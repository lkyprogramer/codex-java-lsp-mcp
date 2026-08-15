// input: A clean Java repository, an empty private JavaIndex cache and a frozen anchor-closure scenario.
// output: Monotonic T_open/T_anchor_ready/T_module_ready/T_complete/T_snapshot_durable evidence.
// pos: V3.2-16 progressive-index measurement; never used by the MCP request path.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { probeLayout } from "../layout-probe.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { computeBuildFingerprint, computeExtractorVersion } from "../java-index/build-fingerprint.js";
import { JavaIndexClient } from "../java-index/java-index-client.js";
import type { JavaIndexStatus } from "../java-index/index-types.js";
import { computeCurrentSnapshotManifestFingerprint } from "../java-index/manifest.js";
import { RouterJavaIndex } from "../java-index/router-java-index.js";
import { loadSnapshot, type JavaIndexSnapshotV3 } from "../java-index/snapshot.js";
import { STABLE_ID_VERSION } from "../java-index/stable-id.js";
import {
  areJavaSourceRootsCompleteAt,
  isJavaIndexCompleteAt,
  isJavaIndexSnapshotDurableAt
} from "./java-index-idle.js";

const SNAPSHOT_FILE = "java-index-snapshot.json.gz";

export type ProgressiveScenario = {
  projectId: string;
  repoCommit: string;
  anchorScenarioId: string;
  anchor: { file: string; line: number; column: number };
  requiredTypeDefinitions: Array<{ typeText: string; expectedFile: string }>;
  requiredImplementer?: { typeText: string; expectedFile: string; limit: number };
  missingTypeFqn: string;
};

export type ProgressiveStage<T = unknown> =
  | { state: "REACHED"; elapsedMs: number; proof: T }
  | { state: "UNMEASURABLE_NOT_BUILDING" | "TIMEOUT" | "FAILED"; elapsedMs?: number; reason: string };

export type ProgressiveIndexResult = {
  schemaVersion: 1;
  clock: "performance.now-monotonic";
  projectId: string;
  scenarioId: string;
  generation: number;
  stages: {
    open: ProgressiveStage;
    anchorReady: ProgressiveStage;
    moduleReady: ProgressiveStage;
    complete: ProgressiveStage;
    snapshotDurable: ProgressiveStage;
  };
  negativeLookup: {
    beforeComplete: { state: string; coverage?: string; authoritative: boolean } | { state: "UNMEASURED"; authoritative: false };
    afterComplete: { state: string; coverage?: string; authoritative: boolean };
  };
  finalSemanticDigest?: string;
  events: Array<{ elapsedMs: number; name: string; status: ReturnType<typeof summarizeStatus> }>;
};

export async function runProgressiveIndex(input: {
  repoRoot: string;
  indexCacheDir: string;
  scenario: ProgressiveScenario;
  generation?: number;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<ProgressiveIndexResult> {
  const generation = input.generation ?? 1;
  const pollMs = input.pollMs ?? 50;
  const timeoutMs = input.timeoutMs ?? 180_000;
  const startedAt = performance.now();
  const elapsed = () => performance.now() - startedAt;
  const deadlineAt = startedAt + timeoutMs;
  const budget = DeadlineBudget.fromTimeout(timeoutMs);
  const client = new JavaIndexClient(input.repoRoot, input.indexCacheDir);
  const router = new RouterJavaIndex(input.repoRoot, client);
  const layout = probeLayout(input.repoRoot);
  const anchorFile = path.resolve(input.repoRoot, input.scenario.anchor.file);
  const events: ProgressiveIndexResult["events"] = [];
  let lastEventSignature = "";
  const observe = (name: string, value: JavaIndexStatus) => {
    const status = summarizeStatus(value);
    const signature = JSON.stringify(status);
    if (signature !== lastEventSignature || name !== "poll") {
      events.push({ elapsedMs: elapsed(), name, status });
      lastEventSignature = signature;
    }
  };
  const failed = (reason: string): ProgressiveStage => ({ state: "FAILED", elapsedMs: elapsed(), reason });
  const stages: ProgressiveIndexResult["stages"] = {
    open: failed("not started"),
    anchorReady: failed("not started"),
    moduleReady: failed("not started"),
    complete: failed("not started"),
    snapshotDurable: failed("not started")
  };
  let beforeComplete: ProgressiveIndexResult["negativeLookup"]["beforeComplete"] = {
    state: "UNMEASURED",
    authoritative: false
  };
  let afterComplete: ProgressiveIndexResult["negativeLookup"]["afterComplete"] = {
    state: "UNMEASURED",
    authoritative: false
  };

  try {
      const opened = await router.withRequestOptions({ budget }, () => router.open(generation));
      observe("open", opened);
      stages.open = opened.state === "READY" && opened.indexedGeneration === generation
        ? { state: "REACHED", elapsedMs: elapsed(), proof: summarizeStatus(opened) }
        : failed(`OPEN returned ${opened.state}@${opened.indexedGeneration}`);

      const reconciled = await router.withRequestOptions({ budget }, () => router.reconcile(generation));
      observe("reconcile", reconciled);
      const anchorRoot = sourceRootForFile(input.repoRoot, anchorFile, layout.sourceRoots.map(root => root.relativePath));
      let observedBuilding = reconciled.coverage.some(root =>
        root.root === anchorRoot && root.generation === generation && root.state === "BUILDING"
      );
      if (observedBuilding) {
        const negative = await client.queryType(input.scenario.missingTypeFqn, anchorFile, { budget });
        beforeComplete = negative.state === "UNRESOLVED"
          ? {
              state: negative.state,
              coverage: negative.coverage,
              authoritative: negative.coverage === "COMPLETE"
            }
          : { state: negative.state, authoritative: false };
      }

      let moduleRoots: string[] = [];
      while (performance.now() < deadlineAt) {
        const proof = await router.withRequestOptions(
          { budget },
          () => probeAnchorClosure(router, input.repoRoot, anchorFile, input.scenario, generation)
        );
        const status = await client.status({ budget });
        observe("poll", status);
        const buildingNow = status.coverage.some(root =>
          root.root === anchorRoot && root.generation === generation && root.state === "BUILDING"
        );
        if (!observedBuilding && buildingNow) {
          const negative = await client.queryType(input.scenario.missingTypeFqn, anchorFile, { budget });
          beforeComplete = negative.state === "UNRESOLVED"
            ? {
                state: negative.state,
                coverage: negative.coverage,
                authoritative: negative.coverage === "COMPLETE"
              }
            : { state: negative.state, authoritative: false };
        }
        observedBuilding ||= buildingNow;
        if (moduleRoots.length === 0 && proof.anchorModule !== undefined) {
          const anchorModule = proof.anchorModule;
          moduleRoots = layout.sourceRoots
            .filter(root => sameModule(root.module, anchorModule) && root.sourceSet === "main")
            .map(root => root.relativePath.replaceAll(path.sep, "/"));
        }
        if (stages.anchorReady.state !== "REACHED" && proof.ready) {
          stages.anchorReady = observedBuilding
            ? { state: "REACHED", elapsedMs: elapsed(), proof }
            : {
                state: "UNMEASURABLE_NOT_BUILDING",
                elapsedMs: elapsed(),
                reason: "anchor closure succeeded before BUILDING was observed"
              };
        }
        if (stages.moduleReady.state !== "REACHED" && areJavaSourceRootsCompleteAt(status, generation, moduleRoots)) {
          stages.moduleReady = { state: "REACHED", elapsedMs: elapsed(), proof: { roots: moduleRoots } };
        }
        if (isJavaIndexCompleteAt(status, generation)) {
          stages.complete = { state: "REACHED", elapsedMs: elapsed(), proof: summarizeStatus(status) };
          const finalProof = proof.ready
            ? proof
            : await router.withRequestOptions(
                { budget },
                () => probeAnchorClosure(router, input.repoRoot, anchorFile, input.scenario, generation)
          );
          if (moduleRoots.length === 0 && finalProof.anchorModule !== undefined) {
            const anchorModule = finalProof.anchorModule;
            moduleRoots = layout.sourceRoots
              .filter(root => sameModule(root.module, anchorModule) && root.sourceSet === "main")
              .map(root => root.relativePath.replaceAll(path.sep, "/"));
          }
          if (stages.moduleReady.state !== "REACHED" && areJavaSourceRootsCompleteAt(status, generation, moduleRoots)) {
            stages.moduleReady = { state: "REACHED", elapsedMs: elapsed(), proof: { roots: moduleRoots } };
          }
          if (stages.anchorReady.state !== "REACHED" && finalProof.ready) {
            stages.anchorReady = observedBuilding
              ? { state: "REACHED", elapsedMs: elapsed(), proof: finalProof }
              : stages.anchorReady;
          }
          break;
        }
        await sleep(pollMs);
      }
      if (stages.anchorReady.state === "FAILED") stages.anchorReady = timeout("anchor closure", elapsed());
      if (stages.moduleReady.state === "FAILED") stages.moduleReady = timeout("module roots", elapsed());
      if (stages.complete.state === "FAILED") stages.complete = timeout("complete coverage", elapsed());
      if (stages.complete.state === "REACHED") {
        const flushed = await client.flush({ budget });
        observe("flush", flushed);
        const snapshotProof = await verifyDurableSnapshot(input.repoRoot, input.indexCacheDir, generation, flushed);
        stages.snapshotDurable = snapshotProof.ok
          ? { state: "REACHED", elapsedMs: elapsed(), proof: snapshotProof }
          : failed(snapshotProof.reason);
        const negative = await client.queryType(input.scenario.missingTypeFqn, anchorFile, { budget });
        afterComplete = negative.state === "UNRESOLVED"
          ? {
              state: negative.state,
              coverage: negative.coverage,
              authoritative: negative.coverage === "COMPLETE" && isJavaIndexCompleteAt(flushed, generation)
            }
          : { state: negative.state, authoritative: false };
      }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const key of Object.keys(stages) as Array<keyof typeof stages>) {
      if (stages[key].state === "FAILED" && stages[key].reason === "not started") stages[key] = failed(reason);
    }
  } finally {
    await router.close().catch(() => undefined);
  }

  const durable = stages.snapshotDurable.state === "REACHED"
    ? stages.snapshotDurable.proof as { semanticDigest: string }
    : undefined;
  return {
    schemaVersion: 1,
    clock: "performance.now-monotonic",
    projectId: input.scenario.projectId,
    scenarioId: input.scenario.anchorScenarioId,
    generation,
    stages,
    negativeLookup: { beforeComplete, afterComplete },
    ...(durable ? { finalSemanticDigest: durable.semanticDigest } : {}),
    events
  };
}

async function probeAnchorClosure(
  router: RouterJavaIndex,
  repoRoot: string,
  anchorFile: string,
  scenario: ProgressiveScenario,
  generation: number
) {
  await router.ensureFresh([anchorFile], generation);
  const anchor = await router.queryAnchor(anchorFile, scenario.anchor.line, scenario.anchor.column);
  const anchorBundle = (await router.queryFiles([anchorFile]))[0];
  const imports = new Set(anchorBundle?.file.imports.filter(item => !item.static && !item.wildcard).map(item => item.qualifiedName));
  const definitions = await router.findTypeDefinitions(scenario.requiredTypeDefinitions.map(item => item.typeText));
  const definitionFiles = new Set(definitions.map(item => relative(repoRoot, item.absolutePath)));
  const missingDefinitions = scenario.requiredTypeDefinitions.filter(item =>
    !imports.has(item.typeText) || !definitionFiles.has(item.expectedFile)
  );
  const implementers = scenario.requiredImplementer
    ? await router.findImplementers(scenario.requiredImplementer.typeText, scenario.requiredImplementer.limit, anchorFile)
    : [];
  const implementerFiles = implementers.map(item => relative(repoRoot, item.absolutePath));
  const implementationReady = !scenario.requiredImplementer
    || implementerFiles.includes(scenario.requiredImplementer.expectedFile);
  return {
    ready: anchor !== undefined
      && anchor.file.generation === generation
      && missingDefinitions.length === 0
      && implementationReady,
    anchorKind: anchor?.symbolKind,
    anchorModule: anchor?.file.module,
    anchorGeneration: anchor?.file.generation,
    requiredDefinitions: scenario.requiredTypeDefinitions.map(item => item.expectedFile),
    definitionFiles: [...definitionFiles].sort(),
    missingDefinitions: missingDefinitions.map(item => item.expectedFile),
    implementerFiles: implementerFiles.sort(),
    implementationReady
  };
}

async function verifyDurableSnapshot(
  repoRoot: string,
  cacheDir: string,
  generation: number,
  status: JavaIndexStatus
): Promise<{ ok: true; bytes: number; sha256: string; manifestFingerprint: string; semanticDigest: string } | { ok: false; reason: string }> {
  if (!isJavaIndexSnapshotDurableAt(status, generation)) return { ok: false, reason: "status is not durable at generation" };
  const layout = probeLayout(repoRoot);
  const buildFingerprint = await computeBuildFingerprint(repoRoot, layout).catch(() => undefined);
  if (!buildFingerprint) return { ok: false, reason: "build fingerprint unavailable" };
  const snapshotPath = path.join(cacheDir, SNAPSHOT_FILE);
  const snapshot = await loadSnapshot(snapshotPath, {
    extractorVersion: computeExtractorVersion(),
    stableIdVersion: STABLE_ID_VERSION,
    canonicalRepoRoot: repoRoot,
    buildFingerprint
  });
  if (!snapshot || snapshot.indexedGeneration !== generation) return { ok: false, reason: "snapshot readback generation mismatch" };
  const currentManifest = await computeCurrentSnapshotManifestFingerprint(repoRoot, layout);
  if (snapshot.manifestFingerprint !== currentManifest) return { ok: false, reason: "snapshot readback manifest mismatch" };
  const [contents, fileStats] = await Promise.all([readFile(snapshotPath), stat(snapshotPath)]);
  if (fileStats.size <= 0 || contents.length !== status.snapshotBytes) return { ok: false, reason: "snapshot readback byte mismatch" };
  return {
    ok: true,
    bytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
    manifestFingerprint: currentManifest,
    semanticDigest: canonicalSnapshotSemanticDigest(snapshot)
  };
}

export function canonicalSnapshotSemanticDigest(snapshot: JavaIndexSnapshotV3): string {
  const semantic = {
    files: snapshot.files
      .map(({ generation: _generation, mtimeMs: _mtime, ctimeMs: _ctime, ...item }) => item)
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    types: [...snapshot.types].sort((left, right) => left.typeId.localeCompare(right.typeId)),
    fields: [...snapshot.fields].sort((left, right) => left.fieldId.localeCompare(right.fieldId)),
    methods: [...snapshot.methods].sort((left, right) => left.methodId.localeCompare(right.methodId)),
    edges: snapshot.edges
      .map(({ generation: _generation, ...item }) => item)
      .sort((left, right) => left.edgeId.localeCompare(right.edgeId)),
    myBatisResources: snapshot.myBatisResources
      .map(({ generation: _generation, ...item }) => item)
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  };
  return createHash("sha256").update(stableJson(semantic)).digest("hex");
}

function summarizeStatus(status: JavaIndexStatus) {
  return {
    state: status.state,
    indexedGeneration: status.indexedGeneration,
    pendingForeground: status.pendingForeground,
    pendingBackground: status.pendingBackground,
    snapshotVerificationPending: status.snapshotVerificationPending === true,
    snapshot: status.snapshot,
    coverage: status.coverage,
    resourceCoverage: status.resourceCoverage,
    ...(status.lastError ? { lastError: status.lastError } : {})
  };
}

function sourceRootForFile(repoRoot: string, file: string, roots: readonly string[]): string {
  const target = relative(repoRoot, file);
  return [...roots]
    .map(root => root.replaceAll(path.sep, "/"))
    .sort((left, right) => right.length - left.length)
    .find(root => target === root || target.startsWith(`${root}/`)) ?? "";
}

function relative(repoRoot: string, file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function sameModule(left: string, right: string): boolean {
  return normalizeModule(left) === normalizeModule(right);
}

function normalizeModule(value: string): string {
  return value === "" ? "." : value;
}

function timeout(subject: string, elapsedMs: number): ProgressiveStage {
  return { state: "TIMEOUT", elapsedMs, reason: `timed out waiting for ${subject}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

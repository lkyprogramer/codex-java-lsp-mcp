// input: an isolated Java/Maven/MyBatis fixture and an optional JSON output path.
// output: deterministic Task 36 freshness-gate results through the production index path.
// pos: Task 36's nine-case mutation freshness matrix, on the MAC-08B call graph: one IndexOwner
//      (real builder and query processes, sealed snapshots), tracker signals injected per mutation
//      (native FSEvents delivery is G03B's evidence), and every observation made through one request
//      view. Schema 2 replaces the fs.watch coordinator matrix (schema 1), whose runtime was deleted.
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ImpactOptions } from "../agent-types.js";
import { AgentRouter } from "../agent-router/index.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import type { JavaFileBundle, JavaIndexStatus } from "../java-index/index-types.js";
import { RouterJavaIndex } from "../java-index/router-java-index.js";
import { fqnOfTypeId } from "../java-index/framework-index-view.js";
import { IndexOwner, type PublishEvent, type WorkspaceIndex } from "../java-index/snapshot/index-owner.js";
import { snapshotIndexStatus, SnapshotJavaIndexClient, withRequestDefaults, withRequestView, type RequestView, type ViewLabels } from "../java-index/snapshot/request-view.js";
import { FSEVENT_FLAGS, type TrackerSourceFactory } from "../java-index/snapshot/workspace-tracker.js";
import { probeLayout } from "../layout-probe.js";
import { createRequestContext } from "../runtime/request-context.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { RgRunner } from "../search/rg-runner.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import { resolveWorktreeIdentity } from "../worktree-identity.js";

const SETTLE_TIMEOUT_MS = 120_000;
const REQUEST_MS = 30_000;
const FILE_MODIFIED = 0x1000 | FSEVENT_FLAGS.ItemIsFile;

const CASE_IDS = [
  "method-body",
  "package-private-method",
  "nested-record",
  "rename-java-type-file",
  "delete-java-file",
  "duplicate-simple-name-import-switch",
  "pom-module",
  "mybatis-xml-statement",
  "malformed-java-repair"
] as const;

export type Task36MutationCaseId = typeof CASE_IDS[number];

export type Task36MutationCase = {
  id: Task36MutationCaseId;
  staleCount: number;
  oldFactAbsent: boolean;
  viewState: ViewLabels["state"];
  changedDuringRequest: boolean;
  requestGeneration: number;
  indexedGeneration: number;
};

export type Task36MutationMatrix = {
  schemaVersion: 2;
  gate: {
    expectedCases: number;
    staleCount: number;
    passed: boolean;
  };
  cases: Task36MutationCase[];
  tracker: {
    signals: "injected";
    ready: boolean;
    publishes: number;
    generations: number[];
  };
  overlapProbe: {
    source: "agent-router";
    requestGeneration: number;
    indexedGeneration: number;
    changedDuringRequest: boolean;
    heldSnapshotId: string;
    latestSnapshotId: string;
    latestGeneration: number;
  };
};

type Fixture = {
  root: string;
  target: string;
  importConsumer: string;
  renameSource: string;
  renamedTarget: string;
  deletable: string;
  rootPom: string;
  mapper: string;
  broken: string;
};

type Engine = {
  owner: IndexOwner;
  workspace: WorkspaceIndex;
  root: string;
  publishes: PublishEvent[];
  rounds: unknown[];
  emit(file: string): void;
};

type SettledMutation = { generation: number; snapshotId: string };

class EmptyRgRunner extends RgRunner {
  override async run(_query: RgQuery, _budget: DeadlineBudget): Promise<SearchResult> {
    return { files: [], completion: "COMPLETE", rawBytes: 0, totalMatches: 0, elapsedMs: 0 };
  }
}

/** A change source whose signals this driver emits itself, one per mutated path. */
function injectedSource(): { factory: TrackerSourceFactory; emit(file: string): void } {
  let onSignal: ((flags: number, file: string) => void) | undefined;
  return {
    factory: async listener => {
      onSignal = listener;
      return { epoch: randomBytes(16).toString("hex"), fence: async () => {}, stop: async () => {}, closed: new Promise<void>(() => {}) };
    },
    emit: file => {
      if (!onSignal) throw new Error("tracker source not started");
      onSignal(FILE_MODIFIED, file);
    }
  };
}

export async function runTask36MutationMatrix(): Promise<Task36MutationMatrix> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "task36-mutation-matrix-")));
  const fixture = await createFixture(path.join(base, "repo"));
  const source = injectedSource();
  const publishes: PublishEvent[] = [];
  const rounds: unknown[] = [];
  const owner = await IndexOwner.open({ cacheRoot: path.join(base, "cache"), trackerSource: () => source.factory, roundDelayMs: 5,
    onEvent: event => { if (event.type === "round") rounds.push(event); } });
  owner.onPublished(event => publishes.push(event));
  const cases: Task36MutationCase[] = [];
  try {
    const workspace = await owner.workspace(fixture.root);
    const engine: Engine = { owner, workspace, root: fixture.root, publishes, rounds, emit: source.emit };
    await until(() => Boolean(owner.store.binding(workspace.workspaceId)) && settledRound(workspace), "first binding");
    const trackerReady = workspace.trackerStatus() === "FRESH";

    const methodBody = await settleMutation(engine, [fixture.target], async () => {
      await writeFile(fixture.target, targetSource({ body: "newBody", packagePrivate: false, nestedRecord: false }));
    });
    cases.push(await observeCase(engine, "method-body", methodBody, async client => {
      const bundle = await requiredBundle(client, fixture.target);
      const body = requiredMethod(bundle, "bodyMutation");
      const oldBody = requiredMethod(bundle, "oldBody");
      const newBody = requiredMethod(bundle, "newBody");
      return bundle.edges.some(edge => edge.kind === "CALLS" && edge.fromId === body.methodId && edge.toId === newBody.methodId)
        && !bundle.edges.some(edge => edge.kind === "CALLS" && edge.fromId === body.methodId && edge.toId === oldBody.methodId);
    }));

    const packagePrivate = await settleMutation(engine, [fixture.target], async () => {
      await writeFile(fixture.target, targetSource({ body: "newBody", packagePrivate: true, nestedRecord: false }));
    });
    cases.push(await observeCase(engine, "package-private-method", packagePrivate, async client => {
      const bundle = await requiredBundle(client, fixture.target);
      return bundle.methods.some(method => method.name === "packageVisible")
        && !bundle.methods.some(method => method.name === "packagePrivateLegacy");
    }));

    const nestedRecord = await settleMutation(engine, [fixture.target], async () => {
      await writeFile(fixture.target, targetSource({ body: "newBody", packagePrivate: true, nestedRecord: true }));
    });
    cases.push(await observeCase(engine, "nested-record", nestedRecord, async client => {
      const bundle = await requiredBundle(client, fixture.target);
      return bundle.types.some(type => type.simpleName === "Payload")
        && !bundle.types.some(type => type.simpleName === "LegacyPayload");
    }));

    const renameMutation = await settleMutation(engine, [fixture.renamedTarget, fixture.renameSource], async () => {
      await rename(fixture.renameSource, fixture.renamedTarget);
      await writeFile(fixture.renamedTarget, "package demo;\npublic class RenamedTarget {}\n");
    });
    cases.push(await observeCase(engine, "rename-java-type-file", renameMutation, async client =>
      await isUnresolved(client, "demo.RenameSource") && await isResolved(client, "demo.RenamedTarget")
    ));

    const deletion = await settleMutation(engine, [fixture.deletable], async () => {
      await rm(fixture.deletable);
    });
    cases.push(await observeCase(engine, "delete-java-file", deletion, async client =>
      await isUnresolved(client, "demo.Deletable") && (await client.queryFiles([fixture.deletable])).length === 0
    ));

    const importSwitch = await settleMutation(engine, [fixture.importConsumer], async () => {
      await writeFile(fixture.importConsumer, importConsumerSource("b.User"));
    });
    cases.push(await observeCase(engine, "duplicate-simple-name-import-switch", importSwitch, async client => {
      const bundle = await requiredBundle(client, fixture.importConsumer);
      const field = bundle.fields.find(candidate => candidate.name === "user");
      return field?.type.resolution.state === "RESOLVED_REPO"
        // v2 declaration ids are source-scoped; compare the embedded FQN, not a v1 literal.
        && fqnOfTypeId(field.type.resolution.typeId) === "b.User"
        && !bundle.edges.some(edge => edge.kind === "FIELD_TYPE" && fqnOfTypeId(edge.toId) === "a.User");
    }));

    const modulePom = path.join(fixture.root, "modules", "extra", "pom.xml");
    const moduleType = path.join(fixture.root, "modules", "extra", "src", "main", "java", "extra", "ModuleAdded.java");
    const pomModule = await settleMutation(engine, [fixture.rootPom, modulePom, moduleType], async () => {
      await mkdir(path.dirname(moduleType), { recursive: true });
      await writeFile(fixture.rootPom, rootPomSource(true));
      await writeFile(modulePom, "<project><modelVersion>4.0.0</modelVersion></project>\n");
      await writeFile(moduleType, "package extra;\npublic class ModuleAdded {}\n");
    }, [moduleType]);
    const pomPublish = publishes.at(-1);
    cases.push(await observeCase(engine, "pom-module", pomModule, async client =>
      // The module's pom changed the build key: the publish says so, and the new module is indexed.
      pomPublish?.buildKeyChanged === true && await isResolved(client, "extra.ModuleAdded")
    ));

    const mybatis = await settleMutation(engine, [fixture.mapper], async () => {
      await writeFile(fixture.mapper, mapperSource("findFresh"));
    });
    cases.push(await observeCase(engine, "mybatis-xml-statement", mybatis, async client => {
      const resource = await client.queryMyBatisResource("src/main/resources/mapper/OrderMapper.xml");
      return resource?.statements.some(statement => statement.id === "findFresh") === true
        && !resource.statements.some(statement => statement.id === "findStale");
    }));

    await settleMutation(engine, [fixture.broken], async () => {
      await writeFile(fixture.broken, "package demo;\npublic class Broken { String stale( {\n");
    });
    const repaired = await settleMutation(engine, [fixture.broken], async () => {
      await writeFile(fixture.broken, "package demo;\npublic class Broken { String repaired() { return \"ok\"; } }\n");
    });
    cases.push(await observeCase(engine, "malformed-java-repair", repaired, async client => {
      const bundle = await requiredBundle(client, fixture.broken);
      return await isResolved(client, "demo.Broken")
        && bundle.methods.some(method => method.name === "repaired")
        && !bundle.methods.some(method => method.name === "stale");
    }));

    const identity = await resolveWorktreeIdentity(fixture.root);
    const overlapProbe = await verifyHeldViewDuringPublish(engine, fixture.target, identity.repoHash);
    const staleCount = cases.reduce((total, item) => total + item.staleCount, 0);
    return {
      schemaVersion: 2,
      gate: {
        expectedCases: CASE_IDS.length,
        staleCount,
        passed: staleCount === 0
          && cases.length === CASE_IDS.length
          && trackerReady
          && !overlapProbe.changedDuringRequest
          && overlapProbe.indexedGeneration === overlapProbe.requestGeneration
          && overlapProbe.latestGeneration > overlapProbe.requestGeneration
      },
      cases,
      tracker: {
        signals: "injected",
        ready: trackerReady,
        publishes: publishes.length,
        generations: publishes.map(event => event.indexedGeneration)
      },
      overlapProbe
    };
  } finally {
    await owner.stop();
    await writable(base);
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Sealed snapshots are read-only directories: make the tree removable. */
async function writable(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => undefined);
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await writable(path.join(dir, entry.name));
  }
}

function settledRound(workspace: WorkspaceIndex): boolean {
  return workspace.trackerStatus() === "FRESH" && !workspace.status().roundInFlight;
}

async function until(probe: () => boolean, label: string | (() => string), timeoutMs = SETTLE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error(`timed out: ${typeof label === "function" ? label() : label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * Mutate, signal each path, and wait until publishes cover every indexed member that changed and the
 * tracker is FRESH again. Build files are not index members: they change the build key, not `changed`.
 */
async function settleMutation(engine: Engine, files: readonly string[], mutate: () => Promise<void>, members: readonly string[] = files): Promise<SettledMutation> {
  const first = engine.publishes.length;
  const expected = members.map(file => path.relative(engine.root, file).split(path.sep).join("/"));
  await mutate();
  for (const file of files) engine.emit(file);
  await until(() => {
    const covered = new Set(engine.publishes.slice(first).flatMap(event => [...event.changed, ...event.deleted]));
    return expected.every(relative => covered.has(relative)) && settledRound(engine.workspace);
  }, () => `publish covering ${expected.join(", ")} (publishes ${JSON.stringify(engine.publishes.slice(first).map(event => [event.changed, event.deleted]))}; `
    + `workspace ${JSON.stringify(engine.workspace.status())}; last rounds ${JSON.stringify(engine.rounds.slice(-3))})`);
  const latest = engine.publishes.at(-1)!;
  return { generation: latest.indexedGeneration, snapshotId: latest.snapshotId };
}

/** One request view: the assertion reads only the snapshot that view holds. */
async function observeCase(
  engine: Engine,
  id: Task36MutationCaseId,
  mutation: SettledMutation,
  assertLatest: (client: JavaIndexClientApi) => Promise<boolean>
): Promise<Task36MutationCase> {
  const budget = DeadlineBudget.fromTimeout(REQUEST_MS);
  const observed = await withRequestView({
    owner: engine.owner, budget, resolve: async () => engine.root,
    handler: async view => {
      if (!view.snapshotId) return { labels: view.labels, status: undefined, oldFactAbsent: false };
      const status = snapshotIndexStatus(await view.snapshotStatus(), view.snapshotId);
      const client = new SnapshotJavaIndexClient(engine.owner, view.snapshotId, engine.root, status, probeLayout(engine.root));
      const oldFactAbsent = await withRequestDefaults({ budget }, () => assertLatest(client));
      return { labels: view.labels, status, oldFactAbsent };
    }
  });
  const bound = engine.owner.store.binding(engine.workspace.workspaceId);
  const requestGeneration = observed.status?.indexedGeneration ?? 0;
  const fresh = observed.oldFactAbsent
    && observed.labels.state === "FRESH"
    && observed.labels.snapshotId === mutation.snapshotId
    && requestGeneration === mutation.generation;
  return {
    id,
    staleCount: fresh ? 0 : 1,
    oldFactAbsent: observed.oldFactAbsent,
    viewState: observed.labels.state,
    changedDuringRequest: bound?.snapshotId !== observed.labels.snapshotId,
    requestGeneration,
    indexedGeneration: engine.publishes.at(-1)?.indexedGeneration ?? 0
  };
}

/**
 * A publish that lands while an AgentRouter request holds its view: the request keeps answering
 * from its own snapshot (contract §2.6), so its freshness reports no change during the request.
 */
async function verifyHeldViewDuringPublish(engine: Engine, target: string, repoHash: string): Promise<Task36MutationMatrix["overlapProbe"]> {
  const budget = DeadlineBudget.fromTimeout(SETTLE_TIMEOUT_MS);
  return withRequestView({
    owner: engine.owner, budget, resolve: async () => engine.root,
    handler: async (view: RequestView) => {
      if (!view.snapshotId) throw new Error("overlap probe has no verified snapshot");
      const status = snapshotIndexStatus(await view.snapshotStatus(), view.snapshotId);
      const layout = probeLayout(engine.root);
      const client = new SnapshotJavaIndexClient(engine.owner, view.snapshotId, engine.root, status, layout);
      const index = new RouterJavaIndex(engine.root, client);
      await withRequestDefaults({ budget }, () => index.open(status.indexedGeneration));
      // The publish lands after this request acquired its view and before its router runs.
      const latest = await settleMutation(engine, [target], async () => {
        await writeFile(target, targetSource({ body: "oldBody", packagePrivate: true, nestedRecord: true }));
      });
      const router = new AgentRouter(engine.root, noLspSession() as never, index, layout, undefined, new EmptyRgRunner(), noOpSemanticEdgeStore() as never);
      const options: ImpactOptions & { verbosity: "diagnostic" } = {
        anchors: [{ file: target, line: 3, column: 24 }],
        mode: "balanced",
        profile: "service",
        semanticPolicy: "fast",
        semanticTimeoutMs: 100,
        testReadMode: "defer",
        focusModules: [],
        excludeModules: [],
        taskKeywords: ["bodyMutation"],
        crossModulePolicy: "auto",
        verbosity: "diagnostic"
      };
      const request = createRequestContext({
        repoRoot: engine.root,
        repoHash,
        generation: status.indexedGeneration,
        freshnessMode: "NORMAL",
        cacheReadAllowed: true,
        cacheWriteAllowed: true,
        negativeLookupAllowed: false,
        indexOpenSource: "own-snapshot",
        mode: "balanced",
        semanticPolicy: "fast",
        budget
      });
      const result = await withRequestDefaults({ budget }, () => index.withRequestOptions({ budget }, () => router.impact(options, request)));
      router.dispose();
      return {
        source: "agent-router" as const,
        requestGeneration: result.freshness.requestGeneration,
        indexedGeneration: result.freshness.indexedGeneration,
        changedDuringRequest: result.freshness.changedDuringRequest,
        heldSnapshotId: view.snapshotId,
        latestSnapshotId: latest.snapshotId,
        latestGeneration: latest.generation
      };
    }
  });
}

function noLspSession(): Record<string, unknown> {
  return {
    cacheStatus: () => ({ invalidations: 0, entries: 0, hits: 0, misses: 0 }),
    status: () => ({
      state: "NEW",
      started: false,
      progress: { active: 0, activeMessages: [] },
      generatedCode: {
        lombok: { detected: false, agentEnabled: false, status: "not-detected" },
        annotationProcessing: { detectedProcessors: [], enabled: false, source: "auto" },
        generatedCodeSemantics: "complete"
      }
    })
  };
}

function noOpSemanticEdgeStore(): Record<string, unknown> {
  return {
    findFrom: () => [],
    putComplete: async () => undefined,
    applyChanges: () => undefined,
    clearForBuildChange: () => undefined,
    flush: async () => undefined,
    status: () => ({
      entries: 0,
      snapshotBytes: 0,
      generation: 0,
      buildFingerprint: "",
      hits: 0,
      misses: 0,
      invalidations: 0,
      promoted: 0,
      completeWrites: 0,
      rejectedWrites: 0
    })
  };
}

async function createFixture(root: string): Promise<Fixture> {
  const javaRoot = path.join(root, "src", "main", "java", "demo");
  const target = path.join(javaRoot, "MutationTarget.java");
  const importConsumer = path.join(javaRoot, "ImportConsumer.java");
  const renameSource = path.join(javaRoot, "RenameSource.java");
  const renamedTarget = path.join(javaRoot, "RenamedTarget.java");
  const deletable = path.join(javaRoot, "Deletable.java");
  const rootPom = path.join(root, "pom.xml");
  const mapper = path.join(root, "src", "main", "resources", "mapper", "OrderMapper.xml");
  const broken = path.join(javaRoot, "Broken.java");
  await mkdir(javaRoot, { recursive: true });
  await mkdir(path.dirname(mapper), { recursive: true });
  await mkdir(path.join(root, "src", "main", "java", "a"), { recursive: true });
  await mkdir(path.join(root, "src", "main", "java", "b"), { recursive: true });
  await writeFile(rootPom, rootPomSource(false));
  await writeFile(target, targetSource({ body: "oldBody", packagePrivate: false, nestedRecord: false }));
  await writeFile(path.join(root, "src", "main", "java", "a", "User.java"), "package a;\npublic class User {}\n");
  await writeFile(path.join(root, "src", "main", "java", "b", "User.java"), "package b;\npublic class User {}\n");
  await writeFile(importConsumer, importConsumerSource("a.User"));
  await writeFile(renameSource, "package demo;\npublic class RenameSource {}\n");
  await writeFile(deletable, "package demo;\npublic class Deletable {}\n");
  await writeFile(mapper, mapperSource("findStale"));
  return { root, target, importConsumer, renameSource, renamedTarget, deletable, rootPom, mapper, broken };
}

function targetSource(options: { body: "oldBody" | "newBody"; packagePrivate: boolean; nestedRecord: boolean }): string {
  return [
    "package demo;",
    "public class MutationTarget {",
    `  public String bodyMutation() { return ${options.body}(); }`,
    "  String oldBody() { return \"old\"; }",
    "  String newBody() { return \"new\"; }",
    ...(options.packagePrivate
      ? ["  String packageVisible() { return \"visible\"; }"]
      : ["  private String packagePrivateLegacy() { return \"legacy\"; }"]),
    ...(options.nestedRecord ? ["  record Payload(String value) {}"] : ["  static class LegacyPayload {}"]),
    "}",
    ""
  ].join("\n");
}

function importConsumerSource(importName: "a.User" | "b.User"): string {
  return [
    "package demo;",
    `import ${importName};`,
    "public class ImportConsumer { User user; }",
    ""
  ].join("\n");
}

function rootPomSource(withModule: boolean): string {
  return [
    "<project><modelVersion>4.0.0</modelVersion><packaging>pom</packaging>",
    ...(withModule ? ["<modules><module>modules/extra</module></modules>"] : []),
    "</project>",
    ""
  ].join("\n");
}

function mapperSource(statementId: "findStale" | "findFresh"): string {
  return `<mapper namespace="demo.OrderMapper"><select id="${statementId}" resultType="demo.Order">select 1</select></mapper>\n`;
}

async function requiredBundle(client: JavaIndexClientApi, absolutePath: string): Promise<JavaFileBundle> {
  const bundle = (await client.queryFiles([absolutePath]))[0];
  if (!bundle) throw new Error(`expected JavaIndex facts for ${absolutePath}`);
  return bundle;
}

function requiredMethod(bundle: JavaFileBundle, name: string) {
  const method = bundle.methods.find(candidate => candidate.name === name);
  if (!method) throw new Error(`expected ${name} method in ${bundle.file.relativePath}`);
  return method;
}

async function isResolved(client: JavaIndexClientApi, typeText: string): Promise<boolean> {
  return (await client.queryType(typeText)).state === "RESOLVED";
}

async function isUnresolved(client: JavaIndexClientApi, typeText: string): Promise<boolean> {
  return (await client.queryType(typeText)).state === "UNRESOLVED";
}

async function main(): Promise<void> {
  const output = parseOutput(process.argv.slice(2));
  const payload = await runTask36MutationMatrix();
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, serialized);
  }
  process.stdout.write(serialized);
  if (!payload.gate.passed) process.exitCode = 1;
}

function parseOutput(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    throw new Error("usage: task36-mutation-matrix [--output path]");
  }
  return path.resolve(args[1]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

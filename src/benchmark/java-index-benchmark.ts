// input: a generated Java fixture and an optional artifact output path.
// output: repeatable JavaIndex V2 microbenchmark measurements from real worker threads.
// pos: Task 23's focused performance, snapshot, refresh, and query evidence harness.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { probeLayout } from "../layout-probe.js";
import { createGitWorktreeFamily } from "../test-support/git-worktree.js";
import { resolveWorktreeIdentity } from "../worktree-identity.js";
import { scanCurrentManifest } from "../java-index/manifest.js";
import { JavaIndexClient } from "../java-index/java-index-client.js";
import type { JavaFileBundle, JavaIndexStatus } from "../java-index/index-types.js";

type Cli = {
  files: number;
  samples: number;
  output?: string;
  keepTemp: boolean;
  realSeedSource?: string;
  realSeedTarget?: string;
};

type Measurement = {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

type Fixture = {
  root: string;
  cacheDir: string;
  serviceFile: string;
};

const SNAPSHOT_FILE = "java-index-snapshot.json.gz";
const DEFAULT_FILES = 256;
const DEFAULT_SAMPLES = 20;
const IDLE_TIMEOUT_MS = 60_000;

const cli = parseCli(process.argv.slice(2));
const temporaryRoots: string[] = [];

try {
  const freshSweepSamples: number[] = [];
  const sweepEventLoopP99Samples: number[] = [];
  let freshSnapshotBytes = 0;

  for (let sample = 0; sample < cli.samples; sample += 1) {
    const fixture = await createFixture(cli.files);
    const observed = await measureFreshFullSweep(fixture);
    freshSweepSamples.push(observed.elapsedMs);
    sweepEventLoopP99Samples.push(observed.eventLoopDelayP99Ms);
    freshSnapshotBytes = Math.max(freshSnapshotBytes, observed.snapshotBytes);
  }

  const snapshotFixture = await createFixture(cli.files);
  await buildCompleteSnapshot(snapshotFixture, 1);
  const snapshotBytes = await stat(path.join(snapshotFixture.cacheDir, SNAPSHOT_FILE)).then(file => file.size);
  const snapshotLoadSamples = await measureMany(cli.samples, async () => {
    const client = new JavaIndexClient(snapshotFixture.root, snapshotFixture.cacheDir);
    try {
      const startedAt = performance.now();
      await client.open(1);
      const status = await waitForIdle(client);
      const elapsedMs = performance.now() - startedAt;
      if (!hasCompleteCoverage(status)) {
        throw new Error(`snapshot load did not restore COMPLETE coverage: ${JSON.stringify(status.coverage)}`);
      }
      return elapsedMs;
    } finally {
      await client.close();
    }
  });

  const refreshFixture = await createFixture(cli.files);
  const refreshClient = new JavaIndexClient(refreshFixture.root, refreshFixture.cacheDir);
  await refreshClient.open(1);
  await refreshClient.reconcile(1);
  await waitForIdle(refreshClient);

  let generation = 2;
  const fullParseRefreshSamples = await measureMany(cli.samples, async sample => {
    await writeFile(refreshFixture.serviceFile, serviceSource(`full-${sample}`, true));
    const startedAt = performance.now();
    await refreshClient.refresh(generation++, [refreshFixture.serviceFile], []);
    return performance.now() - startedAt;
  });

  await writeFile(refreshFixture.serviceFile, serviceSource("incremental-baseline", false));
  await refreshClient.refresh(generation++, [refreshFixture.serviceFile], []);
  const incrementalRefreshSamples = await measureMany(cli.samples, async sample => {
    await writeFile(refreshFixture.serviceFile, serviceSource(`incremental-${sample}`, false));
    const startedAt = performance.now();
    await refreshClient.refresh(generation++, [refreshFixture.serviceFile], []);
    return performance.now() - startedAt;
  });

  const incrementalBundle = (await refreshClient.queryFiles([refreshFixture.serviceFile]))[0];
  if (!incrementalBundle) throw new Error("incremental refresh did not return Service.java facts");

  const equivalentFixture = await createFixture(cli.files, serviceSource(`incremental-${cli.samples - 1}`, false));
  const equivalentClient = new JavaIndexClient(equivalentFixture.root, equivalentFixture.cacheDir);
  await equivalentClient.open(generation);
  await equivalentClient.reconcile(generation);
  await waitForIdle(equivalentClient);
  const fullBundle = (await equivalentClient.queryFiles([equivalentFixture.serviceFile]))[0];
  if (!fullBundle) throw new Error("clean full sweep did not return Service.java facts");
  const incrementalEqualsFull = JSON.stringify(normalizeBundle(incrementalBundle)) === JSON.stringify(normalizeBundle(fullBundle));
  if (!incrementalEqualsFull) {
    throw new Error("incremental refresh facts differ from an equivalent clean full sweep");
  }

  const gateway = await refreshClient.queryType("demo.Gateway");
  if (gateway.state !== "RESOLVED") throw new Error("fixture Gateway type did not resolve");
  const serviceBundle = (await refreshClient.queryFiles([refreshFixture.serviceFile]))[0];
  const handle = serviceBundle?.methods.find(method => method.name === "handle");
  if (!handle) throw new Error("fixture Service#handle method did not index");

  const typeLookupSamples = await measureMany(cli.samples, async () => {
    const startedAt = performance.now();
    const result = await refreshClient.queryType("demo.Gateway");
    if (result.state !== "RESOLVED") throw new Error("type lookup lost Gateway");
    return performance.now() - startedAt;
  });
  const implementerLookupSamples = await measureMany(cli.samples, async () => {
    const startedAt = performance.now();
    const result = await refreshClient.queryImplementers(gateway.type.typeId, 20);
    if (result.length === 0) throw new Error("implementer lookup lost Service");
    return performance.now() - startedAt;
  });
  const callerLookupSamples = await measureMany(cli.samples, async () => {
    const startedAt = performance.now();
    const result = await refreshClient.queryCallers(handle.methodId, 20);
    if (result.length === 0) throw new Error("caller lookup lost generated callers");
    return performance.now() - startedAt;
  });
  await refreshClient.close();
  await equivalentClient.close();
  const mutationMatrix = await runMutationMatrix();
  const syntheticSeed = await runSyntheticWorktreeSeed(Math.max(64, cli.files));
  const realSeed = cli.realSeedSource && cli.realSeedTarget
    ? await runRealWorktreeSeed(cli.realSeedSource, cli.realSeedTarget)
    : undefined;
  const worktreeSeed = { synthetic: syntheticSeed, ...(realSeed ? { real: realSeed } : {}) };

  const payload = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    fixture: {
      kind: "generated-java-worker-fixture",
      files: cli.files,
      workerCopies: cli.samples + 3
    },
    measurements: {
      freshFullSweepMs: summarize(freshSweepSamples),
      snapshotLoadMs: summarize(snapshotLoadSamples),
      fullParseRefreshMs: summarize(fullParseRefreshSamples),
      incrementalRefreshMs: summarize(incrementalRefreshSamples),
      typeLookupMs: summarize(typeLookupSamples),
      implementerLookupMs: summarize(implementerLookupSamples),
      callerLookupMs: summarize(callerLookupSamples)
    },
    factEquivalence: {
      incrementalEqualsFull
    },
    eventLoopDelay: {
      sweepP99Ms: Math.max(...sweepEventLoopP99Samples),
      samples: sweepEventLoopP99Samples.length,
      perSweepP99Ms: sweepEventLoopP99Samples
    },
    snapshot: {
      bytes: snapshotBytes,
      freshSweepMaxBytes: freshSnapshotBytes
    },
    mutationMatrix,
    worktreeSeed
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (cli.output) {
    await mkdir(path.dirname(cli.output), { recursive: true });
    await writeFile(cli.output, serialized);
  }
  process.stdout.write(serialized);
} finally {
  if (!cli.keepTemp) {
    await Promise.all(temporaryRoots.map(root => rm(root, {
      recursive: true,
      force: true,
      // CLOSE waits for the worker, but the worker may have only just
      // published its final atomic snapshot rename.  Retrying this disposable
      // fixture cleanup keeps that filesystem race out of benchmark results.
      maxRetries: 5,
      retryDelay: 50
    })));
  }
}

function parseCli(args: string[]): Cli {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep-temp") {
      values.set(argument, true);
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
    values.set(argument, value);
    index += 1;
  }
  return {
    files: positiveInteger(values.get("--files"), DEFAULT_FILES, "--files"),
    samples: positiveInteger(values.get("--samples"), DEFAULT_SAMPLES, "--samples"),
    output: stringValue(values.get("--output")),
    keepTemp: values.get("--keep-temp") === true,
    ...realSeedArguments(values)
  };
}

function realSeedArguments(values: Map<string, string | true>): Pick<Cli, "realSeedSource" | "realSeedTarget"> {
  const source = stringValue(values.get("--real-seed-source"));
  const target = stringValue(values.get("--real-seed-target"));
  if (Boolean(source) !== Boolean(target)) {
    throw new Error("--real-seed-source and --real-seed-target must be passed together");
  }
  return source && target ? { realSeedSource: source, realSeedTarget: target } : {};
}

function positiveInteger(value: string | true | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function stringValue(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? path.resolve(value) : undefined;
}

async function createFixture(files: number, service = serviceSource("baseline", false)): Promise<Fixture> {
  if (files < 4) throw new Error("--files must be at least 4 so the fixture contains real query relationships");
  const root = await mkdtemp(path.join(tmpdir(), "java-index-benchmark-"));
  temporaryRoots.push(root);
  const javaRoot = path.join(root, "src", "main", "java", "demo");
  const cacheDir = path.join(root, ".java-index-cache");
  await mkdir(javaRoot, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
  await writeFile(path.join(javaRoot, "Gateway.java"), "package demo;\npublic interface Gateway { String handle(String input); }\n");
  const serviceFile = path.join(javaRoot, "Service.java");
  await writeFile(serviceFile, service);
  for (let index = 0; index < files - 2; index += 1) {
    await writeFile(path.join(javaRoot, `Caller${index}.java`), callerSource(index));
  }
  return { root, cacheDir, serviceFile };
}

function serviceSource(marker: string, fullRewrite: boolean): string {
  const filler = fullRewrite
    ? Array.from({ length: 80 }, (_, index) => `  private String full${index}() { return \"${marker}-${index}\"; }`).join("\n")
    : Array.from({ length: 80 }, (_, index) => `  private String full${index}() { return \"stable-${index}\"; }`).join("\n");
  return [
    "package demo;",
    "",
    `/* benchmark-marker:${marker} */`,
    "public class Service implements Gateway {",
    "  @Override public String handle(String input) { return input + \"-ok\"; }",
    filler,
    "}",
    ""
  ].join("\n");
}

function callerSource(index: number): string {
  return [
    "package demo;",
    "",
    `public class Caller${index} {`,
    "  private final Service service = new Service();",
    `  public String invoke${index}() { return service.handle(\"caller-${index}\"); }`,
    "}",
    ""
  ].join("\n");
}

async function runMutationMatrix(): Promise<{
  staleCount: number;
  operations: Array<{ id: string; visibleMs: number; previousFactAbsent?: boolean }>;
}> {
  const fixture = await createFixture(8);
  const client = new JavaIndexClient(fixture.root, fixture.cacheDir);
  const operations: Array<{ id: string; visibleMs: number; previousFactAbsent?: boolean }> = [];
  let generation = 1;
  try {
    await client.open(generation);
    await client.reconcile(generation);
    await waitForIdle(client);
    const original = await requiredType(client, "demo.Service");
    const originalBundle = (await client.queryFiles([fixture.serviceFile]))[0];
    const originalHandle = originalBundle?.methods.find(method => method.name === "handle");
    if (!originalHandle) throw new Error("mutation fixture did not index Service#handle");

    let previousFactAbsent = false;
    const methodSignatureOperation = await measureVisible("method-signature", async () => {
      await writeFile(fixture.serviceFile, methodSignatureServiceSource());
      await client.refresh(++generation, [fixture.serviceFile], []);
      const current = await requiredType(client, "demo.Service");
      const bundle = (await client.queryFiles([fixture.serviceFile]))[0];
      const signatureChanged = bundle?.methods.some(method => method.name === "handle" && method.parameters.length === 2);
      previousFactAbsent = !bundle?.methods.some(method => method.name === "handle" && method.parameters.length === 1);
      if (current.typeId !== original.typeId || !signatureChanged || !previousFactAbsent) {
        throw new Error("method signature refresh exposed stale Service facts");
      }
    });
    operations.push({ ...methodSignatureOperation, previousFactAbsent });

    const secondService = path.join(fixture.root, "src", "main", "java", "demo", "SecondService.java");
    operations.push(await measureVisible("add-implementer", async () => {
      await writeFile(secondService, [
        "package demo;",
        "public class SecondService implements Gateway {",
        "  public String handle(String input) { return input; }",
        "}",
        ""
      ].join("\n"));
      await client.refresh(++generation, [secondService], []);
      const gateway = await requiredType(client, "demo.Gateway");
      const implementations = await client.queryImplementers(gateway.typeId, 20);
      if (!implementations.some(type => type.simpleName === "SecondService")) {
        throw new Error("added implementer was not visible after refresh");
      }
    }));

    const renamedService = path.join(fixture.root, "src", "main", "java", "demo", "RenamedService.java");
    operations.push(await measureVisible("rename-type", async () => {
      await writeFile(renamedService, renamedServiceSource("demo", "RenamedService"));
      await rm(fixture.serviceFile);
      await client.refresh(++generation, [renamedService], [fixture.serviceFile]);
      await requireUnresolved(client, "demo.Service");
      await requiredType(client, "demo.RenamedService");
    }));

    const relocatedService = path.join(fixture.root, "src", "main", "java", "other", "RelocatedService.java");
    operations.push(await measureVisible("move-package", async () => {
      await mkdir(path.dirname(relocatedService), { recursive: true });
      await writeFile(relocatedService, renamedServiceSource("other", "RelocatedService"));
      await rm(renamedService);
      await client.refresh(++generation, [relocatedService], [renamedService]);
      await requireUnresolved(client, "demo.RenamedService");
      await requiredType(client, "other.RelocatedService");
    }));

    operations.push(await measureVisible("delete-type", async () => {
      await rm(relocatedService);
      await client.refresh(++generation, [], [relocatedService]);
      await requireUnresolved(client, "other.RelocatedService");
    }));

    const modulePom = path.join(fixture.root, "modules", "extra", "pom.xml");
    const moduleType = path.join(fixture.root, "modules", "extra", "src", "main", "java", "extra", "ModuleAdded.java");
    operations.push(await measureVisible("pom-module", async () => {
      await writeFile(path.join(fixture.root, "pom.xml"), [
        "<project><modelVersion>4.0.0</modelVersion><packaging>pom</packaging>",
        "<modules><module>modules/extra</module></modules></project>",
        ""
      ].join("\n"));
      await mkdir(path.dirname(modulePom), { recursive: true });
      await writeFile(modulePom, "<project><modelVersion>4.0.0</modelVersion></project>\n");
      await mkdir(path.dirname(moduleType), { recursive: true });
      await writeFile(moduleType, "package extra; public class ModuleAdded {}\n");
      await client.reconcile(++generation);
      await waitForIdle(client);
      await requiredType(client, "extra.ModuleAdded");
    }));
  } finally {
    await client.close();
  }
  return { staleCount: 0, operations };
}

async function runSyntheticWorktreeSeed(files: number): Promise<{
  sourceFiles: number;
  noSeed: {
    reconcileElapsedMs: number;
    fullParsedFiles: number;
    mainEventLoopDelayP99Ms: number;
    snapshotBytes: number;
  };
  seeded: {
    openElapsedMs: number;
    firstIndexQueryElapsedMs: number;
    firstIndexCoverage: string;
    firstIndexQueryResolved: boolean;
    manifestValidationMs: number;
    reusedFiles: number;
    deltaParsedFiles: number;
    fullParsedFiles: number;
    mainEventLoopDelayP99Ms: number;
    snapshotBytes: number;
    modifiedTargetReused: boolean;
    deletedSourceFactVisible: boolean;
    negativeLookupAllowed: boolean;
  };
  postReconcileEquivalent: boolean;
}> {
  const family = await createGitWorktreeFamily();
  const familyRoot = path.dirname(family.primary);
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-index-seed-benchmark-cache-"));
  temporaryRoots.push(familyRoot, cacheBase);
  const primaryCache = path.join(cacheBase, "primary");
  const noSeedCache = path.join(cacheBase, "target-no-seed");
  const seededCache = path.join(cacheBase, "target-seeded");
  const sourceRoot = "src/main/java/demo";
  const gatewayPath = `${sourceRoot}/Gateway.java`;
  const modifiedTargetPath = `${sourceRoot}/Impl0.java`;
  const deletedTargetPath = `${sourceRoot}/Impl1.java`;
  const targetOnlyPath = `${sourceRoot}/TargetOnly.java`;
  const primaryRelativePaths = ["src/main/java/demo/A.java", gatewayPath];
  const targetRelativePaths = ["src/main/java/demo/A.java", gatewayPath];
  let primaryClient: JavaIndexClient | undefined;
  let noSeedClient: JavaIndexClient | undefined;
  let seededClient: JavaIndexClient | undefined;
  try {
    for (const root of [family.primary, family.linked]) {
      await writeFixtureJava(root, gatewayPath, "package demo; public interface Gateway { String execute(); }\n");
      for (let index = 0; index < files - 2; index += 1) {
        const relativePath = `${sourceRoot}/Impl${index}.java`;
        await writeFixtureJava(root, relativePath, implementationSource(index));
      }
    }
    for (let index = 0; index < files - 2; index += 1) {
      const relativePath = `${sourceRoot}/Impl${index}.java`;
      primaryRelativePaths.push(relativePath);
      targetRelativePaths.push(relativePath);
    }

    primaryClient = new JavaIndexClient(family.primary, primaryCache);
    await primaryClient.open(1);
    await primaryClient.reconcile(1);
    await waitForIdle(primaryClient);
    await primaryClient.flush();
    await primaryClient.close();
    primaryClient = undefined;
    const primaryIdentity = await resolveWorktreeIdentity(family.primary);
    await writeFile(path.join(primaryCache, "repo-meta.json"), JSON.stringify({
      repoRoot: family.primary,
      repoHash: primaryIdentity.repoHash,
      familyHash: primaryIdentity.familyHash
    }));

    await writeFixtureJava(family.linked, modifiedTargetPath, [
      "package demo;",
      "public class Impl0 implements Gateway {",
      "  public String execute() { return \"changed\"; }",
      "  public String targetOnlyMethod() { return \"target\"; }",
      "}",
      ""
    ].join("\n"));
    await rm(path.join(family.linked, deletedTargetPath));
    await writeFixtureJava(family.linked, targetOnlyPath, "package demo; public class TargetOnly {}\n");
    targetRelativePaths.splice(targetRelativePaths.indexOf(deletedTargetPath), 1);
    targetRelativePaths.push(targetOnlyPath);

    noSeedClient = new JavaIndexClient(family.linked, noSeedCache);
    await noSeedClient.open(2);
    const noSeedSweep = await measureReconcile(noSeedClient, 2);
    await noSeedClient.flush();
    const noSeedSnapshot = await noSeedClient.status();
    const noSeedBundles = await noSeedClient.queryFiles(targetRelativePaths.map(relativePath => path.join(family.linked, relativePath)));

    const targetIdentity = await resolveWorktreeIdentity(family.linked);
    seededClient = new JavaIndexClient(family.linked, seededCache);
    const seedOpenedAt = performance.now();
    const seedOpenStatus = await seededClient.open(2, { worktree: targetIdentity, siblingCacheBase: cacheBase });
    const openElapsedMs = performance.now() - seedOpenedAt;
    const firstQueryStartedAt = performance.now();
    const firstQuery = await seededClient.queryType("demo.Gateway");
    const firstIndexQueryElapsedMs = performance.now() - firstQueryStartedAt;
    const modifiedTargetReused = (await seededClient.queryFiles([path.join(family.linked, modifiedTargetPath)])).length > 0;
    const deletedSourceFactVisible = (await seededClient.queryFiles([path.join(family.linked, deletedTargetPath)])).length > 0;
    const negative = await seededClient.queryType("demo.NotPresent");
    const seedSweep = await measureReconcile(seededClient, 2);
    await seededClient.flush();
    const seededStatus = await seededClient.status();
    const seededBundles = await seededClient.queryFiles(targetRelativePaths.map(relativePath => path.join(family.linked, relativePath)));
    const postReconcileEquivalent = JSON.stringify(noSeedBundles.map(normalizeBundle)) === JSON.stringify(seededBundles.map(normalizeBundle));
    if (!postReconcileEquivalent) throw new Error("seeded target facts differ from a clean target full sweep");
    const seed = seededStatus.worktreeSeed;
    if (!seed?.attempted || seed.reusedFiles === 0) throw new Error("synthetic sibling seed was not installed");
    if (modifiedTargetReused || deletedSourceFactVisible) throw new Error("sibling seed exposed a modified or deleted target fact");
    if (negative.state !== "UNRESOLVED" || negative.coverage === "COMPLETE") {
      throw new Error("sibling seed enabled a negative lookup before target COMPLETE");
    }

    return {
      sourceFiles: primaryRelativePaths.length,
      noSeed: {
        reconcileElapsedMs: round(noSeedSweep.elapsedMs),
        fullParsedFiles: noSeedSweep.status.files,
        mainEventLoopDelayP99Ms: round(noSeedSweep.eventLoopDelayP99Ms),
        snapshotBytes: noSeedSnapshot.snapshotBytes
      },
      seeded: {
        openElapsedMs: round(openElapsedMs),
        firstIndexQueryElapsedMs: round(firstIndexQueryElapsedMs),
        firstIndexCoverage: coverageLabel(seedOpenStatus),
        firstIndexQueryResolved: firstQuery.state === "RESOLVED",
        manifestValidationMs: seed.manifestValidationMs,
        reusedFiles: seed.reusedFiles,
        deltaParsedFiles: seed.deltaParsedFiles,
        fullParsedFiles: seededStatus.files,
        mainEventLoopDelayP99Ms: round(seedSweep.eventLoopDelayP99Ms),
        snapshotBytes: seededStatus.snapshotBytes,
        modifiedTargetReused,
        deletedSourceFactVisible,
        negativeLookupAllowed: false
      },
      postReconcileEquivalent
    };
  } finally {
    await seededClient?.close().catch(() => undefined);
    await noSeedClient?.close().catch(() => undefined);
    await primaryClient?.close().catch(() => undefined);
  }
}

async function writeFixtureJava(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function runRealWorktreeSeed(sourceRepoRoot: string, targetRepoRoot: string): Promise<{
  sourceRepoRoot: string;
  targetRepoRoot: string;
  sourceFiles: number;
  targetFiles: number;
  changedOrAddedTargetFiles: number;
  deletedSourceFiles: number;
  noSeed: {
    reconcileElapsedMs: number;
    fullParsedFiles: number;
    mainEventLoopDelayP99Ms: number;
    snapshotBytes: number;
  };
  seeded: {
    attempted: boolean;
    openElapsedMs: number;
    firstIndexQueryElapsedMs: number;
    firstIndexCoverage: string;
    firstIndexQueryResolved: boolean;
    candidateSourceDistribution: Record<string, number>;
    manifestValidationMs: number;
    reusedFiles: number;
    deltaParsedFiles: number;
    fullParsedFiles: number;
    reconcileElapsedMs: number;
    mainEventLoopDelayP99Ms: number;
    snapshotBytes: number;
    modifiedTargetReused: boolean;
    deletedSourceFactVisible: boolean;
    negativeLookupAllowed: boolean;
  };
  postReconcileEquivalent: boolean;
}> {
  const cacheBase = await mkdtemp(path.join(tmpdir(), "java-index-real-seed-benchmark-cache-"));
  temporaryRoots.push(cacheBase);
  const primaryCache = path.join(cacheBase, "primary");
  const noSeedCache = path.join(cacheBase, "target-no-seed");
  const seededCache = path.join(cacheBase, "target-seeded");
  const sourceManifest = await scanCurrentManifest(sourceRepoRoot, probeLayout(sourceRepoRoot));
  const targetManifest = await scanCurrentManifest(targetRepoRoot, probeLayout(targetRepoRoot));
  const sourceByPath = new Map(sourceManifest.entries.map(entry => [entry.relativePath, entry]));
  const targetByPath = new Map(targetManifest.entries.map(entry => [entry.relativePath, entry]));
  const changedTargetFiles = targetManifest.discovered.filter(file => sourceByPath.get(file.relativePath)?.contentHash !== targetByPath.get(file.relativePath)?.contentHash);
  const deletedSourceFiles = sourceManifest.discovered.filter(file => !targetByPath.has(file.relativePath));
  let sourceClient: JavaIndexClient | undefined;
  let noSeedClient: JavaIndexClient | undefined;
  let seededClient: JavaIndexClient | undefined;
  try {
    sourceClient = new JavaIndexClient(sourceRepoRoot, primaryCache);
    await sourceClient.open(1);
    await sourceClient.reconcile(1);
    await waitForIdle(sourceClient);
    await sourceClient.flush();
    await sourceClient.close();
    sourceClient = undefined;
    const sourceIdentity = await resolveWorktreeIdentity(sourceRepoRoot);
    await writeFile(path.join(primaryCache, "repo-meta.json"), JSON.stringify({
      repoRoot: sourceRepoRoot,
      repoHash: sourceIdentity.repoHash,
      familyHash: sourceIdentity.familyHash
    }));

    noSeedClient = new JavaIndexClient(targetRepoRoot, noSeedCache);
    await noSeedClient.open(2);
    const noSeedSweep = await measureReconcile(noSeedClient, 2, 180_000);
    await noSeedClient.flush();
    const noSeedStatus = await noSeedClient.status();
    // The no-seed snapshot is now the complete equivalence oracle.  Keep no
    // second 5k-file worker/store resident while loading the seeded target;
    // real A/B runs otherwise double the peak heap for no measurement value.
    await noSeedClient.close();
    noSeedClient = undefined;

    const targetIdentity = await resolveWorktreeIdentity(targetRepoRoot);
    seededClient = new JavaIndexClient(targetRepoRoot, seededCache);
    const openedAt = performance.now();
    const openStatus = await seededClient.open(2, { worktree: targetIdentity, siblingCacheBase: cacheBase });
    const openElapsedMs = performance.now() - openedAt;
    const probeFile = targetManifest.discovered[0]?.absolutePath;
    const firstQueryStartedAt = performance.now();
    const firstQuery = probeFile ? await seededClient.queryFiles([probeFile]) : [];
    const firstIndexQueryElapsedMs = performance.now() - firstQueryStartedAt;
    const modifiedTargetReused = changedTargetFiles.length > 0
      && (await seededClient.queryFiles(changedTargetFiles.map(file => file.absolutePath))).length > 0;
    const deletedSourceFactVisible = deletedSourceFiles.length > 0
      && (await seededClient.queryFiles(deletedSourceFiles.map(file => path.join(targetRepoRoot, file.relativePath)))).length > 0;
    const negative = await seededClient.queryType("task23.__AbsentType");
    const seedSweep = await measureReconcile(seededClient, 2, 180_000);
    await seededClient.flush();
    const seededStatus = await seededClient.status();
    const seed = seededStatus.worktreeSeed;
    const postReconcileEquivalent = (await snapshotFactsDigest(noSeedCache))
      === (await snapshotFactsDigest(seededCache));
    // A real-repo mismatch is report evidence, not a harness crash: retain
    // every measured field so Task 23 can distinguish a failed correctness
    // gate from an environmental failure.  The synthetic run remains a hard
    // assertion for every seed invariant.
    const negativeLookupAllowed = negative.state === "UNRESOLVED" && negative.coverage === "COMPLETE";

    return {
      sourceRepoRoot,
      targetRepoRoot,
      sourceFiles: sourceManifest.discovered.length,
      targetFiles: targetManifest.discovered.length,
      changedOrAddedTargetFiles: changedTargetFiles.length,
      deletedSourceFiles: deletedSourceFiles.length,
      noSeed: {
        reconcileElapsedMs: round(noSeedSweep.elapsedMs),
        fullParsedFiles: noSeedSweep.status.files,
        mainEventLoopDelayP99Ms: round(noSeedSweep.eventLoopDelayP99Ms),
        snapshotBytes: noSeedStatus.snapshotBytes
      },
      seeded: {
        attempted: seed?.attempted ?? false,
        openElapsedMs: round(openElapsedMs),
        firstIndexQueryElapsedMs: round(firstIndexQueryElapsedMs),
        firstIndexCoverage: coverageLabel(openStatus),
        firstIndexQueryResolved: firstQuery.length > 0,
        candidateSourceDistribution: seed?.sourceRepoHash ? { siblingSnapshot: 1 } : {},
        manifestValidationMs: seed?.manifestValidationMs ?? 0,
        reusedFiles: seed?.reusedFiles ?? 0,
        deltaParsedFiles: seed?.deltaParsedFiles ?? 0,
        fullParsedFiles: seededStatus.files,
        reconcileElapsedMs: round(seedSweep.elapsedMs),
        mainEventLoopDelayP99Ms: round(seedSweep.eventLoopDelayP99Ms),
        snapshotBytes: seededStatus.snapshotBytes,
        modifiedTargetReused,
        deletedSourceFactVisible,
        negativeLookupAllowed
      },
      postReconcileEquivalent
    };
  } finally {
    await seededClient?.close().catch(() => undefined);
    await noSeedClient?.close().catch(() => undefined);
    await sourceClient?.close().catch(() => undefined);
  }
}

async function snapshotFactsDigest(cacheDir: string): Promise<string> {
  const compressed = await readFile(path.join(cacheDir, SNAPSHOT_FILE));
  const snapshot = JSON.parse(gunzipSync(compressed).toString("utf8")) as {
    files: unknown[];
    types: unknown[];
    fields: unknown[];
    methods: unknown[];
    edges: unknown[];
  };
  const digest = createHash("sha256");
  for (const values of [snapshot.files, snapshot.types, snapshot.fields, snapshot.methods, snapshot.edges]) {
    const recordHashes: string[] = [];
    for (const value of values) {
      // Index maps may retain a different insertion order after a seed is
      // reconciled.  Compare the normalized fact multiset, not that private
      // iteration order; each record stays small even for large repositories.
      const record = JSON.stringify(value, (key, nested) =>
        key === "mtimeMs" || key === "ctimeMs" || key === "generation" ? undefined : nested);
      recordHashes.push(createHash("sha256").update(record).digest("hex"));
    }
    recordHashes.sort();
    for (const recordHash of recordHashes) {
      digest.update(recordHash);
      digest.update("\n");
    }
    digest.update("\0");
  }
  return digest.digest("hex");
}

function implementationSource(index: number): string {
  return [
    "package demo;",
    `public class Impl${index} implements Gateway {`,
    `  public String execute() { return \"${index}\"; }`,
    "}",
    ""
  ].join("\n");
}

async function measureReconcile(client: JavaIndexClient, generation: number, timeoutMs = IDLE_TIMEOUT_MS): Promise<{
  elapsedMs: number;
  eventLoopDelayP99Ms: number;
  status: JavaIndexStatus;
}> {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const startedAt = performance.now();
  try {
    await client.reconcile(generation);
    const status = await waitForIdle(client, timeoutMs);
    if (!hasCompleteCoverage(status)) throw new Error("reconcile did not reach COMPLETE coverage");
    return {
      elapsedMs: performance.now() - startedAt,
      eventLoopDelayP99Ms: histogram.percentile(99) / 1_000_000,
      status
    };
  } finally {
    histogram.disable();
  }
}

function coverageLabel(status: JavaIndexStatus): string {
  return status.coverage.length === 0 ? "NO_COVERAGE" : [...new Set(status.coverage.map(entry => entry.state))].sort().join(",");
}

async function measureVisible(id: string, action: () => Promise<void>): Promise<{ id: string; visibleMs: number }> {
  const startedAt = performance.now();
  await action();
  return { id, visibleMs: round(performance.now() - startedAt) };
}

async function requiredType(client: JavaIndexClient, name: string) {
  const result = await client.queryType(name);
  if (result.state !== "RESOLVED") throw new Error(`${name} was not resolved after mutation`);
  return result.type;
}

async function requireUnresolved(client: JavaIndexClient, name: string): Promise<void> {
  const result = await client.queryType(name);
  if (result.state !== "UNRESOLVED") throw new Error(`${name} remained visible after mutation`);
}

function methodSignatureServiceSource(): string {
  return [
    "package demo;",
    "public class Service implements Gateway {",
    "  public String handle(String input, int attempts) { return input + attempts; }",
    "}",
    ""
  ].join("\n");
}

function renamedServiceSource(packageName: string, typeName: string): string {
  return [
    `package ${packageName};`,
    `public class ${typeName} { public String handle(String input) { return input; } }`,
    ""
  ].join("\n");
}

async function measureFreshFullSweep(fixture: Fixture): Promise<{
  elapsedMs: number;
  eventLoopDelayP99Ms: number;
  snapshotBytes: number;
}> {
  const client = new JavaIndexClient(fixture.root, fixture.cacheDir);
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const startedAt = performance.now();
  try {
    await client.open(1);
    await client.reconcile(1);
    const status = await waitForIdle(client);
    if (!hasCompleteCoverage(status)) throw new Error(`fresh sweep did not reach COMPLETE: ${JSON.stringify(status.coverage)}`);
    await client.flush();
    return {
      elapsedMs: performance.now() - startedAt,
      eventLoopDelayP99Ms: histogram.percentile(99) / 1_000_000,
      snapshotBytes: (await client.status()).snapshotBytes
    };
  } finally {
    histogram.disable();
    await client.close();
  }
}

async function buildCompleteSnapshot(fixture: Fixture, generation: number): Promise<void> {
  const client = new JavaIndexClient(fixture.root, fixture.cacheDir);
  try {
    await client.open(generation);
    await client.reconcile(generation);
    const status = await waitForIdle(client);
    if (!hasCompleteCoverage(status)) throw new Error("snapshot source fixture did not reach COMPLETE");
    await client.flush();
  } finally {
    await client.close();
  }
}

async function waitForIdle(client: JavaIndexClient, timeoutMs = IDLE_TIMEOUT_MS): Promise<JavaIndexStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await client.status();
  while (status.pendingForeground > 0 || status.pendingBackground > 0) {
    if (Date.now() >= deadline) throw new Error(`JavaIndex did not become idle in ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 10));
    status = await client.status();
  }
  return status;
}

function hasCompleteCoverage(status: JavaIndexStatus): boolean {
  return status.coverage.length > 0 && status.coverage.every(entry => entry.state === "COMPLETE");
}

async function measureMany(samples: number, action: (sample: number) => Promise<number>): Promise<number[]> {
  const values: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) values.push(await action(sample));
  return values;
}

function summarize(values: number[]): Measurement {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    maxMs: round(sorted.at(-1) ?? 0)
  };
}

function percentile(sorted: number[], value: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeBundle(bundle: JavaFileBundle): unknown {
  // Generation and mtime are lifecycle metadata.  Equivalence here is about
  // extracted facts and resolved static edges for identical source content.
  return JSON.parse(JSON.stringify(bundle, (key, value) =>
    key === "mtimeMs" || key === "ctimeMs" || key === "generation" ? undefined : value));
}

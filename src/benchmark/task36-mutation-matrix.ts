// input: an isolated Java/Maven/MyBatis fixture and an optional JSON output path.
// output: deterministic Task 36 JavaIndex freshness-gate results from one worker lifetime.
// pos: Task 36's required nine-case mutation freshness matrix.
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ImpactOptions } from "../agent-types.js";
import { AgentRouter } from "../agent-router/index.js";
import { SqlJavaIndexClient } from "../java-index/sql/sql-client.js";
import type { JavaFileBundle, JavaIndexStatus } from "../java-index/index-types.js";
import { RouterJavaIndex, type RouterIndex } from "../java-index/router-java-index.js";
import { LayoutManager } from "../layout-manager.js";
import { RepoChangeCoordinator } from "../repo-change-coordinator.js";
import { GenerationClock, type RepoChangeBatch } from "../repo-generation.js";
import { createRequestContext } from "../runtime/request-context.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { RgRunner } from "../search/rg-runner.js";
import type { RgQuery, SearchResult } from "../search/search-types.js";
import { resolveWorktreeIdentity } from "../worktree-identity.js";
import { isJavaIndexQuiescent } from "./java-index-idle.js";

const IDLE_TIMEOUT_MS = 30_000;
const WATCHER_SETTLE_QUIET_MS = 500;

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
  changedDuringRequest: boolean;
  requestGeneration: number;
  indexedGeneration: number;
};

export type Task36MutationMatrix = {
  schemaVersion: 1;
  gate: {
    expectedCases: number;
    staleCount: number;
    passed: boolean;
  };
  cases: Task36MutationCase[];
  watcher: {
    ready: boolean;
    batches: number;
    generations: number[];
  };
  overlapProbe: {
    source: "agent-router";
    requestGeneration: number;
    indexedGeneration: number;
    changedDuringRequest: boolean;
  };
};

type Fixture = {
  root: string;
  cacheDir: string;
  target: string;
  importConsumer: string;
  renameSource: string;
  renamedTarget: string;
  deletable: string;
  rootPom: string;
  mapper: string;
  broken: string;
};

type SettledMutation = {
  generation: number;
  status: JavaIndexStatus;
};

class EmptyRgRunner extends RgRunner {
  override async run(_query: RgQuery, _budget: DeadlineBudget): Promise<SearchResult> {
    return { files: [], completion: "COMPLETE", rawBytes: 0, totalMatches: 0, elapsedMs: 0 };
  }
}

export async function runTask36MutationMatrix(): Promise<Task36MutationMatrix> {
  const fixture = await createFixture();
  const client = new SqlJavaIndexClient(fixture.root, path.join(fixture.cacheDir, "index.sqlite"));
  const index = new RouterJavaIndex(fixture.root, client);
  const clock = new GenerationClock();
  const layout = new LayoutManager(fixture.root);
  const identity = await resolveWorktreeIdentity(fixture.root);
  const coordinator = new RepoChangeCoordinator(
    fixture.root,
    identity,
    fixture.cacheDir,
    clock,
    layout,
    20,
    () => client.localStatus().files
  );
  const batches: RepoChangeBatch[] = [];
  const cases: Task36MutationCase[] = [];
  coordinator.onBatch(async batch => {
    await applyBatchToIndex(index, client, batch);
    batches.push(batch);
  });
  try {
    await coordinator.start();
    const watcherReady = await coordinator.awaitReadyWithin(5_000);
    if (!watcherReady) throw new Error("Task36 mutation watcher did not become ready");
    // Give the platform backend one scheduling turn after its ready event;
    // mutation evidence must come from the watcher, never queueForTest().
    await new Promise(resolve => setTimeout(resolve, 50));
    await index.open(clock.snapshot().value);
    await index.reconcile(clock.snapshot().value);
    await waitForIdle(client);

    const methodBody = await settleWatchedMutation(coordinator, client, clock, batches, [fixture.target], async () => {
      await writeFile(fixture.target, targetSource({ body: "newBody", packagePrivate: false, nestedRecord: false }));
    });
    cases.push(await observeCase(client, "method-body", methodBody, async () => {
      const bundle = await requiredBundle(client, fixture.target);
      const body = requiredMethod(bundle, "bodyMutation");
      const oldBody = requiredMethod(bundle, "oldBody");
      const newBody = requiredMethod(bundle, "newBody");
      return bundle.edges.some(edge => edge.kind === "CALLS" && edge.fromId === body.methodId && edge.toId === newBody.methodId)
        && !bundle.edges.some(edge => edge.kind === "CALLS" && edge.fromId === body.methodId && edge.toId === oldBody.methodId);
    }));

    const packagePrivate = await settleWatchedMutation(coordinator, client, clock, batches, [fixture.target], async () => {
      await writeFile(fixture.target, targetSource({ body: "newBody", packagePrivate: true, nestedRecord: false }));
    });
    cases.push(await observeCase(client, "package-private-method", packagePrivate, async () => {
      const bundle = await requiredBundle(client, fixture.target);
      return bundle.methods.some(method => method.name === "packageVisible")
        && !bundle.methods.some(method => method.name === "packagePrivateLegacy");
    }));

    const nestedRecord = await settleWatchedMutation(coordinator, client, clock, batches, [fixture.target], async () => {
      await writeFile(fixture.target, targetSource({ body: "newBody", packagePrivate: true, nestedRecord: true }));
    });
    cases.push(await observeCase(client, "nested-record", nestedRecord, async () => {
      const bundle = await requiredBundle(client, fixture.target);
      return bundle.types.some(type => type.simpleName === "Payload")
        && !bundle.types.some(type => type.simpleName === "LegacyPayload");
    }));

    const renameMutation = await settleWatchedMutation(
      coordinator,
      client,
      clock,
      batches,
      [fixture.renamedTarget, fixture.renameSource],
      async () => {
        await rename(fixture.renameSource, fixture.renamedTarget);
        await new Promise(resolve => setTimeout(resolve, 250));
        await writeFile(fixture.renamedTarget, "package demo;\npublic class RenamedTarget {}\n");
      }
    );
    cases.push(await observeCase(client, "rename-java-type-file", renameMutation, async () =>
      await isUnresolved(client, "demo.RenameSource") && await isResolved(client, "demo.RenamedTarget")
    ));

    const deletion = await settleWatchedMutation(coordinator, client, clock, batches, [fixture.deletable], async () => {
      await rm(fixture.deletable);
    });
    cases.push(await observeCase(client, "delete-java-file", deletion, async () =>
      await isUnresolved(client, "demo.Deletable") && (await client.queryFiles([fixture.deletable])).length === 0
    ));

    const importSwitch = await settleWatchedMutation(coordinator, client, clock, batches, [fixture.importConsumer], async () => {
      await writeFile(fixture.importConsumer, importConsumerSource("b.User"));
    });
    cases.push(await observeCase(client, "duplicate-simple-name-import-switch", importSwitch, async () => {
      const bundle = await requiredBundle(client, fixture.importConsumer);
      const field = bundle.fields.find(candidate => candidate.name === "user");
      return field?.type.resolution.state === "RESOLVED_REPO"
        && field.type.resolution.typeId === "type:b.User"
        && !bundle.edges.some(edge => edge.kind === "FIELD_TYPE" && edge.toId === "type:a.User");
    }));

    const modulePom = path.join(fixture.root, "modules", "extra", "pom.xml");
    const moduleType = path.join(fixture.root, "modules", "extra", "src", "main", "java", "extra", "ModuleAdded.java");
    const pomModule = await settleWatchedMutation(coordinator, client, clock, batches, [fixture.rootPom], async () => {
      await mkdir(path.dirname(moduleType), { recursive: true });
      await writeFile(fixture.rootPom, rootPomSource(true));
      await writeFile(modulePom, "<project><modelVersion>4.0.0</modelVersion></project>\n");
      await writeFile(moduleType, "package extra;\npublic class ModuleAdded {}\n");
    });
    cases.push(await observeCase(client, "pom-module", pomModule, async () =>
      await isResolved(client, "extra.ModuleAdded")
    ));

    const mybatis = await settleWatchedMutation(coordinator, client, clock, batches, [fixture.mapper], async () => {
      await writeFile(fixture.mapper, mapperSource("findFresh"));
    });
    cases.push(await observeCase(client, "mybatis-xml-statement", mybatis, async () => {
      const resource = await client.queryMyBatisResource("src/main/resources/mapper/OrderMapper.xml");
      return resource?.statements.some(statement => statement.id === "findFresh") === true
        && !resource.statements.some(statement => statement.id === "findStale");
    }));

    await settleWatchedMutation(coordinator, client, clock, batches, [fixture.broken], async () => {
      await writeFile(fixture.broken, "package demo;\npublic class Broken { String stale( {\n");
    });
    const repaired = await settleWatchedMutation(coordinator, client, clock, batches, [fixture.broken], async () => {
      await writeFile(fixture.broken, "package demo;\npublic class Broken { String repaired() { return \"ok\"; } }\n");
    });
    cases.push(await observeCase(client, "malformed-java-repair", repaired, async () => {
      const bundle = await requiredBundle(client, fixture.broken);
      return await isResolved(client, "demo.Broken")
        && bundle.methods.some(method => method.name === "repaired")
        && !bundle.methods.some(method => method.name === "stale");
    }));

    const overlapProbe = await verifyChangedDuringRequest({
      index,
      client,
      coordinator,
      clock,
      batches,
      repoRoot: fixture.root,
      target: fixture.target,
      repoHash: identity.repoHash,
      layout
    });
    const staleCount = cases.reduce((total, item) => total + item.staleCount, 0);
    return {
      schemaVersion: 1,
      gate: {
        expectedCases: CASE_IDS.length,
        staleCount,
        passed: staleCount === 0
          && cases.length === CASE_IDS.length
          && watcherReady
          && overlapProbe.changedDuringRequest
      },
      cases,
      watcher: {
        ready: watcherReady,
        batches: batches.length,
        generations: batches.map(batch => batch.generation)
      },
      overlapProbe
    };
  } finally {
    await coordinator.close();
    await index.close();
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function observeCase(
  client: SqlJavaIndexClient,
  id: Task36MutationCaseId,
  mutation: SettledMutation,
  assertLatest: () => Promise<boolean>
): Promise<Task36MutationCase> {
  const before = await client.status();
  const oldFactAbsent = await assertLatest();
  const after = await client.status();
  const changedDuringRequest = after.indexedGeneration !== before.indexedGeneration;
  const currentGeneration = after.indexedGeneration;
  const fresh = oldFactAbsent
    && currentGeneration === mutation.generation
    && mutation.status.indexedGeneration === mutation.generation
    && after.pendingForeground === 0
    && after.pendingBackground === 0;
  return {
    id,
    staleCount: fresh ? 0 : 1,
    oldFactAbsent,
    changedDuringRequest,
    requestGeneration: before.indexedGeneration,
    indexedGeneration: currentGeneration
  };
}

async function applyBatchToIndex(
  index: RouterJavaIndex,
  client: SqlJavaIndexClient,
  batch: RepoChangeBatch
): Promise<void> {
  if (batch.storm || batch.changes.some(change => change.kind === "BUILD_CHANGE")) {
    await index.reconcile(batch.generation);
    await waitForIdle(client);
    return;
  }
  const changed: string[] = [];
  const deleted: string[] = [];
  const resources: string[] = [];
  for (const change of batch.changes) {
    if (change.kind === "JAVA_ADD" || change.kind === "JAVA_CHANGE") changed.push(change.absolutePath);
    else if (change.kind === "JAVA_DELETE") deleted.push(change.absolutePath);
    else if (change.kind === "RESOURCE_CHANGE") resources.push(change.absolutePath);
  }
  await index.refresh(batch.generation, changed, deleted);
  if (resources.length > 0) {
    await client.refreshResources(batch.generation, resources);
  }
  await waitForIdle(client);
}

async function settleWatchedMutation(
  coordinator: RepoChangeCoordinator,
  client: SqlJavaIndexClient,
  clock: GenerationClock,
  batches: readonly RepoChangeBatch[],
  expectedPaths: readonly string[],
  mutate: () => Promise<void>
): Promise<SettledMutation> {
  const firstBatch = batches.length;
  const expected = new Set(expectedPaths.map(file => path.resolve(file)));
  await mutate();
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  let stableSince = 0;
  let lastBatchCount = -1;
  let lastObserved = new Set<string>();
  while (Date.now() < deadline) {
    await coordinator.flushNow();
    const observedBatches = batches.slice(firstBatch);
    const observed = new Set(observedBatches.flatMap(batch => batch.changes.map(change => path.resolve(change.absolutePath))));
    lastObserved = observed;
    const allObserved = [...expected].every(file => observed.has(file));
    if (allObserved && coordinator.status().pending === 0) {
      if (lastBatchCount !== observedBatches.length) {
        lastBatchCount = observedBatches.length;
        stableSince = Date.now();
      // Chokidar's awaitWriteFinish waits 100 ms before publishing a stable
      // write.  Keep a materially larger quiet window here: under a loaded
      // test runner, the coordinator's own polling timer can otherwise run
      // before Chokidar publishes the final change half of a rename, making
      // an intermediate JavaIndex generation look settled.
      } else if (Date.now() - stableSince >= WATCHER_SETTLE_QUIET_MS) {
        const status = await waitForIdle(client);
        const generation = clock.snapshot().value;
        if (status.indexedGeneration === generation) return { generation, status };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(
    `watcher did not settle paths at the latest generation: firstBatch=${firstBatch} allBatches=${JSON.stringify(batches.map(batch => batch.changes))} expected=${[...expected].join(", ")} observed=${[...lastObserved].join(", ")} status=${JSON.stringify(coordinator.status())}`
  );
}

async function verifyChangedDuringRequest(input: {
  index: RouterJavaIndex;
  client: SqlJavaIndexClient;
  coordinator: RepoChangeCoordinator;
  clock: GenerationClock;
  batches: readonly RepoChangeBatch[];
  repoRoot: string;
  target: string;
  repoHash: string;
  layout: LayoutManager;
}): Promise<Task36MutationMatrix["overlapProbe"]> {
  let releaseFirstStatus!: () => void;
  let firstStatusCaptured!: () => void;
  const release = new Promise<void>(resolve => { releaseFirstStatus = resolve; });
  const captured = new Promise<void>(resolve => { firstStatusCaptured = resolve; });
  let statusCalls = 0;
  const delayedIndex = new Proxy(input.index, {
    get(target, property, receiver) {
      if (property === "routerStatus") {
        return async () => {
          const status = await target.routerStatus();
          statusCalls += 1;
          if (statusCalls === 1) {
            firstStatusCaptured();
            await release;
          }
          return status;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as RouterIndex;
  const session = noLspSession();
  const edgeStore = noOpSemanticEdgeStore();
  const router = new AgentRouter(
    input.repoRoot,
    session as never,
    delayedIndex as never,
    input.layout.current(),
    undefined,
    new EmptyRgRunner(),
    edgeStore as never
  );
  const requestGeneration = input.clock.snapshot().value;
  const options: ImpactOptions & { verbosity: "diagnostic" } = {
    anchors: [{ file: input.target, line: 3, column: 24 }],
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
    repoRoot: input.repoRoot,
    repoHash: input.repoHash,
    generation: requestGeneration,
    freshnessMode: "NORMAL",
    cacheReadAllowed: true,
    cacheWriteAllowed: true,
    negativeLookupAllowed: false,
    mode: "balanced",
    semanticPolicy: "fast",
    budget: DeadlineBudget.fromTimeout(10_000)
  });
  const impact = router.impact(options, request);
  await withTimeout(captured, 5_000, "AgentRouter sourceStatusBefore");
  try {
    await settleWatchedMutation(
      input.coordinator,
      input.client,
      input.clock,
      input.batches,
      [input.target],
      async () => writeFile(input.target, targetSource({ body: "oldBody", packagePrivate: true, nestedRecord: true }))
    );
  } finally {
    releaseFirstStatus();
  }
  const result = await withTimeout(impact, 10_000, "overlapping AgentRouter request");
  return {
    source: "agent-router",
    requestGeneration: result.freshness.requestGeneration,
    indexedGeneration: result.freshness.indexedGeneration,
    changedDuringRequest: result.freshness.changedDuringRequest
  };
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "task36-mutation-matrix-"));
  const javaRoot = path.join(root, "src", "main", "java", "demo");
  const cacheDir = path.join(root, ".java-index-cache");
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
  return { root, cacheDir, target, importConsumer, renameSource, renamedTarget, deletable, rootPom, mapper, broken };
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

async function waitForIdle(client: SqlJavaIndexClient): Promise<JavaIndexStatus> {
  const deadline = Date.now() + IDLE_TIMEOUT_MS;
  let status = await client.status();
  while (!isJavaIndexQuiescent(status)) {
    if (Date.now() >= deadline) throw new Error(`JavaIndex did not become idle in ${IDLE_TIMEOUT_MS}ms`);
    await new Promise(resolve => setTimeout(resolve, 10));
    status = await client.status();
  }
  return status;
}

async function requiredBundle(client: SqlJavaIndexClient, absolutePath: string): Promise<JavaFileBundle> {
  const bundle = (await client.queryFiles([absolutePath]))[0];
  if (!bundle) throw new Error(`expected JavaIndex facts for ${absolutePath}`);
  return bundle;
}

function requiredMethod(bundle: JavaFileBundle, name: string) {
  const method = bundle.methods.find(candidate => candidate.name === name);
  if (!method) throw new Error(`expected ${name} method in ${bundle.file.relativePath}`);
  return method;
}

async function isResolved(client: SqlJavaIndexClient, typeText: string): Promise<boolean> {
  return (await client.queryType(typeText)).state === "RESOLVED";
}

async function isUnresolved(client: SqlJavaIndexClient, typeText: string): Promise<boolean> {
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

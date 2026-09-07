// input: A real temp repo indexed by a real JavaIndexClient worker (never hand-assembled facts).
// output: Coverage for RouterJavaIndex's FrameworkIndexView wiring - frameworkFactsFor/declarationsById/
//         resolvedCallees/repositoryMarkers/frameworkStatus, plus cache invalidation across refresh().
// pos: Task 27 Slice B. The pure projection logic itself is covered by framework-index-view.test.ts;
//      this file only proves the orchestration (id -> file resolution -> queryFiles -> project) is wired right.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import type { JavaFileBundle, JavaIndexStatus, JavaParseState } from "./index-types.js";

import { MAX_FRAMEWORK_FACT_FILES } from "./framework-index-view.js";
import { MAX_FACTS_FOR_FILES } from "./router-facts.js";
import { RouterJavaIndex } from "./router-java-index.js";

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for condition after ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function readyRouter(repoRoot: string): Promise<RouterJavaIndex> {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "framework-view-cache-"));
  const router = RouterJavaIndex.create(repoRoot, cacheDir);
  await router.open(1);
  await router.reconcile(1);
  await waitFor(async () => (await router.status()).pendingBackground === 0, 15_000);
  return router;
}

function readyStatus(generation: number): JavaIndexStatus {
  return {
    state: "READY",
    indexedGeneration: generation,
    files: 0,
    types: 0,
    methods: 0,
    edges: 0,
    snapshotBytes: 0,
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: [],
    resourceCoverage: []
  };
}

function emptyBundle(repoRoot: string, absolutePath: string, generation: number, parseState: JavaParseState = "COMPLETE"): JavaFileBundle {
  return {
    file: {
      fileId: `file:${path.relative(repoRoot, absolutePath).replace(/\\/g, "/")}`,
      relativePath: path.relative(repoRoot, absolutePath).replace(/\\/g, "/"),
      sourceRoot: "src/main/java",
      module: "",
      sourceSet: "main",
      packageName: "demo",
      imports: [],
      topLevelTypeIds: [],
      allTypeIds: [],
      contentHash: "hash",
      size: 1,
      mtimeMs: 1,
      parseState,
      parseErrorCount: parseState === "COMPLETE" ? 0 : 1,
      generation
    },
    types: [],
    fields: [],
    methods: [],
    edges: []
  };
}

class RecordingFactsClient {
  generation = 1;
  readonly refreshCalls: string[][] = [];
  readonly refreshPriorities: Array<"ACTIVE_ANCHOR" | undefined> = [];
  readonly queryFilesCalls: string[][] = [];
  statusCalls = 0;
  queryAnchorCalls = 0;
  queryFilesImpl: (files: string[]) => Promise<JavaFileBundle[]>;

  constructor(private readonly repoRoot: string) {
    this.queryFilesImpl = async files => files.map(file => emptyBundle(this.repoRoot, file, this.generation));
  }

  localStatus(): JavaIndexStatus {
    return readyStatus(this.generation);
  }

  async refresh(
    generation: number,
    changed: string[],
    _deleted: string[] = [],
    _requestOptions: unknown = {},
    priority?: "ACTIVE_ANCHOR"
  ): Promise<JavaIndexStatus> {
    this.generation = generation;
    this.refreshCalls.push([...changed]);
    this.refreshPriorities.push(priority);
    return readyStatus(generation);
  }

  async queryFiles(files: string[]): Promise<JavaFileBundle[]> {
    this.queryFilesCalls.push([...files]);
    return this.queryFilesImpl(files);
  }

  async status(): Promise<JavaIndexStatus> {
    this.statusCalls += 1;
    return readyStatus(this.generation);
  }

  async queryAnchor(): Promise<undefined> {
    this.queryAnchorCalls += 1;
    return undefined;
  }
}

test("factsForFiles preserves input order while refreshing and hydrating each unique file once", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-facts-batch-order-"));
  write(repoRoot, "src/main/java/demo/A.java", "package demo; class A {}\n");
  write(repoRoot, "src/main/java/demo/B.java", "package demo; class B {}\n");
  const a = path.join(repoRoot, "src/main/java/demo/A.java");
  const b = path.join(repoRoot, "src/main/java/demo/B.java");
  const client = new RecordingFactsClient(repoRoot);
  client.queryFilesImpl = async files => [...files].reverse().map(file => emptyBundle(repoRoot, file, client.generation));
  const router = new RouterJavaIndex(repoRoot, client as never);

  const result = await router.factsForFiles([a, b, a], 1);

  assert.equal(result.completion, "COMPLETE");
  assert.deepEqual(result.items.map(item => item.state), ["FOUND", "FOUND", "FOUND"]);
  assert.deepEqual(result.items.map(item => item.absolutePath), [a, b, a]);
  assert.strictEqual(
    result.items[0]!.state === "FOUND" ? result.items[0]!.facts : undefined,
    result.items[2]!.state === "FOUND" ? result.items[2]!.facts : undefined,
    "duplicate inputs must share the one authoritative projection"
  );
  assert.deepEqual(client.refreshCalls, [[a, b]]);
  assert.deepEqual(client.queryFilesCalls, [[a, b]]);

  await router.factsForFiles([a, b], 1);
  assert.equal(client.refreshCalls.length, 1, "same-generation authoritative facts must be cached");
  assert.equal(client.queryFilesCalls.length, 1);
  await router.factsForFiles([a, b], 2);
  assert.equal(client.refreshCalls.length, 2, "a new request generation must not reuse the old batch");
  assert.equal(client.queryFilesCalls.length, 2);
});

test("ensureFresh forwards ACTIVE_ANCHOR only when the caller explicitly requests it", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-active-anchor-priority-"));
  const file = path.join(repoRoot, "src/main/java/demo/Anchor.java");
  write(repoRoot, "src/main/java/demo/Anchor.java", "package demo; class Anchor {}\n");
  const client = new RecordingFactsClient(repoRoot);
  const router = new RouterJavaIndex(repoRoot, client as never);

  await router.ensureFresh([file], 1, { priority: "ACTIVE_ANCHOR" });
  await router.ensureFresh([file], 2);

  assert.deepEqual(client.refreshPriorities, ["ACTIVE_ANCHOR", undefined]);
});

test("factsForFiles caps unique work at 70 and isolates one malformed source", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-facts-batch-cap-"));
  const files = Array.from({ length: MAX_FACTS_FOR_FILES + 1 }, (_, index) => {
    const relative = `src/main/java/demo/F${index}.java`;
    write(repoRoot, relative, `package demo; class F${index} {}\n`);
    return path.join(repoRoot, relative);
  });
  const client = new RecordingFactsClient(repoRoot);
  client.queryFilesImpl = async queried => queried.map(file => emptyBundle(
    repoRoot,
    file,
    client.generation,
    file === files[1] ? "FAILED" : "COMPLETE"
  ));
  const router = new RouterJavaIndex(repoRoot, client as never);

  const result = await router.factsForFiles(files, 1);

  assert.equal(result.completion, "PARTIAL");
  assert.equal(result.truncated, true);
  assert.equal(client.refreshCalls[0]!.length, MAX_FACTS_FOR_FILES);
  assert.equal(client.queryFilesCalls[0]!.length, MAX_FACTS_FOR_FILES);
  assert.equal(result.items[0]!.state, "FOUND", "a neighboring valid item survives one malformed source");
  assert.deepEqual(result.items[1], {
    inputFile: files[1],
    absolutePath: files[1],
    state: "DEGRADED",
    reason: "INDEX_INCOMPLETE"
  });
  assert.deepEqual(result.items.at(-1), {
    inputFile: files.at(-1),
    absolutePath: files.at(-1),
    state: "DEGRADED",
    reason: "LIMIT_EXCEEDED"
  });
});

test("request memo singleflights exact queries, evicts rejection, and partitions nested deadlines", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-request-memo-"));
  const file = path.join(repoRoot, "src/main/java/demo/A.java");
  write(repoRoot, "src/main/java/demo/A.java", "package demo; class A {}\n");
  const client = new RecordingFactsClient(repoRoot);
  const router = new RouterJavaIndex(repoRoot, client as never);

  await router.withRequestOptions({ budget: DeadlineBudget.fromTimeout(1_000) }, async () => {
    await Promise.all([router.queryFiles([file]), router.queryFiles([file])]);
    assert.equal(client.queryFilesCalls.length, 1, "same request and generation share the in-flight RPC");

    client.queryFilesImpl = async () => { throw new Error("transient query failure"); };
    await assert.rejects(() => router.queryFiles([file, file]));
    client.queryFilesImpl = async files => files.map(item => emptyBundle(repoRoot, item, client.generation));
    await router.queryFiles([file, file]);
    assert.equal(client.queryFilesCalls.length, 3, "a rejected memo entry must be evicted before retry");

    await router.withRequestOptions({ budget: DeadlineBudget.fromTimeout(500) }, () => router.queryFiles([file]));
    assert.equal(client.queryFilesCalls.length, 4, "a nested control boundary must not inherit the parent in-flight/result memo");
  });

  await Promise.all([
    router.withRequestOptions({ budget: DeadlineBudget.fromTimeout(1_000) }, () => router.queryFiles([file])),
    router.withRequestOptions({ budget: DeadlineBudget.fromTimeout(1_000) }, () => router.queryFiles([file]))
  ]);
  assert.equal(client.queryFilesCalls.length, 6, "independent root requests never share request-local memo state");
});

test("request memo shares anchor and status probes while the final status refresh stays authoritative", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-request-probes-"));
  const file = path.join(repoRoot, "src/main/java/demo/A.java");
  write(repoRoot, "src/main/java/demo/A.java", "package demo; class A {}\n");
  const client = new RecordingFactsClient(repoRoot);
  const router = new RouterJavaIndex(repoRoot, client as never);

  await router.withRequestOptions({ budget: DeadlineBudget.fromTimeout(1_000) }, async () => {
    await Promise.all([
      router.queryAnchor(file, 1, 1),
      router.queryAnchor("src/main/java/demo/A.java", 1, 1)
    ]);
    await Promise.all([router.routerStatus(), router.routerStatus(), router.frameworkStatus()]);
    assert.equal(router.localRouterStatus().javaIndex.indexedGeneration, 1);
    await router.routerStatus(true);
  });

  assert.equal(client.queryAnchorCalls, 1, "canonical anchor coordinates share one request-local RPC");
  assert.equal(client.statusCalls, 2, "request-scoped readers share one STATUS and the final refresh remains distinct");
  await router.withRequestOptions({ budget: DeadlineBudget.fromTimeout(1_000) }, () => router.queryAnchor(file, 1, 1));
  assert.equal(client.queryAnchorCalls, 2, "independent requests do not share anchor results");
});

test("metadata-only reference and implementer discovery skips type resolution and bundle hydration", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-metadata-only-discovery-"));
  const client = new RecordingFactsClient(repoRoot);
  let typeReferencerCalls = 0;
  let implementerCalls = 0;
  Object.assign(client, {
    async queryTypeReferencers() {
      typeReferencerCalls += 1;
      return [{
        sourceId: "type:demo.Usage",
        targetId: "type:demo.Anchor",
        sourceFile: "src/main/java/demo/Usage.java",
        sourceModule: "",
        sourceSet: "main",
        kind: "FIELD_TYPE",
        confidence: 1,
        generation: 1
      }];
    },
    async queryImplementers() {
      implementerCalls += 1;
      return [{
        typeId: "type:demo.AnchorImpl",
        fqn: "demo.AnchorImpl",
        simpleName: "AnchorImpl",
        kind: "class",
        fileId: "src/main/java/demo/AnchorImpl.java",
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 17 } },
        modifiers: [],
        annotations: [],
        typeParameters: [],
        extends: [],
        implements: [],
        permits: [],
        fieldIds: [],
        methodIds: [],
        confidence: 1
      }];
    },
    async queryType() {
      throw new Error("known type ids must skip QUERY_TYPE");
    }
  });
  client.queryFilesImpl = async () => {
    throw new Error("metadata-only discovery must skip QUERY_FILES");
  };
  const router = new RouterJavaIndex(repoRoot, client as never);

  const references = await router.findTypeReferences("Anchor", 20, {
    typeId: "type:demo.Anchor",
    hydrate: false
  });
  const implementations = await router.findImplementers("demo.Anchor", 8, undefined, {
    typeId: "type:demo.Anchor",
    hydrate: false
  });

  assert.deepEqual(references.map(item => item.absolutePath), [path.join(repoRoot, "src/main/java/demo/Usage.java")]);
  assert.deepEqual(implementations.map(item => item.absolutePath), [path.join(repoRoot, "src/main/java/demo/AnchorImpl.java")]);
  assert.equal(typeReferencerCalls, 1);
  assert.equal(implementerCalls, 1);
  assert.equal(client.queryFilesCalls.length, 0);
});

test("factsForFiles classifies deadline failure and one request hydrates source/framework surfaces once", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-cross-surface-memo-"));
  const file = path.join(repoRoot, "src/main/java/demo/A.java");
  write(repoRoot, "src/main/java/demo/A.java", "package demo; class A {}\n");

  const deadlineClient = new RecordingFactsClient(repoRoot);
  deadlineClient.queryFilesImpl = async () => {
    throw new JavaIntelligenceError("DEADLINE_EXCEEDED", "synthetic deadline");
  };
  const deadlineRouter = new RouterJavaIndex(repoRoot, deadlineClient as never);
  const deadlineResult = await deadlineRouter.factsForFiles([file], 1);
  assert.deepEqual(deadlineResult.items, [{
    inputFile: file,
    absolutePath: file,
    state: "DEGRADED",
    reason: "DEADLINE_EXCEEDED",
    detail: "DEADLINE_EXCEEDED"
  }]);
  await assert.rejects(
    () => deadlineRouter.factsFor(file, 1),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "DEADLINE_EXCEEDED"
  );

  const client = new RecordingFactsClient(repoRoot);
  const router = new RouterJavaIndex(repoRoot, client as never);
  await router.withRequestOptions({ budget: DeadlineBudget.fromTimeout(1_000) }, async () => {
    const [source, framework, frameworkBatch] = await Promise.all([
      router.factsFor(file, 1),
      router.frameworkFactsFor(file, 1),
      router.frameworkFactsForFiles([file], 1)
    ]);
    assert.equal(source.factSource, "javaIndex");
    assert.equal(framework.coverage, "COMPLETE");
    assert.strictEqual(frameworkBatch[0], framework);
  });
  assert.equal(client.refreshCalls.length, 1);
  assert.equal(client.queryFilesCalls.length, 1, "source, type-reference and framework projections share one hydrate");
});

test("equivalent facts batches share one canonical refresh and hydrate within a request", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-canonical-facts-memo-"));
  write(repoRoot, "src/main/java/demo/A.java", "package demo; class A {}\n");
  write(repoRoot, "src/main/java/demo/B.java", "package demo; class B {}\n");
  const a = path.join(repoRoot, "src/main/java/demo/A.java");
  const b = path.join(repoRoot, "src/main/java/demo/B.java");
  const client = new RecordingFactsClient(repoRoot);
  const router = new RouterJavaIndex(repoRoot, client as never);

  await router.withRequestOptions({ budget: DeadlineBudget.fromTimeout(1_000) }, async () => {
    await Promise.all([
      router.factsForFiles([a, b, a], 1),
      router.factsForFiles([b, "src/main/java/demo/A.java"], 1),
      router.frameworkFactsFor(a, 1)
    ]);
  });

  assert.deepEqual(client.refreshCalls, [[a, b]]);
  assert.deepEqual(client.queryFilesCalls, [[a, b]]);
});

test("factsForFiles rejects an older generation without regressing or refreshing the worker", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-facts-generation-high-water-"));
  const file = path.join(repoRoot, "src/main/java/demo/A.java");
  write(repoRoot, "src/main/java/demo/A.java", "package demo; class A {}\n");
  const client = new RecordingFactsClient(repoRoot);
  const router = new RouterJavaIndex(repoRoot, client as never);

  assert.equal((await router.factsForFiles([file], 2)).completion, "COMPLETE");
  const stale = await router.factsForFiles([file], 1);

  assert.equal(client.generation, 2);
  assert.equal(client.refreshCalls.length, 1, "the stale request must not reach REFRESH");
  assert.deepEqual(stale.items, [{
    inputFile: file,
    absolutePath: file,
    state: "DEGRADED",
    reason: "GENERATION_MISMATCH"
  }]);
});

test("factsForFiles never mixes cached facts with a newer generation reached during hydration", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-facts-generation-race-"));
  write(repoRoot, "src/main/java/demo/A.java", "package demo; class A {}\n");
  write(repoRoot, "src/main/java/demo/B.java", "package demo; class B {}\n");
  const a = path.join(repoRoot, "src/main/java/demo/A.java");
  const b = path.join(repoRoot, "src/main/java/demo/B.java");
  const client = new RecordingFactsClient(repoRoot);
  const router = new RouterJavaIndex(repoRoot, client as never);

  assert.equal((await router.factsForFiles([a], 1)).completion, "COMPLETE");
  let releaseHydration: (() => void) | undefined;
  let hydrationStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { hydrationStarted = resolve; });
  client.queryFilesImpl = files => new Promise(resolve => {
    releaseHydration = () => resolve(files.map(file => emptyBundle(repoRoot, file, 1)));
    hydrationStarted?.();
  });

  const pending = router.factsForFiles([a, b], 1);
  await started;
  client.generation = 2;
  releaseHydration?.();
  const result = await pending;

  assert.equal(result.completion, "PARTIAL");
  assert.deepEqual(result.items, [a, b].map(inputFile => ({
    inputFile,
    absolutePath: inputFile,
    state: "DEGRADED",
    reason: "GENERATION_MISMATCH"
  })));
});

test("framework facts retain the 200-file contract instead of inheriting the relationship cap", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-framework-cap-"));
  const files = Array.from({ length: MAX_FACTS_FOR_FILES + 1 }, (_, index) => {
    const relative = `src/main/java/demo/F${index}.java`;
    write(repoRoot, relative, `package demo; class F${index} {}\n`);
    return path.join(repoRoot, relative);
  });
  assert.ok(files.length <= MAX_FRAMEWORK_FACT_FILES);
  const client = new RecordingFactsClient(repoRoot);
  const router = new RouterJavaIndex(repoRoot, client as never);

  const result = await router.frameworkFactsForFiles(files, 1);

  assert.equal(result.length, files.length);
  assert.ok(result.every(item => item.coverage === "COMPLETE"));
  assert.equal(client.refreshCalls[0]?.length, files.length);
  assert.equal(client.queryFilesCalls[0]?.length, files.length);
});

test("framework facts never return a prior-generation complete projection after a failed refresh", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-framework-generation-"));
  const file = path.join(repoRoot, "src/main/java/demo/A.java");
  write(repoRoot, "src/main/java/demo/A.java", "package demo; class A {}\n");
  const client = new RecordingFactsClient(repoRoot);
  const router = new RouterJavaIndex(repoRoot, client as never);

  assert.equal((await router.frameworkFactsFor(file, 1)).coverage, "COMPLETE");
  client.queryFilesImpl = async () => {
    throw new JavaIntelligenceError("DEADLINE_EXCEEDED", "synthetic generation-two deadline");
  };

  const generationTwo = await router.frameworkFactsFor(file, 2);

  assert.equal(generationTwo.coverage, "DEGRADED");
  assert.equal(client.refreshCalls.length, 2);
  assert.equal(client.queryFilesCalls.length, 2);
});

test("frameworkFactsFor resolves annotations (incl. a parameter annotation) and callSite argument hints against a real extracted+resolved bundle", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-repo-"));
  write(
    repoRoot,
    "src/main/java/demo/Widget.java",
    [
      "package demo;",
      "",
      "import org.springframework.stereotype.Service;",
      "import org.springframework.beans.factory.annotation.Autowired;",
      "",
      "@Service",
      "class Widget {",
      "  void handle(@Autowired Order order) {",
      "    new Marker();",
      "    helper();",
      "  }",
      "  void helper() {}",
      "}",
      "",
      "class Order {}",
      "class Marker {}",
      ""
    ].join("\n")
  );
  const router = await readyRouter(repoRoot);
  try {
    const facts = await router.frameworkFactsFor(path.join(repoRoot, "src/main/java/demo/Widget.java"));

    assert.equal(facts.coverage, "COMPLETE");
    const widget = facts.types.find(t => t.simpleName === "Widget")!;
    assert.equal(widget.annotations[0]!.resolvedFqn, "org.springframework.stereotype.Service");

    const handle = facts.methods.find(m => m.name === "handle")!;
    assert.equal(handle.parameters[0]!.annotations[0]!.resolvedFqn, "org.springframework.beans.factory.annotation.Autowired");
    assert.equal(handle.parameters[0]!.type.resolvedFqn, "demo.Order");
    assert.ok(handle.callSites.some(c => c.name === "Marker" && c.kind === "CONSTRUCTOR_INVOCATION"));
    assert.ok(facts.methods.some(m => m.name === "helper"));
  } finally {
    await router.close();
  }
});

test("frameworkFactsFor projects an extends clause's base and its type arguments as independently-resolved refs", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-extends-repo-"));
  write(repoRoot, "src/main/java/demo/OrderEntity.java", "package demo;\nclass OrderEntity {}\n");
  write(
    repoRoot,
    "src/main/java/demo/OrderRepository.java",
    [
      "package demo;",
      "import org.springframework.data.jpa.repository.JpaRepository;",
      "interface OrderRepository extends JpaRepository<OrderEntity, Long> {}",
      ""
    ].join("\n")
  );
  const router = await readyRouter(repoRoot);
  try {
    const facts = await router.frameworkFactsFor(path.join(repoRoot, "src/main/java/demo/OrderRepository.java"));
    const repository = facts.types.find(t => t.simpleName === "OrderRepository")!;

    assert.equal(repository.implements.length, 0);
    assert.equal(repository.extends.length, 1);
    const base = repository.extends[0]!;
    assert.equal(base.resolvedFqn, "org.springframework.data.jpa.repository.JpaRepository");
    assert.equal(base.typeArguments[0]!.resolvedFqn, "demo.OrderEntity", "a repo-resolved generic argument resolves RESOLVED_REPO independent of the external base");
    assert.equal(base.typeArguments[1]!.resolvedFqn, "java.lang.Long");
  } finally {
    await router.close();
  }
});

test("frameworkFactsFor caches within a generation and drops the cache entry on refresh", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-cache-repo-"));
  const relativePath = "src/main/java/demo/Cached.java";
  write(repoRoot, relativePath, "package demo;\nclass Cached {\n  void first() {}\n}\n");
  const router = await readyRouter(repoRoot);
  try {
    const absolutePath = path.join(repoRoot, relativePath);
    const before = await router.frameworkFactsFor(absolutePath);
    assert.deepEqual(before.methods.map(m => m.name), ["first"]);

    // Change the file on disk without telling the router - if frameworkFactsFor
    // re-read it, this would already fail the *next* assertion; the point is
    // that a same-generation call returns the identical cached object.
    write(repoRoot, relativePath, "package demo;\nclass Cached {\n  void first() {}\n  void second() {}\n}\n");
    const stillCached = await router.frameworkFactsFor(absolutePath);
    assert.strictEqual(stillCached, before, "a same-generation call must be served from cache, not re-read from disk");

    await router.refresh(2, [relativePath], []);
    const afterRefresh = await router.frameworkFactsFor(absolutePath);
    assert.deepEqual(afterRefresh.methods.map(m => m.name).sort(), ["first", "second"], "refresh() must drop the stale cache entry");
  } finally {
    await router.close();
  }
});

test("declarationsById hydrates a method/field/type id across two files with one batched lookup, and reports an unresolvable id as missing", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-decl-repo-"));
  write(repoRoot, "src/main/java/demo/A.java", "package demo;\nclass A {\n  String name;\n  void run() {}\n}\n");
  write(repoRoot, "src/main/java/demo/B.java", "package demo;\nclass B {}\n");
  const router = await readyRouter(repoRoot);
  try {
    const methodId = "method:type:demo.A#run()";
    const fieldId = "field:type:demo.A#name";
    const typeId = "type:demo.B";

    const result = await router.declarationsById([methodId, fieldId, typeId, "method:type:demo.Missing#gone()"]);

    assert.deepEqual(result.methods.map(m => m.methodId), [methodId]);
    assert.deepEqual(result.fields.map(f => f.fieldId), [fieldId]);
    assert.deepEqual(result.types.map(t => t.typeId), [typeId]);
    assert.deepEqual(result.missingIds, ["method:type:demo.Missing#gone()"]);
    assert.equal(result.truncated, false);
  } finally {
    await router.close();
  }
});

test("declarationsById foreground-refreshes a conventional cross-module type path while the initial sweep is incomplete", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-cold-decl-repo-"));
  write(repoRoot, "modules/school/src/main/java/school/Mapper.java", "package school;\nimport common.IdConverter;\nclass Mapper {}\n");
  write(repoRoot, "modules/common/src/main/java/common/IdConverter.java", "package common;\npublic class IdConverter {}\n");
  const cacheDir = mkdtempSync(path.join(tmpdir(), "framework-view-cold-decl-cache-"));
  const router = RouterJavaIndex.create(repoRoot, cacheDir);
  await router.open(1);
  try {
    // This is the production ordering: an anchor may be foreground-refreshed
    // before the background reconcile reaches its imported module.
    await router.frameworkFactsFor(path.join(repoRoot, "modules/school/src/main/java/school/Mapper.java"), 1);

    const result = await router.declarationsById(["type:common.IdConverter"]);

    assert.deepEqual(result.missingIds, []);
    assert.deepEqual(result.types.map(type => type.fqn), ["common.IdConverter"]);
    assert.equal(result.truncated, false);
  } finally {
    await router.close();
  }
});

test.skip("cold foreground lookups close an exact imported type and a positively discovered one-hop implementation", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "router-cold-foreground-closure-"));
  write(repoRoot, "modules/api/src/main/java/api/Anchor.java", [
    "package api;",
    "import contract.Port;",
    "class Anchor { Port port; }",
    ""
  ].join("\n"));
  write(repoRoot, "modules/contract/src/main/java/contract/Port.java", "package contract; public interface Port {}\n");
  write(repoRoot, "modules/impl/src/main/java/impl/PortAdapter.java", [
    "package impl;",
    "import contract.Port;",
    "public class PortAdapter implements Port {}",
    ""
  ].join("\n"));
  write(repoRoot, "modules/impl/src/main/java/impl/PortPrimary.java", [
    "package impl;",
    "import contract.Port;",
    "public class PortPrimary implements Port {}",
    ""
  ].join("\n"));
  const router = RouterJavaIndex.create(repoRoot, mkdtempSync(path.join(tmpdir(), "router-cold-foreground-cache-")));
  await router.open(1);
  try {
    const anchor = path.join(repoRoot, "modules/api/src/main/java/api/Anchor.java");
    await router.ensureFresh([anchor], 1);

    const definitions = await router.findTypeDefinitions(["contract.Port"]);
    await router.ensureFresh([path.join(repoRoot, "modules/impl/src/main/java/impl/PortPrimary.java")], 1);
    const implementations = await router.findImplementers("contract.Port", 8, anchor);

    assert.deepEqual(definitions.map(item => item.path), ["modules/contract/src/main/java/contract/Port.java"]);
    assert.deepEqual(implementations.map(item => item.path), [
      "modules/impl/src/main/java/impl/PortAdapter.java",
      "modules/impl/src/main/java/impl/PortPrimary.java"
    ], "a known partial result below the limit still triggers bounded positive discovery");
    assert.notEqual(router.localRouterStatus().coverage, "complete", "foreground positive closure must not promote global coverage");
  } finally {
    await router.close();
  }
});

test("declarationsById caps an oversized id list rather than issuing an unbounded worker query, and reports it as truncated", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-decl-cap-repo-"));
  write(repoRoot, "src/main/java/demo/Only.java", "package demo;\nclass Only {\n  void run() {}\n}\n");
  const router = await readyRouter(repoRoot);
  try {
    const realId = "method:type:demo.Only#run()";
    // 70 > MAX_DECLARATION_IDS (64) - the excess must never even be looked up.
    const oversizedIds = Array.from({ length: 70 }, (_, i) => `field:type:demo.Fake${i}#x`);
    oversizedIds[0] = realId;

    const result = await router.declarationsById(oversizedIds);

    assert.equal(result.truncated, true);
    assert.deepEqual(result.methods.map(m => m.methodId), [realId], "an id within the cap must still resolve normally");
    assert.ok(result.missingIds.length >= 6, "ids beyond the cap must be reported, not silently dropped");
  } finally {
    await router.close();
  }
});

test("resolvedCallees returns the real CALLS edge with truncated=false for an ordinary call count", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-callees-repo-"));
  write(repoRoot, "src/main/java/demo/Caller.java", "package demo;\nclass Caller {\n  void run() {\n    target();\n  }\n  void target() {}\n}\n");
  const router = await readyRouter(repoRoot);
  try {
    const callerMethodId = "method:type:demo.Caller#run()";
    const { callees, truncated } = await router.resolvedCallees(callerMethodId, 80);

    assert.equal(truncated, false);
    assert.ok(callees.some(c => c.targetId === "method:type:demo.Caller#target()" && c.kind === "CALLS"));
  } finally {
    await router.close();
  }
});

test("repositoryMarkers reads a small marker file's content and caches it independent of the Java generation", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-markers-repo-"));
  write(repoRoot, "src/main/java/demo/Only.java", "package demo;\nclass Only {}\n");
  write(repoRoot, "pom.xml", "<project><artifactId>demo</artifactId></project>");
  const router = await readyRouter(repoRoot);
  try {
    const markers = await router.repositoryMarkers(["pom.xml", "build.gradle"]);
    assert.equal(markers.get("pom.xml"), "<project><artifactId>demo</artifactId></project>");
    assert.equal(markers.has("build.gradle"), false, "a missing marker file is omitted, not an error");

    const status = await router.frameworkStatus();
    assert.equal(status.coverage, "complete");
  } finally {
    await router.close();
  }
});

test.skip("framework activation marker caches are invalidated by both BUILD and JAVA refresh batches", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-marker-refresh-"));
  const javaPath = "src/main/java/demo/Springy.java";
  write(repoRoot, "pom.xml", "<project><dependency><groupId>org.springframework</groupId></dependency></project>");
  write(repoRoot, javaPath, "package demo;\nimport org.springframework.stereotype.Service;\n@Service class Springy {}\n");
  const router = await readyRouter(repoRoot);
  try {
    assert.match((await router.repositoryMarkers(["pom.xml"])).get("pom.xml") ?? "", /org\.springframework/);
    assert.deepEqual(
      await router.repositoryFactMarkers({ importPrefixes: ["org.springframework."], annotationPrefixes: ["org.springframework."] }),
      { importPrefixFound: true, annotationPrefixFound: true }
    );

    write(repoRoot, "pom.xml", "<project><artifactId>plain</artifactId></project>");
    write(repoRoot, javaPath, "package demo;\nclass Springy {}\n");
    await router.refresh(2, ["pom.xml", javaPath], []);

    assert.doesNotMatch((await router.repositoryMarkers(["pom.xml"])).get("pom.xml") ?? "", /org\.springframework/);
    assert.deepEqual(
      await router.repositoryFactMarkers({ importPrefixes: ["org.springframework."], annotationPrefixes: ["org.springframework."] }),
      { importPrefixFound: false, annotationPrefixFound: false },
      "a cached positive activation fact must not survive either build-marker or Java-facts refresh"
    );
  } finally {
    await router.close();
  }
});

test("myBatisResourcesByNamespaces batches a namespace lookup against real background-swept mapper XML", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-mybatis-repo-"));
  write(repoRoot, "src/main/java/demo/OrderMapper.java", "package demo;\ninterface OrderMapper {}\n");
  write(
    repoRoot,
    "src/main/resources/mapper/OrderMapper.xml",
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<mapper namespace="demo.OrderMapper">',
      '  <select id="findById" resultType="demo.OrderMapper">select 1</select>',
      "</mapper>",
      ""
    ].join("\n")
  );
  const router = await readyRouter(repoRoot);
  try {
    const found = await router.myBatisResourcesByNamespaces(["demo.OrderMapper", "demo.NoSuchMapper"]);
    assert.equal(found.size, 1, "an unindexed namespace is simply absent from the result, not an error");
    const resource = found.get("demo.OrderMapper");
    assert.equal(resource?.relativePath, "src/main/resources/mapper/OrderMapper.xml");
    assert.deepEqual(resource?.statements.map(s => s.id), ["findById"]);
  } finally {
    await router.close();
  }
});

test("myBatisResourcesByNamespaces omits a namespace collision rather than returning arbitrary XML", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "framework-view-mybatis-collision-"));
  write(repoRoot, "src/main/java/demo/Marker.java", "package demo;\nclass Marker {}\n");
  const mapperXml = ['<?xml version="1.0" encoding="UTF-8"?>', '<mapper namespace="demo.Dup"></mapper>', ""].join("\n");
  write(repoRoot, "src/main/resources/mapper/z-second.xml", mapperXml);
  write(repoRoot, "src/main/resources/mapper/a-first.xml", mapperXml);
  const router = await readyRouter(repoRoot);
  try {
    const found = await router.myBatisResourcesByNamespaces(["demo.Dup"]);
    assert.equal(found.get("demo.Dup"), undefined);
  } finally {
    await router.close();
  }
});

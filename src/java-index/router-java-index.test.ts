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
import { JavaIndexClient } from "./java-index-client.js";
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

test("framework activation marker caches are invalidated by both BUILD and JAVA refresh batches", async () => {
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

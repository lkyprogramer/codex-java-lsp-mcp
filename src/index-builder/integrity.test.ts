import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { close, openIndexDb } from "../java-index/sql/driver.js";
import { ensureSchema, schemaVersionsMatch } from "../java-index/sql/schema.js";
import { runSqlColdBuild } from "./cold-build.js";
import { applyBuilderJob } from "./incremental.js";
import { readMyBatisResource, readBundle } from "../java-index/sql/rows.js";
import { SqlFactsStore } from "../java-index/sql/facts-store.js";
import { SqlKnowledgeGraph } from "../java-index/sql/knowledge-graph.js";
import { SqlJavaIndexClient } from "../java-index/sql/sql-client.js";
import { readSourceRootCounts, readMeta, writeMeta } from "./progress.js";

async function fixture() {
  const repo = await mkdtemp(path.join(tmpdir(), "index-integrity-"));
  await mkdir(path.join(repo, "src/main/java"), { recursive: true });
  await mkdir(path.join(repo, "src/test/java"), { recursive: true });
  await writeFile(path.join(repo, "src/main/java/A.java"), "class A { void a() {} }");
  await writeFile(path.join(repo, "src/test/java/B.java"), "class B {}");
  const dbPath = path.join(repo, "index.sqlite");
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  return { repo, dbPath, db };
}

test("repeat cold build survives close/reopen/serve schema check and partial refresh", async () => {
  const f = await fixture();
  let db = f.db;
  try {
    await runSqlColdBuild({ repoRoot: f.repo, db });
    await runSqlColdBuild({ repoRoot: f.repo, db, generation: 2 });
    assert.equal(schemaVersionsMatch(db), true);
    close(db);
    db = openIndexDb(f.dbPath);
    ensureSchema(db);
    const result = await applyBuilderJob({ repoRoot: f.repo, db, job: { kind: "refresh", generation: 3, changed: ["src/main/java/A.java"] } });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.files, 2);
    assert.equal(readMeta(db, "buildState"), "READY");
    const counts = readSourceRootCounts(db);
    assert.equal(counts["src/main/java"].discoveredFiles, 1);
    assert.equal(counts["src/main/java"].indexedFiles, 1);
    assert.equal(counts["src/test/java"].indexedFiles, 1);
  } finally { close(db); await rm(f.repo, { recursive: true, force: true }); }
});

for (const state of ["BUILDING", "DEGRADED"]) {
  test(`unattested ${state} base explicitly falls back to full before promotion`, async () => {
    const f = await fixture();
    try {
      writeMeta(f.db, "buildState", state);
      for (const changed of [["src/main/java/A.java"], []]) {
        writeMeta(f.db,"buildState",state);
        f.db.prepare("DELETE FROM meta WHERE key='coverageRevision'").run();
        const result = await applyBuilderJob({ repoRoot: f.repo, db: f.db, job: { kind: "refresh", changed } });
        assert.equal(result.ok, true, result.error);
        assert.equal(result.stages?.mode,"full");
        assert.equal(result.stages?.reason,"no compatible published base");
        assert.equal(result.files,2);
        assert.equal(readMeta(f.db, "buildState"), "READY");
        const complete = f.db.prepare("SELECT root FROM source_root_coverage WHERE state='COMPLETE'").all();
        assert.equal(complete.length, 2);
      }
      const result = await applyBuilderJob({ repoRoot: f.repo, db: f.db, job: { kind: "reconcile" } });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.files, 2);
      assert.equal(readMeta(f.db, "buildState"), "READY");
    } finally { close(f.db); await rm(f.repo, { recursive: true, force: true }); }
  });
}

test("failed parses and failed refresh never publish complete coverage; reconcile repairs", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, "src/test/java/B.java"), "@#$ !!!");
    const cold = await runSqlColdBuild({ repoRoot: f.repo, db: f.db });
    assert.equal(cold.parseFailed, 1);
    assert.equal(cold.parseFailures.length, 1);
    assert.equal(readSourceRootCounts(f.db)["src/test/java"].failedFiles, 1);
    assert.equal(readMeta(f.db, "buildState"), "DEGRADED");
    await applyBuilderJob({ repoRoot: f.repo, db: f.db, job: { kind: "refresh", changed: [] } });
    assert.equal(readMeta(f.db, "buildState"), "DEGRADED");
    await writeFile(path.join(f.repo, "src/test/java/B.java"), "class B {}");
    assert.equal((await applyBuilderJob({ repoRoot: f.repo, db: f.db, job: { kind: "reconcile" } })).ok, true);
    assert.equal(readMeta(f.db, "buildState"), "READY");
    const failed = await applyBuilderJob({ repoRoot: f.repo, db: f.db, job: { kind: "refresh", changed: ["src/main/java"] } });
    assert.equal(failed.ok, false);
    assert.equal(readMeta(f.db, "buildState"), "DEGRADED");
    const completeRoots = () => Number((f.db.prepare("SELECT count(*) AS n FROM source_root_coverage WHERE state='COMPLETE'").get() as { n: number }).n);
    assert.equal(completeRoots(), 0, "no root stays COMPLETE after a lost job");
    // The failed job's rollback restored the facts, not the coverage: a later
    // successful delta does not certify the tree, only a reconcile does.
    await writeFile(path.join(f.repo, "src/main/java/A.java"), "class A { void a() {} void b() {} }");
    const refreshed = await applyBuilderJob({ repoRoot: f.repo, db: f.db, job: { kind: "refresh", changed: ["src/main/java/A.java"] } });
    assert.equal(refreshed.ok, true, refreshed.error);
    assert.equal(refreshed.stages?.mode, "delta");
    assert.equal(readMeta(f.db, "buildState"), "DEGRADED");
    assert.equal(completeRoots(), 0);
    assert.equal((await applyBuilderJob({ repoRoot: f.repo, db: f.db, job: { kind: "reconcile" } })).ok, true);
    assert.equal(readMeta(f.db, "buildState"), "READY");
  } finally { close(f.db); await rm(f.repo, { recursive: true, force: true }); }
});


test("old same-schema false READY without traversal attestation is never served", async () => {
  const f = await fixture();
  await runSqlColdBuild({ repoRoot: f.repo, db: f.db });
  f.db.prepare("DELETE FROM file WHERE path=?").run("src/test/java/B.java");
  f.db.prepare("DELETE FROM meta WHERE key='coverageRevision'").run();
  close(f.db);
  const client = new SqlJavaIndexClient(f.repo, f.dbPath);
  try {
    const status = await client.open(2);
    assert.equal(status.state, "DEGRADED");
    assert.equal(status.files, 0);
  } finally { await client.close(); await rm(f.repo, { recursive: true, force: true }); }
});


test("interrupted cold build resumes against changed, added and deleted files", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => runSqlColdBuild({ repoRoot: f.repo, db: f.db, batchSize: 1,
      shouldAbort: progress => progress.phase === "resolve" && progress.done === 1 }), /injected abort/);
    await writeFile(path.join(f.repo, "src/main/java/A.java"), "class Renamed { void changed() {} }");
    await rm(path.join(f.repo, "src/test/java/B.java"));
    await writeFile(path.join(f.repo, "src/test/java/C.java"), "class C {}");
    const result = await runSqlColdBuild({ repoRoot: f.repo, db: f.db, batchSize: 1 });
    assert.equal(result.files, 2);
    assert.equal(readMeta(f.db, "buildState"), "READY");
    const names = f.db.prepare("SELECT simple_name AS name FROM type ORDER BY simple_name").all();
    assert.deepEqual(names.map(row => (row as { name: string }).name), ["C", "Renamed"]);
  } finally { close(f.db); await rm(f.repo, { recursive: true, force: true }); }
});


test("reconcile completes interrupted declaration/graph phases rather than certifying raw files", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => runSqlColdBuild({ repoRoot: f.repo, db: f.db,
      shouldAbort: progress => progress.phase === "resolve" && progress.done === 0 }), /injected abort/);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM kg_node").get() as { n: number }).n, 0);
    assert.equal((await applyBuilderJob({ repoRoot: f.repo, db: f.db, job: { kind: "reconcile" } })).ok, true);
    assert.equal(readMeta(f.db, "buildState"), "READY");
    assert.ok((f.db.prepare("SELECT count(*) AS n FROM kg_node").get() as { n: number }).n > 0);
    assert.ok((f.db.prepare("SELECT count(*) AS n FROM search_doc").get() as { n: number }).n > 0);
  } finally { close(f.db); await rm(f.repo, { recursive: true, force: true }); }
});


test("recovery rebuild resets graph digest metadata with the derived rows", async () => {
  const f = await fixture();
  try {
    await runSqlColdBuild({ repoRoot: f.repo, db: f.db });
    const digest = new SqlKnowledgeGraph(f.db).digest();
    writeMeta(f.db, "buildState", "BUILDING");
    f.db.exec("DELETE FROM kg_edge_owner; DELETE FROM kg_node_owner; DELETE FROM kg_edge; DELETE FROM kg_node;");
    assert.equal((await applyBuilderJob({ repoRoot: f.repo, db: f.db, job: { kind: "reconcile" } })).ok, true);
    assert.equal(new SqlKnowledgeGraph(f.db).digest(), digest);
  } finally { close(f.db); await rm(f.repo, { recursive: true, force: true }); }
});


test("K24: recovered parse cannot certify COMPLETE or a trustworthy missing type", async () => {
  const f = await fixture();
  let client: SqlJavaIndexClient | undefined;
  let closed = false;
  try {
    await writeFile(path.join(f.repo, "src/main/java/A.java"), "class A { void broken( { }");
    await runSqlColdBuild({ repoRoot: f.repo, db: f.db });
    assert.equal(readSourceRootCounts(f.db)["src/main/java"].recoveredFiles, 1);
    assert.equal(readMeta(f.db, "buildState"), "DEGRADED");
    const coverage = f.db.prepare("SELECT state FROM source_root_coverage WHERE root='src/main/java'").get() as { state: string };
    assert.equal(coverage.state, "DEGRADED");
    close(f.db);
    closed = true;
    client = new SqlJavaIndexClient(f.repo, f.dbPath);
    const status = await client.open(1);
    assert.equal(status.state, "DEGRADED");
    const missing = await client.queryType("MissingType");
    assert.equal(missing.state, "UNRESOLVED");
    assert.equal(missing.coverage, "DEGRADED");
  } finally {
    if (client) await client.close();
    if (!closed) close(f.db);
    await rm(f.repo, { recursive: true, force: true });
  }
});


test("K31: local declaration name anchor wins over its containing method; body keeps nearest method", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, "src/main/java/A.java"), `class A {
  void run() {
    class Local { void nested() { int value = 1; } }
    int outside = 2;
  }
}`);
    await runSqlColdBuild({ repoRoot: f.repo, db: f.db });
    const store = new SqlFactsStore(f.db);
    const local = readBundle(f.db, "src/main/java/A.java")?.types.find(type => type.simpleName === "Local");
    assert.ok(local?.nameRange);
    const declared = store.anchor("src/main/java/A.java", local.nameRange.start.line, local.nameRange.start.column);
    assert.equal(declared?.symbolId, local.typeId);
    assert.equal(declared?.symbolKind, "TYPE");
    assert.equal(store.anchor("src/main/java/A.java", 4, 9)?.symbolName, "run");
    assert.equal(store.anchor("src/main/java/A.java", 3, 41)?.symbolName, "nested");
  } finally { close(f.db); await rm(f.repo, { recursive: true, force: true }); }
});


for (const changeJava of [false, true]) test(`cold resolve resume reconciles XML change/delete/add and non-mappers (Java changed=${changeJava})`, async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, "src/main/java/A.java"), "package demo; interface A { void a(); void b(); void c(); }");
    const resourceRoot = path.join(f.repo, "src/main/resources");
    await mkdir(resourceRoot, { recursive: true });
    const xml = (id: string) => `<mapper namespace="demo.A"><select id="${id}">SELECT ${id} FROM rows</select></mapper>`;
    for (const name of ["change", "delete", "replace"]) await writeFile(path.join(resourceRoot, `${name}.xml`), xml("a"));
    await assert.rejects(() => runSqlColdBuild({ repoRoot: f.repo, db: f.db,
      shouldAbort: progress => progress.phase === "resolve" && progress.done === 0 }), /injected abort/);
    await writeFile(path.join(resourceRoot, "change.xml"), xml("b"));
    await rm(path.join(resourceRoot, "delete.xml"));
    await writeFile(path.join(resourceRoot, "add.xml"), xml("c"));
    await writeFile(path.join(resourceRoot, "replace.xml"), "<configuration/>");
    if (changeJava) await writeFile(path.join(f.repo, "src/main/java/A.java"), "package demo; interface A { void a(); void b(); void c(); void d(); }");
    await runSqlColdBuild({ repoRoot: f.repo, db: f.db });
    assert.equal(readMeta(f.db, "buildState"), "READY");
    assert.equal(readMyBatisResource(f.db, "src/main/resources/delete.xml"), undefined);
    assert.equal(readMyBatisResource(f.db, "src/main/resources/replace.xml"), undefined);
    const methods = readBundle(f.db, "src/main/java/A.java")!.methods;
    for (const [name, id] of [["change", "b"], ["add", "c"]]) {
      const rel = `src/main/resources/${name}.xml`;
      const hash = createHash("sha256").update(xml(id)).digest("hex");
      const resource = readMyBatisResource(f.db, rel);
      assert.equal(resource?.contentHash, hash);
      // Evidence hashes are read through the source row, so a stale document
      // shows as a declaration or range the current statements do not derive
      // (change.xml's old statement `a` binds A.a, not A.b).
      const expected = resource!.statements.flatMap(statement => methods.filter(method => method.name === statement.id)
        .map(method => `${method.methodId}|${statement.range!.start.line}|${statement.range!.end.line}`));
      const docs = (f.db.prepare(`SELECT ds.text||'|'||d.start_line||'|'||d.end_line AS doc FROM search_doc d JOIN sym s ON s.id=d.source_path_sym
        JOIN sym ds ON ds.id=d.declaration_sym WHERE s.text=? ORDER BY doc`).all(rel) as Array<{ doc: string }>).map(row => row.doc);
      assert.ok(expected.length > 0, rel);
      assert.deepEqual(docs, expected.sort(), rel);
    }
    const stale = f.db.prepare(`SELECT d.id FROM search_doc d JOIN sym s ON s.id=d.source_path_sym WHERE s.text IN (?,?)`).all("src/main/resources/delete.xml", "src/main/resources/replace.xml");
    assert.equal(stale.length, 0);
    assert.deepEqual((f.db.prepare("SELECT path FROM resource_scan ORDER BY path").all() as Array<{ path: string }>).map(row => row.path),
      ["src/main/resources/add.xml", "src/main/resources/change.xml", "src/main/resources/replace.xml"]);
  } finally { close(f.db); await rm(f.repo, { recursive: true, force: true }); }
});


test("full reconcile resolves all inheritance facts before building caller edges", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.repo, "src/main/java/A.java"), "class A extends Z { void run() { inherited(); } }");
    await writeFile(path.join(f.repo, "src/main/java/Base.java"), "class Base { void inherited() {} }");
    await writeFile(path.join(f.repo, "src/main/java/Z.java"), "class Z extends Base {}");
    await runSqlColdBuild({ repoRoot: f.repo, db: f.db });
    const calls = () => readBundle(f.db, "src/main/java/A.java")!.edges.filter(edge => edge.kind === "CALLS").map(edge => edge.toId);
    const expected = calls();
    assert.equal(expected.length, 1);
    writeMeta(f.db, "buildState", "DEGRADED");
    const result = await applyBuilderJob({ repoRoot: f.repo, db: f.db, job: { kind: "reconcile", generation: 2 } });
    assert.equal(result.ok, true, result.error);
    assert.equal(readMeta(f.db, "buildState"), "READY");
    assert.deepEqual(calls(), expected);
  } finally { close(f.db); await rm(f.repo, { recursive: true, force: true }); }
});

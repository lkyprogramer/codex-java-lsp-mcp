// R05-R08 review fixes, through the real parser, cold build and incremental
// writer: incremental re-resolution of name dependents (R05), whole-selector
// exact lookup (R07), facts revision invalidation (R05), LF line numbering
// for previews (R08), resource XML reconcile memory and MyBatis module
// visibility (R08).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { close, openIndexDb } from "../sql/driver.js";
import { ensureSchema, schemaVersionsMatch } from "../sql/schema.js";
import { SqlEntitySearch } from "../sql/entity-search.js";
import { SqlFactsStore } from "../sql/facts-store.js";
import { readEntityRecords } from "../sql/entity-tokens.js";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { applyBuilderJob, changedResources } from "../../index-builder/incremental.js";
import { probeLayout } from "../../layout-probe.js";
import { JAVA_FACTS_REVISION } from "../build-fingerprint.js";
import { searchEntitiesDetailed } from "../../test-support/entity-search-oracle.js";
import { runStaticDiscovery } from "../../discovery/query.js";
import type { JavaIndexClientApi } from "../java-index-client-api.js";

type Db = ReturnType<typeof openIndexDb>;

async function repo(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "review-fixes-"));
  const write = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf8");
    return path.join(root, rel);
  };
  for (const [rel, text] of Object.entries(files)) await write(rel, text);
  return { root, write };
}

async function cold(root: string): Promise<{ db: Db; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "review-fixes-db-"));
  const db = openIndexDb(path.join(dir, "index.sqlite"));
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot: root, db, generation: 1, batchSize: 5 });
  return { db, dir };
}

async function cleanup(...paths: string[]) {
  for (const p of paths) await rm(p, { recursive: true, force: true });
}

const SHARED = (marker: string) => `package demo;\npublic class Shared {\n  public String track() { return "${marker}"; }\n}\n`;
const CALLER_REL = "src/main/java/lab/UsesShared.java";
const MULTI = {
  "pom.xml": "<project><modules><module>modules/a</module><module>modules/b</module></modules></project>\n",
  "modules/a/pom.xml": "<project><artifactId>a</artifactId></project>\n",
  "modules/b/pom.xml": "<project><artifactId>b</artifactId></project>\n",
  [CALLER_REL]: "package lab;\nimport demo.Shared;\npublic class UsesShared {\n  String go(Shared s) { return s.track(); }\n}\n"
};
const A = "modules/a/src/main/java/demo/Shared.java";
const B = "modules/b/src/main/java/demo/Shared.java";

function callerCalls(db: Db): string[] {
  const store = new SqlFactsStore(db);
  const typeId = [...(store.typeIdsBySimpleName.get("UsesShared") ?? [])][0]!;
  const go = store.typesById.get(typeId)!.methodIds.find(id => id.includes("go"))!;
  return store.callees(go).filter(ref => ref.kind === "CALLS").map(ref => decodeURIComponent(ref.targetId)).sort();
}

async function coldCalls(root: string): Promise<string[]> {
  const { db, dir } = await cold(root);
  try {
    return callerCalls(db);
  } finally {
    close(db);
    await cleanup(dir);
  }
}

test("R05 review: deleting one of two duplicate declarations re-resolves the AMBIGUOUS caller (matches cold build)", async () => {
  const { root } = await repo({ ...MULTI, [A]: SHARED("a"), [B]: SHARED("b") });
  const { db, dir } = await cold(root);
  try {
    assert.deepEqual(callerCalls(db), [], "two visible declarations: ambiguous, no edge");
    await rm(path.join(root, A));
    const result = await applyBuilderJob({ repoRoot: root, db, job: { id: 1, kind: "refresh", generation: 2, deleted: [path.join(root, A)] } });
    assert.ok(result.ok, result.error);
    const incremental = callerCalls(db);
    assert.equal(incremental.length, 1, `the caller now binds the remaining declaration, got ${JSON.stringify(incremental)}`);
    assert.ok(incremental[0]!.includes("modules/b/"));
    assert.deepEqual(incremental, await coldCalls(root));
  } finally {
    close(db);
    await cleanup(dir, root);
  }
});

test("R05 review: adding a duplicate declaration turns the bound caller AMBIGUOUS (matches cold build)", async () => {
  const { root, write } = await repo({ ...MULTI, [A]: SHARED("a") });
  const { db, dir } = await cold(root);
  try {
    assert.equal(callerCalls(db).length, 1, "a single declaration binds");
    const abs = await write(B, SHARED("b"));
    const result = await applyBuilderJob({ repoRoot: root, db, job: { id: 1, kind: "refresh", generation: 2, changed: [abs] } });
    assert.ok(result.ok, result.error);
    assert.deepEqual(callerCalls(db), [], "a second visible declaration makes the reference ambiguous");
    assert.deepEqual(callerCalls(db), await coldCalls(root));
  } finally {
    close(db);
    await cleanup(dir, root);
  }
});

test("R05 review: a facts revision mismatch invalidates the SQLite index like a schema change", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "review-fixes-rev-"));
  const db = openIndexDb(path.join(dir, "index.sqlite"));
  try {
    ensureSchema(db);
    assert.ok(schemaVersionsMatch(db));
    db.prepare("UPDATE meta SET value=? WHERE key='factsRevision'").run(String(JAVA_FACTS_REVISION - 1));
    db.prepare("INSERT INTO meta(key, value) VALUES ('marker', 'old')").run();
    assert.equal(schemaVersionsMatch(db), false, "an index built by other resolution rules is not reused");
    ensureSchema(db);
    assert.equal((db.prepare("SELECT value FROM meta WHERE key='factsRevision'").get() as { value: string }).value, String(JAVA_FACTS_REVISION));
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='marker'").get(), undefined, "dropped and rebuilt");
    db.prepare("DELETE FROM meta WHERE key='factsRevision'").run();
    assert.equal(schemaVersionsMatch(db), false, "a pre-revision index (no factsRevision) is not reused");
  } finally {
    close(db);
    await cleanup(dir);
  }
});

const EXACT_REPO = {
  "pom.xml": "<project><artifactId>d</artifactId></project>\n",
  "src/main/java/demo/OrderService.java": "package demo;\npublic class OrderService {\n  void refund() {}\n  public static class Line {}\n}\n",
  "src/main/java/demo/Demo.java": "package demo;\npublic class Demo {\n  void cancel() {}\n}\n",
  "src/main/java/other/Billing.java": "package other;\npublic class Billing {\n  void cancel() {}\n}\n"
};

test("R07 review: exact matches the whole selector - never one of its words, never a truncated `$` prefix", async () => {
  const { root } = await repo(EXACT_REPO);
  const { db, dir } = await cold(root);
  try {
    const search = new SqlEntitySearch(db);
    const records = readEntityRecords(db);
    const cases: Array<[string, "match" | "miss" | "ambiguous", string[]]> = [
      ["demo.MissingService", "miss", []],
      ["demo.OrderService#missingMethod", "miss", []],
      ["demo.OrderService#cancel", "miss", []],
      ["other.Billing#refund", "miss", []],
      ["demo.Demo$Nope", "miss", []],
      ["Demo.MissingService", "miss", []],
      ["Order", "miss", []],
      ["other.OrderService", "miss", []],
      ["Billing.Line", "miss", []],
      ["demo.Billing#cancel", "miss", []],
      ["demo.OrderService", "match", ["demo.OrderService"]],
      ["OrderService", "match", ["demo.OrderService"]],
      ["demo.OrderService#refund", "match", ["demo.OrderService#refund"]],
      ["OrderService#refund()", "match", ["demo.OrderService#refund"]],
      ["demo.OrderService.refund", "match", ["demo.OrderService#refund"]],
      ["demo.OrderService$Line", "match", ["demo.OrderService$Line"]],
      ["OrderService.Line", "match", ["demo.OrderService$Line"]],
      ["Line", "match", ["demo.OrderService$Line"]],
      ["refund", "match", ["demo.OrderService#refund"]],
      ["cancel", "ambiguous", ["demo.Demo#cancel", "other.Billing#cancel"]],
      ["Billing#cancel", "match", ["other.Billing#cancel"]]
    ];
    for (const [query, outcome, fqns] of cases) {
      const sql = search.searchDetailed(query, 8, "exact");
      assert.equal(sql.exact, outcome, `${query}: ${JSON.stringify(sql.hits.map(hit => hit.fqn))}`);
      assert.deepEqual(sql.hits.map(hit => hit.fqn).sort(), fqns, query);
      const oracle = searchEntitiesDetailed(records, query, 8, "exact");
      assert.equal(oracle.exact, outcome, `oracle ${query}`);
      assert.deepEqual(oracle.hits.map(hit => hit.entityId), sql.hits.map(hit => hit.entityId), `oracle parity ${query}`);
    }
  } finally {
    close(db);
    await cleanup(dir, root);
  }
});

test("R08 review: a lone CR inside a line does not shift the preview off the parser's declaration line", async () => {
  const widget = "package demo;\n/* legacy\rnote */\npublic class Widget {\n  void spin() {}\n}\n";
  const { root } = await repo({ "pom.xml": "<project><artifactId>w</artifactId></project>\n", "src/main/java/demo/Widget.java": widget });
  const { db, dir } = await cold(root);
  try {
    const search = new SqlEntitySearch(db);
    const client = {
      status: async () => ({ state: "READY", indexedGeneration: 1, coverage: db.prepare("SELECT root FROM source_root_coverage").all() }),
      querySearch: async (task: string, options: { limit?: number; mode?: "auto" | "exact" | "text" }) => search.searchDetailed(task, options.limit, options.mode, options)
    } as unknown as JavaIndexClientApi;
    const result = await runStaticDiscovery(client, { repoRoot: root, query: "demo.Widget", searchMode: "exact" });
    const candidate = result.candidates[0]!;
    assert.equal(candidate.declaration.selection.line, 3);
    assert.equal(candidate.evidenceRange?.startLine, 3);
    assert.ok(candidate.preview?.startsWith("public class Widget {"), JSON.stringify(candidate.preview));
    assert.equal(candidate.previewKind, "source");
  } finally {
    close(db);
    await cleanup(dir, root);
  }
});

const MAPPER = "package demo;\npublic interface OrderMapper {\n  int load(int id);\n}\n";
const MAPPER_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<mapper namespace="demo.OrderMapper">\n  <select id="load">SELECT 1</select>\n</mapper>\n`;

test("R08 review: reconcile skips unchanged XML by size+mtime, restamps mtime-only changes and remembers non-mapper XML", async () => {
  const { root, write } = await repo({
    "pom.xml": "<project><artifactId>x</artifactId></project>\n",
    "src/main/java/demo/OrderMapper.java": MAPPER,
    "src/main/resources/mapper/OrderMapper.xml": MAPPER_XML,
    "src/main/resources/logback.xml": "<configuration/>\n"
  });
  const { db, dir } = await cold(root);
  try {
    const plan = () => changedResources(db, root, probeLayout(root));
    assert.deepEqual(await plan(), { changed: [], deleted: [], stamps: [] }, "nothing to do after a cold build, logback.xml included");
    const later = new Date(Date.now() + 60_000);
    await utimes(path.join(root, "src/main/resources/logback.xml"), later, later);
    const touched = await plan();
    assert.deepEqual([touched.changed, touched.stamps.map(stamp => stamp.path)], [[], ["src/main/resources/logback.xml"]], "same content: restamp, no reparse");
    await write("src/main/resources/spring.xml", "<beans/>\n");
    const added = await plan();
    assert.equal(added.changed.length, 1);
    const result = await applyBuilderJob({ repoRoot: root, db, job: { id: 1, kind: "reconcile", generation: 2 } });
    assert.ok(result.ok, result.error);
    assert.deepEqual(await plan(), { changed: [], deleted: [], stamps: [] }, "a non-mapper XML is remembered after one look");
    await rm(path.join(root, "src/main/resources/spring.xml"));
    assert.deepEqual((await plan()).deleted, ["src/main/resources/spring.xml"]);
  } finally {
    close(db);
    await cleanup(dir, root);
  }
});

function xmlOwners(db: Db): Array<[string, string]> {
  return (db.prepare(
    `SELECT op.text AS owner, sp.text AS source FROM search_doc d JOIN sym op ON op.id=d.path_sym JOIN sym sp ON sp.id=d.source_path_sym
      WHERE sp.text LIKE '%.xml' ORDER BY sp.text, op.text`
  ).all() as Array<{ owner: string; source: string }>).map(row => [row.source, row.owner]);
}

test("R08 review: a mapper XML binds to its own module's namespace declaration when one exists", async () => {
  const files = {
    "pom.xml": "<project><modules><module>modules/a</module><module>modules/b</module></modules></project>\n",
    "modules/a/pom.xml": "<project><artifactId>a</artifactId></project>\n",
    "modules/b/pom.xml": "<project><artifactId>b</artifactId></project>\n",
    "modules/a/src/main/java/demo/OrderMapper.java": MAPPER,
    "modules/a/src/main/resources/mapper/OrderMapper.xml": MAPPER_XML,
    "src/main/resources/mapper/Shared.xml": MAPPER_XML.replace("SELECT 1", "SELECT 2")
  };
  const { root, write } = await repo(files);
  const { db, dir } = await cold(root);
  try {
    assert.deepEqual(xmlOwners(db), [
      ["modules/a/src/main/resources/mapper/OrderMapper.xml", "modules/a/src/main/java/demo/OrderMapper.java"],
      ["src/main/resources/mapper/Shared.xml", "modules/a/src/main/java/demo/OrderMapper.java"]
    ]);
    // A second declaration in module b: module a's XML stays with a; the root
    // XML (no same-module declaration) binds to both.
    const abs = await write("modules/b/src/main/java/demo/OrderMapper.java", MAPPER);
    const result = await applyBuilderJob({ repoRoot: root, db, job: { id: 1, kind: "refresh", generation: 2, changed: [abs] } });
    assert.ok(result.ok, result.error);
    const expected: Array<[string, string]> = [
      ["modules/a/src/main/resources/mapper/OrderMapper.xml", "modules/a/src/main/java/demo/OrderMapper.java"],
      ["src/main/resources/mapper/Shared.xml", "modules/a/src/main/java/demo/OrderMapper.java"],
      ["src/main/resources/mapper/Shared.xml", "modules/b/src/main/java/demo/OrderMapper.java"]
    ];
    assert.deepEqual(xmlOwners(db), expected);
    const fresh = await cold(root);
    try {
      assert.deepEqual(xmlOwners(fresh.db), expected, "incremental equals cold build");
    } finally {
      close(fresh.db);
      await cleanup(fresh.dir);
    }
    // A same-module declaration appears for the root XML: it rebinds there
    // even though the module-a/b owner files were not rewritten.
    const rootAbs = await write("src/main/java/demo/OrderMapper.java", MAPPER);
    const again = await applyBuilderJob({ repoRoot: root, db, job: { id: 2, kind: "refresh", generation: 3, changed: [rootAbs] } });
    assert.ok(again.ok, again.error);
    assert.deepEqual(xmlOwners(db).filter(([source]) => source.startsWith("src/")), [["src/main/resources/mapper/Shared.xml", "src/main/java/demo/OrderMapper.java"]]);
  } finally {
    close(db);
    await cleanup(dir, root);
  }
});

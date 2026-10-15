// R08: MyBatis evidence provenance through the real parser and writer paths
// (cold build, XML-only resource job, reconcile, Java refresh) and the
// one-snapshot read contract of the detailed search.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { close, openIndexDb } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { SqlEntitySearch } from "../sql/entity-search.js";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { applyBuilderJob } from "../../index-builder/incremental.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const ORDER_JAVA = "src/main/java/demo/OrderMapper.java";
const ITEM_JAVA = "src/main/java/demo/ItemMapper.java";
const ORDER_XML = "src/main/resources/mapper/OrderMapper.xml";
const ITEM_XML = "src/main/resources/mapper/ItemMapper.xml";

const mapperJava = (name: string, extra = "") => [
  "package demo;",
  "",
  `public interface ${name} {${extra}`,
  "    int load(int id);",
  "}",
  ""
].join("\n");

const mapperXml = (namespace: string, kind: string, padding = 0) => [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<mapper namespace="${namespace}">`,
  ...Array.from({ length: padding }, (_, i) => `  <!-- pad ${i} -->`),
  `  <${kind} id="load">`,
  `    SELECT * FROM t WHERE id = #{id}`,
  `  </${kind}>`,
  `</mapper>`,
  ""
].join("\n");

type DocRow = { declaration: string; owner: string; source: string; contentHash: string; startLine: number; endLine: number; doc: string };

function mybatisDocs(db: ReturnType<typeof openIndexDb>): DocRow[] {
  return db.prepare(
    `SELECT ds.text AS declaration, op.text AS owner, sp.text AS source, d.content_hash AS contentHash,
            d.start_line AS startLine, d.end_line AS endLine,
            ds.text||'|'||d.kind||'|'||sp.text||'|'||d.start_line||'|'||d.end_line||'|'||d.content_hash AS doc
       FROM search_doc d JOIN sym ds ON ds.id=d.declaration_sym JOIN sym op ON op.id=d.path_sym
       JOIN sym sp ON sp.id=d.source_path_sym
      WHERE sp.text LIKE '%.xml' ORDER BY sp.text`
  ).all() as DocRow[];
}

async function repo(): Promise<{ root: string; write: (rel: string, text: string) => Promise<string> }> {
  const root = await mkdtemp(path.join(tmpdir(), "r08-evidence-"));
  const write = async (rel: string, text: string) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf8");
    return path.join(root, rel);
  };
  await write("pom.xml", "<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>r08</artifactId><version>1</version></project>\n");
  await write(ORDER_JAVA, mapperJava("OrderMapper"));
  await write(ITEM_JAVA, mapperJava("ItemMapper"));
  await write(ORDER_XML, mapperXml("demo.OrderMapper", "select"));
  await write(ITEM_XML, mapperXml("demo.ItemMapper", "select"));
  return { root, write };
}

async function cold(root: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "r08-evidence-db-"));
  const db = openIndexDb(path.join(dir, "index.sqlite"));
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot: root, db, generation: 1, batchSize: 5 });
  return { db, dir };
}

function documentHits(db: ReturnType<typeof openIndexDb>, task: string) {
  return new SqlEntitySearch(db).searchDetailed(task, 10, "text").hits.filter(hit => hit.layer === "DOCUMENT");
}

test("K16/P01: same-named statements in two namespaces: source is each XML path/hash/range, target each Java method", async () => {
  const { root } = await repo();
  const { db, dir } = await cold(root);
  try {
    const rows = mybatisDocs(db);
    assert.equal(rows.length, 2, JSON.stringify(rows));
    const item = rows.find(row => row.source === ITEM_XML)!;
    const order = rows.find(row => row.source === ORDER_XML)!;
    assert.equal(item.contentHash, sha(mapperXml("demo.ItemMapper", "select")));
    assert.equal(order.contentHash, sha(mapperXml("demo.OrderMapper", "select")));
    assert.deepEqual([item.startLine, item.endLine], [3, 5], "the XML element's own lines");
    assert.ok(item.declaration.includes("ItemMapper#load"), item.declaration);
    assert.ok(order.declaration.includes("OrderMapper#load"), order.declaration);
    assert.equal(item.owner, ITEM_JAVA, "the owning Java file stays the undo handle");
    // The document identity (search_doc_identity) names its source path and hash.
    assert.ok(item.doc.includes(`|${ITEM_XML}|`) && item.doc.endsWith(`|${item.contentHash}`), item.doc);

    const hits = documentHits(db, "mybatis");
    const itemHit = hits.find(hit => hit.relativePath === ITEM_JAVA);
    assert.deepEqual(itemHit?.evidence, {
      relativePath: ITEM_XML, contentHash: item.contentHash, startLine: 3, endLine: 5, sourceKind: "framework-key"
    }, "the hit keeps the document that matched, not the declaration head");
    assert.notEqual(itemHit?.contentHash, item.contentHash, "the locator hash is the Java file's");
  } finally {
    close(db);
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("R08: an XML-only resource job replaces the XML-sourced documents while Java is unchanged", async () => {
  const { root, write } = await repo();
  const { db, dir } = await cold(root);
  try {
    const before = mybatisDocs(db);
    const javaHash = (db.prepare("SELECT content_hash AS h FROM file WHERE path=?").get(ITEM_JAVA) as { h: string }).h;
    const nextXml = mapperXml("demo.ItemMapper", "update", 2);
    const abs = await write(ITEM_XML, nextXml);
    const result = await applyBuilderJob({ repoRoot: root, db, job: { id: 1, kind: "resources", generation: 2, changed: [abs] } });
    assert.ok(result.ok, result.error);
    const after = mybatisDocs(db);
    const item = after.find(row => row.source === ITEM_XML)!;
    assert.equal(item.contentHash, sha(nextXml), "the new XML hash");
    assert.deepEqual([item.startLine, item.endLine], [5, 7], "the moved element's current lines");
    assert.ok(!after.some(row => before.find(old => old.source === ITEM_XML)!.doc === row.doc), "the old XML document is gone");
    assert.deepEqual(after.find(row => row.source === ORDER_XML), before.find(row => row.source === ORDER_XML), "other XML untouched");
    assert.equal((db.prepare("SELECT content_hash AS h FROM file WHERE path=?").get(ITEM_JAVA) as { h: string }).h, javaHash);
    const hit = documentHits(db, "mybatis update").find(candidate => candidate.relativePath === ITEM_JAVA);
    assert.equal(hit?.evidence?.contentHash, sha(nextXml), "retrieval sees the new XML text and hash");
    const oldHash = before.find(row => row.source === ITEM_XML)!.contentHash;
    assert.equal(documentHits(db, "mybatis select").some(candidate => candidate.evidence?.contentHash === oldHash), false,
      "no hit is evidenced by the old XML content");
  } finally {
    close(db);
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("K21: reconcile replaces XML evidence when only the XML differs, and drops a deleted XML's documents", async () => {
  const { root, write } = await repo();
  const { db, dir } = await cold(root);
  try {
    const nextXml = mapperXml("demo.ItemMapper", "delete", 1);
    await write(ITEM_XML, nextXml);
    await rm(path.join(root, ORDER_XML));
    const result = await applyBuilderJob({ repoRoot: root, db, job: { id: 1, kind: "reconcile", generation: 2 } });
    assert.ok(result.ok, result.error);
    const rows = mybatisDocs(db);
    assert.deepEqual(rows.map(row => [row.source, row.contentHash, row.startLine]), [[ITEM_XML, sha(nextXml), 4]]);
    assert.equal(result.indexedGeneration, 2);
    // A second reconcile with nothing changed is a no-op for documents.
    const again = await applyBuilderJob({ repoRoot: root, db, job: { id: 2, kind: "reconcile", generation: 3 } });
    assert.ok(again.ok, again.error);
    assert.deepEqual(mybatisDocs(db), rows);
  } finally {
    close(db);
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("R08: a Java refresh of the mapper keeps its XML-sourced documents (rebuilt under the owner)", async () => {
  const { root, write } = await repo();
  const { db, dir } = await cold(root);
  try {
    const before = mybatisDocs(db).find(row => row.source === ITEM_XML);
    const abs = await write(ITEM_JAVA, mapperJava("ItemMapper", "\n    /** lookup */"));
    const result = await applyBuilderJob({ repoRoot: root, db, job: { id: 1, kind: "refresh", generation: 2, changed: [abs] } });
    assert.ok(result.ok, result.error);
    const after = mybatisDocs(db).find(row => row.source === ITEM_XML);
    assert.ok(after, "the XML document survives the owner's rewrite");
    assert.equal(after!.contentHash, before!.contentHash, "its source is still the unchanged XML");
    assert.ok(after!.declaration.includes("ItemMapper#load"));
  } finally {
    close(db);
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("K20: a writer commit during the scan cannot mix generations into one detailed result", async () => {
  const { root } = await repo();
  const { db, dir } = await cold(root);
  const writer = openIndexDb(path.join(dir, "index.sqlite"));
  try {
    const original = (db.prepare("SELECT content_hash AS h FROM file WHERE path=?").get(ITEM_JAVA) as { h: string }).h;
    let wrote = false;
    const remainingMs = () => {
      // Commit once the scan's read snapshot is open (R09: the first
      // deadline check runs on entry, before the snapshot).
      if (!wrote && db.isTransaction) {
        wrote = true;
        writer.exec("BEGIN IMMEDIATE");
        writer.prepare("UPDATE file SET content_hash='changed-by-writer'").run();
        writer.prepare("UPDATE meta SET value='99' WHERE key='indexedGeneration'").run();
        writer.exec("COMMIT");
      }
      return 60_000;
    };
    const result = new SqlEntitySearch(db).searchDetailed("mybatis", 10, "text", { budget: { remainingMs } });
    assert.ok(wrote, "the writer committed mid-scan");
    assert.equal(result.generation, 1);
    const hit = result.hits.find(candidate => candidate.relativePath === ITEM_JAVA);
    assert.equal(hit?.contentHash, original, "locators come from the same snapshot as the generation");
    const later = new SqlEntitySearch(db).searchDetailed("mybatis", 10, "text");
    assert.equal(later.generation, 99, "the next request sees the committed generation");
    assert.equal(later.hits.find(candidate => candidate.relativePath === ITEM_JAVA)?.contentHash, "changed-by-writer");
  } finally {
    close(writer);
    close(db);
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

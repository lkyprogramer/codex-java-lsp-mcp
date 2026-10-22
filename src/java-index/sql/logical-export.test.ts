import assert from "node:assert/strict";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { applyBuilderJob } from "../../index-builder/incremental.js";
import { close, openIndexDb, type IndexDatabase } from "./driver.js";
import { diffLogical, exportLogical, logicalDigest, validateLogicalData, validateLogicalTable } from "./logical-export.js";
import { ensureSchema } from "./schema.js";
import { buildSnapshotManifest, parseSnapshotManifest, SNAPSHOT_MANIFEST_FORMAT } from "./snapshot-manifest.js";
import { internSym, symId } from "./sym.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";

test("seal data validation rejects unsafe scalar integers while preserving omitted surrogate ids and generations", () => {
  const db = openIndexDb(":memory:");
  try {
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE sample(id INTEGER PRIMARY KEY, generation INTEGER, value INTEGER)");
    db.prepare("INSERT INTO sample VALUES (?, ?, ?)").run(9223372036854775807n, 9223372036854775807n, 9007199254740991n);
    for (const value of [9007199254740991n, -9007199254740991n]) {
      db.prepare("UPDATE sample SET value=?").run(value);
      validateLogicalData(db);
      assert.doesNotThrow(() => logicalDigest(db));
    }
    for (const value of [9007199254740992n, -9007199254740992n]) {
      db.prepare("UPDATE sample SET value=?").run(value);
      assert.throws(() => logicalDigest(db));
      assert.throws(() => validateLogicalData(db), /unsafe integer/);
    }
  } finally { close(db); }
});

test("a scoped check covers exactly the rows its predicate selects: facts, references and unsafe integers", () => {
  const db = openIndexDb(":memory:");
  try {
    db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE sym(id INTEGER PRIMARY KEY, text TEXT);
      CREATE TABLE sample(owner_sym INTEGER, generation INTEGER, value INTEGER, facts BLOB); INSERT INTO sym VALUES (1, 'owner')`);
    const insert = db.prepare("INSERT INTO sample VALUES (?, ?, ?, ?)");
    insert.run(1, 2, 1, deflateRawSync(Buffer.from('{"value":1}')));
    // Old rows of generation 1, each corrupt in its own way.
    insert.run(1, 1, 1, Buffer.from("invalid deflate"));
    insert.run(999, 1, 1, deflateRawSync(Buffer.from('{"value":1}')));
    insert.run(1, 1, 9007199254740992n, deflateRawSync(Buffer.from('{"value":1}')));
    assert.doesNotThrow(() => validateLogicalTable(db, "sample", "t.generation=2"));
    assert.throws(() => validateLogicalTable(db, "sample"));
    assert.throws(() => validateLogicalTable(db, "sample", "t.generation=1"));
    for (const [sql, error] of [["UPDATE sample SET facts=X'00' WHERE generation=2", /invalid|incorrect|unexpected|unknown/i],
      ["UPDATE sample SET facts=?, owner_sym=999 WHERE generation=2", /orphan reference in sample.owner_sym/],
      ["UPDATE sample SET owner_sym=1, value=9007199254740992 WHERE generation=2", /unsafe integer in sample/]] as const) {
      const statement = db.prepare(sql);
      if (sql.includes("?")) statement.run(deflateRawSync(Buffer.from('{"value":1}'))); else statement.run();
      assert.throws(() => validateLogicalTable(db, "sample", "t.generation=2"), error, sql);
    }
  } finally { close(db); }
});

test("seal data validation preserves nullable references and rejects non-blob, deflate and JSON corruption", () => {
  const db = openIndexDb(":memory:");
  try {
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE sym(id INTEGER PRIMARY KEY, text TEXT); CREATE TABLE sample(owner_sym INTEGER, facts BLOB)");
    const insert = db.prepare("INSERT INTO sample VALUES (NULL, ?)");
    insert.run(deflateRawSync(Buffer.from('{"value":1}')));
    validateLogicalData(db);
    for (const invalid of ["not a blob", Buffer.from("invalid deflate"), deflateRawSync(Buffer.from("not JSON"))]) {
      db.prepare("UPDATE sample SET facts=?").run(invalid);
      assert.throws(() => logicalDigest(db));
      assert.throws(() => validateLogicalData(db));
    }
  } finally { close(db); }
});

async function withRepo<T>(fn: (repo: string) => Promise<T>): Promise<T> {
  const repo = await mkdtemp(path.join(tmpdir(), "logical-export-"));
  try {
    await cp(fixturesRoot, repo, { recursive: true });
    return await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

async function build(repo: string, options: { batchSize?: number; padSyms?: number; generation?: number } = {}): Promise<IndexDatabase> {
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  // Junk dictionary entries shift every sym id and rowid the build allocates.
  for (let index = 0; index < (options.padSyms ?? 0); index += 1) internSym(db, `pad:${index}`);
  await runSqlColdBuild({ repoRoot: repo, db, generation: options.generation ?? 1, batchSize: options.batchSize ?? 5 });
  return db;
}

test("logical export ignores sym ids, rowids, generations and insertion order", async () => {
  await withRepo(async repo => {
    const left = await build(repo, { batchSize: 1 });
    const right = await build(repo, { batchSize: 50, padSyms: 997, generation: 7 });
    try {
      assert.notEqual(symId(left, serviceRel), symId(right, serviceRel));
      assert.deepEqual(diffLogical(exportLogical(left), exportLogical(right)), []);
      assert.equal(logicalDigest(left).digest, logicalDigest(right).digest);
      const tables = logicalDigest(left).tables;
      for (const table of ["file", "type", "method", "edge", "kg_node", "kg_node_owner", "kg_edge", "kg_edge_owner", "entity", "search_doc", "mybatis_resource", "resource_scan"]) {
        assert.ok(tables[table]!.rows > 0, `${table} exported no rows`);
      }
      assert.equal(tables.sym, undefined);
      assert.ok(tables.source_root_coverage!.rows > 0);
      // Content, not only invariance: references are exported as their text and path.
      const exported = exportLogical(left);
      const fileIndex = exported.tables.edge!.columns.indexOf("file");
      const edge = exported.tables.edge!.rows.map(row => JSON.parse(row) as unknown[]).find(row => row[fileIndex] === serviceRel);
      assert.ok(edge, "service edge");
      const column = (name: string) => edge[exported.tables.edge!.columns.indexOf(name)];
      assert.match(String(column("from_sym")), /^(method|type|field):/);
      assert.equal(typeof column("kind_sym"), "string");
      assert.ok(exported.tables.source_root_coverage!.rows.includes(JSON.stringify(["src/main/java", "COMPLETE"])), exported.tables.source_root_coverage!.rows.join());
      // A posting names its document by identity, not by the surrogate search_doc.id.
      const docColumn = exported.tables.search_doc_token!.columns.indexOf("doc");
      const doc = JSON.parse(String((JSON.parse(exported.tables.search_doc_token!.rows[0]!) as unknown[])[docColumn])) as unknown[];
      assert.equal(doc.length, 5);
      assert.match(String(doc[0]), /^(method|type|field):/);
      // The shared facts database never names the checkout it was built from.
      for (const [table, { rows }] of Object.entries(exported.tables)) assert.equal(rows.some(row => row.includes(repo)), false, table);
      assert.equal(left.prepare("SELECT count(*) AS n FROM sym WHERE instr(text, ?) > 0").get(repo)?.n, 0);
    } finally {
      close(left);
      close(right);
    }
  });
});

test("logical export decodes facts, so recompressed bytes keep the digest", async () => {
  await withRepo(async repo => {
    const db = await build(repo);
    try {
      const baseline = logicalDigest(db);
      const before = baseline.digest;
      const row = db.prepare("SELECT id, facts FROM file WHERE path=?").get(serviceRel) as { id: number; facts: Uint8Array };
      const recompressed = deflateRawSync(inflateRawSync(row.facts), { level: 1, memLevel: 1 });
      assert.notDeepEqual(Buffer.from(recompressed), Buffer.from(row.facts));
      db.prepare("UPDATE file SET facts=? WHERE id=?").run(recompressed, row.id);
      assert.equal(logicalDigest(db).digest, before);
      db.prepare("UPDATE file SET content_hash='changed' WHERE id=?").run(row.id);
      const after = logicalDigest(db);
      assert.notEqual(after.digest, before);
      assert.notEqual(after.tables.file!.digest, baseline.tables.file!.digest);
      assert.equal(after.tables.type!.digest, baseline.tables.type!.digest);
    } finally {
      close(db);
    }
  });
});

test("an incremental refresh is logically equal to a cold build of the edited tree", async () => {
  await withRepo(async repo => {
    const incremental = await build(repo);
    try {
      const service = path.join(repo, serviceRel);
      await writeFile(service, (await readFile(service, "utf8")).replace("repository.save", "repository.save /* logical */"));
      const result = await applyBuilderJob({ repoRoot: repo, db: incremental, job: { id: 1, kind: "refresh", generation: 2, changed: [serviceRel] } });
      assert.equal(result.ok, true, result.error);
      const fresh = await build(repo, { padSyms: 13 });
      try {
        assert.deepEqual(diffLogical(exportLogical(incremental), exportLogical(fresh)), []);
        assert.equal(logicalDigest(incremental).digest, logicalDigest(fresh).digest);
      } finally {
        close(fresh);
      }
    } finally {
      close(incremental);
    }
  });
});

test("a line-shifting edit re-indexes its search documents without growing the sym dictionary", async () => {
  await withRepo(async repo => {
    const db = await build(repo);
    try {
      const count = () => Number((db.prepare("SELECT count(*) AS n FROM sym").get() as { n: number }).n);
      const before = count();
      const docs = db.prepare("SELECT count(*) AS n FROM search_doc").get()?.n;
      const service = path.join(repo, serviceRel);
      // Every document range of the file moves and its content hash changes; no name changes.
      const postings = db.prepare("SELECT count(*) AS n FROM search_doc_token").get()?.n;
      await writeFile(service, `\n\n${await readFile(service, "utf8")}`);
      const result = await applyBuilderJob({ repoRoot: repo, db, job: { id: 1, kind: "refresh", generation: 2, changed: [serviceRel] } });
      assert.equal(result.ok, true, result.error);
      assert.equal(db.prepare("SELECT count(*) AS n FROM search_doc").get()?.n, docs);
      assert.equal(db.prepare("SELECT count(*) AS n FROM search_doc_token").get()?.n, postings);
      assert.equal(count(), before);
      // The identity key still rejects a duplicate document, as the old sym primary key did.
      const row = db.prepare("SELECT declaration_sym, path_sym, source_path_sym, kind, start_line, end_line, token_len FROM search_doc LIMIT 1").get() as Record<string, number | string>;
      assert.throws(() => db.prepare("INSERT INTO search_doc(declaration_sym, path_sym, source_path_sym, kind, start_line, end_line, token_len) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(row.declaration_sym!, row.path_sym!, row.source_path_sym!, row.kind!, row.start_line!, row.end_line!, row.token_len!), /UNIQUE constraint/);
    } finally {
      close(db);
    }
  });
});

test("seal reference validation also rejects missing symbols in existing posting parents", async () => {
  await withRepo(async repo => {
    const db = await build(repo);
    try {
      for (const [table, column] of [["search_doc", "declaration_sym"], ["search_doc", "source_path_sym"], ["kg_edge", "from_sym"], ["kg_edge", "to_sym"]]) {
        db.exec("SAVEPOINT damaged");
        try {
          const result = db.prepare(`UPDATE ${table} SET ${column}=999999999 WHERE id=(SELECT min(id) FROM ${table})`).run();
          assert.equal(Number(result.changes), 1);
          assert.throws(() => logicalDigest(db), /orphan reference/);
          assert.throws(() => validateLogicalData(db), /orphan reference/);
        } finally { db.exec("ROLLBACK TO damaged; RELEASE damaged"); }
      }
      validateLogicalData(db);
    } finally { close(db); }
  });
});

test("dangling references are rejected by SQLite or by the export", async () => {
  await withRepo(async repo => {
    const db = await build(repo);
    try {
      const sym = internSym(db, "type:v2:orphan#Orphan");
      assert.throws(() => db.prepare("INSERT INTO type(sym, file_id, fqn, simple_name, kind, facts) VALUES (?, 999999, 'Orphan', 'Orphan', 'class', x'00')").run(sym), /FOREIGN KEY/);
      // Columns without a declared FK still cannot point outside the dictionary unnoticed.
      db.prepare("UPDATE kg_edge SET kind_sym=999999999 WHERE id=(SELECT min(id) FROM kg_edge)").run();
      assert.throws(() => logicalDigest(db), /orphan reference in kg_edge/);
      assert.throws(() => validateLogicalData(db), /orphan reference in kg_edge/);
    } finally {
      close(db);
    }
    const docs = await build(repo);
    try {
      docs.exec("PRAGMA foreign_keys=OFF");
      docs.prepare("UPDATE search_doc_token SET doc_id=999999999 WHERE (doc_id, token_sym)=(SELECT doc_id, token_sym FROM search_doc_token LIMIT 1)").run();
      assert.throws(() => logicalDigest(docs), /orphan reference in search_doc_token/);
      assert.throws(() => validateLogicalData(docs), /orphan reference in search_doc_token/);
    } finally {
      close(docs);
    }
    const owned = await build(repo);
    try {
      owned.exec("PRAGMA foreign_keys=OFF");
      owned.prepare("UPDATE kg_edge_owner SET edge_id=999999999 WHERE (edge_id, owner_sym)=(SELECT edge_id, owner_sym FROM kg_edge_owner LIMIT 1)").run();
      assert.throws(() => logicalDigest(owned), /orphan reference in kg_edge_owner/);
      assert.throws(() => validateLogicalData(owned), /orphan reference in kg_edge_owner/);
    } finally {
      close(owned);
    }
  });
});

test("the sealed snapshot manifest is workspace-free and strictly parsed", async () => {
  await withRepo(async repo => {
    const left = await build(repo);
    const right = await build(repo, { padSyms: 31, batchSize: 2 });
    try {
      const sealed = { snapshotId: "snap-0001", bytes: 8192, pageSize: 4096 };
      const manifest = buildSnapshotManifest(left, sealed);
      assert.equal(manifest.formatVersion, SNAPSHOT_MANIFEST_FORMAT);
      assert.ok(manifest.sources.java > 0 && manifest.sources.resources > 0);
      assert.equal(manifest.contentManifestId, buildSnapshotManifest(right, sealed).contentManifestId);
      assert.equal(logicalDigest(left).digest, logicalDigest(right).digest);
      assert.equal("logical" in manifest, false);
      assert.throws(() => parseSnapshotManifest({ ...manifest, formatVersion: "ilv2-snapshot-manifest/mac1" }), /formatVersion/);
      // mac2 named the file digest; a delta publish no longer computes it (contract §2.7, plan B).
      assert.throws(() => parseSnapshotManifest({ ...manifest, formatVersion: "ilv2-snapshot-manifest/mac2", file: { ...manifest.file, sha256: "a".repeat(64) } }), /formatVersion/);
      assert.throws(() => parseSnapshotManifest({ ...manifest, file: { ...manifest.file, sha256: "a".repeat(64) } }), /invalid snapshot manifest: file/);
      assert.throws(() => parseSnapshotManifest({ ...manifest, logical: logicalDigest(left) }), /unexpected fields/);
      assert.equal(JSON.stringify(manifest).includes(repo), false);
      assert.throws(() => parseSnapshotManifest({ ...manifest, formatVersion: "ilv2-snapshot-manifest/v0" }), /formatVersion/);
      assert.throws(() => parseSnapshotManifest({ ...manifest, repoRoot: repo }), /unexpected fields/);
      assert.throws(() => parseSnapshotManifest({ ...manifest, file: { ...manifest.file, pages: 3 } }), /file/);
      assert.throws(() => parseSnapshotManifest({ ...manifest, schemaVersion: 2 ** 53 }), /schemaVersion/);
    } finally {
      close(left);
      close(right);
    }
  });
});

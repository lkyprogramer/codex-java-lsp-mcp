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
import { diffLogical, exportLogical, logicalDigest } from "./logical-export.js";
import { ensureSchema } from "./schema.js";
import { buildSnapshotManifest, parseSnapshotManifest, SNAPSHOT_MANIFEST_FORMAT } from "./snapshot-manifest.js";
import { internSym, symId } from "./sym.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";

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
      for (const table of ["file", "type", "method", "edge", "kg_node", "kg_edge", "entity", "search_doc", "mybatis_resource", "resource_scan"]) {
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

test("dangling references are rejected by SQLite or by the export", async () => {
  await withRepo(async repo => {
    const db = await build(repo);
    try {
      const sym = internSym(db, "type:v2:orphan#Orphan");
      assert.throws(() => db.prepare("INSERT INTO type(sym, file_id, fqn, simple_name, kind, facts) VALUES (?, 999999, 'Orphan', 'Orphan', 'class', x'00')").run(sym), /FOREIGN KEY/);
      // Columns without a declared FK still cannot point outside the dictionary unnoticed.
      db.prepare("UPDATE kg_edge SET kind_sym=999999999 WHERE id=(SELECT min(id) FROM kg_edge)").run();
      assert.throws(() => logicalDigest(db), /orphan reference in kg_edge/);
    } finally {
      close(db);
    }
  });
});

test("the sealed snapshot manifest is workspace-free and strictly parsed", async () => {
  await withRepo(async repo => {
    const left = await build(repo);
    const right = await build(repo, { padSyms: 31, batchSize: 2 });
    try {
      const sealed = { snapshotId: "snap-0001", bytes: 8192, pageSize: 4096, sha256: "a".repeat(64) };
      const manifest = buildSnapshotManifest(left, sealed);
      assert.equal(manifest.formatVersion, SNAPSHOT_MANIFEST_FORMAT);
      assert.ok(manifest.sources.java > 0 && manifest.sources.resources > 0);
      assert.equal(manifest.contentManifestId, buildSnapshotManifest(right, sealed).contentManifestId);
      assert.equal(manifest.logical.digest, buildSnapshotManifest(right, sealed).logical.digest);
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

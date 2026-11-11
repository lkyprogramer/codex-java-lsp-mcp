import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { close, openIndexDb, SQLITE_MAX_VARIABLE_NUMBER, withTransaction } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { readEntityRecords } from "../sql/entity-tokens.js";
import { SqlKnowledgeGraph } from "../sql/knowledge-graph.js";
import { encodeFacts, STATIC_EDGE_SELECT } from "../sql/rows.js";
import { internSym } from "../sql/sym.js";
import { probeLayout } from "../../layout-probe.js";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { applyBuilderJob } from "../../index-builder/incremental.js";
import { readMeta } from "../../index-builder/progress.js";
import { currentBuildKey } from "../sql/snapshot-manifest.js";
import { computeBuildFingerprint } from "../build-fingerprint.js";
import { discoverJavaFiles } from "../manifest.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";
const gatewayRel = "src/main/java/demo/PaymentGateway.java";

async function copyFixtures(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "iod-inc-"));
  await cp(fixturesRoot, root, { recursive: true });
  return root;
}

async function cold(repo: string, generation = 1) {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-inc-db-"));
  const dbPath = path.join(dir, "index.sqlite");
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot: repo, db, generation, batchSize: 5 });
  return { db, dbPath };
}

function edgeSnapshot(db: ReturnType<typeof openIndexDb>, paths?: ReadonlySet<string>) {
  const rows = db.prepare(`${STATIC_EDGE_SELECT} ORDER BY f.path, e.sl, e.sc, e.el, e.ec, ks.text, fs.text, ts.text`).all() as Array<{
    kind: string;
    fromId: string;
    toId: string;
    sl: number;
    sc: number;
    el: number;
    ec: number;
    path: string;
  }>;
  return rows
    .filter(row => !paths || paths.has(row.path))
    .map(row => ({
      kind: row.kind,
      fromId: row.fromId,
      toId: row.toId,
      sl: row.sl,
      sc: row.sc,
      el: row.el,
      ec: row.ec,
      path: row.path
    }));
}

function entitySnapshot(db: ReturnType<typeof openIndexDb>, paths?: ReadonlySet<string>) {
  return readEntityRecords(db)
    .filter(record => !paths || paths.has(record.relativePath))
    .map(record => ({
      entityId: record.entityId,
      kind: record.kind,
      fqn: record.fqn,
      simpleName: record.simpleName,
      relativePath: record.relativePath,
      identifierTokens: [...record.identifierTokens].sort(),
      chunkTokens: [...record.chunkTokens].sort()
    }))
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
}

function graphSnapshot(db: ReturnType<typeof openIndexDb>, paths?: ReadonlySet<string>) {
  const graph = new SqlKnowledgeGraph(db);
  if (!paths) {
    return { digest: graph.digest(), nodes: graph.nodesById.size, edges: graph.edgesById.size };
  }
  const nodes = [...paths].flatMap(relativePath => graph.nodesByPath(relativePath)).map(node => ({
    id: node.id,
    kind: node.kind,
    relativePath: node.relativePath,
    javaIndexId: node.javaIndexId
  })).sort((left, right) => left.id.localeCompare(right.id));
  return { nodes };
}

function cascadeCounts(db: ReturnType<typeof openIndexDb>, relativePath: string) {
  const file = db.prepare("SELECT count(*) AS n FROM file WHERE path=?").get(relativePath) as { n: number };
  const dangling = db.prepare(
    "SELECT count(*) AS n FROM type t LEFT JOIN file f ON f.id=t.file_id WHERE f.id IS NULL"
  ).get() as { n: number };
  const danglingEdges = db.prepare(
    "SELECT count(*) AS n FROM edge e LEFT JOIN file f ON f.id=e.file_id WHERE f.id IS NULL"
  ).get() as { n: number };
  const entities = db.prepare(
    "SELECT count(*) AS n FROM entity e JOIN sym s ON s.id=e.path_sym WHERE s.text=?"
  ).get(relativePath) as { n: number };
  return {
    files: Number(file.n),
    danglingTypes: Number(dangling.n),
    danglingEdges: Number(danglingEdges.n),
    entities: Number(entities.n),
    kgNodes: new SqlKnowledgeGraph(db).nodesByPath(relativePath).length
  };
}

function fileFacts(db: ReturnType<typeof openIndexDb>) {
  return db.prepare("SELECT id, path, content_hash, size, generation, hex(facts) AS facts FROM file ORDER BY path").all()
    .concat(db.prepare("SELECT path, content_hash FROM resource_scan ORDER BY path").all());
}

function fileIdentity(db: ReturnType<typeof openIndexDb>) {
  return (db.prepare(
    "SELECT f.path AS path, f.content_hash AS contentHash, f.generation AS generation, s.mtime_ns AS mtime FROM file f LEFT JOIN ws.file_stat s ON s.path=f.path ORDER BY f.path"
  ).all() as Array<{ path: string; contentHash: string; generation: number; mtime: string }>).map(row => ({
    path: row.path,
    contentHash: row.contentHash,
    generation: Number(row.generation),
    // Nanoseconds exceed 2^53: compared as bigints, never as Numbers.
    mtime: BigInt(row.mtime)
  }));
}

async function bumpAllJavaMtimes(repo: string, whenMs: number): Promise<void> {
  const files = await discoverJavaFiles(repo, probeLayout(repo));
  const at = new Date(whenMs);
  for (const file of files) await utimes(file.absolutePath, at, at);
}

test("refresh after a signature change matches recold-build edges/KG/entity", async () => {
  const repo = await copyFixtures();
  const incremental = await cold(repo, 1);
  try {
    const service = path.join(repo, serviceRel);
    const original = await readFile(service, "utf8");
    await writeFile(
      service,
      original.replace("OrderResponse create(OrderRequest request)", "OrderResponse create(OrderRequest request, String note)")
    );
    const refreshed = await applyBuilderJob({
      repoRoot: repo,
      db: incremental.db,
      job: { id: 1, kind: "refresh", generation: 2, changed: [service], deleted: [] }
    });
    assert.equal(refreshed.ok, true, refreshed.error);
    assert.equal(refreshed.indexedGeneration, 2);
    const recold = await cold(repo, 2);
    try {
      const paths = new Set([
        serviceRel,
        "src/main/java/demospring/OrderController.java"
      ]);
      assert.deepEqual(edgeSnapshot(incremental.db, paths), edgeSnapshot(recold.db, paths));
      assert.deepEqual(entitySnapshot(incremental.db, paths), entitySnapshot(recold.db, paths));
      assert.deepEqual(graphSnapshot(incremental.db, paths), graphSnapshot(recold.db, paths));
      assert.deepEqual(edgeSnapshot(incremental.db), edgeSnapshot(recold.db));
      assert.deepEqual(entitySnapshot(incremental.db), entitySnapshot(recold.db));
      assert.equal(graphSnapshot(incremental.db).digest, graphSnapshot(recold.db).digest);
    } finally {
      close(recold.db);
    }
  } finally {
    close(incremental.db);
    await rm(repo, { recursive: true, force: true });
  }
});

test("deleting a file cascades facts/KG/entity rows to zero", async () => {
  const repo = await copyFixtures();
  const built = await cold(repo, 1);
  try {
    internSym(built.db, gatewayRel);
    assert.ok(cascadeCounts(built.db, gatewayRel).files > 0);
    const result = await applyBuilderJob({
      repoRoot: repo,
      db: built.db,
      job: { id: 2, kind: "refresh", generation: 2, changed: [], deleted: [path.join(repo, gatewayRel)] }
    });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(cascadeCounts(built.db, gatewayRel), {
      files: 0,
      danglingTypes: 0,
      danglingEdges: 0,
      entities: 0,
      kgNodes: 0
    });
  } finally {
    close(built.db);
    await rm(repo, { recursive: true, force: true });
  }
});

test("reconcile with rewritten mtimes does not reparse identical Java content", async () => {
  const repo = await copyFixtures();
  const incremental = await cold(repo, 1);
  try {
    const before = fileIdentity(incremental.db);
    const factsBefore = fileFacts(incremental.db);
    const edgesBefore = edgeSnapshot(incremental.db);
    await bumpAllJavaMtimes(repo, Date.now() + 120_000);
    const result = await applyBuilderJob({
      repoRoot: repo,
      db: incremental.db,
      job: { id: 4, kind: "reconcile", generation: 2 }
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(readMeta(incremental.db, "indexedGeneration"), "2");
    const after = fileIdentity(incremental.db);
    assert.deepEqual(
      after.map(row => ({ path: row.path, contentHash: row.contentHash, generation: row.generation })),
      before.map(row => ({ path: row.path, contentHash: row.contentHash, generation: row.generation }))
    );
    assert.ok(after.every((row, index) => row.mtime > before[index]!.mtime), "mtime stamps must follow the checkout");
    // The restamp lands in the workspace stat store; file facts keep their bytes.
    assert.deepEqual(fileFacts(incremental.db), factsBefore);
    assert.deepEqual(edgeSnapshot(incremental.db), edgesBefore);
  } finally {
    close(incremental.db);
    await rm(repo, { recursive: true, force: true });
  }
});

test("mtime-only siblings still refresh a file whose content actually changed", async () => {
  const repo = await copyFixtures();
  const incremental = await cold(repo, 1);
  try {
    const before = new Map(fileIdentity(incremental.db).map(row => [row.path, row]));
    await bumpAllJavaMtimes(repo, Date.now() + 120_000);
    const service = path.join(repo, serviceRel);
    const original = await readFile(service, "utf8");
    await writeFile(service, original.replace("repository.save", "repository.save /* iod-mtime */"));
    const result = await applyBuilderJob({
      repoRoot: repo,
      db: incremental.db,
      job: { id: 5, kind: "reconcile", generation: 2 }
    });
    assert.equal(result.ok, true, result.error);
    const after = fileIdentity(incremental.db);
    for (const row of after) {
      const previous = before.get(row.path);
      assert.ok(previous, row.path);
      if (row.path === serviceRel) {
        assert.equal(row.generation, 2);
        assert.notEqual(row.contentHash, previous.contentHash);
      } else {
        assert.equal(row.generation, previous.generation);
        assert.equal(row.contentHash, previous.contentHash);
      }
    }
  } finally {
    close(incremental.db);
    await rm(repo, { recursive: true, force: true });
  }
});

test("reconcile sees an external edit and matches recold-build", async () => {
  const repo = await copyFixtures();
  const incremental = await cold(repo, 1);
  try {
    const service = path.join(repo, serviceRel);
    const original = await readFile(service, "utf8");
    await writeFile(service, original.replace("repository.save", "repository.save /* iod-inc */"));
    const result = await applyBuilderJob({
      repoRoot: repo,
      db: incremental.db,
      job: { id: 3, kind: "reconcile", generation: 2 }
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(readMeta(incremental.db, "indexedGeneration"), "2");
    const recold = await cold(repo, 2);
    try {
      const paths = new Set([serviceRel]);
      assert.deepEqual(edgeSnapshot(incremental.db, paths), edgeSnapshot(recold.db, paths));
      assert.deepEqual(entitySnapshot(incremental.db, paths), entitySnapshot(recold.db, paths));
      assert.deepEqual(edgeSnapshot(incremental.db), edgeSnapshot(recold.db));
    } finally {
      close(recold.db);
    }
  } finally {
    close(incremental.db);
    await rm(repo, { recursive: true, force: true });
  }
});

test("a job whose round captured other build inputs is refused before any write", async () => {
  const repo = await copyFixtures();
  const incremental = await cold(repo, 1);
  try {
    const before = fileFacts(incremental.db);
    const expected = readMeta(incremental.db, "buildFingerprint");
    for (const job of [{ id: 1, kind: "full" as const, generation: 2 }, { id: 2, kind: "refresh" as const, generation: 2, changed: [serviceRel] }]) {
      const refused = await applyBuilderJob({ repoRoot: repo, db: incremental.db, job: { ...job, buildKey: "0".repeat(64) } });
      assert.deepEqual([refused.ok, refused.error], [false, "buildKey changed before build"]);
    }
    assert.equal(readMeta(incremental.db, "indexedGeneration"), "1");
    assert.equal(readMeta(incremental.db, "buildFingerprint"), expected);
    assert.deepEqual(fileFacts(incremental.db), before, "nothing was rebuilt");
    const matching = await applyBuilderJob({ repoRoot: repo, db: incremental.db,
      job: { id: 3, kind: "refresh", generation: 2, changed: [serviceRel], buildKey: currentBuildKey(expected!) } });
    assert.equal(matching.ok, true, matching.error);
  } finally {
    close(incremental.db);
    await rm(repo, { recursive: true, force: true });
  }
});

test("a build-file-only change is a delta on its base only while the layout and extractor the base recorded still match", async () => {
  const repo = await copyFixtures();
  const built = await cold(repo, 1);
  try {
    const pom = path.join(repo, "pom.xml");
    await writeFile(pom, (await readFile(pom, "utf8")).replace("</project>", "  <!-- dependency bump -->\n</project>"));
    const fingerprint = await computeBuildFingerprint(repo, probeLayout(repo));
    assert.notEqual(fingerprint, readMeta(built.db, "buildFingerprint"));
    const buildKey = currentBuildKey(fingerprint);
    // Unmarked, changed inputs escalate as before.
    const plain = await applyBuilderJob({ repoRoot: repo, db: built.db, escalation: "report", job: { id: 1, kind: "reconcile", generation: 2, buildKey } });
    assert.equal(plain.escalation, "build/resolver inputs changed");
    const moved = await applyBuilderJob({ repoRoot: repo, db: built.db, escalation: "report",
      job: { id: 2, kind: "reconcile", generation: 2, buildKey, buildInputsMoved: true } });
    assert.equal(moved.ok, true, moved.error);
    assert.equal(moved.escalation, undefined);
    assert.equal(readMeta(built.db, "buildFingerprint"), fingerprint, "the snapshot records the inputs it now stands for");
    // A tree-sitter upgrade moves the buildKey without moving the fingerprint: only the base's own record can tell.
    withTransaction(built.db, () => { built.db.prepare("UPDATE meta SET value='other-extractor' WHERE key='extractorVersion'").run(); });
    const stale = await applyBuilderJob({ repoRoot: repo, db: built.db, escalation: "report",
      job: { id: 3, kind: "reconcile", generation: 3, buildKey, buildInputsMoved: true } });
    assert.equal(stale.escalation, "build/resolver inputs changed");
  } finally {
    close(built.db);
    await rm(repo, { recursive: true, force: true });
  }
});

test("refresh with more owned ids than SQLITE_MAX_VARIABLE_NUMBER still completes", async () => {
  const repo = await copyFixtures();
  const built = await cold(repo, 1);
  try {
    const file = built.db.prepare("SELECT id AS id FROM file WHERE path=?").get(serviceRel) as { id: number } | undefined;
    assert.ok(file, "fixture OrderService file");
    const fileId = Number(file.id);
    const owner = built.db.prepare("SELECT t.sym AS sym FROM type t WHERE t.file_id=?").get(fileId) as { sym: number } | undefined;
    assert.ok(owner, "fixture OrderService type");
    const ownerSym = Number(owner.sym);
    const dummyFacts = encodeFacts({});
    const padPrefix = "iod-pad:";
    withTransaction(built.db, () => {
      const insert = built.db.prepare(
        "INSERT INTO method(sym, owner_sym, file_id, name, is_ctor, arity, facts) VALUES (?, ?, ?, ?, 0, 0, ?)"
      );
      for (let index = 0; index < SQLITE_MAX_VARIABLE_NUMBER; index += 1) {
        insert.run(internSym(built.db, `${padPrefix}${index}`), ownerSym, fileId, `pad${index}`, dummyFacts);
      }
    });
    const padded = built.db.prepare(
      "SELECT count(*) AS n FROM method m JOIN file f ON f.id=m.file_id WHERE f.path=?"
    ).get(serviceRel) as { n: number };
    assert.ok(Number(padded.n) > SQLITE_MAX_VARIABLE_NUMBER, `owned methods ${padded.n}`);
    const result = await applyBuilderJob({
      repoRoot: repo,
      db: built.db,
      job: { id: 9, kind: "refresh", generation: 2, changed: [path.join(repo, serviceRel)], deleted: [] }
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(readMeta(built.db, "indexedGeneration"), "2");
    const leftover = built.db.prepare(
      "SELECT count(*) AS n FROM method m JOIN sym s ON s.id=m.sym WHERE s.text LIKE ?"
    ).get(`${padPrefix}%`) as { n: number };
    assert.equal(Number(leftover.n), 0);
    assert.ok(cascadeCounts(built.db, serviceRel).files > 0);
  } finally {
    close(built.db);
    await rm(repo, { recursive: true, force: true });
  }
});

// A stat row that matches the file on disk but vouches for a different hash
// than the facts (a torn main/ws commit, a foreign or stale stat store) must
// never let reconcile skip the file.
async function forgeStat(db: ReturnType<typeof openIndexDb>, repo: string, relativePath: string, kind: "java" | "resource") {
  const file = path.join(repo, relativePath);
  const info = await stat(file, { bigint: true });
  const hash = createHash("sha256").update(await readFile(file, "utf8"), "utf8").digest("hex");
  db.prepare(`INSERT INTO ws.file_stat(path, kind, content_hash, size, mtime_ns, ctime_ns, ino, dev) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET content_hash=excluded.content_hash, size=excluded.size, mtime_ns=excluded.mtime_ns,
      ctime_ns=excluded.ctime_ns, ino=excluded.ino, dev=excluded.dev`)
    .run(relativePath, kind, hash, Number(info.size), String(info.mtimeNs), String(info.ctimeNs), String(info.ino), String(info.dev));
  return hash;
}

test("a stat row matching the disk but not the facts hash forces Java and XML re-reads", async () => {
  const repo = await copyFixtures();
  const incremental = await cold(repo, 1);
  try {
    const service = path.join(repo, serviceRel);
    await writeFile(service, (await readFile(service, "utf8")).replace("repository.save", "repository.save /* torn */"));
    const javaHash = await forgeStat(incremental.db, repo, serviceRel, "java");
    const xmlRel = "src/main/resources/mapper/ItemMapper.xml";
    const xml = path.join(repo, xmlRel);
    await writeFile(xml, (await readFile(xml, "utf8")).replace("</mapper>", "<!-- torn --></mapper>"));
    const xmlHash = await forgeStat(incremental.db, repo, xmlRel, "resource");
    const result = await applyBuilderJob({ repoRoot: repo, db: incremental.db, job: { id: 9, kind: "reconcile", generation: 2 } });
    assert.equal(result.ok, true, result.error);
    const java = incremental.db.prepare("SELECT content_hash AS hash, generation FROM file WHERE path=?").get(serviceRel) as { hash: string; generation: number };
    assert.deepEqual({ hash: java.hash, generation: Number(java.generation) }, { hash: javaHash, generation: 2 });
    const scanned = incremental.db.prepare("SELECT content_hash AS hash FROM resource_scan WHERE path=?").get(xmlRel) as { hash: string };
    assert.equal(scanned.hash, xmlHash);
  } finally {
    close(incremental.db);
    await rm(repo, { recursive: true, force: true });
  }
});

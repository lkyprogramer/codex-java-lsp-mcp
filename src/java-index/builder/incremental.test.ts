import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { close, openIndexDb } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { readEntityRecords } from "../sql/entity-tokens.js";
import { SqlKnowledgeGraph } from "../sql/knowledge-graph.js";
import { STATIC_EDGE_SELECT } from "../sql/rows.js";
import { internSym } from "../sql/sym.js";
import { runSqlColdBuild } from "./cold-build.js";
import { applyBuilderJob, runBuilderServe } from "./incremental.js";
import { readMeta } from "./progress.js";

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

test("serve mode answers refresh JSON jobs then exits", async () => {
  const repo = await copyFixtures();
  const built = await cold(repo, 1);
  try {
    const service = path.join(repo, serviceRel);
    const original = await readFile(service, "utf8");
    await writeFile(service, original.replace("class OrderService", "class OrderService /* serve */"));
    const chunks: string[] = [];
    const lines = (async function* () {
      yield JSON.stringify({ id: 7, kind: "refresh", generation: 2, changed: [service], deleted: [] });
      yield JSON.stringify({ kind: "exit" });
    })();
    await runBuilderServe(repo, built.db, lines, { write: chunk => chunks.push(String(chunk)) });
    assert.equal(chunks.length, 1);
    const payload = JSON.parse(chunks[0]!) as { id: number; ok: boolean; indexedGeneration: number; files: number };
    assert.equal(payload.id, 7);
    assert.equal(payload.ok, true, JSON.stringify(payload));
    assert.equal(payload.indexedGeneration, 2);
    assert.ok(payload.files > 0);
  } finally {
    close(built.db);
    await rm(repo, { recursive: true, force: true });
  }
});

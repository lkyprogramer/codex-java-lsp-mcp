import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import { writeBundle, writeMyBatisResource } from "../sql/rows.js";
import { SqlFactsStore } from "../sql/facts-store.js";
import type { JavaFileBundle, JavaTypeFacts } from "../index-types.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { discoverJavaFiles, discoverMyBatisResourceFiles } from "../manifest.js";
import { extractMyBatisMapperFacts } from "../mybatis-xml-extractor.js";
import { buildTypeRegistryView, JavaNameResolver } from "../name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "./parse-cache.js";
import { probeLayout } from "../../layout-probe.js";
import { KnowledgeGraphBuilder } from "../../java-knowledge/graph-builder.js";
import { recordsFromBundle } from "../entity-search.js";
import { close, openIndexDb } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { SqlKnowledgeGraph } from "../sql/knowledge-graph.js";
import { readEntityRecords } from "../sql/entity-tokens.js";
import { runSqlColdBuild } from "../../index-builder/cold-build.js";
import { readBuildProgress, readMeta } from "../../index-builder/progress.js";

function sqlGraph() {
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  return new SqlKnowledgeGraph(db);
}

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");

async function memoryStoreFromFixtures(): Promise<SqlFactsStore> {
  const backend = await createJavaParserBackend();
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  const resolvedRepoRoot = await realpath(fixturesRoot);
  const layout = probeLayout(resolvedRepoRoot);
  const discovered = await discoverJavaFiles(resolvedRepoRoot, layout);
  const parsed: JavaFileBundle[] = [];
  for (const file of discovered) {
    parsed.push(await parseJavaSourceFile({
      repoRoot: resolvedRepoRoot,
      resolvedRepoRoot,
      inputPath: file.absolutePath,
      generation: 1,
      backend,
      cache,
      layout
    }));
  }
  const registry = buildTypeRegistryView(
    parsed.flatMap(bundle => bundle.types),
    parsed.flatMap(bundle => bundle.methods)
  );
  const resolver = new JavaNameResolver(registry);
  const byId = registry.byId as Map<string, JavaTypeFacts>;
  const resolved: JavaFileBundle[] = [];
  for (const raw of parsed) {
    const next = resolveFileRefs(raw, resolver, registry);
    for (const type of next.types) byId.set(type.typeId, type);
    resolved.push({ ...next, edges: [] });
  }
  const expectedDb = openIndexDb(":memory:");
  ensureSchema(expectedDb);
  for (const bundle of resolved) {
    writeBundle(expectedDb, { ...bundle, edges: buildStaticEdges(bundle, registry, resolver) });
  }
  for (const file of await discoverMyBatisResourceFiles(resolvedRepoRoot, layout)) {
    const content = await readFile(file.absolutePath, "utf8");
    const resource = extractMyBatisMapperFacts({
      relativePath: file.relativePath,
      content,
      contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
      generation: 1
    });
    if (resource) writeMyBatisResource(expectedDb, resource);
  }
  return new SqlFactsStore(expectedDb);
}

test("sql cold build table counts match JavaIndexStore", async () => {
  const store = await memoryStoreFromFixtures();
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    const result = await runSqlColdBuild({ repoRoot: fixturesRoot, db, batchSize: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.parseFailed, 0);
    assert.equal(result.parseFailures.length, 0);
    assert.equal(result.files, store.filesByPath.size);
    assert.equal(result.types, store.typesById.size);
    assert.equal(result.methods, store.methodsById.size);
    assert.equal(result.edges, [...store.iterEdges()].length);
    assert.equal(readMeta(db, "buildState"), "READY");
    const kgNodes = db.prepare("SELECT count(*) AS n FROM kg_node").get() as { n: number };
    const entities = db.prepare("SELECT count(*) AS n FROM entity").get() as { n: number };
    assert.ok(kgNodes.n > 0);
    assert.ok(entities.n > 0);
    const expectedGraph = sqlGraph();
    new KnowledgeGraphBuilder(expectedGraph).rebuildFromStore(store, 1);
    const rebuilt = new SqlKnowledgeGraph(db);
    assert.equal(rebuilt.nodesById.size, expectedGraph.nodesById.size);
    assert.equal(rebuilt.edgesById.size, expectedGraph.edgesById.size);
    assert.equal(rebuilt.digest(), expectedGraph.digest());
    const expectedEntities = store.files(
      [...store.iterFiles()].map(file => file.relativePath)
    ).flatMap(recordsFromBundle);
    const actualEntities = readEntityRecords(db);
    assert.equal(actualEntities.length, expectedEntities.length);
    assert.deepEqual(
      actualEntities.map(record => record.entityId).sort(),
      expectedEntities.map(record => record.entityId).sort()
    );
  } finally {
    close(db);
  }
});

test("sql cold build resumes resolve after an injected abort", async () => {
  const store = await memoryStoreFromFixtures();
  const dir = await mkdtemp(path.join(tmpdir(), "iod-cold-"));
  const dbPath = path.join(dir, "index.sqlite");
  const first = openIndexDb(dbPath);
  try {
    ensureSchema(first);
    await assert.rejects(
      () => runSqlColdBuild({
        repoRoot: fixturesRoot,
        db: first,
        batchSize: 2,
        shouldAbort: progress => progress.phase === "resolve" && progress.done >= 4
      }),
      /injected abort/
    );
    assert.equal(readMeta(first, "buildState"), "BUILDING");
    const progress = readBuildProgress(first);
    assert.ok(progress);
    assert.equal(progress.phase, "resolve");
    assert.ok(progress.done >= 4);
    assert.ok(progress.done < store.filesByPath.size);
  } finally {
    close(first);
  }

  const second = openIndexDb(dbPath);
  try {
    ensureSchema(second);
    const result = await runSqlColdBuild({ repoRoot: fixturesRoot, db: second, batchSize: 2 });
    assert.equal(result.files, store.filesByPath.size);
    assert.equal(result.types, store.typesById.size);
    assert.equal(result.methods, store.methodsById.size);
    assert.equal(result.edges, [...store.iterEdges()].length);
    assert.equal(readMeta(second, "buildState"), "READY");
  } finally {
    close(second);
  }
});

// Cold-build lock follow-up: the entity/document phase must not hold a read
// cursor across its per-file write transactions. With a cursor open, BEGIN
// IMMEDIATE is an upgrade of a stale read snapshot, which SQLite refuses at
// once (SQLITE_BUSY, no busy wait) as soon as any other connection commits.
test("sql cold build survives foreign commits during the entity phase", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "iod-cold-foreign-"));
  const dbPath = path.join(dir, "index.sqlite");
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  db.exec("CREATE TABLE zz_noise(x INTEGER)");
  const stop = new Int32Array(new SharedArrayBuffer(8));
  const noise = new Worker(`
    const { workerData, parentPort } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const flags = new Int32Array(workerData.stop);
    const db = new DatabaseSync(workerData.dbPath);
    db.exec("PRAGMA busy_timeout=5000");
    let commits = 0;
    while (Atomics.load(flags, 0) === 0) {
      db.exec("BEGIN IMMEDIATE; INSERT INTO zz_noise VALUES (1); COMMIT");
      commits += 1;
      Atomics.wait(flags, 0, 0, 1);
    }
    db.close();
    parentPort.postMessage(commits);
  `, { eval: true, workerData: { dbPath, stop: stop.buffer } });
  const commits = new Promise<number>(resolve => noise.once("message", resolve));
  let foreignCommits = 0;
  try {
    await runSqlColdBuild({ repoRoot: fixturesRoot, db, generation: 1 });
    assert.equal(readMeta(db, "buildState"), "READY");
  } finally {
    Atomics.store(stop, 0, 1);
    Atomics.notify(stop, 0);
    foreignCommits = await commits;
    close(db);
  }
  assert.ok(foreignCommits > 0, "the foreign writer must have committed during the build");
});

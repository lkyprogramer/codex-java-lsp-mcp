import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { KnowledgeGraphBuilder } from "../../java-knowledge/graph-builder.js";
import { knowledgeEdgeId } from "../../java-knowledge/entity-id.js";
import type { GraphEdge, GraphNode } from "../../java-knowledge/schema.js";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import { writeBundle, writeMyBatisResource } from "./rows.js";
import { SqlFactsStore } from "./facts-store.js";
import type { JavaFileBundle, JavaTypeFacts } from "../index-types.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { extractMyBatisMapperFacts } from "../mybatis-xml-extractor.js";
import { buildTypeRegistryView, JavaNameResolver } from "../name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../builder/parse-cache.js";
import { close, openIndexDb, type IndexDatabase } from "./driver.js";
import { SqlKnowledgeGraph } from "./knowledge-graph.js";
import { ensureSchema } from "./schema.js";
import { exportLogical } from "./logical-export.js";
import { checkGraphInvariants } from "./index-invariants.js";
import { GraphFragment } from "../../java-knowledge/graph-fragment.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");

function listFiles(root: string, suffix: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix)) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

async function loadFacts(): Promise<{ db: IndexDatabase; store: SqlFactsStore }> {
  const backend = await createJavaParserBackend();
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  const resolvedRepoRoot = await realpath(fixturesRoot);
  const parsed: JavaFileBundle[] = [];
  for (const relativePath of listFiles(fixturesRoot, ".java")) {
    parsed.push(await parseJavaSourceFile({
      repoRoot: fixturesRoot,
      resolvedRepoRoot,
      inputPath: path.join(fixturesRoot, relativePath),
      generation: 1,
      backend,
      cache
    }));
  }
  const registry = buildTypeRegistryView(parsed.flatMap(bundle => bundle.types), parsed.flatMap(bundle => bundle.methods));
  const resolver = new JavaNameResolver(registry);
  const byId = registry.byId as Map<string, JavaTypeFacts>;
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  const resolved: JavaFileBundle[] = [];
  for (const raw of parsed) {
    const next = resolveFileRefs(raw, resolver, registry);
    for (const type of next.types) byId.set(type.typeId, type);
    resolved.push({ ...next, edges: [] });
  }
  for (const bundle of resolved) {
    writeBundle(db, { ...bundle, edges: buildStaticEdges(bundle, registry, resolver) });
  }
  for (const relativePath of listFiles(fixturesRoot, ".xml").filter(item => item.includes("/mapper/"))) {
    const content = readFileSync(path.join(fixturesRoot, relativePath), "utf8");
    const resource = extractMyBatisMapperFacts({
      relativePath,
      content,
      contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
      generation: 1
    });
    if (resource) writeMyBatisResource(db, resource);
  }
  return { db, store: new SqlFactsStore(db) };
}

function sortedNodes(graph: { nodesById: { entries(): Iterable<[string, GraphNode]> } }): GraphNode[] {
  return [...graph.nodesById.entries()].map(([, node]) => node).sort((a, b) => a.id.localeCompare(b.id));
}

function sortedEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  return [...edges].sort((a, b) => a.edgeId.localeCompare(b.edgeId));
}

function allEdges(graph: SqlKnowledgeGraph): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [id] of graph.nodesById.entries()) {
    edges.push(...graph.successors(id));
  }
  return sortedEdges(edges);
}

const GRAPH_TABLES = ["kg_node", "kg_node_owner", "kg_edge", "kg_edge_owner"] as const;

function graphRows(db: IndexDatabase): Record<string, string[]> {
  const tables = exportLogical(db).tables;
  return Object.fromEntries(GRAPH_TABLES.map(table => [table, tables[table]!.rows]));
}

function assertGraphInvariants(db: IndexDatabase): void {
  const failed = checkGraphInvariants(db).filter(item => item.violations > 0);
  assert.deepEqual(failed, []);
}

function emptyDb(): IndexDatabase {
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  return db;
}

function owners(db: IndexDatabase, kind: string, fromId: string, toId: string): string[] {
  return (db.prepare(`SELECT os.text AS owner FROM kg_edge e JOIN kg_edge_owner o ON o.edge_id=e.id
    JOIN sym fs ON fs.id=e.from_sym JOIN sym ks ON ks.id=e.kind_sym JOIN sym ts ON ts.id=e.to_sym JOIN sym os ON os.id=o.owner_sym
    WHERE fs.text=? AND ks.text=? AND ts.text=? ORDER BY os.text`).all(fromId, kind, toId) as Array<{ owner: string }>).map(row => row.owner);
}

function call(kind: GraphEdge["kind"], fromId: string, toId: string): GraphEdge {
  return { edgeId: knowledgeEdgeId({ kind, fromId, toId }), kind, fromId, toId, generation: 1 };
}

function fragment(owner: string, nodes: string[], edges: GraphEdge[]): GraphFragment {
  const out = new GraphFragment(owner);
  for (const id of nodes) out.upsertNode({ id, kind: "METHOD", generation: 1, relativePath: owner }, owner);
  for (const edge of edges) out.addEdge(edge, owner);
  return out;
}

test("fixture graph rows do not depend on the order files are added", async () => {
  const forward = await loadFacts();
  const backward = await loadFacts();
  try {
    new KnowledgeGraphBuilder(new SqlKnowledgeGraph(forward.db)).rebuildFromStore(forward.store, 1);
    const files = [...backward.store.iterFiles()].map(file => file.relativePath).reverse();
    const graph = new SqlKnowledgeGraph(backward.db);
    const builder = new KnowledgeGraphBuilder(graph);
    graph.clear();
    for (const relativePath of files) builder.appendFile(backward.store.files([relativePath])[0]!, backward.store, 1);
    graph.flushMeta();
    const expected = graphRows(forward.db);
    assert.ok(expected.kg_edge_owner!.length > expected.kg_edge!.length, "fixtures must share some edges between files");
    assert.deepEqual(graphRows(backward.db), expected);
    assert.equal(new SqlKnowledgeGraph(backward.db).digest(), new SqlKnowledgeGraph(forward.db).digest());
    assertGraphInvariants(forward.db);
    assertGraphInvariants(backward.db);
  } finally {
    close(forward.db);
    close(backward.db);
  }
});

test("a call edge and its reverse belong to the calling file only", () => {
  const db = emptyDb();
  try {
    const graph = new SqlKnowledgeGraph(db);
    graph.replaceOwner(fragment("B.java", ["B#n"], []));
    graph.replaceOwner(fragment("A.java", ["A#m"], [call("CALLS_EXACT", "A#m", "B#n")]));
    graph.replaceOwner(fragment("C.java", ["C#k"], [call("CALLS_EXACT", "C#k", "B#n")]));
    assert.deepEqual(owners(db, "CALLS_EXACT", "A#m", "B#n"), ["A.java"]);
    assert.deepEqual(owners(db, "CALLED_BY", "B#n", "A#m"), ["A.java"]);
    assert.deepEqual(owners(db, "CALLED_BY", "B#n", "C#k"), ["C.java"]);
    // A drops its call: both directions go, C's caller edge and B's node stay.
    graph.replaceOwner(fragment("A.java", ["A#m"], []));
    assert.deepEqual(owners(db, "CALLS_EXACT", "A#m", "B#n"), []);
    assert.deepEqual(owners(db, "CALLED_BY", "B#n", "A#m"), []);
    assert.deepEqual(graph.successors("B#n", "CALLED_BY").map(edge => edge.toId), ["C#k"]);
    assert.equal(graph.nodesById.has("B#n"), true);
    // A caller added back by a later edit owns the reverse again.
    graph.replaceOwner(fragment("A.java", ["A#m"], [call("CALLS_EXACT", "A#m", "B#n")]));
    assert.deepEqual(graph.successors("B#n", "CALLED_BY").map(edge => edge.toId).sort(), ["A#m", "C#k"]);
  } finally {
    close(db);
  }
});

test("a dispatch target shared by two callers keeps its reverse until the last caller goes", () => {
  const db = emptyDb();
  try {
    const graph = new SqlKnowledgeGraph(db);
    const edges = (from: string) => [call("CALLS_VIRTUAL", from, "Base#x"), call("DISPATCHES_TO", "Base#x", "Child#x")];
    graph.replaceOwner(fragment("Base.java", ["Base#x"], []));
    graph.replaceOwner(fragment("Child.java", ["Child#x"], []));
    graph.replaceOwner(fragment("A.java", ["A#m"], edges("A#m")));
    graph.replaceOwner(fragment("C.java", ["C#k"], edges("C#k")));
    assert.deepEqual(owners(db, "DISPATCHES_TO", "Base#x", "Child#x"), ["A.java", "C.java"]);
    assert.deepEqual(owners(db, "CALLED_BY", "Child#x", "Base#x"), ["A.java", "C.java"]);
    graph.removeFiles(["A.java"]);
    assert.deepEqual(owners(db, "CALLED_BY", "Child#x", "Base#x"), ["C.java"]);
    graph.replaceOwner(fragment("C.java", ["C#k"], []));
    assert.deepEqual(owners(db, "CALLED_BY", "Child#x", "Base#x"), []);
    assert.equal(graph.successors("Base#x", "DISPATCHES_TO").length, 0);
  } finally {
    close(db);
  }
});

test("addEdge gives an existing reverse edge to every owner", () => {
  const db = emptyDb();
  const edge = call("DISPATCHES_TO", "method:base", "method:child");
  try {
    let graph = new SqlKnowledgeGraph(db);
    graph.addEdge(edge, "A.java");
    graph.addEdge(edge, "B.java");
    graph = new SqlKnowledgeGraph(db);
    graph.removeFiles(["A.java"]);
    assert.equal(graph.successors("method:base", "DISPATCHES_TO").length, 1);
    assert.equal(graph.successors("method:child", "CALLED_BY").length, 1, "second owner must retain the reverse edge");
    graph.addEdge(edge, "A.java");
    graph = new SqlKnowledgeGraph(db);
    graph.removeFiles(["B.java"]);
    assert.equal(graph.successors("method:child", "CALLED_BY").length, 1);
    const cold = emptyDb();
    try {
      new SqlKnowledgeGraph(cold).addEdge(edge, "A.java");
      assert.equal(graph.digest(), new SqlKnowledgeGraph(cold).digest());
    } finally {
      close(cold);
    }
    graph.removeFiles(["A.java"]);
    assert.equal(graph.edgesById.size, 0);
  } finally {
    close(db);
  }
});

test("module rows stay while any file of the module does; the repository root always stays", () => {
  const db = emptyDb();
  try {
    const graph = new SqlKnowledgeGraph(db);
    graph.upsertNode({ id: "repo", kind: "REPOSITORY", generation: 1 });
    for (const owner of ["m/A.java", "m/B.java"]) {
      const rows = new GraphFragment(owner);
      rows.upsertNode({ id: "module:m", kind: "MODULE", generation: 1, simpleName: "m" }, owner);
      rows.addEdge(call("CONTAINS", "repo", "module:m"), owner);
      graph.replaceOwner(rows);
    }
    graph.removeFiles(["m/A.java"]);
    assert.equal(graph.nodesById.has("module:m"), true);
    assert.deepEqual(owners(db, "CONTAINS", "repo", "module:m"), ["m/B.java"]);
    graph.removeFiles(["m/B.java"]);
    assert.equal(graph.nodesById.has("module:m"), false);
    assert.equal(graph.edgesById.size, 0);
    assert.equal(graph.nodesById.has("repo"), true);
  } finally {
    close(db);
  }
});

test("replacing an owner with the same rows writes nothing", () => {
  const db = emptyDb();
  try {
    const graph = new SqlKnowledgeGraph(db);
    graph.replaceOwner(fragment("A.java", ["A#m", "A#n"], [call("CALLS_EXACT", "A#m", "A#n")]));
    const before = Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
    // A new generation alone is not a change.
    const again = new GraphFragment("A.java");
    for (const id of ["A#m", "A#n"]) again.upsertNode({ id, kind: "METHOD", generation: 7, relativePath: "A.java" }, "A.java");
    again.addEdge({ ...call("CALLS_EXACT", "A#m", "A#n"), generation: 7 }, "A.java");
    graph.replaceOwner(again);
    assert.equal(Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n), before);
  } finally {
    close(db);
  }
});

test("a fragment rejects rows attributed to another file", () => {
  const rows = new GraphFragment("A.java");
  assert.throws(() => rows.upsertNode({ id: "x", kind: "METHOD", generation: 1 }, "B.xml"), /owned by B\.xml/);
});

test("cold full graph equals a per-file replay in reverse order", async t => {
  const { runSqlColdBuild } = await import("../../index-builder/cold-build.js");
  const { readBundle } = await import("./rows.js");
  const db = openIndexDb(":memory:");
  const oracleDb = openIndexDb(":memory:");
  ensureSchema(db);
  ensureSchema(oracleDb);
  try {
    const remove = t.mock.method(SqlKnowledgeGraph.prototype, "removeFiles", () => {
      throw new Error("fresh full graph must not remove per-file owners");
    });
    await runSqlColdBuild({ repoRoot: fixturesRoot, db });
    assert.equal(remove.mock.callCount(), 0);
    t.mock.restoreAll();
    const store = new SqlFactsStore(db, { factsAreImmutable: true });
    const oracle = new SqlKnowledgeGraph(oracleDb);
    const builder = new KnowledgeGraphBuilder(oracle);
    for (const file of [...store.iterFiles()].reverse()) {
      const bundle = readBundle(db, file.relativePath);
      if (bundle) builder.replaceFile(bundle, store, 1);
    }
    oracle.flushMeta();
    const actual = new SqlKnowledgeGraph(db);
    assert.deepEqual(sortedNodes(actual), sortedNodes(oracle));
    assert.deepEqual(allEdges(actual), allEdges(oracle));
    assert.equal(actual.digest(), oracle.digest());
    const type = [...store.iterTypes()][0]!;
    const cached = store.typesById.get(type.typeId);
    const clear = t.mock.method(store, "clearRequestCache");
    store.implementers(type.typeId);
    assert.equal(clear.mock.callCount(), 0);
    assert.equal(store.typesById.get(type.typeId), cached);
    const live = new SqlFactsStore(db);
    const liveClear = t.mock.method(live, "clearRequestCache");
    assert.deepEqual(live.implementers(type.typeId), store.implementers(type.typeId));
    assert.ok(liveClear.mock.callCount() > 0, "default request-cache invalidation stays intact");
  } finally {
    t.mock.restoreAll();
    close(db);
    close(oracleDb);
  }
});

test("full graph batch size bounds commits and preserves residual-batch graph", async t => {
  const { runSqlColdBuild, writeKnowledgeAndEntities } = await import("../../index-builder/cold-build.js");
  const { logicalDigest } = await import("./logical-export.js");
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  try {
    await runSqlColdBuild({ repoRoot: fixturesRoot, db, batchSize: 1 });
    const expected = logicalDigest(db).digest;
    const fileCount = Number((db.prepare("SELECT count(*) AS n FROM file").get() as { n: number }).n);
    assert.ok(fileCount > 4);
    const original = db.exec;
    const counts = new Map<number, number>();
    for (const batchSize of [1, 3, 4, 200]) {
      let commits = 0;
      t.mock.method(db, "exec", function (this: typeof db, sql: string) {
        if (sql === "COMMIT") commits++;
        return original.call(this, sql);
      });
      writeKnowledgeAndEntities(db, 1, fixturesRoot, undefined, batchSize);
      t.mock.restoreAll();
      assert.equal(logicalDigest(db).digest, expected);
      counts.set(batchSize, commits);
    }
    const fixedCommits = counts.get(1)! - fileCount;
    for (const [batchSize, commits] of counts) {
      assert.equal(commits, fixedCommits + Math.ceil(fileCount / batchSize));
    }
    assert.ok(counts.get(200)! < counts.get(1)!);
    assert.throws(() => writeKnowledgeAndEntities(db, 1, fixturesRoot, undefined, 0), /positive graph batch/);
  } finally {
    t.mock.restoreAll();
    close(db);
  }
});

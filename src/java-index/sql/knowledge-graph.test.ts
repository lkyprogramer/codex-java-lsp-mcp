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
import { close, openIndexDb } from "./driver.js";
import { SqlKnowledgeGraph } from "./knowledge-graph.js";
import { ensureSchema } from "./schema.js";

function sqlGraph() {
  const db = openIndexDb(":memory:");
  ensureSchema(db);
  return new SqlKnowledgeGraph(db);
}

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

async function loadStore(): Promise<SqlFactsStore> {
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
  return new SqlFactsStore(db);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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

test("SqlKnowledgeGraph matches KnowledgeGraphStore for fixtures via graph-builder", async () => {
  const store = await loadStore();
  const mem = sqlGraph();
  new KnowledgeGraphBuilder(mem).rebuildFromStore(store, 1);

  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    const sql = new SqlKnowledgeGraph(db);
    new KnowledgeGraphBuilder(sql).rebuildFromStore(store, 1);

    assert.equal(sql.nodesById.size, mem.nodesById.size);
    assert.equal(sql.edgesById.size, mem.edgesById.size);
    assert.equal(sql.digest(), mem.digest());
    assert.deepEqual(jsonClone(sortedNodes(sql)), jsonClone(sortedNodes(mem)));
    assert.deepEqual(jsonClone(allEdges(sql)), jsonClone(allEdges(mem)));

    for (const [id] of mem.nodesById.entries()) {
      assert.deepEqual(jsonClone(sortedEdges(sql.successors(id))), jsonClone(sortedEdges(mem.successors(id))), `succ:${id}`);
      assert.deepEqual(jsonClone(sortedEdges(sql.predecessors(id))), jsonClone(sortedEdges(mem.predecessors(id))), `pred:${id}`);
    }

    for (const file of store.iterFiles()) {
      const path = file.relativePath;
      const memNodes = jsonClone(mem.nodesByPath(path)).sort((a, b) => a.id.localeCompare(b.id));
      const sqlNodes = jsonClone(sql.nodesByPath(path)).sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(sqlNodes, memNodes, path);
      if (file.fileId) {
        assert.equal(sql.nodeIdForJavaIndexId(file.fileId), mem.nodeIdForJavaIndexId(file.fileId));
      }
    }
  } finally {
    close(db);
  }
});

test("SqlKnowledgeGraph reverse edges, removeFiles, and digest match the in-memory store", () => {
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    const mem = sqlGraph();
    const sql = new SqlKnowledgeGraph(db);
    for (const graph of [mem, sql]) {
      graph.upsertNode({ id: "src/A.java#A#m#1", kind: "METHOD", generation: 1, relativePath: "src/A.java" }, "src/A.java");
      graph.upsertNode({ id: "src/B.java#B#n#1", kind: "METHOD", generation: 1, relativePath: "src/B.java" }, "src/B.java");
      graph.addEdge({
        edgeId: knowledgeEdgeId({ kind: "CALLS_EXACT", fromId: "src/A.java#A#m#1", toId: "src/B.java#B#n#1" }),
        kind: "CALLS_EXACT",
        fromId: "src/A.java#A#m#1",
        toId: "src/B.java#B#n#1",
        generation: 1,
        sourceFile: "src/A.java"
      }, "src/A.java");
    }
    assert.equal(sql.digest(), mem.digest());
    assert.equal(sql.predecessors("src/A.java#A#m#1", "CALLED_BY").length, 1);
    sql.removeFiles(["src/A.java"]);
    mem.removeFiles(["src/A.java"]);
    assert.equal(sql.digest(), mem.digest());
    assert.equal(sql.edgesById.size, 0);
    assert.equal(sql.nodesById.has("src/A.java#A#m#1"), false);
    assert.equal(sql.nodesById.has("src/B.java#B#n#1"), true);
  } finally {
    close(db);
  }
});

test("SqlKnowledgeGraph keeps a shared edge after removing one owner", () => {
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    const mem = sqlGraph();
    const sql = new SqlKnowledgeGraph(db);
    const edge: GraphEdge = {
      edgeId: knowledgeEdgeId({ kind: "MODULE_DEPENDS_ON", fromId: "module:a", toId: "module:b", ordinal: 0 }),
      kind: "MODULE_DEPENDS_ON",
      fromId: "module:a",
      toId: "module:b",
      generation: 1
    };
    for (const graph of [mem, sql]) {
      graph.upsertNode({ id: "module:a", kind: "MODULE", generation: 1 }, "src/A.java");
      graph.upsertNode({ id: "module:b", kind: "MODULE", generation: 1 }, "src/B.java");
      graph.upsertNode({ id: "module:a", kind: "MODULE", generation: 1 }, "src/B.java");
      graph.addEdge(edge, "src/A.java");
      graph.addEdge(edge, "src/B.java");
    }
    sql.removeFiles(["src/A.java"]);
    mem.removeFiles(["src/A.java"]);
    assert.equal(sql.digest(), mem.digest());
    assert.equal(sql.successors("module:a", "MODULE_DEPENDS_ON").length, 1);
    assert.equal(sql.nodesById.has("module:a"), true);
    const reopened = new SqlKnowledgeGraph(db);
    reopened.removeFiles(["src/B.java"]);
    assert.equal(reopened.successors("module:a", "MODULE_DEPENDS_ON").length, 0);
  } finally {
    close(db);
  }
});

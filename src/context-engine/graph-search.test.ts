import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";
import { knowledgeEdgeId } from "../java-knowledge/entity-id.js";
import { compileIntent } from "./intent-compiler.js";
import { navigateGraph, searchContextGraph } from "./graph-search.js";
import { shouldLexicalFallback } from "./lexical-fallback.js";
import { shouldEscalateToJdt } from "./semantic-escalation.js";

function seed(): KnowledgeGraphStore {
  const graph = new KnowledgeGraphStore();
  graph.upsertNode({ id: "src/A.java", kind: "FILE", generation: 1, relativePath: "src/A.java" }, "src/A.java");
  graph.upsertNode({ id: "src/A.java#A#run#1", kind: "METHOD", generation: 1, relativePath: "src/A.java" }, "src/A.java");
  graph.upsertNode({ id: "src/B.java", kind: "FILE", generation: 1, relativePath: "src/B.java" }, "src/B.java");
  graph.upsertNode({ id: "src/B.java#B#save#1", kind: "METHOD", generation: 1, relativePath: "src/B.java" }, "src/B.java");
  graph.addEdge({
    edgeId: knowledgeEdgeId({ kind: "CALLS_EXACT", fromId: "src/A.java#A#run#1", toId: "src/B.java#B#save#1" }),
    kind: "CALLS_EXACT",
    fromId: "src/A.java#A#run#1",
    toId: "src/B.java#B#save#1",
    generation: 1,
    sourceFile: "src/A.java"
  }, "src/A.java");
  return graph;
}

test("search honors maxHops and maxExpansions budgets", () => {
  const graph = seed();
  const compiled = compileIntent("IMPLEMENTATION_CHANGE");
  const hops = searchContextGraph(graph, "src/A.java", compiled, { maxHops: 0, maxExpansions: 8, tokenBudget: 8000 });
  assert.equal(hops.bundles.every(bundle => bundle.hops <= 0), true);
  const expansions = searchContextGraph(graph, "src/A.java", compiled, { maxHops: 8, maxExpansions: 1, tokenBudget: 8000 });
  assert.ok(expansions.metrics.expansions <= 1);
});

test("source-root relativePath is not emitted as a file bundle; sibling files still are", () => {
  const graph = seed();
  graph.upsertNode({ id: "root:src", kind: "SOURCE_ROOT", generation: 1, relativePath: "src" });
  graph.upsertNode({ id: "src/C.java", kind: "FILE", generation: 1, relativePath: "src/C.java" }, "src/C.java");
  graph.addEdge({
    edgeId: knowledgeEdgeId({ kind: "CONTAINS", fromId: "root:src", toId: "src/A.java" }),
    kind: "CONTAINS",
    fromId: "root:src",
    toId: "src/A.java",
    generation: 1
  }, "src/A.java");
  graph.addEdge({
    edgeId: knowledgeEdgeId({ kind: "CONTAINS", fromId: "root:src", toId: "src/C.java" }),
    kind: "CONTAINS",
    fromId: "root:src",
    toId: "src/C.java",
    generation: 1
  }, "src/C.java");
  const result = searchContextGraph(graph, "src/A.java", compileIntent("IMPLEMENTATION_CHANGE"), { maxHops: 2, maxExpansions: 32 });
  assert.equal(result.bundles.some(bundle => bundle.path === "src"), false);
  assert.ok(result.bundles.some(bundle => bundle.path === "src/C.java"));
});

test("same input yields the same bundle paths", () => {
  const graph = seed();
  const compiled = compileIntent("IMPLEMENTATION_CHANGE");
  const first = searchContextGraph(graph, "src/A.java", compiled, { maxHops: 3, maxExpansions: 32 });
  const second = searchContextGraph(graph, "src/A.java", compiled, { maxHops: 3, maxExpansions: 32 });
  assert.deepEqual(first.bundles.map(bundle => bundle.path), second.bundles.map(bundle => bundle.path));
});

test("navigate callers follows CALLED_BY and stays within two hops; wire stays under 2KiB", () => {
  const graph = seed();
  const navigated = navigateGraph(graph, "src/B.java", { direction: "callers", maxHops: 2 });
  assert.ok(navigated.bundles.some(bundle => bundle.path === "src/A.java"));
  assert.equal(navigated.bundles.every(bundle => bundle.hops <= 2), true);
  const wire = Buffer.byteLength(JSON.stringify(navigated.bundles.map(bundle => ({ path: bundle.path, hops: bundle.hops }))));
  assert.ok(wire <= 2048);
});

test("lexical fallback and JDT escalation stay off when obligations are closed or JDT is false", () => {
  const graph = seed();
  const result = searchContextGraph(graph, "src/A.java", compileIntent("DIAGNOSTIC_ONLY"), { maxHops: 1, maxExpansions: 8 });
  result.unresolved = [];
  assert.equal(shouldLexicalFallback(result, "save"), false);
  assert.equal(shouldEscalateToJdt({ unresolvedRoles: ["implementers"], jdtlsBin: "/usr/bin/false" }), false);
  assert.equal(shouldEscalateToJdt({ unresolvedRoles: ["implementers"], jdtlsBin: "/opt/jdtls" }), true);
});

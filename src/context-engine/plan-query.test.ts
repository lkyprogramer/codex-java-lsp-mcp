import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";
import { knowledgeEdgeId } from "../java-knowledge/entity-id.js";
import { compileIntent } from "./intent-compiler.js";
import { searchContextGraph } from "./graph-search.js";
import { planContextQuery } from "./plan-query.js";
import { PLANNER_VERSION, StaleSessionError, contextSessions } from "./context-contract.js";

function seed(): KnowledgeGraphStore {
  const graph = new KnowledgeGraphStore();
  graph.upsertNode({ id: "src/A.java", kind: "FILE", generation: 1, relativePath: "src/A.java" }, "src/A.java");
  graph.upsertNode({ id: "src/A.java#A#run#1", kind: "METHOD", generation: 1, relativePath: "src/A.java", simpleName: "run" }, "src/A.java");
  graph.upsertNode({ id: "src/B.java", kind: "FILE", generation: 1, relativePath: "src/B.java" }, "src/B.java");
  graph.upsertNode({ id: "src/B.java#B#save#1", kind: "METHOD", generation: 1, relativePath: "src/B.java", simpleName: "save" }, "src/B.java");
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

test("planContextQuery returns a contract without scores and fail-closes a stale session", () => {
  const graph = seed();
  const search = searchContextGraph(graph, "src/A.java", compileIntent("IMPLEMENTATION_CHANGE"), { maxHops: 2, maxExpansions: 16 });
  const contract = planContextQuery({ graph, search, tokenBudget: 400, generation: 4, serviceMs: 9 });
  assert.equal(contract.version, 1);
  assert.equal(contract.resolvedIntent, "IMPLEMENTATION_CHANGE");
  assert.ok(contract.contexts.length >= 1);
  assert.equal(JSON.stringify(contract).includes("confidence"), false);
  const session = { sessionId: "s-plan", generation: 4, repoHash: "r", plannerVersion: PLANNER_VERSION };
  const first = planContextQuery({ graph, search, tokenBudget: 400, generation: 4, session });
  contextSessions.save(session, { ...first, coverage: "COMPLETE" });
  assert.throws(
    () => planContextQuery({ graph, search, tokenBudget: 400, generation: 4, session: { ...session, generation: 9 } }),
    StaleSessionError
  );
});

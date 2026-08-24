import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeEdgeId } from "./entity-id.js";
import { KnowledgeGraphStore } from "./graph-store.js";

test("call edges materialize CALLED_BY reverse rows", () => {
  const store = new KnowledgeGraphStore();
  store.upsertNode({ id: "src/A.java#A#m#1", kind: "METHOD", generation: 1 }, "src/A.java");
  store.upsertNode({ id: "src/B.java#B#n#1", kind: "METHOD", generation: 1 }, "src/B.java");
  store.addEdge({
    edgeId: knowledgeEdgeId({ kind: "CALLS_EXACT", fromId: "src/A.java#A#m#1", toId: "src/B.java#B#n#1" }),
    kind: "CALLS_EXACT",
    fromId: "src/A.java#A#m#1",
    toId: "src/B.java#B#n#1",
    generation: 1,
    sourceFile: "src/A.java"
  }, "src/A.java");
  const reverse = store.predecessors("src/A.java#A#m#1", "CALLED_BY");
  assert.equal(reverse.length, 1);
  assert.equal(reverse[0]?.fromId, "src/B.java#B#n#1");
});

test("removeFiles drops owned edges and leaves no stale reverse row", () => {
  const store = new KnowledgeGraphStore();
  store.upsertNode({ id: "src/A.java#A#m#1", kind: "METHOD", generation: 1 }, "src/A.java");
  store.upsertNode({ id: "src/B.java#B#n#1", kind: "METHOD", generation: 1 }, "src/B.java");
  store.addEdge({
    edgeId: knowledgeEdgeId({ kind: "CALLS_EXACT", fromId: "src/A.java#A#m#1", toId: "src/B.java#B#n#1" }),
    kind: "CALLS_EXACT",
    fromId: "src/A.java#A#m#1",
    toId: "src/B.java#B#n#1",
    generation: 1,
    sourceFile: "src/A.java"
  }, "src/A.java");
  store.removeFiles(["src/A.java"]);
  assert.equal(store.edgesById.size, 0);
  assert.equal(store.predecessors("src/B.java#B#n#1").length, 0);
  assert.equal(store.nodesById.has("src/A.java#A#m#1"), false);
  assert.equal(store.nodesById.has("src/B.java#B#n#1"), true);
});

test("digest is stable for identical graphs and changes after a file is removed", () => {
  const store = new KnowledgeGraphStore();
  store.upsertNode({ id: "src/A.java", kind: "FILE", generation: 1 }, "src/A.java");
  store.upsertNode({ id: "src/B.java", kind: "FILE", generation: 1 }, "src/B.java");
  const first = store.digest();
  const second = store.digest();
  assert.equal(first, second);
  store.removeFiles(["src/A.java"]);
  assert.notEqual(store.digest(), first);
});

test("shared unowned nodes survive removing one of two contributing files", () => {
  const store = new KnowledgeGraphStore();
  store.upsertNode({ id: "repo", kind: "REPOSITORY", generation: 1 });
  store.upsertNode({ id: "module:demo", kind: "MODULE", generation: 1 });
  store.upsertNode({ id: "src/A.java", kind: "FILE", generation: 1 }, "src/A.java");
  store.upsertNode({ id: "src/B.java", kind: "FILE", generation: 1 }, "src/B.java");
  store.addEdge({
    edgeId: "e:CONTAINS:repo->module:demo:0",
    kind: "CONTAINS",
    fromId: "repo",
    toId: "module:demo",
    generation: 1
  });
  store.addEdge({
    edgeId: "e:CONTAINS:module:demo->src/A.java:0",
    kind: "CONTAINS",
    fromId: "module:demo",
    toId: "src/A.java",
    generation: 1,
    sourceFile: "src/A.java"
  }, "src/A.java");
  store.removeFiles(["src/A.java"]);
  assert.equal(store.nodesById.has("module:demo"), true);
  assert.equal(store.successors("repo", "CONTAINS").length, 1);
  assert.equal(store.nodesById.has("src/A.java"), false);
});

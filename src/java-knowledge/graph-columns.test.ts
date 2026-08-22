import assert from "node:assert/strict";
import test from "node:test";
import { StringTable } from "../java-index/columnar/string-table.js";
import { GraphEdgeColumns, GraphNodeColumns } from "./graph-columns.js";
import { KnowledgeGraphStore } from "./graph-store.js";
import { knowledgeEdgeId } from "./entity-id.js";

test("graph node columns intern ids and materialize without retaining the input object", () => {
  const columns = new GraphNodeColumns(new StringTable());
  const input = { id: "src/A.java#A", kind: "TYPE" as const, generation: 2, relativePath: "src/A.java", simpleName: "A", javaIndexId: "type:A" };
  const row = columns.upsert(input);
  input.simpleName = "mutated";
  const got = columns.materialize(row);
  assert.equal(got.simpleName, "A");
  assert.equal(got.javaIndexId, "type:A");
  assert.notEqual(got, input);
  assert.equal(columns.materialize(row), got);
  assert.equal(columns.size, 1);
});

test("graph edge columns last-write identity is the edgeId", () => {
  const columns = new GraphEdgeColumns(new StringTable());
  const first = columns.add({
    edgeId: "e:DECLARES:a->b:0",
    kind: "DECLARES",
    fromId: "a",
    toId: "b",
    generation: 1
  });
  const second = columns.add({
    edgeId: "e:DECLARES:a->b:0",
    kind: "DECLARES",
    fromId: "a",
    toId: "b",
    generation: 2
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.row, first.row);
  assert.equal(columns.size, 1);
});

test("columnar store digest matches object-store semantics for reverse call edges", () => {
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
  assert.equal(store.edgesById.size, 2);
  assert.equal(store.nodesById.get("src/A.java#A#m#1")?.kind, "METHOD");
});

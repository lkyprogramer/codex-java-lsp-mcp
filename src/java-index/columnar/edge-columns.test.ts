import assert from "node:assert/strict";
import test from "node:test";
import { EdgeColumns } from "./edge-columns.js";
import type { StaticEdge } from "../index-types.js";

function edge(overrides: Partial<StaticEdge> = {}): StaticEdge {
  return {
    edgeId: "e1",
    fromId: "from#a",
    toId: "to#b",
    kind: "CALLS",
    confidence: 0.91,
    sourceFile: "src/A.java",
    generation: 3,
    resolution: { kind: "AST_EXPLICIT", typeStrategy: "QUALIFIED" },
    range: { start: { line: 4, column: 1 }, end: { line: 4, column: 8 } },
    ...overrides
  };
}

test("EdgeColumns round-trips a StaticEdge including optional range and strategy", () => {
  const columns = new EdgeColumns();
  columns.add(edge());
  columns.add(edge({
    edgeId: "e2",
    kind: "IMPORTS",
    confidence: 1,
    range: undefined,
    resolution: { kind: "TYPE_REFERENCE" }
  }));
  assert.equal(columns.size, 2);
  assert.deepEqual(columns.materialize(columns.rowOf("e1")!), edge());
  const second = columns.materialize(columns.rowOf("e2")!);
  assert.equal(second.range, undefined);
  assert.deepEqual(second.resolution, { kind: "TYPE_REFERENCE" });
});

test("EdgeColumns remove tombstones a row and stampGeneration mutates in place", () => {
  const columns = new EdgeColumns();
  columns.add(edge());
  columns.add(edge({ edgeId: "e2" }));
  const removed = columns.remove("e1");
  assert.equal(removed?.edgeId, "e1");
  assert.equal(columns.has("e1"), false);
  assert.equal(columns.size, 1);
  const row = columns.rowOf("e2")!;
  columns.stampGeneration(row, 9);
  assert.equal(columns.materialize(row).generation, 9);
  assert.deepEqual([...columns.values()].map(item => item.edgeId), ["e2"]);
});

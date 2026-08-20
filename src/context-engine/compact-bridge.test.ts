import assert from "node:assert/strict";
import test from "node:test";
import { toCompactFromContract } from "./compact-bridge.js";
import type { ContextContract } from "./context-contract.js";

function contract(): ContextContract {
  return {
    version: 1,
    generation: 3,
    coverage: "PARTIAL",
    resolvedIntent: "IMPLEMENTATION_CHANGE",
    resolvedAnchors: [{ path: "src/A.java", symbol: "run", layer: "graph" }],
    anchor: { path: "src/A.java", symbol: "run" },
    contexts: [
      { role: "ANCHOR", path: "src/A.java", proof: ["DECLARES"], spans: [{ start: 4, end: 20 }] },
      { role: "CALLEE", path: "src/B.java", proof: ["CALLS_EXACT"], spans: [{ start: 10, end: 16 }] },
      { role: "DATAFLOW", path: "src/ghost.java", proof: [], spans: [] }
    ],
    unresolved: [{ id: "O3", role: "entity" }],
    next: [],
    cost: { modelTokens: 80, serviceMs: 12 }
  };
}

test("compact bridge emits only selected spans and never pads empty discovery paths", () => {
  const compact = toCompactFromContract(contract(), 15);
  assert.deepEqual(compact.contexts.map(item => item.path), ["src/A.java", "src/B.java"]);
  assert.equal(compact.contexts.every(item => item.spans.length > 0), true);
  assert.equal(JSON.stringify(compact).includes("ghost.java"), false);
  assert.equal(compact.semantic.completion, "COMPLETE");
  assert.equal(compact.semantic.used, false);
});

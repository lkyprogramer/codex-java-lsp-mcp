import assert from "node:assert/strict";
import test from "node:test";
import { toCompactFromContract } from "./compact-bridge.js";
import type { ContextContract } from "./context-contract.js";

function contract(): ContextContract {
  return {
    version: 3,
    generation: 3,
    coverage: "PARTIAL",
    evidence: [
      { role: "ANCHOR", path: "src/A.java", ranges: "4-20" },
      { role: "CALLEE", path: "src/B.java", ranges: "10-16" },
      { role: "DATAFLOW", path: "src/ghost.java", ranges: "" }
    ],
    candidates: [{ path: "src/A.java", role: "ANCHOR", hop: 0, reason: "ANCHOR" }],
    unresolved: [{ path: "src/A.java", role: "entity" }],
    next: [{ action: "expand", file: "src/A.java", line: 1, reason: "entity" }],
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

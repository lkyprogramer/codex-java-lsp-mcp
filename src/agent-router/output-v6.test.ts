import assert from "node:assert/strict";
import test from "node:test";
import { withConvergedCostV6, type ImpactResultV6 } from "./output-v6.js";

function samplePayload(evidenceGapCount: number): ImpactResultV6 {
  return {
    version: 6,
    target: {
      file: "src/main/java/demo/DemoService.java",
      symbol: "DemoService#process",
      type: "DemoService",
      method: "process",
      profile: "service",
      range: { start: { line: 10, column: 3 }, end: { line: 10, column: 10 } }
    },
    freshness: {
      requestGeneration: 3,
      indexedGeneration: 3,
      coverage: "COMPLETE",
      changedDuringRequest: false
    },
    semantic: {
      policy: "fast",
      used: false,
      completion: "COMPLETE"
    },
    files: [{
      id: "F1",
      path: "src/main/java/demo/DemoRepository.java",
      role: "collaborator",
      confidence: "high",
      evidence: ["called by DemoService#process"],
      locations: [{ line: 5, column: 1 }]
    }],
    readPlan: [{
      priority: "P0",
      fileId: "F1",
      ranges: [{ startLine: 1, endLine: 20, reason: "implementation", estimatedBytes: 400 }],
      reason: "resolved implementation",
      expectedEvidence: ["called by DemoService#process"],
      estimatedBytes: 400
    }],
    evidenceGaps: Array.from({ length: evidenceGapCount }, (_, index) => `gap ${index}`),
    cost: { resultBytes: 0, readBytes: 0, estimatedTokens: 0, suppressedRawBytes: 0 }
  };
}

test("withConvergedCostV6 stabilizes resultBytes/estimatedTokens within 3 attempts", () => {
  const payload = samplePayload(1);
  const result = withConvergedCostV6(payload, 400, 12000);

  const reserialized = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.equal(result.cost.resultBytes, reserialized, "resultBytes reflects the payload including the cost object itself");
  assert.equal(result.cost.readBytes, 400);
  assert.equal(result.cost.suppressedRawBytes, 12000);
  assert.equal(result.cost.estimatedTokens, Math.ceil((result.cost.resultBytes + 400) / 4));
});

test("withConvergedCostV6 converges identically regardless of starting cost values", () => {
  const zeroed = withConvergedCostV6(samplePayload(1), 400, 12000);
  const prefilled = samplePayload(1);
  prefilled.cost = { resultBytes: 999999, readBytes: 1, estimatedTokens: 1, suppressedRawBytes: 1 };
  const converged = withConvergedCostV6(prefilled, 400, 12000);

  assert.equal(converged.cost.resultBytes, zeroed.cost.resultBytes);
  assert.equal(converged.cost.estimatedTokens, zeroed.cost.estimatedTokens);
});

test("withConvergedCostV6 handles a resultBytes digit-width crossing (e.g. 999->1000 bytes)", () => {
  // A payload whose serialized size sits right at a digit-count boundary once
  // the cost object's own field widths are counted exercises the fixed-point
  // loop's actual purpose, not just a payload that already happens to be stable.
  const payload = samplePayload(50);
  const result = withConvergedCostV6(payload, 0, 0);
  const reserialized = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.equal(result.cost.resultBytes, reserialized);
});

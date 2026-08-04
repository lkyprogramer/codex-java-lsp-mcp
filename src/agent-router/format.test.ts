import assert from "node:assert/strict";
import test from "node:test";
import type { ImpactResult } from "../agent-types.js";
import { applyVerbosity } from "./format.js";

const LOMBOK_GAP = "Lombok is detected but the JDT javaagent is missing/disabled; generated members (getters/setters/builders) on types in scope may not resolve - verify with a full compile before assuming a member is absent.";

function resultWithLombokGap(): ImpactResult {
  return {
    version: 6,
    target: {
      file: "src/main/java/demo/DemoService.java",
      symbol: "DemoService#process",
      profile: "service",
      range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } }
    },
    freshness: {
      requestGeneration: 0,
      indexedGeneration: 0,
      coverage: "COMPLETE",
      changedDuringRequest: false
    },
    semantic: {
      policy: "fast",
      used: false,
      completion: "COMPLETE"
    },
    files: [],
    readPlan: [],
    evidenceGaps: [
      "Run Gradle compile/test before claiming behavior.",
      "LSP semantic enrichment was skipped by policy; raise semanticPolicy or mode if exact symbol binding is required.",
      "Review persistence/config evidence in the returned files (role=config or framework) before changing behavior.",
      LOMBOK_GAP
    ],
    cost: { resultBytes: 0, readBytes: 0, estimatedTokens: 0, suppressedRawBytes: 0 },
    metrics: {
      routingVersion: 6,
      elapsedMs: 1,
      generatedSemantics: "INCOMPLETE"
    }
  };
}

test("standard output preserves the Lombok completeness state and advisory", () => {
  const result = resultWithLombokGap();

  applyVerbosity(result, "standard");

  assert.equal(result.metrics?.generatedSemantics, "INCOMPLETE");
  assert.ok(result.evidenceGaps.some(gap => gap.includes("Lombok")));
});

test("compact output preserves a task-relevant Lombok advisory", () => {
  const result = resultWithLombokGap();

  applyVerbosity(result, "compact");

  assert.equal(result.metrics?.generatedSemantics, "INCOMPLETE");
  assert.ok(result.evidenceGaps.some(gap => gap.includes("Lombok")));
});

test("diagnostic output exposes generated semantics at the common metrics path", () => {
  const result = resultWithLombokGap();

  applyVerbosity(result, "diagnostic");

  assert.equal(result.metrics?.generatedSemantics, "INCOMPLETE");
  assert.ok(result.evidenceGaps.some(gap => gap.includes("Lombok")));
});

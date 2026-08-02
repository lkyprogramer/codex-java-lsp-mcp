import assert from "node:assert/strict";
import test from "node:test";
import type { ImpactResult } from "../agent-types.js";
import { applyVerbosity } from "./format.js";

const LOMBOK_GAP = "Lombok is detected but the JDT javaagent is missing/disabled; generated members (getters/setters/builders) on types in scope may not resolve - verify with a full compile before assuming a member is absent.";

function resultWithLombokGap(): ImpactResult {
  return {
    target: {},
    options: {},
    counts: {},
    files: [],
    readPlan: [],
    rgSummary: { sections: [], suppressed: {} },
    suppressed: {},
    evidenceGaps: [
      "Run Gradle compile/test before claiming behavior.",
      "LSP semantic enrichment was skipped by policy; raise semanticPolicy or mode if exact symbol binding is required.",
      "Review persistence/config evidence from rgSummary before changing behavior.",
      LOMBOK_GAP
    ],
    metrics: {
      routingVersion: 5,
      elapsedMs: 1,
      semantic: { skipped: true, timeout: false, policy: "fast" },
      freshness: {},
      javaIndex: {},
      framework: { generatedCode: { semantics: "INCOMPLETE", taskGapDetected: true } },
      outputBytes: 0
    }
  };
}

test("standard output preserves the Lombok completeness state and advisory", () => {
  const result = resultWithLombokGap();

  applyVerbosity(result, "standard");

  assert.equal(result.metrics.generatedSemantics, "INCOMPLETE");
  assert.ok(result.evidenceGaps.some(gap => gap.includes("Lombok")));
});

test("compact output preserves a task-relevant Lombok advisory", () => {
  const result = resultWithLombokGap();

  applyVerbosity(result, "compact");

  assert.equal(result.metrics.generatedSemantics, "INCOMPLETE");
  assert.ok(result.evidenceGaps.some(gap => gap.includes("Lombok")));
});

test("diagnostic output exposes generated semantics at the common metrics path", () => {
  const result = resultWithLombokGap();

  applyVerbosity(result, "diagnostic");

  assert.equal(result.metrics.generatedSemantics, "INCOMPLETE");
  assert.ok(result.evidenceGaps.some(gap => gap.includes("Lombok")));
});

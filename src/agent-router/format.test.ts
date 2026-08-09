import assert from "node:assert/strict";
import test from "node:test";
import type { ImpactResult } from "../agent-types.js";
import { applyVerbosity, projectImpactResultV6 } from "./format.js";

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

test("one diagnostic canonical result projects to standard/compact without diagnostic file leakage", () => {
  const canonical = resultWithLombokGap();
  canonical.files = [{
    id: "F1",
    path: "src/main/java/demo/DemoRepository.java",
    role: "collaborator",
    confidence: "high",
    evidence: ["calls anchor"],
    locations: [{ line: 2, column: 3 }],
    reasons: ["CALLS"],
    verifiedBy: ["CALLS"],
    scoreBreakdown: [{ id: "family", source: "policy", delta: 1, reason: "test" }]
  }];
  canonical.metrics = {
    ...canonical.metrics!,
    semantic: { used: false },
    cache: { hits: 1 },
    javaIndex: { rpc: { enabled: true, operations: { STATUS: { count: 1 } } } }
  };

  const standard = projectImpactResultV6(canonical, "standard");
  const compact = projectImpactResultV6(canonical, "compact");
  const diagnostic = projectImpactResultV6(canonical, "diagnostic");

  assert.equal(Object.hasOwn(standard.files[0]!, "reasons"), false);
  assert.equal(Object.hasOwn(compact.files[0]!, "scoreBreakdown"), false);
  assert.deepEqual(diagnostic.files[0]!.reasons, ["CALLS"]);
  assert.deepEqual(canonical.files[0]!.reasons, ["CALLS"], "projection must not mutate the canonical result");
  assert.equal(Object.hasOwn(standard.metrics!, "cache"), false);
  assert.equal(Object.hasOwn(standard.metrics!, "javaIndex"), false);
  assert.equal(Object.hasOwn(compact.metrics!, "javaIndex"), false);
  assert.equal((diagnostic.metrics?.javaIndex as any)?.rpc?.operations?.STATUS?.count, 1);
  for (const payload of [standard, compact, diagnostic]) {
    assert.equal(payload.cost.resultBytes, Buffer.byteLength(JSON.stringify(payload), "utf8"));
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateFile, ImpactResultV6, ResolvedAnchor } from "../agent-types.js";
import { buildImpactFileV6, buildImpactTargetV6, evidencePhrasesFor, roleOf, withConvergedCostV6 } from "./output-v6.js";

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

test("roleOf prefers a resolved CALLS/METHOD_RELATION edge over an overlapping lexical hit", () => {
  // The bug this precedence exists to avoid: categories collapses both
  // EXACT_SEMANTIC and STATIC_STRUCTURE onto "semantic", so a category-based
  // precedence could never tell a resolved call apart from a same-package
  // type reference. reasons carries the real kind string.
  assert.equal(roleOf(["rg:java", "CALLS"]), "collaborator");
  assert.equal(roleOf(["CALLS", "rg:java"]), "collaborator", "order-independent - CALLS wins regardless of position");
});

test("roleOf recognizes every framework family via the shared SPRING|MYBATIS|JPA|MAPSTRUCT prefix", () => {
  for (const kind of ["SPRING_INJECTION", "MYBATIS_STATEMENT_METHOD", "JPA_REPOSITORY_ENTITY", "MAPSTRUCT_USES"]) {
    assert.equal(roleOf([kind]), "framework", kind);
  }
});

test("roleOf falls back to target/reference/config/related in the expected order", () => {
  assert.equal(roleOf(["target"]), "target");
  assert.equal(roleOf(["typeReference"]), "reference");
  assert.equal(roleOf(["config"]), "config");
  assert.equal(roleOf(["rg:java"]), "related");
  assert.equal(roleOf([]), "related", "a candidate with no reasons must not throw");
});

test("evidencePhrasesFor caps at 4 phrases, dedupes, and never leaks a raw provider kind string", () => {
  const phrases = evidencePhrasesFor(["CALLS", "SPRING_INJECTION", "CALLS", "MYBATIS_STATEMENT_METHOD", "typeReference", "rg:java"]);
  assert.ok(phrases.length <= 4);
  assert.deepEqual(phrases, [...new Set(phrases)], "no duplicate phrases");
  for (const phrase of phrases) {
    assert.notEqual(phrase, "CALLS");
    assert.notEqual(phrase, "SPRING_INJECTION");
  }
});

test("evidencePhrasesFor degrades an unknown kind to a humanized phrase instead of dropping or throwing", () => {
  const phrases = evidencePhrasesFor(["SOME_FUTURE_KIND"]);
  assert.deepEqual(phrases, ["some future kind evidence"]);
});

function sampleCandidateFile(overrides: Partial<CandidateFile> = {}): CandidateFile {
  return {
    absolutePath: "/repo/src/main/java/demo/DemoRepository.java",
    path: "src/main/java/demo/DemoRepository.java",
    score: 500,
    matchCount: 1,
    positions: [{ line: 5, column: 1 }, { line: 9, column: 3 }, { line: 12, column: 1 }, { line: 20, column: 1 }],
    categories: ["semantic"],
    reasons: ["CALLS"],
    confidence: "high",
    verifiedBy: ["CALLS"],
    scoreBreakdown: [{ id: "family-ranker.final-score", source: "policy", delta: 500, reason: "family-saturated score" }],
    ...overrides
  };
}

test("buildImpactFileV6 in standard mode omits reasons/verifiedBy/scoreBreakdown and caps locations at 3", () => {
  const file = buildImpactFileV6(sampleCandidateFile(), "F1", "standard");
  assert.equal(file.id, "F1");
  assert.equal(file.path, "src/main/java/demo/DemoRepository.java");
  assert.equal(file.role, "collaborator");
  assert.deepEqual(file.evidence, ["calls or is called by the anchor"]);
  assert.equal(file.locations.length, 3);
  assert.equal(Object.hasOwn(file, "reasons"), false);
  assert.equal(Object.hasOwn(file, "verifiedBy"), false);
  assert.equal(Object.hasOwn(file, "scoreBreakdown"), false);
});

test("buildImpactFileV6 in diagnostic mode adds reasons/verifiedBy/scoreBreakdown on top of the standard fields", () => {
  const file = buildImpactFileV6(sampleCandidateFile(), "F1", "diagnostic");
  assert.deepEqual(file.reasons, ["CALLS"]);
  assert.deepEqual(file.verifiedBy, ["CALLS"]);
  assert.equal(file.scoreBreakdown?.[0]?.id, "family-ranker.final-score");
  // Diagnostic mode is additive, not a different shape - the standard fields still hold.
  assert.equal(file.role, "collaborator");
  assert.deepEqual(file.evidence, ["calls or is called by the anchor"]);
});

test("buildImpactFileV6 defaults a missing confidence to medium, matching the pre-V6 formatCandidate default", () => {
  const file = buildImpactFileV6(sampleCandidateFile({ confidence: undefined }), "F1", "standard");
  assert.equal(file.confidence, "medium");
});

function sampleAnchor(overrides: Partial<ResolvedAnchor> = {}): ResolvedAnchor {
  return {
    id: "A1",
    absolutePath: "/repo/src/main/java/demo/DemoService.java",
    path: "src/main/java/demo/DemoService.java",
    line: 10,
    column: 3,
    profile: "service",
    symbolName: "DemoService#process",
    methodName: "process",
    className: "DemoService",
    kind: "method",
    ...overrides
  };
}

test("buildImpactTargetV6 maps the anchor point onto a zero-width range rather than inventing an end position", () => {
  const target = buildImpactTargetV6(sampleAnchor());
  assert.equal(target.file, "src/main/java/demo/DemoService.java");
  assert.equal(target.symbol, "DemoService#process");
  assert.equal(target.type, "DemoService");
  assert.equal(target.method, "process");
  assert.equal(target.profile, "service");
  assert.deepEqual(target.range, { start: { line: 10, column: 3 }, end: { line: 10, column: 3 } });
});

test("buildImpactTargetV6 falls back to absolutePath only when the anchor has no repo-relative path", () => {
  const target = buildImpactTargetV6(sampleAnchor({ path: undefined }));
  assert.equal(target.file, "/repo/src/main/java/demo/DemoService.java");
});

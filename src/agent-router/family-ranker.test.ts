import assert from "node:assert/strict";
import test from "node:test";
import type { CandidateEvidence, EvidenceCompleteness, EvidenceFamily, EvidenceSignal } from "./evidence.js";
import { confidenceLabel, familyContribution, genericFamilyRankPolicy, rankCandidates } from "./family-ranker.js";

let nextSignalId = 0;

function signal(overrides: Partial<EvidenceSignal>): EvidenceSignal {
  nextSignalId += 1;
  return {
    signalId: `signal-${nextSignalId}`,
    candidateFile: "A.java",
    anchorId: "A1",
    kind: "REFERENCE",
    family: "STATIC_STRUCTURE",
    provenance: "AST_RESOLVED",
    confidence: 0.8,
    completeness: "COMPLETE",
    weight: 1,
    sourceFile: "A.java",
    positions: [],
    providerId: "test",
    providerVersion: "1",
    generation: 1,
    ...overrides
  };
}

function candidate(file: string, signals: EvidenceSignal[]): CandidateEvidence {
  return { file, signals, familyScores: {}, finalScore: 0, confidence: "low", degradation: [] };
}

function context(): { policy: typeof genericFamilyRankPolicy } {
  return { policy: genericFamilyRankPolicy };
}

test("three duplicate lexical providers cannot outrank one exact semantic edge", () => {
  const exact = candidate("Exact.java", [
    signal({
      family: "EXACT_SEMANTIC",
      kind: "REFERENCE",
      weight: 100,
      confidence: 1
    })
  ]);
  const duplicated = candidate("Duplicated.java", [
    signal({ family: "LEXICAL", kind: "NAME_MATCH", weight: 60, confidence: 0.7, providerId: "rg-a" }),
    signal({ family: "LEXICAL", kind: "NAME_MATCH", weight: 60, confidence: 0.7, providerId: "rg-b" }),
    signal({ family: "LEXICAL", kind: "NAME_MATCH", weight: 60, confidence: 0.7, providerId: "rg-c" })
  ]);
  const ranked = rankCandidates([duplicated, exact], context());
  assert.equal(ranked[0].file, "Exact.java");
});

test("independent structure and framework evidence can combine", () => {
  const oneFamily = candidate("One.java", [
    signal({ family: "STATIC_STRUCTURE", kind: "PARAM_TYPE", weight: 80, confidence: 0.9 })
  ]);
  const twoFamilies = candidate("Two.java", [
    signal({ family: "STATIC_STRUCTURE", kind: "PARAM_TYPE", weight: 70, confidence: 0.9 }),
    signal({ family: "FRAMEWORK", kind: "SPRING_INJECTION", weight: 65, confidence: 0.95 })
  ]);
  assert.equal(rankCandidates([oneFamily, twoFamilies], context())[0].file, "Two.java");
});

test("familyContribution ignores families with no matching signal", () => {
  const signals = [signal({ family: "LEXICAL" })];
  assert.equal(familyContribution(signals, "FRAMEWORK", genericFamilyRankPolicy), 0);
});

test("familyContribution caps at the family's ceiling regardless of weight", () => {
  const signals = [signal({ family: "STATIC_STRUCTURE", weight: 10000, confidence: 1, completeness: "COMPLETE" })];
  assert.equal(familyContribution(signals, "STATIC_STRUCTURE", genericFamilyRankPolicy), genericFamilyRankPolicy.familyCaps.STATIC_STRUCTURE);
});

test("familyContribution takes the max weighted signal, not the sum, then adds a log-scaled diversity bonus", () => {
  const single = familyContribution(
    [signal({ family: "STATIC_STRUCTURE", kind: "A", weight: 40, confidence: 1, completeness: "COMPLETE" })],
    "STATIC_STRUCTURE",
    genericFamilyRankPolicy
  );
  const twoKinds = familyContribution(
    [
      signal({ family: "STATIC_STRUCTURE", kind: "A", weight: 40, confidence: 1, completeness: "COMPLETE" }),
      signal({ family: "STATIC_STRUCTURE", kind: "B", weight: 10, confidence: 1, completeness: "COMPLETE" })
    ],
    "STATIC_STRUCTURE",
    genericFamilyRankPolicy
  );
  assert.ok(twoKinds > single, "a second independent kind must add the diversity bonus on top of the max");
  assert.equal(single, 40 + genericFamilyRankPolicy.diversityBonus.STATIC_STRUCTURE * Math.log2(2));
});

test("completeness discounts a signal's weighted contribution", () => {
  const complete = familyContribution(
    [signal({ family: "FRAMEWORK", weight: 50, confidence: 1, completeness: "COMPLETE" })],
    "FRAMEWORK",
    genericFamilyRankPolicy
  );
  const partial = familyContribution(
    [signal({ family: "FRAMEWORK", weight: 50, confidence: 1, completeness: "PARTIAL" as EvidenceCompleteness })],
    "FRAMEWORK",
    genericFamilyRankPolicy
  );
  assert.ok(partial < complete, "PARTIAL completeness must discount the contribution relative to COMPLETE");
});

test("confidenceLabel is high when exact semantic evidence clears its own threshold", () => {
  const signals = [signal({ family: "EXACT_SEMANTIC" })];
  assert.equal(confidenceLabel(signals, { EXACT_SEMANTIC: 80 }), "high");
});

test("confidenceLabel is high when complete static or framework evidence clears its threshold", () => {
  const staticSignals = [signal({ family: "STATIC_STRUCTURE", completeness: "COMPLETE" })];
  const frameworkSignals = [signal({ family: "FRAMEWORK", completeness: "COMPLETE" })];
  assert.equal(confidenceLabel(staticSignals, { STATIC_STRUCTURE: 100 }), "high");
  assert.equal(confidenceLabel(frameworkSignals, { FRAMEWORK: 100 }), "high");
});

test("confidenceLabel does not call it high when the >=100 score came only from PARTIAL/UNKNOWN evidence", () => {
  // A high-weight PARTIAL signal can still numerically clear 100 after the
  // completenessFactor discount (e.g. weight 300 * confidence 1 * 0.55 = 165,
  // capped at 130) - that must not be mislabeled high confidence. It can
  // still reach "medium" (the plan's completeness gate is on "high" only).
  const partialOnly = [signal({ family: "STATIC_STRUCTURE", completeness: "PARTIAL" as EvidenceCompleteness, weight: 300, confidence: 1 })];
  assert.equal(confidenceLabel(partialOnly, { STATIC_STRUCTURE: 130 }), "medium");
  const unknownOnly = [signal({ family: "FRAMEWORK", completeness: "UNKNOWN" as EvidenceCompleteness, weight: 300, confidence: 1 })];
  assert.equal(confidenceLabel(unknownOnly, { FRAMEWORK: 100 }), "medium");
});

test("confidenceLabel does not let lexical evidence alone reach medium or high", () => {
  const signals = [signal({ family: "LEXICAL" })];
  assert.equal(confidenceLabel(signals, { LEXICAL: 70 }), "low");
});

test("confidenceLabel is medium when non-lexical evidence sums past its threshold without clearing high", () => {
  const signals = [signal({ family: "STATIC_STRUCTURE" })];
  assert.equal(confidenceLabel(signals, { STATIC_STRUCTURE: 40, FRAMEWORK: 30 }), "medium");
});

test("rankCandidates applies a same-module prior over an equally-evidenced cross-module candidate", () => {
  const sameModule: CandidateEvidence = {
    ...candidate("Same.java", [signal({ family: "STATIC_STRUCTURE", weight: 40, confidence: 0.9 })]),
    module: "billing"
  };
  const crossModule: CandidateEvidence = {
    ...candidate("Cross.java", [signal({ family: "STATIC_STRUCTURE", weight: 40, confidence: 0.9 })]),
    module: "shipping"
  };
  const ranked = rankCandidates([crossModule, sameModule], { policy: genericFamilyRankPolicy, anchorModule: "billing" });
  assert.equal(ranked[0].file, "Same.java");
});

test("rankCandidates tie-breaks on repo path when every scored term is equal", () => {
  const a = candidate("A.java", [signal({ family: "STATIC_STRUCTURE", weight: 40, confidence: 0.9 })]);
  const z = candidate("Z.java", [signal({ family: "STATIC_STRUCTURE", weight: 40, confidence: 0.9 })]);
  const ranked = rankCandidates([z, a], context());
  assert.deepEqual(ranked.map(entry => entry.file), ["A.java", "Z.java"]);
});

test("rankCandidates does not exempt a focus-module candidate from the cross-module penalty", () => {
  // focusModules must score through TASK_CONTEXT evidence only (single
  // evidence channel) - the ranker itself must not also waive the
  // cross-module penalty for the same module, or the signal counts twice.
  const withoutFocusContext = candidate("Focused.java", [
    signal({ family: "STATIC_STRUCTURE", weight: 40, confidence: 0.9 })
  ]);
  const ranked = rankCandidates([withoutFocusContext], { policy: genericFamilyRankPolicy, anchorModule: "billing" });
  const penalized = rankCandidates(
    [{ ...withoutFocusContext, module: "reporting" }],
    { policy: genericFamilyRankPolicy, anchorModule: "billing" }
  );
  assert.ok(
    penalized[0].finalScore < ranked[0].finalScore,
    "a cross-module candidate must be penalized even if its module would otherwise be a focus module upstream"
  );
});

test("rankCandidates applies the sourceSet delta from policy", () => {
  const main: CandidateEvidence = {
    ...candidate("Main.java", [signal({ family: "STATIC_STRUCTURE", weight: 40, confidence: 0.9 })]),
    sourceSet: "main"
  };
  const generated: CandidateEvidence = {
    ...candidate("Generated.java", [signal({ family: "STATIC_STRUCTURE", weight: 40, confidence: 0.9 })]),
    sourceSet: "generated"
  };
  const ranked = rankCandidates([generated, main], context());
  assert.equal(ranked[0].file, "Main.java");
});

test("rankCandidates applies the test-defer penalty only when testReadMode is defer", () => {
  const test_: CandidateEvidence = {
    ...candidate("Some.java", [signal({ family: "STATIC_STRUCTURE", weight: 40, confidence: 0.9 })]),
    sourceSet: "test"
  };
  const deferred = rankCandidates([test_], { policy: genericFamilyRankPolicy, testReadMode: "defer" })[0];
  const included = rankCandidates([test_], { policy: genericFamilyRankPolicy, testReadMode: "include" })[0];
  assert.ok(deferred.finalScore < included.finalScore);
});

test("rankCandidates does not apply the cross-module penalty when crossModulePolicy is all", () => {
  const crossModule: CandidateEvidence = {
    ...candidate("Cross.java", [signal({ family: "STATIC_STRUCTURE", weight: 40, confidence: 0.9 })]),
    module: "shipping"
  };
  const penalized = rankCandidates([crossModule], { policy: genericFamilyRankPolicy, anchorModule: "billing" })[0];
  const allowed = rankCandidates([crossModule], { policy: genericFamilyRankPolicy, anchorModule: "billing", crossModulePolicy: "all" })[0];
  assert.ok(allowed.finalScore > penalized.finalScore);
});

test("rankCandidates tie-break level 1: higher exact-semantic contribution wins at an equal final score", () => {
  // Both land on finalScore 59 (1 base + 58 familySum): A's 58 comes entirely
  // from EXACT_SEMANTIC; B's 58 comes entirely from LEXICAL. Only the
  // tie-break chain, not score order, can pick between them.
  const exactCarriesTheScore = candidate("ExactCarries.java", [
    signal({ family: "EXACT_SEMANTIC", weight: 50, confidence: 1, completeness: "COMPLETE" })
  ]);
  const lexicalCarriesTheScore = candidate("LexicalCarries.java", [
    signal({ family: "LEXICAL", weight: 54, confidence: 1, completeness: "COMPLETE" })
  ]);
  const ranked = rankCandidates([lexicalCarriesTheScore, exactCarriesTheScore], context());
  assert.equal(ranked[0].finalScore, ranked[1].finalScore, "test setup must produce an actual tie");
  assert.equal(ranked[0].file, "ExactCarries.java");
});

test("rankCandidates tie-break level 2: higher static+framework contribution wins when exact-semantic is equal (both zero)", () => {
  // Both land on finalScore 59: A's 58 comes from STATIC_STRUCTURE, B's 58
  // from LEXICAL - neither has EXACT_SEMANTIC, so level 1 is a wash and level
  // 2 must decide.
  const structuralCarriesTheScore = candidate("StructuralCarries.java", [
    signal({ family: "STATIC_STRUCTURE", weight: 48, confidence: 1, completeness: "COMPLETE" })
  ]);
  const lexicalCarriesTheScore = candidate("LexicalCarries.java", [
    signal({ family: "LEXICAL", weight: 54, confidence: 1, completeness: "COMPLETE" })
  ]);
  const ranked = rankCandidates([lexicalCarriesTheScore, structuralCarriesTheScore], context());
  assert.equal(ranked[0].finalScore, ranked[1].finalScore, "test setup must produce an actual tie");
  assert.equal(ranked[0].file, "StructuralCarries.java");
});

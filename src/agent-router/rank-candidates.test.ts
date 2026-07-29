import assert from "node:assert/strict";
import test from "node:test";
import { foldProviderCandidates } from "./rank-candidates.js";
import type { CandidateFile } from "../agent-types.js";
import type { ProviderOutcome } from "./evidence.js";

function candidate(absolutePath: string, score: number): CandidateFile {
  return {
    absolutePath,
    path: absolutePath.slice(1),
    score,
    matchCount: 0,
    positions: [],
    categories: ["semantic"],
    reasons: ["typeReference"],
    verifiedBy: ["typeReference"],
    scoreBreakdown: []
  };
}

function outcome(overrides: Partial<ProviderOutcome>): ProviderOutcome {
  return {
    providerId: "static",
    providerVersion: "1",
    evidence: [],
    candidates: [],
    completion: "COMPLETE",
    elapsedMs: 0,
    ...overrides
  };
}

test("rank fold ignores a provider fragment without retained evidence", () => {
  const orphan = candidate("/repo/Orphan.java", 55);

  const folded = foldProviderCandidates([], [outcome({ candidates: [orphan] })]);

  assert.equal(
    folded.has(orphan.absolutePath),
    false,
    "a provider cannot nominate a scored candidate after the evidence normalizer rejected or omitted its evidence"
  );
});

test("rank fold applies one provider contribution when its evidence was deduplicated", () => {
  const duplicate = candidate("/repo/Duplicate.java", 55);
  const evidence = {
    signalId: "first",
    candidateFile: duplicate.absolutePath,
    anchorId: "A1",
    kind: "REFERENCE",
    family: "STATIC_STRUCTURE" as const,
    provenance: "AST_RESOLVED" as const,
    confidence: 0.8,
    completeness: "COMPLETE" as const,
    weight: 55,
    sourceFile: duplicate.absolutePath,
    positions: [],
    providerId: "static",
    providerVersion: "1",
    generation: 0
  };

  const folded = foldProviderCandidates([], [
    outcome({ candidates: [duplicate], evidence: [evidence] }),
    outcome({ candidates: [duplicate], evidence: [{ ...evidence, signalId: "duplicate" }] })
  ]);

  assert.equal(folded.get(duplicate.absolutePath)?.score, 55);
});

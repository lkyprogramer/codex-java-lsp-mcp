import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { ResolvedAnchor } from "../agent-types.js";
import type { CandidateEvidence, EvidenceSignal } from "./evidence.js";
import { materializeRankedCandidates } from "./materialize-candidates.js";

const repoRoot = "/repo";

let nextSignalId = 0;

function signal(overrides: Partial<EvidenceSignal>): EvidenceSignal {
  nextSignalId += 1;
  return {
    signalId: `signal-${nextSignalId}`,
    candidateFile: path.join(repoRoot, "src/main/java/com/example/Other.java"),
    anchorId: "A1",
    kind: "REFERENCE",
    family: "STATIC_STRUCTURE",
    provenance: "AST_RESOLVED",
    confidence: 0.8,
    completeness: "COMPLETE",
    weight: 40,
    sourceFile: "Other.java",
    positions: [{ line: 3, column: 1 }],
    providerId: "test",
    providerVersion: "1",
    generation: 1,
    ...overrides
  };
}

function candidateEvidence(file: string, signals: EvidenceSignal[], finalScore = 60): CandidateEvidence {
  return { file, signals, familyScores: {}, finalScore, confidence: "medium", degradation: [] };
}

function anchor(): ResolvedAnchor {
  return {
    id: "A1",
    absolutePath: path.join(repoRoot, "src/main/java/com/example/Anchor.java"),
    path: "src/main/java/com/example/Anchor.java",
    module: "example",
    line: 10,
    column: 5,
    profile: "service",
    symbolName: "Anchor",
    className: "Anchor",
    kind: "class"
  };
}

test("the anchor is always present and first, even though it earned no evidence", () => {
  const other = candidateEvidence(path.join(repoRoot, "src/main/java/com/example/Other.java"), [signal({})]);
  const result = materializeRankedCandidates([other], [anchor()], repoRoot);
  assert.equal(result[0].absolutePath, anchor().absolutePath);
  assert.equal(result[0].reasons[0], "target");
});

test("a candidate that is also the anchor path is not listed twice", () => {
  const anchorPath = anchor().absolutePath;
  const sameAsAnchor = candidateEvidence(anchorPath, [signal({ candidateFile: anchorPath })]);
  const result = materializeRankedCandidates([sameAsAnchor], [anchor()], repoRoot);
  assert.equal(result.filter(file => file.absolutePath === anchorPath).length, 1);
});

test("module/layer/sourceSet thread through from the normalized evidence entry", () => {
  const other = {
    ...candidateEvidence(path.join(repoRoot, "src/test/java/com/example/OtherTest.java"), [signal({})]),
    module: "example",
    layer: "domain",
    sourceSet: "test"
  };
  const result = materializeRankedCandidates([other], [anchor()], repoRoot);
  const materialized = result.find(file => file.absolutePath === other.file)!;
  assert.equal(materialized.module, "example");
  assert.equal(materialized.layer, "domain");
  assert.equal(materialized.sourceSet, "test");
});

test("finalScore becomes the CandidateFile score, and positions are deduplicated across signals", () => {
  const other = candidateEvidence(
    path.join(repoRoot, "src/main/java/com/example/Other.java"),
    [
      signal({ positions: [{ line: 1, column: 1 }] }),
      signal({ positions: [{ line: 1, column: 1 }] }),
      signal({ positions: [{ line: 2, column: 5 }] })
    ],
    77
  );
  const result = materializeRankedCandidates([other], [anchor()], repoRoot);
  const materialized = result.find(file => file.absolutePath === other.file)!;
  assert.equal(materialized.score, 77);
  assert.deepEqual(materialized.positions, [{ line: 1, column: 1 }, { line: 2, column: 5 }]);
});

test("an IMPLEMENTS signal produces a compatible finalize.type-relation scoreBreakdown entry", () => {
  const other = candidateEvidence(
    path.join(repoRoot, "src/main/java/com/example/Impl.java"),
    [signal({ kind: "IMPLEMENTS", weight: 70 })]
  );
  const result = materializeRankedCandidates([other], [anchor()], repoRoot);
  const materialized = result.find(file => file.absolutePath === other.file)!;
  const entry = materialized.scoreBreakdown!.find(item => item.id === "finalize.type-relation");
  assert.ok(entry, "expected a finalize.type-relation entry for an IMPLEMENTS signal");
  assert.ok(entry!.delta > 0);
});

test("a REFERENCE-only candidate does not fabricate a finalize.type-relation entry", () => {
  const other = candidateEvidence(
    path.join(repoRoot, "src/main/java/com/example/Referenced.java"),
    [signal({ kind: "REFERENCE" })]
  );
  const result = materializeRankedCandidates([other], [anchor()], repoRoot);
  const materialized = result.find(file => file.absolutePath === other.file)!;
  assert.equal(materialized.scoreBreakdown!.some(item => item.id === "finalize.type-relation"), false);
});

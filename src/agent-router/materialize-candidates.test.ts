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

test("IMPLEMENTS and TYPE_RELATION signals for the same candidate collapse to one finalize.type-relation entry at the max weight", () => {
  const other = candidateEvidence(
    path.join(repoRoot, "src/main/java/com/example/Impl.java"),
    [
      signal({ kind: "IMPLEMENTS", weight: 70 }),
      signal({ kind: "TYPE_RELATION", weight: 95 })
    ]
  );
  const result = materializeRankedCandidates([other], [anchor()], repoRoot);
  const materialized = result.find(file => file.absolutePath === other.file)!;
  const entries = materialized.scoreBreakdown!.filter(item => item.id === "finalize.type-relation");
  assert.equal(entries.length, 1, "the two discovery paths to the same relationship must not double the score");
  assert.equal(entries[0]!.delta, 95, "must take the max delta, matching the old Math.max() between the two old conditions");
});

test("relationship-provider kinds map to their compatible finalize.* scoreBreakdown ids", () => {
  const other = candidateEvidence(
    path.join(repoRoot, "src/main/java/com/example/Related.java"),
    [
      signal({ kind: "DIRECT_COLLABORATOR", weight: 170 }),
      signal({ kind: "METHOD_RELATION", weight: 160 }),
      signal({ kind: "ANNOTATION_COLLABORATION", weight: 50 }),
      signal({ kind: "PACKAGE_PROXIMITY", weight: 30 }),
      signal({ kind: "TYPE_SYMMETRIC", weight: 95 }),
      signal({ kind: "KIND_PAIRING", weight: 20 })
    ]
  );
  const result = materializeRankedCandidates([other], [anchor()], repoRoot);
  const materialized = result.find(file => file.absolutePath === other.file)!;
  const idsById = new Map(materialized.scoreBreakdown!.map(item => [item.id, item.delta]));
  assert.equal(idsById.get("finalize.direct-collaborator"), 170);
  assert.equal(idsById.get("finalize.method-relation"), 160);
  assert.equal(idsById.get("finalize.structural.annotation"), 50);
  assert.equal(idsById.get("finalize.structural.package"), 30);
  assert.equal(idsById.get("finalize.structural.type-symmetric"), 95);
  assert.equal(idsById.get("finalize.structural.kind"), 20);
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

test("lexical section categories and task-keyword utility survive materialization", () => {
  const other = candidateEvidence(
    path.join(repoRoot, "src/main/java/com/example/OrderMapper.java"),
    [
      signal({ kind: "LEXICAL:persistence", family: "LEXICAL", weight: 70 }),
      signal({ kind: "TASK_KEYWORD", family: "TASK_CONTEXT", weight: 30 })
    ]
  );
  const result = materializeRankedCandidates([other], [anchor()], repoRoot);
  const materialized = result.find(file => file.absolutePath === other.file)!;
  assert.ok(materialized.categories.includes("persistence"), "read-plan must retain the original lexical section category");
  assert.ok(materialized.reasons.includes("rg:persistence"));
  assert.ok(materialized.scoreBreakdown!.some(item => item.id === "finalize.task-keyword" && item.delta > 0));
});

test("provider candidate metadata survives materialization while the family score remains authoritative", () => {
  const file = path.join(repoRoot, "modules/report/src/main/java/com/example/ReportTask.java");
  const ranked = candidateEvidence(file, [signal({
    candidateFile: file,
    kind: "LEXICAL:java",
    family: "LEXICAL",
    weight: 56
  })], 77);
  const legacy = {
    absolutePath: file,
    path: "modules/report/src/main/java/com/example/ReportTask.java",
    module: "report",
    layer: "persistence",
    sourceSet: "main" as const,
    score: 999,
    matchCount: 4,
    positions: [{ line: 41, column: 3 }],
    categories: ["persistence"],
    reasons: ["typeReference", "rg:persistence"],
    verifiedBy: ["typeReference"]
  };

  const result = materializeRankedCandidates([ranked], [anchor()], repoRoot, new Map([[file, legacy]]));
  const materialized = result.find(item => item.absolutePath === file)!;
  assert.equal(materialized.score, 77, "ranker score must not be replaced by legacy score");
  assert.ok(materialized.categories.includes("persistence"));
  assert.ok(materialized.reasons.includes("typeReference"));
  assert.ok(materialized.verifiedBy!.includes("typeReference"));
  assert.deepEqual(materialized.positions, [{ line: 3, column: 1 }, { line: 41, column: 3 }]);
});

test("weak name support does not misclassify a Java collaborator as config", () => {
  const file = path.join(repoRoot, "src/main/java/com/example/OrderCommand.java");
  const ranked = candidateEvidence(file, [signal({
    candidateFile: file,
    kind: "DIRECT_COLLABORATOR",
    family: "SUPPORT",
    weight: 170
  })]);
  const result = materializeRankedCandidates([ranked], [anchor()], repoRoot);
  const materialized = result.find(item => item.absolutePath === file)!;
  assert.equal(materialized.categories.includes("config"), false);
});

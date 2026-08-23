import assert from "node:assert/strict";
import test from "node:test";
import {
  CANDIDATE_FRONTIER_N,
  CANDIDATE_FRONTIER_N_MAX,
  CANDIDATE_WIRE_N,
  EVIDENCE_FILE_CAP,
  capEvidenceByFile,
  candidateReason,
  candidateRole,
  formatSpanRanges,
  frontierCandidates,
  nextSteps,
  parseSpanRanges,
  wireRank
} from "./context-candidates.js";

test("formatSpanRanges merges adjacent intervals", () => {
  assert.equal(formatSpanRanges([{ start: 12, end: 48 }, { start: 60, end: 75 }]), "12-48,60-75");
  assert.equal(formatSpanRanges([{ start: 1, end: 4 }, { start: 5, end: 8 }]), "1-8");
  assert.equal(parseSpanRanges("12-48,60-75").length, 2);
  assert.ok(EVIDENCE_FILE_CAP >= 1 && EVIDENCE_FILE_CAP <= 3);
  assert.deepEqual(capEvidenceByFile([
    { path: "src/A.java" },
    { path: "src/B.java" },
    { path: "src/A.java" },
    { path: "src/C.java" },
    { path: "src/D.java" },
    { path: "src/E.java" }
  ]).map(item => item.path), ["src/A.java", "src/B.java", "src/C.java"]);
});

test("frontierCandidates is path-level, hop-ordered, and capped at N", () => {
  const rows = frontierCandidates([
    { path: "src/Far.java", hops: 3, estimatedTokens: 10, provingPath: [], closedObligations: [] },
    {
      path: "src/Pay.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT", fromId: "src/A.java#PayService#create#1", toId: "src/Pay.java#Pay#save#1" }],
      closedObligations: ["O1"]
    },
    { path: "src/A.java", hops: 0, estimatedTokens: 10, provingPath: [], closedObligations: ["O0"] },
    { path: "src/Pay.java", hops: 2, estimatedTokens: 10, provingPath: [], closedObligations: [] }
  ], 2);
  assert.equal(CANDIDATE_FRONTIER_N, 24);
  assert.equal(CANDIDATE_WIRE_N, 24);
  assert.ok(CANDIDATE_WIRE_N <= CANDIDATE_FRONTIER_N_MAX);
  assert.deepEqual(rows.map(item => item.path), ["src/A.java", "src/Pay.java"]);
  assert.equal(rows[0]!.role, "ANCHOR");
  assert.equal(rows[0]!.hop, 0);
  assert.equal(rows[1]!.role, "CALLEE");
  assert.equal(rows[1]!.hop, 1);
  assert.equal(rows[1]!.reason, "CALLS_EXACT←PayService.create");
});

test("frontierCandidates keeps hop-1 CALLS before hop-1 IMPORTS when the cap is tight", () => {
  const rows = frontierCandidates([
    { path: "src/A.java", hops: 0, estimatedTokens: 10, provingPath: [], closedObligations: ["O0"] },
    {
      path: "src/AaaConstant.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "IMPORTS", fromId: "src/A.java", toId: "src/AaaConstant.java#C" }],
      closedObligations: []
    },
    {
      path: "src/Ledger.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT", fromId: "src/A.java#A#pay#1", toId: "src/Ledger.java#Ledger" }],
      closedObligations: ["O1"]
    },
    {
      path: "src/ATest.java",
      hops: 1,
      estimatedTokens: 10,
      provingPath: [{ kind: "CALLS_EXACT", fromId: "src/ATest.java#T#run#1", toId: "src/A.java#A" }],
      closedObligations: []
    }
  ], 3);
  assert.deepEqual(rows.map(item => item.path), ["src/A.java", "src/Ledger.java", "src/AaaConstant.java"]);
  assert.ok(wireRank({
    path: "src/Ledger.java",
    hops: 1,
    provingPath: [{ kind: "CALLS_EXACT", fromId: "a", toId: "b" }]
  }) < wireRank({
    path: "src/AaaConstant.java",
    hops: 1,
    provingPath: [{ kind: "IMPORTS", fromId: "a", toId: "b" }]
  }));
});

test("candidateRole follows graph edge kinds without scores", () => {
  assert.equal(candidateRole({ hops: 0, provingPath: [] }), "ANCHOR");
  assert.equal(candidateRole({ hops: 1, provingPath: [{ kind: "CALLED_BY", fromId: "a", toId: "b" }] }), "CALLER");
  assert.equal(candidateRole({ hops: 1, provingPath: [{ kind: "MYBATIS_METHOD_BINDS_STATEMENT", fromId: "a", toId: "b" }] }), "PERSISTENCE");
  assert.equal(JSON.stringify(candidateReason({
    path: "src/A.java",
    hops: 1,
    estimatedTokens: 1,
    provingPath: [{ kind: "CALLS_EXACT", fromId: "src/A.java#PayService#create#1", toId: "x" }],
    closedObligations: []
  })).includes("score"), false);
});

test("nextSteps emit copy-pasteable navigate params for unpacked candidates", () => {
  const next = nextSteps({
    unresolved: [{ id: "entity", role: "entity" }],
    candidates: [
      { path: "src/A.java", role: "ANCHOR", hop: 0, reason: "ANCHOR" },
      { path: "src/B.java", role: "CALLEE", hop: 1, reason: "CALLS_EXACT←A.run" }
    ],
    evidence: [{ path: "src/A.java" }],
    anchorPath: "src/A.java"
  });
  assert.equal(next.length, 1);
  assert.equal(next[0]!.action, "navigate");
  assert.equal(next[0]!.file, "src/B.java");
  assert.equal(next[0]!.line, 1);
  assert.equal(next[0]!.direction, "callees");
  assert.equal(next[0]!.reason, "entity");
});

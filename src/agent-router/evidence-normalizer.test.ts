import assert from "node:assert/strict";
import test from "node:test";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import type { EvidenceCompleteness, EvidenceFamily, EvidenceSignal } from "./evidence.js";
import { normalizeEvidence } from "./evidence-normalizer.js";
import type { SourceRange } from "../java-index/index-types.js";

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
    positions: [{ line: 1, column: 1 }],
    providerId: "static",
    providerVersion: "1",
    generation: 1,
    ...overrides
  };
}

function range(startLine: number, startColumn: number, endLine: number, endColumn: number): SourceRange {
  return { start: { line: startLine, column: startColumn }, end: { line: endLine, column: endColumn } };
}

test("normalizer deduplicates the same underlying evidence", () => {
  const duplicate = signal({
    candidateFile: "A.java",
    kind: "IMPLEMENTS",
    providerId: "static",
    sourceFile: "A.java",
    sourceRange: range(2, 1, 2, 20)
  });
  const result = normalizeEvidence([duplicate, { ...duplicate, signalId: "other" }]);
  assert.equal(result.get("A.java")!.signals.length, 1);
});

test("normalizer preserves independent evidence families", () => {
  const result = normalizeEvidence([
    signal({ candidateFile: "A.java", family: "STATIC_STRUCTURE", kind: "IMPLEMENTS" }),
    signal({ candidateFile: "A.java", family: "EXACT_SEMANTIC", kind: "REFERENCE" })
  ]);
  assert.equal(result.get("A.java")!.signals.length, 2);
});

test("normalizer groups signals by candidate file", () => {
  const result = normalizeEvidence([
    signal({ candidateFile: "A.java" }),
    signal({ candidateFile: "B.java" })
  ]);
  assert.equal(result.size, 2);
  assert.ok(result.has("A.java"));
  assert.ok(result.has("B.java"));
});

test("duplicate identity keeps the signal with higher confidence", () => {
  const low = signal({ candidateFile: "A.java", kind: "IMPLEMENTS", confidence: 0.4, signalId: "low" });
  const high = signal({ candidateFile: "A.java", kind: "IMPLEMENTS", confidence: 0.9, signalId: "high" });
  const result = normalizeEvidence([low, high]);
  const kept = result.get("A.java")!.signals;
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.signalId, "high");
});

test("duplicate identity with equal confidence keeps COMPLETE over PARTIAL over UNKNOWN", () => {
  const partial = signal({ candidateFile: "A.java", kind: "IMPLEMENTS", confidence: 0.7, completeness: "PARTIAL" as EvidenceCompleteness, signalId: "partial" });
  const complete = signal({ candidateFile: "A.java", kind: "IMPLEMENTS", confidence: 0.7, completeness: "COMPLETE" as EvidenceCompleteness, signalId: "complete" });
  const unknown = signal({ candidateFile: "A.java", kind: "IMPLEMENTS", confidence: 0.7, completeness: "UNKNOWN" as EvidenceCompleteness, signalId: "unknown" });
  const result = normalizeEvidence([partial, unknown, complete]);
  assert.equal(result.get("A.java")!.signals[0]!.signalId, "complete");
});

test("duplicate identity with equal confidence and completeness keeps higher weight", () => {
  const lightweight = signal({ candidateFile: "A.java", kind: "IMPLEMENTS", weight: 1, signalId: "lightweight" });
  const heavyweight = signal({ candidateFile: "A.java", kind: "IMPLEMENTS", weight: 5, signalId: "heavyweight" });
  const result = normalizeEvidence([lightweight, heavyweight]);
  assert.equal(result.get("A.java")!.signals[0]!.signalId, "heavyweight");
});

test("duplicate identity fully tied breaks deterministically on the lower signalId", () => {
  const a = signal({ candidateFile: "A.java", kind: "IMPLEMENTS", signalId: "b-signal" });
  const b = signal({ candidateFile: "A.java", kind: "IMPLEMENTS", signalId: "a-signal" });
  const result = normalizeEvidence([a, b]);
  assert.equal(result.get("A.java")!.signals[0]!.signalId, "a-signal");
});

test("a different sourceRange is a different identity even for the same kind and file", () => {
  const first = signal({ candidateFile: "A.java", kind: "CALLS", sourceRange: range(1, 1, 1, 5) });
  const second = signal({ candidateFile: "A.java", kind: "CALLS", sourceRange: range(9, 1, 9, 5) });
  const result = normalizeEvidence([first, second]);
  assert.equal(result.get("A.java")!.signals.length, 2);
});

test("out-of-range confidence throws INVALID_INPUT instead of silently clamping", () => {
  assert.throws(
    () => normalizeEvidence([signal({ confidence: 1.5 })]),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "INVALID_INPUT"
  );
});

test("NaN confidence throws INVALID_INPUT instead of silently becoming zero", () => {
  assert.throws(
    () => normalizeEvidence([signal({ confidence: Number.NaN })]),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "INVALID_INPUT"
  );
});

test("an unknown completeness value throws INVALID_INPUT", () => {
  assert.throws(
    () => normalizeEvidence([signal({ completeness: "BOGUS" as unknown as EvidenceCompleteness })]),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "INVALID_INPUT"
  );
});

test("a negative weight throws INVALID_INPUT", () => {
  assert.throws(
    () => normalizeEvidence([signal({ weight: -1 })]),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "INVALID_INPUT"
  );
});

test("normalized entries start unscored, leaving ranking to a later stage", () => {
  const result = normalizeEvidence([signal({ candidateFile: "A.java" })]);
  const entry = result.get("A.java")!;
  assert.deepEqual(entry.familyScores, {});
  assert.equal(entry.finalScore, 0);
  assert.deepEqual(entry.degradation, []);
});

test("family is preserved on the kept signal for later per-family scoring", () => {
  const result = normalizeEvidence([
    signal({ candidateFile: "A.java", family: "FRAMEWORK" as EvidenceFamily, kind: "SPRING_BEAN" })
  ]);
  assert.equal(result.get("A.java")!.signals[0]!.family, "FRAMEWORK");
});

import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceSignal, ProviderOutcome } from "./evidence.js";
import { EvidenceLedger } from "./evidence-ledger.js";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";

function signal(signalId: string, candidateFile: string, confidence = 0.8): EvidenceSignal {
  return {
    signalId,
    candidateFile,
    anchorId: "A1",
    kind: "REFERENCE",
    family: "STATIC_STRUCTURE",
    provenance: "AST_RESOLVED",
    confidence,
    completeness: "COMPLETE",
    weight: 1,
    sourceFile: "/repo/A.java",
    positions: [],
    providerId: "test",
    providerVersion: "1",
    generation: 1
  };
}

function outcome(providerId: string, evidence: EvidenceSignal[]): ProviderOutcome {
  return { providerId, providerVersion: "1", evidence, completion: "COMPLETE", elapsedMs: 0 };
}

test("ledger preserves first-seen path and provider order", () => {
  const ledger = new EvidenceLedger("/repo", ["/repo/A.java", "/repo/A.java"]);
  const first = outcome("first", [signal("first-b", "/repo/B.java"), signal("first-a", "/repo/A.java")]);
  const second = outcome("second", [signal("second-c", "/repo/C.java")]);

  ledger.append(first);
  ledger.append(second);

  assert.deepEqual(ledger.paths(), ["/repo/A.java", "/repo/B.java", "/repo/C.java"]);
  assert.deepEqual(ledger.outcomes().map(item => item.providerId), ["first", "second"]);
});

test("normalized evidence is memoized until any append invalidates it", () => {
  const ledger = new EvidenceLedger("/repo", []);
  ledger.append(outcome("first", [signal("first", "/repo/A.java")]));

  const first = ledger.normalized();
  assert.equal(ledger.normalized(), first);

  ledger.append(outcome("empty", []));
  const afterEmpty = ledger.normalized();
  assert.notEqual(afterEmpty, first);
  assert.deepEqual([...afterEmpty.keys()], ["/repo/A.java"]);
});

test("append stays lazy and invalid evidence fails only when normalized", () => {
  const ledger = new EvidenceLedger("/repo", []);
  assert.doesNotThrow(() => ledger.append(outcome("invalid", [signal("bad", "/repo/A.java", 2)])));
  assert.throws(
    () => ledger.normalized(),
    (error: unknown) => error instanceof JavaIntelligenceError && error.code === "INVALID_INPUT"
  );
});

test("ledgers never share request-local state", () => {
  const left = new EvidenceLedger("/repo", ["/repo/A.java"]);
  const right = new EvidenceLedger("/repo", ["/repo/A.java"]);
  left.append(outcome("left", [signal("left", "/repo/B.java")]));

  assert.deepEqual(left.paths(), ["/repo/A.java", "/repo/B.java"]);
  assert.deepEqual(right.paths(), ["/repo/A.java"]);
  assert.deepEqual(right.outcomes(), []);
  assert.equal(right.normalized().size, 0);
});

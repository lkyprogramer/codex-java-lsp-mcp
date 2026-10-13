import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_TESTS, acceptJdtEvidence, loadEvidenceGate, testEvidence } from "./run-release-contracts.mjs";

const tap = (result, directive = "") => `# Subtest: K01: real contract\n${result} 1 - K01: real contract${directive}\n`;
test("release runner requires a selected passing behavior, not exit zero or a file wrapper", () => {
  const run = stdout => ({ stdout, stderr: "", exitCode: 0, timedOut: false });
  assert.equal(testEvidence(run(tap("ok")), "^K01:").status, "PASS");
  for (const output of ["", "ok 1 - /tmp/file.test.js\n", tap("not ok"), tap("ok", " # SKIP"), tap("ok", " # TODO"), tap("ok").replaceAll("K01", "K02")]) {
    assert.equal(testEvidence(run(output), "^K01:").status, "FAIL");
  }
  assert.equal(testEvidence({ ...run(tap("ok")), timedOut: true }, "^K01:").status, "FAIL");
  assert.equal(testEvidence({ ...run(tap("ok")), exitCode: 1 }, "^K01:").status, "FAIL");
});

test("release load gate preserves the frozen SLO and all scheduled samples", () => {
  const step = concurrency => ({ concurrency, requests: 100, settled: true, worker: { queuePeak: concurrency - 1 }, latencyMs: { p95: 80 }, eventLoopDelayMs: { p95: 3 } });
  const report = { steps: [step(1), step(5), step(20)], withUpdates: step(20) };
  assert.equal(loadEvidenceGate(report).status, "PASS");
  assert.equal(loadEvidenceGate({ steps: [] }).status, "FAIL");
  assert.equal(loadEvidenceGate({ ...report, steps: [step(1)] }).status, "FAIL");
  for (const change of [{ requests: 0 }, { settled: false }, { latencyMs: { p95: 151 } }, { eventLoopDelayMs: { p95: 21 } }, { worker: { queuePeak: 33 } }]) {
    assert.equal(loadEvidenceGate({ ...report, withUpdates: { ...step(20), ...change } }).status, "FAIL");
  }
});

test("release JDT gate rejects a different candidate and unmeasured PASS labels", () => {
  const identity = { sourceDigest: "a".repeat(64) };
  const evidence = { shortCode: "DEADLINE_EXCEEDED", backendCalls: 1, whileShortExited: { inflight: 1, sharedJoins: 1, abortedNoWaiters: 0 }, longOutcome: { completion: "COMPLETE" }, settled: { inflight: 0, completeWrites: 1, abortedNoWaiters: 0 } };
  const payload = { candidateIdentity: identity, K28: { status: "PASS", evidence } };
  assert.equal(acceptJdtEvidence(payload, identity, "K28").status, "PASS");
  assert.equal(acceptJdtEvidence(payload, { sourceDigest: "b" }, "K28").status, "FAIL");
  assert.equal(acceptJdtEvidence({ ...payload, K28: { status: "PASS", evidence: {} } }, identity, "K28").status, "FAIL");
  assert.equal(acceptJdtEvidence({ ...payload, K26: { status: "PASS", evidence: {} } }, identity, "K26").status, "FAIL");
  assert.equal(acceptJdtEvidence(payload, identity, "K26").status, "FAIL");
});

test("release runner covers all 32 contracts through tests or explicit real runtime handlers", () => {
  const ids = [...Object.keys(CONTRACT_TESTS), "K26", "K28", "K29"].sort();
  assert.deepEqual(ids, Array.from({ length: 32 }, (_, i) => "K" + String(i + 1).padStart(2, "0")));
});

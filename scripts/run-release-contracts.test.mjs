import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_TESTS, K29_REQUEST_PROTOCOL, acceptJdtEvidence, contractOutcome, loadEvidenceGate, testEvidence } from "./run-release-contracts.mjs";
import { REQUEST_LOAD_PROTOCOL } from "../dist/benchmark/measure-request-load.js";

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
  const step = concurrency => ({ concurrency, requests: 100, settled: true, errors: 0, previews: 300, publishes: 0,
    worker: { queuePeak: concurrency - 1, submits: 200, pids: [101, 102] }, latencyMs: { p95: 80 }, eventLoopDelayMs: { p95: 3 } });
  const report = { protocol: K29_REQUEST_PROTOCOL, steps: [step(1), step(5), step(20)], withUpdates: { ...step(20), publishes: 2 } };
  assert.equal(loadEvidenceGate(report).status, "PASS");
  assert.equal(loadEvidenceGate({ steps: [] }).status, "FAIL");
  assert.equal(loadEvidenceGate({ ...report, steps: [step(1)] }).status, "FAIL");
  for (const change of [{ requests: 0 }, { settled: false }, { latencyMs: { p95: 151 } }, { eventLoopDelayMs: { p95: 21 } }, { worker: { queuePeak: 33, submits: 200, pids: [1] } }]) {
    assert.equal(loadEvidenceGate({ ...report, withUpdates: { ...report.withUpdates, ...change } }).status, "FAIL");
  }
});

test("release load gate accepts only the request-path driver with the pool, previews and a publish under load", () => {
  const step = concurrency => ({ concurrency, requests: 100, settled: true, errors: 0, previews: 300, publishes: 0,
    worker: { queuePeak: 3, submits: 200, pids: [101] }, latencyMs: { p95: 40 }, eventLoopDelayMs: { p95: 2 } });
  const report = { protocol: K29_REQUEST_PROTOCOL, steps: [step(1), step(5), step(20)], withUpdates: { ...step(20), publishes: 1 } };
  assert.equal(K29_REQUEST_PROTOCOL, REQUEST_LOAD_PROTOCOL, "runner and driver share one protocol");
  assert.equal(loadEvidenceGate(report).requestPathPass, true);
  // The retired in-process SQL driver met the SLO but never passed the request view or the pool.
  const retired = { ...report, protocol: "p3-capacity-v1" };
  assert.deepEqual([loadEvidenceGate(retired).status, loadEvidenceGate(retired).requestPathPass, loadEvidenceGate(retired).performancePass], ["FAIL", false, true]);
  for (const change of [{ errors: 1 }, { previews: 0 }, { worker: { queuePeak: 3, submits: 99, pids: [101] } }, { worker: { queuePeak: 3, submits: 200, pids: [] } }]) {
    assert.equal(loadEvidenceGate({ ...report, steps: [step(1), step(5), { ...step(20), ...change }] }).status, "FAIL", JSON.stringify(change));
  }
  assert.equal(loadEvidenceGate({ ...report, withUpdates: { ...report.withUpdates, publishes: 0 } }).status, "FAIL", "no publish landed under load");
});

test("a selected-only run exits on its selected contracts and never claims the full K set", () => {
  const rows = Array.from({ length: 32 }, (_, i) => ({ id: "K" + String(i + 1).padStart(2, "0"), status: "NOT_RUN" }));
  const withK29 = status => rows.map(row => row.id === "K29" ? { ...row, status } : row);
  const pass = contractOutcome(withK29("PASS"), ["K29"]);
  assert.equal(pass.exitCode, 0);
  assert.deepEqual(pass.summary, { PASS: 1, FAIL: 0, BLOCKED_ENV: 0, NOT_RUN: 31, selection: "selected", selected: ["K29"], selectedPass: true, allContractsPass: false });
  assert.equal(contractOutcome(withK29("FAIL"), ["K29"]).exitCode, 1);
  assert.equal(contractOutcome(withK29("BLOCKED_ENV"), ["K29"]).exitCode, 1);
  assert.equal(contractOutcome(withK29("PASS"), ["K29"], true).exitCode, 1, "candidate drift fails the run");
  assert.equal(contractOutcome(rows, []).exitCode, 1, "nothing selected is not a pass");
  const all = rows.map(row => ({ ...row, status: "PASS" }));
  const ids = all.map(row => row.id);
  assert.deepEqual([contractOutcome(all, ids).exitCode, contractOutcome(all, ids).summary.allContractsPass, contractOutcome(all, ids).summary.selection], [0, true, "all"]);
  const oneMissing = all.map(row => row.id === "K26" ? { ...row, status: "BLOCKED_ENV" } : row);
  assert.deepEqual([contractOutcome(oneMissing, ids).exitCode, contractOutcome(oneMissing, ids).summary.allContractsPass], [1, false]);
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

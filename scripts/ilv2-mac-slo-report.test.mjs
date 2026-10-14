import test from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION } from "./ilv2-mac-contracts.mjs";
import { evaluateOracle, percentile, summarize, validatePlan } from "./ilv2-mac-slo-report.mjs";

function plan() {
  return { contractVersion: CONTRACT_VERSION, concurrency: 2, slots: Array.from({ length: 20 }, (_, index) => ({
    id: `s${index}`, operation: "query", window: "normal", workspaceId: "fixture-w1", deadlineMs: 100, stopAfterMs: 300, atMs: index,
    expected: { workspaceId: "fixture-w1", sourceHash: "fixture-source-hash", match: { token: "fresh-token" } }
  })), slos: [{ id: "query", window: "normal", metric: "elapsedMs", percentile: 0.95, minSamples: 20, limitMs: 20 }] };
}
function samples() {
  return plan().slots.map((slot, index) => ({ kind: "slot", sampleId: `sample-${index}`, slotId: slot.id, operation: slot.operation,
    window: slot.window, workspaceId: slot.workspaceId, startedAt: "2026-10-13T00:00:00Z", startMonoNs: "1000000000",
    endMonoNs: String(1000000000 + (index + 1) * 1000000), elapsedMs: index + 1, maxAttemptMs: index + 1, status: "PASS",
    response: { status: "OK", workspaceId: "fixture-w1", sourceHash: "fixture-source-hash", snapshotId: "snapshot-1", token: "fresh-token" } }));
}
test("nearest-rank uses the complete planned denominator", () => {
  assert.equal(percentile(Array.from({ length: 20 }, (_, index) => index + 1), 0.95), 19);
  const result = summarize(plan(), samples());
  assert.equal(result.status, "PASS");
  assert.equal(result.metrics[0].n, 20);
  assert.equal(result.metrics[0].p95, 19);
});
for (const [name, mutate] of [
  ["missing slot", calls => calls.pop()],
  ["duplicate slot", calls => calls.push({ ...calls[0], sampleId: "extra" })],
  ["duplicate sample", calls => { calls[1].sampleId = calls[0].sampleId; }],
  ["wrong source hash", calls => { calls[0].response.sourceHash = "wrong"; }],
  ["wrong workspace", calls => { calls[0].response.workspaceId = "wrong"; }],
  ["timeout", calls => { calls[0].status = "FAIL"; calls[0].response = undefined; }],
  ["forged wall time", calls => { calls[0].elapsedMs = 0; }],
  ["late deadline", calls => { calls[0].maxAttemptMs = 1200; }],
  ["missing deadline evidence", calls => { delete calls[0].maxAttemptMs; }],
  ["fault relabel", calls => { calls[0].window = "fault"; }]
]) test(`${name} cannot pass`, () => {
  const calls = samples(); mutate(calls);
  assert.equal(summarize(plan(), calls).status, "FAIL");
});
test("failed and right-censored samples are not replaced with zero", () => {
  const calls = samples(); calls[0].status = "FAIL";
  const result = summarize(plan(), calls);
  assert.equal(result.metrics[0].n, 19);
  assert.equal(result.metrics[0].expected, 20);
  assert.equal(result.metrics[0].status, "FAIL");
});
test("query correctness requires content, snapshot, workspace and hash", () => {
  const call = samples()[0];
  assert.equal(evaluateOracle(call.response, plan().slots[0].expected), true);
  assert.equal(evaluateOracle({ ...call.response, status: "NOT_READY" }, plan().slots[0].expected), false);
  assert.equal(evaluateOracle({ ...call.response, token: "old-token" }, plan().slots[0].expected), false);
  assert.equal(evaluateOracle({ ...call.response, snapshotId: null }, plan().slots[0].expected), false);
});
test("invalid plans and reporting windows do not drop required samples", () => {
  const duplicate = plan(); duplicate.slots[1].id = duplicate.slots[0].id;
  assert.throws(() => validatePlan(duplicate), /duplicate/);
  const slowPoll = plan(); slowPoll.slots[0].pollMs = 10000;
  assert.throws(() => validatePlan(slowPoll), /polling/);
  assert.equal(summarize(plan(), samples(), { since: Date.parse("2026-10-14") }).status, "FAIL");
});

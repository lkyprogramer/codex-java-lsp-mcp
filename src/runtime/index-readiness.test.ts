import assert from "node:assert/strict";
import test from "node:test";
import { describeIndexPreparation, IndexNotReadyError, withIndexReadiness } from "./index-readiness.js";
import { JavaIntelligenceError } from "./intelligence-error.js";

test("index preparation distinguishes an unstarted repo, active round, retry and unavailable owner", () => {
  assert.deepEqual(describeIndexPreparation(), { state: "NOT_STARTED" });
  assert.deepEqual(describeIndexPreparation({ roundInFlight: true }), { state: "BUILDING" });
  assert.deepEqual(describeIndexPreparation({ roundInFlight: false }), { state: "SCHEDULED" });
  assert.deepEqual(describeIndexPreparation({ roundInFlight: false, lastError: "capture failed", retryInMs: 300000 }),
    { state: "RETRYING", lastError: "capture failed", retryInMs: 300000 });
  assert.deepEqual(describeIndexPreparation({ roundInFlight: true, lastError: "previous failure" }),
    { state: "BUILDING", lastError: "previous failure" });
  assert.deepEqual(describeIndexPreparation(undefined, "owner unavailable"),
    { state: "UNAVAILABLE", lastError: "owner unavailable" });
});

test("cold-index recovery names the exact Unicode repo and the static readiness condition", () => {
  const root = "/repos/试卷 worktree";
  const cause = new JavaIntelligenceError("INDEX_PARTIAL", "no snapshot");
  const error = new IndexNotReadyError(root, { state: "BUILDING" }, cause);
  assert.equal(error.code, "INDEX_PARTIAL");
  assert.equal(error.cause, cause);
  assert.equal(error.recovery.status, "INDEX_NOT_READY");
  assert.equal(error.recovery.retryable, true);
  assert.equal(error.recovery.retryAfterMs, 1000);
  assert.deepEqual(error.recovery.nextAction, { tool: "java_status", arguments: { repoRoot: root, start: false } });
  assert.match(error.recovery.instructions, /indexView\.snapshotId/);
  assert.match(error.recovery.instructions, /FRESH or STALE/);
  assert.match(error.recovery.instructions, /original/);
  assert.match(error.recovery.instructions, /native search/);
});

test("retry guidance respects the existing backoff, including zero and the retry upper boundary", () => {
  for (const retryInMs of [0, 999, 1000, 300000, 300001]) {
    const error = new IndexNotReadyError("/repo", { state: "RETRYING", retryInMs }, new Error("capture failed"));
    assert.equal(error.recovery.retryAfterMs, Math.max(1000, retryInMs));
  }
});

test("unavailable and unstarted indexes do not invite endless status polling", () => {
  const unavailable = new IndexNotReadyError("/repo", { state: "UNAVAILABLE" }, new Error("owner failed"));
  assert.equal(unavailable.recovery.retryable, false);
  assert.equal(unavailable.recovery.retryAfterMs, undefined);
  assert.match(unavailable.recovery.instructions, /unavailable/);
  const unstarted = new IndexNotReadyError("/repo", { state: "NOT_STARTED" }, new Error("not started"));
  assert.equal(unstarted.recovery.retryable, false);
  assert.match(unstarted.recovery.instructions, /does not start/);
});

test("the request boundary reports a cold build and preserves cancellation, deadlines and non-readiness failures", async () => {
  const context = { repoRoot: "/repos/试卷", indexView: { state: "NOT_READY" as const }, indexPreparation: { state: "BUILDING" as const } };
  const partial = new JavaIntelligenceError("INDEX_PARTIAL", "no snapshot");
  await assert.rejects(withIndexReadiness(context, () => Promise.reject(partial)), error => {
    assert.ok(error instanceof IndexNotReadyError);
    assert.equal(error.cause, partial);
    assert.equal(error.recovery.preparation.state, "BUILDING");
    return true;
  });
  for (const code of ["CANCELLED", "DEADLINE_EXCEEDED", "INDEX_CORRUPT"] as const) {
    const failure = new JavaIntelligenceError(code, code);
    await assert.rejects(withIndexReadiness(context, () => Promise.reject(failure)), error => error === failure);
  }
  await assert.rejects(withIndexReadiness({ ...context, indexView: { state: "STALE" } }, () => Promise.reject(partial)), error => error === partial);
  assert.equal(await withIndexReadiness(context, () => Promise.resolve("result")), "result");
});

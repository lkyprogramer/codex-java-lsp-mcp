import assert from "node:assert/strict";
import test from "node:test";
import {
  COLD_BUILD_STALL_MS,
  coldBuildRetryDelayMs,
  coldBuildStallExceeded,
  parseColdBuildStdoutLine,
  inProcessParseDecision,
  resolveClosedColdBuild,
  resolveStalledColdBuild
} from "./cold-build-watch.js";

test("progress lines are not treated as the result payload", () => {
  assert.deepEqual(
    parseColdBuildStdoutLine(JSON.stringify({ type: "progress", phase: "parse", files: 40 })),
    { kind: "progress", phase: "parse", files: 40 }
  );
  assert.equal(parseColdBuildStdoutLine(JSON.stringify({ ok: true, files: 10 })).kind, "result");
  assert.equal(parseColdBuildStdoutLine("not-json").kind, "ignore");
});

test("stall is 120s without progress, not an absolute timeout", () => {
  const started = 1_000_000;
  assert.equal(coldBuildStallExceeded(started, started + 119_999), false);
  assert.equal(coldBuildStallExceeded(started, started + COLD_BUILD_STALL_MS), true);
  assert.equal(COLD_BUILD_STALL_MS, 120_000);
});

test("a stalled child with a complete snapshot is success", () => {
  assert.equal(resolveStalledColdBuild(true), "success");
  assert.equal(resolveStalledColdBuild(false), "failure");
});

test("nonzero exit with a complete snapshot is success", () => {
  assert.equal(resolveClosedColdBuild(null, true), "success");
  assert.equal(resolveClosedColdBuild(1, true), "success");
  assert.equal(resolveClosedColdBuild(1, false), "failure");
  assert.equal(resolveClosedColdBuild(0, false), "success");
});

test("retries back off exponentially", () => {
  assert.equal(coldBuildRetryDelayMs(0), 1000);
  assert.equal(coldBuildRetryDelayMs(1), 2000);
  assert.equal(coldBuildRetryDelayMs(2), 4000);
});

test("true failure does not in-process parse above 500 files", () => {
  assert.equal(inProcessParseDecision(501), "skip");
  assert.equal(inProcessParseDecision(500), "recycle");
  assert.equal(inProcessParseDecision(199), "ok");
});

import assert from "node:assert/strict";
import test from "node:test";
import { IdlePrewarmTracker, idlePrewarmTracker } from "./impact-metrics.js";

test("prewarm-then-query increments delay and queried count on the shipped tracker", () => {
  const tracker = new IdlePrewarmTracker();
  tracker.recordPrewarm("s1", 1_000);
  tracker.recordFirstSemanticRequest("s1", 1_250);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.prewarmedSessions, 1);
  assert.equal(snapshot.queriedAfterPrewarm, 1);
  assert.equal(snapshot.neverQueried, 0);
  assert.deepEqual(snapshot.firstSemanticDelayMs, [250]);
  assert.equal(snapshot.neverQueriedFraction, 0);
});

test("prewarm-never-query increments the unused fraction", () => {
  const tracker = new IdlePrewarmTracker();
  tracker.recordPrewarm("warm", 1_000);
  tracker.recordPrewarm("idle", 1_000);
  tracker.recordFirstSemanticRequest("warm", 1_400);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.prewarmedSessions, 2);
  assert.equal(snapshot.queriedAfterPrewarm, 1);
  assert.equal(snapshot.neverQueried, 1);
  assert.equal(snapshot.neverQueriedFraction, 0.5);
  assert.deepEqual(snapshot.firstSemanticDelayMs, [400]);
});

test("the shipped impact-metrics singleton records a prewarm-then-query sequence", () => {
  idlePrewarmTracker.reset();
  idlePrewarmTracker.recordPrewarm("runtime-a", 10);
  idlePrewarmTracker.recordFirstSemanticRequest("runtime-a", 40);
  const snapshot = idlePrewarmTracker.snapshot();
  assert.equal(snapshot.prewarmedSessions, 1);
  assert.deepEqual(snapshot.firstSemanticDelayMs, [30]);
  idlePrewarmTracker.reset();
});

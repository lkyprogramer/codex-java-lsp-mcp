import assert from "node:assert/strict";
import test from "node:test";
import { JdtRestartBackoff } from "./jdt-restart-backoff.js";

test("retryable JDT failures back off and explicit reset clears the gate", () => {
  let now = 1_000;
  const backoff = new JdtRestartBackoff(() => now);

  backoff.recordFailure("JDT_SERVER_ERROR");
  assert.deepEqual(backoff.check(), {
    allowed: false,
    retryAfterMs: 500,
    blockedUntilExplicitReset: false
  });

  now += 499;
  assert.equal(backoff.check().allowed, false);
  now += 1;
  assert.equal(backoff.check().allowed, true);

  backoff.recordFailure("JDT_SERVER_ERROR");
  assert.equal(backoff.status().consecutiveFailures, 2);
  assert.equal(backoff.status().retryAfterMs, 1_000);

  backoff.reset();
  assert.equal(backoff.check().allowed, true);
});

test("JDT configuration failures require explicit reset", () => {
  const backoff = new JdtRestartBackoff(() => 10_000);
  backoff.recordFailure("JDT_CONFIG_ERROR");
  assert.equal(backoff.check().blockedUntilExplicitReset, true);
  assert.equal(backoff.check().allowed, false);
  backoff.reset();
  assert.equal(backoff.check().allowed, true);
});

test("caller deadlines and cancellation do not poison restart backoff", () => {
  const backoff = new JdtRestartBackoff(() => 10_000);
  backoff.recordFailure("DEADLINE_EXCEEDED");
  backoff.recordFailure("CANCELLED");
  assert.equal(backoff.status().consecutiveFailures, 0);
  assert.equal(backoff.check().allowed, true);
});

test("READY does not reset failures until the stability window completes", () => {
  const backoff = new JdtRestartBackoff(() => 10_000);
  backoff.recordFailure("JDT_SERVER_ERROR");
  backoff.recordReadyStarted();
  assert.equal(backoff.status().consecutiveFailures, 1);
  backoff.recordReadyStable();
  assert.equal(backoff.status().consecutiveFailures, 0);
});

test("backoff delay grows exponentially and is capped at 30 seconds", () => {
  let now = 0;
  const backoff = new JdtRestartBackoff(() => now);
  const delays: number[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    backoff.recordFailure("JDT_BROKEN");
    delays.push(backoff.status().retryAfterMs ?? 0);
  }
  assert.deepEqual(delays, [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  assert.equal(backoff.status().lastErrorCode, "JDT_BROKEN");
});

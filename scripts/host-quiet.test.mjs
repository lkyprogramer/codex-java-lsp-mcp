import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MIN_AVAILABLE_BYTES,
  assertHostQuiet,
  evaluateHostQuiet,
  inspectHostQuiet
} from "./host-quiet.mjs";

const fourGiB = 4 * 1024 * 1024 * 1024;
const thirtyTwoGiB = 32 * 1024 * 1024 * 1024;

test("host gate ignores load and passes when available memory meets the floor", () => {
  const noisy = evaluateHostQuiet({
    loadavg1: 36,
    logicalCpus: 10,
    availableBytes: fourGiB,
    totalBytes: thirtyTwoGiB,
    minAvailableBytes: fourGiB
  });
  assert.equal(noisy.perCpu, 3.6);
  assert.equal(noisy.passed, true);
  assert.equal(noisy.memory.availableBytes, fourGiB);
});

test("host gate fails only when available memory is below the floor", () => {
  const tight = evaluateHostQuiet({
    loadavg1: 1,
    logicalCpus: 10,
    availableBytes: fourGiB - 1,
    totalBytes: thirtyTwoGiB,
    minAvailableBytes: fourGiB
  });
  assert.equal(tight.passed, false);
});

test("assertHostQuiet throws a refusal that names the memory floor, not load", () => {
  assert.throws(
    () => assertHostQuiet({
      loadavg1: 30,
      logicalCpus: 10,
      availableBytes: 1024,
      totalBytes: thirtyTwoGiB,
      minAvailableBytes: fourGiB
    }),
    /available memory 0.0 GiB is below the 4.0 GiB floor/
  );
  const ready = assertHostQuiet({
    loadavg1: 30,
    logicalCpus: 10,
    availableBytes: fourGiB,
    totalBytes: thirtyTwoGiB,
    minAvailableBytes: fourGiB
  });
  assert.equal(ready.passed, true);
});

test("inspectHostQuiet reports live load and memory without inventing a pass", () => {
  const live = inspectHostQuiet();
  assert.equal(typeof live.loadavg1, "number");
  assert.ok(live.logicalCpus > 0);
  assert.equal(typeof live.memory.availableBytes, "number");
  assert.equal(live.memory.minAvailableBytes, DEFAULT_MIN_AVAILABLE_BYTES);
  assert.equal(live.passed, live.memory.availableBytes >= live.memory.minAvailableBytes);
});

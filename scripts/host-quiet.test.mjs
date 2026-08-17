import assert from "node:assert/strict";
import test from "node:test";
import { assertHostQuiet, evaluateHostQuiet, inspectHostQuiet } from "./host-quiet.mjs";

test("quiet-host gate passes at the 0.7 boundary and fails just above it", () => {
  const passing = evaluateHostQuiet({ loadavg1: 7, logicalCpus: 10, maxLoadavgPerCpu: 0.7 });
  assert.equal(passing.perCpu, 0.7);
  assert.equal(passing.passed, true);

  const failing = evaluateHostQuiet({ loadavg1: 7.1, logicalCpus: 10, maxLoadavgPerCpu: 0.7 });
  assert.equal(failing.passed, false);
  assert.ok(failing.perCpu > 0.7);
});

test("assertHostQuiet throws a refusal that names the measured ratio", () => {
  assert.throws(
    () => assertHostQuiet({ loadavg1: 30, logicalCpus: 10 }),
    /refusing to start: 1-minute load average 30.00 is 3.00x/
  );
  const quiet = assertHostQuiet({ loadavg1: 1, logicalCpus: 10 });
  assert.equal(quiet.passed, true);
});

test("inspectHostQuiet reports the live host without inventing a pass", () => {
  const live = inspectHostQuiet();
  assert.equal(typeof live.loadavg1, "number");
  assert.ok(live.logicalCpus > 0);
  assert.equal(live.passed, live.perCpu <= live.maxLoadavgPerCpu);
});

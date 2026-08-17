#!/usr/bin/env node
// input: Optional 1-minute load average, logical CPU count, and per-CPU threshold.
// output: A comparable quiet-host verdict used by first-touch / storm / Sprint0' runners.
// pos: Shared load gate for V4 measurements; 1-minute load / logical CPUs must be <= 0.7.
import os from "node:os";

export const DEFAULT_MAX_LOADAVG_PER_CPU = 0.7;

export function evaluateHostQuiet({
  loadavg1,
  logicalCpus,
  maxLoadavgPerCpu = DEFAULT_MAX_LOADAVG_PER_CPU
} = {}) {
  if (!(Number.isFinite(loadavg1) && loadavg1 >= 0)) {
    throw new Error("loadavg1 must be a non-negative finite number");
  }
  if (!(Number.isInteger(logicalCpus) && logicalCpus > 0)) {
    throw new Error("logicalCpus must be a positive integer");
  }
  if (!(Number.isFinite(maxLoadavgPerCpu) && maxLoadavgPerCpu > 0)) {
    throw new Error("maxLoadavgPerCpu must be a positive finite number");
  }
  const perCpu = loadavg1 / logicalCpus;
  return {
    loadavg1,
    logicalCpus,
    perCpu,
    maxLoadavgPerCpu,
    passed: perCpu <= maxLoadavgPerCpu
  };
}

export function inspectHostQuiet({
  maxLoadavgPerCpu = DEFAULT_MAX_LOADAVG_PER_CPU,
  loadavg1 = os.loadavg()[0],
  logicalCpus = os.cpus().length
} = {}) {
  return evaluateHostQuiet({ loadavg1, logicalCpus, maxLoadavgPerCpu });
}

export function assertHostQuiet(options = {}) {
  const verdict = inspectHostQuiet(options);
  if (!verdict.passed) {
    throw new Error(
      `refusing to start: 1-minute load average ${verdict.loadavg1.toFixed(2)} is ${verdict.perCpu.toFixed(2)}x `
      + `logical CPU count (${verdict.logicalCpus}); this measurement requires a quiet host `
      + `(<=${verdict.maxLoadavgPerCpu}x) to produce a comparison worth trusting.`
    );
  }
  return verdict;
}

#!/usr/bin/env node
// input: Optional load sample plus available-memory floor.
// output: A host-readiness verdict. Three-repo tests proceed when 1-minute
// load is below 20; load is never a refuse gate. Memory remains the hard gate.
// pos: Shared start gate for V4 measurements. Do not revive per-CPU 0.7 refusals.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";

export const DEFAULT_MAX_LOADAVG_PER_CPU = 1.2;
export const DEFAULT_MIN_AVAILABLE_BYTES = 4 * 1024 * 1024 * 1024;
/** 1-minute loadavg below this is the expected three-repo operating window. Never refuse a run for load. */
export const THREE_REPO_LOADAVG_PROCEED_BELOW = 20;
/** Real JDT first-touch / prewarm suggested window: load < logicalCpus * this factor. Not a three-repo refuse gate. */
export const JDT_EXPERIMENT_LOAD_PER_CPU = 1.5;

export function jdtExperimentLoadDecision(loadavg1, logicalCpus, perCpu = JDT_EXPERIMENT_LOAD_PER_CPU) {
  if (!(Number.isFinite(loadavg1) && loadavg1 >= 0)) {
    throw new Error("loadavg1 must be a non-negative finite number");
  }
  if (!(Number.isInteger(logicalCpus) && logicalCpus > 0)) {
    throw new Error("logicalCpus must be a positive integer");
  }
  const proceedBelow = logicalCpus * perCpu;
  return {
    loadavg1,
    logicalCpus,
    proceedBelow,
    belowThreshold: loadavg1 < proceedBelow,
    refuse: false
  };
}

export function evaluateHostQuiet({
  loadavg1,
  logicalCpus,
  maxLoadavgPerCpu = DEFAULT_MAX_LOADAVG_PER_CPU,
  availableBytes,
  totalBytes,
  minAvailableBytes = DEFAULT_MIN_AVAILABLE_BYTES
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
  if (!(Number.isFinite(availableBytes) && availableBytes >= 0)) {
    throw new Error("availableBytes must be a non-negative finite number");
  }
  if (!(Number.isFinite(totalBytes) && totalBytes > 0)) {
    throw new Error("totalBytes must be a positive finite number");
  }
  if (!(Number.isFinite(minAvailableBytes) && minAvailableBytes > 0)) {
    throw new Error("minAvailableBytes must be a positive finite number");
  }
  const load = threeRepoLoadDecision(loadavg1);
  return {
    loadavg1,
    logicalCpus,
    perCpu: loadavg1 / logicalCpus,
    maxLoadavgPerCpu,
    loadPolicy: load,
    memory: {
      totalBytes,
      availableBytes,
      minAvailableBytes
    },
    passed: availableBytes >= minAvailableBytes
  };
}

/**
 * Three-repo cold matrix policy: load < 20 means the run must start.
 * load >= 20 is recorded as above-window, but still must not refuse.
 */
export function threeRepoLoadDecision(loadavg1, proceedBelow = THREE_REPO_LOADAVG_PROCEED_BELOW) {
  if (!(Number.isFinite(loadavg1) && loadavg1 >= 0)) {
    throw new Error("loadavg1 must be a non-negative finite number");
  }
  if (!(Number.isFinite(proceedBelow) && proceedBelow > 0)) {
    throw new Error("proceedBelow must be a positive finite number");
  }
  return {
    loadavg1,
    proceedBelow,
    belowThreshold: loadavg1 < proceedBelow,
    refuse: false
  };
}

export function inspectHostMemory({
  availableBytes = readAvailableMemoryBytes(),
  totalBytes = os.totalmem(),
  minAvailableBytes = minAvailableBytesFromEnv()
} = {}) {
  return {
    totalBytes,
    availableBytes,
    minAvailableBytes
  };
}

export function inspectHostQuiet({
  maxLoadavgPerCpu = DEFAULT_MAX_LOADAVG_PER_CPU,
  loadavg1 = os.loadavg()[0],
  logicalCpus = os.cpus().length,
  ...memoryOptions
} = {}) {
  const memory = inspectHostMemory(memoryOptions);
  return evaluateHostQuiet({
    loadavg1,
    logicalCpus,
    maxLoadavgPerCpu,
    ...memory
  });
}

export function assertHostQuiet(options = {}) {
  const verdict = inspectHostQuiet(options);
  if (!verdict.passed) {
    throw new Error(
      `refusing to start: available memory ${formatGiB(verdict.memory.availableBytes)} is below the `
      + `${formatGiB(verdict.memory.minAvailableBytes)} floor needed for isolated JDT + Gradle `
      + `(three-repo load policy: proceed when load < ${THREE_REPO_LOADAVG_PROCEED_BELOW}; `
      + `observed ${verdict.loadavg1.toFixed(2)} is recorded, never a refuse gate).`
    );
  }
  return verdict;
}

export function readAvailableMemoryBytes() {
  if (process.platform === "darwin") return readDarwinAvailableBytes();
  if (process.platform === "linux") return readLinuxAvailableBytes();
  return os.freemem();
}

function minAvailableBytesFromEnv(env = process.env) {
  const raw = env.JAVA_LSP_MIN_AVAILABLE_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MIN_AVAILABLE_BYTES;
  const parsed = Number(raw);
  if (!(Number.isFinite(parsed) && parsed > 0)) {
    throw new Error("JAVA_LSP_MIN_AVAILABLE_BYTES must be a positive finite number");
  }
  return parsed;
}

function readDarwinAvailableBytes() {
  const text = execFileSync("vm_stat", { encoding: "utf8" });
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
  const pages = ["Pages free", "Pages speculative", "Pages inactive", "Pages purgeable"]
    .reduce((sum, name) => sum + pageCount(text, name), 0);
  return pages * pageSize;
}

function readLinuxAvailableBytes() {
  if (!existsSync("/proc/meminfo")) return os.freemem();
  const kb = Number(readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m)?.[1]);
  return Number.isFinite(kb) ? kb * 1024 : os.freemem();
}

function pageCount(text, name) {
  return Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
}

function formatGiB(bytes) {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

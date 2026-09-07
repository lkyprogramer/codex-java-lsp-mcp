// Task36 Step6a final lease smoke. This script launches independent Node OS
// processes and coordinates them with IPC barriers and explicit releases; it
// never substitutes in-process stores for the multiprocess gate.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectedSubtests } from "./task36-tap-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const workerScript = path.join(here, "task36-multiprocess-worker.mjs");
const JDT_SLOTS = 2;
const SWEEP_SLOTS = 2;
const WORKER_TIMEOUT_MS = 5_000;
const ISOLATED_TEST_TIMEOUT_MS = 30_000;

let nextRequestId = 1;
let workerProcessCount = 0;
let liveWorkerCount = 0;
let maxConcurrentWorkers = 0;
const workerPids = [];
const allWorkers = new Set();

class WorkerClient {
  constructor(leaseRoot, workerId) {
    this.workerId = workerId;
    this.pending = new Map();
    this.stderr = "";
    this.exitInfo = undefined;
    this.child = spawn(process.execPath, [workerScript], {
      env: {
        ...process.env,
        TASK36_LEASE_ROOT: leaseRoot,
        TASK36_JDT_SLOTS: String(JDT_SLOTS),
        TASK36_SWEEP_SLOTS: String(SWEEP_SLOTS),
        TASK36_WORKER_ID: workerId
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    workerProcessCount += 1;
    liveWorkerCount += 1;
    maxConcurrentWorkers = Math.max(maxConcurrentWorkers, liveWorkerCount);

    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.exited = new Promise(resolve => {
      this.resolveExit = resolve;
    });

    this.child.stderr.on("data", chunk => { this.stderr += chunk; });
    this.child.on("message", message => this.onMessage(message));
    this.child.once("error", error => {
      this.rejectReady(error);
      this.rejectPending(error);
    });
    this.child.once("exit", (code, signal) => {
      liveWorkerCount -= 1;
      this.exitInfo = { code, signal };
      const error = new Error(
        `${this.workerId} exited before completing IPC (code=${String(code)}, signal=${String(signal)}): ${this.stderr}`
      );
      this.rejectReady(error);
      this.rejectPending(error);
      this.resolveExit(this.exitInfo);
    });
  }

  onMessage(message) {
    if (message?.type === "ready") {
      this.pid = message.pid;
      workerPids.push(message.pid);
      this.resolveReady(message);
      return;
    }
    if (message?.type !== "response") return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(new Error(`${this.workerId}: ${message.error}`));
    else pending.resolve(message.result);
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async waitUntilReady() {
    return await withSafetyTimeout(this.ready, WORKER_TIMEOUT_MS, `${this.workerId} readiness`);
  }

  request(op, fields = {}) {
    if (this.exitInfo) {
      return Promise.reject(new Error(`${this.workerId} already exited`));
    }
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${this.workerId} did not answer ${op} within ${WORKER_TIMEOUT_MS}ms`));
      }, WORKER_TIMEOUT_MS);
      timeout.unref?.();
      this.pending.set(requestId, { resolve, reject, timeout });
      this.child.send({ requestId, op, ...fields }, error => {
        if (!error) return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async crashWithoutRelease() {
    if (this.exitInfo) return this.exitInfo;
    this.child.send({ op: "crash-without-release" });
    const exit = await withSafetyTimeout(this.exited, WORKER_TIMEOUT_MS, `${this.workerId} crash`);
    if (exit.code !== 86) {
      throw new Error(`${this.workerId} dead-owner fixture exited with unexpected code ${String(exit.code)}`);
    }
    return exit;
  }

  async shutdown() {
    if (this.exitInfo) return;
    try {
      await this.request("shutdown");
    } catch {
      if (!this.exitInfo) this.child.kill("SIGKILL");
    }
    await withSafetyTimeout(this.exited, WORKER_TIMEOUT_MS, `${this.workerId} shutdown`);
  }
}

function withSafetyTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    timeout.unref?.();
    promise.then(
      value => {
        clearTimeout(timeout);
        resolve(value);
      },
      error => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

async function startWorker(leaseRoot, workerId) {
  const worker = new WorkerClient(leaseRoot, workerId);
  allWorkers.add(worker);
  await worker.waitUntilReady();
  return worker;
}

async function withLeaseRoot(prefix, run) {
  const leaseRoot = await mkdtemp(path.join(tmpdir(), prefix));
  const scenarioWorkers = new Set();
  const spawnScenarioWorker = async workerId => {
    const worker = await startWorker(leaseRoot, workerId);
    scenarioWorkers.add(worker);
    return worker;
  };
  try {
    return await run(spawnScenarioWorker);
  } finally {
    await Promise.allSettled([...scenarioWorkers].map(worker => worker.shutdown()));
    await rm(leaseRoot, { recursive: true, force: true });
  }
}

async function machineJdtSlotsCase() {
  return await withLeaseRoot("task36-jdt-cap-", async start => {
    const [first, second, contender] = await Promise.all([
      start("jdt-holder-a"),
      start("jdt-holder-b"),
      start("jdt-contender")
    ]);
    const holderResults = await Promise.all([
      first.request("try-jdt", { repoHash: "jdt-a" }),
      second.request("try-jdt", { repoHash: "jdt-b" })
    ]);
    const status = await first.request("status");
    const contenderResult = await contender.request("try-jdt", { repoHash: "jdt-c" });
    const acquiredCount = holderResults.filter(result => result.kind === "ACQUIRED").length;
    const deniedCount = contenderResult.kind === "NO_GLOBAL_SLOT" ? 1 : 0;
    await Promise.all([
      first.request("release-jdt"),
      second.request("release-jdt"),
      contenderResult.kind === "ACQUIRED" ? contender.request("release-jdt") : Promise.resolve()
    ]);
    return {
      execution: "subprocess",
      configuredMax: status.configuredJdtSlots,
      observedMax: status.claimedJdtSlots,
      acquiredCount,
      deniedCount,
      gate: status.configuredJdtSlots === JDT_SLOTS
        && status.claimedJdtSlots === JDT_SLOTS
        && acquiredCount === JDT_SLOTS
        && deniedCount === 1
        ? "PASS"
        : "FAIL"
    };
  });
}

async function sameWorktreeJdtCase() {
  return await withLeaseRoot("task36-jdt-same-", async start => {
    const [owner, contender] = await Promise.all([
      start("same-worktree-owner"),
      start("same-worktree-contender")
    ]);
    const ownerResult = await owner.request("try-jdt", { repoHash: "same-worktree" });
    const secondResult = await contender.request("try-jdt", { repoHash: "same-worktree" });
    const duplicateCount = secondResult.kind === "ACQUIRED" ? 1 : 0;
    await Promise.all([
      ownerResult.kind === "ACQUIRED" ? owner.request("release-jdt") : Promise.resolve(),
      secondResult.kind === "ACQUIRED" ? contender.request("release-jdt") : Promise.resolve()
    ]);
    return {
      execution: "subprocess",
      secondAttempt: secondResult.kind,
      duplicateCount,
      gate: ownerResult.kind === "ACQUIRED"
        && secondResult.kind === "BUSY_SAME_WORKTREE"
        && duplicateCount === 0
        ? "PASS"
        : "FAIL"
    };
  });
}

async function machineSweepSlotsCase() {
  return await withLeaseRoot("task36-sweep-cap-", async start => {
    const [first, second, contender] = await Promise.all([
      start("sweep-holder-a"),
      start("sweep-holder-b"),
      start("sweep-contender")
    ]);
    const holderResults = await Promise.all([
      first.request("acquire-sweep", { repoHash: "sweep-a", timeoutMs: 1_000 }),
      second.request("acquire-sweep", { repoHash: "sweep-b", timeoutMs: 1_000 })
    ]);
    const status = await first.request("status");
    const contenderResult = await contender.request("acquire-sweep", {
      repoHash: "sweep-c",
      timeoutMs: 150
    });
    if (contenderResult.kind === "SWEEP_SLOT") await contender.request("release-sweep");
    await Promise.all([
      first.request("release-sweep"),
      second.request("release-sweep")
    ]);
    const afterRelease = await contender.request("acquire-sweep", {
      repoHash: "sweep-c",
      timeoutMs: 1_000
    });
    const acquiredAfterRelease = afterRelease.kind === "SWEEP_SLOT";
    if (acquiredAfterRelease) await contender.request("release-sweep");
    return {
      execution: "subprocess",
      configuredMax: status.configuredSweepSlots,
      observedMax: status.claimedSweepSlots,
      contenderResult: contenderResult.kind,
      acquiredAfterRelease,
      gate: status.configuredSweepSlots === SWEEP_SLOTS
        && status.claimedSweepSlots === SWEEP_SLOTS
        && holderResults.every(result => result.kind === "SWEEP_SLOT")
        && contenderResult.kind === "DEADLINE_EXCEEDED"
        && acquiredAfterRelease
        ? "PASS"
        : "FAIL"
    };
  });
}

async function reclaimAndLivePidCase() {
  return await withLeaseRoot("task36-reclaim-", async start => {
    const deadOwner = await start("dead-owner");
    const deadOwnerAcquire = await deadOwner.request("try-jdt", { repoHash: "reclaim-worktree" });
    await deadOwner.crashWithoutRelease();

    const reclaimer = await start("dead-owner-reclaimer");
    const deadOwnerResult = await reclaimer.request("try-jdt", { repoHash: "reclaim-worktree" });
    const reclaimStatus = await reclaimer.request("status");
    if (deadOwnerResult.kind === "ACQUIRED") await reclaimer.request("release-jdt");
    await reclaimer.shutdown();

    const liveOwner = await start("live-owner");
    const liveOwnerAcquire = await liveOwner.request("try-jdt", { repoHash: "live-worktree" });
    const liveContender = await start("live-owner-contender");
    const liveOwnerAttempt = await liveContender.request("try-jdt", { repoHash: "live-worktree" });
    const livePidStolen = liveOwnerAttempt.kind === "ACQUIRED";
    await Promise.all([
      liveOwnerAcquire.kind === "ACQUIRED" ? liveOwner.request("release-jdt") : Promise.resolve(),
      livePidStolen ? liveContender.request("release-jdt") : Promise.resolve()
    ]);

    const deadLeaseReclaimed = deadOwnerAcquire.kind === "ACQUIRED"
      && deadOwnerResult.kind === "ACQUIRED"
      && reclaimStatus.staleLeaseReclaims >= 1;
    return {
      execution: "subprocess",
      deadOwnerResult: deadOwnerResult.kind,
      deadLeaseReclaimed,
      staleLeaseReclaims: reclaimStatus.staleLeaseReclaims,
      liveOwnerAttempt: liveOwnerAttempt.kind,
      livePidStolen,
      gate: deadLeaseReclaimed
        && liveOwnerAcquire.kind === "ACQUIRED"
        && liveOwnerAttempt.kind === "BUSY_SAME_WORKTREE"
        && !livePidStolen
        ? "PASS"
        : "FAIL"
    };
  });
}

async function isolatedBehaviorCases() {
  const definitions = {
    fast_only_cache_janitor: {
      files: ["dist/worktree-cache-cleanup.test.js"],
      pattern: "^janitor does not delete a stale-looking cache whose ownerToken matches a live fast-only runtime$",
      expectedSelectedTestCount: 1,
      references: ["src/worktree-cache-cleanup.test.ts: fast-only runtime ownerToken janitor protection"]
    },
    linked_worktree_ignore: {
      files: ["dist/repo-change-coordinator.test.js", "dist/worktree-storm.test.js"],
      pattern: "^(a linked-worktree \\.git file and common-dir are ignored|linked-worktree git metadata never advances Java generation, even under a large burst)$",
      expectedSelectedTestCount: 2,
      references: ["src/repo-change-coordinator.test.ts", "src/worktree-storm.test.ts"]
    },
    storm_foreground_anchor: {
      files: ["dist/worktree-storm.test.js"],
      pattern: "^a 500-file batch is delivered as one storm with a bounded, non-empty affectedRoots list, and marks the generation dirty$",
      expectedSelectedTestCount: 1,
      references: ["src/worktree-storm.test.ts"]
    },
    snapshot_generation_rebase: {
      files: ["dist/repo-generation.test.js"],
      pattern: "^generation advances monotonically and dirty clear is compare-and-set$",
      expectedSelectedTestCount: 1,
      references: ["src/repo-generation.test.ts"]
    }
  };
  const entries = [];
  // These cases validate independent behavior contracts; the process-level
  // concurrency/slot bounds are exercised above. Running six Node test trees
  // at once makes their 30s safety timeout measure host contention after the
  // full dist suite instead of the behavior under test.
  for (const [name, definition] of Object.entries(definitions)) {
    entries.push([name, await runIsolatedBehaviorCase(definition)]);
  }
  return Object.fromEntries(entries);
}

async function runIsolatedBehaviorCase(definition) {
  const args = ["--test", `--test-name-pattern=${definition.pattern}`, ...definition.files];
  const result = await spawnAndCapture(process.execPath, args, ISOLATED_TEST_TIMEOUT_MS);
  const output = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
  const failed = tapCount(output, "fail") ?? 0;
  const passed = tapCount(output, "pass") ?? 0;
  const selectedTests = selectedSubtests(output, definition.pattern);
  const selectedTestNames = selectedTests.map(test => test.name);
  return {
    execution: "subprocess_test",
    references: definition.references,
    command: process.execPath,
    args,
    exitCode: result.exitCode,
    signal: result.signal,
    testCount: tapCount(output, "tests") ?? passed,
    passedTestCount: passed,
    failedTestCount: failed,
    expectedSelectedTestCount: definition.expectedSelectedTestCount,
    selectedTestCount: selectedTests.length,
    selectedTestNames,
    selectedTestResults: selectedTests,
    timedOut: result.timedOut,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
    gate: result.exitCode === 0
      && result.signal === null
      && !result.timedOut
      && selectedTests.length === definition.expectedSelectedTestCount
      && selectedTests.every(test => test.status === "passed" && test.directive === undefined)
      && failed === 0
      ? "PASS"
      : "FAIL"
  };
}

function spawnAndCapture(command, args, timeoutMs) {
  return new Promise(resolve => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const detached = process.platform !== "win32";
    const child = spawn(command, args, { cwd: repoRoot, env, detached, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let spawnError;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, "SIGKILL");
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", error => { spawnError = error; });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (spawnError) stderr.push(Buffer.from(`${spawnError.message}\n`));
      resolve({ exitCode, signal, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function terminateProcessTree(child, signal) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process group may already be gone; try the direct child below.
    }
  }
  child.kill(signal);
}

function tapCount(output, label) {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)\\r?$`, "gm"))];
  return matches.length > 0 ? Number(matches.at(-1)[1]) : undefined;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function runSmoke() {
  const isolatedCases = await isolatedBehaviorCases();
  const cases = {
    machine_jdt_slots: await machineJdtSlotsCase(),
    same_worktree_jdt: await sameWorktreeJdtCase(),
    machine_sweep_slots: await machineSweepSlotsCase(),
    dead_lease_reclaim_live_pid_non_steal: await reclaimAndLivePidCase(),
    ...isolatedCases
  };
  const subprocessCases = [
    cases.machine_jdt_slots,
    cases.same_worktree_jdt,
    cases.machine_sweep_slots,
    cases.dead_lease_reclaim_live_pid_non_steal
  ];
  const subprocessGate = subprocessCases.every(item => item.gate === "PASS") ? "PASS" : "FAIL";
  const isolatedBehaviorGate = Object.values(isolatedCases).every(item => item.gate === "PASS") ? "PASS" : "FAIL";
  return {
    schemaVersion: 1,
    suite: "task36-step6a-multiprocess",
    configuredMax: { jdt: JDT_SLOTS, sweep: SWEEP_SLOTS },
    observedMax: {
      jdt: cases.machine_jdt_slots.observedMax,
      sweep: cases.machine_sweep_slots.observedMax
    },
    duplicateCount: { sameWorktreeJdt: cases.same_worktree_jdt.duplicateCount },
    reclaim: {
      deadLeaseReclaimed: cases.dead_lease_reclaim_live_pid_non_steal.deadLeaseReclaimed,
      staleLeaseReclaims: cases.dead_lease_reclaim_live_pid_non_steal.staleLeaseReclaims,
      livePidStolen: cases.dead_lease_reclaim_live_pid_non_steal.livePidStolen
    },
    cases,
    evidence: {
      parentPid: process.pid,
      workerProcessCount,
      maxConcurrentWorkers,
      workerPids
    },
    gate: {
      subprocessCases: subprocessGate,
      isolatedBehaviorCases: isolatedBehaviorGate,
      task36Step6a: subprocessGate === "PASS" && isolatedBehaviorGate === "PASS" ? "PASS" : "FAIL"
    }
  };
}

let report;
try {
  report = await runSmoke();
} catch (error) {
  report = {
    schemaVersion: 1,
    suite: "task36-step6a-multiprocess",
    error: error instanceof Error ? error.message : String(error),
    evidence: { parentPid: process.pid, workerProcessCount, maxConcurrentWorkers, workerPids },
    gate: { subprocessCases: "FAIL", isolatedBehaviorCases: "FAIL", task36Step6a: "FAIL" }
  };
} finally {
  await Promise.allSettled([...allWorkers].map(worker => worker.shutdown()));
}

process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = report.gate.task36Step6a === "PASS" ? 0 : 1;

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const smokeScript = path.join(here, "task36-multiprocess-smoke.mjs");

function runSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smokeScript], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      if (pid && process.platform !== "win32") {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      reject(new Error("Task36 multiprocess smoke exceeded 60 seconds"));
    }, 60_000);
    timeout.unref?.();

    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, pid });
    });
  });
}

test("Task36 Step6a smoke enforces process lease caps and executes every isolated behavior gate", async () => {
  const execution = await runSmoke();
  assert.equal(execution.code, 0, execution.stderr || execution.stdout);
  assert.equal(execution.signal, null);

  const report = JSON.parse(execution.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.suite, "task36-step6a-multiprocess");
  assert.deepEqual(report.configuredMax, { jdt: 2, sweep: 2 });
  assert.deepEqual(report.observedMax, { jdt: 2, sweep: 2 });
  assert.deepEqual(report.duplicateCount, { sameWorktreeJdt: 0 });
  assert.equal(report.reclaim.deadLeaseReclaimed, true);
  assert.ok(report.reclaim.staleLeaseReclaims >= 1);
  assert.equal(report.reclaim.livePidStolen, false);

  assert.deepEqual(report.cases.machine_jdt_slots, {
    execution: "subprocess",
    configuredMax: 2,
    observedMax: 2,
    acquiredCount: 2,
    deniedCount: 1,
    gate: "PASS"
  });
  assert.deepEqual(report.cases.same_worktree_jdt, {
    execution: "subprocess",
    secondAttempt: "BUSY_SAME_WORKTREE",
    duplicateCount: 0,
    gate: "PASS"
  });
  assert.deepEqual(report.cases.machine_sweep_slots, {
    execution: "subprocess",
    configuredMax: 2,
    observedMax: 2,
    contenderResult: "DEADLINE_EXCEEDED",
    acquiredAfterRelease: true,
    gate: "PASS"
  });
  assert.equal(report.cases.dead_lease_reclaim_live_pid_non_steal.execution, "subprocess");
  assert.equal(report.cases.dead_lease_reclaim_live_pid_non_steal.deadOwnerResult, "ACQUIRED");
  assert.equal(report.cases.dead_lease_reclaim_live_pid_non_steal.deadLeaseReclaimed, true);
  assert.ok(report.cases.dead_lease_reclaim_live_pid_non_steal.staleLeaseReclaims >= 1);
  assert.equal(report.cases.dead_lease_reclaim_live_pid_non_steal.liveOwnerAttempt, "BUSY_SAME_WORKTREE");
  assert.equal(report.cases.dead_lease_reclaim_live_pid_non_steal.livePidStolen, false);
  assert.equal(report.cases.dead_lease_reclaim_live_pid_non_steal.gate, "PASS");

  const unitBackedCases = [
    "fast_only_cache_janitor",
    "linked_worktree_ignore",
    "storm_foreground_anchor",
    "snapshot_generation_rebase",
    "sibling_seed_cases",
    "seed_reconcile_equivalence"
  ];
  for (const name of unitBackedCases) {
    assert.equal(report.cases[name].execution, "subprocess_test");
    assert.equal(report.cases[name].gate, "PASS");
    assert.equal(report.cases[name].exitCode, 0);
    assert.ok(report.cases[name].testCount >= 1);
    assert.equal(report.cases[name].selectedTestCount, report.cases[name].expectedSelectedTestCount);
    assert.equal(report.cases[name].selectedTestNames.length, report.cases[name].expectedSelectedTestCount);
    assert.match(report.cases[name].stdoutSha256, /^[a-f0-9]{64}$/);
    assert.match(report.cases[name].stderrSha256, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(report.cases[name].references));
    assert.ok(report.cases[name].references.length > 0);
  }

  assert.equal(report.evidence.parentPid, execution.pid);
  assert.ok(report.evidence.workerProcessCount >= 10);
  assert.ok(report.evidence.maxConcurrentWorkers >= 3);
  assert.ok(report.evidence.workerPids.length >= 10);
  assert.ok(report.evidence.workerPids.every(pid => pid !== report.evidence.parentPid));
  assert.deepEqual(report.gate, {
    subprocessCases: "PASS",
    isolatedBehaviorCases: "PASS",
    task36Step6a: "PASS"
  });
});

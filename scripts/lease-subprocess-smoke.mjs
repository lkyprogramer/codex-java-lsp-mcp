// Task 13 Step 2a: a real multi-process smoke test for the cross-process JDT
// lease (Task 12a). Two independent Node processes race to acquire a JDT
// lease for the same worktree identity against the same on-disk lease
// directory; only one may succeed, proving the atomic-mkdir mutex holds
// across real OS processes, not just in-process function calls.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(here, "lease-subprocess-smoke-worker.mjs");

function runWorker(leaseBase, holdMs, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker], {
      env: { ...process.env, SMOKE_LEASE_BASE: leaseBase, SMOKE_HOLD_MS: String(holdMs), ...extraEnv },
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.on("exit", code => {
      if (code !== 0) {
        reject(new Error(`worker exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`worker produced unparseable output: ${stdout}`));
      }
    });
    child.on("error", reject);
  });
}

let failed = false;

async function scenarioSameWorktree() {
  const leaseBase = await mkdtemp(path.join(tmpdir(), "lease-smoke-same-"));
  try {
    // Process A starts first and holds the lease for 400ms; process B starts
    // 100ms later, while A still holds it, guaranteeing real overlap.
    const [resultA, resultB] = await Promise.all([
      runWorker(leaseBase, 400, { SMOKE_REPO_HASH: "smoke-same", SMOKE_JDT_SLOTS: "1" }),
      new Promise(resolve => setTimeout(resolve, 100))
        .then(() => runWorker(leaseBase, 0, { SMOKE_REPO_HASH: "smoke-same", SMOKE_JDT_SLOTS: "1" }))
    ]);
    const kinds = [resultA.kind, resultB.kind].sort();
    const acquired = kinds.filter(kind => kind === "ACQUIRED").length;
    const busy = kinds.filter(kind => kind === "BUSY_SAME_WORKTREE").length;
    console.log("scenario: same worktree, two processes ->", JSON.stringify({ resultA, resultB }));
    if (acquired !== 1 || busy !== 1) {
      console.error(`FAIL(same-worktree): expected one ACQUIRED and one BUSY_SAME_WORKTREE, got acquired=${acquired} busy=${busy}`);
      failed = true;
    } else {
      console.log("PASS(same-worktree): the second process was rejected before a second JDT slot, across real OS processes.");
    }
  } finally {
    await rm(leaseBase, { recursive: true, force: true });
  }
}

async function scenarioMachineSlotCap() {
  const leaseBase = await mkdtemp(path.join(tmpdir(), "lease-smoke-cap-"));
  try {
    // Three distinct worktrees, one machine-wide slot budget of 2: exactly
    // two must succeed and the third must observe NO_GLOBAL_SLOT.
    const results = await Promise.all([1, 2, 3].map(index => runWorker(leaseBase, 300, {
      SMOKE_REPO_HASH: `smoke-cap-${index}`,
      SMOKE_JDT_SLOTS: "2"
    })));
    const acquired = results.filter(result => result.kind === "ACQUIRED").length;
    const rejected = results.filter(result => result.kind === "NO_GLOBAL_SLOT").length;
    console.log("scenario: three worktrees, jdtSlots=2 ->", JSON.stringify(results));
    if (acquired > 2 || acquired !== 2 || rejected !== 1) {
      console.error(`FAIL(slot-cap): expected exactly 2 ACQUIRED and 1 NO_GLOBAL_SLOT, got acquired=${acquired} rejected=${rejected}`);
      failed = true;
    } else {
      console.log("PASS(slot-cap): maxObservedClaimedJdtSlots never exceeded the configured 2 slots, across real OS processes.");
    }
  } finally {
    await rm(leaseBase, { recursive: true, force: true });
  }
}

await scenarioSameWorktree();
await scenarioMachineSlotCap();
process.exitCode = failed ? 1 : 0;

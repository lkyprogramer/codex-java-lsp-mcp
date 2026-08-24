// Child process for lease-subprocess-smoke.mjs: acquires (or fails to acquire)
// a JDT lease for a fixed worktree identity, holds it briefly, then releases.
import { FileCrossProcessLeaseStore, defaultLeaseClockDeps } from "../dist/cross-process-lease.js";
import { DeadlineBudget } from "../dist/runtime/deadline-budget.js";

const leaseBase = process.env.SMOKE_LEASE_BASE;
const holdMs = Number(process.env.SMOKE_HOLD_MS || "300");
const repoHash = process.env.SMOKE_REPO_HASH || "smoke-repo-hash";
const familyHash = process.env.SMOKE_FAMILY_HASH || "smoke-family-hash";
const jdtSlots = Number(process.env.SMOKE_JDT_SLOTS || "1");

const identity = {
  repoRoot: `/tmp/${repoHash}`,
  repoHash,
  familyHash,
  isLinkedWorktree: true
};

// tryAcquireJdt (one-shot) by default: acquireJdt retries on NO_GLOBAL_SLOT
// until its budget expires, which would let a process "succeed" only after
// another releases — a point-in-time slot-cap check must not retry, or it
// measures eventual admission instead of concurrent occupancy.
const oneShot = process.env.SMOKE_ONE_SHOT !== "0";

const store = new FileCrossProcessLeaseStore(leaseBase, defaultLeaseClockDeps());
await store.open({ jdtSlots, sweepSlots: 1 });
const result = oneShot
  ? await store.tryAcquireJdt(identity)
  : await store.acquireJdt(identity, DeadlineBudget.fromTimeout(2000));

process.stdout.write(`${JSON.stringify({ pid: process.pid, kind: result.kind })}\n`);

if (result.kind === "ACQUIRED") {
  await new Promise(resolve => setTimeout(resolve, holdMs));
  await result.lease.release();
}

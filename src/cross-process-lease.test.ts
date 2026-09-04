import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileCrossProcessLeaseStore,
  LeaseConfigError,
  type CrossProcessLeaseStore,
  type LeaseOwner
} from "./cross-process-lease.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import type { WorktreeIdentity } from "./worktree-identity.js";

function tempLeaseRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "lease-"));
}

function identity(repoRoot: string, repoHash: string, familyHash?: string): WorktreeIdentity {
  return { repoRoot, repoHash, familyHash, isLinkedWorktree: false };
}

function budget(ms = 500): DeadlineBudget {
  return DeadlineBudget.fromTimeout(ms);
}

type StoreOptions = {
  pid: number;
  alive: Set<number>;
  jdtSlots?: number;
  sweepSlots?: number;
  orphanGraceMs?: number;
  capacityLockTimeoutMs?: number;
  now?: () => number;
};

async function leaseStore(root: string, options: StoreOptions): Promise<FileCrossProcessLeaseStore> {
  const store = new FileCrossProcessLeaseStore(root, {
    pid: options.pid,
    isAlive: pid => options.alive.has(pid),
    now: options.now ?? (() => Date.now()),
    orphanGraceMs: options.orphanGraceMs ?? 30,
    capacityLockTimeoutMs: options.capacityLockTimeoutMs ?? 1000
  });
  await store.open({ jdtSlots: options.jdtSlots ?? 1, sweepSlots: options.sweepSlots ?? 1 });
  return store;
}

async function countClaimedSlots(
  store: CrossProcessLeaseStore,
  kind: "jdt-slots" | "sweep-slots" | "build-slots"
): Promise<number> {
  const status = await store.status();
  if (kind === "jdt-slots") return status.claimedJdtSlots;
  if (kind === "sweep-slots") return status.claimedSweepSlots;
  return status.claimedBuildSlots;
}

test("two processes cannot exceed one machine JDT slot", async () => {
  const shared = tempLeaseRoot();
  const first = await leaseStore(shared, { pid: 101, alive: new Set([101, 202]), jdtSlots: 1 });
  const second = await leaseStore(shared, { pid: 202, alive: new Set([101, 202]), jdtSlots: 1 });

  const a = await first.acquireJdt(identity("/repo-a", "a"), budget());
  assert.equal(a.kind, "ACQUIRED");
  const b = await second.tryAcquireJdt(identity("/repo-b", "b"));
  assert.equal(b.kind, "NO_GLOBAL_SLOT");

  if (a.kind !== "ACQUIRED") throw new Error("unreachable");
  await a.lease.release();
  const b2 = await second.acquireJdt(identity("/repo-b", "b"), budget());
  assert.equal(b2.kind, "ACQUIRED");
  if (b2.kind !== "ACQUIRED") throw new Error("unreachable");
  await b2.lease.release();
});

test("sibling worktrees acquire independent JDT worktree leases when slots allow", async () => {
  const shared = tempLeaseRoot();
  const first = await leaseStore(shared, { pid: 101, alive: new Set([101, 202]), jdtSlots: 2 });
  const second = await leaseStore(shared, { pid: 202, alive: new Set([101, 202]), jdtSlots: 2 });
  const primary = identity("/repo/primary", "primary-hash", "family");
  const linked = identity("/repo/linked", "linked-hash", "family");

  const a = await first.tryAcquireJdt(primary);
  const b = await second.tryAcquireJdt(linked);
  assert.equal(a.kind, "ACQUIRED");
  assert.equal(b.kind, "ACQUIRED", "a sibling worktree must not share the other worktree's JDT lease");
  if (a.kind !== "ACQUIRED" || b.kind !== "ACQUIRED") throw new Error("unreachable");
  assert.notEqual(a.lease.worktree.path, b.lease.worktree.path);
  await a.lease.release();
  await b.lease.release();
});

test("same worktree second process is rejected before a second JDT slot", async () => {
  const shared = tempLeaseRoot();
  const first = await leaseStore(shared, { pid: 101, alive: new Set([101, 202]), jdtSlots: 2 });
  const second = await leaseStore(shared, { pid: 202, alive: new Set([101, 202]), jdtSlots: 2 });
  const id = identity("/same-worktree", "same");

  const a = await first.acquireJdt(id, budget());
  const b = await second.tryAcquireJdt(id);
  assert.equal(a.kind, "ACQUIRED");
  assert.equal(b.kind, "BUSY_SAME_WORKTREE");
  assert.equal(await countClaimedSlots(first, "jdt-slots"), 1, "the rejected second attempt never claimed a slot");
  if (a.kind !== "ACQUIRED") throw new Error("unreachable");
  await a.lease.release();
});

test("a dead-PID worktree lease is reclaimed", async () => {
  const shared = tempLeaseRoot();
  const first = await leaseStore(shared, { pid: 101, alive: new Set([101]), jdtSlots: 1 });
  const id = identity("/repo-a", "a");
  const a = await first.acquireJdt(id, budget());
  assert.equal(a.kind, "ACQUIRED");

  // From a second store's point of view, pid 101 is no longer alive.
  const second = await leaseStore(shared, { pid: 202, alive: new Set([202]), jdtSlots: 1 });
  const b = await second.tryAcquireJdt(id);
  assert.equal(b.kind, "ACQUIRED", "the dead owner's worktree lease was reclaimed");
  if (b.kind !== "ACQUIRED") throw new Error("unreachable");
  const status = await second.status();
  assert.equal(status.staleLeaseReclaims > 0, true);
  await b.lease.release();
});

test("a dead owner with no live JDT child allows worktree and global slot reclaim", async () => {
  const shared = tempLeaseRoot();
  const first = await leaseStore(shared, { pid: 101, alive: new Set([101]), jdtSlots: 1 });
  const id = identity("/repo-a", "a");
  const a = await first.acquireJdt(id, budget());
  assert.equal(a.kind, "ACQUIRED");
  if (a.kind !== "ACQUIRED") throw new Error("unreachable");
  // No jdtlsPid was ever recorded: this owner has no known child at all.

  const second = await leaseStore(shared, { pid: 202, alive: new Set([202]), jdtSlots: 1 });
  const b = await second.acquireJdt(id, budget());
  assert.equal(b.kind, "ACQUIRED");
  if (b.kind !== "ACQUIRED") throw new Error("unreachable");
  await b.lease.release();
});

test("a dead owner whose recorded jdtlsPid is still alive is ORPHAN_JDT and is not reclaimed until the child exits", async () => {
  const shared = tempLeaseRoot();
  const alive = new Set([101, 999]);
  const first = await leaseStore(shared, { pid: 101, alive, jdtSlots: 1 });
  const id = identity("/repo-a", "a");
  const a = await first.acquireJdt(id, budget());
  assert.equal(a.kind, "ACQUIRED");
  if (a.kind !== "ACQUIRED") throw new Error("unreachable");
  const recorded = await a.lease.recordJdtlsPid(999);
  assert.equal(recorded, true);

  // Owner process 101 dies, but its spawned JDT child 999 is still running.
  alive.delete(101);
  const second = await leaseStore(shared, { pid: 202, alive, jdtSlots: 1 });
  const attempt = await second.tryAcquireJdt(id);
  assert.equal(attempt.kind, "ORPHAN_JDT");
  if (attempt.kind === "ORPHAN_JDT") {
    assert.equal(attempt.owner.jdtlsPid, 999);
  }

  // The orphaned child finally exits: now it is safe to reclaim.
  alive.delete(999);
  const afterChildExit = await second.tryAcquireJdt(id);
  assert.equal(afterChildExit.kind, "ACQUIRED");
  if (afterChildExit.kind === "ACQUIRED") {
    await afterChildExit.lease.release();
  }
});

test("a live PID with a stale heartbeat is not stolen", async () => {
  const shared = tempLeaseRoot();
  const clock = { value: Date.now() };
  const first = await leaseStore(shared, { pid: 101, alive: new Set([101, 202]), jdtSlots: 1, now: () => clock.value });
  const id = identity("/repo-a", "a");
  const a = await first.acquireJdt(id, budget());
  assert.equal(a.kind, "ACQUIRED");

  // Advance the clock far past any orphan grace window without the owner
  // ever heartbeating again. Liveness is PID-based, not heartbeat-based.
  clock.value += 10 * 60 * 1000;
  const second = await leaseStore(shared, { pid: 202, alive: new Set([101, 202]), jdtSlots: 1, now: () => clock.value });
  const b = await second.tryAcquireJdt(id);
  assert.equal(b.kind, "BUSY_SAME_WORKTREE", "a live PID is never stolen regardless of heartbeat staleness");
});

test("a directory created without metadata is reclaimed only after orphanGraceMs", async () => {
  const shared = tempLeaseRoot();
  const clock = { value: Date.now() };
  const orphanGraceMs = 1000;
  const store = await leaseStore(shared, { pid: 202, alive: new Set([202]), jdtSlots: 1, orphanGraceMs, now: () => clock.value });
  const id = identity("/repo-a", "a");

  // Simulate a crash between mkdir and the metadata rename: the directory
  // exists but metadata.json never landed.
  const orphanDir = path.join(shared, "jdt-worktree", "a");
  mkdirSync(orphanDir, { recursive: true });
  // inspectLeaseDir uses the directory's real ctime, not the fake clock. Align
  // after mkdir so store.open() latency cannot eat the +10ms grace slack.
  clock.value = statSync(orphanDir).ctimeMs;

  const tooEarly = await store.tryAcquireJdt(id);
  assert.equal(tooEarly.kind, "BUSY_SAME_WORKTREE", "not yet reclaimable within the grace window");

  clock.value += orphanGraceMs + 10;
  const afterGrace = await store.tryAcquireJdt(id);
  assert.equal(afterGrace.kind, "ACQUIRED");
  if (afterGrace.kind === "ACQUIRED") {
    await afterGrace.lease.release();
  }
});

test("release with a different ownerToken cannot delete another owner's lease", async () => {
  const shared = tempLeaseRoot();
  const store = await leaseStore(shared, { pid: 101, alive: new Set([101]), jdtSlots: 1 });
  const id = identity("/repo-a", "a");
  const a = await store.acquireJdt(id, budget());
  assert.equal(a.kind, "ACQUIRED");
  if (a.kind !== "ACQUIRED") throw new Error("unreachable");

  // Simulate another process having reclaimed and re-acquired the same
  // directory between our acquire and our release.
  const metaPath = path.join(a.lease.worktree.path, "metadata.json");
  const currentOwner = JSON.parse(readFileSync(metaPath, "utf8")) as LeaseOwner;
  const otherOwner: LeaseOwner = { ...currentOwner, ownerToken: "someone-else" };
  const tmpPath = `${metaPath}.rewrite.tmp`;
  writeFileSync(tmpPath, JSON.stringify(otherOwner));
  renameSync(tmpPath, metaPath);

  await a.lease.worktree.release();
  assert.equal(existsSync(a.lease.worktree.path), true, "a stale-token release must not delete the new owner's lease");
});

test("timeout while waiting for a JDT slot leaves no worktree lease behind", async () => {
  const shared = tempLeaseRoot();
  const store = await leaseStore(shared, { pid: 101, alive: new Set([101]), jdtSlots: 0 });
  const id = identity("/repo-a", "a");

  const result = await store.acquireJdt(id, budget(120));
  assert.equal(result.kind, "NO_GLOBAL_SLOT");
  assert.equal(existsSync(path.join(shared, "jdt-worktree", "a")), false, "no orphaned worktree lease remains");
});

test("two stores requesting different jdtSlots while one lease is live both obey the persisted capacity", async () => {
  const shared = tempLeaseRoot();
  const first = await leaseStore(shared, { pid: 101, alive: new Set([101, 202]), jdtSlots: 2 });
  const id = identity("/repo-a", "a");
  const a = await first.acquireJdt(id, budget());
  assert.equal(a.kind, "ACQUIRED");
  if (a.kind !== "ACQUIRED") throw new Error("unreachable");

  const second = await leaseStore(shared, { pid: 202, alive: new Set([101, 202]), jdtSlots: 5 });
  const secondStatus = await second.status();
  assert.equal(secondStatus.configuredJdtSlots, 2, "existing capacity is authoritative while a lease is live");
  assert.equal(secondStatus.capacityConflict, true);
  const firstStatus = await first.status();
  assert.equal(firstStatus.capacityConflict, false, "the original opener sees no conflict");

  await a.lease.release();

  const third = await leaseStore(shared, { pid: 303, alive: new Set([101, 202, 303]), jdtSlots: 5 });
  const thirdStatus = await third.status();
  assert.equal(thirdStatus.configuredJdtSlots, 5, "capacity can be replaced once no lease is live");
  assert.equal(thirdStatus.capacityConflict, false);
});

test("a dead or metadata-less expired capacity.lock is reclaimed, while a live lock owner is never stolen", async () => {
  const shared = tempLeaseRoot();
  // A crash mid-negotiation: capacity.lock exists with no metadata.
  mkdirSync(path.join(shared, "capacity.lock"), { recursive: true });
  const clock = { value: Date.now() };
  // Advance the clock past the grace window before the first attempt, so
  // open() reclaims on its first inspection instead of looping on a real
  // wall-clock delay against a clock that (by design) never advances itself.
  clock.value += 1000;
  const reclaimStore = new FileCrossProcessLeaseStore(shared, {
    pid: 101,
    isAlive: pid => pid === 101,
    now: () => clock.value,
    orphanGraceMs: 50,
    capacityLockTimeoutMs: 200
  });
  await reclaimStore.open({ jdtSlots: 1, sweepSlots: 1 });
  const status = await reclaimStore.status();
  assert.equal(status.opened, true, "a metadata-less capacity.lock was reclaimed rather than blocking forever");

  // Now simulate a live (different, alive) process holding the lock: open()
  // must time out rather than steal it.
  mkdirSync(path.join(shared, "capacity.lock"), { recursive: true });
  writeFileSync(
    path.join(shared, "capacity.lock", "metadata.json"),
    JSON.stringify({ ownerToken: "live-owner", pid: 555, repoRoot: "", repoHash: "", acquiredAt: "now", heartbeatAt: "now" })
  );
  const blockedStore = new FileCrossProcessLeaseStore(shared, {
    pid: 606,
    isAlive: (pid: number) => pid === 555 || pid === 606,
    now: () => Date.now(),
    orphanGraceMs: 30,
    capacityLockTimeoutMs: 100
  });
  await assert.rejects(() => blockedStore.open({ jdtSlots: 1, sweepSlots: 1 }));
});

test("acquireSweep bounds to the configured sweep slots and rejects use before open()", async () => {
  const shared = tempLeaseRoot();
  const unopened = new FileCrossProcessLeaseStore(shared, {
    pid: 101,
    isAlive: pid => pid === 101,
    now: () => Date.now(),
    orphanGraceMs: 30,
    capacityLockTimeoutMs: 200
  });
  await assert.rejects(
    () => unopened.acquireSweep(identity("/repo-a", "a"), budget()),
    (error: unknown) => error instanceof LeaseConfigError
  );

  const store = await leaseStore(shared, { pid: 202, alive: new Set([202]), sweepSlots: 1 });
  const first = await store.acquireSweep(identity("/repo-a", "a"), budget());
  assert.equal(first.kind, "SWEEP_SLOT");
  assert.equal(await countClaimedSlots(store, "sweep-slots"), 1);

  const second = store.acquireSweep(identity("/repo-b", "b"), budget(120));
  await assert.rejects(() => second, (error: unknown) => error instanceof Error && /Deadline exceeded/i.test(error.message));

  await first.release();
  const third = await store.acquireSweep(identity("/repo-b", "b"), budget());
  assert.equal(third.kind, "SWEEP_SLOT");
  await third.release();
});

test("acquireBuild is a single machine-wide slot independent of sweep capacity", async () => {
  const shared = tempLeaseRoot();
  const unopened = new FileCrossProcessLeaseStore(shared, {
    pid: 101,
    isAlive: pid => pid === 101,
    now: () => Date.now(),
    orphanGraceMs: 30,
    capacityLockTimeoutMs: 200
  });
  await assert.rejects(
    () => unopened.acquireBuild(identity("/repo-a", "a"), budget()),
    (error: unknown) => error instanceof LeaseConfigError
  );

  const firstStore = await leaseStore(shared, { pid: 202, alive: new Set([202, 303]), sweepSlots: 4 });
  const secondStore = await leaseStore(shared, { pid: 303, alive: new Set([202, 303]), sweepSlots: 4 });
  const first = await firstStore.acquireBuild(identity("/repo-a", "a"), budget());
  assert.equal(first.kind, "BUILD_SLOT");
  assert.equal(await countClaimedSlots(firstStore, "build-slots"), 1);

  const blocked = secondStore.acquireBuild(identity("/repo-b", "b"), budget(120));
  await assert.rejects(
    () => blocked,
    (error: unknown) => error instanceof Error && /Deadline exceeded/i.test(error.message)
  );

  await first.release();
  const second = await secondStore.acquireBuild(identity("/repo-b", "b"), budget());
  assert.equal(second.kind, "BUILD_SLOT");
  assert.equal(await countClaimedSlots(secondStore, "build-slots"), 1);
  await second.release();
});

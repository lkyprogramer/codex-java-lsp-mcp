// input: A shared on-disk lease root plus injected PID-liveness/clock deps.
// output: Atomic-mkdir leases coordinating JDT/sweep capacity across every
//         codex-java-lsp MCP process on this machine.
// pos: Directory-based mutex/semaphore primitive. `mkdir` is the only atomic
//      step; metadata is written afterward via temp-write + rename, so every
//      reader must tolerate a directory that exists with no metadata yet.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import type { WorktreeIdentity } from "./worktree-identity.js";
import { leaseFamilyKey } from "./worktree-identity.js";

export type LeaseOwner = {
  ownerToken: string;
  pid: number;
  repoRoot: string;
  repoHash: string;
  familyHash?: string;
  jdtlsPid?: number;
  acquiredAt: string;
  heartbeatAt: string;
};

export interface LeaseHandle {
  readonly kind: "RUNTIME" | "JDT_WORKTREE" | "JDT_SLOT" | "SWEEP_SLOT";
  readonly path: string;
  readonly owner: LeaseOwner;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

export interface CompositeJdtLease {
  readonly worktree: LeaseHandle;
  readonly slot: LeaseHandle;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
  /**
   * Records the spawned Eclipse JDT LS child on both the worktree and slot
   * leases (two sequential atomic renames, not one joint transaction).
   * Returns false if either update failed, in which case the caller must kill
   * the child and release this composite lease before ever reaching
   * lifecycle READY (Task 12a Step 5) — that rollback is what makes a
   * partial write safe, not atomicity across the two renames.
   */
  recordJdtlsPid(jdtlsPid: number): Promise<boolean>;
}

export type JdtLeaseAcquireResult =
  | { kind: "ACQUIRED"; lease: CompositeJdtLease }
  | { kind: "BUSY_SAME_WORKTREE"; owner?: LeaseOwner }
  | { kind: "ORPHAN_JDT"; owner: LeaseOwner }
  | { kind: "NO_GLOBAL_SLOT" };

export type CrossProcessLeaseStatus = {
  opened: boolean;
  configuredJdtSlots: number;
  configuredSweepSlots: number;
  requestedJdtSlots: number;
  requestedSweepSlots: number;
  capacityConflict: boolean;
  runtimeLeases: number;
  jdtWorktreeLeases: number;
  claimedJdtSlots: number;
  claimedSweepSlots: number;
  staleLeaseReclaims: number;
  lastError?: string;
};

export interface CrossProcessLeaseStore {
  open(requested: { jdtSlots: number; sweepSlots: number }): Promise<void>;
  acquireRuntime(identity: WorktreeIdentity): Promise<LeaseHandle>;
  tryAcquireJdt(identity: WorktreeIdentity): Promise<JdtLeaseAcquireResult>;
  acquireJdt(identity: WorktreeIdentity, budget: DeadlineBudget): Promise<JdtLeaseAcquireResult>;
  acquireSweep(identity: WorktreeIdentity, budget: DeadlineBudget): Promise<LeaseHandle>;
  activeRuntimeCount(familyHash?: string): Promise<number>;
  status(): Promise<CrossProcessLeaseStatus>;
}

/** Thrown by `open()` when capacity.json is corrupt while a live lease exists. */
export class LeaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseConfigError";
  }
}

/**
 * Always-succeeds store. This is the default so every JdtlsSession-based test
 * (and any production code that hasn't wired a real store) behaves exactly as
 * it did before cross-process leases existed; only `createRuntime` passes a
 * real `FileCrossProcessLeaseStore`.
 */
export class NoopCrossProcessLeaseStore implements CrossProcessLeaseStore {
  async open(): Promise<void> {}

  async acquireRuntime(): Promise<LeaseHandle> {
    return this.inertHandle("RUNTIME");
  }

  async tryAcquireJdt(): Promise<JdtLeaseAcquireResult> {
    return { kind: "ACQUIRED", lease: this.inertJdtLease() };
  }

  async acquireJdt(): Promise<JdtLeaseAcquireResult> {
    return { kind: "ACQUIRED", lease: this.inertJdtLease() };
  }

  async acquireSweep(): Promise<LeaseHandle> {
    return this.inertHandle("SWEEP_SLOT");
  }

  async activeRuntimeCount(): Promise<number> {
    return 0;
  }

  async status(): Promise<CrossProcessLeaseStatus> {
    return {
      opened: true,
      configuredJdtSlots: 0,
      configuredSweepSlots: 0,
      requestedJdtSlots: 0,
      requestedSweepSlots: 0,
      capacityConflict: false,
      runtimeLeases: 0,
      jdtWorktreeLeases: 0,
      claimedJdtSlots: 0,
      claimedSweepSlots: 0,
      staleLeaseReclaims: 0
    };
  }

  private inertHandle(kind: LeaseHandle["kind"]): LeaseHandle {
    const owner: LeaseOwner = {
      ownerToken: "noop",
      pid: process.pid,
      repoRoot: "",
      repoHash: "",
      acquiredAt: "",
      heartbeatAt: ""
    };
    return { kind, path: "", owner, heartbeat: async () => {}, release: async () => {} };
  }

  private inertJdtLease(): CompositeJdtLease {
    const worktree = this.inertHandle("JDT_WORKTREE");
    const slot = this.inertHandle("JDT_SLOT");
    return {
      worktree,
      slot,
      heartbeat: async () => {},
      release: async () => {},
      recordJdtlsPid: async () => true
    };
  }
}

export type LeaseClockDeps = {
  pid: number;
  isAlive(pid: number): boolean;
  now(): number;
  /** How long a metadata-less (mkdir succeeded, write never landed) directory survives before reclaim. */
  orphanGraceMs: number;
  /** Bound on waiting for another process's capacity.lock during open(). */
  capacityLockTimeoutMs: number;
};

/**
 * Alive check with a fail-safe default: ESRCH means the PID is truly gone;
 * every other errno (EPERM in particular, when the PID exists but is owned by
 * another user) is treated as alive. Getting EPERM wrong here is how a lease
 * would be stolen out from under a still-running process.
 */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Read-only, synchronous liveness check for the startup cache janitor: does
 * any runtime lease directory for this exact (familyHash, repoHash) belong to
 * a still-alive owner? No `open()`, no mutation, no reclaim — the janitor
 * only ever needs to ask "is someone still using this", never touch the
 * shared lease tree itself.
 */
export function hasLiveRuntimeLease(
  leaseBase: string,
  familyHash: string,
  repoHash: string,
  isAlive: (pid: number) => boolean = defaultIsAlive
): boolean {
  const repoDir = path.join(leaseBase, "runtime", familyHash, repoHash);
  if (!existsSync(repoDir)) return false;
  let entries: string[];
  try {
    entries = readdirSync(repoDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return false;
  }
  for (const entry of entries) {
    try {
      const owner = JSON.parse(readFileSync(path.join(repoDir, entry, "metadata.json"), "utf8")) as { pid?: unknown };
      if (typeof owner.pid === "number" && isAlive(owner.pid)) return true;
    } catch {
      // A metadata-less or unreadable lease directory is not proof of life.
    }
  }
  return false;
}

export function defaultLeaseClockDeps(overrides: Partial<LeaseClockDeps> = {}): LeaseClockDeps {
  return {
    pid: process.pid,
    isAlive: defaultIsAlive,
    now: () => Date.now(),
    orphanGraceMs: 10000,
    capacityLockTimeoutMs: 2000,
    ...overrides
  };
}

type CapacityFile = {
  schemaVersion: number;
  jdtSlots: number;
  sweepSlots: number;
  updatedAt: string;
};

const CAPACITY_SCHEMA_VERSION = 1;

type LeaseInspection =
  | { state: "ABSENT" }
  | { state: "LIVE"; owner: LeaseOwner }
  | { state: "DEAD_OWNER"; owner: LeaseOwner }
  | { state: "METADATA_LESS"; createdAtMs: number };

type ClaimAttempt =
  | { ok: true; handle: LeaseHandle }
  | { ok: false; reason: "BUSY"; owner?: LeaseOwner }
  | { ok: false; reason: "ORPHAN_CHILD_ALIVE"; owner: LeaseOwner };

export class FileCrossProcessLeaseStore implements CrossProcessLeaseStore {
  private opened = false;
  private jdtSlots = 0;
  private sweepSlots = 0;
  private requestedJdtSlots = 0;
  private requestedSweepSlots = 0;
  private capacityConflict = false;
  private staleLeaseReclaims = 0;
  private lastError?: string;

  constructor(private readonly root: string, private readonly deps: LeaseClockDeps) {}

  async open(requested: { jdtSlots: number; sweepSlots: number }): Promise<void> {
    mkdirSync(this.root, { recursive: true });
    this.requestedJdtSlots = requested.jdtSlots;
    this.requestedSweepSlots = requested.sweepSlots;
    const lockDir = path.join(this.root, "capacity.lock");
    await this.acquireCapacityLock(lockDir);
    try {
      const read = this.readCapacityFile();
      const anyLive = this.anyLiveLeaseExists();
      if (read.state === "CORRUPT") {
        if (anyLive) {
          this.lastError = "capacity.json is corrupt while live leases exist";
          throw new LeaseConfigError(this.lastError);
        }
        // No live lease anywhere: safe to quarantine and rebuild.
        rmSync(path.join(this.root, "capacity.json"), { force: true });
        this.publishCapacity(requested);
        this.capacityConflict = false;
      } else if (read.state === "VALID" && anyLive) {
        this.jdtSlots = read.value.jdtSlots;
        this.sweepSlots = read.value.sweepSlots;
        this.capacityConflict = read.value.jdtSlots !== requested.jdtSlots || read.value.sweepSlots !== requested.sweepSlots;
      } else {
        // Either no capacity.json yet, or one exists but nothing live depends
        // on it: free to (re)publish the requested capacity atomically.
        this.publishCapacity(requested);
        this.capacityConflict = false;
      }
      this.opened = true;
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.releaseCapacityLock(lockDir);
    }
  }

  async acquireRuntime(identity: WorktreeIdentity): Promise<LeaseHandle> {
    this.assertOpen();
    const familyKey = leaseFamilyKey(identity);
    const dir = path.join(this.root, "runtime", familyKey, identity.repoHash, `${this.deps.pid}-${randomUUID()}`);
    mkdirSync(path.dirname(dir), { recursive: true });
    // The directory name is unique per process instance; EEXIST here would be
    // a UUID collision, not contention, so it is allowed to throw.
    mkdirSync(dir);
    const owner = this.makeOwner(identity);
    this.writeMetadataAtomic(dir, owner);
    return this.makeHandle(dir, "RUNTIME", owner);
  }

  async tryAcquireJdt(identity: WorktreeIdentity): Promise<JdtLeaseAcquireResult> {
    this.assertOpen();
    const worktreeDir = path.join(this.root, "jdt-worktree", identity.repoHash);
    const worktreeAttempt = this.claimLeaseDir(worktreeDir, "JDT_WORKTREE", identity, true);
    if (!worktreeAttempt.ok) {
      return worktreeAttempt.reason === "ORPHAN_CHILD_ALIVE"
        ? { kind: "ORPHAN_JDT", owner: worktreeAttempt.owner }
        : { kind: "BUSY_SAME_WORKTREE", owner: worktreeAttempt.owner };
    }
    let slotHandle: LeaseHandle | undefined;
    try {
      slotHandle = this.claimFixedSlot("jdt-slots", this.jdtSlots, "JDT_SLOT", identity);
    } catch (error) {
      await worktreeAttempt.handle.release();
      throw error;
    }
    if (!slotHandle) {
      await worktreeAttempt.handle.release();
      return { kind: "NO_GLOBAL_SLOT" };
    }
    return { kind: "ACQUIRED", lease: this.composeJdtLease(worktreeAttempt.handle, slotHandle) };
  }

  async acquireJdt(identity: WorktreeIdentity, budget: DeadlineBudget): Promise<JdtLeaseAcquireResult> {
    for (;;) {
      const attempt = await this.tryAcquireJdt(identity);
      if (attempt.kind !== "NO_GLOBAL_SLOT") return attempt;
      if (budget.expired()) return attempt;
      await delay(Math.min(50, budget.remainingMs(50)));
    }
  }

  async acquireSweep(identity: WorktreeIdentity, budget: DeadlineBudget): Promise<LeaseHandle> {
    this.assertOpen();
    for (;;) {
      const handle = this.claimFixedSlot("sweep-slots", this.sweepSlots, "SWEEP_SLOT", identity);
      if (handle) return handle;
      budget.throwIfExpired("cross-process-lease.acquireSweep");
      await delay(Math.min(50, budget.remainingMs(50)));
    }
  }

  async activeRuntimeCount(familyHash?: string): Promise<number> {
    const runtimeRoot = path.join(this.root, "runtime");
    if (!existsSync(runtimeRoot)) return 0;
    const families = familyHash ? [familyHash] : this.listDirs(runtimeRoot);
    let count = 0;
    for (const family of families) {
      const familyDir = path.join(runtimeRoot, family);
      for (const repoHash of this.listDirs(familyDir)) {
        const repoDir = path.join(familyDir, repoHash);
        for (const entry of this.listDirs(repoDir)) {
          if (this.inspectLeaseDir(path.join(repoDir, entry)).state === "LIVE") count += 1;
        }
      }
    }
    return count;
  }

  async status(): Promise<CrossProcessLeaseStatus> {
    return {
      opened: this.opened,
      configuredJdtSlots: this.jdtSlots,
      configuredSweepSlots: this.sweepSlots,
      requestedJdtSlots: this.requestedJdtSlots,
      requestedSweepSlots: this.requestedSweepSlots,
      capacityConflict: this.capacityConflict,
      runtimeLeases: await this.activeRuntimeCount(),
      jdtWorktreeLeases: this.countLiveIn(path.join(this.root, "jdt-worktree")),
      claimedJdtSlots: this.countLiveIn(path.join(this.root, "jdt-slots")),
      claimedSweepSlots: this.countLiveIn(path.join(this.root, "sweep-slots")),
      staleLeaseReclaims: this.staleLeaseReclaims,
      lastError: this.lastError
    };
  }

  private assertOpen(): void {
    if (!this.opened) {
      throw new LeaseConfigError("CrossProcessLeaseStore used before open() completed");
    }
  }

  private composeJdtLease(worktree: LeaseHandle, slot: LeaseHandle): CompositeJdtLease {
    return {
      worktree,
      slot,
      heartbeat: async () => {
        await worktree.heartbeat();
        await slot.heartbeat();
      },
      release: async () => {
        // Release order does not matter for correctness (each handle guards
        // its own directory by ownerToken), but slot-then-worktree frees the
        // machine-wide resource first.
        await slot.release();
        await worktree.release();
      },
      recordJdtlsPid: async (jdtlsPid: number) => {
        const worktreeOk = this.updateOwnerField(worktree, owner => ({ ...owner, jdtlsPid }));
        const slotOk = this.updateOwnerField(slot, owner => ({ ...owner, jdtlsPid }));
        return worktreeOk && slotOk;
      }
    };
  }

  /** Reread-then-write-if-still-ours; returns false if the lease was lost underneath us. */
  private updateOwnerField(handle: LeaseHandle, update: (owner: LeaseOwner) => LeaseOwner): boolean {
    const current = this.readOwner(handle.path);
    if (!current || current.ownerToken !== handle.owner.ownerToken) return false;
    const next = update(current);
    (handle.owner as LeaseOwner).jdtlsPid = next.jdtlsPid;
    this.writeMetadataAtomic(handle.path, next);
    return true;
  }

  private claimFixedSlot(
    prefix: "jdt-slots" | "sweep-slots",
    count: number,
    kind: "JDT_SLOT" | "SWEEP_SLOT",
    identity: WorktreeIdentity
  ): LeaseHandle | undefined {
    for (let index = 0; index < count; index += 1) {
      const dir = path.join(this.root, prefix, `slot-${index}`);
      const attempt = this.claimLeaseDir(dir, kind, identity, false);
      if (attempt.ok) return attempt.handle;
    }
    return undefined;
  }

  /**
   * The single atomic-mkdir claim primitive shared by every lease kind.
   * `checkOrphanChild` gates the JDT-worktree-only fail-closed rule: a dead
   * owner whose recorded `jdtlsPid` is still alive must never be reclaimed
   * automatically, or two Eclipse processes could attach to one workspace.
   */
  private claimLeaseDir(
    dir: string,
    kind: LeaseHandle["kind"],
    identity: WorktreeIdentity,
    checkOrphanChild: boolean
  ): ClaimAttempt {
    mkdirSync(path.dirname(dir), { recursive: true });
    if (!this.tryMkdir(dir)) {
      const inspection = this.inspectLeaseDir(dir);
      if (inspection.state === "LIVE") {
        return { ok: false, reason: "BUSY", owner: inspection.owner };
      }
      if (inspection.state === "DEAD_OWNER") {
        if (checkOrphanChild && inspection.owner.jdtlsPid !== undefined && this.deps.isAlive(inspection.owner.jdtlsPid)) {
          return { ok: false, reason: "ORPHAN_CHILD_ALIVE", owner: inspection.owner };
        }
        this.reclaimDir(dir);
        this.staleLeaseReclaims += 1;
      } else if (inspection.state === "METADATA_LESS") {
        if (this.deps.now() - inspection.createdAtMs < this.deps.orphanGraceMs) {
          return { ok: false, reason: "BUSY" };
        }
        this.reclaimDir(dir);
        this.staleLeaseReclaims += 1;
      }
      // ABSENT (a benign race: the directory vanished between our failed
      // mkdir and this inspection) falls straight through to the retry below.
      if (!this.tryMkdir(dir)) {
        // Lost the reclaim/creation race to a concurrent process.
        const reinspect = this.inspectLeaseDir(dir);
        return reinspect.state === "LIVE"
          ? { ok: false, reason: "BUSY", owner: reinspect.owner }
          : { ok: false, reason: "BUSY" };
      }
    }
    const owner = this.makeOwner(identity);
    this.writeMetadataAtomic(dir, owner);
    return { ok: true, handle: this.makeHandle(dir, kind, owner) };
  }

  private tryMkdir(dir: string): boolean {
    try {
      mkdirSync(dir);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  /** Removes a lease directory left by a confirmed-dead or too-old-to-trust owner. */
  private reclaimDir(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
  }

  private inspectLeaseDir(dir: string): LeaseInspection {
    if (!existsSync(dir)) return { state: "ABSENT" };
    const owner = this.readOwner(dir);
    if (!owner) {
      return { state: "METADATA_LESS", createdAtMs: statSync(dir).ctimeMs };
    }
    return this.deps.isAlive(owner.pid) ? { state: "LIVE", owner } : { state: "DEAD_OWNER", owner };
  }

  private readOwner(dir: string): LeaseOwner | undefined {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, "metadata.json"), "utf8"));
      if (typeof parsed?.ownerToken !== "string" || typeof parsed?.pid !== "number") return undefined;
      return parsed as LeaseOwner;
    } catch {
      return undefined;
    }
  }

  private writeMetadataAtomic(dir: string, owner: LeaseOwner): void {
    const target = path.join(dir, "metadata.json");
    const tmp = path.join(dir, `.metadata.json.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(owner));
    renameSync(tmp, target);
  }

  private makeOwner(identity?: WorktreeIdentity): LeaseOwner {
    const now = new Date(this.deps.now()).toISOString();
    return {
      ownerToken: randomUUID(),
      pid: this.deps.pid,
      repoRoot: identity?.repoRoot ?? "",
      repoHash: identity?.repoHash ?? "",
      familyHash: identity?.familyHash,
      acquiredAt: now,
      heartbeatAt: now
    };
  }

  private makeHandle(dir: string, kind: LeaseHandle["kind"], owner: LeaseOwner): LeaseHandle {
    let released = false;
    const handle: LeaseHandle = {
      kind,
      path: dir,
      owner,
      heartbeat: async () => {
        if (released) return;
        const current = this.readOwner(dir);
        if (!current || current.ownerToken !== owner.ownerToken) return;
        this.writeMetadataAtomic(dir, { ...current, heartbeatAt: new Date(this.deps.now()).toISOString() });
      },
      release: async () => {
        if (released) return;
        released = true;
        // Reread-and-confirm: never delete a directory reclaimed by another
        // process (or one we already reclaimed) out from under a new owner.
        const current = this.readOwner(dir);
        if (current && current.ownerToken !== owner.ownerToken) return;
        rmSync(dir, { recursive: true, force: true });
      }
    };
    return handle;
  }

  private async acquireCapacityLock(lockDir: string): Promise<void> {
    const deadline = this.deps.now() + this.deps.capacityLockTimeoutMs;
    for (;;) {
      if (this.tryMkdir(lockDir)) {
        this.writeMetadataAtomic(lockDir, this.makeOwner());
        return;
      }
      const inspection = this.inspectLeaseDir(lockDir);
      if (inspection.state === "DEAD_OWNER") {
        this.reclaimDir(lockDir);
        continue;
      }
      if (inspection.state === "METADATA_LESS" && this.deps.now() - inspection.createdAtMs >= this.deps.orphanGraceMs) {
        this.reclaimDir(lockDir);
        continue;
      }
      if (this.deps.now() >= deadline) {
        throw new Error("timed out waiting for capacity.lock");
      }
      await delay(10);
    }
  }

  private releaseCapacityLock(lockDir: string): void {
    rmSync(lockDir, { recursive: true, force: true });
  }

  private readCapacityFile(): { state: "ABSENT" } | { state: "VALID"; value: CapacityFile } | { state: "CORRUPT" } {
    const file = path.join(this.root, "capacity.json");
    if (!existsSync(file)) return { state: "ABSENT" };
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed?.jdtSlots !== "number" || typeof parsed?.sweepSlots !== "number") {
        return { state: "CORRUPT" };
      }
      return { state: "VALID", value: parsed as CapacityFile };
    } catch {
      return { state: "CORRUPT" };
    }
  }

  private publishCapacity(requested: { jdtSlots: number; sweepSlots: number }): void {
    const file: CapacityFile = {
      schemaVersion: CAPACITY_SCHEMA_VERSION,
      jdtSlots: requested.jdtSlots,
      sweepSlots: requested.sweepSlots,
      updatedAt: new Date(this.deps.now()).toISOString()
    };
    const target = path.join(this.root, "capacity.json");
    const tmp = path.join(this.root, `.capacity.json.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(file));
    renameSync(tmp, target);
    this.jdtSlots = requested.jdtSlots;
    this.sweepSlots = requested.sweepSlots;
  }

  /** Scans a flat (one-level) lease root, reclaiming dead/stale entries. */
  private anyLiveLeaseExists(): boolean {
    // jdt-worktree is the only root that can hold an ORPHAN_JDT entry (a dead
    // owner whose recorded jdtlsPid is still alive); that fail-closed rule
    // must apply here too, or capacity negotiation would reclaim the very
    // lease tryAcquireJdt refuses to touch.
    if (this.scanFlatRootForLive(path.join(this.root, "jdt-worktree"), true)) return true;
    if (this.scanFlatRootForLive(path.join(this.root, "jdt-slots"), false)) return true;
    if (this.scanFlatRootForLive(path.join(this.root, "sweep-slots"), false)) return true;
    return this.hasAnyRuntimeLease();
  }

  private scanFlatRootForLive(root: string, checkOrphanChild: boolean): boolean {
    if (!existsSync(root)) return false;
    let anyLive = false;
    for (const name of this.listDirs(root)) {
      const dir = path.join(root, name);
      const inspection = this.inspectLeaseDir(dir);
      if (inspection.state === "LIVE") {
        anyLive = true;
      } else if (inspection.state === "DEAD_OWNER") {
        if (checkOrphanChild && inspection.owner.jdtlsPid !== undefined && this.deps.isAlive(inspection.owner.jdtlsPid)) {
          anyLive = true;
          continue;
        }
        this.reclaimDir(dir);
        this.staleLeaseReclaims += 1;
      } else if (inspection.state === "METADATA_LESS" && this.deps.now() - inspection.createdAtMs >= this.deps.orphanGraceMs) {
        this.reclaimDir(dir);
        this.staleLeaseReclaims += 1;
      }
    }
    return anyLive;
  }

  private hasAnyRuntimeLease(): boolean {
    const runtimeRoot = path.join(this.root, "runtime");
    if (!existsSync(runtimeRoot)) return false;
    for (const family of this.listDirs(runtimeRoot)) {
      const familyDir = path.join(runtimeRoot, family);
      for (const repoHash of this.listDirs(familyDir)) {
        const repoDir = path.join(familyDir, repoHash);
        for (const entry of this.listDirs(repoDir)) {
          if (this.inspectLeaseDir(path.join(repoDir, entry)).state === "LIVE") return true;
        }
      }
    }
    return false;
  }

  private countLiveIn(root: string): number {
    if (!existsSync(root)) return 0;
    return this.listDirs(root).filter(name => this.inspectLeaseDir(path.join(root, name)).state === "LIVE").length;
  }

  private listDirs(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
    } catch {
      return [];
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

// input: canonical workspace roots, their native change signals, and read requests.
// output: one owner per daemon: a SnapshotStore, the BuildScheduler, the persistent
//         QueryPool, and one tracker-driven WorkspaceIndex per workspace.
// pos: MAC-08 production index lifecycle (contract §2.4-§2.7). A round is dispatch →
//      verify → noop-confirm or build → publish → complete; requests never build,
//      they prepare for at most min(1000 ms, remaining) and then hold one snapshot. MAC-09: the
//      owner's GC runs one sweep at open (recovery of a dead incarnation) and then every cycle.
import type { ChildProcess } from "node:child_process";
import { stat, statfs } from "node:fs/promises";
import path from "node:path";
import { builderJobFor, startBuildProcess, type BuilderHeartbeat } from "../../index-builder/build-process.js";
import { BuildScheduler, DELTA_CLOSURE_LIMIT, type BuildAttempt, type BuildGrant, type BuildHint, type BuildSelection } from "../../index-builder/build-scheduler.js";
import type { BuilderJob } from "../../index-builder/incremental.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";
import { isLinkedWorktreeRoot } from "../../worktree-identity.js";
import { computeExtractorVersion } from "../build-fingerprint.js";
import type { ContentEntry } from "../sql/snapshot-manifest.js";
import type { WorkspaceBinding } from "./binding.js";
import { builderFullReason, type FullBuildReason } from "./publication-history.js";
import type { QueryOpName, QueryOps, QueryRequest, SnapshotIndexStatus } from "./query-ops.js";
import { QueryPool, type QueryCompletion } from "./query-pool.js";
import { queryOpTask, spawnQueryWorker } from "./query-process.js";
import type { FaultHook, SealTimings } from "./seal.js";
import { SnapshotStore, type BuildJob, type LeasePurpose, type SnapshotLease, type SweepReport } from "./snapshot-store.js";
import { SnapshotVerifier, type VerificationEvent } from "./snapshot-verifier.js";
import { nativeTrackerSource, rebase, WorkspaceTracker, type TrackerSourceFactory, type TrackerStatus, type TrackerVerification } from "./workspace-tracker.js";

/** The freshness label a request view freezes at its one acquire. */
export type ViewState = "FRESH" | "STALE" | "NOT_READY";

/** A publish that moved a workspace to another snapshot (never emitted for a verified noop). */
export type PublishEvent = {
  workspaceId: string;
  canonicalRoot: string;
  snapshotId: string;
  previousSnapshotId?: string;
  indexedGeneration: number;
  /** Workspace-relative members whose content changed or that were removed by this publish. */
  changed: readonly string[];
  deleted: readonly string[];
  buildKeyChanged: boolean;
};

/** What a round did, for lifecycle telemetry: the plan kind, its size and the snapshot it bound. */
export type RoundDetail = {
  kind?: "noop" | "seed-bind" | "full" | "delta" | "rescan";
  /** The sibling snapshot a workspace without a binding of its own was judged against (seed). */
  seedFrom?: string;
  changed?: number;
  deleted?: number;
  hashed?: number;
  statted?: number;
  snapshotId?: string;
  bindingVersion?: number;
  /** Epoch ms of the binding commit. */
  boundAt?: number;
  /** The builder's captured content differs from the tracker's verified census (the binding is the builder's; a later round reconciles). */
  censusDiverged?: boolean;
  /** Owner-side stage wall times (ms): verify, sibling seed scan, base clone, scheduler submit (queue + build), publish (seal + bind). */
  timings?: { verifyMs?: number; seedMs?: number; cloneMs?: number; buildMs?: number; publishMs?: number; seal?: SealTimings };
};

export type OwnerEvent =
  | ({ type: "round"; workspaceId: string; mode: string; outcome: "noop" | "published" | "failed"; elapsedMs: number; error?: string } & RoundDetail)
  /** One request's freshness prepare: `none` when nothing was owed at entry; `covered` once the entry-time hints are committed. */
  | { type: "prepare"; workspaceId: string; waitedMs: number; outcome: "none" | "covered" | "capped" | "backoff" | "aborted" | "stopped" }
  | { type: "reclaimed"; snapshotId: string }
  /** One GC cycle; `error` when the cycle stopped early (its deletions so far stand). */
  | { type: "sweep"; report?: SweepReport; elapsedMs: number; error?: string }
  | { type: "pool"; event: unknown }
  | { type: "scheduler"; event: unknown }
  /** A builder's liveness line (contract §2.6), at most one per second. */
  | { type: "builder"; workspaceId: string; pid?: number; beat: BuilderHeartbeat }
  /** Diagnosis only: a live builder whose work counter has not moved for STALL_DIAGNOSIS_MS. Its job deadline still decides termination. */
  | { type: "stall"; workspaceId: string; pid?: number; stage: string; work: number; sinceMs: number }
  /** A background full verification of a published snapshot (contract §2.7, plan B). */
  | VerificationEvent;

export type IndexOwnerOptions = {
  /** The owner cache root; the store lives in `<cacheRoot>/mac1`. */
  cacheRoot: string;
  /** Before every binding write or deletion (assertOwnerLock). */
  assertOwner?: () => void;
  /** Fault seam at every store boundary (clone, checkpoint, seal, binding, reclaim). */
  faultAt?: FaultHook;
  /** Static admission for builder and query slots. */
  admitted?: () => boolean;
  /** Called once the store restored its bindings, before any cycle, build or query (opens static admission); throwing fails the open. */
  restored?: () => void;
  spawnQueryWorker?: () => ChildProcess;
  /** Test seam: the builder process for an admitted job. */
  startBuild?: (input: BuildStart) => BuildAttempt;
  /** Test seam: the change source for a workspace (default: the native FSEvents helper). */
  trackerSource?: (canonicalRoot: string) => TrackerSourceFactory;
  onEvent?: (event: OwnerEvent) => void;
  /** Signals are coalesced this long before a round is dispatched. */
  roundDelayMs?: number;
  /** Test seam: stall a query's worker this long (a stuck native step) before it answers. */
  queryTestBlockMs?: (request: QueryRequest) => number | undefined;
  /** stop() waits this long for workspace starts still in flight (default START_STOP_GRACE_MS). */
  startStopGraceMs?: number;
  /** One GC cycle (default GC_CYCLE_MS); unreferenced objects converge within two cycles. */
  gcCycleMs?: number;
  /** SnapshotStoreOptions.renumberedGraceMs (default RENUMBERED_GRACE_MS): pinned workspaces start and seed-bind in it. */
  renumberedGraceMs?: number;
  /**
   * false: no GC cycle, neither at open nor periodic. Without the owner lock nothing proves that the
   * store's other jobs and unbound snapshots belong to a dead incarnation rather than to a live
   * process (contract §2.1 opens snapshot GC only under the lock); this owner's own superseded
   * snapshots still go once nothing binds or leases them.
   */
  gc?: boolean;
  /** Test seam: the trackers' periodic full-hash interval (default FULL_HASH_INTERVAL_MS). */
  fullHashIntervalMs?: number;
  /** Quiet time before a published snapshot's background verification (default VERIFY_DELAY_MS). */
  verifyDelayMs?: number;
  /** No build starts while the cache volume has less free space than this (default MIN_FREE_BYTES; 0 disables). */
  minFreeBytes?: number;
  worktreeIdle?: {
    mode: "observe" | "enforce";
    /** A fresh, exact-path decision. Unknown config must return false. */
    isUnpinned: (canonicalRoot: string) => boolean;
    /** Test seam for the idle clock, not the request budget. */
    now?: () => number;
  };
};

type BuildStart = { repoRoot: string; dbPath: string; job: BuilderJob; grant: BuildGrant; onHeartbeat?: (beat: BuilderHeartbeat) => void };

/** A builder phase without real progress this long is reported for diagnosis (contract §2.6). */
export const STALL_DIAGNOSIS_MS = 30_000;
/** Freshness prepare never waits longer than this (contract §2.6). */
export const PREPARE_CAP_MS = 1_000;
const ROUND_DELAY_MS = 25;
/** The first retry after a failed round; each further failure without new owed work doubles it. */
export const ROUND_RETRY_MS = 1_000;
/** The retry backoff never grows past this: a persistent failure costs one round per five minutes. */
export const ROUND_RETRY_MAX_MS = 5 * 60 * 1000;
/**
 * Below this much free space on the cache volume no job is created: a full build or a clone could
 * fill the disk the user works on. Retained seed snapshots are released first. statfs's f_bavail does
 * not count APFS purgeable space, so the floor is kept low: it stops a build on a nearly full volume,
 * it is not a capacity estimate.
 */
export const MIN_FREE_BYTES = 512 * 1024 * 1024;
/** The initial GC cycle (contract §2.7). */
export const GC_CYCLE_MS = 30_000;
/**
 * Deltas a workspace's lineage takes before its next build is a full one (JAVA_LSP_MAX_DELTA_LINEAGE,
 * 0 disables). Conservative: there is no full-versus-delta comparison data yet to tune it.
 */
export const DEFAULT_MAX_DELTA_LINEAGE = 256;
function maxDeltaLineage(): number {
  const raw = process.env.JAVA_LSP_MAX_DELTA_LINEAGE?.trim() ?? "";
  return /^\d{1,9}$/.test(raw) ? Number(raw) : DEFAULT_MAX_DELTA_LINEAGE;
}
/**
 * After open, how long a binding whose root only changed device number survives the GC: long enough
 * for pinned workspaces to start (one at a time) and seed-bind their old snapshot under the new
 * workspaceId. A pin whose start falls after it (earlier pins needing real builds, each prewarm waits up
 * to 5 min) rebuilds in full, as before. Such a binding converges in this window plus one cycle, an
 * exception to the two-cycle bound (deletion safety is unchanged: tryReclaim still decides). Volume
 * UUIDs in the workspace identity would remove the need (deferred).
 */
export const RENUMBERED_GRACE_MS = 10 * 60_000;
export const WORKTREE_IDLE_MS = 48 * 60 * 60 * 1000;
const WORKTREE_GC_BATCH = 8;
type IdleObservation = { idleSince: number; observedAt?: number; lastAccessAt?: number; dirty: boolean };

export function idleWorktreeBatch<T>(candidates: readonly T[], cursor: number): { batch: T[]; cursor: number } {
  if (candidates.length === 0) return { batch: [], cursor: 0 };
  const start = cursor % candidates.length;
  const count = Math.min(WORKTREE_GC_BATCH, candidates.length);
  const batch = Array.from({ length: count }, (_, index) => candidates[(start + index) % candidates.length]!);
  return { batch, cursor: (start + count) % candidates.length };
}
/**
 * A native change source that never reports ready is killed by its 5 s ready timer and settles only
 * after the helper is reaped. stop() waits that long, so a pre-ready helper holding the owner lock fd
 * is not left behind by an owner that exits right after stop() (contract §2.6: no release before reap).
 */
const START_STOP_GRACE_MS = 6_000;
/** Internal reads (the verification base) are bounded too. */
const INTERNAL_QUERY_MS = 60_000;
/** A request waits this long for an FSEvents fence before freezing its label (flushSignals). */
const REQUEST_FENCE_WAIT_MS = 200;
/** A workspace without a compatible binding judges at most this many sibling snapshots. */
export const MAX_SEED_CANDIDATES = 16;

type SnapshotContent = { entries: Map<string, ContentEntry>; status: SnapshotIndexStatus };
/** A leased sibling snapshot used as a candidate base; the caller releases the lease. */
type SeedBase = SnapshotContent & { snapshotId: string; lease: SnapshotLease };

/** Bytes an unprivileged writer may still use on the volume holding `directory`; undefined if unknown. */
async function freeBytes(directory: string): Promise<number | undefined> {
  try {
    const info = await statfs(directory);
    return Number(info.bavail) * Number(info.bsize);
  } catch { return undefined; }
}

/** Query errors only a damaged database file explains (SQLITE_CORRUPT, SQLITE_NOTADB and their messages). */
const SQLITE_DAMAGE = /SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i;

function queryError(completion: Exclude<QueryCompletion<unknown>, { status: "ok" }>, op: string): JavaIntelligenceError {
  if (completion.status === "deadline") return new JavaIntelligenceError("DEADLINE_EXCEEDED", `Deadline exceeded during ${op}`);
  if (completion.status === "cancelled") return new JavaIntelligenceError("CANCELLED", `Cancelled during ${op}`);
  return new JavaIntelligenceError("INDEX_PARTIAL", `${op} ${completion.status}${completion.error ? `: ${completion.error}` : ""}`);
}

export class IndexOwner {
  readonly store: SnapshotStore;
  readonly scheduler: BuildScheduler;
  readonly pool: QueryPool<unknown>;
  readonly verifier: SnapshotVerifier;
  private readonly workspaces = new Map<string, WorkspaceIndex>();
  private readonly starting = new Map<string, Promise<WorkspaceIndex>>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly requests = new Map<string, number>();
  // A throttled write cannot prove that the previous process recorded its last read.
  // Start a fresh monotonic grace period on first confirmation after each owner open.
  private readonly idleObservations = new Map<string, IdleObservation>();
  private idleCursor = 0;
  private idleResults: Array<{ workspaceId: string; outcome: string }> = [];
  private readonly byId = new Map<string, WorkspaceIndex>();
  private readonly superseded = new Set<string>();
  /** Sealed snapshots never change: their content is read once (bounded, oldest first out). */
  private readonly contents = new Map<string, Promise<SnapshotContent>>();
  private readonly publishListeners = new Set<(event: PublishEvent) => void>();
  private sweepTimer?: NodeJS.Timeout;
  private sweeping?: Promise<SweepReport | undefined>;
  private stopped = false;

  private constructor(store: SnapshotStore, readonly options: IndexOwnerOptions) {
    this.store = store;
    this.scheduler = new BuildScheduler({
      admitted: options.admitted,
      select: hint => this.selectBuild(hint),
      onEvent: event => options.onEvent?.({ type: "scheduler", event })
    });
    this.pool = new QueryPool<unknown>({
      admitted: options.admitted,
      spawn: options.spawnQueryWorker ?? (() => spawnQueryWorker()),
      // A worker keeps a connection only to a bound snapshot; older ones are closed so they can be reclaimed.
      retain: snapshotId => [...this.byId.values()].some(workspace => store.binding(workspace.workspaceId)?.snapshotId === snapshotId),
      onEvent: event => options.onEvent?.({ type: "pool", event })
    });
    this.verifier = new SnapshotVerifier(store, {
      ...(options.verifyDelayMs !== undefined ? { delayMs: options.verifyDelayMs } : {}),
      onEvent: event => options.onEvent?.(event),
      // The binding is quarantined (NOT_READY): the workspace rebuilds in full, never on that base.
      onFailed: workspaceIds => { for (const id of workspaceIds) this.byId.get(id)?.verificationFailed(); },
      // A verify lease went: a superseded snapshot may be deletable now.
      onSettled: () => void this.reclaim()
    });
  }

  static async open(options: IndexOwnerOptions): Promise<IndexOwner> {
    const { store } = await SnapshotStore.open(options.cacheRoot, { assertOwner: options.assertOwner, faultAt: options.faultAt,
      renumberedGraceMs: options.renumberedGraceMs ?? RENUMBERED_GRACE_MS });
    options.restored?.();
    const owner = new IndexOwner(store, options);
    // Recovery: what a dead incarnation left (jobs, unbound snapshots, tmp) goes in the first cycle.
    if (options.gc !== false) void owner.sweep();
    // Served but never fully verified (a delta publish before a restart): checked in the background.
    for (const snapshotId of store.unverifiedBound()) owner.verifier.enqueue(snapshotId);
    return owner;
  }

  /** The workspace index if one runs for this root. Pure: never starts a tracker or a build. */
  peek(canonicalRoot: string): WorkspaceIndex | undefined {
    return this.retiring.has(canonicalRoot) ? undefined : this.workspaces.get(canonicalRoot);
  }

  list(): WorkspaceIndex[] {
    return [...this.workspaces.values()];
  }

  /** Every publish of every workspace this owner runs, including ones started later. */
  onPublished(listener: (event: PublishEvent) => void): () => void {
    this.publishListeners.add(listener);
    return () => this.publishListeners.delete(listener);
  }

  /** @internal WorkspaceIndex reports its publishes here. */
  published(event: PublishEvent): void {
    if (!this.store.verification(event.snapshotId)) this.verifier.enqueue(event.snapshotId);
    for (const listener of this.publishListeners) {
      try { listener(event); } catch { /* a consumer failure never undoes a publish */ }
    }
  }

  /**
   * Stop one workspace's tracker and forget it. Its binding stays: a later workspace() starts a new
   * tracker whose first round verifies that binding (a noop when nothing changed).
   */
  retire(canonicalRoot: string): Promise<void> {
    return this.retiring.get(canonicalRoot)
      ?? this.claimRetirement(canonicalRoot, () => this.stopWorkspace(canonicalRoot))
      ?? Promise.resolve();
  }

  /** Reserves admission synchronously, or returns a wait without reserving anything. */
  admitRequest(canonicalRoot: string): (() => void) | Promise<void> {
    const retiring = this.retiring.get(canonicalRoot);
    if (retiring) return retiring;
    this.requests.set(canonicalRoot, (this.requests.get(canonicalRoot) ?? 0) + 1);
    return () => {
      const count = this.requests.get(canonicalRoot)!;
      if (count === 1) this.requests.delete(canonicalRoot);
      else this.requests.set(canonicalRoot, count - 1);
    };
  }

  private claimRetirement(canonicalRoot: string, action: () => Promise<void>): Promise<void> | undefined {
    if (this.retiring.has(canonicalRoot) || this.starting.has(canonicalRoot) || this.requests.has(canonicalRoot)) return;
    const pending = Promise.resolve().then(action).finally(() => this.retiring.delete(canonicalRoot));
    this.retiring.set(canonicalRoot, pending);
    return pending;
  }

  private async stopWorkspace(canonicalRoot: string): Promise<void> {
    const workspace = this.workspaces.get(canonicalRoot);
    if (!workspace) return;
    // The current round may still need the store queue and the scheduler's byId entry.
    await workspace.stop();
    this.workspaces.delete(canonicalRoot);
    this.byId.delete(workspace.workspaceId);
    this.store.untrack(workspace.workspaceId, workspace.trackerEpoch);
    this.pool.trim();
  }

  /** The workspace index for this root, starting its tracker (and so its first round) once. */
  workspace(canonicalRoot: string): Promise<WorkspaceIndex> {
    if (this.stopped) return Promise.reject(new JavaIntelligenceError("INDEX_PARTIAL", "index owner stopped"));
    const retiring = this.retiring.get(canonicalRoot);
    if (retiring) return retiring.then(() => this.workspace(canonicalRoot));
    const running = this.workspaces.get(canonicalRoot);
    if (running) return Promise.resolve(running);
    const pending = this.starting.get(canonicalRoot);
    if (pending) return pending;
    const started = WorkspaceIndex.start(this, canonicalRoot).then(async workspace => {
      // A start that outlived stop() is not adopted: its tracker is stopped here instead.
      if (this.stopped) {
        await workspace.stop();
        throw new JavaIntelligenceError("INDEX_PARTIAL", "index owner stopped");
      }
      this.workspaces.set(canonicalRoot, workspace);
      this.byId.set(workspace.workspaceId, workspace);
      return workspace;
    }).finally(() => this.starting.delete(canonicalRoot));
    this.starting.set(canonicalRoot, started);
    return started;
  }

  noteStaticRead(workspaceId: string): void {
    if (!this.options.worktreeIdle || !this.store.binding(workspaceId)) return;
    const previous = this.idleObservations.get(workspaceId);
    this.idleObservations.set(workspaceId, { observedAt: previous?.observedAt,
      idleSince: this.idleNow(), lastAccessAt: Date.now(), dirty: true });
  }

  private idleNow(): number {
    return this.options.worktreeIdle?.now?.() ?? performance.now();
  }

  private async sweepIdleWorktrees(): Promise<string[]> {
    const policy = this.options.worktreeIdle;
    if (!policy) return [];
    const bindings = this.store.boundWorkspaces();
    for (const id of this.idleObservations.keys()) {
      if (!this.store.binding(id)) this.idleObservations.delete(id);
    }
    const candidates = bindings.filter(binding => {
      const seen = this.idleObservations.get(binding.workspaceId);
      return seen?.observedAt === undefined || seen.dirty || this.idleNow() - seen.idleSince >= WORKTREE_IDLE_MS;
    });
    const results: typeof this.idleResults = [];
    const removed: string[] = [];
    this.idleResults = results;
    const { batch, cursor } = idleWorktreeBatch(candidates, this.idleCursor);
    this.idleCursor = cursor;
    for (const binding of batch) {
      if (this.stopped) break;
      const { workspaceId, root: { canonicalRoot } } = binding;
      if (!policy.isUnpinned(canonicalRoot) || !await isLinkedWorktreeRoot(canonicalRoot)) continue;
      // A query can complete during Git I/O. Use its current observation after the await.
      let seen = this.idleObservations.get(workspaceId);
      if (seen?.observedAt === undefined) {
        seen = { idleSince: this.idleNow(), observedAt: Date.now(), lastAccessAt: seen?.lastAccessAt, dirty: true };
        this.idleObservations.set(workspaceId, seen);
      }
      if (seen.dirty) {
        try {
          await this.store.writeIdleObservation(workspaceId, { observedAt: seen.observedAt!, lastAccessAt: seen.lastAccessAt });
          seen.dirty = false;
        } catch {
          results.push({ workspaceId, outcome: "observation-write-failed" });
          continue;
        }
      }
      const eligible = () => {
        const current = this.idleObservations.get(workspaceId);
        return !this.stopped && current?.observedAt !== undefined && !current.dirty
          && this.idleNow() - current.idleSince >= WORKTREE_IDLE_MS && policy.isUnpinned(canonicalRoot);
      };
      if (!eligible()) continue;
      if (policy.mode === "observe") {
        results.push({ workspaceId, outcome: "eligible" });
        continue;
      }
      if (this.workspaces.get(canonicalRoot)?.roundInFlight) {
        results.push({ workspaceId, outcome: "in-flight" });
        continue;
      }
      const retired = this.claimRetirement(canonicalRoot, async () => {
        await this.stopWorkspace(canonicalRoot);
        if (!await isLinkedWorktreeRoot(canonicalRoot)) {
          results.push({ workspaceId, outcome: "root-unconfirmed" });
          return;
        }
        const result = await this.store.reclaimExpired({ binding, stillEligible: eligible });
        results.push({ workspaceId, outcome: result.reclaimed ? "unbound" : result.reason });
        if (result.reclaimed) {
          removed.push(workspaceId);
          this.idleObservations.delete(workspaceId);
        }
      });
      if (!retired) results.push({ workspaceId, outcome: "active" });
      else await retired.catch(() => { results.push({ workspaceId, outcome: "cleanup-failed" }); });
    }
    return removed;
  }

  /** One read on `snapshotId` through the query pool; the task holds its own query-worker lease. */
  async query<K extends QueryOpName>(snapshotId: string, request: QueryRequest<K>, budget: DeadlineBudget, signal?: AbortSignal): Promise<QueryOps[K]["result"]> {
    const testBlockMs = this.options.queryTestBlockMs?.(request);
    const completion = await this.pool.submit(queryOpTask({
      request, budget, signal, ...(testBlockMs ? { allowTestHooks: true, testBlockMs } : {}),
      acquire: async () => {
        const lease = this.store.acquire(snapshotId, "query-worker");
        try { await this.options.faultAt?.("query-leased"); } catch (error) { lease.release(); throw error; }
        return lease;
      }
    }) as never) as QueryCompletion<QueryOps[K]["result"]>;
    if (completion.status !== "ok") {
      // A verified snapshot that reads as damaged is checked again rather than served errors until the next edit.
      if (completion.status === "error" && SQLITE_DAMAGE.test(completion.error ?? "") && this.store.doubtVerified(snapshotId)) {
        this.verifier.enqueue(snapshotId);
      }
      throw queryError(completion, request.op);
    }
    return completion.value;
  }

  acquireBound(workspaceId: string, purpose: LeasePurpose = "request"): { lease: SnapshotLease; binding: WorkspaceBinding } | undefined {
    return this.store.acquireBound(workspaceId, purpose);
  }

  /** A sealed snapshot's captured content and status, read once through the pool. The caller holds a lease on it. */
  content(snapshotId: string): Promise<SnapshotContent> {
    const cached = this.contents.get(snapshotId);
    if (cached) return cached;
    const budget = DeadlineBudget.fromTimeout(INTERNAL_QUERY_MS);
    const read = Promise.all([
      this.query(snapshotId, { op: "contentEntries", args: {} }, budget),
      this.query(snapshotId, { op: "status", args: {} }, budget)
    ]).then(([rows, status]) => ({ entries: new Map(rows.map(row => [row.path, row])), status }));
    this.contents.set(snapshotId, read);
    read.catch(() => { if (this.contents.get(snapshotId) === read) this.contents.delete(snapshotId); });
    while (this.contents.size > MAX_SEED_CANDIDATES) this.contents.delete(this.contents.keys().next().value!);
    return read;
  }

  /**
   * Seed (contract §2.7): for a workspace without a compatible binding, the sibling snapshot under the
   * same buildKey whose content differs least from this capture, judged by hash. It is returned under a
   * candidate-scan lease, so no publish or GC can reclaim it before it is bound or cloned.
   */
  async seedFor(workspaceId: string, verification: TrackerVerification): Promise<SeedBase | undefined> {
    const buildKey = verification.round.buildKey;
    let best: (SeedBase & { size: number }) | undefined;
    for (const snapshotId of this.store.seedCandidates(workspaceId, buildKey, verification.round.root).slice(0, MAX_SEED_CANDIDATES)) {
      let lease: SnapshotLease | undefined;
      try { lease = this.store.acquire(snapshotId, "candidate-scan"); } catch { continue; } // being reclaimed: not a base
      try {
        const content = await this.content(snapshotId);
        const judged = rebase(verification, { entries: content.entries, buildKey });
        const size = judged.changed.length + judged.deleted.length;
        if (!best || size < best.size) {
          best?.lease.release();
          best = { ...content, snapshotId, lease, size };
          lease = undefined;
        }
      } catch { /* unreadable: not a base */ } finally { lease?.release(); }
      if (best?.size === 0) break;
    }
    return best;
  }

  /**
   * A superseded snapshot is deleted once nothing binds or leases it: now if it can be, else by the sweep.
   * With `retainFor` (the workspace left it on a checkout-sized switch) it is first kept as that
   * workspace's retained seed; the retained seed it displaces is deleted instead.
   */
  supersede(snapshotId: string, retainFor?: { workspaceId: string; buildKey: string }): void {
    if (retainFor) for (const evicted of this.store.retainSeed(snapshotId, retainFor.workspaceId, retainFor.buildKey)) this.superseded.add(evicted);
    this.superseded.add(snapshotId);
    this.pool.trim();
    void this.reclaim();
  }

  /**
   * Fails when the cache volume is below its free-space floor, or below `expectedBytes` (the build's
   * estimated peak) when that is larger, even after every retained seed went.
   * An unreadable volume is not judged: the build goes ahead as before.
   */
  /** Whether the cache volume has `bytes` free (and the floor) now, releasing nothing; unknown counts as yes. */
  async hasDiskHeadroom(bytes: number): Promise<boolean> {
    const configured = this.options.minFreeBytes ?? MIN_FREE_BYTES;
    if (configured <= 0) return true;
    return (await freeBytes(this.store.cacheRoot) ?? Infinity) >= Math.max(configured, bytes);
  }

  async ensureDiskHeadroom(expectedBytes = 0): Promise<void> {
    const configured = this.options.minFreeBytes ?? MIN_FREE_BYTES;
    if (configured <= 0) return;
    const floor = Math.max(configured, expectedBytes);
    if ((await freeBytes(this.store.cacheRoot) ?? Infinity) >= floor) return;
    for (const snapshotId of this.store.releaseRetained()) this.superseded.add(snapshotId);
    await this.reclaim();
    const free = await freeBytes(this.store.cacheRoot) ?? Infinity;
    if (free < floor) throw new Error(`insufficient disk space: ${free} bytes free on the index cache volume, ${floor} required`);
  }

  /** Fast path for superseded snapshots (a lease just went); the periodic sweep covers every other object. */
  async reclaim(): Promise<void> {
    for (const snapshotId of [...this.superseded]) {
      const result = await this.store.tryReclaim({ snapshotId }).catch(() => ({ reclaimed: false as const, reason: "leased" as const }));
      // A retained seed leaves this set; if it is displaced later, supersede() or the sweep takes it.
      if (result.reclaimed || result.reason === "missing" || result.reason === "bound" || result.reason === "retained") {
        this.superseded.delete(snapshotId);
        if (result.reclaimed) this.options.onEvent?.({ type: "reclaimed", snapshotId });
      }
    }
  }

  /**
   * One GC cycle, then the next one is armed. Cycles never overlap; none runs before static
   * admission opens or after stop(). Every deletion is the store's own tryReclaim decision.
   */
  sweep(): Promise<SweepReport | undefined> {
    if (this.options.gc === false) return Promise.resolve(undefined);
    if (this.sweeping) return this.sweeping;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
    const started = performance.now();
    const run = (async () => {
      if (this.stopped || (this.options.admitted && !this.options.admitted())) return undefined;
      try {
        const expired = await this.sweepIdleWorktrees();
        const report = await this.store.sweep();
        report.workspaces.unshift(...expired);
        for (const snapshotId of report.snapshots) this.superseded.delete(snapshotId);
        this.options.onEvent?.({ type: "sweep", report, elapsedMs: performance.now() - started });
        return report;
      } catch (error) {
        this.options.onEvent?.({ type: "sweep", elapsedMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    })().finally(() => {
      this.sweeping = undefined;
      if (this.stopped) return;
      this.sweepTimer = setTimeout(() => void this.sweep(), this.options.gcCycleMs ?? GC_CYCLE_MS);
      this.sweepTimer.unref();
    });
    this.sweeping = run;
    return run;
  }

  private selectBuild(hint: Readonly<BuildHint>): BuildSelection {
    const workspace = this.byId.get(hint.workspaceId);
    if (!workspace) throw new Error(`unknown workspace ${hint.workspaceId}`);
    return workspace.selection(hint);
  }

  startBuild(input: BuildStart): BuildAttempt {
    return (this.options.startBuild ?? startBuildProcess)(input);
  }

  status() {
    return { workspaces: this.list().map(workspace => workspace.status()), scheduler: this.scheduler.status(), pool: this.pool.status(), poolCounters: this.pool.counters(),
      verifier: this.verifier.status(), superseded: this.superseded.size, gcCycleMs: this.options.gcCycleMs ?? GC_CYCLE_MS,
      ...(this.options.worktreeIdle ? { worktreeIdle: { mode: this.options.worktreeIdle.mode, lastSweep: [...this.idleResults] } } : {}) };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    // Bounded: a start that lands stops its own tracker; one that never comes up cannot hold stop past the grace.
    const starts = [...this.starting.values()].map(pending => pending.then(() => undefined, () => undefined));
    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<void>(resolve => { graceTimer = setTimeout(resolve, this.options.startStopGraceMs ?? START_STOP_GRACE_MS); });
    // Together: a round waiting on a builder or a query ends when the scheduler and pool stop.
    await Promise.all([...this.list().filter(workspace => !this.retiring.has(workspace.canonicalRoot)).map(workspace => workspace.stop()),
      this.scheduler.stop(), this.pool.stop(), this.verifier.stop(),
      Promise.race([Promise.all(starts), grace]).finally(() => clearTimeout(graceTimer)), this.sweeping, ...this.retiring.values()]);
  }
}

/** `buildKey`: what the round captured; the builder refuses to spend a build on other inputs. */
/** The bound snapshot as a round reads it: its census, status and recorded build inputs. */
type BaseView = { snapshotId: string; entries: Map<string, ContentEntry>; status: SnapshotIndexStatus; inputs: QueryOps["buildInputs"]["result"] };

type PreparedJob = { job: BuildJob; baseId?: string; buildKey: string; buildInputsMoved?: boolean };

export class WorkspaceIndex {
  readonly workspaceId: string;
  private round?: Promise<void>;
  private timer?: NodeJS.Timeout;
  /** Fires when the periodic full hash falls due; re-armed after every round. */
  private hashTimer?: NodeJS.Timeout;
  private stopped = false;
  private prepared?: PreparedJob;
  private base?: BaseView;
  /** The census of the snapshot this workspace last published, when it equals the verified one (F11). */
  private publishedEntries?: { snapshotId: string; entries: ReadonlyMap<string, ContentEntry> };
  private readonly listeners = new Set<(event: PublishEvent) => void>();
  private readonly settled = new Set<() => void>();
  private lastError?: string;
  /** The last delta ran out its job deadline: the next round is a full. */
  private fullNext?: "delta-deadline" | "verification-failed";
  private rounds = 0;
  private lastRound?: { outcome: string; at: number; elapsedMs: number };
  /** Consecutive rounds that failed or published a census the tracker did not verify; 0 after a clean round. */
  private setbacks = 0;
  /** The tracker's workMark the current setback already saw: only work owed after it cuts a backoff short. */
  private setbackWorkMark = 0;
  /** When the armed round timer fires (performance.now()). */
  private timerDueAt = 0;

  private constructor(private readonly owner: IndexOwner, readonly canonicalRoot: string, readonly tracker: WorkspaceTracker) {
    this.workspaceId = tracker.workspaceId;
  }

  get trackerEpoch(): string { return this.tracker.trackedState().trackerEpoch; }
  get roundInFlight(): boolean { return this.round !== undefined; }

  static async start(owner: IndexOwner, canonicalRoot: string): Promise<WorkspaceIndex> {
    let index: WorkspaceIndex | undefined;
    const source = (owner.options.trackerSource ?? nativeTrackerSource)(canonicalRoot);
    const tracker = await WorkspaceTracker.start({
      canonicalRoot,
      // A signal is only a hint: it schedules the next round.
      source: (onSignal, onResume) => source((flags, file) => { onSignal(flags, file); index?.signalled(); }, () => { onResume(); index?.signalled(); }),
      onInvalidRoot: () => { if (index) owner.store.track(index.workspaceId, tracker.trackedState()); },
      // A new tracker (idle reopen, daemon restart) continues its binding's generation: the store refuses any plan below
      // it, so starting at 1 after a build-input change would reject every round of this workspace for good.
      workspaceGeneration: workspaceId => owner.store.binding(workspaceId)?.workspaceGeneration,
      ...(owner.options.fullHashIntervalMs ? { fullHashIntervalMs: owner.options.fullHashIntervalMs } : {})
    });
    index = new WorkspaceIndex(owner, canonicalRoot, tracker);
    owner.store.track(index.workspaceId, tracker.trackedState());
    index.kick(0);
    index.armFullHash();
    return index;
  }

  onPublished(listener: (event: PublishEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  trackerStatus(): TrackerStatus {
    return this.tracker.status();
  }

  /** The label a view acquired now would freeze: no verified binding is NOT_READY, never a sibling. */
  viewState(binding: WorkspaceBinding | undefined): ViewState {
    if (!binding) return "NOT_READY";
    return this.tracker.status() === "FRESH" && !this.round ? "FRESH" : "STALE";
  }

  status() {
    const binding = this.owner.store.binding(this.workspaceId);
    return { workspaceId: this.workspaceId, canonicalRoot: this.canonicalRoot, tracker: this.tracker.status(), view: this.viewState(binding),
      snapshotId: binding?.snapshotId, bindingVersion: binding?.bindingVersion, coveredThroughSeq: binding?.coveredThroughSeq,
      ...(binding ? { verified: this.owner.store.isVerified(binding.snapshotId) } : {}),
      roundInFlight: Boolean(this.round), rounds: this.rounds, lastRound: this.lastRound, ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.setbacks ? { setbacks: this.setbacks, retryInMs: this.timer ? Math.max(0, Math.round(this.timerDueAt - performance.now())) : undefined } : {}) };
  }

  /**
   * Bounded freshness prepare (before the request's one acquire): wait for rounds that cover the
   * hints known at entry for at most min(1000 ms, remaining). It never cancels the shared round.
   */
  async prepare(budget: DeadlineBudget, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    // Half the remaining time at most: a short request still answers from its binding (STALE) instead of timing out in prepare.
    const cap = budget.forStage(Math.max(1, Math.min(PREPARE_CAP_MS, Math.floor(budget.remainingMs() / 2))));
    // A save just before this request may still sit in FSEvents' latency window: flushed first, so a
    // FRESH label is never frozen over a change the stream already holds. Bounded by the same cap.
    if (this.tracker.status() === "FRESH" && !this.round) await this.flushSignals(cap, signal);
    // Only the hints known at entry: one that lands while this request waits never extends its wait.
    // A due periodic full hash is owed like a resume (requireDueFullHash advances the seq), so a request
    // arriving while it is owed waits for it like any hint, within the same cap.
    const epoch = this.tracker.trackerEpoch;
    const known = this.tracker.currentSeq;
    const owedAtEntry = this.tracker.status() === "STALE";
    const owed = () => this.tracker.status() === "STALE" && !this.tracker.confirmedThrough(epoch, known);
    const outcome = owedAtEntry ? await this.waitFor(owed, cap, signal) : "none";
    // The round that covered the entry hints fenced at its dispatch; a save after that fence and before
    // this request may still be in the latency window. A signal it delivers makes the view STALE.
    if (outcome === "covered" && this.tracker.status() === "FRESH" && !this.round) await this.flushSignals(cap, signal);
    this.owner.options.onEvent?.({ type: "prepare", workspaceId: this.workspaceId, waitedMs: performance.now() - started, outcome });
  }

  private async waitFor(owed: () => boolean, cap: DeadlineBudget, signal?: AbortSignal): Promise<"covered" | "capped" | "backoff" | "aborted" | "stopped"> {
    for (;;) {
      if (this.stopped) return "stopped";
      if (signal?.aborted) return "aborted";
      if (!owed()) return "covered";
      if (cap.expired()) return "capped";
      if (!this.round) {
        // A failed or diverging round's retry backoff stands: answer from the binding instead of forcing or awaiting the retry.
        if (this.retryDelay() !== undefined && this.timer) return "backoff";
        this.kick(0);
      }
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.settled.delete(done); signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, cap.remainingMs());
        this.settled.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  /**
   * At most REQUEST_FENCE_WAIT_MS of the request's cap: a healthy fence returns in milliseconds, and one
   * that does not (a helper slow under load, or stuck) keeps running in the background, shared by later
   * requests, while this one answers with the label it has, as it did before fences existed.
   */
  private async flushSignals(cap: DeadlineBudget, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || cap.expired()) return;
    let timer: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;
    try {
      await Promise.race([
        // A failed fence is the stream's own failure: the next dispatch restarts it; this request just answers.
        this.tracker.flush().catch(() => undefined),
        new Promise<void>(resolve => {
          wake = () => resolve();
          timer = setTimeout(wake, Math.min(cap.remainingMs(), REQUEST_FENCE_WAIT_MS));
          signal?.addEventListener("abort", wake, { once: true });
        })
      ]);
    } finally {
      clearTimeout(timer);
      if (wake) signal?.removeEventListener("abort", wake);
    }
  }

  /**
   * The delay before the next round while a setback stands, undefined when none does. A failure backs
   * off exponentially (ROUND_RETRY_MS doubling up to ROUND_RETRY_MAX_MS); a first census divergence
   * reconciles at once and only a repeated one backs off. Work owed since the setback (an edit that
   * may be the fix) retries after ROUND_RETRY_MS at most.
   */
  private retryDelay(): number | undefined {
    const failures = this.lastError ? this.setbacks : this.setbacks - 1;
    if (failures <= 0) return undefined;
    const backoff = Math.min(ROUND_RETRY_MAX_MS, ROUND_RETRY_MS * 2 ** Math.min(failures - 1, 20));
    return this.tracker.workMark > this.setbackWorkMark ? Math.min(backoff, ROUND_RETRY_MS) : backoff;
  }

  /**
   * A native signal or wake. Without a setback it schedules a round as before; during one only newly
   * owed work may cut the backoff short, and never to less than ROUND_RETRY_MS, so writes the index
   * does not track (target/, IDE files) cannot drive a failing workspace into a retry loop.
   */
  signalled(): void {
    if (this.retryDelay() === undefined) { this.kick(); return; }
    if (this.tracker.workMark <= this.setbackWorkMark) return;
    this.kick(Math.max(ROUND_RETRY_MS, this.owner.options.roundDelayMs ?? ROUND_DELAY_MS));
  }

  /** The periodic full hash: owed when due, so the next round hashes every file and the view is STALE meanwhile. */
  private armFullHash(): void {
    if (this.hashTimer) clearTimeout(this.hashTimer);
    this.hashTimer = undefined;
    if (this.stopped) return;
    const dueAt = this.tracker.fullHashDueAt();
    // Until the startup hash confirms there is no due time: the round after it re-arms this.
    if (!Number.isFinite(dueAt)) return;
    this.hashTimer = setTimeout(() => {
      this.hashTimer = undefined;
      if (this.tracker.requireDueFullHash()) this.kick(0);
      // Already owed (or the root is invalid): the round that settles it re-arms this; only an early fire waits again.
      else if (Date.now() < this.tracker.fullHashDueAt()) this.armFullHash();
    }, Math.max(0, dueAt - Date.now()));
    this.hashTimer.unref?.();
  }

  /** Schedule a round soon; rounds never overlap. The earliest due time wins over a timer already armed. */
  kick(delayMs = this.owner.options.roundDelayMs ?? ROUND_DELAY_MS): void {
    if (this.stopped || this.round) return;
    const dueAt = performance.now() + delayMs;
    if (this.timer) {
      if (dueAt >= this.timerDueAt) return;
      clearTimeout(this.timer);
    }
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || this.round || !this.tracker.hasWork()) return;
      this.round = this.runRound().finally(() => {
        this.round = undefined;
        for (const done of [...this.settled]) done();
        if (this.stopped) return;
        this.armFullHash();
        if (this.lastError || this.tracker.hasWork()) this.kick(this.retryDelay());
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async runRound(): Promise<void> {
    const started = performance.now();
    const store = this.owner.store;
    let mode = "dispatch";
    let round;
    try {
      round = await this.tracker.dispatch({ bindingVersion: store.bindingVersionOf(this.workspaceId) });
    } catch (error) {
      store.track(this.workspaceId, this.tracker.trackedState());
      if (error instanceof Error && /event stream lost/.test(error.message)) await this.tracker.restartStream().catch(() => undefined);
      this.finish("failed", mode, started, error);
      return;
    }
    mode = round.mode;
    store.track(this.workspaceId, this.tracker.trackedState());
    let seed: SeedBase | undefined;
    let hint: BuildHint | undefined;
    const detail: RoundDetail = {};
    const timings: NonNullable<RoundDetail["timings"]> = {};
    const timed = async <T>(name: Exclude<keyof typeof timings, "seal">, work: () => Promise<T>): Promise<T> => {
      const at = performance.now();
      try { return await work(); } finally { timings[name] = performance.now() - at; detail.timings = timings; }
    };
    try {
      // Fault seam: a dispatched round of a known mode, not yet confirmed (the workspace is not FRESH).
      await this.owner.options.faultAt?.(`round-${mode}`);
      const bound = store.binding(this.workspaceId);
      const own = bound ? await this.baseOf(bound.snapshotId) : undefined;
      const againstOwn = await timed("verifyMs", () => this.tracker.verify(round, own && { entries: own.entries, buildKey: bound!.buildKey }));
      const keyChanged = Boolean(bound) && bound!.buildKey !== round.buildKey;
      let verification = againstOwn;
      const ownDiff = againstOwn.changed.length + againstOwn.deleted.length;
      // A difference the own base cannot take as a delta (a branch switch) may be small against a
      // sibling's or a retained snapshot: judged by hash like any seed, used only if it is smaller.
      const tooFar = Boolean(bound) && !keyChanged && !this.fullNext && ownDiff > DELTA_CLOSURE_LIMIT;
      // A switch of that size (a checkout, whose branches often differ in build files too): the snapshot
      // left behind is retained as a seed under its own buildKey, so switching back binds or deltas from
      // it. An ordinary edit's superseded snapshot is deleted as before.
      const switched = Boolean(bound) && ownDiff > DELTA_CLOSURE_LIMIT;
      if (!bound || keyChanged || tooFar) {
        seed = await timed("seedMs", () => this.owner.seedFor(this.workspaceId, verification));
        if (seed) {
          const judged = rebase(verification, { entries: seed.entries, buildKey: round.buildKey });
          if (tooFar && judged.changed.length + judged.deleted.length >= ownDiff) {
            seed.lease.release();
            seed = undefined;
          } else verification = judged;
        }
      }
      Object.assign(detail, { changed: verification.changed.length, deleted: verification.deleted.length, hashed: verification.hashed,
        statted: verification.statted, ...(seed ? { seedFrom: seed.snapshotId } : {}) });
      if (verification.noop) {
        // Zero diff: the own binding only moves its watermark; a seed binds the sibling's snapshot after a full manifest/file check.
        const plan = this.tracker.planFor(verification);
        const binding = seed ? await timed("publishMs", () => store.bindVerified(plan, seed!.snapshotId, {
          indexedGeneration: seed!.status.indexedGeneration, plannedMode: "seed-bind",
          actualBuildMode: "none", comparisonBaseSnapshotId: seed!.snapshotId
        })) : await store.confirmNoop(plan);
        this.tracker.complete(round, binding);
        Object.assign(detail, { kind: seed ? "seed-bind" : "noop", snapshotId: binding.snapshotId, bindingVersion: binding.bindingVersion, boundAt: Date.now() });
        this.finish("noop", mode, started, undefined, detail);
        if (seed) {
          this.base = undefined;
          this.announce({ workspaceId: this.workspaceId, canonicalRoot: this.canonicalRoot, snapshotId: binding.snapshotId,
            ...(bound ? { previousSnapshotId: bound.snapshotId } : {}), indexedGeneration: seed.status.indexedGeneration,
            changed: bound ? againstOwn.changed : [], deleted: bound ? againstOwn.deleted : [], buildKeyChanged: keyChanged });
          if (bound) this.owner.supersede(bound.snapshotId, switched ? { workspaceId: this.workspaceId, buildKey: bound.buildKey } : undefined);
        }
        return;
      }
      const baseId = seed?.snapshotId ?? bound?.snapshotId;
      // Census members only (Java sources, resource XML): a path delta reads exactly these; anything else rescans.
      const pathsOnly = [...verification.changed, ...verification.deleted].every(file => file.endsWith(".java") || file.endsWith(".xml"));
      const generation = Math.max(own?.status.indexedGeneration ?? 0, seed?.status.indexedGeneration ?? 0) + 1;
      const files = verification.changed.length + verification.deleted.length;
      // Changed build inputs on the own base (a seed is already under this round's key): a rescan delta
      // marked buildInputsMoved when the base recorded this round's layout and this extractor (a pom
      // dependency bump, a comment), decided here so a full is not first cloned, warmed and escalated.
      // The builder re-checks the same record and escalates if it no longer holds.
      let inputsRebuilt = false;
      if (keyChanged && !seed && baseId && !this.fullNext && files <= DELTA_CLOSURE_LIMIT) {
        const recorded = own!.inputs;
        inputsRebuilt = !recorded.schemaCompatible || recorded.layoutFingerprint !== round.layoutFingerprint
          || recorded.extractorVersion !== computeExtractorVersion();
      }
      // An explicit full on an empty job: no base; a difference above the delta closure limit (a seed's or the
      // workspace's own: the closure holds at least the changed files); build inputs the base's facts depend
      // on changed (above); or the previous delta ran out its job deadline (a misjudged small job goes to the
      // full queue, never back into a delta slot).
      // A long delta lineage on the own base is rebuilt in full: no runtime check proves a delta equals a
      // full build (docs/review-2026-11-11-architecture.md F2), so drift is bounded by this many deltas.
      // A seed's depth is not read (seeds are rare; the next round on the own base counts it).
      // The base's size: the disk estimate below (F12). A lineage full is optional: it waits for room
      // rather than refusing every round (a delta clones the base and needs only its size).
      const baseBytes = baseId ? await stat(this.owner.store.snapshotPath(baseId)).then(info => info.size, () => 0) : 0;
      const lineageCapped = !seed && Boolean(own) && maxDeltaLineage() > 0 && own!.inputs.deltaDepth >= maxDeltaLineage()
        && await this.owner.hasDiskHeadroom(2 * baseBytes);
      const fullReason: FullBuildReason | undefined = this.fullNext ?? (!baseId ? "no-base"
        : files > DELTA_CLOSURE_LIMIT ? "input-limit" : inputsRebuilt ? "build-key-changed" : lineageCapped ? "lineage-limit" : undefined);
      const chosen: BuildHint = fullReason ? { workspaceId: this.workspaceId, kind: "full", generation }
        : (seed || round.mode === "paths") && pathsOnly
          ? { workspaceId: this.workspaceId, kind: "delta", generation, changed: verification.changed, deleted: verification.deleted }
          : { workspaceId: this.workspaceId, kind: "delta", generation, rescan: true };
      hint = chosen;
      const plannedMode = chosen.kind === "full" ? "full" : chosen.rescan ? "rescan" : "delta";
      detail.kind = plannedMode;
      // Before anything is spent or forgotten: a refused build keeps fullNext owed for its retry.
      // A full build holds its uncommitted pages in the WAL (one job transaction): about twice the base's
      // size at peak; a delta clones the base. The base's size is the estimate (F12); unknown means the floor.
      await this.owner.ensureDiskHeadroom(chosen.kind === "full" ? 2 * baseBytes : baseBytes);
      if (chosen.kind === "full") this.fullNext = undefined;
      const cloned = chosen.kind === "full" ? undefined : baseId;
      // The own base under the previous buildKey (a seed is already under this round's key).
      const buildInputsMoved = keyChanged && Boolean(cloned) && !seed;
      const job = await store.createJob({ workspaceId: this.workspaceId, captureId: round.captureId });
      try {
        if (cloned && !seed) {
          const baseLease = store.acquire(cloned, "base");
          try { await timed("cloneMs", () => store.cloneBase(baseLease, job)); } finally { baseLease.release(); }
        } else if (cloned) await timed("cloneMs", () => store.cloneBase(seed!.lease, job));
        seed?.lease.release();
        seed = undefined;
        this.prepared = { job, baseId: cloned, buildKey: round.buildKey, ...(buildInputsMoved ? { buildInputsMoved: true } : {}) };
        const completion = await timed("buildMs", () => this.owner.scheduler.submit(chosen));
        const built = completion.result?.contentManifestId;
        if (!completion.ok || !built) throw new Error(completion.error ?? "builder reported no content identity");
        if (built !== verification.contentManifestId) detail.censusDiverged = true;
        const binding = await timed("publishMs", () => store.publish(this.tracker.planFor(verification, built), job, {
          indexedGeneration: completion.result?.indexedGeneration ?? generation,
          plannedMode, actualBuildMode: completion.result?.stages?.mode ?? completion.buildKind ?? chosen.kind,
          comparisonBaseSnapshotId: baseId,
          fullReason: completion.escalationReason === undefined ? fullReason : builderFullReason(completion.escalationReason)
        })).finally(() => {
          if (job.sealTimings) timings.seal = job.sealTimings;
        });
        let seenThrough: number | undefined;
        if (detail.censusDiverged) {
          // The self-consistent builder capture is usable, but it did not verify this round's
          // census. Keep its hints and watermark owed, including changes with no native signal.
          // Work owed before this round settled is seen; the full hash owed here is not new work, so
          // a census that keeps diverging backs off (retryDelay) instead of rehashing in a loop.
          const workBefore = this.tracker.workMark;
          this.tracker.abandon(round);
          this.tracker.resume();
          seenThrough = workBefore > round.workMark ? round.workMark : this.tracker.workMark;
        } else this.tracker.complete(round, binding);
        this.base = undefined;
        // The census the builder published is the one this round verified (same content identity):
        // the next round's base takes it from here instead of reading every row back through the pool.
        this.publishedEntries = detail.censusDiverged ? undefined : { snapshotId: binding.snapshotId, entries: verification.entries };
        Object.assign(detail, { snapshotId: binding.snapshotId, bindingVersion: binding.bindingVersion, boundAt: Date.now() });
        this.finish("published", mode, started, undefined, detail, seenThrough);
        this.announce({ workspaceId: this.workspaceId, canonicalRoot: this.canonicalRoot, snapshotId: binding.snapshotId,
          ...(bound ? { previousSnapshotId: bound.snapshotId } : {}), indexedGeneration: completion.result?.indexedGeneration ?? generation,
          changed: bound ? againstOwn.changed : verification.changed, deleted: bound ? againstOwn.deleted : verification.deleted,
          buildKeyChanged: keyChanged });
        if (bound && bound.snapshotId !== binding.snapshotId) {
          this.owner.supersede(bound.snapshotId, switched ? { workspaceId: this.workspaceId, buildKey: bound.buildKey } : undefined);
        }
      } finally {
        this.prepared = undefined;
        if (job.state !== "FINISHED") store.finishJob(job);
        void store.tryReclaim({ jobId: job.jobId }).catch(() => undefined);
      }
    } catch (error) {
      // Nothing is cleared: the old binding keeps serving, every hint stays owed.
      if (hint?.kind === "delta" && error instanceof Error && /deadline exceeded/.test(error.message)) this.fullNext = "delta-deadline";
      this.tracker.abandon(round);
      store.track(this.workspaceId, this.tracker.trackedState());
      this.finish("failed", mode, started, error, detail, round.workMark);
    } finally {
      seed?.lease.release();
    }
  }

  private announce(event: PublishEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* a consumer failure never undoes a publish */ }
    }
    this.owner.published(event);
  }

  /** `seenThrough`: the tracker workMark this round already accounted for (a setback is cut short only by work owed after it). */
  private finish(outcome: "noop" | "published" | "failed", mode: string, started: number, error?: unknown, detail: RoundDetail = {},
    seenThrough = this.tracker.workMark): void {
    const elapsedMs = performance.now() - started;
    this.rounds += 1;
    this.lastRound = { outcome, at: Date.now(), elapsedMs };
    this.lastError = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
    if (outcome === "failed" || detail.censusDiverged) {
      this.setbacks += 1;
      this.setbackWorkMark = seenThrough;
    } else this.setbacks = 0;
    this.owner.options.onEvent?.({ type: "round", workspaceId: this.workspaceId, mode, outcome, elapsedMs, ...detail,
      ...(this.lastError ? { error: this.lastError } : {}) });
  }

  /** The bound snapshot's captured content and status, read once per snapshot through the pool. */
  private async baseOf(snapshotId: string): Promise<BaseView> {
    if (this.base?.snapshotId === snapshotId) return this.base;
    const budget = DeadlineBudget.fromTimeout(INTERNAL_QUERY_MS);
    const published = this.publishedEntries?.snapshotId === snapshotId ? this.publishedEntries.entries : undefined;
    const [entries, status, inputs] = await Promise.all([
      published ? Promise.resolve(new Map(published))
        : this.owner.query(snapshotId, { op: "contentEntries", args: {} }, budget).then(rows => new Map(rows.map(row => [row.path, row]))),
      this.owner.query(snapshotId, { op: "status", args: {} }, budget),
      this.owner.query(snapshotId, { op: "buildInputs", args: {} }, budget)
    ]);
    this.base = { snapshotId, entries, status, inputs };
    return this.base;
  }

  /** BuildScheduler admission: the job prepared for this round, on its cloned base (or empty for a full). */
  selection(hint: Readonly<BuildHint>): BuildSelection {
    const prepared = this.prepared;
    if (!prepared) throw new Error(`no prepared job for ${this.workspaceId}`);
    return {
      kind: hint.kind,
      ...(prepared.baseId ? { baseId: prepared.baseId } : {}),
      start: grant => {
        let pid: number | undefined;
        let work = -1;
        let movedAt = performance.now();
        let reported = false;
        const onEvent = this.owner.options.onEvent;
        const attempt = this.owner.startBuild({ repoRoot: this.canonicalRoot, dbPath: prepared.job.dbPath, job: { ...builderJobFor(hint, hint.kind), buildKey: prepared.buildKey,
          ...(prepared.buildInputsMoved ? { buildInputsMoved: true } : {}) }, grant,
          onHeartbeat: beat => {
            const now = performance.now();
            if (beat.work !== work) { work = beat.work; movedAt = now; reported = false; }
            else if (!reported && now - movedAt >= STALL_DIAGNOSIS_MS) {
              reported = true;
              onEvent?.({ type: "stall", workspaceId: this.workspaceId, pid, stage: beat.stage, work: beat.work, sinceMs: now - movedAt });
            }
            onEvent?.({ type: "builder", workspaceId: this.workspaceId, pid, beat });
          } });
        pid = attempt.child.pid;
        return attempt;
      }
    };
  }

  /**
   * The background verifier failed this workspace's snapshot and quarantined its binding (NOT_READY).
   * The next round is a full build: no base, so nothing of the failed snapshot is carried forward.
   */
  verificationFailed(): void {
    this.fullNext = "verification-failed";
    this.base = undefined;
    this.tracker.resume();
    this.owner.store.track(this.workspaceId, this.tracker.trackedState());
    this.kick(0);
  }

  /** Absolute path of a workspace member. */
  absolute(relativePath: string): string {
    return path.join(this.canonicalRoot, relativePath);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.hashTimer) clearTimeout(this.hashTimer);
    for (const done of [...this.settled]) done();
    await this.round?.catch(() => undefined);
    await this.tracker.stop(5000).catch(() => undefined);
  }
}

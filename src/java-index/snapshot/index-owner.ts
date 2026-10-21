// input: canonical workspace roots, their native change signals, and read requests.
// output: one owner per daemon: a SnapshotStore, the BuildScheduler, the persistent
//         QueryPool, and one tracker-driven WorkspaceIndex per workspace.
// pos: MAC-08 production index lifecycle (contract §2.4-§2.7). A round is dispatch →
//      verify → noop-confirm or build → publish → complete; requests never build,
//      they prepare for at most min(1000 ms, remaining) and then hold one snapshot. MAC-09: the
//      owner's GC runs one sweep at open (recovery of a dead incarnation) and then every cycle.
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { builderJobFor, startBuildProcess, type BuilderHeartbeat } from "../../index-builder/build-process.js";
import { BuildScheduler, DELTA_CLOSURE_LIMIT, type BuildAttempt, type BuildGrant, type BuildHint, type BuildSelection } from "../../index-builder/build-scheduler.js";
import type { BuilderJob } from "../../index-builder/incremental.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";
import type { ContentEntry } from "../sql/snapshot-manifest.js";
import type { WorkspaceBinding } from "./binding.js";
import type { QueryOpName, QueryOps, QueryRequest, SnapshotIndexStatus } from "./query-ops.js";
import { QueryPool, type QueryCompletion } from "./query-pool.js";
import { queryOpTask, spawnQueryWorker } from "./query-process.js";
import type { FaultHook, SealTimings } from "./seal.js";
import { SnapshotStore, type BuildJob, type LeasePurpose, type SnapshotLease, type SweepReport } from "./snapshot-store.js";
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
  | { type: "stall"; workspaceId: string; pid?: number; stage: string; work: number; sinceMs: number };

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
  /**
   * false: no GC cycle, neither at open nor periodic. Without the owner lock nothing proves that the
   * store's other jobs and unbound snapshots belong to a dead incarnation rather than to a live
   * process (contract §2.1 opens snapshot GC only under the lock); this owner's own superseded
   * snapshots still go once nothing binds or leases them.
   */
  gc?: boolean;
  /** Test seam: the trackers' periodic full-hash interval (default FULL_HASH_INTERVAL_MS). */
  fullHashIntervalMs?: number;
};

type BuildStart = { repoRoot: string; dbPath: string; job: BuilderJob; grant: BuildGrant; onHeartbeat?: (beat: BuilderHeartbeat) => void };

/** A builder phase without real progress this long is reported for diagnosis (contract §2.6). */
export const STALL_DIAGNOSIS_MS = 30_000;
/** Freshness prepare never waits longer than this (contract §2.6). */
export const PREPARE_CAP_MS = 1_000;
const ROUND_DELAY_MS = 25;
const ROUND_RETRY_MS = 1_000;
/** The initial GC cycle (contract §2.7). */
export const GC_CYCLE_MS = 30_000;
/**
 * A native change source that never reports ready is killed by its 5 s ready timer and settles only
 * after the helper is reaped. stop() waits that long, so a pre-ready helper holding the owner lock fd
 * is not left behind by an owner that exits right after stop() (contract §2.6: no release before reap).
 */
const START_STOP_GRACE_MS = 6_000;
/** Internal reads (the verification base) are bounded too. */
const INTERNAL_QUERY_MS = 60_000;
/** A workspace without a binding judges at most this many sibling snapshots as its seed base. */
export const MAX_SEED_CANDIDATES = 16;

type SnapshotContent = { entries: Map<string, ContentEntry>; status: SnapshotIndexStatus };
/** A leased sibling snapshot a workspace without a binding was judged against; the caller releases the lease. */
type SeedBase = SnapshotContent & { snapshotId: string; lease: SnapshotLease };

function queryError(completion: Exclude<QueryCompletion<unknown>, { status: "ok" }>, op: string): JavaIntelligenceError {
  if (completion.status === "deadline") return new JavaIntelligenceError("DEADLINE_EXCEEDED", `Deadline exceeded during ${op}`);
  if (completion.status === "cancelled") return new JavaIntelligenceError("CANCELLED", `Cancelled during ${op}`);
  return new JavaIntelligenceError("INDEX_PARTIAL", `${op} ${completion.status}${completion.error ? `: ${completion.error}` : ""}`);
}

export class IndexOwner {
  readonly store: SnapshotStore;
  readonly scheduler: BuildScheduler;
  readonly pool: QueryPool<unknown>;
  private readonly workspaces = new Map<string, WorkspaceIndex>();
  private readonly starting = new Map<string, Promise<WorkspaceIndex>>();
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
  }

  static async open(options: IndexOwnerOptions): Promise<IndexOwner> {
    const { store } = await SnapshotStore.open(options.cacheRoot, { assertOwner: options.assertOwner, faultAt: options.faultAt });
    options.restored?.();
    const owner = new IndexOwner(store, options);
    // Recovery: what a dead incarnation left (jobs, unbound snapshots, tmp) goes in the first cycle.
    if (options.gc !== false) void owner.sweep();
    return owner;
  }

  /** The workspace index if one runs for this root. Pure: never starts a tracker or a build. */
  peek(canonicalRoot: string): WorkspaceIndex | undefined {
    return this.workspaces.get(canonicalRoot);
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
    for (const listener of this.publishListeners) {
      try { listener(event); } catch { /* a consumer failure never undoes a publish */ }
    }
  }

  /**
   * Stop one workspace's tracker and forget it. Its binding stays: a later workspace() starts a new
   * tracker whose first round verifies that binding (a noop when nothing changed).
   */
  async retire(canonicalRoot: string): Promise<void> {
    const workspace = this.workspaces.get(canonicalRoot);
    if (!workspace) return;
    this.workspaces.delete(canonicalRoot);
    this.byId.delete(workspace.workspaceId);
    await workspace.stop();
    this.store.untrack(workspace.workspaceId);
    this.pool.trim();
  }

  /** The workspace index for this root, starting its tracker (and so its first round) once. */
  workspace(canonicalRoot: string): Promise<WorkspaceIndex> {
    if (this.stopped) return Promise.reject(new JavaIntelligenceError("INDEX_PARTIAL", "index owner stopped"));
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
    if (completion.status !== "ok") throw queryError(completion, request.op);
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
   * Seed (contract §2.7): for a workspace without a binding of its own, the sibling snapshot under the
   * same buildKey whose content differs least from this capture, judged by hash. It is returned under a
   * candidate-scan lease, so no publish or GC can reclaim it before it is bound or cloned.
   */
  async seedFor(workspaceId: string, verification: TrackerVerification): Promise<SeedBase | undefined> {
    const buildKey = verification.round.buildKey;
    let best: (SeedBase & { size: number }) | undefined;
    for (const snapshotId of this.store.seedCandidates(workspaceId, buildKey).slice(0, MAX_SEED_CANDIDATES)) {
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

  /** A superseded snapshot is deleted once nothing binds or leases it: now if it can be, else by the sweep. */
  supersede(snapshotId: string): void {
    this.superseded.add(snapshotId);
    this.pool.trim();
    void this.reclaim();
  }

  /** Fast path for superseded snapshots (a lease just went); the periodic sweep covers every other object. */
  async reclaim(): Promise<void> {
    for (const snapshotId of [...this.superseded]) {
      const result = await this.store.tryReclaim({ snapshotId }).catch(() => ({ reclaimed: false as const, reason: "leased" as const }));
      if (result.reclaimed || result.reason === "missing" || result.reason === "bound") {
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
        const report = await this.store.sweep();
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
    return { workspaces: this.list().map(workspace => workspace.status()), scheduler: this.scheduler.status(), pool: this.pool.status(),
      superseded: this.superseded.size, gcCycleMs: this.options.gcCycleMs ?? GC_CYCLE_MS };
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
    await Promise.all([...this.list().map(workspace => workspace.stop()), this.scheduler.stop(), this.pool.stop(),
      Promise.race([Promise.all(starts), grace]).finally(() => clearTimeout(graceTimer)), this.sweeping]);
  }
}

type PreparedJob = { job: BuildJob; baseId?: string };

export class WorkspaceIndex {
  readonly workspaceId: string;
  private round?: Promise<void>;
  private timer?: NodeJS.Timeout;
  /** Fires when the periodic full hash falls due; re-armed after every round. */
  private hashTimer?: NodeJS.Timeout;
  private stopped = false;
  private prepared?: PreparedJob;
  private base?: { snapshotId: string; entries: Map<string, ContentEntry>; status: SnapshotIndexStatus };
  private readonly listeners = new Set<(event: PublishEvent) => void>();
  private readonly settled = new Set<() => void>();
  private lastError?: string;
  /** The last delta ran out its job deadline: the next round is a full. */
  private fullNext = false;
  private rounds = 0;
  private lastRound?: { outcome: string; at: number; elapsedMs: number };

  private constructor(private readonly owner: IndexOwner, readonly canonicalRoot: string, readonly tracker: WorkspaceTracker) {
    this.workspaceId = tracker.workspaceId;
  }

  static async start(owner: IndexOwner, canonicalRoot: string): Promise<WorkspaceIndex> {
    let index: WorkspaceIndex | undefined;
    const source = (owner.options.trackerSource ?? nativeTrackerSource)(canonicalRoot);
    const tracker = await WorkspaceTracker.start({
      canonicalRoot,
      // A signal is only a hint: it schedules the next round.
      source: (onSignal, onResume) => source((flags, file) => { onSignal(flags, file); index?.kick(); }, () => { onResume(); index?.kick(); }),
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
      roundInFlight: Boolean(this.round), rounds: this.rounds, lastRound: this.lastRound, ...(this.lastError ? { lastError: this.lastError } : {}) };
  }

  /**
   * Bounded freshness prepare (before the request's one acquire): wait for rounds that cover the
   * hints known at entry for at most min(1000 ms, remaining). It never cancels the shared round.
   */
  async prepare(budget: DeadlineBudget, signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    // Half the remaining time at most: a short request still answers from its binding (STALE) instead of timing out in prepare.
    const cap = budget.forStage(Math.max(1, Math.min(PREPARE_CAP_MS, Math.floor(budget.remainingMs() / 2))));
    // Only the hints known at entry: one that lands while this request waits never extends its wait,
    // and a round that owes no known hint (the periodic full hash) is not waited for.
    const epoch = this.tracker.trackerEpoch;
    const known = this.tracker.currentSeq;
    const owedAtEntry = this.tracker.status() === "STALE";
    const owed = () => this.tracker.status() === "STALE" && !this.tracker.confirmedThrough(epoch, known);
    const outcome = owedAtEntry ? await this.waitFor(owed, cap, signal) : "none";
    this.owner.options.onEvent?.({ type: "prepare", workspaceId: this.workspaceId, waitedMs: performance.now() - started, outcome });
  }

  private async waitFor(owed: () => boolean, cap: DeadlineBudget, signal?: AbortSignal): Promise<"covered" | "capped" | "backoff" | "aborted" | "stopped"> {
    for (;;) {
      if (this.stopped) return "stopped";
      if (signal?.aborted) return "aborted";
      if (!owed()) return "covered";
      if (cap.expired()) return "capped";
      if (!this.round) {
        // A failed round's retry backoff stands: answer from the binding instead of forcing or awaiting the retry.
        if (this.lastError && this.timer) return "backoff";
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

  /** Schedule a round soon; rounds never overlap. */
  kick(delayMs = this.owner.options.roundDelayMs ?? ROUND_DELAY_MS): void {
    if (this.stopped || this.round) return;
    if (this.timer) {
      if (delayMs > 0) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || this.round || !this.tracker.hasWork()) return;
      this.round = this.runRound().finally(() => {
        this.round = undefined;
        for (const done of [...this.settled]) done();
        if (this.stopped) return;
        this.armFullHash();
        if (this.lastError) this.kick(ROUND_RETRY_MS);
        else if (this.tracker.hasWork()) this.kick();
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
      let verification = await timed("verifyMs", () => this.tracker.verify(round, own && { entries: own.entries, buildKey: bound!.buildKey }));
      // No binding of its own: a sibling's sealed snapshot under the same buildKey is the base (seed).
      if (!bound) {
        seed = await timed("seedMs", () => this.owner.seedFor(this.workspaceId, verification));
        if (seed) verification = rebase(verification, { entries: seed.entries, buildKey: round.buildKey });
      }
      Object.assign(detail, { changed: verification.changed.length, deleted: verification.deleted.length, hashed: verification.hashed,
        statted: verification.statted, ...(seed ? { seedFrom: seed.snapshotId } : {}) });
      if (verification.noop) {
        // Zero diff: the own binding only moves its watermark; a seed binds the sibling's snapshot after a full manifest/file check.
        const binding = bound ? await store.confirmNoop(this.tracker.planFor(verification))
          : await store.bindVerified(this.tracker.planFor(verification), seed!.snapshotId);
        this.tracker.complete(round, binding);
        Object.assign(detail, { kind: bound ? "noop" : "seed-bind", snapshotId: binding.snapshotId, bindingVersion: binding.bindingVersion, boundAt: Date.now() });
        this.finish("noop", mode, started, undefined, detail);
        if (!bound) this.announce({ workspaceId: this.workspaceId, canonicalRoot: this.canonicalRoot, snapshotId: binding.snapshotId,
          indexedGeneration: seed!.status.indexedGeneration, changed: [], deleted: [], buildKeyChanged: false });
        return;
      }
      const base = own ?? seed;
      const baseId = bound?.snapshotId ?? seed?.snapshotId;
      const javaOnly = [...verification.changed, ...verification.deleted].every(file => file.endsWith(".java"));
      const generation = (base?.status.indexedGeneration ?? 0) + 1;
      const files = verification.changed.length + verification.deleted.length;
      // An explicit full on an empty job: no base; a difference above the delta closure limit (a seed's or the
      // workspace's own: the closure holds at least the changed files); changed build inputs; or the previous
      // delta ran out its job deadline (a misjudged small job goes to the full queue, never back into a delta slot).
      const fullNext = this.fullNext;
      const keyChanged = Boolean(bound) && bound!.buildKey !== round.buildKey;
      const chosen: BuildHint = !baseId || files > DELTA_CLOSURE_LIMIT || keyChanged || fullNext ? { workspaceId: this.workspaceId, kind: "full", generation }
        : (bound ? round.mode === "paths" : true) && javaOnly && (bound?.buildKey ?? round.buildKey) === round.buildKey
          ? { workspaceId: this.workspaceId, kind: "delta", generation, changed: verification.changed, deleted: verification.deleted }
          : { workspaceId: this.workspaceId, kind: "delta", generation, rescan: true };
      hint = chosen;
      detail.kind = chosen.kind === "full" ? "full" : chosen.rescan ? "rescan" : "delta";
      if (chosen.kind === "full") this.fullNext = false;
      const cloned = chosen.kind === "full" ? undefined : baseId;
      const job = await store.createJob({ workspaceId: this.workspaceId, captureId: round.captureId });
      try {
        if (cloned && bound) {
          const baseLease = store.acquire(bound.snapshotId, "base");
          try { await timed("cloneMs", () => store.cloneBase(baseLease, job)); } finally { baseLease.release(); }
        } else if (cloned) await timed("cloneMs", () => store.cloneBase(seed!.lease, job));
        seed?.lease.release();
        seed = undefined;
        this.prepared = { job, baseId: cloned };
        const completion = await timed("buildMs", () => this.owner.scheduler.submit(chosen));
        const built = completion.result?.contentManifestId;
        if (!completion.ok || !built) throw new Error(completion.error ?? "builder reported no content identity");
        if (built !== verification.contentManifestId) detail.censusDiverged = true;
        const binding = await timed("publishMs", () => store.publish(this.tracker.planFor(verification, built), job)).finally(() => {
          if (job.sealTimings) timings.seal = job.sealTimings;
        });
        if (detail.censusDiverged) {
          // The self-consistent builder capture is usable, but it did not verify this round's
          // census. Keep its hints and watermark owed, including changes with no native signal.
          this.tracker.abandon(round);
          this.tracker.resume();
        } else this.tracker.complete(round, binding);
        this.base = undefined;
        Object.assign(detail, { snapshotId: binding.snapshotId, bindingVersion: binding.bindingVersion, boundAt: Date.now() });
        this.finish("published", mode, started, undefined, detail);
        this.announce({ workspaceId: this.workspaceId, canonicalRoot: this.canonicalRoot, snapshotId: binding.snapshotId,
          ...(bound ? { previousSnapshotId: bound.snapshotId } : {}), indexedGeneration: completion.result?.indexedGeneration ?? generation,
          changed: verification.changed, deleted: verification.deleted, buildKeyChanged: Boolean(bound) && bound!.buildKey !== binding.buildKey });
        if (bound && bound.snapshotId !== binding.snapshotId) this.owner.supersede(bound.snapshotId);
      } finally {
        this.prepared = undefined;
        if (job.state !== "FINISHED") store.finishJob(job);
        void store.tryReclaim({ jobId: job.jobId }).catch(() => undefined);
      }
    } catch (error) {
      // Nothing is cleared: the old binding keeps serving, every hint stays owed.
      if (hint?.kind === "delta" && error instanceof Error && /deadline exceeded/.test(error.message)) this.fullNext = true;
      this.tracker.abandon(round);
      store.track(this.workspaceId, this.tracker.trackedState());
      this.finish("failed", mode, started, error, detail);
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

  private finish(outcome: "noop" | "published" | "failed", mode: string, started: number, error?: unknown, detail: RoundDetail = {}): void {
    const elapsedMs = performance.now() - started;
    this.rounds += 1;
    this.lastRound = { outcome, at: Date.now(), elapsedMs };
    this.lastError = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
    this.owner.options.onEvent?.({ type: "round", workspaceId: this.workspaceId, mode, outcome, elapsedMs, ...detail,
      ...(this.lastError ? { error: this.lastError } : {}) });
  }

  /** The bound snapshot's captured content and status, read once per snapshot through the pool. */
  private async baseOf(snapshotId: string): Promise<{ entries: Map<string, ContentEntry>; status: SnapshotIndexStatus }> {
    if (this.base?.snapshotId === snapshotId) return this.base;
    const budget = DeadlineBudget.fromTimeout(INTERNAL_QUERY_MS);
    const [rows, status] = await Promise.all([
      this.owner.query(snapshotId, { op: "contentEntries", args: {} }, budget),
      this.owner.query(snapshotId, { op: "status", args: {} }, budget)
    ]);
    this.base = { snapshotId, entries: new Map(rows.map(row => [row.path, row])), status };
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
        const attempt = this.owner.startBuild({ repoRoot: this.canonicalRoot, dbPath: prepared.job.dbPath, job: builderJobFor(hint, hint.kind), grant,
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

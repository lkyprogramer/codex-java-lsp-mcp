// input: canonical workspace roots, their native change signals, and read requests.
// output: one owner per daemon: a SnapshotStore, the BuildScheduler, the persistent
//         QueryPool, and one tracker-driven WorkspaceIndex per workspace.
// pos: MAC-08 production index lifecycle (contract §2.4-§2.7). A round is dispatch →
//      verify → noop-confirm or build → publish → complete; requests never build,
//      they prepare for at most min(1000 ms, remaining) and then hold one snapshot.
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { builderJobFor, startBuildProcess } from "../../index-builder/build-process.js";
import { BuildScheduler, type BuildAttempt, type BuildGrant, type BuildHint, type BuildSelection } from "../../index-builder/build-scheduler.js";
import type { BuilderJob } from "../../index-builder/incremental.js";
import { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";
import type { ContentEntry } from "../sql/snapshot-manifest.js";
import type { WorkspaceBinding } from "./binding.js";
import type { QueryOpName, QueryOps, QueryRequest, SnapshotIndexStatus } from "./query-ops.js";
import { QueryPool, type QueryCompletion } from "./query-pool.js";
import { queryOpTask, spawnQueryWorker } from "./query-process.js";
import { SnapshotStore, type BuildJob, type LeasePurpose, type SnapshotLease } from "./snapshot-store.js";
import { nativeTrackerSource, WorkspaceTracker, type TrackerSourceFactory, type TrackerStatus } from "./workspace-tracker.js";

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

export type OwnerEvent =
  | { type: "round"; workspaceId: string; mode: string; outcome: "noop" | "published" | "failed"; elapsedMs: number; error?: string }
  | { type: "reclaimed"; snapshotId: string }
  | { type: "pool"; event: unknown }
  | { type: "scheduler"; event: unknown };

export type IndexOwnerOptions = {
  /** The owner cache root; the store lives in `<cacheRoot>/mac1`. */
  cacheRoot: string;
  /** Before every binding write or deletion (assertOwnerLock). */
  assertOwner?: () => void;
  /** Static admission for builder and query slots. */
  admitted?: () => boolean;
  spawnQueryWorker?: () => ChildProcess;
  /** Test seam: the builder process for an admitted job. */
  startBuild?: (input: { repoRoot: string; dbPath: string; job: BuilderJob; grant: BuildGrant }) => BuildAttempt;
  /** Test seam: the change source for a workspace (default: the native FSEvents helper). */
  trackerSource?: (canonicalRoot: string) => TrackerSourceFactory;
  onEvent?: (event: OwnerEvent) => void;
  /** Signals are coalesced this long before a round is dispatched. */
  roundDelayMs?: number;
  /** Test seam: stall a query's worker this long (a stuck native step) before it answers. */
  queryTestBlockMs?: (request: QueryRequest) => number | undefined;
};

/** Freshness prepare never waits longer than this (contract §2.6). */
export const PREPARE_CAP_MS = 1_000;
const ROUND_DELAY_MS = 25;
const ROUND_RETRY_MS = 1_000;
const RECLAIM_RETRY_MS = 5_000;
/** Internal reads (the verification base) are bounded too. */
const INTERNAL_QUERY_MS = 60_000;

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
  private reclaimTimer?: NodeJS.Timeout;
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
    const { store } = await SnapshotStore.open(options.cacheRoot, { assertOwner: options.assertOwner });
    return new IndexOwner(store, options);
  }

  /** The workspace index if one runs for this root. Pure: never starts a tracker or a build. */
  peek(canonicalRoot: string): WorkspaceIndex | undefined {
    return this.workspaces.get(canonicalRoot);
  }

  list(): WorkspaceIndex[] {
    return [...this.workspaces.values()];
  }

  /** The workspace index for this root, starting its tracker (and so its first round) once. */
  workspace(canonicalRoot: string): Promise<WorkspaceIndex> {
    if (this.stopped) return Promise.reject(new JavaIntelligenceError("INDEX_PARTIAL", "index owner stopped"));
    const running = this.workspaces.get(canonicalRoot);
    if (running) return Promise.resolve(running);
    const pending = this.starting.get(canonicalRoot);
    if (pending) return pending;
    const started = WorkspaceIndex.start(this, canonicalRoot).then(workspace => {
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
      acquire: () => this.store.acquire(snapshotId, "query-worker")
    }) as never) as QueryCompletion<QueryOps[K]["result"]>;
    if (completion.status !== "ok") throw queryError(completion, request.op);
    return completion.value;
  }

  acquireBound(workspaceId: string, purpose: LeasePurpose = "request"): { lease: SnapshotLease; binding: WorkspaceBinding } | undefined {
    return this.store.acquireBound(workspaceId, purpose);
  }

  /** A superseded snapshot is deleted once nothing binds or leases it. */
  supersede(snapshotId: string): void {
    this.superseded.add(snapshotId);
    this.pool.trim();
    void this.reclaim();
  }

  async reclaim(): Promise<void> {
    for (const snapshotId of [...this.superseded]) {
      const result = await this.store.tryReclaim({ snapshotId }).catch(() => ({ reclaimed: false as const, reason: "leased" as const }));
      if (result.reclaimed || result.reason === "missing" || result.reason === "bound") {
        this.superseded.delete(snapshotId);
        if (result.reclaimed) this.options.onEvent?.({ type: "reclaimed", snapshotId });
      }
    }
    if (this.reclaimTimer) clearTimeout(this.reclaimTimer);
    this.reclaimTimer = undefined;
    if (this.superseded.size > 0 && !this.stopped) {
      this.reclaimTimer = setTimeout(() => void this.reclaim(), RECLAIM_RETRY_MS);
      this.reclaimTimer.unref();
    }
  }

  private selectBuild(hint: Readonly<BuildHint>): BuildSelection {
    const workspace = this.byId.get(hint.workspaceId);
    if (!workspace) throw new Error(`unknown workspace ${hint.workspaceId}`);
    return workspace.selection(hint);
  }

  startBuild(input: { repoRoot: string; dbPath: string; job: BuilderJob; grant: BuildGrant }): BuildAttempt {
    return (this.options.startBuild ?? startBuildProcess)(input);
  }

  status() {
    return { workspaces: this.list().map(workspace => workspace.status()), scheduler: this.scheduler.status(), pool: this.pool.status(),
      superseded: this.superseded.size };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reclaimTimer) clearTimeout(this.reclaimTimer);
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all(this.list().map(workspace => workspace.stop()));
    await Promise.all([this.scheduler.stop(), this.pool.stop()]);
  }
}

type PreparedJob = { job: BuildJob; baseId?: string };

export class WorkspaceIndex {
  readonly workspaceId: string;
  private round?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private prepared?: PreparedJob;
  private base?: { snapshotId: string; entries: Map<string, ContentEntry>; status: SnapshotIndexStatus };
  private readonly listeners = new Set<(event: PublishEvent) => void>();
  private readonly settled = new Set<() => void>();
  private lastError?: string;
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
      source: onSignal => source((flags, file) => { onSignal(flags, file); index?.kick(); }),
      onInvalidRoot: () => { if (index) owner.store.track(index.workspaceId, tracker.trackedState()); }
    });
    index = new WorkspaceIndex(owner, canonicalRoot, tracker);
    owner.store.track(index.workspaceId, tracker.trackedState());
    index.kick(0);
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
   * known hints for at most min(1000 ms, remaining). It never cancels the shared round.
   */
  async prepare(budget: DeadlineBudget, signal?: AbortSignal): Promise<void> {
    // Half the remaining time at most: a short request still answers from its binding (STALE) instead of timing out in prepare.
    const cap = budget.forStage(Math.max(1, Math.min(PREPARE_CAP_MS, Math.floor(budget.remainingMs() / 2))));
    while (!this.stopped && !signal?.aborted && !cap.expired() && (this.round || this.tracker.status() === "STALE")) {
      if (!this.round) this.kick(0);
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); this.settled.delete(done); signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, cap.remainingMs());
        this.settled.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
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
    try {
      const bound = store.binding(this.workspaceId);
      const base = bound ? await this.baseOf(bound.snapshotId) : undefined;
      const verification = await this.tracker.verify(round, base && { entries: base.entries, buildKey: bound!.buildKey });
      if (verification.noop) {
        const binding = await store.confirmNoop(this.tracker.planFor(verification));
        this.tracker.complete(round, binding);
        this.finish("noop", mode, started);
        return;
      }
      const javaOnly = [...verification.changed, ...verification.deleted].every(file => file.endsWith(".java"));
      const generation = (base?.status.indexedGeneration ?? 0) + 1;
      const hint: BuildHint = !bound ? { workspaceId: this.workspaceId, kind: "full", generation }
        : round.mode === "paths" && javaOnly && bound.buildKey === round.buildKey
          ? { workspaceId: this.workspaceId, kind: "delta", generation, changed: verification.changed, deleted: verification.deleted }
          : { workspaceId: this.workspaceId, kind: "delta", generation, rescan: true };
      const job = await store.createJob({ workspaceId: this.workspaceId, captureId: round.captureId });
      try {
        if (bound) {
          const baseLease = store.acquire(bound.snapshotId, "base");
          try { await store.cloneBase(baseLease, job); } finally { baseLease.release(); }
        }
        this.prepared = { job, baseId: bound?.snapshotId };
        const completion = await this.owner.scheduler.submit(hint);
        const built = completion.result?.contentManifestId;
        if (!completion.ok || !built) throw new Error(completion.error ?? "builder reported no content identity");
        const binding = await store.publish(this.tracker.planFor(verification, built), job);
        this.tracker.complete(round, binding);
        this.base = undefined;
        this.finish("published", mode, started);
        const event: PublishEvent = { workspaceId: this.workspaceId, canonicalRoot: this.canonicalRoot, snapshotId: binding.snapshotId,
          ...(bound ? { previousSnapshotId: bound.snapshotId } : {}), indexedGeneration: completion.result?.indexedGeneration ?? generation,
          changed: verification.changed, deleted: verification.deleted, buildKeyChanged: Boolean(bound) && bound!.buildKey !== binding.buildKey };
        for (const listener of this.listeners) {
          try { listener(event); } catch { /* a consumer failure never undoes a publish */ }
        }
        if (bound && bound.snapshotId !== binding.snapshotId) this.owner.supersede(bound.snapshotId);
      } finally {
        this.prepared = undefined;
        if (job.state !== "FINISHED") store.finishJob(job);
        void store.tryReclaim({ jobId: job.jobId }).catch(() => undefined);
      }
    } catch (error) {
      // Nothing is cleared: the old binding keeps serving, every hint stays owed.
      this.tracker.abandon(round);
      store.track(this.workspaceId, this.tracker.trackedState());
      this.finish("failed", mode, started, error);
    }
  }

  private finish(outcome: "noop" | "published" | "failed", mode: string, started: number, error?: unknown): void {
    const elapsedMs = performance.now() - started;
    this.rounds += 1;
    this.lastRound = { outcome, at: Date.now(), elapsedMs };
    this.lastError = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
    this.owner.options.onEvent?.({ type: "round", workspaceId: this.workspaceId, mode, outcome, elapsedMs,
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
      start: grant => this.owner.startBuild({ repoRoot: this.canonicalRoot, dbPath: prepared.job.dbPath, job: builderJobFor(hint, hint.kind), grant })
    };
  }

  /** Absolute path of a workspace member. */
  absolute(relativePath: string): string {
    return path.join(this.canonicalRoot, relativePath);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const done of [...this.settled]) done();
    await this.round?.catch(() => undefined);
    await this.tracker.stop(5000).catch(() => undefined);
  }
}

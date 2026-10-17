// input: Resolved repo roots and per-request budgets.
// output: Per-repo runtime contexts whose index reads run on one held snapshot per request.
// pos: Runtime manager (MAC-08B): one context per canonical repoRoot with small LRU/idle control
//      for JDT; the index is the daemon's single IndexOwner (tracker, scheduler, snapshots, query
//      pool). A request prepares for at most min(1000 ms, remaining), acquires once, and keeps
//      that snapshot's labels; it never builds, reconciles or seeds from a sibling.
import os from "node:os";
import path from "node:path";
import { AgentRouter } from "./agent-router/index.js";
import {
  defaultLeaseClockDeps,
  FileCrossProcessLeaseStore,
  type CrossProcessLeaseStatus,
  type CrossProcessLeaseStore,
  type LeaseHandle
} from "./cross-process-lease.js";
import { JdtlsSession, type JdtlsLifecycleState } from "./jdtls-session.js";
import type { JavaIndexStatus } from "./java-index/index-types.js";
import { RouterJavaIndex } from "./java-index/router-java-index.js";
import { IndexOwner, type IndexOwnerOptions, type PublishEvent } from "./java-index/snapshot/index-owner.js";
import {
  NotReadyJavaIndexClient,
  snapshotIndexStatus,
  SnapshotJavaIndexClient,
  withRequestDefaults,
  withRequestView,
  type RequestView,
  type ViewLabels
} from "./java-index/snapshot/request-view.js";
import { probeLayout, type LayoutContext } from "./layout-probe.js";
import { assertOwnerLock, ownerCacheRoot } from "./mac-platform/owner-lock.js";
import { GenerationClock, isStormBatch, type RepoChange, type RepoChangeBatch } from "./repo-generation.js";
import { repoCacheBase } from "./repo-layout.js";
import { RepoResolver, type RepoSelector, type ResolvedRepo } from "./repo-resolver.js";
import {
  DEFAULT_FREEMEM_PRESSURE_BYTES,
  positiveInteger,
  resourceDefaults,
  type ResourceDefaults
} from "./resource-defaults.js";
import { resolveRoutingPolicy } from "./routing-policy.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import {
  createRequestContext,
  defaultDeadlineMs,
  MAX_REQUEST_DEADLINE_MS,
  type RequestContext,
  type RequestFreshnessMode,
  type RequestMode,
  type SemanticPolicy
} from "./runtime/request-context.js";
import { RgRunner } from "./search/rg-runner.js";
import { FileSemanticEdgeStoreV2, type SemanticEdgeStoreV2 } from "./semantic-edge-store.js";
import type { ToolContext } from "./tools/context.js";
import { touchRepoCache, type RepoCacheTouch } from "./worktree-cache-cleanup.js";
import { RuntimeLifecycleGate } from "./runtime-lifecycle-gate.js";
import {
  type RepoOwnershipLease,
  type RepoOwnershipProvider,
  type RepoOwnerTransport
} from "./repo-ownership-lease.js";
import { forceTerminateJdtlsChild } from "./jdtls-session.js";
import { idlePrewarmTracker } from "./agent-router/prewarm-metrics.js";

export type RequestOptionsInput = {
  mode: RequestMode;
  semanticPolicy: SemanticPolicy;
  deadlineMs?: number;
};

/** Per pinned repo: cover one cold full build (lishuedu ~106s) plus sealing. */
const PREWARM_INDEX_MS = 300_000;
const PREWARM_POLL_MS = 250;
/** Held views pin their own runtime; beyond those only the newest snapshots keep router caches. */
const RETAINED_SNAPSHOT_RUNTIMES = 2;

export type ManagedToolContext = ToolContext & {
  repoHash: string;
  rootSource: NonNullable<ToolContext["rootSource"]>;
  aliases: string[];
  layoutProfile: string;
  lsp: ResolvedRepo["lsp"];
};

/** Index reads of one sealed snapshot. Router caches are snapshot-scoped, so a held view is never upgraded. */
type SnapshotRuntime = {
  snapshotId: string;
  status: JavaIndexStatus;
  javaIndexClient: SnapshotJavaIndexClient;
  javaIndex: RouterJavaIndex;
  router: AgentRouter;
  users: number;
  lastUsedAt: number;
};

/** What every router of one repo shares: its layout probe, rg runner and the one semantic edge store file. */
export type SharedRouterState = {
  layout: LayoutContext;
  rgRunner: RgRunner;
  edgeStore: SemanticEdgeStoreV2;
};

/**
 * A slot is held from the moment we decide to start JDT, not from the moment
 * JDT reports READY. STARTING must count, or concurrent requests all pass the
 * capacity check during the asynchronous startup window and oversubscribe.
 */
type LspReservation = "NONE" | "STARTING" | "READY";

type RuntimeEntry = {
  /** The NOT_READY context: session plus a router whose index reads refuse. */
  context: ManagedToolContext;
  generation: GenerationClock;
  shared: SharedRouterState;
  snapshots: Map<string, SnapshotRuntime>;
  refCount: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
  lspReservation: LspReservation;
  unsubscribeLifecycle?: () => void;
  /** Set once `shutdown()` has retired this entry; undefined while active. */
  stoppedAt?: number;
  /**
   * Best-effort: a degraded/unopened lease store must never block runtime
   * creation, so a failed acquire simply leaves this undefined and the repo
   * stays invisible to `activeRuntimeCount()`/janitor protection.
   */
  runtimeLease?: LeaseHandle;
  gate: RuntimeLifecycleGate;
  ownership?: RepoOwnershipLease;
};

type SlotWaiter = {
  entry: RuntimeEntry;
  promise: Promise<void>;
  grant(): void;
  cancel(): void;
};

/** false: no index (unit tests of JDT capacity); every view is NOT_READY. */
export type IndexOwnerSource = false | (() => Promise<IndexOwner>);

type RuntimeManagerOptions = {
  maxActiveRepos: number;
  idleTtlMs: number;
  freememPressureBytes: number;
  pressureIntervalMs: number;
  freemem?: () => number;
  requestTimeoutMs: number;
  maxRetainedStoppedRepos: number;
  transportMode: RepoOwnerTransport;
  /** Pin roots keep their index runtime after JDT idle-stop. */
  isProtectedRepo?: (repoRoot: string) => boolean;
  index?: IndexOwnerSource;
};

/** The daemon's one owner over `<owner cache root>/mac1`; the launcher's lock is checked before every binding write. */
export function defaultIndexOwner(overrides: Partial<IndexOwnerOptions> = {}): () => Promise<IndexOwner> {
  return () => IndexOwner.open({ cacheRoot: ownerCacheRoot() ?? repoCacheBase(), assertOwner: () => assertOwnerLock(), ...overrides });
}

export class RepoRuntimeManager {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly creating = new Map<string, Promise<RuntimeEntry>>();
  private readonly slotWaiters: SlotWaiter[] = [];
  private servicingWaiters = false;
  private readonly options: RuntimeManagerOptions;
  private readonly defaults: ResourceDefaults;

  private leaseReady?: Promise<void>;
  private leaseInitError?: string;
  private pressureTimer?: NodeJS.Timeout;
  private relievingPressure = false;
  private ownerPromise?: Promise<IndexOwner | undefined>;
  private ownerError?: string;
  private unsubscribePublish?: () => void;

  constructor(
    private readonly resolver: Pick<RepoResolver, "resolve">,
    options: Partial<RuntimeManagerOptions> = {},
    runtimeFactory?: (resolved: ResolvedRepo, leases: CrossProcessLeaseStore, shared: SharedRouterState) => ManagedToolContext,
    private readonly ownership?: RepoOwnershipProvider,
    leasesOrTouch: CrossProcessLeaseStore | ((repoRoot: string, extra?: RepoCacheTouch) => void) = createDefaultLeaseStore()
  ) {
    this.defaults = resourceDefaults();
    this.options = {
      maxActiveRepos: positiveInteger(process.env.JAVA_LSP_MAX_ACTIVE_REPOS, this.defaults.maxActiveRepos),
      idleTtlMs: positiveInteger(process.env.JAVA_LSP_IDLE_TTL_MS, this.defaults.idleTtlMs),
      freememPressureBytes: positiveInteger(
        process.env.JAVA_LSP_FREEMEM_PRESSURE_BYTES,
        DEFAULT_FREEMEM_PRESSURE_BYTES
      ),
      pressureIntervalMs: positiveInteger(
        process.env.JAVA_LSP_FREEMEM_PRESSURE_INTERVAL_MS,
        process.env.JAVA_LSP_ISOLATED_VALIDATION === "1" ? 0 : 5000
      ),
      requestTimeoutMs: 120000,
      maxRetainedStoppedRepos: 2,
      transportMode: "stdio",
      ...options
    };
    this.startPressureWatch();
    this.runtimeFactory = runtimeFactory ?? ((resolved, leases, shared) => createRuntime(resolved, leases, shared, this.options.transportMode));
    if (typeof leasesOrTouch === "function" && !isLeaseStore(leasesOrTouch)) {
      this.leases = createDefaultLeaseStore();
    } else {
      this.leases = leasesOrTouch as CrossProcessLeaseStore;
    }
  }

  private readonly runtimeFactory: (resolved: ResolvedRepo, leases: CrossProcessLeaseStore, shared: SharedRouterState) => ManagedToolContext;
  private readonly leases: CrossProcessLeaseStore;

  /**
   * Opens the shared machine-wide capacity once per process (singleflighted).
   * A degraded lease store never blocks server startup: the fast lexical/rg
   * path stays usable, and every subsequent `JdtlsSession.ensureStarted()`
   * naturally fails with LEASE_CONFIG_ERROR (FileCrossProcessLeaseStore's own
   * `assertOpen()` guard), so no separate gate is needed here.
   */
  initialize(): Promise<void> {
    return this.leaseReady ??= this.leases
      .open({
        jdtSlots: this.options.maxActiveRepos,
        sweepSlots: 1
      })
      .catch(error => {
        this.leaseInitError = error instanceof Error ? error.message : String(error);
        console.error(`[codex-java-lsp] cross-process JDT lease store degraded: ${this.leaseInitError}`);
      });
  }

  async leaseStatus(): Promise<CrossProcessLeaseStatus & { initError?: string }> {
    const status = await this.leases.status();
    return { ...status, initError: this.leaseInitError };
  }

  /** The index owner, opened once. A failed open leaves the index NOT_READY with the reason on status. */
  private indexOwner(): Promise<IndexOwner | undefined> {
    if (this.options.index === false) return Promise.resolve(undefined);
    return this.ownerPromise ??= (this.options.index ?? defaultIndexOwner())().then(owner => {
      this.unsubscribePublish = owner.onPublished(event => this.onPublished(event));
      return owner;
    }, error => {
      this.ownerError = error instanceof Error ? error.message : String(error);
      console.error(`[codex-java-lsp] index owner unavailable: ${this.ownerError}`);
      return undefined;
    });
  }

  /** The owner if it is already open; never opens it (status-only). */
  private openedOwner(): Promise<IndexOwner | undefined> {
    return this.ownerPromise ?? Promise.resolve(undefined);
  }

  async contextFor(selector: RepoSelector): Promise<ManagedToolContext> {
    const resolved = await this.resolver.resolve(selector);
    const entry = await this.getOrCreate(resolved);
    this.refreshResource(entry);
    return entry.context;
  }

  /**
   * Start a pinned repo's workspace and wait until it has its own verified binding (or the per-repo
   * budget expires). Does not start JDT. The next pin is not started before this returns, so cold
   * full builds queue in the scheduler instead of all capturing at once.
   */
  async prewarmRepo(selector: RepoSelector, _options: { hydrate?: boolean } = {}): Promise<void> {
    const resolved = await this.resolver.resolve(selector);
    if (!resolved.lsp.enabled) return;
    const entry = await this.getOrCreate(resolved);
    this.refreshResource(entry);
    entry.refCount += 1;
    try {
      const owner = await this.indexOwner();
      if (!owner) return;
      const budget = DeadlineBudget.fromTimeout(PREWARM_INDEX_MS);
      const workspace = await budget.race("prewarm.create", owner.workspace(entry.context.repoRoot));
      while (!owner.store.binding(workspace.workspaceId) && !budget.expired()) {
        await new Promise(resolve => setTimeout(resolve, Math.min(PREWARM_POLL_MS, budget.remainingMs())));
      }
    } catch (error) {
      console.error("[codex-java-lsp] pinned repo prewarm index wait failed", error);
    } finally {
      entry.refCount = Math.max(0, entry.refCount - 1);
      this.scheduleIdleShutdown(entry);
    }
  }

  async withContext<T>(
    selector: RepoSelector,
    handler: (context: ManagedToolContext, request: RequestContext) => Promise<T>,
    options: { mayStartLsp?: boolean; requestOptions?: RequestOptionsInput; signal?: AbortSignal } = {}
  ): Promise<T> {
    const requestOptions = options.requestOptions;
    const budget = this.createRequestBudget(requestOptions);
    const resolved = await budget.race("runtime.repo-resolve", this.resolver.resolve(selector));
    const entry = await this.getOrCreate(resolved, budget);
    this.refreshResource(entry);
    entry.refCount += 1;
    this.clearIdleTimers(entry);
    try {
      const owner = await budget.race("runtime.index-owner", this.indexOwner());
      return await this.withView(entry, owner, budget, options.signal, true, async (context, view) => {
        const request = this.requestContextFor(entry, view, requestOptions, budget);
        if (options.mayStartLsp) {
          idlePrewarmTracker.recordFirstSemanticRequest(resolved.repoRoot);
          await this.reserveLspSlot(entry, request.budget);
        }
        return handler(context, request);
      });
    } finally {
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
      this.releaseUnusedReservation(entry);
      this.scheduleIdleShutdown(entry);
      void this.serviceSlotWaiters();
    }
  }

  /**
   * Status without start (contract §2.6): reads memory only. An unknown repo gets no entry, no
   * workspace, no scan and no build; a known one reports its current labels without preparing.
   */
  async statusOnly<T>(
    selector: RepoSelector,
    handler: (state: { resolved: ResolvedRepo; context?: ManagedToolContext; labels: ViewLabels; javaIndex?: JavaIndexStatus; layout?: LayoutContext }) => Promise<T>,
    options: { deadlineMs?: number; signal?: AbortSignal } = {}
  ): Promise<T> {
    const budget = DeadlineBudget.fromTimeout(Math.min(MAX_REQUEST_DEADLINE_MS, options.deadlineMs ?? defaultDeadlineMs("balanced", "auto")));
    const resolved = await budget.race("status.resolve", this.resolver.resolve(selector));
    const entry = this.runtimes.get(resolved.repoRoot);
    const owner = await this.openedOwner();
    if (!entry || entry.stoppedAt !== undefined || !owner?.peek(resolved.repoRoot)) {
      return handler({ resolved, context: entry?.stoppedAt === undefined ? entry?.context : undefined, labels: { state: "NOT_READY" } });
    }
    this.refreshResource(entry);
    return withRequestView({
      owner, budget, signal: options.signal, start: false, resolve: async () => resolved.repoRoot,
      handler: async view => {
        const runtime = view.snapshotId ? entry.snapshots.get(view.snapshotId) : undefined;
        return handler({ resolved, context: entry.context, labels: view.labels, javaIndex: runtime?.status, layout: entry.shared.layout });
      }
    });
  }

  async withQuery<T>(
    selector: RepoSelector,
    handler: (context: ManagedToolContext, request: RequestContext) => Promise<T>,
    options: { mayStartLsp?: boolean; requestOptions?: RequestOptionsInput } = {}
  ): Promise<T> {
    return this.withContext(selector, async (context, request) => {
      const entry = this.runtimes.get(context.repoRoot);
      if (!entry) {
        return handler(context, request);
      }
      return entry.gate.withQuery(() => handler(context, request), request.budget.remainingMs());
    }, options);
  }

  async withControl<T>(
    selector: RepoSelector,
    handler: (context: ManagedToolContext, request?: RequestContext) => Promise<T>,
    options: { mayStartLsp?: boolean; requestOptions?: RequestOptionsInput } = {}
  ): Promise<T> {
    return this.withContext(selector, async (context, request) => {
      const entry = this.runtimes.get(context.repoRoot);
      if (!entry) {
        return handler(context, request);
      }
      return entry.gate.withControl(() => handler(context, request), request.budget.remainingMs());
    }, options);
  }

  retainedRepoRoots(): Set<string> {
    return new Set(
      [...this.runtimes.entries()]
        .filter(([, entry]) => entry.stoppedAt === undefined)
        .map(([repoRoot]) => repoRoot)
    );
  }

  async forceTerminateOwnedJdtls(deadlineMs = 1000): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(async entry => {
      const session = entry.context.session as JdtlsSession & { forceStop?: (ms: number) => Promise<void> };
      if (typeof session.forceStop === "function") {
        await session.forceStop(deadlineMs);
        return;
      }
      const child = session.status().pid || session.status().startingPid;
      if (child) {
        await forceTerminateJdtlsChild({ pid: child } as never, deadlineMs).catch(() => undefined);
      }
      await session.stop();
    }));
  }

  /** One view for the whole request; the handler sees the context of the snapshot it holds. */
  private withView<T>(
    entry: RuntimeEntry,
    owner: IndexOwner | undefined,
    budget: DeadlineBudget,
    signal: AbortSignal | undefined,
    start: boolean,
    handler: (context: ManagedToolContext, view: RequestView | undefined) => Promise<T>
  ): Promise<T> {
    if (!owner) return handler(entry.context, undefined);
    return withRequestView({
      owner, budget, signal, start, resolve: async () => entry.context.repoRoot,
      handler: async view => {
        const runtime = view.snapshotId ? await this.snapshotRuntime(entry, view) : undefined;
        if (!runtime) return handler(entry.context, view);
        runtime.users += 1;
        runtime.lastUsedAt = Date.now();
        try {
          const context: ManagedToolContext = { ...entry.context, javaIndexClient: runtime.javaIndexClient, javaIndex: runtime.javaIndex, router: runtime.router };
          // Reads that carry no explicit options still run under this request's deadline and signal.
          return await withRequestDefaults({ budget, signal }, () => runtime.javaIndex.withRequestOptions({ budget, signal }, () => handler(context, view)));
        } finally {
          runtime.users -= 1;
          this.trimSnapshotRuntimes(entry);
        }
      }
    });
  }

  private async snapshotRuntime(entry: RuntimeEntry, view: RequestView): Promise<SnapshotRuntime> {
    const snapshotId = view.snapshotId!;
    const existing = entry.snapshots.get(snapshotId);
    if (existing) return existing;
    const status = snapshotIndexStatus(await view.snapshotStatus(), snapshotId);
    const raced = entry.snapshots.get(snapshotId);
    if (raced) return raced;
    const shared = entry.shared;
    const javaIndexClient = new SnapshotJavaIndexClient(view.owner, snapshotId, entry.context.repoRoot, status, shared.layout);
    const javaIndex = new RouterJavaIndex(entry.context.repoRoot, javaIndexClient);
    await javaIndex.open(status.indexedGeneration);
    const router = new AgentRouter(entry.context.repoRoot, entry.context.session, javaIndex, shared.layout,
      resolveRoutingPolicy(entry.context.repoRoot), shared.rgRunner, shared.edgeStore);
    const runtime: SnapshotRuntime = { snapshotId, status, javaIndexClient, javaIndex, router, users: 0, lastUsedAt: Date.now() };
    entry.snapshots.set(snapshotId, runtime);
    return runtime;
  }

  /** Keep runtimes in use plus the newest few; a dropped one only loses its caches. */
  private trimSnapshotRuntimes(entry: RuntimeEntry): void {
    const idle = [...entry.snapshots.values()].filter(runtime => runtime.users === 0)
      .sort((left, right) => right.status.indexedGeneration - left.status.indexedGeneration);
    for (const runtime of idle.slice(RETAINED_SNAPSHOT_RUNTIMES)) {
      entry.snapshots.delete(runtime.snapshotId);
      runtime.router.dispose();
    }
  }

  /**
   * The request's freshness comes from its one acquire: FRESH serves caches and confident
   * negatives (with complete coverage); STALE and NOT_READY answer from what they hold, uncached.
   */
  private requestContextFor(
    entry: RuntimeEntry,
    view: RequestView | undefined,
    requestOptions: RequestOptionsInput | undefined,
    budget: DeadlineBudget
  ): RequestContext {
    const mode = requestOptions?.mode ?? "balanced";
    const semanticPolicy = requestOptions?.semanticPolicy ?? "auto";
    const deadlineMs = Math.min(
      MAX_REQUEST_DEADLINE_MS,
      requestOptions?.deadlineMs ?? defaultDeadlineMs(mode, semanticPolicy)
    );
    const state = view?.labels.state ?? "NOT_READY";
    const status = view?.snapshotId ? entry.snapshots.get(view.snapshotId)?.status : undefined;
    const fresh = state === "FRESH" && status !== undefined;
    const freshnessMode: RequestFreshnessMode = state === "FRESH" ? "NORMAL" : state === "STALE" ? "WATCHER_DEGRADED" : "WATCHER_NOT_READY";
    return createRequestContext({
      repoRoot: entry.context.repoRoot,
      repoHash: entry.context.repoHash,
      familyHash: entry.context.worktree?.familyHash,
      generation: status?.indexedGeneration ?? entry.generation.snapshot().value,
      freshnessMode,
      cacheReadAllowed: fresh,
      cacheWriteAllowed: fresh,
      negativeLookupAllowed: fresh && negativeLookupAllowed(status),
      indexOpenSource: status ? "own-snapshot" : undefined,
      mode,
      semanticPolicy,
      deadlineMs,
      budget
    });
  }

  /** A publish reaches the JDT session and the router caches as one change batch at the new generation. */
  private onPublished(event: PublishEvent): void {
    const entry = this.runtimes.get(event.canonicalRoot);
    if (!entry || entry.stoppedAt !== undefined) return;
    const generation = entry.generation.rebaseAtLeast(Math.max(entry.generation.snapshot().value + 1, event.indexedGeneration));
    const batch = changeBatchFor(event, generation);
    void entry.context.session.applyRepoChangeBatch(batch).catch(error => {
      console.error("[codex-java-lsp] JDT change batch failed", error);
    });
    const runtimes = [...entry.snapshots.values()];
    // The edge store and build fingerprint are shared: one router applies the batch, the rest drop older rg results.
    (runtimes.find(runtime => runtime.snapshotId === event.snapshotId) ?? runtimes[0])?.router.onRepoChanged(batch);
    for (const runtime of runtimes) runtime.router.invalidateGeneration(generation);
    entry.context.router.invalidateGeneration(generation);
  }

  private createRequestBudget(requestOptions?: RequestOptionsInput): DeadlineBudget {
    const mode = requestOptions?.mode ?? "balanced";
    const semanticPolicy = requestOptions?.semanticPolicy ?? "auto";
    const deadlineMs = Math.min(
      MAX_REQUEST_DEADLINE_MS,
      requestOptions?.deadlineMs ?? defaultDeadlineMs(mode, semanticPolicy)
    );
    return DeadlineBudget.fromTimeout(deadlineMs);
  }

  reservedCount(): number {
    return this.reservedEntries().length;
  }

  hasRuntime(repoRoot: string): boolean {
    return this.runtimes.has(repoRoot);
  }

  /** Memory-only owner state for status and tests. */
  async indexStatus(): Promise<ReturnType<IndexOwner["status"]> | { unavailable: string } | undefined> {
    const owner = await this.openedOwner();
    if (owner) return owner.status();
    return this.ownerError ? { unavailable: this.ownerError } : undefined;
  }

  activeRepos(): Array<{
    repoRoot: string;
    repoHash: string;
    aliases: string[];
    lifecycleState: JdtlsLifecycleState;
    lspReservation: LspReservation;
    started: boolean;
    pid?: number;
    refCount: number;
    lastUsedAt: string;
  }> {
    return [...this.runtimes.values()].map(entry => {
      const context = entry.context;
      const status = context.session.status();
      return {
        repoRoot: context.repoRoot,
        repoHash: context.repoHash,
        aliases: context.aliases,
        lifecycleState: status.state,
        lspReservation: entry.lspReservation,
        started: status.state === "READY",
        pid: status.pid,
        refCount: entry.refCount,
        lastUsedAt: new Date(entry.lastUsedAt).toISOString()
      };
    });
  }

  resourceStatus(): NonNullable<ToolContext["resource"]> {
    const started = [...this.runtimes.values()]
      .filter(entry => entry.context.session.status().state === "READY")
      .map(entry => entry.context.session.status().pid)
      .filter((pid): pid is number => typeof pid === "number");
    return {
      reservedRepos: this.reservedCount(),
      queuedRepos: this.slotWaiters.length,
      machineMemoryGb: this.defaults.machineMemoryGb,
      logicalCpu: this.defaults.logicalCpu,
      maxActiveRepos: this.options.maxActiveRepos,
      idleTtlMs: this.options.idleTtlMs,
      jdtlsXmx: process.env.JAVA_LSP_JDTLS_XMX || this.defaults.jdtlsXmx,
      activeRepos: this.runtimes.size,
      activeJdtlsPids: started,
      importConcurrency: positiveInteger(process.env.JAVA_LSP_IMPORT_CONCURRENCY, this.defaults.importConcurrency),
      workspaceRetainedOnShutdown: true
    };
  }

  /**
   * The coarse, single-repo retirement path: unlike the JDT-capacity teardown
   * in `stopEntry` (used to free an LSP slot for a waiting repo, which must
   * leave the tracker and in-memory caches intact for a quick resume), this
   * stops the workspace tracker and retires the entry. Its binding stays on
   * disk; a later request starts a new tracker whose first round verifies it.
   * The entry stays in the map as a bounded, inert placeholder — `getOrCreate`
   * never reuses one — purely so `activeRepos()`/`hasRuntime()` can still see it.
   */
  async shutdown(repoRoot: string): Promise<void> {
    const entry = this.runtimes.get(repoRoot);
    if (!entry) return;
    await this.stopEntry(entry);
    await this.retireIndex(entry);
    await entry.context.router.flushSemanticEdgeStore().catch(() => undefined);
    await entry.runtimeLease?.release();
    entry.runtimeLease = undefined;
    // This process's PID would otherwise keep looking alive to the janitor's
    // ownerPid fallback long after this repo's runtime (and its lease) is
    // gone — a long-lived server process is not proof this repo is still in use.
    touchRepoCache(entry.context.repoRoot, { ownerPid: undefined, ownerToken: undefined });
    entry.unsubscribeLifecycle?.();
    entry.unsubscribeLifecycle = undefined;
    entry.stoppedAt = Date.now();
    this.evictStoppedBeyondLimit();
  }

  private async retireIndex(entry: RuntimeEntry): Promise<void> {
    for (const runtime of entry.snapshots.values()) runtime.router.dispose();
    entry.snapshots.clear();
    const owner = await this.openedOwner();
    await owner?.retire(entry.context.repoRoot).catch(() => undefined);
  }

  private evictStoppedBeyondLimit(): void {
    const stopped = [...this.runtimes.entries()]
      .filter((pair): pair is [string, RuntimeEntry & { stoppedAt: number }] => pair[1].stoppedAt !== undefined)
      .sort((left, right) => left[1].stoppedAt - right[1].stoppedAt);
    const excess = stopped.length - this.options.maxRetainedStoppedRepos;
    for (let index = 0; index < excess; index += 1) {
      this.runtimes.delete(stopped[index][0]);
    }
  }

  async shutdownAll(options: { releaseOwnership?: boolean; terminal?: boolean } = {}): Promise<void> {
    this.stopPressureWatch();
    for (const waiter of this.slotWaiters.splice(0)) {
      waiter.cancel();
    }
    await Promise.all([...this.runtimes.values()].map(entry => this.stopEntry(entry)));
    await Promise.all([...this.runtimes.values()].map(async entry => {
      for (const runtime of entry.snapshots.values()) runtime.router.dispose();
      entry.snapshots.clear();
      await entry.context.router.flushSemanticEdgeStore().catch(() => undefined);
      await entry.runtimeLease?.release();
      entry.runtimeLease = undefined;
      if (options.releaseOwnership !== false) {
        try {
          entry.ownership?.release();
        } catch {
          // Ownership release is best-effort during shutdown.
        }
        entry.ownership = undefined;
      }
      touchRepoCache(entry.context.repoRoot, { ownerPid: undefined, ownerToken: undefined });
    }));
    for (const entry of this.runtimes.values()) {
      entry.unsubscribeLifecycle?.();
      entry.unsubscribeLifecycle = undefined;
    }
    // The owner stops last: its builders, query workers and trackers are this process's children.
    this.unsubscribePublish?.();
    const owner = await this.openedOwner();
    await owner?.stop();
  }

  /** Singleflight so two concurrent requests share one runtime entry. */
  private async getOrCreate(resolved: ResolvedRepo, budget?: DeadlineBudget): Promise<RuntimeEntry> {
    const existing = this.runtimes.get(resolved.repoRoot);
    if (existing) {
      if (existing.stoppedAt === undefined) {
        existing.context.aliases = resolved.aliases;
        existing.context.rootSource = resolved.rootSource;
        existing.context.layoutProfile = resolved.layoutProfile;
        existing.context.lsp = resolved.lsp;
        existing.context.worktree = resolved.worktree;
        return existing;
      }
      // A retired placeholder's index runtimes are gone; a new entry starts a new tracker.
      this.runtimes.delete(resolved.repoRoot);
    }
    const pending = this.creating.get(resolved.repoRoot);
    if (pending) return budget ? budget.race("runtime.create", pending) : pending;
    const started = this.createEntry(resolved, DeadlineBudget.fromTimeout(this.options.requestTimeoutMs));
    this.creating.set(resolved.repoRoot, started);
    started.finally(() => {
      if (this.creating.get(resolved.repoRoot) === started) this.creating.delete(resolved.repoRoot);
    }).catch(() => undefined);
    return budget ? budget.race("runtime.create", started) : started;
  }

  private async createEntry(resolved: ResolvedRepo, budget?: DeadlineBudget): Promise<RuntimeEntry> {
    const ownership = this.ownership?.acquire(resolved.repoRoot);
    const shared: SharedRouterState = {
      layout: probeLayout(resolved.repoRoot, resolved.layoutProfile),
      rgRunner: new RgRunner(),
      edgeStore: new FileSemanticEdgeStoreV2(resolved.repoRoot)
    };
    const context = this.runtimeFactory(resolved, this.leases, shared);
    context.session.bindOwnershipLifecycle?.(ownership);
    context.runBackgroundTask = operation => {
      void operation().catch(() => undefined);
      return true;
    };
    const generation = new GenerationClock();
    context.session.bindGenerationClock?.(generation);
    const leaseOperation = this.leases.acquireRuntime(resolved.worktree).catch(() => undefined);
    let leaseTimedOut = false;
    // A caller deadline only stops that caller, but the shared creation itself
    // also needs a hard cap so `creating` cannot retain a permanently silent
    // lease operation. If an acquisition completes after the cap, release the
    // now-unowned handle rather than leaking janitor protection.
    void leaseOperation.then(handle => {
      if (leaseTimedOut && handle) void handle.release().catch(() => undefined);
    });
    const runtimeLease = budget
      ? await budget.race("runtime.lease", leaseOperation, undefined, () => { leaseTimedOut = true; })
      : await leaseOperation;
    const entry: RuntimeEntry = {
      context,
      generation,
      shared,
      snapshots: new Map(),
      refCount: 0,
      lastUsedAt: Date.now(),
      lspReservation: "NONE",
      // Best-effort: a degraded or unopened lease store must never block a
      // runtime from being created, so acquisition failure is swallowed here.
      runtimeLease,
      gate: new RuntimeLifecycleGate(),
      ownership
    };
    entry.unsubscribeLifecycle = entry.context.session.onLifecycleChange(state => {
      if (state === "STARTING") entry.lspReservation = "STARTING";
      else if (state === "READY") entry.lspReservation = "READY";
      else {
        this.releaseUnusedReservation(entry);
        // A BROKEN child can survive SIGKILL. Keep its machine slot reserved
        // until reaping or the later exit notification proves it is gone.
        if (state === "BROKEN") void this.reapSession(entry);
      }
    });
    this.runtimes.set(resolved.repoRoot, entry);
    return entry;
  }

  private refreshResource(entry: RuntimeEntry): void {
    entry.context.resource = this.resourceStatus();
    // The multi-process janitor's authoritative signal (Task 12c) is the
    // runtime lease itself. lastRequestAt is stamped only on MCP use, never
    // on JDT pid changes — otherwise log writes and lifecycle touches keep
    // abandoned worktrees immortal.
    touchRepoCache(entry.context.repoRoot, {
      repoHash: entry.context.repoHash,
      familyHash: entry.context.worktree?.familyHash,
      ownerPid: process.pid,
      ownerToken: entry.runtimeLease?.owner.ownerToken,
      touchLastRequest: true
    });
  }

  private async reserveLspSlot(entry: RuntimeEntry, budget: DeadlineBudget): Promise<void> {
    if (entry.lspReservation !== "NONE") {
      return;
    }
    const victim = this.oldestIdleReservedEntry(entry);
    if (this.reservedEntries().length >= this.options.maxActiveRepos && victim) {
      await this.stopEntry(victim);
    }
    if (this.reservedEntries().length < this.options.maxActiveRepos) {
      entry.lspReservation = "STARTING";
      return;
    }

    const waiter = this.createSlotWaiter(entry);
    this.slotWaiters.push(waiter);
    await budget.race(
      "runtime.lsp-slot",
      waiter.promise,
      undefined,
      () => {
        waiter.cancel();
        const index = this.slotWaiters.indexOf(waiter);
        if (index >= 0) this.slotWaiters.splice(index, 1);
      }
    );
  }

  /**
   * A grant marks the target entry synchronously, before resolving. Resolving
   * first and asking the waiter to reserve afterwards would reopen the
   * check-then-act window this task exists to close.
   */
  private createSlotWaiter(entry: RuntimeEntry): SlotWaiter {
    let settled = false;
    let resolve!: () => void;
    const promise = new Promise<void>(accept => { resolve = accept; });
    return {
      entry,
      promise,
      grant: () => {
        if (settled) return;
        settled = true;
        entry.lspReservation = "STARTING";
        resolve();
      },
      cancel: () => { settled = true; }
    };
  }

  private drainSlotWaiters(): void {
    while (
      this.slotWaiters.length > 0
      && this.reservedEntries().length < this.options.maxActiveRepos
    ) {
      const waiter = this.slotWaiters.shift()!;
      if (waiter.entry.lspReservation === "NONE") waiter.grant();
    }
  }

  /**
   * Queued waiters cannot evict on their own behalf, so whenever an entry goes
   * idle we re-check whether a now-evictable runtime is blocking the queue.
   */
  private async serviceSlotWaiters(): Promise<void> {
    if (this.servicingWaiters) {
      return;
    }
    this.servicingWaiters = true;
    try {
      this.drainSlotWaiters();
      while (
        this.slotWaiters.length > 0
        && this.reservedEntries().length >= this.options.maxActiveRepos
      ) {
        const victim = this.oldestIdleReservedEntry();
        if (!victim) return;
        await this.stopEntry(victim);
        this.drainSlotWaiters();
      }
    } finally {
      this.servicingWaiters = false;
    }
  }

  /**
   * `mayStartLsp` only permits a semantic call; it does not guarantee one.
   * A reservation that never became a real JDT start must go back to the pool.
   */
  private releaseUnusedReservation(entry: RuntimeEntry): void {
    const state = entry.context.session.status().state;
    if (state !== "STARTING" && state !== "READY" && !this.sessionHasLiveChildren(entry)) {
      entry.lspReservation = "NONE";
      this.drainSlotWaiters();
    }
  }

  private reservedEntries(): RuntimeEntry[] {
    return [...this.runtimes.values()].filter(entry => entry.lspReservation !== "NONE");
  }

  private oldestIdleReservedEntry(exempt?: RuntimeEntry): RuntimeEntry | undefined {
    return this.reservedEntries()
      .filter(entry => entry !== exempt && entry.refCount === 0)
      .filter(entry => {
        const state = entry.context.session.status().state;
        return state === "READY" || state === "STARTING" || !this.sessionHasLiveChildren(entry);
      })
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  }

  private oldestIdleEntry(exempt?: RuntimeEntry): RuntimeEntry | undefined {
    return [...this.runtimes.values()]
      .filter(entry => entry !== exempt && entry.refCount === 0 && entry.stoppedAt === undefined)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  }

  private clearIdleTimers(entry: RuntimeEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  }

  private scheduleIdleShutdown(entry: RuntimeEntry): void {
    this.clearIdleTimers(entry);
    if (entry.refCount !== 0 || entry.stoppedAt !== undefined) return;
    if (this.options.idleTtlMs > 0) {
      entry.idleTimer = setTimeout(() => {
        if (entry.refCount !== 0 || entry.stoppedAt !== undefined) return;
        void this.retireIdleEntry(entry);
      }, this.options.idleTtlMs);
      entry.idleTimer.unref?.();
    }
  }

  private async retireIdleEntry(entry: RuntimeEntry): Promise<void> {
    try {
      await this.reapSession(entry);
      if (entry.lspReservation !== "NONE") {
        await this.stopEntry(entry);
      }
      if (entry.refCount !== 0 || entry.stoppedAt !== undefined) return;
      if (this.options.isProtectedRepo?.(entry.context.repoRoot)) return;
      await this.shutdown(entry.context.repoRoot);
    } catch {
      // Idle retirement must not throw into the timer.
    }
  }

  private startPressureWatch(): void {
    if (this.pressureTimer || this.options.pressureIntervalMs <= 0) return;
    this.pressureTimer = setInterval(() => {
      void this.maybeRelieveMemoryPressure();
    }, this.options.pressureIntervalMs);
    this.pressureTimer.unref?.();
  }

  private stopPressureWatch(): void {
    if (!this.pressureTimer) return;
    clearInterval(this.pressureTimer);
    this.pressureTimer = undefined;
  }

  private async maybeRelieveMemoryPressure(): Promise<void> {
    if (this.relievingPressure) return;
    const freemem = this.options.freemem ?? os.freemem;
    if (freemem() >= this.options.freememPressureBytes) return;
    const victim = [...this.runtimes.values()]
      .filter(entry => entry.refCount === 0 && entry.stoppedAt === undefined)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!victim) return;
    this.relievingPressure = true;
    try {
      if (victim.lspReservation !== "NONE") {
        await this.stopEntry(victim);
      }
      if (victim.refCount === 0 && !this.options.isProtectedRepo?.(victim.context.repoRoot)) {
        await this.shutdown(victim.context.repoRoot);
      }
    } finally {
      this.relievingPressure = false;
    }
  }

  private sessionHasLiveChildren(entry: RuntimeEntry): boolean {
    const session = entry.context.session as { hasLiveChildren?: () => boolean };
    return session.hasLiveChildren?.() ?? false;
  }

  private async reapSession(entry: RuntimeEntry): Promise<void> {
    const session = entry.context.session as { reapAbandonedChildren?: () => Promise<void> };
    if (typeof session.reapAbandonedChildren !== "function") return;
    try {
      await session.reapAbandonedChildren();
      this.releaseUnusedReservation(entry);
    } catch (error) {
      console.error("[codex-java-lsp] failed to reap abandoned JDT", error);
    }
  }

  private async stopEntry(entry: RuntimeEntry): Promise<void> {
    this.clearIdleTimers(entry);
    await entry.context.session.stop();
    entry.context.router.clearRgCache();
    // The lifecycle listener normally clears this on STOPPED; assign it here too
    // so eviction is authoritative even for a session that never transitioned.
    entry.lspReservation = "NONE";
    this.drainSlotWaiters();
  }
}

/** Confident negatives need a complete snapshot: every source and resource root COMPLETE with no failed or recovered files. */
function negativeLookupAllowed(status: JavaIndexStatus): boolean {
  if (status.state !== "READY" || status.lastError !== undefined || status.coverage.length === 0) return false;
  const generation = status.indexedGeneration;
  return status.coverage.every(entry => entry.generation === generation && entry.state === "COMPLETE"
      && entry.failedFiles === 0 && entry.recoveredFiles === 0)
    && (status.resourceCoverage ?? []).every(entry => entry.generation === generation && entry.state === "COMPLETE" && entry.failedFiles === 0);
}

const BUILD_FILES = ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties"];

/** One publish as the JDT/router change batch: verified content changes only, at the new generation. */
export function changeBatchFor(event: PublishEvent, generation: number): RepoChangeBatch {
  const changes: RepoChange[] = [];
  const absolute = (relative: string) => path.join(event.canonicalRoot, relative);
  for (const relative of event.changed) {
    const name = path.posix.basename(relative);
    if (BUILD_FILES.includes(name)) changes.push({ kind: "BUILD_CHANGE", absolutePath: absolute(relative), event: "change" });
    else changes.push(relative.endsWith(".java")
      ? { kind: "JAVA_CHANGE", absolutePath: absolute(relative), event: "change" }
      : { kind: "RESOURCE_CHANGE", absolutePath: absolute(relative), event: "change" });
  }
  for (const relative of event.deleted) {
    const name = path.posix.basename(relative);
    if (BUILD_FILES.includes(name)) changes.push({ kind: "BUILD_CHANGE", absolutePath: absolute(relative), event: "delete" });
    else changes.push(relative.endsWith(".java")
      ? { kind: "JAVA_DELETE", absolutePath: absolute(relative), event: "delete" }
      : { kind: "RESOURCE_CHANGE", absolutePath: absolute(relative), event: "delete" });
  }
  if (event.buildKeyChanged && !changes.some(change => change.kind === "BUILD_CHANGE")) {
    for (const name of BUILD_FILES) changes.push({ kind: "BUILD_CHANGE", absolutePath: absolute(name), event: "change" });
  }
  const javaFiles = changes.filter(change => change.kind.startsWith("JAVA_")).length;
  return {
    generation,
    observedAt: new Date().toISOString(),
    changes,
    storm: isStormBatch(changes.length, Math.max(javaFiles, 1)),
    affectedRoots: [...new Set(changes.map(change => path.relative(event.canonicalRoot, path.dirname(change.absolutePath)).split(path.sep)[0] || "."))].slice(0, 16)
  };
}

function createRuntime(
  resolved: ResolvedRepo,
  leases: CrossProcessLeaseStore,
  shared: SharedRouterState,
  transportMode: RepoOwnerTransport = "stdio",
  ownershipLifecycle?: RepoOwnershipLease
): ManagedToolContext {
  const session = new JdtlsSession(resolved.repoRoot, resolved.aliases, {
    transportMode,
    ownershipLifecycle,
    leaseStore: leases,
    worktree: resolved.worktree
  });
  // Until a request holds a verified snapshot, every index read refuses (NOT_READY, never a sibling).
  const javaIndexClient = new NotReadyJavaIndexClient();
  const javaIndex = new RouterJavaIndex(resolved.repoRoot, javaIndexClient);
  const router = new AgentRouter(resolved.repoRoot, session, javaIndex, shared.layout,
    resolveRoutingPolicy(resolved.repoRoot), shared.rgRunner, shared.edgeStore);
  return {
    repoRoot: resolved.repoRoot,
    rootSource: resolved.rootSource,
    repoHash: resolved.repoHash,
    aliases: resolved.aliases,
    layoutProfile: resolved.layoutProfile,
    lsp: resolved.lsp,
    worktree: resolved.worktree,
    session,
    router,
    javaIndex,
    javaIndexClient
  };
}

function isLeaseStore(value: unknown): value is CrossProcessLeaseStore {
  return typeof value === "object" && value !== null && typeof (value as CrossProcessLeaseStore).open === "function";
}

function createDefaultLeaseStore(): CrossProcessLeaseStore {
  return new FileCrossProcessLeaseStore(path.join(repoCacheBase(), "leases"), defaultLeaseClockDeps());
}

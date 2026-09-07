// input: Resolved repo roots.
// output: Per-repo runtime contexts.
// pos: Lazy runtime manager; one context per canonical repoRoot with small LRU/idle control.
import { existsSync, statSync } from "node:fs";
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
import { BuilderSupervisor } from "./java-index/builder-supervisor.js";
import type { JavaIndexClientApi } from "./java-index/java-index-client-api.js";
import type { JavaIndexStatus } from "./java-index/index-types.js";
import { SqlJavaIndexClient } from "./java-index/sql/sql-client.js";
import { RouterJavaIndex } from "./java-index/router-java-index.js";
import { LayoutManager, type LayoutSource } from "./layout-manager.js";
import { RepoChangeCoordinator } from "./repo-change-coordinator.js";
import { GenerationClock, type RepoChangeBatch } from "./repo-generation.js";
import { repoCacheBase, repoCacheRoot, scanFamilySiblingIndex } from "./repo-layout.js";
import { RepoResolver, type RepoSelector, type ResolvedRepo } from "./repo-resolver.js";
import {
  DEFAULT_COLD_HIBERNATE_TTL_MS,
  DEFAULT_FREEMEM_PRESSURE_BYTES,
  DEFAULT_INDEX_IDLE_TTL_MS,
  nonNegativeInteger,
  parsePrewarmHotSet,
  positiveInteger,
  resourceDefaults,
  type ResourceDefaults
} from "./resource-defaults.js";
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

/** How long a watcher-ready wait may borrow from the request budget. */
const WATCHER_READY_CAP_MS = 2000;
/** Per pinned repo: cover one cold-build child (lishuedu ~106s) plus hydrate/flush. */
const PREWARM_INDEX_MS = 300_000;

/** The subset of RepoChangeCoordinator the runtime manager depends on. */
export interface RuntimeCoordinator {
  start(): Promise<void>;
  flushNow(): Promise<void>;
  awaitReadyWithin(ms: number): Promise<boolean>;
  close(): Promise<void>;
  onBatch(listener: (batch: RepoChangeBatch) => void | Promise<void>): () => void;
  status(): {
    ready: boolean;
    degraded: boolean;
    pending: number;
    lastStorm?: { observedAt: string; changeCount: number; affectedRoots: string[] };
  };
}

export type RuntimeCoordination = {
  generation: GenerationClock;
  coordinator: RuntimeCoordinator;
  layout: LayoutSource;
};

export type CoordinationFactory = (resolved: ResolvedRepo, indexedFileCount: () => number) => RuntimeCoordination;

export type ManagedToolContext = ToolContext & {
  repoHash: string;
  rootSource: NonNullable<ToolContext["rootSource"]>;
  aliases: string[];
  layoutProfile: string;
  lsp: ResolvedRepo["lsp"];
};

/**
 * A slot is held from the moment we decide to start JDT, not from the moment
 * JDT reports READY. STARTING must count, or concurrent requests all pass the
 * capacity check during the asynchronous startup window and oversubscribe.
 */
type LspReservation = "NONE" | "STARTING" | "READY";

type RuntimeEntry = {
  context: ManagedToolContext;
  generation: GenerationClock;
  coordinator: RuntimeCoordinator;
  layout: LayoutSource;
  ready: Promise<void>;
  refCount: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
  lspReservation: LspReservation;
  unsubscribeLifecycle?: () => void;
  reconcilePromise?: Promise<void>;
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

type RuntimeManagerOptions = {
  maxActiveRepos: number;
  idleTtlMs: number;
  hibernateTtlMs: number;
  coldHibernateTtlMs: number;
  indexIdleTtlMs: number;
  hotIndexAliases: ReadonlySet<string>;
  freememPressureBytes: number;
  pressureIntervalMs: number;
  freemem?: () => number;
  requestTimeoutMs: number;
  maxRetainedStoppedRepos: number;
  transportMode: RepoOwnerTransport;
  /** MiB. Explicit absolute recycle floor. 0 means unset (FSR3 relative 1.6× hydrate). */
  workerHeapRecycleMb: number;
  /** STATUS poll for FSZ1 heap recycle. 0 disables. Default 5 min. */
  heapRecycleIntervalMs: number;
};

export class RepoRuntimeManager {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly creating = new Map<string, Promise<RuntimeEntry>>();
  private readonly familyGates = new Map<string, Promise<void>>();
  private readonly slotWaiters: SlotWaiter[] = [];
  private servicingWaiters = false;
  private readonly options: RuntimeManagerOptions;
  private readonly defaults: ResourceDefaults;

  private leaseReady?: Promise<void>;
  private leaseInitError?: string;
  private pressureTimer?: NodeJS.Timeout;
  private relievingPressure = false;

  constructor(
    private readonly resolver: Pick<RepoResolver, "resolve">,
    options: Partial<RuntimeManagerOptions> = {},
    runtimeFactory?: (resolved: ResolvedRepo, leases: CrossProcessLeaseStore) => ManagedToolContext,
    coordinationOrOwnership: CoordinationFactory | RepoOwnershipProvider = createCoordination,
    leasesOrTouch: CrossProcessLeaseStore | ((repoRoot: string, extra?: RepoCacheTouch) => void) = createDefaultLeaseStore()
  ) {
    this.defaults = resourceDefaults();
    this.options = {
      maxActiveRepos: positiveInteger(process.env.JAVA_LSP_MAX_ACTIVE_REPOS, this.defaults.maxActiveRepos),
      idleTtlMs: positiveInteger(process.env.JAVA_LSP_IDLE_TTL_MS, this.defaults.idleTtlMs),
      hibernateTtlMs: positiveInteger(process.env.JAVA_LSP_HIBERNATE_TTL_MS, this.defaults.hibernateTtlMs),
      indexIdleTtlMs: nonNegativeInteger(process.env.JAVA_LSP_INDEX_IDLE_TTL_MS, DEFAULT_INDEX_IDLE_TTL_MS),
      hotIndexAliases: options.hotIndexAliases ?? parsePrewarmHotSet().hot,
      freememPressureBytes: positiveInteger(
        process.env.JAVA_LSP_FREEMEM_PRESSURE_BYTES,
        DEFAULT_FREEMEM_PRESSURE_BYTES
      ),
      pressureIntervalMs: positiveInteger(
        process.env.JAVA_LSP_FREEMEM_PRESSURE_INTERVAL_MS,
        process.env.JAVA_LSP_ISOLATED_VALIDATION === "1" ? 0 : 5000
      ),
      requestTimeoutMs: positiveInteger(process.env.JAVA_LSP_REQUEST_TIMEOUT_MS, 120000),
      maxRetainedStoppedRepos: positiveInteger(process.env.JAVA_LSP_MAX_RETAINED_STOPPED_REPOS, 2),
      transportMode: "stdio",
      workerHeapRecycleMb: nonNegativeInteger(process.env.JAVA_LSP_WORKER_HEAP_RECYCLE_MB, 0),
      heapRecycleIntervalMs: nonNegativeInteger(
        process.env.JAVA_LSP_WORKER_HEAP_RECYCLE_INTERVAL_MS,
        process.env.JAVA_LSP_ISOLATED_VALIDATION === "1" ? 0 : 300_000
      ),
      ...options,
      coldHibernateTtlMs: options.coldHibernateTtlMs
        ?? (typeof options.hibernateTtlMs === "number"
          ? options.hibernateTtlMs
          : nonNegativeInteger(process.env.JAVA_LSP_COLD_HIBERNATE_TTL_MS, DEFAULT_COLD_HIBERNATE_TTL_MS))
    };
    this.startPressureWatch();
    this.runtimeFactory = runtimeFactory ?? ((resolved, leases) => createRuntime(resolved, leases, this.options.transportMode));
    if (isOwnershipProvider(coordinationOrOwnership)) {
      this.coordinationFactory = createCoordination;
      this.ownership = coordinationOrOwnership;
    } else {
      this.coordinationFactory = coordinationOrOwnership;
    }
    if (typeof leasesOrTouch === "function" && !isLeaseStore(leasesOrTouch)) {
      this.leases = createDefaultLeaseStore();
    } else {
      this.leases = leasesOrTouch as CrossProcessLeaseStore;
    }
  }

  private readonly runtimeFactory: (resolved: ResolvedRepo, leases: CrossProcessLeaseStore) => ManagedToolContext;
  private readonly coordinationFactory: CoordinationFactory;
  private readonly leases: CrossProcessLeaseStore;
  private readonly ownership?: RepoOwnershipProvider;

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
        sweepSlots: positiveInteger(process.env.JAVA_LSP_MAX_BACKGROUND_SWEEPS, 1)
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

  async contextFor(selector: RepoSelector): Promise<ManagedToolContext> {
    const resolved = await this.resolver.resolve(selector);
    const entry = await this.getOrCreate(resolved);
    this.refreshResource(entry);
    return entry.context;
  }

  /**
   * Open JavaIndex for a pinned repo and wait until that repo's rebuild is
   * durable (or the per-repo budget expires). Does not start JDT. The next
   * pinned repo must not be opened until this returns, or cold-build children
   * stampede the machine-wide BUILD_SLOT.
   */
  async prewarmRepo(selector: RepoSelector, _options: { hydrate?: boolean } = {}): Promise<void> {
    const resolved = await this.resolver.resolve(selector);
    if (!resolved.lsp.enabled) return;
    const entry = await this.getOrCreate(resolved);
    this.refreshResource(entry);
    entry.refCount += 1;
    try {
      const client = entry.context.javaIndexClient;
      if (!client) return;
      const budget = DeadlineBudget.fromTimeout(PREWARM_INDEX_MS);
      const status = await client.status({ budget }).catch(() => undefined);
      if (status?.state === "BUILDING") {
        await client.awaitPrewarmReady({ budget });
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
    options: { mayStartLsp?: boolean; requestOptions?: RequestOptionsInput } = {}
  ): Promise<T> {
    const resolved = await this.resolver.resolve(selector);
    const requestOptions = this.requestOptionsForRuntime(resolved.repoRoot, options.requestOptions);
    const budget = this.createRequestBudget(requestOptions);
    budget.throwIfExpired("runtime.repo-resolve");
    const entry = await this.getOrCreate(resolved, budget);
    this.refreshResource(entry);
    entry.refCount += 1;
    this.clearIdleTimers(entry);
    try {
      const request = await this.prepareRequestContext(entry, requestOptions, budget);
      if (options.mayStartLsp) {
        idlePrewarmTracker.recordFirstSemanticRequest(resolved.repoRoot);
        await this.reserveLspSlot(entry, request.budget);
      }
      return await handler(entry.context, request);
    } finally {
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
      this.releaseUnusedReservation(entry);
      this.scheduleIdleShutdown(entry);
      void this.serviceSlotWaiters();
    }
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
    return new Set([...this.runtimes.keys()]);
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

  /**
   * The freshness barrier: settle the watcher, reconcile if dirty, then fix the
   * request's generation and cache policy. A watcher-ready timeout is not a
   * failure — the request proceeds DEGRADED with caches and negative answers off.
   */
  private async prepareRequestContext(
    entry: RuntimeEntry,
    requestOptions: RequestOptionsInput | undefined,
    budget: DeadlineBudget
  ): Promise<RequestContext> {
    const mode = requestOptions?.mode ?? "balanced";
    const semanticPolicy = requestOptions?.semanticPolicy ?? "auto";
    const deadlineMs = Math.min(
      MAX_REQUEST_DEADLINE_MS,
      requestOptions?.deadlineMs ?? defaultDeadlineMs(mode, semanticPolicy)
    );
    if (budget.expired()) {
      return this.degradedRequestContext(entry, mode, semanticPolicy, deadlineMs, budget);
    }

    const ready = await entry.coordinator.awaitReadyWithin(
      Math.min(WATCHER_READY_CAP_MS, budget.remainingMs())
    );

    let freshnessMode: RequestFreshnessMode;
    let cacheReadAllowed = false;
    let cacheWriteAllowed = false;

    if (ready) {
      await entry.coordinator.flushNow();      // already-delivered debounced events
      await this.reconcileIfDirty(entry, budget);      // no-op unless a reconcile is pending
      await entry.coordinator.flushNow();      // events delivered during reconcile
      const clock = entry.generation.snapshot();
      freshnessMode = clock.dirty ? "WATCHER_DEGRADED" : "NORMAL";
      cacheReadAllowed = !clock.dirty;
      cacheWriteAllowed = !clock.dirty;
    } else {
      freshnessMode = entry.generation.snapshot().dirty ? "WATCHER_DEGRADED" : "WATCHER_NOT_READY";
    }

    if (budget.expired()) {
      return this.degradedRequestContext(entry, mode, semanticPolicy, deadlineMs, budget, {
        freshnessMode,
        cacheReadAllowed: false,
        cacheWriteAllowed: false
      });
    }
    const generationBeforeIndexStatus = entry.generation.snapshot().value;
    let javaIndexStatus: JavaIndexStatus | undefined;
    try {
      javaIndexStatus = await entry.context.javaIndexClient?.status({ budget });
    } catch {
      // JavaIndex is an optional accelerator; a failed status probe is
      // degraded evidence, not a reason to fail an otherwise lexical request.
    }
    const finalClock = entry.generation.snapshot();
    if (finalClock.dirty) {
      freshnessMode = "WATCHER_DEGRADED";
      cacheReadAllowed = false;
      cacheWriteAllowed = false;
    }
    const negativeLookupAllowed = this.negativeLookupAllowed(
      freshnessMode,
      entry.coordinator.status(),
      javaIndexStatus,
      finalClock.value,
      finalClock.value === generationBeforeIndexStatus && !finalClock.dirty
    );
    budget.throwIfExpired("runtime.request-context");

    let indexOpenSource: RequestContext["indexOpenSource"];
    try {
      const routerIndex = entry.context.javaIndex;
      const statusOperation = routerIndex.withRequestOptions
        ? routerIndex.withRequestOptions({ budget }, () => routerIndex.routerStatus())
        : routerIndex.routerStatus();
      const status = await budget.race("runtime.router-status", statusOperation);
      indexOpenSource = status.openSource;
    } catch {
      // Router status is diagnostic evidence. A backend failure degrades only
      // this field; an exhausted absolute request budget is rethrown below.
    }
    budget.throwIfExpired("runtime.router-status");

    return createRequestContext({
      repoRoot: entry.context.repoRoot,
      repoHash: entry.context.repoHash,
      familyHash: entry.context.worktree?.familyHash,
      generation: finalClock.value,
      freshnessMode,
      cacheReadAllowed,
      cacheWriteAllowed,
      negativeLookupAllowed,
      indexOpenSource,
      mode,
      semanticPolicy,
      deadlineMs,
      budget
    });
  }

  private degradedRequestContext(
    entry: RuntimeEntry,
    mode: RequestMode,
    semanticPolicy: SemanticPolicy,
    deadlineMs: number,
    budget: DeadlineBudget,
    overrides: {
      freshnessMode?: RequestFreshnessMode;
      cacheReadAllowed?: boolean;
      cacheWriteAllowed?: boolean;
      negativeLookupAllowed?: boolean;
      generation?: number;
    } = {}
  ): RequestContext {
    const clock = entry.generation.snapshot();
    return createRequestContext({
      repoRoot: entry.context.repoRoot,
      repoHash: entry.context.repoHash,
      familyHash: entry.context.worktree?.familyHash,
      generation: overrides.generation ?? clock.value,
      freshnessMode: overrides.freshnessMode
        ?? (clock.dirty ? "WATCHER_DEGRADED" : "WATCHER_NOT_READY"),
      cacheReadAllowed: overrides.cacheReadAllowed ?? false,
      cacheWriteAllowed: overrides.cacheWriteAllowed ?? false,
      negativeLookupAllowed: overrides.negativeLookupAllowed ?? false,
      mode,
      semanticPolicy,
      deadlineMs,
      budget
    });
  }

  /** Negative answers are safe only when watcher and both index coverages agree on this generation. */
  private negativeLookupAllowed(
    freshnessMode: RequestFreshnessMode,
    watcher: ReturnType<RuntimeCoordinator["status"]>,
    status: JavaIndexStatus | undefined,
    generation: number,
    generationStableDuringStatusProbe: boolean
  ): boolean {
    const sourceCoverage = status?.coverage ?? [];
    const resourceCoverage = status?.resourceCoverage ?? [];
    if (
      freshnessMode !== "NORMAL"
      || !generationStableDuringStatusProbe
      || !watcher.ready
      || watcher.degraded
      || watcher.pending > 0
      || !status
      || status.state !== "READY"
      || status.lastError !== undefined
      || status.indexedGeneration !== generation
      || status.pendingForeground !== 0
      || status.pendingBackground !== 0
      || status.snapshotVerificationPending === true
      || sourceCoverage.length === 0
    ) {
      return false;
    }
    const sourceComplete = sourceCoverage.every(entry =>
      entry.generation === generation
      && entry.state === "COMPLETE"
      && entry.failedFiles === 0
      && entry.recoveredFiles === 0
    );
    const resourcesComplete = resourceCoverage.every(entry =>
      entry.generation === generation
      && entry.state === "COMPLETE"
      && entry.failedFiles === 0
    );
    return sourceComplete && resourcesComplete;
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

  /**
   * Idle-close leaves a stopped placeholder (hasRuntime still true). A true
   * cold start is "no live entry", and that path always gets the 15s public budget.
   */
  private hasLiveRuntime(repoRoot: string): boolean {
    const entry = this.runtimes.get(repoRoot);
    return entry !== undefined && entry.stoppedAt === undefined;
  }

  private requestOptionsForRuntime(
    repoRoot: string,
    requestOptions?: RequestOptionsInput
  ): RequestOptionsInput {
    const mode = requestOptions?.mode ?? "balanced";
    const semanticPolicy = requestOptions?.semanticPolicy ?? "auto";
    if (this.hasLiveRuntime(repoRoot) || requestOptions?.deadlineMs !== undefined) {
      return requestOptions ?? { mode, semanticPolicy };
    }
    return { mode, semanticPolicy, deadlineMs: MAX_REQUEST_DEADLINE_MS };
  }

  /**
   * Singleflight: two concurrent requests against a dirty runtime share one
   * reconcile. A failure leaves `dirty` set (clearDirty is never reached), so
   * the runtime stays DEGRADED and the next request tries again rather than
   * silently believing the index is clean.
   */
  private async reconcileIfDirty(entry: RuntimeEntry, budget?: DeadlineBudget): Promise<void> {
    if (!entry.generation.snapshot().dirty) return;
    if (!entry.reconcilePromise) {
      // Reconciliation belongs to the shared runtime, not to the first caller
      // that happens to observe it dirty. Keep the shared work bounded by the
      // manager hard cap, while every caller independently races its own
      // absolute request budget below.
      const operationBudget = DeadlineBudget.fromTimeout(this.options.requestTimeoutMs);
      const operation = (async () => {
        const generationAtStart = entry.generation.snapshot().value;
        try {
          await entry.context.javaIndexClient?.reconcile(
            generationAtStart,
            { budget: operationBudget }
          );
          entry.generation.clearDirty(generationAtStart);
        } catch {
          // Reconcile failure must not fail the request: output coverage stays
          // DEGRADED and the next dirty request retries the reconcile.
        }
      })().finally(() => {
        if (entry.reconcilePromise === operation) entry.reconcilePromise = undefined;
      });
      entry.reconcilePromise = operation;
    }
    await (budget
      ? budget.race("runtime.reconcile", entry.reconcilePromise)
      : entry.reconcilePromise);
  }

  reservedCount(): number {
    return this.reservedEntries().length;
  }

  hasRuntime(repoRoot: string): boolean {
    return this.runtimes.has(repoRoot);
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
      hibernateTtlMs: this.options.hibernateTtlMs,
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
   * leave the watcher and in-memory caches intact for a quick resume), this
   * fully closes the coordinator and retires the entry. It stays in the map
   * as a bounded, inert placeholder — `getOrCreate` never reuses one — purely
   * so `activeRepos()`/`hasRuntime()` can still see it until eviction.
   */
  async shutdown(repoRoot: string): Promise<void> {
    const entry = this.runtimes.get(repoRoot);
    if (!entry) return;
    await this.stopEntry(entry);
    await entry.coordinator.close();
    await entry.context.javaIndexClient?.close().catch(() => undefined);
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
    // A prior shutdown(repoRoot) may have already closed some coordinators;
    // RepoChangeCoordinator.close() is idempotent, so closing the rest here
    // (and re-closing the already-closed ones) is safe either way.
    await Promise.all([...this.runtimes.values()].map(async entry => {
      await entry.coordinator.close();
      await entry.context.javaIndexClient?.close().catch(() => undefined);
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
  }

  /** Singleflight so two concurrent requests share one runtime/coordinator/watcher. */
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
      // A retained-but-stopped placeholder's coordinator is already closed
      // (its startPromise is settled, so start() would be a no-op); reusing
      // it would silently leave freshness tracking dead for this repo.
      this.runtimes.delete(resolved.repoRoot);
    }
    const pending = this.creating.get(resolved.repoRoot);
    if (pending) return budget ? budget.race("runtime.create", pending) : pending;
    const family = this.familyKey(resolved.worktree, resolved.repoHash);
    const started = this.startFamilyCreate(family, resolved);
    this.creating.set(resolved.repoRoot, started);
    started.finally(() => {
      if (this.creating.get(resolved.repoRoot) === started) this.creating.delete(resolved.repoRoot);
    }).catch(() => undefined);
    return budget ? budget.race("runtime.create", started) : started;
  }

  private async startFamilyCreate(family: string, resolved: ResolvedRepo): Promise<RuntimeEntry> {
    const prev = this.familyGates.get(family) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    this.familyGates.set(family, prev.then(() => gate));
    await prev;
    try {
      return await this.createEntry(resolved, DeadlineBudget.fromTimeout(this.options.requestTimeoutMs));
    } finally {
      release();
    }
  }

  private async createEntry(resolved: ResolvedRepo, budget?: DeadlineBudget): Promise<RuntimeEntry> {
    const ownership = this.ownership?.acquire(resolved.repoRoot);
    const context = this.runtimeFactory(resolved, this.leases);
    context.session.bindOwnershipLifecycle?.(ownership);
    context.runBackgroundTask = operation => {
      void operation().catch(() => undefined);
      return true;
    };
    const { generation, coordinator, layout } = this.coordinationFactory(
      resolved,
      () => context.javaIndexClient?.localStatus().files ?? 0
    );
    context.session.bindGenerationClock?.(generation);
    if (process.env.JAVA_LSP_IDLE_PREWARM === "1") {
      idlePrewarmTracker.recordPrewarm(resolved.repoRoot);
    }
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
      coordinator,
      layout,
      ready: Promise.resolve(),
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
        entry.lspReservation = "NONE";
        this.drainSlotWaiters();
      }
    });
    // Register invalidation before start() so the first event cannot be lost.
    // The coordinator starts before JavaIndex OPEN because sibling snapshot
    // validation has a real filesystem race: batches observed while OPEN is
    // reading its target manifest are buffered here, then applied before this
    // runtime becomes visible to a request.
    const bufferedJavaIndexBatches: RepoChangeBatch[] = [];
    let javaIndexReady = entry.context.javaIndexClient === undefined;
    coordinator.onBatch(async batch => {
      entry.context.router.onRepoChanged(batch);
      let sessionFailure: unknown;
      let sessionFailed = false;
      try {
        await entry.context.session.applyRepoChangeBatch(batch);
      } catch (error) {
        sessionFailed = true;
        sessionFailure = error;
      }
      if (!javaIndexReady) {
        bufferedJavaIndexBatches.push(batch);
        if (sessionFailed) throw sessionFailure;
        return;
      }
      try {
        await this.applyBatchToJavaIndex(entry.context.javaIndexClient, batch);
      } catch (indexFailure) {
        if (sessionFailed) {
          throw new AggregateError([sessionFailure, indexFailure], "session and JavaIndex repo-change consumers failed");
        }
        throw indexFailure;
      }
      if (sessionFailed) throw sessionFailure;
    });
    // Do not await the watcher-ready scan here: requests retain their bounded
    // readiness barrier below, while OPEN already gets a live coordinator and
    // can flush any events that have arrived so far.
    entry.ready = coordinator.start();
    // Best-effort: chokidar's initial scan (ignoreInitial: true) never emits
    // an onBatch for pre-existing files, so the Java index's first full
    // discovery is kicked off explicitly here rather than waiting for one.
    // A failed open must not fail runtime creation; the client self-degrades.
    const validationGeneration = generation.snapshot().value;
    await entry.context.javaIndexClient?.open(validationGeneration, {
      leaseRoot: path.join(repoCacheBase(), "leases"),
      worktree: resolved.worktree,
      siblingCacheBase: repoCacheBase(),
      siblingDbPath: this.findSiblingDb(resolved)
    }, budget ? { budget } : undefined).then(async openStatus => {
      // A restored-and-verified snapshot (Task 21 Step 6a) reports its own
      // (possibly higher) generation; the repo's clock must never regress
      // behind facts the Java index has already verified as current.
      generation.rebaseAtLeast(openStatus.indexedGeneration);
      javaIndexReady = true;
      // Step 21a 4.8: replay batches observed during target manifest
      // validation, then flush any event that arrived in the narrow gap. The
      // batch's own generation is preserved, so only its changed/deleted Java
      // paths are refreshed; no stale seeded fact reaches a caller.
      for (const batch of bufferedJavaIndexBatches.splice(0)) {
        await this.applyBatchToJavaIndex(entry.context.javaIndexClient, batch);
      }
      await coordinator.flushNow();
      const generationChangedDuringSeed = generation.snapshot().value !== validationGeneration;
      // A root with a nonzero failed/recovered count restores COMPLETE too
      // (its content is provably unchanged from a prior parse that had
      // issues), but only a fresh coverage.begin() - which only a
      // reconcile()'d sweep performs - ever resets that count. Treating such
      // a root as "not fully restored" keeps it self-healing instead of
      // leaving canAnswerNegative() stuck false forever.
      const fullyRestored = openStatus.coverage.length > 0
        && openStatus.coverage.every(entry_ =>
          entry_.state === "COMPLETE"
          && entry_.generation === openStatus.indexedGeneration
          && entry_.failedFiles === 0
          && entry_.recoveredFiles === 0
        );
      // Own-snapshot verification now continues in the worker after OPEN has
      // restored its facts provisionally.  Starting a full reconcile here
      // would erase the startup win and duplicate the verifier's bounded
      // diff/sweep decision; it promotes COMPLETE or schedules the governed
      // sweep itself.  A real watcher batch still sets generationChanged and
      // takes the normal reconcile path.
      const seededDegraded = openStatus.worktreeSeed?.completion === "SEEDED_DEGRADED";
      const needsFollowUp = seededDegraded
        || (!fullyRestored && !openStatus.snapshotVerificationPending)
        || generationChangedDuringSeed;
      if (needsFollowUp) {
        // Never await a sweep on runtime.create: a failed/empty seed used to
        // block the 15s public tool on a cold-build child, and a successful
        // seed already has queryable facts. Use a fresh manager cap so a
        // nearly-spent OPEN budget cannot cancel the background sweep.
        void entry.context.javaIndexClient?.reconcile(
          generation.snapshot().value,
          { budget: DeadlineBudget.fromTimeout(this.options.requestTimeoutMs) }
        ).catch(() => undefined);
      }
    }).catch(() => {
      // An OPEN failure remains non-fatal, but watchers must not retain every
      // later batch forever. Subsequent batch delivery will self-degrade the
      // unavailable client through the coordinator's normal listener path.
      javaIndexReady = true;
      bufferedJavaIndexBatches.length = 0;
    });
    this.runtimes.set(resolved.repoRoot, entry);
    return entry;
  }

  /**
   * Maps one coordinator batch onto the Java index's own refresh/reconcile
   * contract (Task 20 Step 7). A storm or a build-file change routes to a
   * background reconcile rather than a per-path foreground refresh. A listener
   * throw here is caught by RepoChangeCoordinator's own per-listener catch,
   * which marks the generation dirty for the next request's retry.
   */
  private async applyBatchToJavaIndex(
    javaIndex: JavaIndexClientApi | undefined,
    batch: RepoChangeBatch
  ): Promise<void> {
    if (!javaIndex) return;
    const budget = DeadlineBudget.fromTimeout(this.options.requestTimeoutMs);
    if (batch.storm || batch.changes.some(change => change.kind === "BUILD_CHANGE")) {
      await javaIndex.reconcile(batch.generation, { budget });
      return;
    }
    const changed: string[] = [];
    const deleted: string[] = [];
    const resources: string[] = [];
    for (const change of batch.changes) {
      if (change.kind === "JAVA_ADD" || change.kind === "JAVA_CHANGE") changed.push(change.absolutePath);
      else if (change.kind === "JAVA_DELETE") deleted.push(change.absolutePath);
      else if (change.kind === "RESOURCE_CHANGE") resources.push(change.absolutePath);
    }
    if (changed.length > 0 || deleted.length > 0) {
      await javaIndex.refresh(batch.generation, changed, deleted, { budget });
    }
    // The coordinator retains the exact resource event for LSP consumers, but
    // the worker API remains path-only and resolves each path via its own stat,
    // idempotently (Task 28 Slice B).
    if (resources.length > 0) {
      await javaIndex.refreshResources(batch.generation, resources, { budget });
    }
  }

  private refreshResource(entry: RuntimeEntry): void {
    entry.context.resource = this.resourceStatus();
    entry.context.watcher = entry.coordinator.status();
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
    if (entry.lspReservation === "STARTING" && state !== "STARTING" && state !== "READY") {
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
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  }

  private oldestIdleEntry(exempt?: RuntimeEntry): RuntimeEntry | undefined {
    return [...this.runtimes.values()]
      .filter(entry => entry !== exempt && entry.refCount === 0 && entry.stoppedAt === undefined)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  }

  private isHotIndexEntry(entry: RuntimeEntry): boolean {
    return entry.context.aliases.some(alias => this.options.hotIndexAliases.has(alias));
  }

  private familyKey(worktree: { familyHash?: string; repoHash: string } | undefined, repoHash: string): string {
    return worktree?.familyHash ?? worktree?.repoHash ?? repoHash;
  }

  private findSiblingDb(resolved: ResolvedRepo): string | undefined {
    const family = this.familyKey(resolved.worktree, resolved.repoHash);
    const self = indexDbPath(resolved.repoRoot);
    let best: { path: string; mtime: number } | undefined;
    for (const entry of this.runtimes.values()) {
      if (entry.stoppedAt !== undefined) continue;
      if (this.familyKey(entry.context.worktree, entry.context.repoHash) !== family) continue;
      const dbPath = indexDbPath(entry.context.repoRoot);
      if (dbPath === self || !existsSync(dbPath)) continue;
      const mtime = statSync(dbPath).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: dbPath, mtime };
    }
    const fromDisk = scanFamilySiblingIndex(repoCacheBase(), family, self);
    if (fromDisk && existsSync(fromDisk)) {
      const mtime = statSync(fromDisk).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: fromDisk, mtime };
    }
    return best?.path;
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
        if (entry.refCount === 0 && entry.lspReservation !== "NONE") {
          void this.stopEntry(entry);
        }
      }, this.options.idleTtlMs);
      entry.idleTimer.unref?.();
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
      .filter(entry => entry.refCount === 0 && entry.stoppedAt === undefined && !this.isHotIndexEntry(entry))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!victim) return;
    this.relievingPressure = true;
    try {
      if (victim.lspReservation !== "NONE") {
        await this.stopEntry(victim);
      }
    } finally {
      this.relievingPressure = false;
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

function indexDbPath(repoRoot: string): string {
  const dir = process.env.JAVA_LSP_INDEX_DIR?.trim();
  return path.join(dir && dir.length > 0 ? dir : repoCacheRoot(repoRoot), "index.sqlite");
}

function createRuntime(
  resolved: ResolvedRepo,
  leases: CrossProcessLeaseStore,
  transportMode: RepoOwnerTransport = "stdio",
  ownershipLifecycle?: RepoOwnershipLease
): ManagedToolContext {
  const session = new JdtlsSession(resolved.repoRoot, resolved.aliases, {
    transportMode,
    ownershipLifecycle,
    leaseStore: leases,
    worktree: resolved.worktree
  });
  const dbPath = indexDbPath(resolved.repoRoot);
  const supervisor = new BuilderSupervisor({ repoRoot: resolved.repoRoot, dbPath });
  const javaIndexClient = new SqlJavaIndexClient(resolved.repoRoot, dbPath, supervisor);
  const javaIndex = new RouterJavaIndex(resolved.repoRoot, javaIndexClient);
  const router = new AgentRouter(resolved.repoRoot, session, javaIndex);
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

function isOwnershipProvider(value: CoordinationFactory | RepoOwnershipProvider): value is RepoOwnershipProvider {
  return typeof value === "object" && value !== null && typeof (value as RepoOwnershipProvider).acquire === "function";
}

function isLeaseStore(value: unknown): value is CrossProcessLeaseStore {
  return typeof value === "object" && value !== null && typeof (value as CrossProcessLeaseStore).open === "function";
}

function createDefaultLeaseStore(): CrossProcessLeaseStore {
  return new FileCrossProcessLeaseStore(path.join(repoCacheBase(), "leases"), defaultLeaseClockDeps());
}

function createCoordination(resolved: ResolvedRepo, indexedFileCount: () => number): RuntimeCoordination {
  const generation = new GenerationClock();
  const layout = new LayoutManager(resolved.repoRoot, resolved.layoutProfile);
  const coordinator = new RepoChangeCoordinator(
    resolved.repoRoot,
    resolved.worktree,
    repoCacheBase(),
    generation,
    layout,
    undefined,
    indexedFileCount
  );
  return { generation, coordinator, layout };
}

// input: Resolved repo roots.
// output: Per-repo runtime contexts.
// pos: Lazy runtime manager; one context per canonical repoRoot with small LRU/idle control.
import path from "node:path";
import { AgentRouter } from "./agent-router/index.js";
import {
  defaultLeaseClockDeps,
  FileCrossProcessLeaseStore,
  type CrossProcessLeaseStatus,
  type CrossProcessLeaseStore
} from "./cross-process-lease.js";
import { JdtlsSession, type JdtlsLifecycleState } from "./jdtls-session.js";
import { LayoutManager, type LayoutSource } from "./layout-manager.js";
import { RepoChangeCoordinator } from "./repo-change-coordinator.js";
import { GenerationClock, type RepoChangeBatch } from "./repo-generation.js";
import { repoCacheBase } from "./repo-layout.js";
import { RepoResolver, type RepoSelector, type ResolvedRepo } from "./repo-resolver.js";
import { positiveInteger, resourceDefaults, type ResourceDefaults } from "./resource-defaults.js";
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
import { SourceIndex } from "./source-index.js";
import type { ToolContext } from "./tools/context.js";
import { touchRepoCache } from "./worktree-cache-cleanup.js";

export type RequestOptionsInput = {
  mode: RequestMode;
  semanticPolicy: SemanticPolicy;
  deadlineMs?: number;
};

/** How long a watcher-ready wait may borrow from the request budget. */
const WATCHER_READY_CAP_MS = 2000;

/** The subset of RepoChangeCoordinator the runtime manager depends on. */
export interface RuntimeCoordinator {
  start(): Promise<void>;
  flushNow(): Promise<void>;
  awaitReadyWithin(ms: number): Promise<boolean>;
  close(): Promise<void>;
  onBatch(listener: (batch: RepoChangeBatch) => void | Promise<void>): () => void;
  status(): { ready: boolean; degraded: boolean; pending: number };
}

export type RuntimeCoordination = {
  generation: GenerationClock;
  coordinator: RuntimeCoordinator;
  layout: LayoutSource;
};

export type CoordinationFactory = (resolved: ResolvedRepo) => RuntimeCoordination;

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
  requestTimeoutMs: number;
  maxRetainedStoppedRepos: number;
};

export class RepoRuntimeManager {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly creating = new Map<string, Promise<RuntimeEntry>>();
  private readonly slotWaiters: SlotWaiter[] = [];
  private servicingWaiters = false;
  private readonly options: RuntimeManagerOptions;
  private readonly defaults: ResourceDefaults;

  private leaseReady?: Promise<void>;
  private leaseInitError?: string;

  constructor(
    private readonly resolver: Pick<RepoResolver, "resolve">,
    options: Partial<RuntimeManagerOptions> = {},
    private readonly runtimeFactory: (resolved: ResolvedRepo, leases: CrossProcessLeaseStore) => ManagedToolContext = createRuntime,
    private readonly coordinationFactory: CoordinationFactory = createCoordination,
    private readonly leases: CrossProcessLeaseStore = createDefaultLeaseStore()
  ) {
    this.defaults = resourceDefaults();
    this.options = {
      maxActiveRepos: positiveInteger(process.env.JAVA_LSP_MAX_ACTIVE_REPOS, this.defaults.maxActiveRepos),
      idleTtlMs: positiveInteger(process.env.JAVA_LSP_IDLE_TTL_MS, this.defaults.idleTtlMs),
      requestTimeoutMs: positiveInteger(process.env.JAVA_LSP_REQUEST_TIMEOUT_MS, 120000),
      maxRetainedStoppedRepos: positiveInteger(process.env.JAVA_LSP_MAX_RETAINED_STOPPED_REPOS, 2),
      ...options
    };
  }

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

  async withContext<T>(
    selector: RepoSelector,
    handler: (context: ManagedToolContext, request: RequestContext) => Promise<T>,
    options: { mayStartLsp?: boolean; requestOptions?: RequestOptionsInput } = {}
  ): Promise<T> {
    const resolved = await this.resolver.resolve(selector);
    const entry = await this.getOrCreate(resolved);
    this.refreshResource(entry);
    entry.refCount += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    try {
      const request = await this.prepareRequestContext(entry, options.requestOptions);
      if (options.mayStartLsp) {
        await this.reserveLspSlot(entry, DeadlineBudget.fromTimeout(this.options.requestTimeoutMs));
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

  /**
   * The freshness barrier: settle the watcher, reconcile if dirty, then fix the
   * request's generation and cache policy. A watcher-ready timeout is not a
   * failure — the request proceeds DEGRADED with caches and negative answers off.
   */
  private async prepareRequestContext(
    entry: RuntimeEntry,
    requestOptions?: RequestOptionsInput
  ): Promise<RequestContext> {
    const mode = requestOptions?.mode ?? "balanced";
    const semanticPolicy = requestOptions?.semanticPolicy ?? "auto";
    const deadlineMs = Math.min(
      MAX_REQUEST_DEADLINE_MS,
      requestOptions?.deadlineMs ?? defaultDeadlineMs(mode, semanticPolicy)
    );
    const budget = DeadlineBudget.fromTimeout(deadlineMs);

    const ready = await entry.coordinator.awaitReadyWithin(
      Math.min(WATCHER_READY_CAP_MS, budget.remainingMs())
    );

    let freshnessMode: RequestFreshnessMode;
    let cacheReadAllowed = false;
    let cacheWriteAllowed = false;
    const negativeLookupAllowed = false; // negative-answer coverage tracking arrives in Iteration C

    if (ready) {
      await entry.coordinator.flushNow();      // already-delivered debounced events
      await this.reconcileIfDirty(entry);      // no-op unless a reconcile is pending
      await entry.coordinator.flushNow();      // events delivered during reconcile
      const clock = entry.generation.snapshot();
      freshnessMode = clock.dirty ? "WATCHER_DEGRADED" : "NORMAL";
      cacheReadAllowed = !clock.dirty;
      cacheWriteAllowed = !clock.dirty;
    } else {
      freshnessMode = entry.generation.snapshot().dirty ? "WATCHER_DEGRADED" : "WATCHER_NOT_READY";
    }

    return createRequestContext({
      repoRoot: entry.context.repoRoot,
      repoHash: entry.context.repoHash,
      familyHash: entry.context.worktree?.familyHash,
      generation: entry.generation.snapshot().value,
      freshnessMode,
      cacheReadAllowed,
      cacheWriteAllowed,
      negativeLookupAllowed,
      mode,
      semanticPolicy,
      deadlineMs,
      budget
    });
  }

  /**
   * Singleflight: two concurrent requests against a dirty runtime share one
   * reconcile. A failure leaves `dirty` set (clearDirty is never reached), so
   * the runtime stays DEGRADED and the next request tries again rather than
   * silently believing the index is clean.
   */
  private async reconcileIfDirty(entry: RuntimeEntry): Promise<void> {
    if (!entry.generation.snapshot().dirty) return;
    if (!entry.reconcilePromise) {
      const operation = (async () => {
        const generationAtStart = entry.generation.snapshot().value;
        try {
          await entry.context.sourceIndex.reconcile(entry.layout.current(), generationAtStart);
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
    await entry.reconcilePromise;
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

  async shutdownAll(): Promise<void> {
    for (const waiter of this.slotWaiters.splice(0)) {
      waiter.cancel();
    }
    await Promise.all([...this.runtimes.values()].map(entry => this.stopEntry(entry)));
    // A prior shutdown(repoRoot) may have already closed some coordinators;
    // RepoChangeCoordinator.close() is idempotent, so closing the rest here
    // (and re-closing the already-closed ones) is safe either way.
    await Promise.all([...this.runtimes.values()].map(entry => entry.coordinator.close()));
    for (const entry of this.runtimes.values()) {
      entry.unsubscribeLifecycle?.();
      entry.unsubscribeLifecycle = undefined;
    }
  }

  /** Singleflight so two concurrent requests share one runtime/coordinator/watcher. */
  private async getOrCreate(resolved: ResolvedRepo): Promise<RuntimeEntry> {
    touchRepoCache(resolved.repoRoot);
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
    if (pending) return pending;
    const operation = this.createEntry(resolved).finally(() => {
      if (this.creating.get(resolved.repoRoot) === operation) {
        this.creating.delete(resolved.repoRoot);
      }
    });
    this.creating.set(resolved.repoRoot, operation);
    return operation;
  }

  private async createEntry(resolved: ResolvedRepo): Promise<RuntimeEntry> {
    const { generation, coordinator, layout } = this.coordinationFactory(resolved);
    const entry: RuntimeEntry = {
      context: this.runtimeFactory(resolved, this.leases),
      generation,
      coordinator,
      layout,
      ready: Promise.resolve(),
      refCount: 0,
      lastUsedAt: Date.now(),
      lspReservation: "NONE"
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
    coordinator.onBatch(batch => {
      entry.context.router.onRepoChanged(batch);
      entry.context.sourceIndex.applyChanges(batch);
      entry.context.session.invalidateForRepoChanges(batch);
    });
    // Store the readiness promise; the freshness barrier (Task 10) waits on it
    // only within the request budget, so a slow initial scan never blocks here.
    entry.ready = coordinator.start();
    this.runtimes.set(resolved.repoRoot, entry);
    return entry;
  }

  private refreshResource(entry: RuntimeEntry): void {
    entry.context.resource = this.resourceStatus();
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

  private scheduleIdleShutdown(entry: RuntimeEntry): void {
    if (this.options.idleTtlMs <= 0) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (entry.refCount === 0 && entry.lspReservation !== "NONE") {
        void this.stopEntry(entry);
      }
    }, this.options.idleTtlMs);
    entry.idleTimer.unref?.();
  }

  private async stopEntry(entry: RuntimeEntry): Promise<void> {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    await entry.context.session.stop();
    entry.context.router.clearRgCache();
    // The lifecycle listener normally clears this on STOPPED; assign it here too
    // so eviction is authoritative even for a session that never transitioned.
    entry.lspReservation = "NONE";
    this.drainSlotWaiters();
  }
}

function createRuntime(resolved: ResolvedRepo, leases: CrossProcessLeaseStore): ManagedToolContext {
  const session = new JdtlsSession(resolved.repoRoot, resolved.aliases, undefined, undefined, leases, resolved.worktree);
  const sourceIndex = new SourceIndex(resolved.repoRoot);
  const router = new AgentRouter(resolved.repoRoot, session, sourceIndex);
  return {
    repoRoot: resolved.repoRoot,
    rootSource: resolved.rootSource,
    repoHash: resolved.repoHash,
    aliases: resolved.aliases,
    layoutProfile: resolved.layoutProfile,
    lsp: resolved.lsp,
    worktree: resolved.worktree,
    session,
    sourceIndex,
    router
  };
}

function createDefaultLeaseStore(): CrossProcessLeaseStore {
  return new FileCrossProcessLeaseStore(path.join(repoCacheBase(), "leases"), defaultLeaseClockDeps());
}

function createCoordination(resolved: ResolvedRepo): RuntimeCoordination {
  const generation = new GenerationClock();
  const layout = new LayoutManager(resolved.repoRoot, resolved.layoutProfile);
  const coordinator = new RepoChangeCoordinator(
    resolved.repoRoot,
    resolved.worktree,
    repoCacheBase(),
    generation,
    layout
  );
  return { generation, coordinator, layout };
}

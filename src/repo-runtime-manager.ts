// input: Resolved repo roots.
// output: Per-repo runtime contexts.
// pos: Lazy runtime manager; one context per canonical repoRoot with small LRU/idle control.
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
import { JavaIndexClient } from "./java-index/java-index-client.js";
import { LayoutManager, type LayoutSource } from "./layout-manager.js";
import { RepoChangeCoordinator } from "./repo-change-coordinator.js";
import { GenerationClock, type RepoChangeBatch } from "./repo-generation.js";
import { repoCacheBase, repoCacheRoot } from "./repo-layout.js";
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
  /**
   * Optional: only `createRuntime` (the production factory) constructs one.
   * Test fixtures that inject their own `runtimeFactory` may omit it, since
   * nothing yet requires it (Task 22 wires AgentRouter to query it).
   */
  javaIndex?: JavaIndexClient;
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
          await entry.context.javaIndex?.reconcile(generationAtStart).catch(() => undefined);
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
    await entry.context.javaIndex?.close().catch(() => undefined);
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

  async shutdownAll(): Promise<void> {
    for (const waiter of this.slotWaiters.splice(0)) {
      waiter.cancel();
    }
    await Promise.all([...this.runtimes.values()].map(entry => this.stopEntry(entry)));
    // A prior shutdown(repoRoot) may have already closed some coordinators;
    // RepoChangeCoordinator.close() is idempotent, so closing the rest here
    // (and re-closing the already-closed ones) is safe either way.
    await Promise.all([...this.runtimes.values()].map(async entry => {
      await entry.coordinator.close();
      await entry.context.javaIndex?.close().catch(() => undefined);
      await entry.runtimeLease?.release();
      entry.runtimeLease = undefined;
      touchRepoCache(entry.context.repoRoot, { ownerPid: undefined, ownerToken: undefined });
    }));
    for (const entry of this.runtimes.values()) {
      entry.unsubscribeLifecycle?.();
      entry.unsubscribeLifecycle = undefined;
    }
  }

  /** Singleflight so two concurrent requests share one runtime/coordinator/watcher. */
  private async getOrCreate(resolved: ResolvedRepo): Promise<RuntimeEntry> {
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
    const context = this.runtimeFactory(resolved, this.leases);
    const { generation, coordinator, layout } = this.coordinationFactory(resolved, () => context.sourceIndex.status().entries);
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
      runtimeLease: await this.leases.acquireRuntime(resolved.worktree).catch(() => undefined)
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
    coordinator.onBatch(async batch => {
      entry.context.router.onRepoChanged(batch);
      entry.context.sourceIndex.applyChanges(batch);
      entry.context.session.invalidateForRepoChanges(batch);
      await this.applyBatchToJavaIndex(entry.context.javaIndex, batch);
    });
    // Best-effort: chokidar's initial scan (ignoreInitial: true) never emits
    // an onBatch for pre-existing files, so the Java index's first full
    // discovery is kicked off explicitly here rather than waiting for one.
    // A failed open must not fail runtime creation; the client self-degrades.
    await entry.context.javaIndex?.open(generation.snapshot().value, {
      leaseRoot: path.join(repoCacheBase(), "leases"),
      worktree: resolved.worktree,
      siblingCacheBase: repoCacheBase()
    }).then(async openStatus => {
      // A restored-and-verified snapshot (Task 21 Step 6a) reports its own
      // (possibly higher) generation; the repo's clock must never regress
      // behind facts the Java index has already verified as current.
      generation.rebaseAtLeast(openStatus.indexedGeneration);
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
      if (!fullyRestored) await entry.context.javaIndex?.reconcile(generation.snapshot().value);
    }).catch(() => undefined);
    // Store the readiness promise; the freshness barrier (Task 10) waits on it
    // only within the request budget, so a slow initial scan never blocks here.
    entry.ready = coordinator.start();
    this.runtimes.set(resolved.repoRoot, entry);
    return entry;
  }

  /**
   * Maps one coordinator batch onto the Java index's own refresh/reconcile
   * contract (Task 20 Step 7). A storm or a build-file change routes to a
   * background reconcile rather than a per-path foreground refresh, matching
   * how the batch is already handled for SourceIndex/freshness. A listener
   * throw here is caught by RepoChangeCoordinator's own per-listener catch,
   * which marks the generation dirty for the next request's retry - the same
   * treatment a SourceIndex failure already gets.
   */
  private async applyBatchToJavaIndex(
    javaIndex: JavaIndexClient | undefined,
    batch: RepoChangeBatch
  ): Promise<void> {
    if (!javaIndex) return;
    if (batch.storm || batch.changes.some(change => change.kind === "BUILD_CHANGE")) {
      await javaIndex.reconcile(batch.generation);
      return;
    }
    const changed: string[] = [];
    const deleted: string[] = [];
    for (const change of batch.changes) {
      if (change.kind === "JAVA_ADD" || change.kind === "JAVA_CHANGE") changed.push(change.absolutePath);
      else if (change.kind === "JAVA_DELETE") deleted.push(change.absolutePath);
    }
    if (changed.length > 0 || deleted.length > 0) {
      await javaIndex.refresh(batch.generation, changed, deleted);
    }
  }

  private refreshResource(entry: RuntimeEntry): void {
    entry.context.resource = this.resourceStatus();
    entry.context.watcher = entry.coordinator.status();
    // The multi-process janitor's authoritative signal (Task 12c) is the
    // runtime lease itself; this touch just refreshes the diagnostic
    // fallback fields and lastRequestAt/updatedAt so a fast-only (never
    // started JDT) repo still looks recently used.
    touchRepoCache(entry.context.repoRoot, {
      repoHash: entry.context.repoHash,
      familyHash: entry.context.worktree?.familyHash,
      ownerPid: process.pid,
      ownerToken: entry.runtimeLease?.owner.ownerToken
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
  const javaIndex = new JavaIndexClient(resolved.repoRoot, repoCacheRoot(resolved.repoRoot));
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
    router,
    javaIndex
  };
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

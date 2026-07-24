// input: Resolved repo roots.
// output: Per-repo runtime contexts.
// pos: Lazy runtime manager; one context per canonical repoRoot with small LRU/idle control.
import { AgentRouter } from "./agent-router/index.js";
import { JdtlsSession, type JdtlsLifecycleState } from "./jdtls-session.js";
import { RepoResolver, type RepoSelector, type ResolvedRepo } from "./repo-resolver.js";
import { positiveInteger, resourceDefaults, type ResourceDefaults } from "./resource-defaults.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import { SourceIndex } from "./source-index.js";
import type { ToolContext } from "./tools/context.js";
import { touchRepoCache } from "./worktree-cache-cleanup.js";

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
  refCount: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
  lspReservation: LspReservation;
  unsubscribeLifecycle?: () => void;
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
};

export class RepoRuntimeManager {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly slotWaiters: SlotWaiter[] = [];
  private servicingWaiters = false;
  private readonly options: RuntimeManagerOptions;
  private readonly defaults: ResourceDefaults;

  constructor(
    private readonly resolver: Pick<RepoResolver, "resolve">,
    options: Partial<RuntimeManagerOptions> = {},
    private readonly runtimeFactory: (resolved: ResolvedRepo) => ManagedToolContext = createRuntime
  ) {
    this.defaults = resourceDefaults();
    this.options = {
      maxActiveRepos: positiveInteger(process.env.JAVA_LSP_MAX_ACTIVE_REPOS, this.defaults.maxActiveRepos),
      idleTtlMs: positiveInteger(process.env.JAVA_LSP_IDLE_TTL_MS, this.defaults.idleTtlMs),
      requestTimeoutMs: positiveInteger(process.env.JAVA_LSP_REQUEST_TIMEOUT_MS, 120000),
      ...options
    };
  }

  async contextFor(selector: RepoSelector): Promise<ManagedToolContext> {
    const resolved = await this.resolver.resolve(selector);
    const entry = this.getOrCreate(resolved);
    this.refreshResource(entry);
    return entry.context;
  }

  async withContext<T>(
    selector: RepoSelector,
    handler: (context: ManagedToolContext) => Promise<T>,
    options: { mayStartLsp?: boolean } = {}
  ): Promise<T> {
    const resolved = await this.resolver.resolve(selector);
    const entry = this.getOrCreate(resolved);
    this.refreshResource(entry);
    entry.refCount += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    try {
      if (options.mayStartLsp) {
        await this.reserveLspSlot(entry, DeadlineBudget.fromTimeout(this.options.requestTimeoutMs));
      }
      return await handler(entry.context);
    } finally {
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
      this.releaseUnusedReservation(entry);
      this.scheduleIdleShutdown(entry);
      void this.serviceSlotWaiters();
    }
  }

  reservedCount(): number {
    return this.reservedEntries().length;
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

  async shutdownAll(): Promise<void> {
    for (const waiter of this.slotWaiters.splice(0)) {
      waiter.cancel();
    }
    await Promise.all([...this.runtimes.values()].map(entry => this.stopEntry(entry)));
    for (const entry of this.runtimes.values()) {
      entry.unsubscribeLifecycle?.();
      entry.unsubscribeLifecycle = undefined;
    }
  }

  private getOrCreate(resolved: ResolvedRepo): RuntimeEntry {
    let entry = this.runtimes.get(resolved.repoRoot);
    touchRepoCache(resolved.repoRoot);
    if (!entry) {
      const created: RuntimeEntry = {
        context: this.runtimeFactory(resolved),
        refCount: 0,
        lastUsedAt: Date.now(),
        lspReservation: "NONE"
      };
      created.unsubscribeLifecycle = created.context.session.onLifecycleChange(state => {
        if (state === "STARTING") created.lspReservation = "STARTING";
        else if (state === "READY") created.lspReservation = "READY";
        else {
          created.lspReservation = "NONE";
          this.drainSlotWaiters();
        }
      });
      entry = created;
      this.runtimes.set(resolved.repoRoot, entry);
    } else {
      entry.context.aliases = resolved.aliases;
      entry.context.rootSource = resolved.rootSource;
      entry.context.layoutProfile = resolved.layoutProfile;
      entry.context.lsp = resolved.lsp;
    }
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

function createRuntime(resolved: ResolvedRepo): ManagedToolContext {
  const session = new JdtlsSession(resolved.repoRoot, resolved.aliases);
  const sourceIndex = new SourceIndex(resolved.repoRoot);
  const router = new AgentRouter(resolved.repoRoot, session, sourceIndex);
  return {
    repoRoot: resolved.repoRoot,
    rootSource: resolved.rootSource,
    repoHash: resolved.repoHash,
    aliases: resolved.aliases,
    layoutProfile: resolved.layoutProfile,
    lsp: resolved.lsp,
    session,
    sourceIndex,
    router
  };
}

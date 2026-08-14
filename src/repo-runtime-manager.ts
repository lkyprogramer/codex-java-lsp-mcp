// input: Resolved repo roots.
// output: Per-repo runtime contexts.
// pos: Lazy runtime manager; one context per canonical repoRoot with small LRU/idle control.
import { AgentRouter } from "./agent-router/index.js";
import { JdtlsSession } from "./jdtls-session.js";
import { RepoResolver, type RepoSelector, type ResolvedRepo } from "./repo-resolver.js";
import type { RepoOwnershipLease, RepoOwnershipProvider, RepoOwnerTransport } from "./repo-ownership-lease.js";
import { positiveInteger, resourceDefaults, type ResourceDefaults } from "./resource-defaults.js";
import { SourceIndex } from "./source-index.js";
import type { ToolContext } from "./tools/context.js";
import { touchRepoCache, type RepoCacheTouch } from "./worktree-cache-cleanup.js";
import { RuntimeLifecycleGate } from "./runtime-lifecycle-gate.js";

export type ManagedToolContext = ToolContext & {
  repoHash: string;
  rootSource: NonNullable<ToolContext["rootSource"]>;
  aliases: string[];
  layoutProfile: string;
  lsp: ResolvedRepo["lsp"];
};

type RuntimeEntry = {
  context: ManagedToolContext;
  ownership: RepoOwnershipLease;
  refCount: number;
  lastUsedAt: number;
  slotState: "NONE" | "STARTING" | "READY" | "STOPPING";
  slotGeneration: number;
  startingClaims: number;
  activityGeneration: number;
  evictionFailures: number;
  nextEvictionAttemptAt: number;
  entryState: "ACTIVE" | "EVICTING" | "EVICTED";
  gate: RuntimeLifecycleGate;
  idleTimer?: NodeJS.Timeout;
};

type SlotClaim = {
  entry: RuntimeEntry;
  generation: number;
  counted: boolean;
};

type SlotDecision =
  | { kind: "claim"; claim: SlotClaim }
  | { kind: "stop-victim"; entry: RuntimeEntry; observedGeneration: number }
  | { kind: "wait"; version: number };

const RETRY_RUNTIME_ENTRY = Symbol("retry-runtime-entry");

type RuntimeManagerOptions = {
  maxActiveRepos: number;
  idleTtlMs: number;
  requestTimeoutMs: number;
  runtimeEntryTtlMs: number;
  maxRuntimeEntries: number;
  entryEvictionRetryBaseMs: number;
  transportMode: RepoOwnerTransport;
};

export class RepoRuntimeManager {
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly options: RuntimeManagerOptions;
  private readonly defaults: ResourceDefaults;
  private readonly allocationMutex = new AsyncMutex();
  private readonly entryEvictionMutex = new AsyncMutex();
  private readonly allocationWaiters = new Set<() => void>();
  private allocationVersion = 0;
  private entrySweepTimer?: NodeJS.Timeout;
  private entrySweepDueAt?: number;
  private terminalShutdown = false;
  private terminalReleaseOwnership = false;
  private readonly runtimeFactory: (resolved: ResolvedRepo, ownership: RepoOwnershipLease) => ManagedToolContext;

  constructor(
    private readonly resolver: Pick<RepoResolver, "resolve">,
    options: Partial<RuntimeManagerOptions> = {},
    runtimeFactory?: (resolved: ResolvedRepo, ownership: RepoOwnershipLease) => ManagedToolContext,
    private readonly ownership: RepoOwnershipProvider = noOwnership,
    private readonly touchCache: (repoRoot: string, extra?: RepoCacheTouch) => void = touchRepoCache
  ) {
    this.defaults = resourceDefaults();
    this.options = {
      maxActiveRepos: positiveInteger(process.env.JAVA_LSP_MAX_ACTIVE_REPOS, this.defaults.maxActiveRepos),
      idleTtlMs: positiveInteger(process.env.JAVA_LSP_IDLE_TTL_MS, this.defaults.idleTtlMs),
      requestTimeoutMs: positiveInteger(process.env.JAVA_LSP_REQUEST_TIMEOUT_MS, 120000),
      runtimeEntryTtlMs: positiveInteger(process.env.JAVA_LSP_RUNTIME_ENTRY_TTL_MS, 3600000),
      maxRuntimeEntries: positiveInteger(process.env.JAVA_LSP_MAX_RUNTIME_ENTRIES, 16),
      entryEvictionRetryBaseMs: 1000,
      transportMode: "stdio",
      ...options
    };
    this.runtimeFactory = runtimeFactory ?? ((resolved, ownership) => createRuntime(resolved, this.options.transportMode, ownership));
  }

  async contextFor(selector: RepoSelector): Promise<ManagedToolContext> {
    return this.withQuery(selector, async context => context);
  }

  async withContext<T>(
    selector: RepoSelector,
    handler: (context: ManagedToolContext) => Promise<T>,
    options: { mayStartLsp?: boolean } = {}
  ): Promise<T> {
    return this.withQuery(selector, handler, options);
  }

  async withQuery<T>(
    selector: RepoSelector,
    handler: (context: ManagedToolContext) => Promise<T>,
    options: { mayStartLsp?: boolean } = {}
  ): Promise<T> {
    const resolved = await this.resolver.resolve(selector);
    while (true) {
      const entry = this.getOrCreate(resolved);
      try {
        return await entry.gate.withQuery(async () => {
          this.assertUsableEntry(entry);
          entry.activityGeneration += 1;
          this.refreshResource(entry);
          entry.refCount += 1;
          this.clearIdleTimer(entry);
          let slotClaim: SlotClaim | undefined;
          try {
            if (options.mayStartLsp) {
              slotClaim = await this.reserveLspSlot(entry);
            }
            return await handler(entry.context);
          } finally {
            entry.refCount = Math.max(0, entry.refCount - 1);
            entry.lastUsedAt = Date.now();
            if (slotClaim) {
              await this.completeSlotClaim(slotClaim);
            }
            this.scheduleIdleShutdown(entry);
          }
        }, this.options.requestTimeoutMs);
      } catch (error) {
        if (error !== RETRY_RUNTIME_ENTRY) {
          throw error;
        }
      } finally {
        await this.signalAllocationChange();
        this.scheduleRuntimeEntrySweep();
      }
    }
  }

  async withControl<T>(
    selector: RepoSelector,
    handler: (context: ManagedToolContext) => Promise<T>,
    options: { mayStartLsp?: boolean } = {}
  ): Promise<T> {
    const resolved = await this.resolver.resolve(selector);
    while (true) {
      const entry = this.getOrCreate(resolved);
      try {
        return await entry.gate.withControl(async () => {
          this.assertUsableEntry(entry);
          entry.activityGeneration += 1;
          this.refreshResource(entry);
          this.clearIdleTimer(entry);
          let slotClaim: SlotClaim | undefined;
          try {
            if (options.mayStartLsp) {
              slotClaim = await this.reserveLspSlot(entry);
            }
            return await handler(entry.context);
          } finally {
            entry.lastUsedAt = Date.now();
            if (slotClaim) {
              await this.completeSlotClaim(slotClaim);
            } else {
              await this.reconcileEntrySlot(entry);
            }
            this.scheduleIdleShutdown(entry);
          }
        }, this.options.requestTimeoutMs);
      } catch (error) {
        if (error !== RETRY_RUNTIME_ENTRY) {
          throw error;
        }
      } finally {
        await this.signalAllocationChange();
        this.scheduleRuntimeEntrySweep();
      }
    }
  }

  activeRepos(): Array<{
    repoRoot: string;
    repoHash: string;
    aliases: string[];
    started: boolean;
    pid?: number;
    refCount: number;
    lastUsedAt: string;
    slotState: RuntimeEntry["slotState"];
    entryState: RuntimeEntry["entryState"];
    controlActive: boolean;
    pendingControls: number;
  }> {
    return [...this.runtimes.values()].map(entry => {
      const context = entry.context;
      const status = context.session.status();
      return {
        repoRoot: context.repoRoot,
        repoHash: context.repoHash,
        aliases: context.aliases,
        started: Boolean(status.started),
        pid: status.pid,
        refCount: entry.refCount,
        lastUsedAt: new Date(entry.lastUsedAt).toISOString(),
        slotState: entry.slotState,
        entryState: entry.entryState,
        controlActive: entry.gate.state().controlActive,
        pendingControls: entry.gate.state().pendingControls
      };
    });
  }

  resourceStatus(): NonNullable<ToolContext["resource"]> {
    const started = this.startedEntries()
      .map(entry => entry.context.session.status().pid)
      .filter((pid): pid is number => typeof pid === "number");
    return {
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

  retainedRepoRoots(): Set<string> {
    return new Set(this.runtimes.keys());
  }

  async shutdownAll(options: { releaseOwnership?: boolean; terminal?: boolean } = {}): Promise<void> {
    const terminal = options.terminal ?? Boolean(options.releaseOwnership);
    if (terminal) {
      this.terminalShutdown = true;
      this.terminalReleaseOwnership = Boolean(options.releaseOwnership);
      this.clearRuntimeEntrySweep();
      await this.entryEvictionMutex.runExclusive(async () => {
        await this.shutdownEntries(Boolean(options.releaseOwnership));
      });
      return;
    }
    await this.shutdownEntries(false);
    this.scheduleRuntimeEntrySweep();
  }

  async forceTerminateOwnedJdtls(deadlineMs = 1000): Promise<void> {
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
      throw new Error(`Invalid forced runtime shutdown deadline: ${deadlineMs}`);
    }
    this.terminalShutdown = true;
    this.terminalReleaseOwnership = false;
    this.clearRuntimeEntrySweep();
    for (const entry of this.runtimes.values()) {
      this.clearIdleTimer(entry);
    }
    const results = await Promise.allSettled([...this.runtimes.values()].map(async entry => {
      await settleBefore(
        entry.context.session.forceStop(Math.floor(deadlineMs)),
        Math.floor(deadlineMs),
        `force-stopping JDT LS for ${entry.context.repoRoot}`
      );
      entry.context.router.dispose();
      entry.context.sourceIndex.dispose();
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map(result => result.reason),
        `Failed to force-stop ${failures.length} repository runtime(s); ownership remains retained.`
      );
    }
  }

  private async shutdownEntries(releaseOwnership: boolean): Promise<void> {
    const results = await Promise.allSettled([...this.runtimes.values()].map(async entry => {
      await entry.gate.withControl(async () => {
        await this.stopEntry(entry);
        if (releaseOwnership) {
          await this.disposeAndReleaseEntry(entry);
        }
      }, this.options.requestTimeoutMs);
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(failures.map(result => result.reason), `Failed to stop ${failures.length} repository runtime(s).`);
    }
  }

  async evictInactiveEntries(now = Date.now()): Promise<number> {
    return this.entryEvictionMutex.runExclusive(async () => {
      if (this.terminalShutdown) {
        return 0;
      }
      try {
        let evicted = 0;
        let excess = Math.max(0, this.runtimes.size - this.options.maxRuntimeEntries);
        const candidates = [...this.runtimes.values()]
          .filter(entry => entry.entryState === "ACTIVE"
            && entry.refCount === 0
            && entry.slotState === "NONE"
            && !this.isStarted(entry)
            && entry.gate.isIdle()
            && !entry.context.sourceIndex.isBusy()
            && entry.nextEvictionAttemptAt <= now)
          .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
        for (const entry of candidates) {
          const expired = now - entry.lastUsedAt >= this.options.runtimeEntryTtlMs;
          if (!expired && excess <= 0) {
            continue;
          }
          if (await this.evictEntry(entry, entry.activityGeneration)) {
            evicted += 1;
            excess = Math.max(0, excess - 1);
          }
        }
        return evicted;
      } finally {
        this.scheduleRuntimeEntrySweep();
      }
    });
  }

  private getOrCreate(resolved: ResolvedRepo): RuntimeEntry {
    if (this.terminalShutdown) {
      throw new Error("Repository runtime manager is shut down.");
    }
    let entry = this.runtimes.get(resolved.repoRoot);
    if (!entry) {
      const ownership = this.ownership.acquire(resolved.repoRoot);
      try {
        this.touchCache(resolved.repoRoot, { ownership: ownership.metadata });
        entry = {
          context: this.runtimeFactory(resolved, ownership),
          ownership,
          refCount: 0,
          lastUsedAt: Date.now(),
          slotState: "NONE",
          slotGeneration: 0,
          startingClaims: 0,
          activityGeneration: 0,
          evictionFailures: 0,
          nextEvictionAttemptAt: 0,
          entryState: "ACTIVE",
          gate: new RuntimeLifecycleGate()
        };
        entry.context.runBackgroundTask = operation => this.runBackgroundTask(entry!, operation);
      } catch (error) {
        ownership.release();
        throw error;
      }
      this.runtimes.set(resolved.repoRoot, entry);
    } else if (entry.entryState === "ACTIVE") {
      this.touchCache(resolved.repoRoot, { ownership: entry.ownership.metadata });
      entry.context.aliases = resolved.aliases;
      entry.context.rootSource = resolved.rootSource;
      entry.context.layoutProfile = resolved.layoutProfile;
      entry.context.lsp = resolved.lsp;
    }
    return entry;
  }

  private assertUsableEntry(entry: RuntimeEntry): void {
    if (this.runtimes.get(entry.context.repoRoot) !== entry || entry.entryState === "EVICTED") {
      throw RETRY_RUNTIME_ENTRY;
    }
    if (entry.entryState !== "ACTIVE") {
      throw new Error(`Repository runtime eviction did not complete safely: ${entry.context.repoRoot}`);
    }
  }

  private runBackgroundTask(entry: RuntimeEntry, operation: () => Promise<void>): boolean {
    const task = entry.gate.tryRunQuery(async () => {
      this.assertUsableEntry(entry);
      entry.activityGeneration += 1;
      entry.refCount += 1;
      this.clearIdleTimer(entry);
      try {
        await operation();
      } finally {
        entry.refCount = Math.max(0, entry.refCount - 1);
        entry.lastUsedAt = Date.now();
        this.scheduleIdleShutdown(entry);
      }
    });
    if (!task) {
      return false;
    }
    void task.catch(error => {
      console.error("[codex-java-lsp] background runtime task failed", error);
    }).finally(async () => {
      await this.signalAllocationChange();
      this.scheduleRuntimeEntrySweep();
    }).catch(error => {
      console.error("[codex-java-lsp] background runtime cleanup failed", error);
    });
    return true;
  }

  private refreshResource(entry: RuntimeEntry): void {
    entry.context.resource = this.resourceStatus();
  }

  private async reserveLspSlot(current: RuntimeEntry): Promise<SlotClaim> {
    const deadline = Date.now() + this.options.requestTimeoutMs;
    while (true) {
      const decision = await this.allocationMutex.runExclusive(() => this.allocateSlot(current));
      if (decision.kind === "claim") {
        return decision.claim;
      }
      if (decision.kind === "stop-victim") {
        await this.stopReservedVictim(decision.entry, decision.observedGeneration);
        continue;
      }
      await this.waitForAllocation(deadline, decision.version);
    }
  }

  private allocateSlot(current: RuntimeEntry): SlotDecision {
    this.reconcileSlotStates();
    if (current.slotState === "READY") {
      return {
        kind: "claim",
        claim: { entry: current, generation: current.slotGeneration, counted: false }
      };
    }
    if (current.slotState === "STARTING") {
      current.startingClaims += 1;
      return {
        kind: "claim",
        claim: { entry: current, generation: current.slotGeneration, counted: true }
      };
    }
    if (current.slotState === "STOPPING") {
      return { kind: "wait", version: this.allocationVersion };
    }
    if (current.slotState === "NONE" && this.occupiedSlotCount() < this.options.maxActiveRepos) {
      current.slotState = "STARTING";
      current.slotGeneration += 1;
      current.startingClaims = 1;
      return {
        kind: "claim",
        claim: { entry: current, generation: current.slotGeneration, counted: true }
      };
    }

    const victim = [...this.runtimes.values()]
      .filter(entry => entry !== current
        && entry.slotState === "READY"
        && entry.refCount === 0
        && entry.gate.isIdle())
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!victim) {
      return { kind: "wait", version: this.allocationVersion };
    }
    return { kind: "stop-victim", entry: victim, observedGeneration: victim.slotGeneration };
  }

  private isStarted(entry: RuntimeEntry): boolean {
    return Boolean(entry.context.session.status().started);
  }

  private startedEntries(): RuntimeEntry[] {
    return [...this.runtimes.values()].filter(entry => this.isStarted(entry));
  }

  private occupiedSlotCount(): number {
    return [...this.runtimes.values()].filter(entry => entry.slotState !== "NONE").length;
  }

  private reconcileSlotStates(): void {
    for (const entry of this.runtimes.values()) {
      const started = this.isStarted(entry);
      if (started && entry.slotState === "NONE") {
        entry.slotState = "READY";
        entry.slotGeneration += 1;
      } else if (!started && entry.slotState === "READY") {
        entry.slotState = "NONE";
        entry.slotGeneration += 1;
      }
    }
  }

  private async completeSlotClaim(claim: SlotClaim): Promise<void> {
    await this.allocationMutex.runExclusive(() => {
      const entry = claim.entry;
      if (entry.slotGeneration !== claim.generation) {
        return;
      }
      if (this.isStarted(entry)) {
        entry.slotState = "READY";
        entry.startingClaims = 0;
      } else if (entry.slotState === "STARTING" && claim.counted) {
        entry.startingClaims = Math.max(0, entry.startingClaims - 1);
        if (entry.startingClaims === 0) {
          entry.slotState = "NONE";
        }
      } else if (entry.slotState === "READY") {
        entry.slotState = "NONE";
      }
      this.notifyAllocationWaiters();
    });
  }

  private async reconcileEntrySlot(entry: RuntimeEntry): Promise<void> {
    await this.allocationMutex.runExclusive(() => {
      if (entry.slotState === "STARTING" || entry.slotState === "STOPPING") {
        return;
      }
      const next = this.isStarted(entry) ? "READY" : "NONE";
      if (entry.slotState !== next) {
        entry.slotState = next;
        entry.slotGeneration += 1;
        entry.startingClaims = 0;
        this.notifyAllocationWaiters();
      }
    });
  }

  private async stopReservedVictim(entry: RuntimeEntry, observedGeneration: number): Promise<void> {
    let failure: unknown;
    let reservedGeneration: number | undefined;
    try {
      await entry.gate.withControl(async () => {
        reservedGeneration = await this.allocationMutex.runExclusive(() => {
          if (entry.slotGeneration !== observedGeneration
            || entry.slotState !== "READY"
            || entry.refCount !== 0
            || this.runtimes.get(entry.context.repoRoot) !== entry) {
            return undefined;
          }
          entry.slotState = "STOPPING";
          entry.slotGeneration += 1;
          entry.startingClaims = 0;
          return entry.slotGeneration;
        });
        if (reservedGeneration !== undefined) {
          await this.stopEntryResources(entry);
        }
      }, this.options.requestTimeoutMs);
    } catch (error) {
      failure = error;
    }
    await this.allocationMutex.runExclusive(() => {
      if (reservedGeneration !== undefined
        && entry.slotGeneration === reservedGeneration
        && entry.slotState === "STOPPING") {
        entry.slotState = this.isStarted(entry) ? "READY" : "NONE";
        entry.startingClaims = 0;
      }
      this.notifyAllocationWaiters();
    });
    if (failure !== undefined) {
      throw failure;
    }
  }

  private async waitForAllocation(deadline: number, observedVersion: number): Promise<void> {
    if (this.allocationVersion !== observedVersion) {
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`No idle Java LSP runtime available; active limit is ${this.options.maxActiveRepos}.`);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.allocationWaiters.delete(onAvailable);
        error ? reject(error) : resolve();
      };
      const onAvailable = () => finish();
      const timer = setTimeout(() => finish(new Error(
        `No idle Java LSP runtime available; active limit is ${this.options.maxActiveRepos}.`
      )), remaining);
      this.allocationWaiters.add(onAvailable);
      if (this.allocationVersion !== observedVersion) {
        finish();
      }
    });
  }

  private notifyAllocationWaiters(): void {
    this.allocationVersion += 1;
    for (const resolve of this.allocationWaiters) {
      resolve();
    }
    this.allocationWaiters.clear();
  }

  private async signalAllocationChange(): Promise<void> {
    await this.allocationMutex.runExclusive(() => {
      this.notifyAllocationWaiters();
    });
  }

  private async evictEntry(entry: RuntimeEntry, observedActivityGeneration: number): Promise<boolean> {
    return entry.gate.withControl(async () => {
      const marked = await this.allocationMutex.runExclusive(() => {
        if (this.runtimes.get(entry.context.repoRoot) !== entry
          || entry.entryState !== "ACTIVE"
          || entry.activityGeneration !== observedActivityGeneration
          || entry.refCount !== 0
          || entry.slotState !== "NONE"
          || this.isStarted(entry)
          || entry.context.sourceIndex.isBusy()) {
          return false;
        }
        entry.entryState = "EVICTING";
        this.clearIdleTimer(entry);
        return true;
      });
      if (!marked) {
        return false;
      }

      try {
        await this.stopEntryResources(entry);
        entry.context.router.dispose();
        entry.context.sourceIndex.dispose();
      } catch (error) {
        await this.restoreFailedEviction(entry);
        throw error;
      }

      if (this.terminalShutdown && !this.terminalReleaseOwnership) {
        return false;
      }
      entry.ownership.release();

      return this.allocationMutex.runExclusive(() => {
        if (this.runtimes.get(entry.context.repoRoot) !== entry || entry.entryState !== "EVICTING") {
          return false;
        }
        this.runtimes.delete(entry.context.repoRoot);
        entry.entryState = "EVICTED";
        entry.evictionFailures = 0;
        entry.nextEvictionAttemptAt = 0;
        entry.slotGeneration += 1;
        this.notifyAllocationWaiters();
        return true;
      });
    }, this.options.requestTimeoutMs);
  }

  private async disposeAndReleaseEntry(entry: RuntimeEntry): Promise<void> {
    const marked = await this.allocationMutex.runExclusive(() => {
      if (this.runtimes.get(entry.context.repoRoot) !== entry) {
        return false;
      }
      entry.entryState = "EVICTING";
      this.clearIdleTimer(entry);
      return true;
    });
    if (!marked) {
      return;
    }
    entry.context.router.dispose();
    entry.context.sourceIndex.dispose();
    entry.ownership.release();
    await this.allocationMutex.runExclusive(() => {
      if (this.runtimes.get(entry.context.repoRoot) !== entry || entry.entryState !== "EVICTING") {
        return;
      }
      this.runtimes.delete(entry.context.repoRoot);
      entry.entryState = "EVICTED";
      entry.slotGeneration += 1;
      this.notifyAllocationWaiters();
    });
  }

  private async restoreFailedEviction(entry: RuntimeEntry): Promise<void> {
    await this.allocationMutex.runExclusive(() => {
      if (this.runtimes.get(entry.context.repoRoot) !== entry || entry.entryState !== "EVICTING") {
        return;
      }
      entry.evictionFailures += 1;
      const backoffMs = Math.min(
        60000,
        this.options.entryEvictionRetryBaseMs * (2 ** Math.min(10, entry.evictionFailures - 1))
      );
      entry.nextEvictionAttemptAt = Date.now() + backoffMs;
      entry.entryState = "ACTIVE";
      entry.slotState = this.isStarted(entry) ? "READY" : "NONE";
      entry.slotGeneration += 1;
      this.notifyAllocationWaiters();
    });
  }

  private scheduleRuntimeEntrySweep(): void {
    if (this.terminalShutdown) {
      return;
    }
    const now = Date.now();
    const excess = this.runtimes.size > this.options.maxRuntimeEntries;
    let dueAt: number | undefined;
    for (const entry of this.runtimes.values()) {
      if (entry.entryState !== "ACTIVE"
        || entry.refCount !== 0
        || entry.slotState !== "NONE"
        || this.isStarted(entry)
        || !entry.gate.isIdle()) {
        continue;
      }
      const candidateDueAt = entry.context.sourceIndex.isBusy()
        ? now + Math.min(1000, this.options.runtimeEntryTtlMs)
        : excess
          ? now
          : entry.lastUsedAt + this.options.runtimeEntryTtlMs;
      const entryDueAt = Math.max(candidateDueAt, entry.nextEvictionAttemptAt);
      dueAt = dueAt === undefined ? entryDueAt : Math.min(dueAt, entryDueAt);
    }
    if (dueAt === undefined) {
      return;
    }
    if (this.entrySweepTimer && this.entrySweepDueAt !== undefined && this.entrySweepDueAt <= dueAt) {
      return;
    }
    this.clearRuntimeEntrySweep();
    this.entrySweepDueAt = dueAt;
    this.entrySweepTimer = setTimeout(() => {
      this.entrySweepTimer = undefined;
      this.entrySweepDueAt = undefined;
      void this.evictInactiveEntries().catch(error => {
        console.error("[codex-java-lsp] runtime entry eviction failed", error);
        this.scheduleRuntimeEntrySweep();
      });
    }, Math.max(0, dueAt - now));
    this.entrySweepTimer.unref?.();
  }

  private clearRuntimeEntrySweep(): void {
    if (this.entrySweepTimer) {
      clearTimeout(this.entrySweepTimer);
      this.entrySweepTimer = undefined;
    }
    this.entrySweepDueAt = undefined;
  }

  private scheduleIdleShutdown(entry: RuntimeEntry): void {
    if (this.terminalShutdown || this.options.idleTtlMs <= 0) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      void entry.gate.withControl(async () => {
        if (this.runtimes.get(entry.context.repoRoot) === entry
          && entry.entryState === "ACTIVE"
          && entry.refCount === 0
          && this.isStarted(entry)) {
          await this.stopEntry(entry);
        }
      }, this.options.requestTimeoutMs).catch(error => {
        console.error("[codex-java-lsp] idle runtime stop failed", error);
      }).finally(() => {
        this.scheduleRuntimeEntrySweep();
      });
    }, this.options.idleTtlMs);
    entry.idleTimer.unref?.();
  }

  private clearIdleTimer(entry: RuntimeEntry): void {
    if (!entry.idleTimer) {
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private async stopEntry(entry: RuntimeEntry): Promise<void> {
    const generation = await this.allocationMutex.runExclusive(() => {
      if (entry.slotState === "NONE" && !this.isStarted(entry)) {
        return undefined;
      }
      entry.slotState = "STOPPING";
      entry.slotGeneration += 1;
      entry.startingClaims = 0;
      return entry.slotGeneration;
    });
    let failure: unknown;
    try {
      await this.stopEntryResources(entry);
    } catch (error) {
      failure = error;
    }
    await this.allocationMutex.runExclusive(() => {
      if (generation !== undefined
        && entry.slotGeneration === generation
        && entry.slotState === "STOPPING") {
        entry.slotState = this.isStarted(entry) ? "READY" : "NONE";
      }
      this.notifyAllocationWaiters();
    });
    if (failure !== undefined) {
      throw failure;
    }
  }

  private async stopEntryResources(entry: RuntimeEntry): Promise<void> {
    this.clearIdleTimer(entry);
    await entry.context.session.stop();
    entry.context.router.clearRgCache();
  }
}

function createRuntime(
  resolved: ResolvedRepo,
  transportMode: RepoOwnerTransport,
  ownership: RepoOwnershipLease
): ManagedToolContext {
  const session = new JdtlsSession(resolved.repoRoot, resolved.aliases, { transportMode, ownershipLifecycle: ownership });
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

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function settleBefore<T>(operation: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out ${label} after ${deadlineMs}ms.`)), deadlineMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const noOwnership: RepoOwnershipProvider = {
  acquire(repoRoot) {
    return {
      lockPath: "",
      metadata: {
        schemaVersion: 1,
        repoRoot,
        ownerToken: "none",
        pid: process.pid,
        processStartIdentity: "none",
        transport: "stdio",
        buildSha: "test-or-embedded",
        acquiredAt: new Date(0).toISOString()
      },
      release() {}
    };
  }
};

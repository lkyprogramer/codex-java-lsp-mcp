// input: Resolved repo roots.
// output: Per-repo runtime contexts.
// pos: Lazy runtime manager; one context per canonical repoRoot with small LRU/idle control.
import { AgentRouter } from "./agent-router/index.js";
import { JdtlsSession } from "./jdtls-session.js";
import { RepoResolver, type RepoSelector, type ResolvedRepo } from "./repo-resolver.js";
import { positiveInteger, resourceDefaults, type ResourceDefaults } from "./resource-defaults.js";
import { SourceIndex } from "./source-index.js";
import type { ToolContext } from "./tools/context.js";
import { touchRepoCache } from "./worktree-cache-cleanup.js";

export type ManagedToolContext = ToolContext & {
  repoHash: string;
  aliases: string[];
  layoutProfile: string;
  lsp: ResolvedRepo["lsp"];
};

type RuntimeEntry = {
  context: ManagedToolContext;
  refCount: number;
  lastUsedAt: number;
  idleTimer?: NodeJS.Timeout;
};

type RuntimeManagerOptions = {
  maxActiveRepos: number;
  idleTtlMs: number;
  requestTimeoutMs: number;
};

export class RepoRuntimeManager {
  private readonly runtimes = new Map<string, RuntimeEntry>();
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
        await this.reserveLspSlot(entry);
      }
      return await handler(entry.context);
    } finally {
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
      this.scheduleIdleShutdown(entry);
    }
  }

  activeRepos(): Array<{ repoRoot: string; repoHash: string; aliases: string[]; started: boolean; pid?: number; refCount: number; lastUsedAt: string }> {
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
        lastUsedAt: new Date(entry.lastUsedAt).toISOString()
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

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map(entry => this.stopEntry(entry)));
  }

  private getOrCreate(resolved: ResolvedRepo): RuntimeEntry {
    let entry = this.runtimes.get(resolved.repoRoot);
    touchRepoCache(resolved.repoRoot);
    if (!entry) {
      entry = {
        context: this.runtimeFactory(resolved),
        refCount: 0,
        lastUsedAt: Date.now()
      };
      this.runtimes.set(resolved.repoRoot, entry);
    } else {
      entry.context.aliases = resolved.aliases;
      entry.context.layoutProfile = resolved.layoutProfile;
      entry.context.lsp = resolved.lsp;
    }
    return entry;
  }

  private refreshResource(entry: RuntimeEntry): void {
    entry.context.resource = this.resourceStatus();
  }

  private async reserveLspSlot(current: RuntimeEntry): Promise<void> {
    const deadline = Date.now() + this.options.requestTimeoutMs;
    while (!this.hasLspSlot(current)) {
      const victim = this.idleStartedEntries(current).sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (victim) {
        await this.stopEntry(victim);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`No idle Java LSP runtime available; active limit is ${this.options.maxActiveRepos}.`);
      }
      await sleep(100);
    }
  }

  private hasLspSlot(current: RuntimeEntry): boolean {
    if (this.isStarted(current)) {
      return true;
    }
    return this.startedEntries().length < this.options.maxActiveRepos;
  }

  private startedEntries(): RuntimeEntry[] {
    return [...this.runtimes.values()].filter(entry => this.isStarted(entry));
  }

  private idleStartedEntries(exempt: RuntimeEntry): RuntimeEntry[] {
    return this.startedEntries().filter(entry => entry !== exempt && entry.refCount === 0);
  }

  private isStarted(entry: RuntimeEntry): boolean {
    return Boolean(entry.context.session.status().started);
  }

  private scheduleIdleShutdown(entry: RuntimeEntry): void {
    if (this.options.idleTtlMs <= 0) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (entry.refCount === 0 && this.isStarted(entry)) {
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
  }
}

function createRuntime(resolved: ResolvedRepo): ManagedToolContext {
  const session = new JdtlsSession(resolved.repoRoot, resolved.aliases);
  const sourceIndex = new SourceIndex(resolved.repoRoot);
  const router = new AgentRouter(resolved.repoRoot, session, sourceIndex);
  return {
    repoRoot: resolved.repoRoot,
    repoHash: resolved.repoHash,
    aliases: resolved.aliases,
    layoutProfile: resolved.layoutProfile,
    lsp: resolved.lsp,
    session,
    sourceIndex,
    router
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

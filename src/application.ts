// input: Process-level Java LSP dependencies and MCP tool requests.
// output: One shared application lifecycle across protocol server instances.
// pos: Transport-neutral owner of aliases, repo resolution, runtimes, drain, and shutdown.
import { AliasRegistry } from "./alias-registry.js";
import { RepoResolver, type RepoResolverOptions } from "./repo-resolver.js";
import { RepoRuntimeManager } from "./repo-runtime-manager.js";
import { RepoOwnershipManager, type RepoOwnershipProvider, type RepoOwnerTransport } from "./repo-ownership-lease.js";
import { canonicalPath, repoHash } from "./path-utils.js";
import {
  cleanupStaleWorktreeCaches,
  type WorktreeCacheCleanupOptions,
  type WorktreeCacheCleanupResult
} from "./worktree-cache-cleanup.js";
import { validateJdtlsTransportEnvironment } from "./jdtls-session.js";
import { warmupInstalledJdks } from "./project-jdk.js";
import { parsePrewarmHotSet } from "./resource-defaults.js";

export type JavaLspApplicationState = "created" | "ready" | "draining" | "closed";

export type JavaLspApplicationCloseOptions = {
  releaseOwnership?: boolean;
};

export type JavaLspApplicationOptions = {
  transportMode?: RepoOwnerTransport;
  registry?: AliasRegistry;
  resolver?: RepoResolver;
  runtimes?: RepoRuntimeManager;
  projectsConfigPath?: string;
  resolverOptions?: RepoResolverOptions;
  ownership?: RepoOwnershipProvider;
  cleanup?: (options: WorktreeCacheCleanupOptions) => WorktreeCacheCleanupResult;
  cacheJanitorIntervalMs?: number;
};

export class JavaLspApplication {
  readonly transportMode: RepoOwnerTransport;
  readonly registry: AliasRegistry;
  readonly resolver: RepoResolver;
  readonly runtimes: RepoRuntimeManager;

  private readonly cleanup: (options: WorktreeCacheCleanupOptions) => WorktreeCacheCleanupResult;
  private readonly cacheJanitorIntervalMs: number;
  private readonly createdAt = Date.now();
  private readonly idleWaiters = new Set<() => void>();
  private initializePromise?: Promise<WorktreeCacheCleanupResult>;
  private closePromise?: Promise<void>;
  private forceClosePromise?: Promise<void>;
  private prewarmPromise?: Promise<void>;
  private prewarmStopped = false;
  private activeRequests = 0;
  private currentState: JavaLspApplicationState = "created";
  private cacheJanitorTimer?: NodeJS.Timeout;

  constructor(options: JavaLspApplicationOptions = {}) {
    this.transportMode = options.transportMode ?? "stdio";
    this.registry = options.registry ?? new AliasRegistry(options.projectsConfigPath);
    this.resolver = options.resolver ?? new RepoResolver(this.registry, options.resolverOptions ?? {
      cwdFallback: this.transportMode === "streamable_http" ? "reject" : "allow"
    });
    this.runtimes = options.runtimes ?? new RepoRuntimeManager(
      this.resolver,
      { transportMode: this.transportMode },
      undefined,
      options.ownership ?? new RepoOwnershipManager({ transport: this.transportMode })
    );
    this.cleanup = options.cleanup ?? (cleanupOptions => cleanupStaleWorktreeCaches(cleanupOptions));
    this.cacheJanitorIntervalMs = normalizeCacheJanitorIntervalMs(
      options.cacheJanitorIntervalMs ?? cacheJanitorIntervalMs()
    );
  }

  state(): { state: JavaLspApplicationState; activeRequests: number; uptimeMs: number } {
    return {
      state: this.currentState,
      activeRequests: this.activeRequests,
      uptimeMs: Math.max(0, Date.now() - this.createdAt)
    };
  }

  initialize(): Promise<WorktreeCacheCleanupResult> {
    if (this.closePromise || this.forceClosePromise || this.currentState === "closed") {
      return Promise.reject(new Error("codex-java-lsp application is closed"));
    }
    if (!this.initializePromise) {
      this.initializePromise = Promise.resolve().then(async () => {
        validateJdtlsTransportEnvironment(this.transportMode);
        await this.runtimes.initialize?.();
        await this.registry.reloadIfChanged();
        const result = this.runCacheJanitor();
        this.currentState = "ready";
        this.startCacheJanitor();
        return result;
      });
    }
    return this.initializePromise;
  }

  /** HTTP daemon only. JDK cache first, then one pinned repo at a time, no JDT. */
  startPinnedRepoPrewarm(): Promise<void> {
    if (this.transportMode !== "streamable_http") return Promise.resolve();
    if (this.prewarmStopped || this.currentState !== "ready") return Promise.resolve();
    if (!this.prewarmPromise) {
      this.prewarmPromise = this.prewarmPinnedRepos();
    }
    return this.prewarmPromise;
  }

  async runRequest<T>(operation: () => Promise<T>): Promise<T> {
    if (this.currentState !== "ready") {
      throw new Error(this.currentState === "draining"
        ? "codex-java-lsp is draining"
        : `codex-java-lsp is not ready (${this.currentState})`);
    }
    this.activeRequests += 1;
    try {
      return await operation();
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      if (this.activeRequests === 0) {
        for (const resolve of this.idleWaiters) {
          resolve();
        }
        this.idleWaiters.clear();
      }
    }
  }

  async drain(deadlineMs: number): Promise<void> {
    if (this.currentState === "closed") {
      return;
    }
    this.currentState = "draining";
    this.prewarmStopped = true;
    this.stopCacheJanitor();
    if (this.activeRequests === 0) {
      return;
    }
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
      throw new Error(`Invalid drain deadline: ${deadlineMs}`);
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        error ? reject(error) : resolve();
      };
      const onIdle = () => finish();
      const timer = setTimeout(() => finish(new Error(`Timed out draining ${this.activeRequests} MCP request(s).`)), deadlineMs);
      this.idleWaiters.add(onIdle);
    });
  }

  async shutdown(deadlineMs: number): Promise<void> {
    let drainFailure: unknown;
    try {
      await this.drain(deadlineMs);
    } catch (error) {
      drainFailure = error;
    }

    let closeFailure: unknown;
    try {
      await this.close({ releaseOwnership: drainFailure === undefined });
    } catch (error) {
      closeFailure = error;
    }

    if (drainFailure !== undefined && closeFailure !== undefined) {
      throw new AggregateError([drainFailure, closeFailure], "Failed to drain and close codex-java-lsp safely.");
    }
    if (drainFailure !== undefined) {
      throw drainFailure;
    }
    if (closeFailure !== undefined) {
      throw closeFailure;
    }
  }

  close(options: JavaLspApplicationCloseOptions = {}): Promise<void> {
    if (this.forceClosePromise) {
      return this.forceClosePromise;
    }
    if (!this.closePromise) {
      this.currentState = "draining";
      this.prewarmStopped = true;
      this.stopCacheJanitor();
      const requestedOwnershipRelease = options.releaseOwnership ?? true;
      const activeAtClose = this.activeRequests;
      const releaseOwnership = requestedOwnershipRelease && activeAtClose === 0;
      this.closePromise = (async () => {
        try {
          await this.prewarmPromise?.catch(() => undefined);
          await this.runtimes.shutdownAll({ releaseOwnership, terminal: true });
          if (requestedOwnershipRelease && !releaseOwnership) {
            throw new Error(`Refusing to release repository ownership while ${activeAtClose} MCP request(s) are active.`);
          }
        } finally {
          this.currentState = "closed";
          for (const resolve of this.idleWaiters) {
            resolve();
          }
          this.idleWaiters.clear();
        }
      })();
    }
    return this.closePromise;
  }

  forceClose(deadlineMs = 1000): Promise<void> {
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
      return Promise.reject(new Error(`Invalid forced application shutdown deadline: ${deadlineMs}`));
    }
    if (!this.forceClosePromise) {
      this.currentState = "draining";
      this.prewarmStopped = true;
      this.stopCacheJanitor();
      this.forceClosePromise = (async () => {
        try {
          // A forced HTTP shutdown must not wait for a non-cooperative tool promise.
          // Keep ownership leases until process exit, but prove our JDT children are gone.
          await this.runtimes.forceTerminateOwnedJdtls(Math.floor(deadlineMs));
        } finally {
          this.currentState = "closed";
          for (const resolve of this.idleWaiters) {
            resolve();
          }
          this.idleWaiters.clear();
        }
      })();
    }
    return this.forceClosePromise;
  }

  private async prewarmPinnedRepos(): Promise<void> {
    try {
      await warmupInstalledJdks();
      if (this.prewarmStopped || this.currentState !== "ready") return;
      await this.registry.reloadIfChanged();
      const aliases = this.registry.aliases();
      const { hot, ignored } = parsePrewarmHotSet(aliases.map(alias => alias.id));
      for (const id of ignored) {
        console.error(`[codex-java-lsp] ignoring unknown JAVA_LSP_PREWARM_HOT alias ${id}`);
      }
      const seen = new Set<string>();
      for (const alias of aliases) {
        if (this.prewarmStopped || this.currentState !== "ready") return;
        if (!alias.lspEnabled) continue;
        const root = canonicalPath(alias.root);
        if (seen.has(root)) continue;
        seen.add(root);
        try {
          await this.runtimes.prewarmRepo({ projectId: alias.id }, { hydrate: hot.has(alias.id) });
        } catch (error) {
          console.error(`[codex-java-lsp] pinned repo prewarm failed (${alias.id})`, error);
        }
      }
    } catch (error) {
      console.error("[codex-java-lsp] pinned repo prewarm failed", error);
    }
  }

  private runCacheJanitor(): WorktreeCacheCleanupResult {
    try {
      const retained = this.retainedRepoRoots();
      return this.cleanup({
        protectedRepoRoots: this.pinRepoRoots(retained),
        protectedCacheDirNames: this.activeCacheDirNames(retained),
        transport: this.transportMode
      });
    } catch (error) {
      console.error("[codex-java-lsp] cache janitor failed", error);
      return { scanned: 0, removed: 0, skipped: 0, failures: 1, removedDirs: [], reclaimedFiles: 0 };
    }
  }

  private retainedRepoRoots(): Set<string> {
    const runtimes = this.runtimes as RepoRuntimeManager & { retainedRepoRoots?: () => Set<string> };
    return typeof runtimes.retainedRepoRoots === "function" ? runtimes.retainedRepoRoots() : new Set();
  }

  private pinRepoRoots(retained: ReadonlySet<string>): Set<string> {
    const pins = new Set<string>([...retained].map(root => canonicalPath(root)));
    for (const alias of this.registry.aliases()) {
      if (alias.lspEnabled) {
        pins.add(canonicalPath(alias.root));
      }
    }
    return pins;
  }

  private activeCacheDirNames(retained: ReadonlySet<string>): Set<string> {
    return new Set([...retained].map(root => repoHash(root)));
  }

  private startCacheJanitor(): void {
    if (this.cacheJanitorIntervalMs <= 0 || this.cacheJanitorTimer) {
      return;
    }
    this.cacheJanitorTimer = setInterval(() => {
      if (this.currentState === "ready") {
        void this.registry.reloadIfChanged().then(() => {
          if (this.currentState === "ready") {
            this.runCacheJanitor();
          }
        }).catch(() => undefined);
      }
    }, this.cacheJanitorIntervalMs);
    this.cacheJanitorTimer.unref?.();
  }

  private stopCacheJanitor(): void {
    if (!this.cacheJanitorTimer) {
      return;
    }
    clearInterval(this.cacheJanitorTimer);
    this.cacheJanitorTimer = undefined;
  }
}

function cacheJanitorIntervalMs(): number {
  const value = process.env.JAVA_LSP_CACHE_JANITOR_INTERVAL_MS;
  if (value === undefined) {
    return 6 * 60 * 60 * 1000;
  }
  return normalizeCacheJanitorIntervalMs(Number(value));
}

const DEFAULT_CACHE_JANITOR_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function normalizeCacheJanitorIntervalMs(value: number): number {
  return Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_DELAY_MS
    ? Math.floor(value)
    : DEFAULT_CACHE_JANITOR_INTERVAL_MS;
}

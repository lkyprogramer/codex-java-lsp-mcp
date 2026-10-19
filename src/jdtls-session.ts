// input: MCP tool requests that need Java semantic information.
// output: Managed Eclipse JDT LS requests and normalized raw LSP responses.
// pos: Stateful LSP client and process manager for the generic Java LSP MCP bridge.
import { createWriteStream, existsSync, rmSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  NoopCrossProcessLeaseStore,
  type CompositeJdtLease,
  type CrossProcessLeaseStore,
  type JdtLeaseAcquireResult
} from "./cross-process-lease.js";
import { JdtRestartBackoff, type JdtRestartBackoffStatus } from "./jdt-restart-backoff.js";
import {
  defaultJdtlsTransportFactory,
  type JdtlsChild,
  type JdtlsConnection,
  type JdtlsTransportAttempt,
  type JdtlsTransportFactory
} from "./jdtls-transport.js";
import { repoHash } from "./path-utils.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import { JavaIntelligenceError } from "./runtime/intelligence-error.js";
import type { GradleDomain } from "./mac-platform/gradle-domain.js";
import { DocumentLru } from "./document-lru.js";
import { detectGeneratedCode, type GeneratedCodeStatus } from "./generated-code.js";
import { detectBuildSystem, resolveProjectJdk, type BuildSystem, type ProjectJdkStatus } from "./project-jdk.js";
import { toFileUri } from "./repo-layout.js";
import type { RepoOwnershipLease, RepoOwnerTransport } from "./repo-ownership-lease.js";
import { processStartIdentityForPid } from "./repo-ownership-lease.js";
import { classifyWorkspaceCommand, killOwnedProcessTree, ownedPidStillAlive, processCommand } from "./jdt-process-tree.js";
import type { RepoChangeBatch } from "./repo-generation.js";
import { touchRepoCache } from "./worktree-cache-cleanup.js";
import type { WorktreeIdentity } from "./worktree-identity.js";
import {
  SemanticGateway,
  type SemanticGatewayStatus
} from "./semantic-gateway.js";
import {
  JdtFirstTouchRecorder,
  type JdtFirstTouchExecution,
  type JdtFirstTouchTraceHandle
} from "./jdtls-first-touch.js";
import {
  createJdtlsSemanticBackend,
  filterGeneratedCodeDiagnostics,
  lifecycleGateFromRestartBackoffStatus,
  buildInitializeParams,
  buildJavaSettings,
  pickJavaConfigurationSection
} from "./jdtls-semantic-backend.js";
import {
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  JdtlsLspClient,
  buildJdtlsEnv,
  classifyJdtStartError,
  findExecutable,
  forceTerminateJdtlsChild,
  isMissingFileError,
  jvmArgs,
  leaseAcquireResultToError,
  positiveInteger,
  resolveJdtlsRuntimePaths,
  childHasExited,
  splitArgs,
  delay,
  terminateChild,
  validateJdtlsTransportEnvironment,
  watchedFileChange,
  withTimeout,
  type SemanticGenerationClock
} from "./jdtls-lsp-io.js";
import type { LspDiagnostic } from "./jdtls-lsp-types.js";

export type { HierarchyEdge, HierarchyResult } from "./jdtls-hierarchy-walk.js";
export {
  createJdtlsSemanticBackend,
  filterGeneratedCodeDiagnostics,
  lifecycleGateFromRestartBackoffStatus,
  semanticLifecycleGateFor
} from "./jdtls-semantic-backend.js";
export type {
  JdtFirstTouchExecution,
  JdtFirstTouchOperationTrace,
  JdtFirstTouchSessionTrace,
  JdtFirstTouchTraceHandle,
  TelemetryObservation
} from "./jdtls-first-touch.js";
export type {
  DiagnosticFilterInput,
  LspDiagnostic,
  LspDocumentSymbol,
  LspLocation,
  LspLocationLink,
  LspPosition,
  LspRange,
  LspSymbol
} from "./jdtls-lsp-types.js";
export {
  classifyJdtStartError,
  forceTerminateJdtlsChild,
  resolveJdtlsRuntimePaths,
  validateJdtlsTransportEnvironment
} from "./jdtls-lsp-io.js";
export type { JdtlsRuntimePaths, SemanticGenerationClock } from "./jdtls-lsp-io.js";

export type JdtlsLifecycleState =
  | "NEW"
  | "STARTING"
  | "READY"
  | "BROKEN"
  | "STOPPED";

type LifecycleListener = (state: JdtlsLifecycleState) => void;

type JdtlsStatus = {
  repoRoot: string;
  dataDir: string;
  logFile: string;
  jdtlsBin: string;
  state: JdtlsLifecycleState;
  started: boolean;
  pid?: number;
  startingPid?: number;
  restartBackoff: JdtRestartBackoffStatus;
  knownDiagnostics: number;
  openDocuments: number;
  startedAt?: string;
  cache: JdtlsCacheStatus;
  /** Task 33 Step 9. Aggregate counters only - no per-query file path, matching the plan's diagnostic-output constraint. */
  semanticGateway: SemanticGatewayStatus;
  buildSystem: BuildSystem;
  projectJdk: ProjectJdkStatus;
  generatedCode: GeneratedCodeStatus;
  progress: JdtlsProgressStatus;
  leaseHeartbeat: {
    active: boolean;
    intervalMs: number;
    lastSuccessAt?: string;
    lastError?: string;
  };
};

export type JdtlsCacheStatus = {
  enabled: boolean;
  entries: number;
  hits: number;
  misses: number;
  invalidations: number;
  lastInvalidatedAt?: string;
};

export type JdtlsProgressStatus = {
  importState?: "NOT_STARTED" | "IMPORTING" | "READY" | "FAILED";
  active: number;
  activeMessages: string[];
  lastProgressAt?: string;
  lastLanguageStatus?: string;
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  dependencies: Set<string>;
};

const DEFAULT_CACHE_TTL_MS = positiveInteger(process.env.JDTLS_CACHE_TTL_MS, 300000);

export type JdtlsSessionOptions = {
  gradleDomain?: Pick<GradleDomain, "home" | "assertSemanticAdmission"> & Partial<Pick<GradleDomain, "gradleImport">>;
  transportMode?: RepoOwnerTransport;
  ownershipLifecycle?: Pick<RepoOwnershipLease, "markJdtlsStarting" | "markJdtlsRunning" | "clearJdtlsState">;
  transportFactory?: JdtlsTransportFactory;
  now?: () => number;
  leaseStore?: CrossProcessLeaseStore;
  worktree?: WorktreeIdentity;
  /**
   * Coordinator GenerationClock. When bound, gateway keys read its snapshot
   * instead of the session-local fallback counter.
   */
  generationClock?: SemanticGenerationClock;
};

function isJdtlsSessionOptions(value: JdtlsTransportFactory | JdtlsSessionOptions): value is JdtlsSessionOptions {
  return typeof value === "object" && value !== null && typeof (value as JdtlsTransportFactory).spawn !== "function";
}

export class JdtlsSession extends JdtlsLspClient {
  private process?: JdtlsChild;
  private lifecycleState: JdtlsLifecycleState = "NEW";
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private startAttempt?: JdtlsTransportAttempt;
  /** Every spawned child stays here until its exit is observed. Dropping this set is what leaked JVMs. */
  private readonly liveAttempts = new Set<JdtlsTransportAttempt>();
  private readonly childIdentity = new WeakMap<JdtlsChild, string>();
  private pendingLeaseRelease?: Promise<void>;

  private readonly lifecycleListeners = new Set<LifecycleListener>();
  private readonly restartBackoff: JdtRestartBackoff;
  private readyStableTimer?: NodeJS.Timeout;
  private readonly readyStabilityMs = positiveInteger(
    process.env.JDTLS_READY_STABILITY_MS,
    30_000
  );
  private readonly startHardCapMs = positiveInteger(
    process.env.JDTLS_START_TIMEOUT_MS,
    120_000
  );
  private startedAt?: Date;
  private readonly transportFactory: JdtlsTransportFactory;
  private readonly leaseStore: CrossProcessLeaseStore;
  private readonly dataDir: string;
  private readonly logDir: string;
  private readonly logFile: string;
  private readonly jdtlsBin: string;
  private readonly buildSystem: BuildSystem;
  private readonly projectJdk: ProjectJdkStatus;
  private readonly generatedCode: GeneratedCodeStatus;
  private readonly jdtlsRuntimeJavaHome?: string;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheInvalidations = 0;
  private lastCacheInvalidatedAt?: Date;
  private lastLanguageStatus?: string;
  private importState: NonNullable<JdtlsProgressStatus["importState"]> = "NOT_STARTED";
  private importWait?: {
    connection: JdtlsConnection;
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
    error?: JavaIntelligenceError;
  };
  private pendingLease?: CompositeJdtLease;
  private leaseHeartbeatTimer?: NodeJS.Timeout;
  private leaseHeartbeatPromise?: Promise<void>;
  private leaseHeartbeatError?: JavaIntelligenceError;
  private lastLeaseHeartbeatAt?: Date;
  private readonly leaseHeartbeatMs = positiveInteger(
    process.env.JAVA_LSP_JDT_LEASE_HEARTBEAT_MS,
    30_000
  );
  private readonly firstTouchTraces = new Set<JdtFirstTouchRecorder>();
  private ownershipLifecycle?: JdtlsSessionOptions["ownershipLifecycle"];
  private ownershipJdtlsMarked = false;
  private terminallyStopped = false;
  private readonly gradleDomain?: JdtlsSessionOptions["gradleDomain"];

  constructor(
    repoRoot: string,
    aliases: string[] = [],
    factoryOrOptions: JdtlsTransportFactory | JdtlsSessionOptions = defaultJdtlsTransportFactory,
    now: () => number = Date.now,
    leaseStore: CrossProcessLeaseStore = new NoopCrossProcessLeaseStore(),
    worktree?: WorktreeIdentity
  ) {
    super(repoRoot);
    const options = isJdtlsSessionOptions(factoryOrOptions) ? factoryOrOptions : {};
    this.gradleDomain = options.gradleDomain;
    this.transportFactory = isJdtlsSessionOptions(factoryOrOptions)
      ? (options.transportFactory ?? defaultJdtlsTransportFactory)
      : factoryOrOptions;
    now = options.now ?? now;
    this.leaseStore = options.leaseStore ?? leaseStore;
    this.ownershipLifecycle = options.ownershipLifecycle;
    this.generationClock = options.generationClock;
    worktree = options.worktree ?? worktree;
    this.worktree = worktree ?? { repoRoot, repoHash: repoHash(repoRoot), isLinkedWorktree: false };
    validateJdtlsTransportEnvironment(options.transportMode ?? "stdio");
    const paths = resolveJdtlsRuntimePaths(repoRoot, options.transportMode ?? "stdio");
    this.dataDir = paths.dataDir;
    this.logDir = paths.logDir;
    this.logFile = path.join(this.logDir, "jdtls.log");
    this.restartBackoff = new JdtRestartBackoff(now);
    this.documents = new DocumentLru({
      maxOpen: positiveInteger(process.env.JDTLS_MAX_OPEN_DOCUMENTS, 64),
      notify: (method, params) => {
        this.activeFirstTouchTrace?.recordDocumentNotification(method);
        this.connection?.sendNotification(method, params);
      }
    });
    this.semanticGateway = new SemanticGateway(createJdtlsSemanticBackend(this), {
      now,
      ttlMs: DEFAULT_CACHE_TTL_MS,
      absoluteCapMs: DEFAULT_LSP_REQUEST_TIMEOUT_MS,
      lifecycleGate: () => lifecycleGateFromRestartBackoffStatus(this.restartBackoff.status())
    });
    this.jdtlsBin = process.env.JDTLS_BIN || findExecutable("jdtls");
    this.buildSystem = detectBuildSystem(repoRoot);
    this.projectJdk = resolveProjectJdk(repoRoot, aliases);
    this.generatedCode = detectGeneratedCode(repoRoot);
    this.jdtlsRuntimeJavaHome = process.env.JDTLS_JAVA_HOME || process.env.JAVA_HOME;
  }

  bindOwnershipLifecycle(ownership?: RepoOwnershipLease): void {
    this.ownershipLifecycle = ownership;
  }

  bindGenerationClock(clock?: SemanticGenerationClock): void {
    this.generationClock = clock;
    if (clock) this.cacheGeneration = clock.snapshot().value;
  }

  status(): JdtlsStatus {
    // READY is the only state that may report `started`. A spawned-but-not-yet
    // initialized child is STARTING, and callers must not route semantics to it.
    const state = this.lifecycleState;
    const started = state === "READY";
    return {
      repoRoot: this.repoRoot,
      dataDir: this.dataDir,
      logFile: this.logFile,
      jdtlsBin: this.jdtlsBin,
      state,
      started,
      pid: started ? this.process?.pid : undefined,
      startingPid: state === "STARTING" ? this.startAttempt?.child.pid : undefined,
      restartBackoff: this.restartBackoff.status(),
      knownDiagnostics: [...this.diagnostics.values()].reduce((sum, value) => sum + value.length, 0),
      openDocuments: this.documents.status().open,
      startedAt: this.startedAt?.toISOString(),
      cache: this.cacheStatus(),
      semanticGateway: this.semanticGateway.status(),
      buildSystem: this.buildSystem,
      projectJdk: this.projectJdk,
      generatedCode: this.generatedCode,
      progress: this.progressStatus(),
      leaseHeartbeat: {
        active: this.pendingLease !== undefined,
        intervalMs: this.leaseHeartbeatMs,
        lastSuccessAt: this.lastLeaseHeartbeatAt?.toISOString(),
        lastError: this.leaseHeartbeatError?.message
      }
    };
  }

  onLifecycleChange(listener: LifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  /**
   * Benchmark-only, single-attempt trace. Production requests never call this,
   * so the normal path pays only nullable branch checks at the phase boundaries.
   * The handle remains readable after endAttempt() so a late backend settlement
   * can be attributed to the attempt that created it until close().
   */
  beginFirstTouchTrace(): JdtFirstTouchTraceHandle {
    if (this.activeFirstTouchTrace) {
      throw new Error("a JDT first-touch trace is already active for this session");
    }
    const execution: JdtFirstTouchExecution = this.lifecycleState === "READY"
      ? "reused-ready-session"
      : this.lifecycleState === "STARTING"
        ? "joined-existing-start"
        : "new-process";
    const recorder = new JdtFirstTouchRecorder(execution);
    recorder.recordPid(this.process?.pid ?? this.startAttempt?.child.pid);
    this.activeFirstTouchTrace = recorder;
    this.firstTouchTraces.add(recorder);
    let ended = false;
    let closed = false;
    const endAttempt = (): void => {
      if (ended) return;
      ended = true;
      if (this.activeFirstTouchTrace === recorder) this.activeFirstTouchTrace = undefined;
    };
    return {
      endAttempt,
      snapshot: () => recorder.snapshot(),
      close: () => {
        if (closed) return recorder.snapshot();
        endAttempt();
        closed = true;
        this.firstTouchTraces.delete(recorder);
        return recorder.snapshot();
      }
    };
  }

  /** Semantic admission (contract §2.1): JDT_NOT_READY with the domain state until the private Gradle domain is READY. */
  assertSemanticAdmission(): void {
    this.gradleDomain?.assertSemanticAdmission();
  }

  /**
   * Kill every child this session no longer owns. A READY or STARTING child is
   * kept. A BROKEN session has no owned child: anything still in `liveAttempts`
   * is the leak and is killed here.
   */
  hasLiveChildren(): boolean {
    return this.liveAttempts.size > 0;
  }

  async reapAbandonedChildren(): Promise<void> {
    await this.reapChildren("abandoned");
    if (this.lifecycleState !== "STARTING" && this.lifecycleState !== "READY") {
      await this.releasePendingLease();
    }
  }

  async ensureStarted(
    callerBudget = DeadlineBudget.fromTimeout(DEFAULT_LSP_REQUEST_TIMEOUT_MS)
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      this.gradleDomain?.assertSemanticAdmission();
      if (this.stopPromise) {
        await callerBudget.race("jdtls.stop.wait", this.stopPromise);
      }
      if (this.lifecycleState === "READY") {
        await callerBudget.race("jdtls.lease.heartbeat", this.heartbeatPendingLease());
        return;
      }
      const gate = this.restartBackoff.check();
      if (!gate.allowed) {
        throw new JavaIntelligenceError(
          gate.blockedUntilExplicitReset ? "JDT_CONFIG_ERROR" : "JDT_BACKOFF",
          gate.blockedUntilExplicitReset
            ? "JDT start is blocked until configuration changes or java_runtime(action=restart)"
            : `JDT restart is backing off for ${gate.retryAfterMs}ms`
        );
      }
      let sharedStart = this.startPromise;
      if (!sharedStart) {
        // Claim the singleflight synchronously (this.startPromise is assigned
        // before any await below), so a second concurrent ensureStarted() call
        // sees `sharedStart` already set instead of racing its own lease
        // acquisition and spawn. The lease check itself happens inside
        // startAfterLease, gating the spawn but not this synchronous claim.
        this.transition("STARTING");
        const created: Promise<void> = this.startAfterLease(callerBudget)
          .catch(async (error: unknown) => {
            const classified = classifyJdtStartError(error);
            if (this.lifecycleState !== "STOPPED") this.transition("BROKEN");
            // Cross-process contention (IGNORED_CODES) never pollutes the
            // backoff counter; a genuine JDT start failure still does.
            this.restartBackoff.recordFailure(classified.code);
            await this.releasePendingLease();
            throw classified;
          })
          .finally(() => {
            if (this.startPromise === created) this.startPromise = undefined;
          });
        this.startPromise = created;
        sharedStart = created;
      }
      await callerBudget.race("jdtls.start.wait", sharedStart);
    } finally {
      this.addPhaseMetric("ensureStart", Date.now() - startedAt);
    }
  }

  private transition(next: JdtlsLifecycleState, notify = false): void {
    if (this.lifecycleState === next && !notify) return;
    this.lifecycleState = next;
    for (const listener of this.lifecycleListeners) listener(next);
  }

  private async startAfterLease(callerBudget: DeadlineBudget): Promise<void> {
    await this.pendingLeaseRelease;
    if (!this.pendingLease) {
      const leaseResult = await this.acquireCrossProcessLease(callerBudget);
      if (leaseResult.kind !== "ACQUIRED") {
        throw leaseAcquireResultToError(leaseResult);
      }
      this.pendingLease = leaseResult.lease;
      this.startLeaseHeartbeat(leaseResult.lease);
    } else {
      // A failed start retains both leases while its child survives. Reuse
      // them so retry cannot wait for the worktree lease held by this session.
      await this.heartbeatPendingLease();
    }
    // The start owns its own hard cap. A caller deadline only stops that
    // caller from waiting; it must never kill work shared with another caller.
    const startBudget = DeadlineBudget.fromTimeout(this.startHardCapMs);
    await this.startTransactional(startBudget);
  }

  /** A lease-store failure (corrupt shared config, lock timeout) is reported the same as a lease being unavailable. */
  private async acquireCrossProcessLease(budget: DeadlineBudget): Promise<JdtLeaseAcquireResult> {
    try {
      return await this.leaseStore.acquireJdt(this.worktree, budget);
    } catch (error) {
      throw new JavaIntelligenceError(
        "LEASE_CONFIG_ERROR",
        error instanceof Error ? error.message : String(error),
        error
      );
    }
  }

  private async releasePendingLease(): Promise<void> {
    if (this.hasLiveChildren()) return;
    if (this.pendingLeaseRelease) return this.pendingLeaseRelease;
    const lease = this.pendingLease;
    this.pendingLease = undefined;
    this.stopLeaseHeartbeat();
    const operation = (async () => {
      const heartbeat = this.leaseHeartbeatPromise;
      if (heartbeat) await heartbeat.catch(() => undefined);
      this.leaseHeartbeatError = undefined;
      if (lease) await lease.release();
    })();
    this.pendingLeaseRelease = operation;
    try {
      await operation;
    } finally {
      if (this.pendingLeaseRelease === operation) this.pendingLeaseRelease = undefined;
    }
  }

  private startLeaseHeartbeat(lease: CompositeJdtLease): void {
    this.stopLeaseHeartbeat();
    const schedule = (): void => {
      if (this.pendingLease !== lease) return;
      const timer = setTimeout(() => {
        if (this.leaseHeartbeatTimer === timer) this.leaseHeartbeatTimer = undefined;
        void this.heartbeatPendingLease()
          .catch(() => undefined)
          .finally(schedule);
      }, this.leaseHeartbeatMs);
      timer.unref();
      this.leaseHeartbeatTimer = timer;
    };
    schedule();
  }

  private stopLeaseHeartbeat(): void {
    if (!this.leaseHeartbeatTimer) return;
    clearTimeout(this.leaseHeartbeatTimer);
    this.leaseHeartbeatTimer = undefined;
  }

  private heartbeatPendingLease(): Promise<void> {
    const lease = this.pendingLease;
    if (!lease) return Promise.resolve();
    if (this.leaseHeartbeatPromise) return this.leaseHeartbeatPromise;
    const operation = lease.heartbeat()
      .then(() => {
        if (this.pendingLease === lease) {
          this.lastLeaseHeartbeatAt = new Date();
          this.leaseHeartbeatError = undefined;
        }
      })
      .catch((error: unknown) => {
        const classified = error instanceof JavaIntelligenceError
          ? error
          : new JavaIntelligenceError(
              "LEASE_CONFIG_ERROR",
              error instanceof Error ? error.message : String(error),
              error
            );
        if (this.pendingLease === lease) this.leaseHeartbeatError = classified;
        throw classified;
      })
      .finally(() => {
        if (this.leaseHeartbeatPromise === operation) this.leaseHeartbeatPromise = undefined;
      });
    this.leaseHeartbeatPromise = operation;
    return operation;
  }

  /**
   * Applies a coordinator change batch to the JDT completed-request cache.
   * Changed/deleted files evict their dependent entries; a build change clears
   * everything because classpath/import semantics may have shifted.
   */
  private invalidateForRepoChanges(batch: RepoChangeBatch): void {
    // A storm is handled the same as a build change: filtering/invalidating
    // per-path for hundreds of entries is strictly more work than one clear,
    // for no precision benefit once that many files moved at once.
    if (batch.storm || batch.changes.some(change => change.kind === "BUILD_CHANGE")) {
      this.clearCache(batch);
      return;
    }
    const files = batch.changes
      .filter(change => change.kind.startsWith("JAVA_"))
      .map(change => change.absolutePath);
    if (files.length > 0) {
      this.invalidateCacheFor(files);
      this.invalidateSemanticGateway(batch);
    }
  }

  /**
   * Sole JDT-session consumer of RepoChangeCoordinator output. Cache
   * invalidation always happens; LSP notifications are emitted only while a
   * connection is live, and disk refreshes never synthesize didOpen.
   */
  async applyRepoChangeBatch(batch: RepoChangeBatch): Promise<void> {
    this.invalidateForRepoChanges(batch);
    const connection = this.connection;
    if (!connection) return;
    const watchedChanges = batch.changes
      .map(change => watchedFileChange(change))
      .filter((change): change is { uri: string; type: number } => change !== undefined);
    if (watchedChanges.length > 0) {
      connection.sendNotification("workspace/didChangeWatchedFiles", { changes: watchedChanges });
    }
    for (const change of batch.changes) {
      if (change.kind === "JAVA_DELETE") {
        this.documents.delete(change.absolutePath);
        this.diagnostics.delete(toFileUri(change.absolutePath));
        continue;
      }
      if (
        (change.kind !== "JAVA_ADD" && change.kind !== "JAVA_CHANGE")
        || !this.documents.has(change.absolutePath)
      ) {
        continue;
      }
      try {
        const text = await readFile(change.absolutePath, "utf8");
        await this.documents.updateIfOpen(change.absolutePath, text);
      } catch (error) {
        if (isMissingFileError(error)) continue;
        throw error;
      }
    }
  }

  drainPhaseMetrics(): Record<string, number> {
    const metrics = this.phaseMetrics;
    this.phaseMetrics = {};
    return metrics;
  }

  async restart(clearCache: boolean): Promise<JdtlsStatus> {
    await this.stop();
    if (clearCache && existsSync(this.dataDir)) {
      rmSync(this.dataDir, { force: true, recursive: true });
    }
    // An explicit restart is the operator saying "I changed something"; it is the
    // only thing that clears a configuration block.
    this.restartBackoff.reset();
    await this.ensureStarted();
    return this.status();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const operation: Promise<void> = this.stopInternal().finally(() => {
      for (const trace of this.firstTouchTraces) trace.markSessionStopped();
      if (this.stopPromise === operation) this.stopPromise = undefined;
    });
    this.stopPromise = operation;
    return operation;
  }

  private async stopInternal(): Promise<void> {
    // Transition first so an in-flight startTransactional sees STOPPED and
    // classifies its own failure as CANCELLED rather than a JDT fault.
    this.transition("STOPPED");
    this.importWait?.reject(new JavaIntelligenceError("CANCELLED", "JDT project import was stopped"));
    this.importWait = undefined;
    this.importState = "NOT_STARTED";
    this.clearCache();
    if (this.readyStableTimer) {
      clearTimeout(this.readyStableTimer);
      this.readyStableTimer = undefined;
    }

    const startAttempt = this.startAttempt;
    const startPromise = this.startPromise;
    const connection = this.connection;
    const child = this.process;

    if (connection && connection !== startAttempt?.connection) {
      try {
        await withTimeout(connection.sendRequest("shutdown"), 3000, "shutdown");
        connection.sendNotification("exit");
      } catch {
        // Best-effort shutdown; the process is terminated below if it remains alive.
      }
    }
    if (startAttempt) {
      await this.finishChild(startAttempt);
    }
    const readyAttempt = [...this.liveAttempts].find(item => item.child === child);
    if (readyAttempt) {
      await this.finishChild(readyAttempt);
    } else if (child && !childHasExited(child)) {
      await terminateChild(child, 200);
    }
    for (const attempt of [...this.liveAttempts]) {
      await this.finishChild(attempt);
    }
    if (startPromise) {
      // Let startup waiters settle before stop() resolves, so a later
      // ensureStarted() never races a half-torn-down attempt.
      await startPromise.catch(() => undefined);
    }
    if (this.liveAttempts.size > 0) {
      throw new Error("JDT LS child is still alive after SIGKILL");
    }
    this.startAttempt = undefined;
    this.startPromise = undefined;
    this.connection = undefined;
    this.process = undefined;
    this.startedAt = undefined;
    // A start failure already releases via ensureStarted()'s own catch (awaited
    // above through startPromise); this is a no-op in that case and the only
    // release path when stop() is called on an already-READY session.
    await this.releasePendingLease();
    touchRepoCache(this.repoRoot, { jdtlsPid: undefined });
    this.clearOwnershipJdtlsState();
    this.documents.closeAll();
    this.diagnostics.clear();
    this.transition("STOPPED", true);
  }

  async forceStop(deadlineMs = 1000): Promise<void> {
    this.terminallyStopped = true;
    let failure: unknown;
    try {
      if (this.process) {
        await forceTerminateJdtlsChild(this.process, deadlineMs);
      }
    } catch (error) {
      failure = error;
    }
    await this.stop();
    if (failure && this.liveAttempts.size > 0) throw failure;
  }

  private clearOwnershipJdtlsState(): void {
    if (!this.ownershipJdtlsMarked) {
      return;
    }
    try {
      this.ownershipLifecycle?.clearJdtlsState?.();
    } catch (error) {
      console.error("[codex-java-lsp] failed to clear JDT LS ownership lifecycle state", error);
    } finally {
      this.ownershipJdtlsMarked = false;
    }
  }

  cacheStatus(): JdtlsCacheStatus {
    this.evictExpiredCacheEntries();
    return {
      enabled: DEFAULT_CACHE_TTL_MS > 0,
      entries: this.cache.size,
      hits: this.cacheHits,
      misses: this.cacheMisses,
      invalidations: this.cacheInvalidations,
      lastInvalidatedAt: this.lastCacheInvalidatedAt?.toISOString()
    };
  }

  private async startTransactional(budget: DeadlineBudget): Promise<void> {
    if (!this.jdtlsBin) {
      throw new JavaIntelligenceError(
        "JDT_CONFIG_ERROR",
        "jdtls executable was not found. Install with `brew install jdtls` or set JDTLS_BIN."
      );
    }
    if (this.projectJdk.status === "ambiguous" || this.projectJdk.status === "missing") {
      throw new JavaIntelligenceError(
        "JDT_CONFIG_ERROR",
        `Project JDK is ${this.projectJdk.status}: ${this.projectJdk.notes.join(" ")}`
      );
    }

    const filesystemStartedAt = performance.now();
    try {
      await mkdir(this.dataDir, { recursive: true });
      await mkdir(this.logDir, { recursive: true });
    } finally {
      this.activeFirstTouchTrace?.recordStartupPhase("filesystemSetupMs", performance.now() - filesystemStartedAt);
    }
    budget.throwIfExpired("jdtls.spawn");
    await this.reapChildren("all");
    if (this.liveAttempts.size > 0) {
      throw new JavaIntelligenceError(
        "JDT_BROKEN",
        "JDT LS child is still alive; refusing to spawn another"
      );
    }

    const spawnStartedAt = performance.now();
    let attempt: JdtlsTransportAttempt;
    try {
      this.gradleDomain?.assertSemanticAdmission();
      attempt = this.transportFactory.spawn({
        binary: this.jdtlsBin,
        args: this.launchArgs(),
        cwd: this.repoRoot,
        env: buildJdtlsEnv(this.jdtlsRuntimeJavaHome, this.gradleDomain?.home)
      });
    } finally {
      this.activeFirstTouchTrace?.recordStartupPhase("processSpawnCallMs", performance.now() - spawnStartedAt);
    }
    this.activeFirstTouchTrace?.recordPid(attempt.child.pid);
    this.startAttempt = attempt;
    await this.trackSpawnedChild(attempt);
    if (this.ownershipLifecycle?.markJdtlsStarting) {
      this.ownershipLifecycle.markJdtlsStarting();
      this.ownershipJdtlsMarked = true;
    }
    if (attempt.child.pid !== undefined) {
      const identity = processStartIdentityForPid(attempt.child.pid);
      if (identity) {
        this.ownershipLifecycle?.markJdtlsRunning?.(attempt.child.pid, identity);
      }
    }
    let resolveImport!: () => void;
    let rejectImport!: (error: unknown) => void;
    const importPromise = new Promise<void>((resolve, reject) => {
      resolveImport = resolve;
      rejectImport = reject;
    });
    // Notifications can arrive before initialize has returned and before the
    // startup transaction begins waiting. Keep early rejection handled.
    void importPromise.catch(() => undefined);
    const importWait = { connection: attempt.connection, promise: importPromise, resolve: resolveImport, reject: rejectImport, error: undefined as JavaIntelligenceError | undefined };
    this.importWait = importWait;
    this.importState = "IMPORTING";
    this.lastLanguageStatus = undefined;
    this.registerClientHandlers(attempt.connection);
    attempt.connection.listen();
    this.attachAttemptLogging(attempt);

    try {
      if (this.pendingLease && attempt.child.pid !== undefined) {
        const recorded = await this.pendingLease.recordJdtlsPid(attempt.child.pid);
        if (!recorded) {
          throw new JavaIntelligenceError(
            "LEASE_CONFIG_ERROR",
            "the cross-process JDT lease was lost before initialize could commit"
          );
        }
      }
      const initializeStartedAt = performance.now();
      let initializeResult: unknown;
      try {
        initializeResult = await budget.race(
          "jdtls.initialize",
          attempt.connection.sendRequest("initialize", this.initializeParams()),
          this.startHardCapMs,
          () => { void terminateChild(attempt.child, 200); }
        );
      } finally {
        this.activeFirstTouchTrace?.recordStartupPhase("initializeRoundTripMs", performance.now() - initializeStartedAt);
      }
      if (!initializeResult) {
        throw new JavaIntelligenceError(
          "JDT_SERVER_ERROR",
          "JDT LS initialization returned an empty result"
        );
      }
      if (this.lifecycleState !== "STARTING" || this.startAttempt !== attempt) {
        throw new JavaIntelligenceError(
          "CANCELLED",
          "JDT LS startup was superseded or stopped before commit"
        );
      }
      await this.heartbeatPendingLease();
      const configurationStartedAt = performance.now();
      try {
        attempt.connection.sendNotification("initialized", {});
        attempt.connection.sendNotification("workspace/didChangeConfiguration", {
          settings: this.javaSettings()
        });
      } finally {
        this.activeFirstTouchTrace?.recordStartupPhase(
          "configurationNotifySendMs",
          performance.now() - configurationStartedAt
        );
      }

      // initialize only establishes the protocol. ServiceReady is sent after
      // the initial import job; it does not promise all build/index work succeeded.
      await budget.race("jdtls.project.import", importWait.promise);
      await budget.race("jdtls.lease.heartbeat", this.heartbeatPendingLease());
      if (importWait.error) throw importWait.error;
      if (this.lifecycleState !== "STARTING" || this.startAttempt !== attempt) {
        throw new JavaIntelligenceError("CANCELLED", "JDT project import was stopped or superseded");
      }
      this.importState = "READY";
      this.importWait = undefined;
      this.process = attempt.child;
      this.connection = attempt.connection;
      this.startedAt = new Date();
      this.startAttempt = undefined;
      this.restartBackoff.recordReadyStarted();
      this.transition("READY");
      // Refresh the pid recorded at spawn. Identity is written only after the
      // command line matches this workspace. Omitting the field would let
      // touchRepoCache fill it from `ps` with no command check.
      if (attempt.child.pid !== undefined) {
        const recordedIdentity = await this.rememberOwnedIdentity(attempt.child, attempt.child.pid);
        touchRepoCache(this.repoRoot, {
          jdtlsPid: attempt.child.pid,
          jdtlsProcessStartIdentity: recordedIdentity ?? null
        });
      }
      this.armReadyStabilityReset(attempt);
    } catch (error) {
      const stoppedOrSuperseded =
        this.lifecycleState === "STOPPED"
        || (this.startAttempt !== attempt
          && (this.lifecycleState === "STARTING" || this.lifecycleState === "READY"));
      if (this.importWait === importWait) {
        this.importWait = undefined;
        this.importState = this.lifecycleState === "STOPPED" ? "NOT_STARTED" : "FAILED";
      }
      // Pointers are cleared only after the OS process is gone. A child that
      // survives SIGKILL stays in liveAttempts and blocks the next spawn.
      await this.finishChild(attempt);
      if (stoppedOrSuperseded) {
        throw new JavaIntelligenceError(
          "CANCELLED",
          "JDT LS startup was stopped or superseded",
          error
        );
      }
      throw error;
    }
  }

  private launchArgs(): string[] {
    return [
      ...jvmArgs(this.generatedCode),
      "-data",
      this.dataDir,
      "-configuration",
      path.join(this.dataDir, "configuration"),
      ...splitArgs(process.env.JDTLS_EXTRA_ARGS),
      ...(process.env.JAVA_LSP_ISOLATED_VALIDATION === "1" && process.env.HOME
        ? [`--jvm-arg=-Duser.home=${process.env.HOME}`]
        : [])
    ];
  }

  private attachAttemptLogging(attempt: JdtlsTransportAttempt): void {
    const logStream = createWriteStream(this.logFile, { flags: "a" });
    attempt.child.stderr.on("data", (chunk: Buffer) => {
      logStream.write(chunk);
    });
    attempt.child.once("exit", (code, signal) => {
      logStream.write(`\n[jdtls exited] code=${code ?? ""} signal=${signal ?? ""}\n`);
      logStream.end();
      this.liveAttempts.delete(attempt);
      if (this.liveAttempts.size === 0) {
        touchRepoCache(this.repoRoot, { jdtlsPid: undefined });
      }
      // Identity guards: a stopped or superseded child's exit must never
      // overwrite the state of the session that replaced it.
      const ownsReadyProcess = this.process === attempt.child;
      const ownsStartingAttempt = this.startAttempt === attempt;
      if (!ownsReadyProcess && !ownsStartingAttempt) {
        if (!this.hasLiveChildren() && this.lifecycleState !== "STARTING" && this.lifecycleState !== "READY") {
          void this.releasePendingLease();
          this.transition(this.lifecycleState, true);
        }
        return;
      }
      if (ownsStartingAttempt && this.importWait?.connection === attempt.connection) {
        this.importWait.reject(new JavaIntelligenceError("JDT_BROKEN", "JDT exited during project import"));
      }
      if (ownsReadyProcess) {
        this.importState = this.lifecycleState === "STOPPED" ? "NOT_STARTED" : "FAILED";
        if (this.readyStableTimer) {
          clearTimeout(this.readyStableTimer);
          this.readyStableTimer = undefined;
        }
        // A STARTING attempt's failure is recorded once by the shared start
        // promise catch, so only a READY child's death is counted here. The
        // same is true of the lease release: a STARTING attempt's failure
        // releases it through that same catch.
        this.restartBackoff.recordFailure("JDT_BROKEN");
        void this.releasePendingLease();
      }
      try {
        attempt.connection.dispose();
      } catch {
        // Disposing an already-dead connection must not break exit handling.
      }
      this.process = undefined;
      this.connection = undefined;
      this.startAttempt = undefined;
      this.startedAt = undefined;
      if (this.lifecycleState !== "STARTING") void this.releasePendingLease();
      this.transition(this.lifecycleState === "STOPPED" ? "STOPPED" : "BROKEN", true);
    });
  }

  private armReadyStabilityReset(attempt: JdtlsTransportAttempt): void {
    if (this.readyStableTimer) clearTimeout(this.readyStableTimer);
    this.readyStableTimer = setTimeout(() => {
      if (this.lifecycleState === "READY" && this.process === attempt.child) {
        this.restartBackoff.recordReadyStable();
      }
    }, this.readyStabilityMs);
    this.readyStableTimer.unref?.();
  }

  private async disposeAttempt(attempt: JdtlsTransportAttempt): Promise<void> {
    await this.finishChild(attempt);
  }

  private async trackSpawnedChild(attempt: JdtlsTransportAttempt): Promise<void> {
    this.liveAttempts.add(attempt);
    const pid = attempt.child.pid;
    if (pid === undefined) return;
    const identity = await this.captureOwnedIdentity(pid);
    if (identity) this.childIdentity.set(attempt.child, identity);
    // `null` suppresses touchRepoCache's ps fallback. A collided pid, or one
    // still invisible after the retries, must not be stored under an identity
    // we did not match to this workspace.
    touchRepoCache(this.repoRoot, {
      jdtlsPid: pid,
      jdtlsProcessStartIdentity: identity ?? null
    });
  }

  private async rememberOwnedIdentity(child: JdtlsChild, pid: number): Promise<string | undefined> {
    const known = this.childIdentity.get(child);
    if (known) return known;
    const identity = await this.captureOwnedIdentity(pid);
    if (identity) this.childIdentity.set(child, identity);
    return identity;
  }

  private async captureOwnedIdentity(pid: number): Promise<string | undefined> {
    // Spawn returns before `ps` always sees the new pid. A missing command is
    // unseen, not a collision, so it retries. A visible command that is not
    // this workspace stops immediately.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const command = processCommand(pid);
      const verdict = classifyWorkspaceCommand(command, this.dataDir);
      if (verdict === "collision") return undefined;
      if (verdict === "owned") {
        const identity = processStartIdentityForPid(pid);
        if (identity) return identity;
      }
      if (attempt < 2) await delay(25);
    }
    return undefined;
  }

  private ownedChild(): JdtlsChild | undefined {
    if (this.lifecycleState === "READY") return this.process;
    if (this.lifecycleState === "STARTING") return this.startAttempt?.child ?? this.process;
    return undefined;
  }

  private reapChildren(mode: "abandoned" | "all"): Promise<void> {
    return this.reapChildrenNow(mode);
  }

  private async reapChildrenNow(mode: "abandoned" | "all"): Promise<void> {
    const keep = mode === "abandoned" ? this.ownedChild() : undefined;
    for (const attempt of [...this.liveAttempts]) {
      if (attempt.child === keep) continue;
      await this.finishChild(attempt);
    }
  }

  private async finishChild(attempt: JdtlsTransportAttempt): Promise<boolean> {
    if (!this.liveAttempts.has(attempt) && childHasExited(attempt.child)) {
      return true;
    }
    // Detach before kill so the exit handler does not treat this reap as the
    // active session dying and overwrite a start that is about to replace it.
    const wasStart = this.startAttempt === attempt;
    const wasProcess = this.process === attempt.child;
    if (wasStart) this.startAttempt = undefined;
    if (wasProcess) {
      this.process = undefined;
      this.connection = undefined;
      this.startedAt = undefined;
    }
    try {
      attempt.connection.dispose();
    } catch {
      // Best-effort; the child is terminated regardless.
    }
    let dead = childHasExited(attempt.child) || await terminateChild(attempt.child, 200);
    if (!dead) {
      const pid = attempt.child.pid;
      const identity = pid === undefined ? undefined : await this.rememberOwnedIdentity(attempt.child, pid);
      if (pid !== undefined && identity) {
        killOwnedProcessTree(pid, this.dataDir, identity);
        dead = await this.waitUntilChildGone(attempt.child, identity, 1000);
      }
    }
    if (!dead) {
      if (wasStart && this.startAttempt === undefined) this.startAttempt = attempt;
      if (wasProcess && this.process === undefined) {
        this.process = attempt.child;
        this.connection = attempt.connection;
      }
      return false;
    }
    this.liveAttempts.delete(attempt);
    if (this.liveAttempts.size === 0) {
      touchRepoCache(this.repoRoot, { jdtlsPid: undefined });
    }
    return true;
  }

  private async waitUntilChildGone(child: JdtlsChild, identity: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (childHasExited(child)) return true;
      const pid = child.pid;
      if (pid === undefined || !ownedPidStillAlive(pid, identity)) return true;
      await delay(25);
    }
    if (childHasExited(child)) return true;
    const pid = child.pid;
    return pid === undefined || !ownedPidStillAlive(pid, identity);
  }

  private registerClientHandlers(connection: JdtlsConnection): void {
    connection.onRequest("client/registerCapability", async () => null);
    connection.onRequest("workspace/configuration", async (params: { items?: Array<{ section?: string }> }) => {
      const startedAt = performance.now();
      try {
        return (params.items || []).map(item => {
          const settings = this.javaSettings();
          if (!item.section || item.section === "java") {
            return settings.java;
          }
          if (item.section.startsWith("java.")) {
            return pickJavaConfigurationSection(settings.java, item.section.replace(/^java\./, ""));
          }
          return null;
        });
      } finally {
        this.activeFirstTouchTrace?.recordConfigurationRequest(performance.now() - startedAt);
      }
    });
    connection.onRequest("workspace/applyEdit", async () => ({ applied: false }));
    connection.onRequest("window/workDoneProgress/create", async () => null);
    connection.onRequest("window/showMessageRequest", async () => null);
    connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: LspDiagnostic[] }) => {
      this.diagnostics.set(params.uri, filterGeneratedCodeDiagnostics({
        generatedCode: this.generatedCode,
        source: this.sourceTextForUri(params.uri),
        diagnostics: params.diagnostics || []
      }));
    });
    connection.onNotification("$/progress", (params: { token?: string | number; value?: { kind?: string; title?: string; message?: string } }) => {
      this.recordProgress(params);
    });
    connection.onNotification("language/status", (params: { type?: string; message?: string }) => {
      if (this.startAttempt?.connection !== connection && this.connection !== connection) return;
      this.lastLanguageStatus = [params.type, params.message].filter(Boolean).join(": ");
      this.lastProgressAt = new Date();
      const waiting = this.importWait;
      if (waiting?.connection !== connection) return;
      if (params.type === "Error") {
        waiting.error = new JavaIntelligenceError("JDT_SERVER_ERROR", params.message || "JDT project initialization failed");
        this.importState = "FAILED";
        waiting.reject(waiting.error);
      } else if (params.type === "ServiceReady" && !waiting.error) {
        waiting.resolve();
      }
    });
    connection.onError(error => {
      console.error("[codex-java-lsp] jsonrpc error", error);
    });
  }

  private initializeParams(): unknown {
    return buildInitializeParams(this.repoRoot, this.javaSettings());
  }

  private javaSettings(): Record<string, unknown> {
    return buildJavaSettings({
      repoRoot: this.repoRoot,
      buildSystem: this.buildSystem,
      projectJdk: this.projectJdk,
      generatedCode: this.generatedCode,
      gradleHome: this.gradleDomain?.home,
      gradleImport: this.gradleDomain?.gradleImport
    });
  }

  private invalidateCacheFor(files: string[]): void {
    if (files.length === 0 || this.cache.size === 0) {
      return;
    }
    const normalized = new Set(files.map(file => path.normalize(file)));
    let removed = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.dependencies.size === 0 || [...entry.dependencies].some(file => normalized.has(file))) {
        this.cache.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.cacheInvalidations += removed;
      this.lastCacheInvalidatedAt = new Date();
    }
  }

  private clearCache(batch?: RepoChangeBatch): void {
    if (this.cache.size > 0) {
      this.cacheInvalidations += this.cache.size;
      this.lastCacheInvalidatedAt = new Date();
    }
    this.cache.clear();
    this.invalidateSemanticGateway(batch);
  }

  private invalidateSemanticGateway(batch?: RepoChangeBatch): void {
    const clockValue = this.generationClock?.snapshot().value;
    if (clockValue !== undefined) {
      this.cacheGeneration = clockValue;
    } else if (batch) {
      this.cacheGeneration = Math.max(this.cacheGeneration + 1, batch.generation);
    } else {
      this.cacheGeneration += 1;
    }
    this.semanticGateway.clear();
  }

  private evictExpiredCacheEntries(): void {
    if (this.cache.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }

  private progressStatus(): JdtlsProgressStatus {
    return {
      importState: this.importState,
      active: this.activeProgress.size,
      activeMessages: [...this.activeProgress.values()].slice(0, 5),
      lastProgressAt: this.lastProgressAt?.toISOString(),
      lastLanguageStatus: this.lastLanguageStatus
    };
  }

  private recordProgress(params: { token?: string | number; value?: { kind?: string; title?: string; message?: string } }): void {
    this.activeFirstTouchTrace?.recordProgress(params);
    const token = String(params.token ?? "unknown");
    const value = params.value || {};
    this.lastProgressAt = new Date();
    if (value.kind === "begin") {
      this.activeProgress.set(token, [value.title, value.message].filter(Boolean).join(": ") || token);
    } else if (value.kind === "end") {
      this.activeProgress.delete(token);
    } else if (this.activeProgress.has(token)) {
      this.activeProgress.set(token, [value.title, value.message].filter(Boolean).join(": ") || this.activeProgress.get(token) || token);
    }
  }
}

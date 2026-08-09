// input: MCP tool requests that need Java semantic information.
// output: Managed Eclipse JDT LS requests and normalized raw LSP responses.
// pos: Stateful LSP client and process manager for the generic Java LSP MCP bridge.
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CancellationTokenSource } from "vscode-jsonrpc/node.js";
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
import type { Completion } from "./runtime/completion.js";
import {
  classifySemanticError,
  JavaIntelligenceError,
  type JavaIntelligenceErrorCode
} from "./runtime/intelligence-error.js";
import { normalizeRepoLocation } from "./semantic-location.js";
import { DocumentLru } from "./document-lru.js";
import { detectGeneratedCode, type GeneratedCodeStatus } from "./generated-code.js";
import { detectBuildSystem, resolveProjectJdk, type BuildSystem, type ProjectJdkStatus } from "./project-jdk.js";
import { fromFileUri, repoCacheRoot, toFileUri } from "./repo-layout.js";
import type { RepoChange, RepoChangeBatch } from "./repo-generation.js";
import { resourceDefaults } from "./resource-defaults.js";
import { touchRepoCache } from "./worktree-cache-cleanup.js";
import type { WorktreeIdentity } from "./worktree-identity.js";
import {
  SemanticGateway,
  type SemanticBackend,
  type SemanticBackendResult,
  type SemanticBackendValue,
  type SemanticCacheKey,
  type SemanticGatewayOptions,
  type SemanticGatewayStatus,
  type SemanticValueMap
} from "./semantic-gateway.js";

export type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export type LspLocation = {
  uri: string;
  range: LspRange;
};

export type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
};

export type LspSymbol = {
  name: string;
  kind: number;
  containerName?: string;
  location?: LspLocation;
  data?: unknown;
};

export type LspDocumentSymbol = {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspDocumentSymbol[];
};

export type LspDiagnostic = {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
};

export type DiagnosticFilterInput = {
  readonly generatedCode: GeneratedCodeStatus;
  readonly source?: string;
  readonly diagnostics: readonly LspDiagnostic[];
};

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
  active: number;
  activeMessages: string[];
  lastProgressAt?: string;
  lastLanguageStatus?: string;
};

export type TelemetryObservation<T> =
  | { status: "MEASURED"; value: T }
  | { status: "UNMEASURED"; reason: string }
  | { status: "NOT_APPLICABLE"; reason: string };

export type JdtFirstTouchExecution =
  | "new-process"
  | "joined-existing-start"
  | "reused-ready-session";

export type JdtFirstTouchOperationTrace = {
  id: number;
  method: string;
  callerMs: TelemetryObservation<number>;
  callerSettlement: TelemetryObservation<"COMPLETE" | "FAILED" | "CANCELLED" | "DEADLINE_EXCEEDED">;
  backendSettlement: TelemetryObservation<"fulfilled" | "rejected" | "pending">;
  backendSettlementAfterCallerMs: TelemetryObservation<number>;
  cancelSentMs: TelemetryObservation<number>;
  cancelAckMs: TelemetryObservation<number>;
};

export type JdtFirstTouchSessionTrace = {
  schemaVersion: "java-intelligence-v32-jdt-first-touch-session/v1";
  execution: JdtFirstTouchExecution;
  startup: {
    filesystemSetupMs: TelemetryObservation<number>;
    processSpawnCallMs: TelemetryObservation<number>;
    initializeRoundTripMs: TelemetryObservation<number>;
    configurationNotifySendMs: TelemetryObservation<number>;
    configurationAppliedMs: TelemetryObservation<number>;
    jdtlsPid: TelemetryObservation<number>;
  };
  configuration: {
    requests: number;
    responseBuildMs: TelemetryObservation<number>;
  };
  progress: {
    events: Array<{ atMs: number; kind: string; title?: string }>;
    projectImportMs: TelemetryObservation<number>;
  };
  document: {
    sourceReadMs: TelemetryObservation<number>;
    lruSynchronizeMs: TelemetryObservation<number>;
    syncAction: TelemetryObservation<"didOpen" | "didChange" | "reused">;
    serverAppliedMs: TelemetryObservation<number>;
  };
  gateway: {
    cacheHit: TelemetryObservation<boolean>;
    shared: TelemetryObservation<boolean>;
    backendRole: TelemetryObservation<"owner" | "joiner" | "cache">;
  };
  operations: JdtFirstTouchOperationTrace[];
};

export interface JdtFirstTouchTraceHandle {
  endAttempt(): void;
  snapshot(): JdtFirstTouchSessionTrace;
  close(): JdtFirstTouchSessionTrace;
}

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  dependencies: Set<string>;
};

const DEFAULT_LSP_REQUEST_TIMEOUT_MS = positiveInteger(process.env.JDTLS_REQUEST_TIMEOUT_MS, 120000);
const DEFAULT_CACHE_TTL_MS = positiveInteger(process.env.JDTLS_CACHE_TTL_MS, 300000);

export type HierarchyEdge = {
  depth: number;
  from: unknown;
  to: unknown;
  ranges?: LspRange[];
};

export type HierarchyResult = {
  roots: unknown[];
  edges: HierarchyEdge[];
  completion: Completion;
  truncated: boolean;
  requests: number;
  visited: number;
  errorCode?: JavaIntelligenceErrorCode;
};

/** Hard ceiling on expansion requests regardless of the caller's limit. */
const MAX_HIERARCHY_REQUESTS = 64;
const HIERARCHY_PREPARE_CAP_MS = 1000;
const HIERARCHY_STEP_CAP_MS = 1500;

type FirstTouchStartupPhase =
  | "filesystemSetupMs"
  | "processSpawnCallMs"
  | "initializeRoundTripMs"
  | "configurationNotifySendMs";

type MutableFirstTouchOperation = {
  id: number;
  method: string;
  startedAt: number;
  callerCompletedAt?: number;
  callerSettlement?: "COMPLETE" | "FAILED" | "CANCELLED" | "DEADLINE_EXCEEDED";
  backendSettledAt?: number;
  backendSettlement?: "fulfilled" | "rejected";
  cancelSentAt?: number;
};

class JdtFirstTouchRecorder {
  private readonly startedAt = performance.now();
  private readonly startupPhases = new Map<FirstTouchStartupPhase, number>();
  private readonly progressEvents: Array<{ atMs: number; kind: string; title?: string }> = [];
  private readonly importProgressStarts = new Map<string, number>();
  private projectImportMs = 0;
  private configurationRequests = 0;
  private configurationResponseBuildMs = 0;
  private sourceReadMs = 0;
  private lruSynchronizeMs = 0;
  private readonly documentNotifications: string[] = [];
  private readonly operations = new Map<number, MutableFirstTouchOperation>();
  private nextOperationId = 1;
  private pid?: number;
  private sessionStopped = false;

  constructor(readonly execution: JdtFirstTouchExecution) {}

  recordStartupPhase(name: FirstTouchStartupPhase, elapsedMs: number): void {
    this.startupPhases.set(name, (this.startupPhases.get(name) ?? 0) + elapsedMs);
  }

  recordPid(pid: number | undefined): void {
    if (pid !== undefined) this.pid = pid;
  }

  recordConfigurationRequest(elapsedMs: number): void {
    this.configurationRequests += 1;
    this.configurationResponseBuildMs += elapsedMs;
  }

  recordProgress(params: { token?: string | number; value?: { kind?: string; title?: string; message?: string } }): void {
    const token = String(params.token ?? "unknown");
    const kind = params.value?.kind ?? "report";
    const title = [params.value?.title, params.value?.message].filter(Boolean).join(": ") || undefined;
    const at = performance.now();
    this.progressEvents.push({ atMs: roundedMs(at - this.startedAt), kind, title });
    const isImportProgress = /(?:import|project|workspace|build)/i.test(title ?? "")
      || this.importProgressStarts.has(token);
    if (!isImportProgress) return;
    if (kind === "begin") {
      this.importProgressStarts.set(token, at);
    } else if (kind === "end") {
      const startedAt = this.importProgressStarts.get(token);
      if (startedAt !== undefined) this.projectImportMs += Math.max(0, at - startedAt);
      this.importProgressStarts.delete(token);
    }
  }

  recordDocumentRead(elapsedMs: number): void {
    this.sourceReadMs += elapsedMs;
  }

  documentNotificationCount(): number {
    return this.documentNotifications.length;
  }

  recordDocumentNotification(method: string): void {
    if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
      this.documentNotifications.push(method);
    }
  }

  recordDocumentSync(elapsedMs: number): void {
    this.lruSynchronizeMs += elapsedMs;
  }

  beginOperation(method: string): number {
    const id = this.nextOperationId++;
    this.operations.set(id, { id, method, startedAt: performance.now() });
    return id;
  }

  recordCallerSettlement(
    id: number,
    settlement: MutableFirstTouchOperation["callerSettlement"]
  ): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    operation.callerCompletedAt = performance.now();
    operation.callerSettlement = settlement;
  }

  recordBackendSettlement(id: number, settlement: "fulfilled" | "rejected"): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    operation.backendSettledAt = performance.now();
    operation.backendSettlement = settlement;
  }

  recordCancelSent(id: number): void {
    const operation = this.operations.get(id);
    if (!operation || operation.cancelSentAt !== undefined) return;
    operation.cancelSentAt = performance.now();
  }

  markSessionStopped(): void {
    this.sessionStopped = true;
  }

  snapshot(): JdtFirstTouchSessionTrace {
    const startupObservation = (name: FirstTouchStartupPhase): TelemetryObservation<number> => {
      const value = this.startupPhases.get(name);
      if (value !== undefined) return measured(roundedMs(value));
      if (this.execution === "reused-ready-session") {
        return notApplicable("the attempt reused an already READY JDT session");
      }
      return unmeasured(`${name} was not observed before the trace snapshot`);
    };
    const actions = this.documentNotifications;
    const syncAction: TelemetryObservation<"didOpen" | "didChange" | "reused"> = actions.includes("textDocument/didOpen")
      ? measured("didOpen")
      : actions.includes("textDocument/didChange")
        ? measured("didChange")
        : this.lruSynchronizeMs > 0
          ? measured("reused")
          : unmeasured("no document synchronization phase was observed");
    return {
      schemaVersion: "java-intelligence-v32-jdt-first-touch-session/v1",
      execution: this.execution,
      startup: {
        filesystemSetupMs: startupObservation("filesystemSetupMs"),
        processSpawnCallMs: startupObservation("processSpawnCallMs"),
        initializeRoundTripMs: startupObservation("initializeRoundTripMs"),
        configurationNotifySendMs: startupObservation("configurationNotifySendMs"),
        configurationAppliedMs: unmeasured("LSP configuration notifications have no server acknowledgement"),
        jdtlsPid: this.pid !== undefined
          ? measured(this.pid)
          : this.execution === "reused-ready-session"
            ? notApplicable("the reused session pid was not sampled by this attempt")
            : unmeasured("the JDT child pid was unavailable")
      },
      configuration: {
        requests: this.configurationRequests,
        responseBuildMs: this.configurationRequests > 0
          ? measured(roundedMs(this.configurationResponseBuildMs))
          : unmeasured("JDT did not issue workspace/configuration during this attempt")
      },
      progress: {
        events: this.progressEvents.map(event => ({ ...event })),
        projectImportMs: this.projectImportMs > 0
          ? measured(roundedMs(this.projectImportMs))
          : unmeasured("no complete project-import progress begin/end span was observed")
      },
      document: {
        sourceReadMs: this.sourceReadMs > 0
          ? measured(roundedMs(this.sourceReadMs))
          : unmeasured("no source read was observed"),
        lruSynchronizeMs: this.lruSynchronizeMs > 0
          ? measured(roundedMs(this.lruSynchronizeMs))
          : unmeasured("no document LRU synchronization was observed"),
        syncAction,
        serverAppliedMs: unmeasured("didOpen/didChange notifications have no server acknowledgement")
      },
      gateway: {
        cacheHit: unmeasured("raw JdtlsSession first-touch operations bypass SemanticGateway"),
        shared: unmeasured("raw JdtlsSession first-touch operations bypass SemanticGateway"),
        backendRole: unmeasured("raw JdtlsSession first-touch operations bypass SemanticGateway")
      },
      operations: [...this.operations.values()].map(operation => this.operationSnapshot(operation))
    };
  }

  private operationSnapshot(operation: MutableFirstTouchOperation): JdtFirstTouchOperationTrace {
    const callerMs = operation.callerCompletedAt === undefined
      ? unmeasured("caller had not settled at snapshot")
      : measured(roundedMs(operation.callerCompletedAt - operation.startedAt));
    const backendSettlement = operation.backendSettlement === undefined
      ? measured<"fulfilled" | "rejected" | "pending">("pending")
      : measured<"fulfilled" | "rejected" | "pending">(operation.backendSettlement);
    let backendSettlementAfterCallerMs: TelemetryObservation<number>;
    if (operation.callerCompletedAt === undefined) {
      backendSettlementAfterCallerMs = unmeasured("caller had not settled at snapshot");
    } else if (operation.backendSettledAt !== undefined) {
      backendSettlementAfterCallerMs = measured(roundedMs(Math.max(0, operation.backendSettledAt - operation.callerCompletedAt)));
    } else {
      backendSettlementAfterCallerMs = unmeasured(this.sessionStopped
        ? "backend did not settle before benchmark session stop"
        : "backend was still pending at snapshot");
    }
    const cancelSentMs = operation.cancelSentAt === undefined
      ? notApplicable<number>("the caller did not request cancellation")
      : measured(roundedMs(operation.cancelSentAt - operation.startedAt));
    return {
      id: operation.id,
      method: operation.method,
      callerMs,
      callerSettlement: operation.callerSettlement
        ? measured(operation.callerSettlement)
        : unmeasured("caller settlement was not observed"),
      backendSettlement,
      backendSettlementAfterCallerMs,
      cancelSentMs,
      cancelAckMs: operation.cancelSentAt === undefined
        ? notApplicable("the caller did not request cancellation")
        : unmeasured("LSP cancellation has no acknowledgement")
    };
  }
}

export class JdtlsSession {
  private connection?: JdtlsConnection;
  private process?: JdtlsChild;
  private lifecycleState: JdtlsLifecycleState = "NEW";
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private startAttempt?: JdtlsTransportAttempt;
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
  private readonly documents: DocumentLru;
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
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
  private readonly activeProgress = new Map<string, string>();
  private lastProgressAt?: Date;
  private lastLanguageStatus?: string;
  private phaseMetrics: Record<string, number> = {};
  private pendingLease?: CompositeJdtLease;
  private leaseHeartbeatTimer?: NodeJS.Timeout;
  private leaseHeartbeatPromise?: Promise<void>;
  private leaseHeartbeatError?: JavaIntelligenceError;
  private lastLeaseHeartbeatAt?: Date;
  private readonly leaseHeartbeatMs = positiveInteger(
    process.env.JAVA_LSP_JDT_LEASE_HEARTBEAT_MS,
    30_000
  );
  private readonly worktree: WorktreeIdentity;
  /**
   * Independent staleness signal for SemanticGateway-owned operations,
   * alongside each key's own fileFingerprint. Mirrors clearCache()'s
   * existing repo-change/stop semantics. Any Java change bumps this because
   * cross-file definitions/references cannot be invalidated safely from the
   * queried file's fingerprint alone.
   */
  private cacheGeneration = 1;
  private readonly semanticGateway: SemanticGateway;
  private activeFirstTouchTrace?: JdtFirstTouchRecorder;
  private readonly firstTouchTraces = new Set<JdtFirstTouchRecorder>();

  constructor(
    private readonly repoRoot: string,
    aliases: string[] = [],
    private readonly transportFactory: JdtlsTransportFactory = defaultJdtlsTransportFactory,
    now: () => number = Date.now,
    private readonly leaseStore: CrossProcessLeaseStore = new NoopCrossProcessLeaseStore(),
    worktree?: WorktreeIdentity
  ) {
    this.worktree = worktree ?? { repoRoot, repoHash: repoHash(repoRoot), isLinkedWorktree: false };
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
    const cacheRoot = repoCacheRoot(repoRoot);
    this.dataDir = process.env.JDTLS_DATA_DIR || path.join(cacheRoot, "workspace");
    this.logDir = process.env.JDTLS_LOG_DIR || path.join(cacheRoot, "logs");
    this.logFile = path.join(this.logDir, "jdtls.log");
    this.jdtlsBin = process.env.JDTLS_BIN || findExecutable("jdtls");
    this.buildSystem = detectBuildSystem(repoRoot);
    this.projectJdk = resolveProjectJdk(repoRoot, aliases);
    this.generatedCode = detectGeneratedCode(repoRoot);
    this.jdtlsRuntimeJavaHome = process.env.JDTLS_JAVA_HOME || process.env.JAVA_HOME;
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

  async ensureStarted(
    callerBudget = DeadlineBudget.fromTimeout(DEFAULT_LSP_REQUEST_TIMEOUT_MS)
  ): Promise<void> {
    const startedAt = Date.now();
    try {
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

  private transition(next: JdtlsLifecycleState): void {
    if (this.lifecycleState === next) return;
    this.lifecycleState = next;
    for (const listener of this.lifecycleListeners) listener(next);
  }

  private async startAfterLease(callerBudget: DeadlineBudget): Promise<void> {
    const leaseResult = await this.acquireCrossProcessLease(callerBudget);
    if (leaseResult.kind !== "ACQUIRED") {
      throw leaseAcquireResultToError(leaseResult);
    }
    this.pendingLease = leaseResult.lease;
    this.startLeaseHeartbeat(leaseResult.lease);
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
    const lease = this.pendingLease;
    this.pendingLease = undefined;
    this.stopLeaseHeartbeat();
    const heartbeat = this.leaseHeartbeatPromise;
    if (heartbeat) await heartbeat.catch(() => undefined);
    this.leaseHeartbeatError = undefined;
    if (lease) await lease.release();
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
      this.clearCache();
      return;
    }
    const files = batch.changes
      .filter(change => change.kind.startsWith("JAVA_"))
      .map(change => change.absolutePath);
    if (files.length > 0) {
      this.invalidateCacheFor(files);
      this.invalidateSemanticGateway();
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
    this.clearCache();
    if (this.readyStableTimer) {
      clearTimeout(this.readyStableTimer);
      this.readyStableTimer = undefined;
    }

    const startAttempt = this.startAttempt;
    const startPromise = this.startPromise;
    const connection = this.connection;
    const child = this.process;
    this.startAttempt = undefined;
    this.startPromise = undefined;
    this.connection = undefined;
    this.process = undefined;
    this.startedAt = undefined;

    if (startAttempt) {
      await this.disposeAttempt(startAttempt);
    }
    if (startPromise) {
      // Let startup waiters settle before stop() resolves, so a later
      // ensureStarted() never races a half-torn-down attempt.
      await startPromise.catch(() => undefined);
    }
    if (connection) {
      try {
        await withTimeout(connection.sendRequest("shutdown"), 3000, "shutdown");
        connection.sendNotification("exit");
      } catch {
        // Best-effort shutdown; the process is terminated below if it remains alive.
      }
      try {
        connection.dispose();
      } catch {
        // A disposed connection must never mask the rest of the teardown.
      }
    }
    if (child) {
      await terminateChild(child, 200);
    }
    // A start failure already releases via ensureStarted()'s own catch (awaited
    // above through startPromise); this is a no-op in that case and the only
    // release path when stop() is called on an already-READY session.
    await this.releasePendingLease();
    touchRepoCache(this.repoRoot, { jdtlsPid: undefined });
    this.documents.closeAll();
    this.diagnostics.clear();
  }

  async workspaceSymbols(
    query: string,
    limit: number,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS
  ): Promise<{ items: LspSymbol[]; truncated: boolean }> {
    const budget = semanticBudget(timeoutOrBudget);
    budget.throwIfExpired("workspace/symbol");
    return this.cached("workspaceSymbols", [query, limit], [], async () => {
      await this.ensureStarted(budget);
      budget.throwIfExpired("workspace/symbol");
      const items = await this.request<LspSymbol[]>(
        "workspace/symbol",
        { query },
        Math.max(1, budget.remainingMs())
      );
      return truncate(items || [], limit);
    });
  }

  /**
   * Task 33 Step 7 cutover: hover/definition/implementation are now three
   * independently gateway-cached operations instead of one bundled
   * cached("symbolContext", ...) entry. A per-suboperation failure or
   * caller-deadline timeout degrades to absent (matching the old
   * requestSettled() behavior exactly) rather than failing the whole call -
   * symbolContext() itself still never throws.
   */
  async symbolContext(
    file: string,
    line: number,
    column: number,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS
  ): Promise<{
    hover: unknown;
    definitions: Array<LspLocation | LspLocationLink>;
    implementations: Array<LspLocation | LspLocationLink>;
  }> {
    const budget = semanticBudget(timeoutOrBudget);
    const operationCapMs = semanticOperationCap(timeoutOrBudget, budget);
    const [hover, definitions, implementations] = await Promise.all([
      this.gatewaySemanticValue("hover", file, line, column, budget, operationCapMs),
      this.gatewaySemanticValue("definition", file, line, column, budget, operationCapMs),
      this.gatewaySemanticValue("implementation", file, line, column, budget, operationCapMs)
    ]);
    return {
      hover,
      definitions: definitions ? [...definitions] : [],
      implementations: implementations ? [...implementations] : []
    };
  }

  /** Same cutover as symbolContext(); see its comment. Shares the same "definition"/"implementation" gateway cache entries when called for the same position - a natural improvement over the old bundled per-method caches, which never overlapped even when asking the identical LSP question. */
  async semanticLocations(
    file: string,
    line: number,
    column: number,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    includeImplementations = false
  ): Promise<{
    definitions: Array<LspLocation | LspLocationLink>;
    implementations: Array<LspLocation | LspLocationLink>;
  }> {
    const budget = semanticBudget(timeoutOrBudget);
    const operationCapMs = semanticOperationCap(timeoutOrBudget, budget);
    const [definitions, implementations] = await Promise.all([
      this.gatewaySemanticValue("definition", file, line, column, budget, operationCapMs),
      includeImplementations ? this.gatewaySemanticValue("implementation", file, line, column, budget, operationCapMs) : Promise.resolve(undefined)
    ]);
    return {
      definitions: definitions ? [...definitions] : [],
      implementations: implementations ? [...implementations] : []
    };
  }

  /**
   * Shared primitive behind symbolContext/semanticLocations: a single
   * gateway-owned operation at this position, degrading to `undefined` on
   * any non-COMPLETE outcome (backend failure) or caller-deadline rejection -
   * matching requestSettled()'s "never throws, absent on any trouble"
   * contract these two callers both rely on.
   */
  private async gatewaySemanticValue<Operation extends "hover" | "definition" | "implementation">(
    operation: Operation,
    file: string,
    line: number,
    column: number,
    budget: DeadlineBudget,
    operationCapMs: number
  ): Promise<SemanticValueMap[Operation] | undefined> {
    const key: SemanticCacheKey<Operation> = {
      repoHash: this.worktree.repoHash,
      generation: this.cacheGeneration,
      operation,
      file,
      fileFingerprint: fileFingerprint(file),
      line,
      column,
      optionsKey: ""
    };
    try {
      const outcome = await this.semanticGateway.execute(key, budget, operationCapMs);
      return outcome.completion === "COMPLETE" ? outcome.value : undefined;
    } catch {
      return undefined;
    }
  }

  private async ensureSemanticStarted(
    budget: DeadlineBudget,
    signal: AbortSignal | undefined,
    stage: string
  ): Promise<void> {
    throwIfAborted(signal, stage);
    await waitForAbortSignal(this.ensureStarted(budget), signal, stage);
  }

  async documentSymbols(file: string, timeoutMs = 2000): Promise<LspDocumentSymbol[]> {
    return this.cached("documentSymbols", [file, timeoutMs], [file], async () => this.rawDocumentSymbols(file, timeoutMs));
  }

  /** Uncached primitive for SemanticGateway; see rawReferences. */
  async rawDocumentSymbols(
    file: string,
    timeoutOrBudget: number | DeadlineBudget = 2000,
    signal?: AbortSignal
  ): Promise<LspDocumentSymbol[]> {
    const budget = semanticBudget(timeoutOrBudget);
    await this.ensureSemanticStarted(budget, signal, "textDocument/documentSymbol startup");
    budget.throwIfExpired("textDocument/documentSymbol");
    const symbols = await this.withDocument(file, uri =>
      this.request<LspDocumentSymbol[]>(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
        Math.max(1, budget.remainingMs()),
        signal
      )
    );
    return symbols || [];
  }

  async documentSymbolsWithRetry(file: string, totalTimeoutMs = 20000): Promise<LspDocumentSymbol[]> {
    const deadline = Date.now() + totalTimeoutMs;
    await this.ensureStarted();
    const waitStartedAt = Date.now();
    await this.waitForProgressIdle(Math.max(1, deadline - Date.now()));
    this.addPhaseMetric("progressIdleWait", Date.now() - waitStartedAt);
    const attemptTimeoutMs = positiveInteger(process.env.JAVA_LSP_DOCUMENT_SYMBOL_ATTEMPT_TIMEOUT_MS, 10000);
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await this.documentSymbols(file, Math.min(attemptTimeoutMs, Math.max(1, deadline - Date.now())));
      } catch (error) {
        lastError = error;
        await delay(Math.min(1000, Math.max(1, deadline - Date.now())));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Timed out waiting for textDocument/documentSymbol retry budget.");
  }

  /**
   * Task 33 Step 7 cutover: routed through SemanticGateway instead of the
   * generic cached() TTL wrapper - singleflight, complete-only cache,
   * lifecycle-gate short-circuit. Return shape and throw-on-non-COMPLETE
   * behavior are preserved exactly so no caller (semantic.ts, symbol.ts)
   * needed a code change.
   */
  async references(
    file: string,
    line: number,
    column: number,
    includeDeclaration: boolean,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS
  ): Promise<{
    items: LspLocation[];
    totalReferences: number;
    truncated: boolean;
  }> {
    const budget = semanticBudget(timeoutOrBudget);
    const operationCapMs = semanticOperationCap(timeoutOrBudget, budget);
    const key: SemanticCacheKey<"references"> = {
      repoHash: this.worktree.repoHash,
      generation: this.cacheGeneration,
      operation: "references",
      file,
      fileFingerprint: fileFingerprint(file),
      line,
      column,
      optionsKey: `includeDeclaration=${includeDeclaration}`
    };
    const outcome = await this.semanticGateway.execute(key, budget, operationCapMs);
    if (outcome.completion !== "COMPLETE") {
      throw new JavaIntelligenceError(
        outcome.errorCode ?? "JDT_SERVER_ERROR",
        `textDocument/references did not complete (completion=${outcome.completion})`
      );
    }
    const items = [...outcome.value];
    return {
      items,
      totalReferences: items.length,
      truncated: false
    };
  }

  /**
   * Uncached primitive behind `references()`. Package-internal: exists so
   * SemanticGateway (Task 33) can own its own singleflight/complete-only
   * cache for this operation instead of going through the generic TTL cache
   * a second time.
   */
  async rawReferences(
    file: string,
    line: number,
    column: number,
    includeDeclaration: boolean,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<LspLocation[]> {
    const budget = semanticBudget(timeoutOrBudget);
    await this.ensureSemanticStarted(budget, signal, "textDocument/references startup");
    budget.throwIfExpired("textDocument/references");
    const items = await this.withDocumentPosition(file, line, column, params =>
      this.request<LspLocation[]>(
        "textDocument/references",
        { ...params, context: { includeDeclaration } },
        Math.max(1, budget.remainingMs()),
        signal
      )
    );
    return items || [];
  }

  /** Uncached primitive for SemanticGateway; see rawReferences. */
  async rawHover(
    file: string,
    line: number,
    column: number,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<unknown> {
    const budget = semanticBudget(timeoutOrBudget);
    await this.ensureSemanticStarted(budget, signal, "textDocument/hover startup");
    budget.throwIfExpired("textDocument/hover");
    return this.withDocumentPosition(file, line, column, params =>
      this.request<unknown>("textDocument/hover", params, Math.max(1, budget.remainingMs()), signal)
    );
  }

  /** Uncached primitive for SemanticGateway; see rawReferences. */
  async rawDefinition(
    file: string,
    line: number,
    column: number,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<Array<LspLocation | LspLocationLink>> {
    const budget = semanticBudget(timeoutOrBudget);
    await this.ensureSemanticStarted(budget, signal, "textDocument/definition startup");
    budget.throwIfExpired("textDocument/definition");
    const result = await this.withDocumentPosition(file, line, column, params =>
      this.request<unknown>("textDocument/definition", params, Math.max(1, budget.remainingMs()), signal)
    );
    return normalizeLocations(result);
  }

  /** Uncached primitive for SemanticGateway; see rawReferences. */
  async rawImplementation(
    file: string,
    line: number,
    column: number,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<Array<LspLocation | LspLocationLink>> {
    const budget = semanticBudget(timeoutOrBudget);
    await this.ensureSemanticStarted(budget, signal, "textDocument/implementation startup");
    budget.throwIfExpired("textDocument/implementation");
    const result = await this.withDocumentPosition(file, line, column, params =>
      this.request<unknown>("textDocument/implementation", params, Math.max(1, budget.remainingMs()), signal)
    );
    return normalizeLocations(result);
  }

  async diagnosticsFor(
    files: string[],
    waitMs: number,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS
  ): Promise<Record<string, LspDiagnostic[]>> {
    const budget = semanticBudget(timeoutOrBudget);
    await this.ensureStarted(budget);
    for (const file of files) {
      budget.throwIfExpired("diagnostics.open");
      await this.withDocument(file, async () => undefined);
    }
    if (waitMs > 0) {
      await budget.race("diagnostics.wait", delay(Math.min(waitMs, 10000)));
    }
    const result: Record<string, LspDiagnostic[]> = {};
    for (const file of files) {
      result[file] = this.diagnostics.get(toFileUri(file)) || [];
    }
    return result;
  }

  /** Task 33 hierarchy cutover: same-key callers share backend work while each caller settles against its own absolute deadline. */
  async callHierarchy(
    file: string,
    line: number,
    column: number,
    direction: "incoming" | "outgoing",
    depth: number,
    limit: number,
    budget: DeadlineBudget
  ): Promise<HierarchyResult> {
    const key: SemanticCacheKey<"callHierarchy"> = {
      repoHash: this.worktree.repoHash,
      generation: this.cacheGeneration,
      operation: "callHierarchy",
      file,
      fileFingerprint: fileFingerprint(file),
      line,
      column,
      optionsKey: `direction=${direction}&depth=${depth}&limit=${limit}`
    };
    const outcome = await this.semanticGateway.execute(key, budget, DEFAULT_LSP_REQUEST_TIMEOUT_MS);
    return {
      roots: [...outcome.value.roots],
      edges: [...outcome.value.edges],
      completion: outcome.completion,
      truncated: outcome.value.truncated,
      requests: outcome.value.requests,
      visited: outcome.value.visited,
      errorCode: outcome.errorCode
    };
  }

  /** Uncached primitive for SemanticGateway; see rawReferences. */
  async rawCallHierarchy(
    file: string,
    line: number,
    column: number,
    direction: "incoming" | "outgoing",
    depth: number,
    limit: number,
    budget: DeadlineBudget,
    signal?: AbortSignal
  ): Promise<HierarchyResult> {
    const method = direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
    return this.walkHierarchy({
      file,
      line,
      column,
      prepareMethod: "textDocument/prepareCallHierarchy",
      method,
      depth,
      limit,
      budget,
      signal,
      expand: (item, related) => (related as Array<{ from?: unknown; to?: unknown; fromRanges?: LspRange[] }>).map(call => {
        const next = direction === "incoming" ? call.from : call.to;
        return {
          next,
          edge: {
            from: direction === "incoming" ? next : item,
            to: direction === "incoming" ? item : next,
            ranges: call.fromRanges
          }
        };
      })
    });
  }

  /** Task 33 Step 7 cutover, hierarchy variant: see callHierarchy()'s doc comment. */
  async typeHierarchy(
    file: string,
    line: number,
    column: number,
    direction: "supertypes" | "subtypes",
    depth: number,
    limit: number,
    budget: DeadlineBudget
  ): Promise<HierarchyResult> {
    const key: SemanticCacheKey<"typeHierarchy"> = {
      repoHash: this.worktree.repoHash,
      generation: this.cacheGeneration,
      operation: "typeHierarchy",
      file,
      fileFingerprint: fileFingerprint(file),
      line,
      column,
      optionsKey: `direction=${direction}&depth=${depth}&limit=${limit}`
    };
    const outcome = await this.semanticGateway.execute(key, budget, DEFAULT_LSP_REQUEST_TIMEOUT_MS);
    return {
      roots: [...outcome.value.roots],
      edges: [...outcome.value.edges],
      completion: outcome.completion,
      truncated: outcome.value.truncated,
      requests: outcome.value.requests,
      visited: outcome.value.visited,
      errorCode: outcome.errorCode
    };
  }

  /** Uncached primitive for SemanticGateway; see rawReferences. */
  async rawTypeHierarchy(
    file: string,
    line: number,
    column: number,
    direction: "supertypes" | "subtypes",
    depth: number,
    limit: number,
    budget: DeadlineBudget,
    signal?: AbortSignal
  ): Promise<HierarchyResult> {
    const method = direction === "supertypes" ? "typeHierarchy/supertypes" : "typeHierarchy/subtypes";
    return this.walkHierarchy({
      file,
      line,
      column,
      prepareMethod: "textDocument/prepareTypeHierarchy",
      method,
      depth,
      limit,
      budget,
      signal,
      expand: (item, related) => (related as unknown[]).map(next => ({
        next,
        edge: {
          from: direction === "supertypes" ? item : next,
          to: direction === "supertypes" ? next : item
        }
      }))
    });
  }

  private async walkHierarchy(input: {
    file: string;
    line: number;
    column: number;
    prepareMethod: string;
    method: string;
    depth: number;
    limit: number;
    budget: DeadlineBudget;
    signal?: AbortSignal;
    expand: (item: unknown, related: unknown) => Array<{ next: unknown; edge: Omit<HierarchyEdge, "depth"> }>;
  }): Promise<HierarchyResult> {
    const edges: HierarchyEdge[] = [];
    const visited = new Set<string>();
    const maxDepth = Math.max(1, input.depth);
    const maxRequests = Math.min(Math.max(1, input.limit), MAX_HIERARCHY_REQUESTS);
    let requests = 0;

    const empty = (completion: Completion, errorCode?: JavaIntelligenceErrorCode): HierarchyResult => ({
      roots: [], edges, completion, truncated: false, requests, visited: visited.size, errorCode
    });

    let roots: unknown[];
    try {
      await this.ensureSemanticStarted(input.budget, input.signal, `${input.prepareMethod} startup`);
      roots = await this.withDocumentPosition(input.file, input.line, input.column, params =>
        this.request<unknown[]>(
          input.prepareMethod,
          params,
          Math.max(1, input.budget.remainingMs(HIERARCHY_PREPARE_CAP_MS)),
          input.signal
        )
      ) || [];
    } catch (error) {
      // A prepare that never answered means there is nothing to traverse.
      const classified = classifySemanticError(error);
      return empty(completionForError(classified.code), classified.code);
    }

    const queue = roots.map(item => ({ item, depth: 1 }));
    let limited = false;
    while (queue.length > 0) {
      if (edges.length >= input.limit || requests >= maxRequests) {
        limited = true;
        break;
      }
      const current = queue.shift()!;
      if (current.depth > maxDepth) {
        continue;
      }
      const key = hierarchyItemKey(current.item);
      if (!key || visited.has(key)) {
        continue;
      }
      visited.add(key);
      requests += 1;
      let related: unknown;
      try {
        related = await this.request<unknown[]>(
          input.method,
          { item: current.item },
          Math.max(1, input.budget.remainingMs(HIERARCHY_STEP_CAP_MS)),
          input.signal
        );
      } catch (error) {
        // Preserve what was already collected; classification decides whether
        // this is an expected bound or a genuine JDT fault.
        const classified = classifySemanticError(error);
        return {
          roots,
          edges,
          completion: completionForError(classified.code),
          truncated: true,
          requests,
          visited: visited.size,
          errorCode: classified.code
        };
      }
      for (const { next, edge } of input.expand(current.item, related ?? [])) {
        if (edges.length >= input.limit) {
          limited = true;
          break;
        }
        // Containment is applied before insertion so an out-of-repo type can
        // never enter the edge set or the traversal queue.
        if (!next || !this.isRepoHierarchyItem(next)) {
          continue;
        }
        edges.push({ depth: current.depth, ...edge });
        const nextKey = hierarchyItemKey(next);
        if (nextKey && !visited.has(nextKey)) {
          queue.push({ item: next, depth: current.depth + 1 });
        }
      }
    }

    const truncated = limited || edges.length >= input.limit;
    return {
      roots,
      edges,
      completion: truncated ? "PARTIAL_LIMIT" : "COMPLETE",
      truncated,
      requests,
      visited: visited.size
    };
  }

  private isRepoHierarchyItem(item: unknown): boolean {
    const location = hierarchyItemLocation(item);
    return Boolean(location && normalizeRepoLocation(this.repoRoot, location));
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

    const spawnStartedAt = performance.now();
    let attempt: JdtlsTransportAttempt;
    try {
      attempt = this.transportFactory.spawn({
        binary: this.jdtlsBin,
        args: this.launchArgs(),
        cwd: this.repoRoot,
        env: buildJdtlsEnv(this.jdtlsRuntimeJavaHome)
      });
    } finally {
      this.activeFirstTouchTrace?.recordStartupPhase("processSpawnCallMs", performance.now() - spawnStartedAt);
    }
    this.activeFirstTouchTrace?.recordPid(attempt.child.pid);
    this.startAttempt = attempt;
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

      this.process = attempt.child;
      this.connection = attempt.connection;
      this.startedAt = new Date();
      this.startAttempt = undefined;
      this.restartBackoff.recordReadyStarted();
      this.transition("READY");
      // The janitor's cross-process liveness check trusts a recorded jdtlsPid
      // as proof this worktree is in use; writing it before READY would let a
      // process that dies mid-STARTING leave a stale-but-plausible signal.
      touchRepoCache(this.repoRoot, { jdtlsPid: attempt.child.pid });
      this.armReadyStabilityReset(attempt);
    } catch (error) {
      const stoppedOrSuperseded =
        this.lifecycleState === "STOPPED"
        || (this.startAttempt !== attempt
          && (this.lifecycleState === "STARTING" || this.lifecycleState === "READY"));
      await this.disposeAttempt(attempt);
      if (this.startAttempt === attempt) this.startAttempt = undefined;
      if (this.process === attempt.child) this.process = undefined;
      if (this.connection === attempt.connection) this.connection = undefined;
      this.startedAt = undefined;
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
      // Identity guards: a stopped or superseded child's exit must never
      // overwrite the state of the session that replaced it.
      const ownsReadyProcess = this.process === attempt.child;
      const ownsStartingAttempt = this.startAttempt === attempt;
      if (!ownsReadyProcess && !ownsStartingAttempt) {
        return;
      }
      if (ownsReadyProcess) {
        if (this.readyStableTimer) {
          clearTimeout(this.readyStableTimer);
          this.readyStableTimer = undefined;
        }
        // A STARTING attempt's failure is recorded once by the shared start
        // promise catch, so only a READY child's death is counted here. The
        // same is true of the lease release: a STARTING attempt's failure
        // releases it through that same catch.
        this.restartBackoff.recordFailure("JDT_BROKEN");
        touchRepoCache(this.repoRoot, { jdtlsPid: undefined });
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
      if (this.lifecycleState !== "STOPPED") {
        this.transition("BROKEN");
      }
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
    try {
      attempt.connection.dispose();
    } catch {
      // Best-effort; the child is terminated regardless.
    }
    await terminateChild(attempt.child, 200);
  }

  private registerClientHandlers(connection: JdtlsConnection): void {
    connection.onRequest("client/registerCapability", async () => null);
    connection.onRequest("workspace/configuration", async (params: { items?: Array<{ section?: string }> }) => {
      const startedAt = performance.now();
      try {
        return (params.items || []).map(item => {
          if (!item.section || item.section === "java") {
            return this.javaSettings().java;
          }
          if (item.section.startsWith("java.")) {
            return pickSection(this.javaSettings().java, item.section.replace(/^java\./, ""));
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
      this.lastLanguageStatus = [params.type, params.message].filter(Boolean).join(": ");
      this.lastProgressAt = new Date();
    });
    connection.onError(error => {
      console.error("[codex-java-lsp] jsonrpc error", error);
    });
  }

  private initializeParams(): unknown {
    const rootUri = toFileUri(this.repoRoot);
    return {
      processId: process.pid,
      rootPath: this.repoRoot,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.repoRoot) || "java-worktree" }],
      capabilities: {
        workspace: {
          applyEdit: false,
          configuration: true,
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: false },
          symbol: { dynamicRegistration: false }
        },
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            didSave: false,
            willSave: false,
            willSaveWaitUntil: false
          },
          hover: { dynamicRegistration: false },
          definition: { dynamicRegistration: false, linkSupport: true },
          implementation: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          callHierarchy: { dynamicRegistration: false },
          typeHierarchy: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true }
        },
        window: { workDoneProgress: true },
        general: { positionEncodings: ["utf-16"] }
      },
      initializationOptions: {
        bundles: [],
        extendedClientCapabilities: {
          progressReportProvider: true,
          classFileContentsSupport: false,
          overrideMethodsPromptSupport: false,
          hashCodeEqualsPromptSupport: false
        },
        settings: this.javaSettings()
      }
    };
  }

  private javaSettings(): Record<string, unknown> {
    const runtime = this.projectJdk.resolvedHome && this.projectJdk.runtimeName
      ? [{ name: this.projectJdk.runtimeName, path: this.projectJdk.resolvedHome, default: true }]
      : [];
    const annotationProcessing = this.generatedCode.annotationProcessing.enabled;
    return {
      java: {
        import: {
          gradle: {
            enabled: this.buildSystem !== "maven",
            annotationProcessing: { enabled: annotationProcessing }
          },
          maven: {
            enabled: this.buildSystem === "maven"
          }
        },
        configuration: {
          updateBuildConfiguration: "automatic",
          runtimes: runtime
        },
        autobuild: {
          enabled: ["1", "on", "true"].includes(process.env.JAVA_LSP_AUTOBUILD?.toLowerCase() || "")
        },
        compile: {
          nullAnalysis: { mode: "disabled" }
        },
        maxConcurrentBuilds: positiveInteger(process.env.JAVA_LSP_IMPORT_CONCURRENCY, resourceDefaults().importConcurrency)
      }
    };
  }

  /**
   * Task 34: acquires a bounded, LRU-evicted lease for one file and releases
   * it once `action` settles, so a request never holds a document open past
   * its own lifetime. DocumentLru itself singleflights concurrent acquires
   * for the same uri (see its class doc) - the join Task 33 added here to
   * avoid a measured 1.4-1.6x three-repo P95 regression from duplicate
   * didOpen now lives there instead.
   */
  private async withDocument<T>(file: string, action: (uri: string) => Promise<T>): Promise<T> {
    const readStartedAt = performance.now();
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } finally {
      this.activeFirstTouchTrace?.recordDocumentRead(performance.now() - readStartedAt);
    }
    const synchronizeStartedAt = performance.now();
    let lease: Awaited<ReturnType<DocumentLru["acquire"]>>;
    try {
      lease = await this.documents.acquire(file, text);
    } finally {
      this.activeFirstTouchTrace?.recordDocumentSync(performance.now() - synchronizeStartedAt);
    }
    try {
      return await action(lease.uri);
    } finally {
      lease.release();
    }
  }

  private async withDocumentPosition<T>(
    file: string,
    line: number,
    column: number,
    action: (params: { textDocument: { uri: string }; position: { line: number; character: number } }) => Promise<T>
  ): Promise<T> {
    return this.withDocument(file, uri => action({
      textDocument: { uri },
      position: {
        line: Math.max(0, line - 1),
        character: Math.max(0, column - 1)
      }
    }));
  }

  private sourceTextForUri(uri: string): string | undefined {
    const opened = this.documents.textForUri(uri);
    if (opened !== undefined) {
      return opened;
    }
    const file = fromFileUri(uri);
    if (!file || !existsSync(file)) {
      return undefined;
    }
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      if (error instanceof Error) {
        return undefined;
      }
      throw error;
    }
  }

  private async request<T>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<T> {
    if (!this.connection) {
      throw new Error("JDT LS is not started.");
    }
    throwIfAborted(signal, method);
    const cancellation = new CancellationTokenSource();
    const startedAt = Date.now();
    const firstTouchTrace = this.activeFirstTouchTrace;
    const firstTouchOperationId = firstTouchTrace?.beginOperation(method);
    // Hold the raw promise so backend settlement can still be measured after the
    // client gives up, and so the timeout/cancel/server-error classification
    // below is never lost behind an undefined-on-any-failure return.
    const backend = this.connection.sendRequest(method, params, cancellation.token);
    let backendSettledAt: number | undefined;
    const markFulfilled = (): void => {
      backendSettledAt = Date.now();
      if (firstTouchOperationId !== undefined) {
        firstTouchTrace?.recordBackendSettlement(firstTouchOperationId, "fulfilled");
      }
    };
    const markRejected = (): void => {
      backendSettledAt = Date.now();
      if (firstTouchOperationId !== undefined) {
        firstTouchTrace?.recordBackendSettlement(firstTouchOperationId, "rejected");
      }
    };
    backend.then(markFulfilled, markRejected);

    let removeAbortListener: (() => void) | undefined;
    const abortableBackend = signal
      ? Promise.race([
          backend,
          new Promise<never>((_, reject) => {
            const onAbort = (): void => {
              if (firstTouchOperationId !== undefined) firstTouchTrace?.recordCancelSent(firstTouchOperationId);
              cancellation.cancel();
              reject(new JavaIntelligenceError("CANCELLED", `Cancelled during ${method}`));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            removeAbortListener = () => signal.removeEventListener("abort", onAbort);
          })
        ])
      : backend;

    let callerSettlement: MutableFirstTouchOperation["callerSettlement"] = "COMPLETE";
    try {
      return await withTimeout(abortableBackend, timeoutMs, method, () => {
        if (firstTouchOperationId !== undefined) firstTouchTrace?.recordCancelSent(firstTouchOperationId);
        cancellation.cancel();
      }) as T;
    } catch (error) {
      const code = classifySemanticError(error).code;
      callerSettlement = code === "DEADLINE_EXCEEDED"
        ? "DEADLINE_EXCEEDED"
        : code === "CANCELLED"
          ? "CANCELLED"
          : "FAILED";
      throw error;
    } finally {
      removeAbortListener?.();
      const clientCompletedAt = Date.now();
      if (firstTouchOperationId !== undefined) {
        firstTouchTrace?.recordCallerSettlement(firstTouchOperationId, callerSettlement);
      }
      this.addPhaseMetric(method, clientCompletedAt - startedAt);
      if (backendSettledAt === undefined) {
        // The user response is never blocked on this; it only records how long
        // JDT actually took to honour the cancellation.
        const recordOvershoot = (): void => {
          this.addPhaseMetric("cancelBackendSettlementMs", Date.now() - clientCompletedAt);
        };
        backend.then(recordOvershoot, recordOvershoot);
      }
      cancellation.dispose();
    }
  }

  private async cached<T>(
    method: string,
    parts: unknown[],
    dependencies: string[],
    compute: () => Promise<T>,
    shouldCache: (value: T) => boolean = () => true
  ): Promise<T> {
    if (DEFAULT_CACHE_TTL_MS <= 0) {
      return compute();
    }
    const normalizedDependencies = dependencies.map(file => path.normalize(file));
    const key = this.cacheKey(method, parts, normalizedDependencies);
    const now = Date.now();
    const existing = this.cache.get(key) as CacheEntry<T> | undefined;
    if (existing && existing.expiresAt > now) {
      this.cacheHits += 1;
      return existing.value;
    }
    if (existing) {
      this.cache.delete(key);
    }
    this.cacheMisses += 1;
    const value = await compute();
    if (!shouldCache(value)) {
      return value;
    }
    this.cache.set(key, {
      value,
      expiresAt: now + DEFAULT_CACHE_TTL_MS,
      dependencies: new Set(normalizedDependencies)
    });
    return value;
  }

  private cacheKey(method: string, parts: unknown[], dependencies: string[]): string {
    return JSON.stringify({
      method,
      parts,
      dependencies: dependencies.map(file => ({
        file,
        fingerprint: fileFingerprint(file)
      }))
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

  private clearCache(): void {
    if (this.cache.size > 0) {
      this.cacheInvalidations += this.cache.size;
      this.lastCacheInvalidatedAt = new Date();
    }
    this.cache.clear();
    this.invalidateSemanticGateway();
  }

  private invalidateSemanticGateway(): void {
    this.cacheGeneration += 1;
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

  private addPhaseMetric(name: string, elapsedMs: number): void {
    this.phaseMetrics[name] = (this.phaseMetrics[name] || 0) + elapsedMs;
  }

  /** Public for Task 35's first-touch benchmark, whose "progress-idle" prepare mode needs this wait without also issuing a documentSymbols request. */
  async waitForProgressIdle(maxWaitMs: number): Promise<void> {
    const idleMs = positiveInteger(process.env.JAVA_LSP_PROGRESS_IDLE_MS, 1500);
    const minimumWaitMs = positiveInteger(process.env.JAVA_LSP_MIN_SEMANTIC_WAIT_MS, 1000);
    const started = Date.now();
    const deadline = started + maxWaitMs;
    while (Date.now() < deadline) {
      const waited = Date.now() - started;
      const idleFor = this.lastProgressAt ? Date.now() - this.lastProgressAt.getTime() : waited;
      if (waited >= minimumWaitMs && this.activeProgress.size === 0 && idleFor >= idleMs) {
        return;
      }
      await delay(250);
    }
  }

}

function findExecutable(name: string): string {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(name)}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function watchedFileChange(change: RepoChange): { uri: string; type: number } | undefined {
  if (change.kind === "WATCHER_DEGRADED") return undefined;
  let type: number;
  if (change.kind === "JAVA_ADD") type = 1;
  else if (change.kind === "JAVA_DELETE") type = 3;
  else if (change.event === "add") type = 1;
  else if (change.event === "delete") type = 3;
  else type = 2;
  return { uri: toFileUri(change.absolutePath), type };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildJdtlsEnv(runtimeJavaHome?: string): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SHELL: process.env.SHELL,
    TMPDIR: process.env.TMPDIR,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    JAVA_HOME: runtimeJavaHome
  };
}

function jvmArgs(generatedCode: GeneratedCodeStatus): string[] {
  const args = [`--jvm-arg=-Xmx${process.env.JAVA_LSP_JDTLS_XMX || resourceDefaults().jdtlsXmx}`];
  if (generatedCode.lombok.agentEnabled && generatedCode.lombok.jar) {
    args.push(`--jvm-arg=-javaagent:${generatedCode.lombok.jar}`);
  }
  return args;
}

const LOMBOK_LOG_ANNOTATION = /@(?:[A-Za-z_$][\w$]*\.)*(?:Slf4j|XSlf4j|Log4j2?|CommonsLog|Flogger|JBossLog|Log)\b/;

export function filterGeneratedCodeDiagnostics(input: DiagnosticFilterInput): LspDiagnostic[] {
  if (!input.source || !hasLombokLogSource(input.generatedCode, input.source)) {
    return [...input.diagnostics];
  }
  const { source } = input;
  return input.diagnostics.filter(diagnostic => !isLombokLogUnresolvedDiagnostic(source, diagnostic));
}

function hasLombokLogSource(generatedCode: GeneratedCodeStatus, source: string): boolean {
  const lombokKnown = generatedCode.lombok.detected || /\blombok\.extern\./.test(source);
  return lombokKnown && LOMBOK_LOG_ANNOTATION.test(source);
}

function isLombokLogUnresolvedDiagnostic(source: string, diagnostic: LspDiagnostic): boolean {
  return tokenAt(source, diagnostic.range.start.line, diagnostic.range.start.character) === "log"
    && unresolvedLogMessage(diagnostic.message);
}

function unresolvedLogMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return /\blog\b.*\bcannot be resolved\b/.test(normalized)
    || /\bcannot resolve symbol\b[\s\S]*\blog\b/.test(normalized)
    || /\bcannot find symbol\b[\s\S]*\blog\b/.test(normalized);
}

function tokenAt(source: string, lineNumber: number, character: number): string | undefined {
  const line = source.split(/\r?\n/)[lineNumber];
  if (line === undefined) {
    return undefined;
  }
  return line.slice(Math.max(0, character)).match(/^[A-Za-z_$][\w$]*/)?.[0];
}

function pickSection(source: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }
    return null;
  }, source);
}

function splitArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(/\s+/).filter(Boolean);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function fileFingerprint(filePath: string): string {
  try {
    const stat = statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function normalizeLocations(value: unknown): Array<LspLocation | LspLocationLink> {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value as Array<LspLocation | LspLocationLink> : [value as LspLocation | LspLocationLink];
}

function truncate<T>(items: T[], limit: number): { items: T[]; truncated: boolean } {
  return {
    items: items.slice(0, limit),
    truncated: items.length > limit
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function measured<T>(value: T): TelemetryObservation<T> {
  return { status: "MEASURED", value };
}

function unmeasured<T = never>(reason: string): TelemetryObservation<T> {
  return { status: "UNMEASURED", reason };
}

function notApplicable<T = never>(reason: string): TelemetryObservation<T> {
  return { status: "NOT_APPLICABLE", reason };
}

function roundedMs(value: number): number {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

/** Stable identity for a hierarchy item, so a cycle is visited exactly once. */
function hierarchyItemKey(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as Record<string, unknown>;
  const uri = typeof value.uri === "string" ? value.uri : "";
  const name = typeof value.name === "string" ? value.name : "";
  const range = isLspRange(value.selectionRange)
    ? value.selectionRange
    : isLspRange(value.range)
      ? value.range
      : undefined;
  if (!uri || !range) return undefined;
  return `${uri}:${range.start.line}:${range.start.character}:${name}`;
}

function hierarchyItemLocation(item: unknown): LspLocation | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as { uri?: unknown; range?: unknown; selectionRange?: unknown };
  const range = isLspRange(record.selectionRange)
    ? record.selectionRange
    : isLspRange(record.range)
      ? record.range
      : undefined;
  return typeof record.uri === "string" && range ? { uri: record.uri, range } : undefined;
}

function isLspRange(value: unknown): value is LspRange {
  if (!value || typeof value !== "object") return false;
  const record = value as { start?: unknown; end?: unknown };
  return isLspPosition(record.start) && isLspPosition(record.end);
}

function isLspPosition(value: unknown): value is LspPosition {
  if (!value || typeof value !== "object") return false;
  const record = value as { line?: unknown; character?: unknown };
  return typeof record.line === "number" && typeof record.character === "number";
}

function completionForError(code: JavaIntelligenceErrorCode): Completion {
  if (code === "DEADLINE_EXCEEDED") return "PARTIAL_TIMEOUT";
  if (code === "CANCELLED") return "CANCELLED";
  return "FAILED";
}

async function terminateChild(child: JdtlsChild, graceMs: number): Promise<void> {
  // `child.killed` only records that kill() was called, so exit status is the
  // single source of truth for "the OS process is gone".
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  if (await settlesWithin(exited, graceMs)) {
    return;
  }
  child.kill("SIGKILL");
  await settlesWithin(exited, 1000);
}

function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    operation.then(() => {
      clearTimeout(timer);
      resolve(true);
    }, () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function classifyJdtStartError(error: unknown): JavaIntelligenceError {
  if (error instanceof JavaIntelligenceError) {
    return error;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
    return new JavaIntelligenceError("JDT_CONFIG_ERROR", message, error);
  }
  if (/connection.*(closed|disposed)|process.*exit|broken pipe|EPIPE/i.test(message)) {
    return new JavaIntelligenceError("JDT_BROKEN", message, error);
  }
  return new JavaIntelligenceError("JDT_SERVER_ERROR", message, error);
}

/**
 * Task 33 Step 6: SemanticGateway does not own JDT restart state - it only
 * reads it before creating a backend operation. This bridges the session's
 * existing (already-tested) restartBackoff.status() into the gateway's gate
 * contract. Cross-process lease busy-ness is deliberately NOT latched here:
 * "a rejected lease acquisition ... does not gate future retries" is an
 * existing, load-bearing jdtls-session.test.ts contract (another session may
 * release the lease at any moment), so JDT_BUSY_OTHER_SESSION is discovered
 * per-attempt through the normal execute()/classify path instead of a
 * pre-check, relying on the gateway's own singleflight to avoid redundant
 * concurrent lease attempts for the same key.
 */
export function lifecycleGateFromRestartBackoffStatus(
  status: JdtRestartBackoffStatus
): { allowed: true } | { allowed: false; code: "JDT_BACKOFF" | "JDT_CONFIG_ERROR"; message: string } {
  if (status.blockedUntilExplicitReset) {
    return {
      allowed: false,
      code: "JDT_CONFIG_ERROR",
      message: "JDT start is blocked until configuration changes or java_runtime(action=restart)"
    };
  }
  if (status.retryAfterMs !== undefined) {
    return {
      allowed: false,
      code: "JDT_BACKOFF",
      message: `JDT restart is backing off for ${status.retryAfterMs}ms`
    };
  }
  return { allowed: true };
}

/** Convenience for wiring: a lifecycleGate reading the session's live restartBackoff state on every check. */
export function semanticLifecycleGateFor(session: JdtlsSession): SemanticGatewayOptions["lifecycleGate"] {
  return () => lifecycleGateFromRestartBackoffStatus(session.status().restartBackoff);
}

function parseOptionsKey(optionsKey: string): URLSearchParams {
  return new URLSearchParams(optionsKey);
}

function requirePosition(line: number | undefined, column: number | undefined, operation: string): { line: number; column: number } {
  if (line === undefined || column === undefined) {
    throw new JavaIntelligenceError("INVALID_INPUT", `${operation} requires a line and column`);
  }
  return { line, column };
}

/**
 * Task 33 Step 7: the only production bridge from SemanticGateway's typed
 * operations to JdtlsSession's raw (uncached) request methods. Exhaustive
 * switch over SemanticOperation so an unhandled operation is a compile error,
 * not a silent runtime miss. Errors are intentionally left to propagate:
 * SemanticGateway's own catch path classifies and maps them (Step 5).
 */
export function createJdtlsSemanticBackend(session: JdtlsSession): SemanticBackend {
  return {
    async execute(key, timeoutMs, signal): Promise<SemanticBackendResult<SemanticBackendValue>> {
      const options = parseOptionsKey(key.optionsKey);
      const budget = DeadlineBudget.fromTimeout(timeoutMs);
      switch (key.operation) {
        case "hover": {
          const { line, column } = requirePosition(key.line, key.column, "hover");
          const value = await session.rawHover(key.file, line, column, budget, signal) as SemanticValueMap["hover"];
          return { completion: "COMPLETE", value };
        }
        case "definition": {
          const { line, column } = requirePosition(key.line, key.column, "definition");
          const value = await session.rawDefinition(key.file, line, column, budget, signal);
          return { completion: "COMPLETE", value };
        }
        case "implementation": {
          const { line, column } = requirePosition(key.line, key.column, "implementation");
          const value = await session.rawImplementation(key.file, line, column, budget, signal);
          return { completion: "COMPLETE", value };
        }
        case "references": {
          const { line, column } = requirePosition(key.line, key.column, "references");
          const includeDeclaration = options.get("includeDeclaration") === "true";
          const value = await session.rawReferences(key.file, line, column, includeDeclaration, budget, signal);
          return { completion: "COMPLETE", value };
        }
        case "documentSymbol": {
          const value = await session.rawDocumentSymbols(key.file, budget, signal);
          return { completion: "COMPLETE", value };
        }
        case "typeHierarchy": {
          const { line, column } = requirePosition(key.line, key.column, "typeHierarchy");
          const direction = options.get("direction") === "subtypes" ? "subtypes" : "supertypes";
          const depth = Number(options.get("depth") ?? "1");
          const limit = Number(options.get("limit") ?? "50");
          const result = await session.rawTypeHierarchy(key.file, line, column, direction, depth, limit, budget, signal);
          return {
            completion: result.completion,
            value: { roots: result.roots, edges: result.edges, truncated: result.truncated, requests: result.requests, visited: result.visited },
            errorCode: result.errorCode
          };
        }
        case "callHierarchy": {
          const { line, column } = requirePosition(key.line, key.column, "callHierarchy");
          const direction = options.get("direction") === "outgoing" ? "outgoing" : "incoming";
          const depth = Number(options.get("depth") ?? "1");
          const limit = Number(options.get("limit") ?? "50");
          const result = await session.rawCallHierarchy(key.file, line, column, direction, depth, limit, budget, signal);
          return {
            completion: result.completion,
            value: { roots: result.roots, edges: result.edges, truncated: result.truncated, requests: result.requests, visited: result.visited },
            errorCode: result.errorCode
          };
        }
      }
    }
  };
}

function semanticBudget(timeoutOrBudget: number | DeadlineBudget): DeadlineBudget {
  return timeoutOrBudget instanceof DeadlineBudget
    ? timeoutOrBudget
    : DeadlineBudget.fromTimeout(timeoutOrBudget);
}

function semanticOperationCap(
  timeoutOrBudget: number | DeadlineBudget,
  _budget: DeadlineBudget
): number {
  return typeof timeoutOrBudget === "number"
    ? timeoutOrBudget
    : DEFAULT_LSP_REQUEST_TIMEOUT_MS;
}

function throwIfAborted(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) {
    throw new JavaIntelligenceError("CANCELLED", `Cancelled before ${stage}`);
  }
}

async function waitForAbortSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  stage: string
): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal, stage);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new JavaIntelligenceError("CANCELLED", `Cancelled during ${stage}`));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function leaseAcquireResultToError(result: Exclude<JdtLeaseAcquireResult, { kind: "ACQUIRED" }>): JavaIntelligenceError {
  if (result.kind === "BUSY_SAME_WORKTREE") {
    return new JavaIntelligenceError(
      "JDT_BUSY_OTHER_SESSION",
      "Another codex-java-lsp process already runs JDT LS for this worktree."
    );
  }
  if (result.kind === "ORPHAN_JDT") {
    return new JavaIntelligenceError(
      "JDT_ORPHANED",
      `A previous session's JDT LS process (pid ${result.owner.jdtlsPid}) is still running for this worktree; `
      + "it must exit before a new one can start here."
    );
  }
  return new JavaIntelligenceError("JDT_NOT_READY", "No machine-wide JDT slot is available right now.");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onTimeout?: () => void): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

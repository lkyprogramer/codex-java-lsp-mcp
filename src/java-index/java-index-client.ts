import { Worker } from "node:worker_threads";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import type {
  AnchorFacts,
  IndexedReadRangeResult,
  IndexedReference,
  JavaFileBundle,
  JavaIndexStatus,
  JavaTypeFacts,
  JavaTypeLookupResult,
  StaticEdgeKind
} from "./index-types.js";
import type { MyBatisMapperResourceFacts } from "./mybatis-types.js";
import {
  isJavaIndexResponse,
  validateAnchorFacts,
  validateFileBundleArray,
  validateIndexedReadRangeResults,
  validateIndexedReferenceBatch,
  validateIndexedReferenceArray,
  validateJavaIndexStatus,
  validateMyBatisMapperResourceFacts,
  validateMyBatisResourceByNamespaceBatch,
  validateRepositoryFactMarkers,
  validateStringArray,
  validateTypeFactsArray,
  validateTypeLookup,
  validateTypeLookupArray,
  validateEntitySearchHits,
  validateGraphDigest,
  validateGraphReachable,
  validateContextGraphResult,
  JAVA_INDEX_CLOSE_GRACE_MS,
  type JavaIndexCommand,
  type JavaIndexRefreshPriority,
  type JavaIndexValueValidator,
  type JavaIndexWorkerTiming,
  type JavaIndexWorktreeIdentity,
  type GraphDigest,
  type GraphReachable,
  type ContextGraphResult,
  type MyBatisResourceByNamespaceBatch
} from "./worker-protocol.js";
import { ENTITY_SEARCH_DEFAULT_LIMIT, type EntityHit } from "./entity-search.js";

export type JavaIndexOpenOptions = {
  /** Absent => the worker never acquires a machine-level sweep lease. */
  leaseRoot?: string;
  worktree?: JavaIndexWorktreeIdentity;
  /** Absent => the worker never attempts a sibling-worktree snapshot seed (Task 21a), even with no own snapshot. */
  siblingCacheBase?: string;
};

/** Per-call control; omitted for non-request maintenance and legacy callers. */
export type JavaIndexRequestOptions = {
  budget?: DeadlineBudget;
  signal?: AbortSignal;
  telemetry?: JavaIndexRpcTelemetrySink;
};

export type JavaIndexRpcOperation = JavaIndexCommand["type"];
export type JavaIndexRpcOutcome = "completed" | "cancelled" | "deadlineExceeded" | "failed" | "retired";
export type JavaIndexWorkerRetireReason =
  | "DEADLINE_EXCEEDED"
  | "MALFORMED_RESPONSE"
  | "WORKER_ERROR"
  | "WORKER_EXIT"
  | "OPEN_FAILURE";

export type JavaIndexRpcSettlement = {
  operation: JavaIndexRpcOperation;
  outcome: JavaIndexRpcOutcome;
  callerWaitMs: number;
  outputJsonBytes?: number;
  workerTiming?: JavaIndexWorkerTiming;
  retireReason?: JavaIndexWorkerRetireReason;
};

export interface JavaIndexRpcTelemetrySink {
  requestStarted(event: { operation: JavaIndexRpcOperation; inputJsonBytes: number }): void;
  requestSettled(event: JavaIndexRpcSettlement): void;
  lateResponse(event: Omit<JavaIndexRpcSettlement, "outcome">): void;
}

export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  unref?(): void;
  terminate(): Promise<number>;
}

type PendingRequest = {
  operation: JavaIndexRpcOperation;
  postedAtMs: number;
  telemetry?: JavaIndexRpcTelemetrySink;
  validate: (value: unknown) => unknown;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanup(): void;
};

type CancelledTombstone = Pick<PendingRequest, "operation" | "postedAtMs" | "telemetry">;

export function isJavaIndexPrewarmReady(status: JavaIndexStatus): boolean {
  if (status.snapshotVerificationPending) return false;
  if (status.pendingBackground > 0) return false;
  if (status.snapshot?.state === "DURABLE") return true;
  return status.files > 0
    && status.coverage.length > 0
    && status.coverage.every(entry => entry.state === "COMPLETE" && entry.generation === status.indexedGeneration);
}

function emptyStatus(): JavaIndexStatus {
  return {
    state: "NEW",
    indexedGeneration: 0,
    files: 0,
    types: 0,
    methods: 0,
    edges: 0,
    snapshotBytes: 0,
    snapshot: { state: "EMPTY" },
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: [],
    resourceCoverage: []
  };
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./java-index-worker.js", import.meta.url)) as unknown as WorkerLike;
}

const MAX_CANCELLED_TOMBSTONES = 64;
/** Restart OPEN is shared and must outlive a short caller deadline (java_status ~2–3s). */
const JAVA_INDEX_RESTART_OPEN_MS = 120_000;
/** Mutating/long RPCs may mean a wedged worker; QUERY_* and STATUS only reject the caller. */
const RETIRE_ON_DEADLINE = new Set<JavaIndexCommand["type"]>([
  "OPEN",
  "REFRESH",
  "REFRESH_RESOURCES",
  "RECONCILE",
  "FLUSH",
  "HIBERNATE",
  "CLOSE"
]);

export class JavaIndexClient {
  private nextId = 1;
  private worker?: WorkerLike;
  private state: JavaIndexStatus["state"] = "NEW";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly cancelledTombstones = new Map<number, CancelledTombstone>();
  private readonly terminatedWorkers = new WeakSet<WorkerLike>();
  private restartCount = 0;
  private restarting?: Promise<JavaIndexStatus>;
  private lastKnownStatus: JavaIndexStatus = emptyStatus();
  private openOptions: JavaIndexOpenOptions = {};

  constructor(
    private readonly repoRoot: string,
    private readonly cacheDir: string,
    private readonly createWorker: () => WorkerLike = defaultWorkerFactory
  ) {}

  async open(
    generation: number,
    options: JavaIndexOpenOptions = {},
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<JavaIndexStatus> {
    if (this.worker || this.state !== "NEW") {
      throw new JavaIntelligenceError(
        "INDEX_PARTIAL",
        `Java index client cannot open from state ${this.state}`
      );
    }
    this.openOptions = options;
    return this.spawnAndOpen(generation, requestOptions);
  }

  async status(requestOptions: JavaIndexRequestOptions = {}): Promise<JavaIndexStatus> {
    await this.ensureOpen(requestOptions);
    const status = await this.request({ type: "STATUS" }, validateJavaIndexStatus, requestOptions);
    this.lastKnownStatus = status;
    return status;
  }

  async refresh(
    generation: number,
    changed: string[],
    deleted: string[],
    requestOptions: JavaIndexRequestOptions = {},
    priority?: JavaIndexRefreshPriority
  ): Promise<JavaIndexStatus> {
    if (priority === "ACTIVE_ANCHOR" && (changed.length !== 1 || deleted.length !== 0)) {
      throw new Error("ACTIVE_ANCHOR refresh requires exactly one changed file and no deletions");
    }
    await this.ensureOpen(requestOptions);
    const status = await this.request(
      { type: "REFRESH", generation, changed, deleted, ...(priority ? { priority } : {}) },
      validateJavaIndexStatus,
      requestOptions
    );
    this.lastKnownStatus = status;
    return status;
  }

  /**
   * Foreground upsert/delete for MyBatis mapper resource paths (Task 28
   * Slice B) - a separate call from `refresh` since resource facts carry no
   * Java-graph dependents to re-resolve and never touch Java root coverage.
   * `paths` is unclassified add/change/delete (RESOURCE_CHANGE does not
   * distinguish them at the coordinator layer); the worker resolves each via
   * a stat, idempotently.
   */
  async refreshResources(
    generation: number,
    paths: string[],
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<JavaIndexStatus> {
    if (paths.length === 0) return this.lastKnownStatus ?? await this.status(requestOptions);
    await this.ensureOpen(requestOptions);
    const status = await this.request(
      { type: "REFRESH_RESOURCES", generation, paths },
      validateJavaIndexStatus,
      requestOptions
    );
    this.lastKnownStatus = status;
    return status;
  }

  /**
   * Request-path foreground refresh for the given files at `generation`.
   * Empty input is a no-op so callers can always pair ensureFresh with a query.
   */
  async ensureFresh(
    files: string[],
    generation: number,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<void> {
    if (files.length === 0) return;
    await this.refresh(generation, files, [], requestOptions);
  }

  async reconcile(generation: number, requestOptions: JavaIndexRequestOptions = {}): Promise<JavaIndexStatus> {
    await this.ensureOpen(requestOptions);
    const status = await this.request({ type: "RECONCILE", generation }, validateJavaIndexStatus, requestOptions);
    this.lastKnownStatus = status;
    return status;
  }

  /** Poll STATUS until snapshot/coverage is usable, or the budget is spent. Does not throw on timeout. */
  async awaitPrewarmReady(requestOptions: JavaIndexRequestOptions = {}): Promise<JavaIndexStatus> {
    const budget = requestOptions.budget ?? DeadlineBudget.fromTimeout(60_000);
    let status = await this.status({ ...requestOptions, budget });
    while (!isJavaIndexPrewarmReady(status) && budget.remainingMs() > 50) {
      await new Promise<void>(resolve => {
        setTimeout(resolve, Math.min(250, budget.remainingMs(250)));
      });
      status = await this.status({ ...requestOptions, budget });
    }
    return status;
  }

  async flush(requestOptions: JavaIndexRequestOptions = {}): Promise<JavaIndexStatus> {
    await this.ensureOpen(requestOptions);
    const status = await this.request({ type: "FLUSH" }, validateJavaIndexStatus, requestOptions);
    this.lastKnownStatus = status;
    return status;
  }

  /** Unload facts/parse trees to the v4 files-only shape (M4 S4). Reheat is the next query. */
  async hibernate(requestOptions: JavaIndexRequestOptions = {}): Promise<JavaIndexStatus> {
    await this.ensureOpen(requestOptions);
    const status = await this.request({ type: "HIBERNATE" }, validateJavaIndexStatus, requestOptions);
    this.lastKnownStatus = status;
    return status;
  }

  async queryAnchor(
    file: string,
    line: number,
    column: number,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<AnchorFacts | undefined> {
    await this.ensureOpen(requestOptions);
    return this.request({ type: "QUERY_ANCHOR", file, line, column }, validateAnchorFacts, requestOptions);
  }

  async queryType(
    typeText: string,
    scopeFile?: string,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<JavaTypeLookupResult> {
    await this.ensureOpen(requestOptions);
    return this.request({ type: "QUERY_TYPE", typeText, scopeFile }, validateTypeLookup, requestOptions);
  }

  async queryTypes(
    queries: Array<{ typeText: string; scopeFile?: string }>,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<JavaTypeLookupResult[]> {
    await this.ensureOpen(requestOptions);
    if (queries.length === 0) return [];
    return this.request({ type: "QUERY_TYPES", queries }, validateTypeLookupArray, requestOptions);
  }

  async queryImplementers(
    typeId: string,
    limit: number,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<JavaTypeFacts[]> {
    await this.ensureOpen(requestOptions);
    return this.request({ type: "QUERY_IMPLEMENTERS", typeId, limit }, validateTypeFactsArray, requestOptions);
  }

  async queryTypeReferencers(
    typeId: string,
    edgeKinds: StaticEdgeKind[],
    limit: number,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<IndexedReference[]> {
    await this.ensureOpen(requestOptions);
    return this.request(
      { type: "QUERY_TYPE_REFERENCERS", typeId, edgeKinds, limit },
      validateIndexedReferenceArray,
      requestOptions
    );
  }

  async queryCallers(
    methodId: string,
    limit: number,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<IndexedReference[]> {
    await this.ensureOpen(requestOptions);
    return this.request({ type: "QUERY_CALLERS", methodId, limit }, validateIndexedReferenceArray, requestOptions);
  }

  async queryCallees(
    methodId: string,
    limit: number,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<IndexedReference[]> {
    await this.ensureOpen(requestOptions);
    return this.request({ type: "QUERY_CALLEES", methodId, limit }, validateIndexedReferenceArray, requestOptions);
  }

  async queryCalleesBatch(
    methodIds: string[],
    limit: number,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<Array<{ methodId: string; callees: IndexedReference[] }>> {
    await this.ensureOpen(requestOptions);
    if (methodIds.length === 0) return [];
    return this.request({ type: "QUERY_CALLEES_BATCH", methodIds, limit }, validateIndexedReferenceBatch, requestOptions);
  }

  async queryMethodsWithParameterTypes(
    typeIds: string[],
    limit: number,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<string[]> {
    await this.ensureOpen(requestOptions);
    if (typeIds.length === 0) return [];
    return this.request(
      { type: "QUERY_METHODS_WITH_PARAMETER_TYPES", typeIds, limit },
      validateStringArray,
      requestOptions
    );
  }

  async queryFiles(files: string[], requestOptions: JavaIndexRequestOptions = {}): Promise<JavaFileBundle[]> {
    await this.ensureOpen(requestOptions);
    return this.request({ type: "QUERY_FILES", files }, validateFileBundleArray, requestOptions);
  }

  async queryReadRanges(
    requests: Array<{ file: string; positions: Array<{ line: number; column: number }> }>,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<IndexedReadRangeResult[]> {
    await this.ensureOpen(requestOptions);
    if (requests.length === 0) return [];
    return this.request({ type: "QUERY_READ_RANGES", requests }, validateIndexedReadRangeResults, requestOptions);
  }

  async queryMyBatisResource(
    relativePath: string,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<MyBatisMapperResourceFacts | undefined> {
    await this.ensureOpen(requestOptions);
    return this.request(
      { type: "QUERY_MYBATIS_RESOURCE", relativePath },
      validateMyBatisMapperResourceFacts,
      requestOptions
    );
  }

  async queryMyBatisResourcesByNamespace(
    namespaces: string[],
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<MyBatisResourceByNamespaceBatch> {
    await this.ensureOpen(requestOptions);
    if (namespaces.length === 0) return [];
    return this.request(
      { type: "QUERY_MYBATIS_RESOURCES_BY_NAMESPACE", namespaces },
      validateMyBatisResourceByNamespaceBatch,
      requestOptions
    );
  }

  async queryGraphDigest(requestOptions: JavaIndexRequestOptions = {}): Promise<GraphDigest> {
    await this.ensureOpen(requestOptions);
    return this.request({ type: "QUERY_GRAPH_DIGEST" }, validateGraphDigest, requestOptions);
  }

  async queryGraphReachable(
    fromRelativePath: string,
    maxHops: number,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<GraphReachable> {
    await this.ensureOpen(requestOptions);
    return this.request(
      { type: "QUERY_GRAPH_REACHABLE", fromRelativePath, maxHops },
      validateGraphReachable,
      requestOptions
    );
  }

  async queryContextGraph(
    input: {
      fromRelativePath: string;
      intent: string;
      mode?: "search" | "navigate";
      direction?: "callers" | "callees";
      closure?: "persistence" | "framework";
      maxHops?: number;
      maxExpansions?: number;
      tokenBudget?: number;
      taskText?: string;
      profile?: string;
      plan?: boolean;
      includeSource?: boolean;
      anchorLine?: number;
      anchorColumn?: number;
      sessionId?: string;
      generation?: number;
      repoHash?: string;
    },
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<ContextGraphResult> {
    await this.ensureOpen(requestOptions);
    return this.request({ type: "QUERY_CONTEXT_GRAPH", ...input }, validateContextGraphResult, requestOptions);
  }

  async queryEntitySearch(
    task: string,
    limit = ENTITY_SEARCH_DEFAULT_LIMIT,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<EntityHit[]> {
    await this.ensureOpen(requestOptions);
    return this.request(
      { type: "QUERY_ENTITY_SEARCH", task, limit },
      validateEntitySearchHits,
      requestOptions
    );
  }

  async queryRepositoryFactMarkers(
    importPrefixes: string[],
    annotationPrefixes: string[],
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<{ importPrefixFound: boolean; annotationPrefixFound: boolean }> {
    await this.ensureOpen(requestOptions);
    return this.request(
      { type: "QUERY_REPOSITORY_FACT_MARKERS", importPrefixes, annotationPrefixes },
      validateRepositoryFactMarkers,
      requestOptions
    );
  }

  async close(): Promise<void> {
    if (this.state === "CLOSED") return;
    const worker = this.worker;
    if (!worker) {
      this.state = "CLOSED";
      this.lastKnownStatus = { ...this.lastKnownStatus, state: "CLOSED" };
      return;
    }
    const closed = new JavaIntelligenceError("INDEX_PARTIAL", "Java index client was closed");
    this.state = "CLOSED";
    this.lastKnownStatus = { ...this.lastKnownStatus, state: "CLOSED" };
    this.rejectAllPending(closed);
    const closeRequest = this.request({ type: "CLOSE" }, () => undefined);
    const settled = closeRequest.then(() => true, () => true);
    let graceTimer: NodeJS.Timeout | undefined;
    const acknowledged = await Promise.race([
      settled,
      new Promise<false>(resolve => {
        graceTimer = setTimeout(() => resolve(false), JAVA_INDEX_CLOSE_GRACE_MS);
      })
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    if (acknowledged) {
      await this.finishCloseWorker(worker, closed);
      return;
    }
    // Bound the caller-visible shutdown without killing native parse/fsync.
    // The wired listeners and CLOSE promise stay live; a late ACK/exit runs
    // the same idempotent terminal cleanup below.
    worker.unref?.();
    void settled.then(() => this.finishCloseWorker(worker, closed));
  }

  /** Synchronous, non-blocking snapshot of the last known status; never round-trips to the worker. */
  localStatus(): JavaIndexStatus {
    return { ...this.lastKnownStatus, state: this.state };
  }

  private async spawnAndOpen(
    generation: number,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<JavaIndexStatus> {
    const worker = this.wireWorker(this.createWorker());
    this.worker = worker;
    this.state = "OPENING";
    try {
      const status = await this.request(
        {
          type: "OPEN",
          repoRoot: this.repoRoot,
          cacheDir: this.cacheDir,
          generation,
          ...(this.openOptions.leaseRoot ? { leaseRoot: this.openOptions.leaseRoot } : {}),
          ...(this.openOptions.worktree ? { worktree: this.openOptions.worktree } : {}),
          ...(this.openOptions.siblingCacheBase ? { siblingCacheBase: this.openOptions.siblingCacheBase } : {})
        },
        validateJavaIndexStatus,
        requestOptions
      );
      this.state = status.state;
      this.lastKnownStatus = status;
      return status;
    } catch (error) {
      // A failed OPEN must not leave `this.worker` set: ensureOpen()'s fast
      // path only checks truthiness, so a wedged worker here would silently
      // swallow the one automatic restart and route every future request to
      // a thread that never finished opening.
      const failure = error instanceof Error ? error : new Error(String(error));
      this.retireWorker(worker, failure, "OPEN_FAILURE");
      throw error;
    }
  }

  /**
   * A worker exit only marks the client DEGRADED (see handleExit); it never
   * restarts inline, to avoid a restart loop racing a repeatedly-crashing
   * worker. The single automatic restart happens lazily here, on the next
   * request after the exit, and is spent at most once per client instance.
   */
  private async ensureOpen(requestOptions: JavaIndexRequestOptions = {}): Promise<void> {
    if (this.state === "CLOSED") {
      throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index client is closed");
    }
    if (this.worker) return;
    if (this.state === "NEW") {
      await this.spawnAndOpen(this.lastKnownStatus.indexedGeneration, requestOptions);
      return;
    }
    if (this.restartCount >= 1 && !this.restarting) {
      throw new JavaIntelligenceError(
        "INDEX_PARTIAL",
        "Java index worker is unavailable after one restart attempt"
      );
    }
    this.restarting ??= this.spawnAndOpen(
      this.lastKnownStatus.indexedGeneration,
      { budget: DeadlineBudget.fromTimeout(JAVA_INDEX_RESTART_OPEN_MS) }
    ).then(status => {
      this.restartCount += 1;
      return status;
    }).finally(() => {
      this.restarting = undefined;
    });
    if (requestOptions.budget) {
      try {
        await requestOptions.budget.race("java-index.open", this.restarting);
      } catch (error) {
        if (error instanceof JavaIntelligenceError && error.code === "DEADLINE_EXCEEDED") {
          throw new JavaIntelligenceError(
            "DEADLINE_EXCEEDED",
            "Deadline exceeded before/during java-index.open. This request's deadline was too short (java_status default is ~2–3s; java_impact deadlineMs max is 15000). Index OPEN continues in the background — retry the same tool without deadlineMs. Do not pass readPlanMaxItems>30 or deadlineMs>15000.",
            error
          );
        }
        throw error;
      }
      return;
    }
    await this.restarting;
  }

  private wireWorker(worker: WorkerLike): WorkerLike {
    worker.on("message", value => this.handleMessage(worker, value));
    worker.on("error", error => this.handleFatal(worker, error));
    worker.on("exit", code => this.handleExit(worker, code));
    return worker;
  }

  private request<T>(
    request: JavaIndexCommand,
    validate: JavaIndexValueValidator<T>,
    requestOptions: JavaIndexRequestOptions = {}
  ): Promise<T> {
    const worker = this.worker;
    if (!worker) {
      throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index worker is not open");
    }
    const stage = `java-index.${request.type.toLowerCase()}`;
    this.throwIfCancelledOrExpired(stage, requestOptions);
    const id = this.nextId++;
    const postedAtMs = performance.now();
    let abortListener: (() => void) | undefined;
    const operation = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        operation: request.type,
        postedAtMs,
        telemetry: requestOptions.telemetry,
        validate,
        resolve: value => resolve(value as T),
        reject,
        cleanup: () => {
          if (abortListener) requestOptions.signal?.removeEventListener("abort", abortListener);
        }
      });
    });
    if (requestOptions.signal) {
      abortListener = () => {
        this.rejectPending(id, new JavaIntelligenceError(
          "CANCELLED",
          `Java index request cancelled during ${stage}`
        ), "cancelled", undefined, true);
      };
      requestOptions.signal.addEventListener("abort", abortListener, { once: true });
      if (requestOptions.signal.aborted) {
        abortListener();
        return operation;
      }
    }
    const envelope = requestOptions.telemetry
      ? { ...request, id, telemetry: true as const }
      : { ...request, id };
    this.safeTelemetry(() => requestOptions.telemetry?.requestStarted({
      operation: request.type,
      inputJsonBytes: jsonBytes(envelope)
    }));
    worker.postMessage(envelope);
    if (!requestOptions.budget) return operation;
    return requestOptions.budget.race(stage, operation, undefined, () => {
      const error = new JavaIntelligenceError(
        "DEADLINE_EXCEEDED",
        `Deadline exceeded during ${stage}`
      );
      const retire = RETIRE_ON_DEADLINE.has(request.type);
      if (this.rejectPending(id, error, "deadlineExceeded", retire ? "DEADLINE_EXCEEDED" : undefined, true)) {
        if (retire) this.retireWorker(worker, error, "DEADLINE_EXCEEDED");
      }
    });
  }

  private handleMessage(worker: WorkerLike, value: unknown): void {
    if (this.worker !== worker) return;
    if (!isJavaIndexResponse(value)) {
      // No id to correlate on, so every in-flight request would otherwise
      // hang forever: treat a malformed envelope as fatal to the whole batch
      // and to the worker itself, since nothing further from it is trustworthy.
      const error = new JavaIntelligenceError(
        "INDEX_CORRUPT",
        "Java index worker sent a malformed response envelope"
      );
      this.retireWorker(worker, error, "MALFORMED_RESPONSE");
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) {
      const tombstone = this.cancelledTombstones.get(value.id);
      if (tombstone) {
        this.cancelledTombstones.delete(value.id);
        this.safeTelemetry(() => tombstone.telemetry?.lateResponse({
          operation: tombstone.operation,
          callerWaitMs: Math.max(0, performance.now() - tombstone.postedAtMs),
          outputJsonBytes: jsonBytes(value),
          workerTiming: value.timing
        }));
      }
      return;
    }
    this.pending.delete(value.id);
    pending.cleanup();
    if (value.ok) {
      try {
        const validated = pending.validate(value.value);
        this.recordSettlement(pending, "completed", value, value.timing);
        pending.resolve(validated);
      } catch (error) {
        this.markDegraded("Java index worker returned an invalid payload");
        this.recordSettlement(pending, "failed", value, value.timing, "MALFORMED_RESPONSE");
        pending.reject(new JavaIntelligenceError(
          "INDEX_CORRUPT",
          `Java index returned an invalid payload for ${pending.operation}`,
          error
        ));
      }
    } else {
      this.recordSettlement(
        pending,
        "failed",
        value,
        value.timing,
        pending.operation === "OPEN" ? "OPEN_FAILURE" : undefined
      );
      pending.reject(new JavaIntelligenceError(
        "INDEX_PARTIAL",
        `java index worker reported ${value.error.code}: ${value.error.message}`
      ));
    }
  }

  private handleFatal(worker: WorkerLike, error: Error): void {
    if (this.state === "CLOSED") {
      if (this.worker === worker) this.rejectAllPending(error, "retired", "WORKER_ERROR");
      return;
    }
    this.retireWorker(worker, error, "WORKER_ERROR");
  }

  private handleExit(worker: WorkerLike, code: number): void {
    if (this.worker !== worker) return;
    const error = new JavaIntelligenceError(
      "INDEX_PARTIAL",
      `Java index worker exited unexpectedly with code ${code}`
    );
    if (this.state === "CLOSED") {
      this.rejectAllPending(error, "retired", "WORKER_EXIT");
      return;
    }
    this.rejectAllPending(error, "retired", "WORKER_EXIT");
    this.worker = undefined;
    this.markDegraded(error.message);
  }

  private throwIfCancelledOrExpired(stage: string, requestOptions: JavaIndexRequestOptions): void {
    if (requestOptions.signal?.aborted) {
      throw new JavaIntelligenceError("CANCELLED", `Java index request cancelled before ${stage}`);
    }
    requestOptions.budget?.throwIfExpired(stage);
  }

  private rejectPending(
    id: number,
    error: Error,
    outcome: JavaIndexRpcOutcome = "failed",
    retireReason?: JavaIndexWorkerRetireReason,
    retainLateResponse = false
  ): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    pending.cleanup();
    this.recordSettlement(pending, outcome, undefined, undefined, retireReason);
    if (retainLateResponse) this.rememberCancelledTombstone(id, pending);
    pending.reject(error);
    return true;
  }

  /** Retire only for wedged mutating RPCs (OPEN/REFRESH/FLUSH/…); QUERY deadlines keep the worker. */
  private retireWorker(worker: WorkerLike, error: Error, reason: JavaIndexWorkerRetireReason): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.markDegraded(error.message);
    this.rejectAllPending(error, "retired", reason);
    this.cancelledTombstones.clear();
    void this.terminateWorker(worker);
  }

  private async terminateWorker(worker: WorkerLike): Promise<void> {
    if (this.terminatedWorkers.has(worker)) return;
    this.terminatedWorkers.add(worker);
    await worker.terminate().catch(() => undefined);
  }

  private async finishCloseWorker(worker: WorkerLike, closed: Error): Promise<void> {
    if (this.worker === worker) this.worker = undefined;
    this.rejectAllPending(closed);
    this.cancelledTombstones.clear();
    await this.terminateWorker(worker);
    this.state = "CLOSED";
    this.lastKnownStatus = { ...this.lastKnownStatus, state: "CLOSED" };
  }

  private markDegraded(reason: string): void {
    this.state = "DEGRADED";
    this.lastKnownStatus = { ...this.lastKnownStatus, state: "DEGRADED", lastError: reason };
  }

  private rejectAllPending(
    error: Error,
    outcome: JavaIndexRpcOutcome = "failed",
    retireReason?: JavaIndexWorkerRetireReason
  ): void {
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error, outcome, retireReason);
  }

  private recordSettlement(
    pending: PendingRequest,
    outcome: JavaIndexRpcOutcome,
    response?: unknown,
    workerTiming?: JavaIndexWorkerTiming,
    retireReason?: JavaIndexWorkerRetireReason
  ): void {
    this.safeTelemetry(() => pending.telemetry?.requestSettled({
      operation: pending.operation,
      outcome,
      callerWaitMs: Math.max(0, performance.now() - pending.postedAtMs),
      ...(response === undefined ? {} : { outputJsonBytes: jsonBytes(response) }),
      ...(workerTiming === undefined ? {} : { workerTiming }),
      ...(retireReason === undefined ? {} : { retireReason })
    }));
  }

  private rememberCancelledTombstone(id: number, pending: PendingRequest): void {
    if (this.cancelledTombstones.size >= MAX_CANCELLED_TOMBSTONES) {
      const oldest = this.cancelledTombstones.keys().next().value;
      if (typeof oldest === "number") this.cancelledTombstones.delete(oldest);
    }
    this.cancelledTombstones.set(id, {
      operation: pending.operation,
      postedAtMs: pending.postedAtMs,
      telemetry: pending.telemetry
    });
  }

  private safeTelemetry(action: () => void): void {
    try {
      action();
    } catch {
      // Diagnostic telemetry must never change request behavior.
    }
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

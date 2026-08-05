// input: Semantic (JDT-backed) read requests keyed by repo/generation/file/position.
// output: Deduplicated, complete-only-cached SemanticOutcome per caller.
// pos: Task 33. Sits between tool/provider callers and JdtlsSession's raw transport:
//      same-key concurrent requests join one backend call, only COMPLETE results are
//      cached, and a caller's own deadline never cancels work shared with another caller.
import { isCacheableCompletion, type Completion } from "./runtime/completion.js";
import type { DeadlineBudget } from "./runtime/deadline-budget.js";
import { classifySemanticError, type JavaIntelligenceErrorCode } from "./runtime/intelligence-error.js";
import type {
  HierarchyEdge,
  LspDocumentSymbol,
  LspLocation,
  LspLocationLink
} from "./jdtls-session.js";

export type SemanticOperation =
  | "hover"
  | "definition"
  | "implementation"
  | "references"
  | "documentSymbol"
  | "typeHierarchy"
  | "callHierarchy";

export type SemanticCacheKey<Operation extends SemanticOperation = SemanticOperation> = {
  repoHash: string;
  generation: number;
  operation: Operation;
  file: string;
  fileFingerprint: string;
  line?: number;
  column?: number;
  optionsKey: string;
};

export type SemanticOutcome<T> = {
  completion: Completion;
  value: T;
  elapsedMs: number;
  cacheHit: boolean;
  shared: boolean;
  errorCode?: JavaIntelligenceErrorCode;
};

export type SemanticBackendResult<T> = {
  completion: Completion;
  value: T;
  errorCode?: JavaIntelligenceErrorCode;
};

export type SemanticLocation = LspLocation | LspLocationLink;
export type SemanticHover = { contents: unknown; range?: LspLocation["range"] } | null;
export type SemanticHierarchy = {
  roots: readonly unknown[];
  edges: readonly HierarchyEdge[];
  truncated: boolean;
  requests: number;
  visited: number;
};

export type SemanticValueMap = {
  hover: SemanticHover;
  definition: readonly SemanticLocation[];
  implementation: readonly SemanticLocation[];
  references: readonly LspLocation[];
  documentSymbol: readonly LspDocumentSymbol[];
  typeHierarchy: SemanticHierarchy;
  callHierarchy: SemanticHierarchy;
};

export type SemanticBackendValue = SemanticValueMap[SemanticOperation];

export type SemanticBackend = {
  execute(
    key: SemanticCacheKey,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<SemanticBackendResult<SemanticBackendValue>>;
};

/**
 * Read before a backend operation is created (never before a cache hit or a
 * join onto an existing in-flight request). Lets the gateway skip JDT
 * entirely while Task 3's restart backoff or the cross-process lease is
 * blocking, without owning any restart state itself.
 */
export type SemanticLifecycleGate = () =>
  | { allowed: true }
  | {
      allowed: false;
      code: Extract<
        JavaIntelligenceErrorCode,
        "JDT_BACKOFF" | "JDT_CONFIG_ERROR" | "JDT_BUSY_OTHER_SESSION" | "JDT_NOT_READY"
      >;
      message: string;
    };

export type SemanticGatewayOptions = {
  ttlMs?: number;
  absoluteCapMs?: number;
  now?: () => number;
  lifecycleGate?: SemanticLifecycleGate;
};

export type SemanticGatewayStatus = {
  inflight: number;
  completedEntries: number;
  cacheHits: number;
  cacheMisses: number;
  sharedJoins: number;
  abortedNoWaiters: number;
  completeWrites: number;
  rejectedWrites: number;
  lifecycleBackoffSkips: number;
  busyOtherSessionSkips: number;
};

export interface SemanticGatewayApi {
  execute<Operation extends SemanticOperation>(
    key: SemanticCacheKey<Operation>,
    callerBudget: DeadlineBudget,
    operationCapMs: number
  ): Promise<SemanticOutcome<SemanticValueMap[Operation]>>;
  status(): SemanticGatewayStatus;
}

type BackendSettled<T> = {
  completion: Completion;
  value: T;
  elapsedMs: number;
  errorCode?: JavaIntelligenceErrorCode;
};

type InflightEntry = {
  controller: AbortController;
  promise: Promise<BackendSettled<SemanticBackendValue>>;
  waiters: number;
};

type CompletedEntry = {
  settled: BackendSettled<SemanticBackendValue>;
  expiresAtMs: number;
};

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_ABSOLUTE_CAP_MS = 20_000;
const ALWAYS_ALLOWED: SemanticLifecycleGate = () => ({ allowed: true });

/**
 * typeHierarchy/callHierarchy walk JDT step by step and, on the caller's own
 * deadline expiring mid-walk, RESOLVE with whatever edges were already
 * collected (completion PARTIAL_TIMEOUT) - see jdtls-hierarchy.test.ts's
 * "an expired hierarchy budget returns partial edges rather than throwing".
 * Every other operation's caller REJECTs on its own deadline instead
 * (`callerBudget.race()` below), which is correct when a backend call is
 * shared: one caller giving up must not cancel work another waiter still
 * needs. Those two contracts cannot both apply to one shared backend call -
 * a caller whose deadline just fired cannot both "get back partial edges"
 * and "not affect the other waiter". So these two operations skip
 * singleflight/join entirely: each call gets its own backend operation,
 * capped by the caller's own remaining budget, and the caller simply awaits
 * it to completion instead of racing a second, independent clock against it.
 * They still read and write the completed-at TTL cache like every other
 * operation - only the in-flight join is skipped.
 */
const NON_SHARED_OPERATIONS: ReadonlySet<SemanticOperation> = new Set(["typeHierarchy", "callHierarchy"]);

export class SemanticGateway implements SemanticGatewayApi {
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly completed = new Map<string, CompletedEntry>();
  private readonly ttlMs: number;
  private readonly absoluteCapMs: number;
  private readonly now: () => number;
  private readonly lifecycleGate: SemanticLifecycleGate;

  private cacheHits = 0;
  private cacheMisses = 0;
  private sharedJoins = 0;
  private abortedNoWaiters = 0;
  private completeWrites = 0;
  private rejectedWrites = 0;
  private lifecycleBackoffSkips = 0;
  private busyOtherSessionSkips = 0;

  constructor(
    private readonly backend: SemanticBackend,
    options: SemanticGatewayOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.absoluteCapMs = options.absoluteCapMs ?? DEFAULT_ABSOLUTE_CAP_MS;
    this.now = options.now ?? (() => Date.now());
    this.lifecycleGate = options.lifecycleGate ?? ALWAYS_ALLOWED;
  }

  async execute<Operation extends SemanticOperation>(
    key: SemanticCacheKey<Operation>,
    callerBudget: DeadlineBudget,
    operationCapMs: number
  ): Promise<SemanticOutcome<SemanticValueMap[Operation]>> {
    const cacheKey = serializeKey(key);
    const cachedEntry = this.completed.get(cacheKey);
    if (cachedEntry && cachedEntry.expiresAtMs > this.now()) {
      this.cacheHits += 1;
      return toOutcome(cachedEntry.settled, true, false) as SemanticOutcome<SemanticValueMap[Operation]>;
    }
    if (cachedEntry) this.completed.delete(cacheKey);
    this.cacheMisses += 1;

    if (NON_SHARED_OPERATIONS.has(key.operation)) {
      return this.executeUnshared(key, cacheKey, operationCapMs) as Promise<SemanticOutcome<SemanticValueMap[Operation]>>;
    }

    let entry = this.inflight.get(cacheKey);
    let shared = true;
    if (!entry) {
      const gate = this.lifecycleGate();
      if (!gate.allowed) {
        if (gate.code === "JDT_BACKOFF" || gate.code === "JDT_CONFIG_ERROR") {
          this.lifecycleBackoffSkips += 1;
        } else {
          this.busyOtherSessionSkips += 1;
        }
        return {
          completion: "FAILED",
          value: emptyValueFor(key.operation) as SemanticValueMap[Operation],
          elapsedMs: 0,
          cacheHit: false,
          shared: false,
          errorCode: gate.code
        };
      }
      shared = false;
      entry = this.createInflightEntry(key, cacheKey, operationCapMs);
    } else {
      this.sharedJoins += 1;
    }

    const activeEntry = entry;
    activeEntry.waiters += 1;
    try {
      const settled = await callerBudget.race(
        `semantic.${key.operation}`,
        activeEntry.promise,
        operationCapMs
      );
      return toOutcome(settled, false, shared) as SemanticOutcome<SemanticValueMap[Operation]>;
    } finally {
      activeEntry.waiters -= 1;
      if (activeEntry.waiters === 0 && this.inflight.get(cacheKey) === activeEntry) {
        this.abortedNoWaiters += 1;
        activeEntry.controller.abort();
      }
    }
  }

  /** See NON_SHARED_OPERATIONS: no join, no race - just cache read/write around one dedicated, caller-bounded backend call. */
  private async executeUnshared<Operation extends SemanticOperation>(
    key: SemanticCacheKey<Operation>,
    cacheKey: string,
    operationCapMs: number
  ): Promise<SemanticOutcome<SemanticValueMap[Operation]>> {
    const gate = this.lifecycleGate();
    if (!gate.allowed) {
      if (gate.code === "JDT_BACKOFF" || gate.code === "JDT_CONFIG_ERROR") {
        this.lifecycleBackoffSkips += 1;
      } else {
        this.busyOtherSessionSkips += 1;
      }
      return {
        completion: "FAILED",
        value: emptyValueFor(key.operation) as SemanticValueMap[Operation],
        elapsedMs: 0,
        cacheHit: false,
        shared: false,
        errorCode: gate.code
      };
    }
    const backendCapMs = Math.max(1, Math.min(operationCapMs, this.absoluteCapMs));
    const controller = new AbortController();
    const settled = await this.runBackend(key, backendCapMs, controller.signal);
    this.writeCache(cacheKey, settled);
    return toOutcome(settled, false, false) as SemanticOutcome<SemanticValueMap[Operation]>;
  }

  private createInflightEntry(
    key: SemanticCacheKey,
    cacheKey: string,
    operationCapMs: number
  ): InflightEntry {
    const controller = new AbortController();
    const backendCapMs = Math.max(1, Math.min(operationCapMs, this.absoluteCapMs));
    const promise = this.runBackend(key, backendCapMs, controller.signal);
    const entry: InflightEntry = { controller, promise, waiters: 0 };
    this.inflight.set(cacheKey, entry);
    promise.then(settled => {
      if (this.inflight.get(cacheKey) === entry) this.inflight.delete(cacheKey);
      this.writeCache(cacheKey, settled);
    });
    return entry;
  }

  private runBackend(
    key: SemanticCacheKey,
    backendCapMs: number,
    signal: AbortSignal
  ): Promise<BackendSettled<SemanticBackendValue>> {
    const startedAt = this.now();
    return this.backend.execute(key, backendCapMs, signal)
      .then((result): BackendSettled<SemanticBackendValue> => ({
        completion: result.completion,
        value: result.value,
        elapsedMs: this.now() - startedAt,
        errorCode: result.errorCode
      }))
      .catch((error: unknown): BackendSettled<SemanticBackendValue> => {
        const classified = classifySemanticError(error);
        return {
          completion: completionForCode(classified.code),
          value: emptyValueFor(key.operation) as SemanticBackendValue,
          elapsedMs: this.now() - startedAt,
          errorCode: classified.code
        };
      });
  }

  private writeCache(cacheKey: string, settled: BackendSettled<SemanticBackendValue>): void {
    if (!isCacheableCompletion(settled.completion)) {
      this.rejectedWrites += 1;
      return;
    }
    this.completeWrites += 1;
    this.completed.set(cacheKey, { settled, expiresAtMs: this.now() + this.ttlMs });
  }

  status(): SemanticGatewayStatus {
    return {
      inflight: this.inflight.size,
      completedEntries: this.completed.size,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      sharedJoins: this.sharedJoins,
      abortedNoWaiters: this.abortedNoWaiters,
      completeWrites: this.completeWrites,
      rejectedWrites: this.rejectedWrites,
      lifecycleBackoffSkips: this.lifecycleBackoffSkips,
      busyOtherSessionSkips: this.busyOtherSessionSkips
    };
  }
}

function serializeKey(key: SemanticCacheKey): string {
  return JSON.stringify([
    key.repoHash,
    key.generation,
    key.operation,
    key.file,
    key.fileFingerprint,
    key.line ?? null,
    key.column ?? null,
    key.optionsKey
  ]);
}

function toOutcome<T>(settled: BackendSettled<T>, cacheHit: boolean, shared: boolean): SemanticOutcome<T> {
  return {
    completion: settled.completion,
    value: settled.value,
    elapsedMs: settled.elapsedMs,
    cacheHit,
    shared,
    errorCode: settled.errorCode
  };
}

/** Mirrors jdtls-session.ts's local completionForError: only a defensive fallback for a backend that threw instead of returning a classified SemanticBackendResult. */
function completionForCode(code: JavaIntelligenceErrorCode): Completion {
  if (code === "DEADLINE_EXCEEDED") return "PARTIAL_TIMEOUT";
  if (code === "CANCELLED") return "CANCELLED";
  return "FAILED";
}

function emptyValueFor(operation: SemanticOperation): SemanticBackendValue {
  if (operation === "hover") return null;
  if (operation === "typeHierarchy" || operation === "callHierarchy") {
    return { roots: [], edges: [], truncated: false, requests: 0, visited: 0 };
  }
  return [];
}

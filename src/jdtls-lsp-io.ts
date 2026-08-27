// input: A live JDT LS connection plus document/request host state.
// output: Uncached raw LSP responses and process/path helpers for JdtlsSession.
// pos: Extracted from JdtlsSession so lifecycle does not own request I/O.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CancellationTokenSource } from "vscode-jsonrpc/node.js";
import type { JdtLeaseAcquireResult } from "./cross-process-lease.js";
import { DocumentLru } from "./document-lru.js";
import type { GeneratedCodeStatus } from "./generated-code.js";
import {
  JdtFirstTouchRecorder
} from "./jdtls-first-touch.js";
import {
  walkHierarchy as walkHierarchyGraph,
  type HierarchyResult
} from "./jdtls-hierarchy-walk.js";
import type {
  LspDiagnostic,
  LspDocumentSymbol,
  LspLocation,
  LspLocationLink,
  LspRange,
  LspSymbol
} from "./jdtls-lsp-types.js";
import type { JdtlsChild, JdtlsConnection } from "./jdtls-transport.js";
import { repoHash } from "./path-utils.js";
import type { RepoChange } from "./repo-generation.js";
import { fromFileUri, repoCacheBase, repoCacheRoot, resolveConfiguredBase, toFileUri } from "./repo-layout.js";
import type { RepoOwnerTransport } from "./repo-ownership-lease.js";
import { resourceDefaults } from "./resource-defaults.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import {
  classifySemanticError,
  JavaIntelligenceError
} from "./runtime/intelligence-error.js";
import type {
  SemanticCacheKey,
  SemanticGateway,
  SemanticValueMap
} from "./semantic-gateway.js";
import type { WorktreeIdentity } from "./worktree-identity.js";

export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = positiveInteger(process.env.JDTLS_REQUEST_TIMEOUT_MS, 120000);

export type JdtlsRuntimePaths = {
  cacheRoot: string;
  dataDir: string;
  logDir: string;
};

export type SemanticGenerationClock = {
  snapshot(): { value: number };
};

/**
 * Raw LSP + gateway-facing request methods extracted from JdtlsSession.
 * Lifecycle (start/stop/lease) stays on the subclass.
 */
export abstract class JdtlsLspClient {
  protected connection?: JdtlsConnection;
  protected documents!: DocumentLru;
  protected readonly diagnostics = new Map<string, LspDiagnostic[]>();
  protected worktree!: WorktreeIdentity;
  protected semanticGateway!: SemanticGateway;
  protected cacheGeneration = 1;
  protected generationClock?: SemanticGenerationClock;
  protected activeFirstTouchTrace?: JdtFirstTouchRecorder;
  protected lastProgressAt?: Date;
  protected readonly activeProgress = new Map<string, string>();
  protected phaseMetrics: Record<string, number> = {};

  protected constructor(protected readonly repoRoot: string) {}

  /**
   * Gateway-key generation. Coordinator GenerationClock is the only external
   * clock; the local counter is a fallback for standalone sessions/tests.
   */
  semanticGeneration(): number {
    return this.generationClock?.snapshot().value ?? this.cacheGeneration;
  }

  abstract ensureStarted(
    callerBudget?: DeadlineBudget
  ): Promise<void>;

  async workspaceSymbols(
    query: string,
    limit: number,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS
  ): Promise<{ items: LspSymbol[]; truncated: boolean }> {
    const budget = semanticBudget(timeoutOrBudget);
    const operationCapMs = semanticOperationCap(timeoutOrBudget, budget);
    budget.throwIfExpired("workspace/symbol");
    const key: SemanticCacheKey<"workspaceSymbol"> = {
      repoHash: this.worktree.repoHash,
      generation: this.semanticGeneration(),
      operation: "workspaceSymbol",
      file: "",
      fileFingerprint: "",
      optionsKey: `query=${encodeURIComponent(query)}&limit=${limit}`
    };
    const outcome = await this.semanticGateway.execute(key, budget, operationCapMs);
    if (outcome.completion !== "COMPLETE") {
      throw new JavaIntelligenceError(
        outcome.errorCode ?? "JDT_SERVER_ERROR",
        `workspace/symbol did not complete (completion=${outcome.completion})`
      );
    }
    return { items: [...outcome.value.items], truncated: outcome.value.truncated };
  }

  /** Uncached primitive for SemanticGateway; see rawReferences. */
  async rawWorkspaceSymbols(
    query: string,
    limit: number,
    timeoutOrBudget: number | DeadlineBudget = DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<{ items: LspSymbol[]; truncated: boolean }> {
    const budget = semanticBudget(timeoutOrBudget);
    await this.ensureSemanticStarted(budget, signal, "workspace/symbol startup");
    budget.throwIfExpired("workspace/symbol");
    const items = await this.request<LspSymbol[]>(
      "workspace/symbol",
      { query },
      Math.max(1, budget.remainingMs()),
      signal
    );
    return truncate(items || [], limit);
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
      generation: this.semanticGeneration(),
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

  protected async ensureSemanticStarted(
    budget: DeadlineBudget,
    signal: AbortSignal | undefined,
    stage: string
  ): Promise<void> {
    throwIfAborted(signal, stage);
    await waitForAbortSignal(this.ensureStarted(budget), signal, stage);
  }

  async documentSymbols(
    file: string,
    timeoutOrBudget: number | DeadlineBudget = 2000
  ): Promise<LspDocumentSymbol[]> {
    const budget = semanticBudget(timeoutOrBudget);
    const operationCapMs = semanticOperationCap(timeoutOrBudget, budget);
    const key: SemanticCacheKey<"documentSymbol"> = {
      repoHash: this.worktree.repoHash,
      generation: this.semanticGeneration(),
      operation: "documentSymbol",
      file,
      fileFingerprint: fileFingerprint(file),
      optionsKey: ""
    };
    const outcome = await this.semanticGateway.execute(key, budget, operationCapMs);
    if (outcome.completion !== "COMPLETE") {
      throw new JavaIntelligenceError(
        outcome.errorCode ?? "JDT_SERVER_ERROR",
        `textDocument/documentSymbol did not complete (completion=${outcome.completion})`
      );
    }
    return [...outcome.value];
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
      generation: this.semanticGeneration(),
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
      generation: this.semanticGeneration(),
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
    return walkHierarchyGraph(this.hierarchyHost(), {
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
      generation: this.semanticGeneration(),
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
    return walkHierarchyGraph(this.hierarchyHost(), {
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

  private hierarchyHost() {
    return {
      repoRoot: this.repoRoot,
      ensureSemanticStarted: (budget: DeadlineBudget, signal: AbortSignal | undefined, stage: string) =>
        this.ensureSemanticStarted(budget, signal, stage),
      withDocumentPosition: <T>(
        file: string,
        line: number,
        column: number,
        action: (params: { textDocument: { uri: string }; position: { line: number; character: number } }) => Promise<T>
      ) => this.withDocumentPosition(file, line, column, action),
      request: <T>(method: string, params?: unknown, timeoutMs?: number, signal?: AbortSignal) =>
        this.request<T>(method, params, timeoutMs, signal)
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
  protected async withDocument<T>(file: string, action: (uri: string) => Promise<T>): Promise<T> {
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

  protected async withDocumentPosition<T>(
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

  protected sourceTextForUri(uri: string): string | undefined {
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

  protected async request<T>(
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

    let callerSettlement: "COMPLETE" | "FAILED" | "CANCELLED" | "DEADLINE_EXCEEDED" = "COMPLETE";
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

  protected addPhaseMetric(name: string, elapsedMs: number): void {
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

export function findExecutable(name: string): string {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(name)}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function watchedFileChange(change: RepoChange): { uri: string; type: number } | undefined {
  if (change.kind === "WATCHER_DEGRADED") return undefined;
  let type: number;
  if (change.kind === "JAVA_ADD") type = 1;
  else if (change.kind === "JAVA_DELETE") type = 3;
  else if (change.event === "add") type = 1;
  else if (change.event === "delete") type = 3;
  else type = 2;
  return { uri: toFileUri(change.absolutePath), type };
}

export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildJdtlsEnv(runtimeJavaHome?: string): NodeJS.ProcessEnv {
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

/** Overrides Homebrew jdtls.py's hardcoded `-Xms1G`. Last `-Xms` on the Java command line wins. */
export const JDTLS_XMS = "256m";

export function jvmArgs(generatedCode: GeneratedCodeStatus): string[] {
  const args = [
    `--jvm-arg=-Xms${JDTLS_XMS}`,
    `--jvm-arg=-Xmx${process.env.JAVA_LSP_JDTLS_XMX || resourceDefaults().jdtlsXmx}`
  ];
  if (generatedCode.lombok.agentEnabled && generatedCode.lombok.jar) {
    args.push(`--jvm-arg=-javaagent:${generatedCode.lombok.jar}`);
  }
  return args;
}

export function splitArgs(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value.split(/\s+/).filter(Boolean);
}

export function positiveInteger(value: string | undefined, fallback: number): number {
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

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function terminateChild(child: JdtlsChild, graceMs: number): Promise<void> {
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

export function validateJdtlsTransportEnvironment(
  transportMode: RepoOwnerTransport,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.JAVA_LSP_CACHE_BASE) {
    resolveConfiguredBase(env.JAVA_LSP_CACHE_BASE, "JAVA_LSP_CACHE_BASE", env);
  }
  if (env.JAVA_LSP_OWNERSHIP_BASE) {
    resolveConfiguredBase(env.JAVA_LSP_OWNERSHIP_BASE, "JAVA_LSP_OWNERSHIP_BASE", env);
  }
  // Isolated validation always injects private JDTLS_* dirs. Those are harness
  // plumbing, not operator overrides, so HTTP mode must still initialize.
  if (
    transportMode === "streamable_http"
    && (env.JDTLS_DATA_DIR || env.JDTLS_LOG_DIR)
    && env.JAVA_LSP_ISOLATED_VALIDATION !== "1"
  ) {
    throw new Error("streamable_http mode rejects JDTLS_DATA_DIR/JDTLS_LOG_DIR; use JAVA_LSP_CACHE_BASE so every canonical repo gets its own workspace and logs.");
  }
  if (transportMode === "stdio") {
    if (env.JDTLS_DATA_DIR) {
      resolveConfiguredBase(env.JDTLS_DATA_DIR, "JDTLS_DATA_DIR", env);
    }
    if (env.JDTLS_LOG_DIR) {
      resolveConfiguredBase(env.JDTLS_LOG_DIR, "JDTLS_LOG_DIR", env);
    }
  }
  const extraArgs = (env.JDTLS_EXTRA_ARGS ?? "").split(/\s+/).filter(Boolean);
  if (extraArgs.some(arg => arg === "-data" || arg.startsWith("-data=") || arg.startsWith("--jvm-arg=-data"))) {
    throw new Error("JDTLS_EXTRA_ARGS must not override -data; repository workspaces are managed by codex-java-lsp.");
  }
}

export function resolveJdtlsRuntimePaths(
  repoRoot: string,
  transportMode: RepoOwnerTransport = "stdio",
  env: NodeJS.ProcessEnv = process.env
): JdtlsRuntimePaths {
  validateJdtlsTransportEnvironment(transportMode, env);
  const cacheRoot = repoCacheRoot(repoRoot, repoCacheBase(env));
  const hash = repoHash(repoRoot);
  const dataDir = transportMode === "stdio" && env.JDTLS_DATA_DIR
    ? path.join(resolveConfiguredBase(env.JDTLS_DATA_DIR, "JDTLS_DATA_DIR", env), hash)
    : path.join(cacheRoot, "workspace");
  const logDir = transportMode === "stdio" && env.JDTLS_LOG_DIR
    ? path.join(resolveConfiguredBase(env.JDTLS_LOG_DIR, "JDTLS_LOG_DIR", env), hash)
    : path.join(cacheRoot, "logs");
  return { cacheRoot, dataDir, logDir };
}

export async function forceTerminateJdtlsChild(child: JdtlsChild, deadlineMs = 1000): Promise<void> {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
    throw new Error(`Invalid JDT LS force-stop deadline: ${deadlineMs}`);
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGKILL");
  if (!await settlesWithin(closed, Math.floor(deadlineMs))) {
    throw new Error(`JDT LS child did not exit after SIGKILL within ${Math.floor(deadlineMs)}ms.`);
  }
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

export function leaseAcquireResultToError(result: Exclude<JdtLeaseAcquireResult, { kind: "ACQUIRED" }>): JavaIntelligenceError {
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

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onTimeout?: () => void): Promise<T> {
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

// input: MCP tool requests that need Java semantic information.
// output: Managed Eclipse JDT LS requests and normalized raw LSP responses.
// pos: Stateful LSP client and process manager for the generic Java LSP MCP bridge.
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CancellationTokenSource } from "vscode-jsonrpc/node.js";
import { JdtRestartBackoff, type JdtRestartBackoffStatus } from "./jdt-restart-backoff.js";
import {
  defaultJdtlsTransportFactory,
  type JdtlsChild,
  type JdtlsConnection,
  type JdtlsTransportAttempt,
  type JdtlsTransportFactory
} from "./jdtls-transport.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import { JavaIntelligenceError } from "./runtime/intelligence-error.js";
import {
  isFileWatchEnabled,
  JavaFileWatcher,
  WatchedFileChangeType,
  type FileWatcherStatus,
  type WatchedFileChange
} from "./file-watcher.js";
import { detectGeneratedCode, type GeneratedCodeStatus } from "./generated-code.js";
import { detectBuildSystem, resolveProjectJdk, type BuildSystem, type ProjectJdkStatus } from "./project-jdk.js";
import { fromFileUri, repoCacheRoot, toFileUri } from "./repo-layout.js";
import { resourceDefaults } from "./resource-defaults.js";
import { touchRepoCache } from "./worktree-cache-cleanup.js";

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

type OpenDocument = {
  version: number;
  text: string;
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
  fileWatcher: FileWatcherStatus;
  cache: JdtlsCacheStatus;
  buildSystem: BuildSystem;
  projectJdk: ProjectJdkStatus;
  generatedCode: GeneratedCodeStatus;
  progress: JdtlsProgressStatus;
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
  private readonly openDocuments = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly dataDir: string;
  private readonly logDir: string;
  private readonly logFile: string;
  private readonly jdtlsBin: string;
  private readonly buildSystem: BuildSystem;
  private readonly projectJdk: ProjectJdkStatus;
  private readonly generatedCode: GeneratedCodeStatus;
  private readonly jdtlsRuntimeJavaHome?: string;
  private fileWatcher?: JavaFileWatcher;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheInvalidations = 0;
  private lastCacheInvalidatedAt?: Date;
  private readonly activeProgress = new Map<string, string>();
  private lastProgressAt?: Date;
  private lastLanguageStatus?: string;
  private phaseMetrics: Record<string, number> = {};

  constructor(
    private readonly repoRoot: string,
    aliases: string[] = [],
    private readonly transportFactory: JdtlsTransportFactory = defaultJdtlsTransportFactory,
    now: () => number = Date.now
  ) {
    this.restartBackoff = new JdtRestartBackoff(now);
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
      openDocuments: this.openDocuments.size,
      startedAt: this.startedAt?.toISOString(),
      fileWatcher: this.fileWatcher?.status() ?? {
        enabled: isFileWatchEnabled(),
        active: false,
        watchedRoots: [],
        pendingChanges: 0,
        lastFlushSize: 0
      },
      cache: this.cacheStatus(),
      buildSystem: this.buildSystem,
      projectJdk: this.projectJdk,
      generatedCode: this.generatedCode,
      progress: this.progressStatus()
    };
  }

  onLifecycleChange(listener: LifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
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
        return;
      }
      const gate = this.restartBackoff.check();
      if (!gate.allowed) {
        throw new JavaIntelligenceError(
          gate.blockedUntilExplicitReset ? "JDT_CONFIG_ERROR" : "JDT_BACKOFF",
          gate.blockedUntilExplicitReset
            ? "JDT start is blocked until configuration changes or java_restart"
            : `JDT restart is backing off for ${gate.retryAfterMs}ms`
        );
      }
      let sharedStart = this.startPromise;
      if (!sharedStart) {
        this.transition("STARTING");
        // The start owns its own hard cap. A caller deadline only stops that
        // caller from waiting; it must never kill work shared with another caller.
        const startBudget = DeadlineBudget.fromTimeout(this.startHardCapMs);
        const created: Promise<void> = this.startTransactional(startBudget)
          .catch((error: unknown) => {
            const classified = classifyJdtStartError(error);
            if (this.lifecycleState !== "STOPPED") this.transition("BROKEN");
            this.restartBackoff.recordFailure(classified.code);
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
      if (this.stopPromise === operation) this.stopPromise = undefined;
    });
    this.stopPromise = operation;
    return operation;
  }

  private async stopInternal(): Promise<void> {
    // Transition first so an in-flight startTransactional sees STOPPED and
    // classifies its own failure as CANCELLED rather than a JDT fault.
    this.transition("STOPPED");
    this.stopFileWatcher();
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
    touchRepoCache(this.repoRoot);
    this.openDocuments.clear();
    this.diagnostics.clear();
  }

  async workspaceSymbols(query: string, limit: number): Promise<{ items: LspSymbol[]; truncated: boolean }> {
    return this.cached("workspaceSymbols", [query, limit], [], async () => {
      await this.ensureStarted();
      const items = await this.request<LspSymbol[]>("workspace/symbol", { query });
      return truncate(items || [], limit);
    });
  }

  async symbolContext(file: string, line: number, column: number, timeoutMs = DEFAULT_LSP_REQUEST_TIMEOUT_MS): Promise<{
    hover: unknown;
    definitions: Array<LspLocation | LspLocationLink>;
    implementations: Array<LspLocation | LspLocationLink>;
  }> {
    return this.cached("symbolContext", [file, line, column, timeoutMs], [file], async () => {
      await this.ensureStarted();
      const params = await this.textDocumentPositionParams(file, line, column) as Record<string, unknown>;
      const [hover, definitions, implementations] = await Promise.all([
        this.requestSettled<unknown>("textDocument/hover", params, timeoutMs),
        this.requestSettled<unknown>("textDocument/definition", params, timeoutMs),
        this.requestSettled<unknown>("textDocument/implementation", params, timeoutMs)
      ]);
      return {
        hover,
        definitions: normalizeLocations(definitions),
        implementations: normalizeLocations(implementations)
      };
    });
  }

  async semanticLocations(file: string, line: number, column: number, timeoutMs = DEFAULT_LSP_REQUEST_TIMEOUT_MS, includeImplementations = false): Promise<{
    definitions: Array<LspLocation | LspLocationLink>;
    implementations: Array<LspLocation | LspLocationLink>;
  }> {
    return this.cached("semanticLocations", [file, line, column, timeoutMs, includeImplementations], [file], async () => {
      await this.ensureStarted();
      const params = await this.textDocumentPositionParams(file, line, column) as Record<string, unknown>;
      const definitions = await this.requestSettled<unknown>("textDocument/definition", params, timeoutMs);
      const implementations = includeImplementations
        ? await this.requestSettled<unknown>("textDocument/implementation", params, timeoutMs)
        : undefined;
      return {
        definitions: normalizeLocations(definitions),
        implementations: normalizeLocations(implementations)
      };
    });
  }

  async documentSymbols(file: string, timeoutMs = 2000): Promise<LspDocumentSymbol[]> {
    return this.cached("documentSymbols", [file, timeoutMs], [file], async () => {
      await this.ensureStarted();
      const uri = await this.openDocument(file);
      const symbols = await this.request<LspDocumentSymbol[]>("textDocument/documentSymbol", {
        textDocument: { uri }
      }, timeoutMs);
      return symbols || [];
    });
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

  async references(file: string, line: number, column: number, includeDeclaration: boolean, timeoutMs = DEFAULT_LSP_REQUEST_TIMEOUT_MS): Promise<{
    items: LspLocation[];
    totalReferences: number;
    truncated: boolean;
  }> {
    return this.cached("references", [file, line, column, includeDeclaration, timeoutMs], [file], async () => {
      await this.ensureStarted();
      const params = await this.textDocumentPositionParams(file, line, column) as Record<string, unknown>;
      const items = await this.request<LspLocation[]>("textDocument/references", {
        ...params,
        context: { includeDeclaration }
      }, timeoutMs);
      const references = items || [];
      return {
        items: references,
        totalReferences: references.length,
        truncated: false
      };
    });
  }

  async diagnosticsFor(files: string[], waitMs: number): Promise<Record<string, LspDiagnostic[]>> {
    await this.ensureStarted();
    for (const file of files) {
      await this.openDocument(file);
    }
    if (waitMs > 0) {
      await delay(Math.min(waitMs, 10000));
    }
    const result: Record<string, LspDiagnostic[]> = {};
    for (const file of files) {
      result[file] = this.diagnostics.get(toFileUri(file)) || [];
    }
    return result;
  }

  async callHierarchy(
    file: string,
    line: number,
    column: number,
    direction: "incoming" | "outgoing",
    depth: number,
    limit: number
  ): Promise<{ roots: unknown[]; edges: HierarchyEdge[]; truncated: boolean }> {
    return this.cached("callHierarchy", [file, line, column, direction, depth, limit], [file], async () => {
      await this.ensureStarted();
      const params = await this.textDocumentPositionParams(file, line, column);
      const roots = await this.request<unknown[]>("textDocument/prepareCallHierarchy", params);
      const edges: HierarchyEdge[] = [];
      await this.walkCallHierarchy(roots || [], direction, Math.max(1, depth), 1, edges, limit);
      return { roots: roots || [], edges, truncated: edges.length >= limit };
    });
  }

  async typeHierarchy(
    file: string,
    line: number,
    column: number,
    direction: "supertypes" | "subtypes",
    depth: number,
    limit: number
  ): Promise<{ roots: unknown[]; edges: HierarchyEdge[]; truncated: boolean }> {
    return this.cached("typeHierarchy", [file, line, column, direction, depth, limit], [file], async () => {
      await this.ensureStarted();
      const params = await this.textDocumentPositionParams(file, line, column);
      const roots = await this.request<unknown[]>("textDocument/prepareTypeHierarchy", params);
      const edges: HierarchyEdge[] = [];
      await this.walkTypeHierarchy(roots || [], direction, Math.max(1, depth), 1, edges, limit);
      return { roots: roots || [], edges, truncated: edges.length >= limit };
    });
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

    await mkdir(this.dataDir, { recursive: true });
    await mkdir(this.logDir, { recursive: true });
    budget.throwIfExpired("jdtls.spawn");

    const attempt = this.transportFactory.spawn({
      binary: this.jdtlsBin,
      args: this.launchArgs(),
      cwd: this.repoRoot,
      env: buildJdtlsEnv(this.jdtlsRuntimeJavaHome)
    });
    this.startAttempt = attempt;
    this.registerClientHandlers(attempt.connection);
    attempt.connection.listen();
    this.attachAttemptLogging(attempt);
    touchRepoCache(this.repoRoot, { jdtlsPid: attempt.child.pid });

    try {
      const initializeResult = await budget.race(
        "jdtls.initialize",
        attempt.connection.sendRequest("initialize", this.initializeParams()),
        this.startHardCapMs,
        () => { void terminateChild(attempt.child, 200); }
      );
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
      attempt.connection.sendNotification("initialized", {});
      attempt.connection.sendNotification("workspace/didChangeConfiguration", {
        settings: this.javaSettings()
      });

      this.process = attempt.child;
      this.connection = attempt.connection;
      this.startedAt = new Date();
      await this.startFileWatcher();
      this.startAttempt = undefined;
      this.restartBackoff.recordReadyStarted();
      this.transition("READY");
      this.armReadyStabilityReset(attempt);
    } catch (error) {
      const stoppedOrSuperseded =
        this.lifecycleState === "STOPPED"
        || (this.startAttempt !== attempt
          && (this.lifecycleState === "STARTING" || this.lifecycleState === "READY"));
      this.stopFileWatcher();
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
      ...splitArgs(process.env.JDTLS_EXTRA_ARGS)
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
        this.stopFileWatcher();
        if (this.readyStableTimer) {
          clearTimeout(this.readyStableTimer);
          this.readyStableTimer = undefined;
        }
        // A STARTING attempt's failure is recorded once by the shared start
        // promise catch, so only a READY child's death is counted here.
        this.restartBackoff.recordFailure("JDT_BROKEN");
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
      return (params.items || []).map(item => {
        if (!item.section || item.section === "java") {
          return this.javaSettings().java;
        }
        if (item.section.startsWith("java.")) {
          return pickSection(this.javaSettings().java, item.section.replace(/^java\./, ""));
        }
        return null;
      });
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

  private async textDocumentPositionParams(file: string, line: number, column: number): Promise<unknown> {
    const uri = await this.openDocument(file);
    return {
      textDocument: { uri },
      position: {
        line: Math.max(0, line - 1),
        character: Math.max(0, column - 1)
      }
    };
  }

  private async openDocument(file: string): Promise<string> {
    const uri = toFileUri(file);
    const text = await readFile(file, "utf8");
    const existing = this.openDocuments.get(uri);
    if (!existing) {
      this.openDocuments.set(uri, { version: 1, text });
      this.connection?.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "java", version: 1, text }
      });
      return uri;
    }
    if (existing.text !== text) {
      const version = existing.version + 1;
      this.openDocuments.set(uri, { version, text });
      this.connection?.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }]
      });
    }
    return uri;
  }

  private sourceTextForUri(uri: string): string | undefined {
    const opened = this.openDocuments.get(uri)?.text;
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

  private async startFileWatcher(): Promise<void> {
    this.stopFileWatcher();
    const watcher = new JavaFileWatcher(this.repoRoot, {
      notifyChanges: changes => this.notifyWatchedFileChanges(changes),
      syncOpenDocument: change => this.syncOpenDocumentFromDisk(change)
    });
    this.fileWatcher = watcher;
    await watcher.start();
  }

  private stopFileWatcher(): void {
    this.fileWatcher?.close();
    this.fileWatcher = undefined;
  }

  private notifyWatchedFileChanges(changes: WatchedFileChange[]): void {
    if (!this.connection || changes.length === 0) {
      return;
    }
    this.invalidateCacheFor(changes.map(change => change.filePath));
    this.connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: changes.map(change => ({
        uri: change.uri,
        type: change.type
      }))
    });
  }

  private async syncOpenDocumentFromDisk(change: WatchedFileChange): Promise<void> {
    const existing = this.openDocuments.get(change.uri);
    if (!existing || !this.connection) {
      return;
    }

    if (change.type === WatchedFileChangeType.Deleted) {
      this.openDocuments.delete(change.uri);
      this.diagnostics.delete(change.uri);
      this.connection.sendNotification("textDocument/didClose", {
        textDocument: { uri: change.uri }
      });
      return;
    }

    if (!existsSync(change.filePath)) {
      return;
    }

    const text = await readFile(change.filePath, "utf8");
    if (existing.text === text) {
      return;
    }

    const version = existing.version + 1;
    this.openDocuments.set(change.uri, { version, text });
    this.connection.sendNotification("textDocument/didChange", {
      textDocument: { uri: change.uri, version },
      contentChanges: [{ text }]
    });
  }

  private async request<T>(method: string, params?: unknown, timeoutMs = DEFAULT_LSP_REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.connection) {
      throw new Error("JDT LS is not started.");
    }
    const cancellation = new CancellationTokenSource();
    const startedAt = Date.now();
    try {
      return await withTimeout(this.connection.sendRequest(method, params, cancellation.token), timeoutMs, method, () => cancellation.cancel()) as T;
    } finally {
      this.addPhaseMetric(method, Date.now() - startedAt);
      cancellation.dispose();
    }
  }

  private async requestSettled<T>(method: string, params?: unknown, timeoutMs = DEFAULT_LSP_REQUEST_TIMEOUT_MS): Promise<T | undefined> {
    try {
      return await this.request<T>(method, params, timeoutMs);
    } catch (error) {
      console.error(`[codex-java-lsp] ${method} failed`, error);
      return undefined;
    }
  }

  private async cached<T>(
    method: string,
    parts: unknown[],
    dependencies: string[],
    compute: () => Promise<T>
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

  private async waitForProgressIdle(maxWaitMs: number): Promise<void> {
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

  private async walkCallHierarchy(
    items: unknown[],
    direction: "incoming" | "outgoing",
    maxDepth: number,
    currentDepth: number,
    edges: HierarchyEdge[],
    limit: number
  ): Promise<void> {
    if (currentDepth > maxDepth || edges.length >= limit) {
      return;
    }
    for (const item of items) {
      if (edges.length >= limit) {
        return;
      }
      const method = direction === "incoming" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
      const calls = await this.requestSettled<Array<{ from?: unknown; to?: unknown; fromRanges?: LspRange[] }>>(method, { item });
      const nextItems: unknown[] = [];
      for (const call of calls || []) {
        if (edges.length >= limit) {
          break;
        }
        const from = direction === "incoming" ? call.from : item;
        const to = direction === "incoming" ? item : call.to;
        edges.push({ depth: currentDepth, from, to, ranges: call.fromRanges });
        if (direction === "incoming" && call.from) {
          nextItems.push(call.from);
        } else if (direction === "outgoing" && call.to) {
          nextItems.push(call.to);
        }
      }
      await this.walkCallHierarchy(nextItems, direction, maxDepth, currentDepth + 1, edges, limit);
    }
  }

  private async walkTypeHierarchy(
    items: unknown[],
    direction: "supertypes" | "subtypes",
    maxDepth: number,
    currentDepth: number,
    edges: HierarchyEdge[],
    limit: number
  ): Promise<void> {
    if (currentDepth > maxDepth || edges.length >= limit) {
      return;
    }
    const method = direction === "supertypes" ? "typeHierarchy/supertypes" : "typeHierarchy/subtypes";
    for (const item of items) {
      if (edges.length >= limit) {
        return;
      }
      const related = await this.requestSettled<unknown[]>(method, { item });
      for (const next of related || []) {
        if (edges.length >= limit) {
          break;
        }
        edges.push({
          depth: currentDepth,
          from: direction === "supertypes" ? item : next,
          to: direction === "supertypes" ? next : item
        });
      }
      await this.walkTypeHierarchy(related || [], direction, maxDepth, currentDepth + 1, edges, limit);
    }
  }
}

function findExecutable(name: string): string {
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(name)}`], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
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

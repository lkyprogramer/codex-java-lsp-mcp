import { Worker } from "node:worker_threads";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import type {
  AnchorFacts,
  IndexedReference,
  JavaFileBundle,
  JavaIndexStatus,
  JavaTypeFacts,
  JavaTypeLookupResult,
  StaticEdgeKind
} from "./index-types.js";
import {
  isJavaIndexResponse,
  validateAnchorFacts,
  validateFileBundleArray,
  validateIndexedReferenceArray,
  validateJavaIndexStatus,
  validateTypeFactsArray,
  validateTypeLookup,
  type JavaIndexCommand,
  type JavaIndexValueValidator
} from "./worker-protocol.js";

export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
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
    pendingForeground: 0,
    pendingBackground: 0,
    coverage: []
  };
}

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./java-index-worker.js", import.meta.url)) as unknown as WorkerLike;
}

export class JavaIndexClient {
  private nextId = 1;
  private worker?: WorkerLike;
  private state: JavaIndexStatus["state"] = "NEW";
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private restartCount = 0;
  private lastKnownStatus: JavaIndexStatus = emptyStatus();

  constructor(
    private readonly repoRoot: string,
    private readonly cacheDir: string,
    private readonly createWorker: () => WorkerLike = defaultWorkerFactory
  ) {}

  async open(generation: number): Promise<JavaIndexStatus> {
    if (this.worker || this.state !== "NEW") {
      throw new JavaIntelligenceError(
        "INDEX_PARTIAL",
        `Java index client cannot open from state ${this.state}`
      );
    }
    return this.spawnAndOpen(generation);
  }

  async status(): Promise<JavaIndexStatus> {
    await this.ensureOpen();
    const status = await this.request({ type: "STATUS" }, validateJavaIndexStatus);
    this.lastKnownStatus = status;
    return status;
  }

  async refresh(generation: number, changed: string[], deleted: string[]): Promise<JavaIndexStatus> {
    await this.ensureOpen();
    const status = await this.request(
      { type: "REFRESH", generation, changed, deleted },
      validateJavaIndexStatus
    );
    this.lastKnownStatus = status;
    return status;
  }

  async reconcile(generation: number): Promise<JavaIndexStatus> {
    await this.ensureOpen();
    const status = await this.request({ type: "RECONCILE", generation }, validateJavaIndexStatus);
    this.lastKnownStatus = status;
    return status;
  }

  async flush(): Promise<JavaIndexStatus> {
    await this.ensureOpen();
    const status = await this.request({ type: "FLUSH" }, validateJavaIndexStatus);
    this.lastKnownStatus = status;
    return status;
  }

  async queryAnchor(file: string, line: number, column: number): Promise<AnchorFacts | undefined> {
    await this.ensureOpen();
    return this.request({ type: "QUERY_ANCHOR", file, line, column }, validateAnchorFacts);
  }

  async queryType(typeText: string, scopeFile?: string): Promise<JavaTypeLookupResult> {
    await this.ensureOpen();
    return this.request({ type: "QUERY_TYPE", typeText, scopeFile }, validateTypeLookup);
  }

  async queryImplementers(typeId: string, limit: number): Promise<JavaTypeFacts[]> {
    await this.ensureOpen();
    return this.request({ type: "QUERY_IMPLEMENTERS", typeId, limit }, validateTypeFactsArray);
  }

  async queryTypeReferencers(
    typeId: string,
    edgeKinds: StaticEdgeKind[],
    limit: number
  ): Promise<IndexedReference[]> {
    await this.ensureOpen();
    return this.request(
      { type: "QUERY_TYPE_REFERENCERS", typeId, edgeKinds, limit },
      validateIndexedReferenceArray
    );
  }

  async queryCallers(methodId: string, limit: number): Promise<IndexedReference[]> {
    await this.ensureOpen();
    return this.request({ type: "QUERY_CALLERS", methodId, limit }, validateIndexedReferenceArray);
  }

  async queryCallees(methodId: string, limit: number): Promise<IndexedReference[]> {
    await this.ensureOpen();
    return this.request({ type: "QUERY_CALLEES", methodId, limit }, validateIndexedReferenceArray);
  }

  async queryFiles(files: string[]): Promise<JavaFileBundle[]> {
    await this.ensureOpen();
    return this.request({ type: "QUERY_FILES", files }, validateFileBundleArray);
  }

  async close(): Promise<void> {
    const worker = this.worker;
    if (!worker) {
      this.state = "CLOSED";
      this.lastKnownStatus = { ...this.lastKnownStatus, state: "CLOSED" };
      return;
    }
    try {
      await this.request({ type: "CLOSE" }, () => undefined);
    } catch {
      // best-effort: the worker may already be unresponsive; terminate regardless.
    }
    this.state = "CLOSED";
    this.lastKnownStatus = { ...this.lastKnownStatus, state: "CLOSED" };
    this.worker = undefined;
    this.rejectAllPending(new JavaIntelligenceError("INDEX_PARTIAL", "Java index client was closed"));
    await worker.terminate();
  }

  /** Synchronous, non-blocking snapshot of the last known status; never round-trips to the worker. */
  localStatus(): JavaIndexStatus {
    return { ...this.lastKnownStatus, state: this.state };
  }

  private async spawnAndOpen(generation: number): Promise<JavaIndexStatus> {
    const worker = this.wireWorker(this.createWorker());
    this.worker = worker;
    this.state = "OPENING";
    try {
      const status = await this.request(
        { type: "OPEN", repoRoot: this.repoRoot, cacheDir: this.cacheDir, generation },
        validateJavaIndexStatus
      );
      this.state = status.state;
      this.lastKnownStatus = status;
      return status;
    } catch (error) {
      // A failed OPEN must not leave `this.worker` set: ensureOpen()'s fast
      // path only checks truthiness, so a wedged worker here would silently
      // swallow the one automatic restart and route every future request to
      // a thread that never finished opening.
      this.worker = undefined;
      this.markDegraded(error instanceof Error ? error.message : String(error));
      await worker.terminate().catch(() => undefined);
      throw error;
    }
  }

  /**
   * A worker exit only marks the client DEGRADED (see handleExit); it never
   * restarts inline, to avoid a restart loop racing a repeatedly-crashing
   * worker. The single automatic restart happens lazily here, on the next
   * request after the exit, and is spent at most once per client instance.
   */
  private async ensureOpen(): Promise<void> {
    if (this.worker) return;
    if (this.state === "CLOSED") {
      throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index client is closed");
    }
    if (this.restartCount >= 1) {
      throw new JavaIntelligenceError(
        "INDEX_PARTIAL",
        "Java index worker is unavailable after one restart attempt"
      );
    }
    this.restartCount += 1;
    await this.spawnAndOpen(this.lastKnownStatus.indexedGeneration);
  }

  private wireWorker(worker: WorkerLike): WorkerLike {
    worker.on("message", value => this.handleMessage(value));
    worker.on("error", error => this.handleFatal(error));
    worker.on("exit", code => this.handleExit(code));
    return worker;
  }

  private request<T>(
    request: JavaIndexCommand,
    validate: JavaIndexValueValidator<T>
  ): Promise<T> {
    const worker = this.worker;
    if (!worker) {
      throw new JavaIntelligenceError("INDEX_PARTIAL", "Java index worker is not open");
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => {
          try {
            resolve(validate(value));
          } catch (error) {
            this.markDegraded("Java index worker returned an invalid payload");
            reject(new JavaIntelligenceError(
              "INDEX_CORRUPT",
              `Java index returned an invalid payload for ${request.type}`,
              error
            ));
          }
        },
        reject
      });
      worker.postMessage({ ...request, id });
    });
  }

  private handleMessage(value: unknown): void {
    if (!isJavaIndexResponse(value)) {
      // No id to correlate on, so every in-flight request would otherwise
      // hang forever: treat a malformed envelope as fatal to the whole batch
      // and to the worker itself, since nothing further from it is trustworthy.
      const error = new JavaIntelligenceError(
        "INDEX_CORRUPT",
        "Java index worker sent a malformed response envelope"
      );
      this.markDegraded(error.message);
      this.rejectAllPending(error);
      this.worker = undefined;
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    if (value.ok) {
      pending.resolve(value.value);
    } else {
      pending.reject(new JavaIntelligenceError(
        "INDEX_PARTIAL",
        `java index worker reported ${value.error.code}: ${value.error.message}`
      ));
    }
  }

  private handleFatal(error: Error): void {
    if (this.state === "CLOSED") return;
    this.markDegraded(`Java index worker error: ${error.message}`);
    this.rejectAllPending(error);
    this.worker = undefined;
  }

  private handleExit(code: number): void {
    if (this.state === "CLOSED") return;
    if (!this.worker) return; // already handled by handleFatal for this same crash
    const error = new JavaIntelligenceError(
      "INDEX_PARTIAL",
      `Java index worker exited unexpectedly with code ${code}`
    );
    this.rejectAllPending(error);
    this.worker = undefined;
    this.markDegraded(error.message);
  }

  private markDegraded(reason: string): void {
    this.state = "DEGRADED";
    this.lastKnownStatus = { ...this.lastKnownStatus, state: "DEGRADED", lastError: reason };
  }

  private rejectAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error);
    }
    this.pending.clear();
  }
}

// input: static discovery searches (db path, query, scope, absolute deadline).
// output: bounded DetailedEntitySearchResult rows computed off the main thread.
// pos: R09. Profile evidence (r09-task-result.md): a broad query at the
//      default posting budget blocks synchronous SQLite for 25-50ms, over the
//      20ms event-loop gate, and SQLite itself needs ~1us/posting. So ONE
//      shared read-only worker runs the scans: queue <= 32, one query at a
//      time (waiting exact lookups ahead of waiting broad scans), expired
//      waiters leave the queue without running SQL, and a query
//      stalled past its deadline + grace (between native steps) is
//      terminated; its result settles only after the thread (and its
//      connections) exited, and no second thread starts meanwhile. The worker
//      opens its own read-only connections and never shares the writer's.
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type {
  DetailedEntitySearchResult,
  EntitySearchMode,
  EntitySearchScope
} from "../java-index/entity-search.js";
import { classifyQuery } from "./query-intent.js";

export const QUERY_WORKER_QUEUE_MAX = 32;
/**
 * A query still running this long after its deadline is terminated. The
 * scan itself stops at the next row boundary; termination is the backstop
 * for JS-side stalls. node:sqlite (Node 22) has no interrupt/progress
 * handler, and Worker.terminate() only takes effect once a native SQLite
 * step returns, so a single long native step is NOT bounded by this grace.
 */
export const QUERY_WORKER_KILL_GRACE_MS = 250;
const QUERY_WORKER_ROLE = "java-static-query-worker";

export type QueryWorkerRequest = {
  dbPath: string;
  task: string;
  limit: number;
  mode: EntitySearchMode;
  scope?: EntitySearchScope;
  maxPostings?: number;
  /** Absolute deadline (performance.timeOrigin + performance.now() ms). */
  deadlineAt?: number;
  /** Close the worker's connection after this long without requests. */
  idleMs?: number;
  /** Test seam (honored only by pools built with allowTestHooks): busy-wait
   *  this long inside the worker before the scan while holding a read
   *  snapshot, i.e. a JS-side stall (a native SQLite step cannot be
   *  terminated mid-step, see QUERY_WORKER_KILL_GRACE_MS). */
  testBlockMs?: number;
};

export type QueryWorkerStats = {
  queued: number;
  running: boolean;
  queuePeak: number;
  completed: number;
  rejectedQueueFull: number;
  expiredInQueue: number;
  terminated: number;
  spawned: number;
  /** Live worker threads (0 or 1). */
  threads: number;
};

type Pending = {
  id: number;
  request: QueryWorkerRequest;
  /** An exact lookup: an index point read, served before waiting scans. */
  point: boolean;
  resolve: (result: DetailedEntitySearchResult) => void;
  reject: (error: Error) => void;
  expiry?: NodeJS.Timeout;
};

type WorkerReply =
  | { id: number; ok: true; result: DetailedEntitySearchResult }
  | { id: number; ok: false; error: string }
  | { released: number };

/** Same intent rule as the scan itself (searchDetailed); never throws. */
function isPointLookup(request: QueryWorkerRequest): boolean {
  try {
    return (request.mode === "auto" ? classifyQuery(request.task, request.mode) : request.mode) === "exact";
  } catch {
    return false; // classifyQuery rejects empty/oversized text: the scan answers it
  }
}

export function absoluteNow(): number {
  return performance.timeOrigin + performance.now();
}

function stoppedResult(stopReason: "deadline" | "queue_full"): DetailedEntitySearchResult {
  return { hits: [], truncated: true, selectionLimited: false, work: { postings: 0 }, generation: 0, stopReason, trace: [] };
}

export class QueryWorkerPool {
  private readonly queue: Pending[] = [];
  private running: Pending | undefined;
  private worker: Worker | undefined;
  private workerExited: Promise<void> | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private nextId = 1;
  private closed = false;
  // Pending release acks, per thread: a thread that exits settles only its own.
  private readonly releases = new Map<Worker, Map<number, () => void>>();
  // A thread being terminated is still alive (it may be finishing a native
  // step): no second thread is spawned until it has exited.
  private terminating: Promise<void> | undefined;
  private readonly counters = { queuePeak: 0, completed: 0, rejectedQueueFull: 0, expiredInQueue: 0, terminated: 0, spawned: 0 };

  constructor(private readonly options: { queueMax?: number; killGraceMs?: number; allowTestHooks?: boolean } = {}) {}

  isClosed(): boolean {
    return this.closed;
  }

  stats(): QueryWorkerStats {
    return {
      queued: this.queue.length,
      running: this.running !== undefined,
      ...this.counters,
      threads: (this.worker ? 1 : 0) + (this.terminating ? 1 : 0)
    };
  }

  /**
   * Resolves with a bounded result; never rejects for deadline or overload
   * (those are `stopReason`s). Rejects only for a worker failure.
   */
  search(request: QueryWorkerRequest): Promise<DetailedEntitySearchResult> {
    if (this.closed) return Promise.reject(new Error("query worker pool is closed"));
    if (request.deadlineAt !== undefined && absoluteNow() >= request.deadlineAt) return Promise.resolve(stoppedResult("deadline"));
    if (this.queue.length >= (this.options.queueMax ?? QUERY_WORKER_QUEUE_MAX)) {
      this.counters.rejectedQueueFull += 1;
      return Promise.resolve(stoppedResult("queue_full"));
    }
    return new Promise((resolve, reject) => {
      const pending: Pending = { id: this.nextId++, request, point: isPointLookup(request), resolve, reject };
      if (request.deadlineAt !== undefined) {
        // An expired waiter leaves the queue; it never reaches the worker.
        pending.expiry = setTimeout(() => {
          const index = this.queue.indexOf(pending);
          if (index < 0) return;
          this.queue.splice(index, 1);
          this.counters.expiredInQueue += 1;
          resolve(stoppedResult("deadline"));
          this.updateRef();
        }, Math.max(0, request.deadlineAt - absoluteNow()));
      }
      // Low-concurrency HOL fix: one thread, no preemption of the running
      // scan, but a waiting point lookup goes ahead of waiting scans (FIFO
      // within each class). A scan with a deadline cannot starve past it; one
      // without a deadline could in principle wait behind a steady stream of
      // point lookups (not a concern for a single-user server).
      const firstScan = pending.point ? this.queue.findIndex(waiting => !waiting.point) : -1;
      if (firstScan >= 0) this.queue.splice(firstScan, 0, pending);
      else this.queue.push(pending);
      this.counters.queuePeak = Math.max(this.counters.queuePeak, this.queue.length);
      this.pump();
    });
  }

  /** Restart queuePeak measurement (load steps report their own peak). */
  resetPeak(): void {
    this.counters.queuePeak = this.queue.length;
  }

  /**
   * Close the worker's cached connection for `dbPath` (repo close / idle
   * drop). Resolves once the worker closed it (after any scan already in
   * flight), or at once when no worker is alive.
   */
  release(dbPath: string): Promise<void> {
    const worker = this.worker;
    if (!worker || this.closed) return Promise.resolve();
    const id = this.nextId++;
    return new Promise(resolve => {
      const pending = this.releases.get(worker) ?? new Map<number, () => void>();
      pending.set(id, resolve);
      this.releases.set(worker, pending);
      worker.postMessage({ type: "release", dbPath, id });
      this.updateRef();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0)) {
      if (pending.expiry) clearTimeout(pending.expiry);
      pending.resolve(stoppedResult("deadline"));
    }
    await this.terminate();
    if (this.running) {
      this.running.resolve(stoppedResult("deadline"));
      this.running = undefined;
    }
  }

  private pump(): void {
    if (this.running || this.closed || this.terminating) {
      this.updateRef();
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      this.updateRef();
      return;
    }
    if (next.expiry) clearTimeout(next.expiry);
    if (next.request.deadlineAt !== undefined && absoluteNow() >= next.request.deadlineAt) {
      this.counters.expiredInQueue += 1;
      next.resolve(stoppedResult("deadline"));
      this.pump();
      return;
    }
    this.running = next;
    const worker = this.ensureWorker();
    const request = this.options.allowTestHooks ? next.request : { ...next.request, testBlockMs: undefined };
    worker.postMessage({ type: "search", id: next.id, request });
    if (next.request.deadlineAt !== undefined) {
      const killAfter = Math.max(0, next.request.deadlineAt - absoluteNow()) + (this.options.killGraceMs ?? QUERY_WORKER_KILL_GRACE_MS);
      this.killTimer = setTimeout(() => void this.killRunning(next), killAfter);
    }
    this.updateRef();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL(import.meta.url), { workerData: { role: QUERY_WORKER_ROLE } });
    this.counters.spawned += 1;
    this.worker = worker;
    this.workerExited = new Promise(resolve => worker.once("exit", () => resolve()));
    worker.on("message", (reply: WorkerReply) => this.onReply(worker, reply));
    worker.on("error", error => this.onWorkerGone(worker, error));
    worker.on("exit", code => this.onWorkerGone(worker, new Error(`query worker exited with code ${code}`)));
    return worker;
  }

  private onReply(worker: Worker, reply: WorkerReply): void {
    if ("released" in reply) {
      const pending = this.releases.get(worker);
      pending?.get(reply.released)?.();
      pending?.delete(reply.released);
      if (pending?.size === 0) this.releases.delete(worker);
      this.updateRef();
      return;
    }
    const current = this.running;
    if (!current || current.id !== reply.id) return;
    this.clearKillTimer();
    this.running = undefined;
    this.counters.completed += 1;
    if (reply.ok) current.resolve(reply.result);
    else current.reject(new Error(reply.error));
    this.pump();
  }

  private onWorkerGone(worker: Worker, error: Error): void {
    this.settleReleases(worker);
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.clearKillTimer();
    const current = this.running;
    this.running = undefined;
    current?.reject(error);
    this.pump();
  }

  // The deadline passed and the worker is still inside one statement:
  // terminate it. The request settles only after the thread exited, so its
  // read snapshot and connections are gone; the next request respawns.
  private async killRunning(pending: Pending): Promise<void> {
    if (this.running !== pending) return;
    this.counters.terminated += 1;
    this.running = undefined;
    await this.terminate();
    pending.resolve(stoppedResult("deadline"));
    this.pump();
  }

  private async terminate(): Promise<void> {
    this.clearKillTimer();
    const worker = this.worker;
    const exited = this.workerExited;
    this.worker = undefined;
    this.workerExited = undefined;
    if (!worker) return;
    const done = (async () => {
      await worker.terminate();
      await exited;
      this.settleReleases(worker);
    })();
    this.terminating = done;
    try {
      await done;
    } finally {
      if (this.terminating === done) this.terminating = undefined;
    }
  }

  // A gone thread holds no connection: its pending releases are done.
  private settleReleases(worker: Worker): void {
    const pending = this.releases.get(worker);
    if (!pending) return;
    for (const resolve of pending.values()) resolve();
    this.releases.delete(worker);
  }

  private clearKillTimer(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = undefined;
  }

  // An idle worker never keeps the process alive; a busy one does.
  private updateRef(): void {
    if (!this.worker) return;
    if (this.running || this.queue.length > 0 || this.releases.has(this.worker)) this.worker.ref();
    else this.worker.unref();
  }
}

let shared: QueryWorkerPool | undefined;

/** The process-wide static query worker (one thread for every repository). */
export function sharedQueryWorker(): QueryWorkerPool {
  if (!shared || shared.isClosed()) shared = new QueryWorkerPool();
  return shared;
}

// ---------------------------------------------------------------- worker side

async function runWorker(): Promise<void> {
  const { openIndexDb, close } = await import("../java-index/sql/driver.js");
  const { SqlEntitySearch } = await import("../java-index/sql/entity-search.js");
  type Conn = { db: ReturnType<typeof openIndexDb>; search: InstanceType<typeof SqlEntitySearch>; identity: string; idle?: NodeJS.Timeout };
  const conns = new Map<string, Conn>();
  const drop = (dbPath: string) => {
    const conn = conns.get(dbPath);
    if (!conn) return;
    if (conn.idle) clearTimeout(conn.idle);
    conns.delete(dbPath);
    close(conn.db);
  };
  // A rebuilt or replaced index file is a new inode: never keep reading the
  // old one.
  const identityOf = (dbPath: string) => {
    const stat = statSync(dbPath);
    return `${stat.dev}:${stat.ino}`;
  };
  const connFor = (dbPath: string): Conn => {
    const identity = identityOf(dbPath);
    const cached = conns.get(dbPath);
    if (cached && cached.identity === identity) return cached;
    if (cached) drop(dbPath);
    const db = openIndexDb(dbPath, { readOnly: true });
    const conn: Conn = { db, search: new SqlEntitySearch(db), identity };
    conns.set(dbPath, conn);
    return conn;
  };
  parentPort!.on("message", (message: { type: "search"; id: number; request: QueryWorkerRequest } | { type: "release"; dbPath: string; id: number }) => {
    if (message.type === "release") {
      drop(message.dbPath);
      parentPort!.postMessage({ released: message.id } satisfies WorkerReply);
      return;
    }
    const { id, request } = message;
    try {
      const conn = connFor(request.dbPath);
      if (request.testBlockMs) {
        // Hold a read snapshot while "stuck", as a long statement would.
        conn.db.exec("BEGIN");
        conn.db.prepare("SELECT count(*) AS n FROM entity").get();
        const until = absoluteNow() + request.testBlockMs;
        while (absoluteNow() < until) { /* simulated JS-side stall */ }
        conn.db.exec("COMMIT");
      }
      if (conn.idle) clearTimeout(conn.idle);
      const deadlineAt = request.deadlineAt;
      const result = conn.search.searchDetailed(request.task, request.limit, request.mode, {
        scope: request.scope,
        budget: {
          maxPostings: request.maxPostings,
          remainingMs: deadlineAt === undefined ? () => Number.POSITIVE_INFINITY : () => deadlineAt - absoluteNow()
        }
      });
      if (request.idleMs && request.idleMs > 0) {
        conn.idle = setTimeout(() => drop(request.dbPath), request.idleMs);
        conn.idle.unref();
      }
      parentPort!.postMessage({ id, ok: true, result } satisfies WorkerReply);
    } catch (error) {
      parentPort!.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies WorkerReply);
    }
  });
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === QUERY_WORKER_ROLE) {
  void runWorker();
}

// input: static discovery searches (db path, query, scope, absolute deadline).
// output: bounded DetailedEntitySearchResult rows computed off the main thread.
// pos: R09. Profile evidence (r09-task-result.md): a broad query at the
//      default posting budget blocks synchronous SQLite for 25-50ms, over the
//      20ms event-loop gate, and SQLite itself needs ~1us/posting. So the shared
//      read-only pool defaults to one reader (explicit experiment: two),
//      queue <= 32 globally, one query per reader at a
//      time (waiting exact lookups ahead of waiting broad scans), expired
//      waiters leave the queue without running SQL, and a query
//      stalled past its deadline + grace (between native steps) is
//      terminated; its result settles only after the thread (and its
//      connections) exited, and its slot cannot be reused meanwhile. The worker
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
  /** Live worker threads, including terminating threads (0..workerCount). */
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
  dispatchedAt?: number;
  workerSlot?: number;
  workerStartedAt?: number;
  workerFinishedAt?: number;
};

type WorkerReply =
  | { id: number; ok: true; result: DetailedEntitySearchResult; workerStartedAt: number; workerFinishedAt: number }
  | { id: number; ok: false; error: string; workerStartedAt: number; workerFinishedAt: number }
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

export type QueryWorkerTiming = {
  id: number;
  request: QueryWorkerRequest;
  queuedMs: number;
  enqueueAt: number;
  dispatchedAt: number | null;
  settledAt: number;
  workerStartedAt: number | null;
  workerFinishedAt: number | null;
  actualServiceMs: number | null;
  /** Dispatch to settlement, including worker startup and termination. */
  dispatchReplyMs: number;
  totalMs: number;
  started: boolean;
  workerSlot?: number;
  outcome: "completed" | "deadline" | "queue_full" | "error" | "closed";
};
export type QueryWorkerOptions = {
  workerCount?: 1 | 2;
  queueMax?: number;
  killGraceMs?: number;
  allowTestHooks?: boolean;
  onTiming?: (timing: QueryWorkerTiming) => void;
};
type Slot = {
  worker?: Worker;
  exited?: Promise<void>;
  running?: Pending;
  killTimer?: NodeJS.Timeout;
  terminating?: Promise<void>;
};

export class QueryWorkerPool {
  private readonly queue: Pending[] = [];
  private readonly slots: Slot[];
  private nextId = 1;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly releases = new Map<Worker, Map<number, () => void>>();
  private readonly counters = { queuePeak: 0, completed: 0, rejectedQueueFull: 0, expiredInQueue: 0, terminated: 0, spawned: 0 };

  private readonly options: QueryWorkerOptions;

  constructor(options: QueryWorkerOptions = {}) {
    this.options = { ...options };
    if (options.workerCount !== undefined && options.workerCount !== 1 && options.workerCount !== 2) {
      throw new Error("query workerCount must be 1 or 2");
    }
    if (options.queueMax !== undefined && (!Number.isInteger(options.queueMax) || options.queueMax < 1 || options.queueMax > QUERY_WORKER_QUEUE_MAX)) {
      throw new Error("query queueMax must be 1..32");
    }
    this.slots = Array.from({ length: options.workerCount ?? 1 }, () => ({}));
  }

  /** True only after close has settled every thread and request. */
  isClosed(): boolean { return this.closed && this.slots.every(slot => !slot.worker && !slot.terminating && !slot.running); }

  stats(): QueryWorkerStats {
    return { queued: this.queue.length, running: this.slots.some(slot => !!slot.running), ...this.counters,
      threads: this.slots.filter(slot => !!slot.worker).length };
  }

  search(request: QueryWorkerRequest): Promise<DetailedEntitySearchResult> {
    if (this.closed) return Promise.reject(new Error("query worker pool is closed"));
    const enqueuedAt = absoluteNow();
    const id = this.nextId++;
    const emit = (outcome: QueryWorkerTiming["outcome"], dispatchedAt?: number, workerSlot?: number, workerStartedAt?: number, workerFinishedAt?: number) => {
      const endedAt = absoluteNow();
      // Instrumentation must never affect query or resource settlement.
      try { this.options.onTiming?.({ id, request, queuedMs: (dispatchedAt ?? endedAt) - enqueuedAt,
        dispatchReplyMs: dispatchedAt === undefined ? 0 : endedAt - dispatchedAt, totalMs: endedAt - enqueuedAt,
        enqueueAt: enqueuedAt, dispatchedAt: dispatchedAt ?? null, settledAt: endedAt,
        workerStartedAt: workerStartedAt ?? null, workerFinishedAt: workerFinishedAt ?? null,
        actualServiceMs: workerStartedAt === undefined || workerFinishedAt === undefined ? null : workerFinishedAt - workerStartedAt,
        started: dispatchedAt !== undefined, workerSlot, outcome }); } catch { /* observer only */ }
    };
    if (request.deadlineAt !== undefined && enqueuedAt >= request.deadlineAt) {
      emit("deadline"); return Promise.resolve(stoppedResult("deadline"));
    }
    if (this.queue.length >= (this.options.queueMax ?? QUERY_WORKER_QUEUE_MAX)) {
      this.counters.rejectedQueueFull += 1;
      emit("queue_full"); return Promise.resolve(stoppedResult("queue_full"));
    }
    return new Promise((resolve, reject) => {
      const pending: Pending = { id, request, point: isPointLookup(request),
        resolve: result => { emit(result.stopReason === "deadline" ? (this.closed ? "closed" : "deadline") : "completed", pending.dispatchedAt, pending.workerSlot, pending.workerStartedAt, pending.workerFinishedAt); resolve(result); },
        reject: error => { emit("error", pending.dispatchedAt, pending.workerSlot, pending.workerStartedAt, pending.workerFinishedAt); reject(error); } };
      if (request.deadlineAt !== undefined) {
        pending.expiry = setTimeout(() => {
          const index = this.queue.indexOf(pending);
          if (index < 0) return;
          this.queue.splice(index, 1);
          this.counters.expiredInQueue += 1;
          pending.resolve(stoppedResult("deadline"));
          this.updateRef();
        }, Math.max(0, request.deadlineAt - absoluteNow()));
      }
      const firstScan = pending.point ? this.queue.findIndex(waiting => !waiting.point) : -1;
      if (firstScan >= 0) this.queue.splice(firstScan, 0, pending);
      else this.queue.push(pending);
      this.counters.queuePeak = Math.max(this.counters.queuePeak, this.queue.length);
      this.pump();
    });
  }

  resetPeak(): void { this.counters.queuePeak = this.queue.length; }

  /** Release all current readers; a terminating thread settles on exit. */
  async release(dbPath: string): Promise<void> {
    await Promise.all(this.slots.map(slot => {
      if (slot.terminating) return slot.terminating;
      const worker = slot.worker;
      if (!worker) return Promise.resolve();
      const id = this.nextId++;
      return new Promise<void>(resolve => {
        const pending = this.releases.get(worker) ?? new Map<number, () => void>();
        pending.set(id, resolve); this.releases.set(worker, pending);
        worker.postMessage({ type: "release", dbPath, id });
        this.updateRef();
      });
    }));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const pending of this.queue.splice(0)) {
      if (pending.expiry) clearTimeout(pending.expiry);
      pending.resolve(stoppedResult("deadline"));
    }
    this.closePromise = Promise.all(this.slots.map(async slot => {
      await this.terminate(slot);
      const pending = slot.running;
      slot.running = undefined;
      pending?.resolve(stoppedResult("deadline"));
    })).then(() => undefined);
    return this.closePromise;
  }

  private pump(): void {
    if (!this.closed) for (const [index, slot] of this.slots.entries()) {
      if (slot.running || slot.terminating) continue;
      let next: Pending | undefined;
      while ((next = this.queue.shift())) {
        if (next.expiry) clearTimeout(next.expiry);
        if (next.request.deadlineAt !== undefined && absoluteNow() >= next.request.deadlineAt) {
          this.counters.expiredInQueue += 1; next.resolve(stoppedResult("deadline")); continue;
        }
        break;
      }
      if (!next) continue;
      slot.running = next;
      next.dispatchedAt = absoluteNow(); next.workerSlot = index;
      const worker = this.ensureWorker(slot);
      worker.postMessage({ type: "search", id: next.id,
        request: this.options.allowTestHooks ? next.request : { ...next.request, testBlockMs: undefined } });
      if (next.request.deadlineAt !== undefined) {
        const killAfter = Math.max(0, next.request.deadlineAt - absoluteNow()) + (this.options.killGraceMs ?? QUERY_WORKER_KILL_GRACE_MS);
        const pending = next;
        slot.killTimer = setTimeout(() => void this.killRunning(slot, pending), killAfter);
      }
    }
    this.updateRef();
  }

  private ensureWorker(slot: Slot): Worker {
    if (slot.worker) return slot.worker;
    const worker = new Worker(new URL(import.meta.url), { workerData: { role: QUERY_WORKER_ROLE } });
    this.counters.spawned += 1;
    slot.worker = worker;
    slot.exited = new Promise(resolve => worker.once("exit", () => resolve()));
    worker.on("message", (reply: WorkerReply) => this.onReply(slot, worker, reply));
    // Error precedes exit: preserve the slot until exit has closed connections.
    let failure: Error | undefined;
    worker.on("error", error => { failure = error; });
    worker.on("exit", code => {
      this.settleReleases(worker);
      if (slot.worker !== worker || slot.terminating) return;
      slot.worker = undefined; slot.exited = undefined; this.clearKillTimer(slot);
      const current = slot.running; slot.running = undefined;
      current?.reject(failure ?? new Error(`query worker exited with code ${code}`));
      this.pump();
    });
    return worker;
  }

  private onReply(slot: Slot, worker: Worker, reply: WorkerReply): void {
    if ("released" in reply) {
      const pending = this.releases.get(worker);
      pending?.get(reply.released)?.(); pending?.delete(reply.released);
      if (pending?.size === 0) this.releases.delete(worker);
      this.updateRef(); return;
    }
    const current = slot.running;
    if (slot.worker !== worker || slot.terminating || !current || current.id !== reply.id) return;
    current.workerStartedAt = reply.workerStartedAt; current.workerFinishedAt = reply.workerFinishedAt;
    this.clearKillTimer(slot); slot.running = undefined; this.counters.completed += 1;
    if (reply.ok) current.resolve(reply.result); else current.reject(new Error(reply.error));
    this.pump();
  }

  private async killRunning(slot: Slot, pending: Pending): Promise<void> {
    if (slot.running !== pending || slot.terminating) return;
    this.counters.terminated += 1;
    await this.terminate(slot);
    if (slot.running === pending) { slot.running = undefined; pending.resolve(stoppedResult("deadline")); }
    this.pump();
  }

  private terminate(slot: Slot): Promise<void> {
    this.clearKillTimer(slot);
    if (slot.terminating) return slot.terminating;
    const worker = slot.worker;
    if (!worker) return Promise.resolve();
    const exited = slot.exited;
    // Keep the worker attached until termination AND exit complete. This is
    // the slot reservation that bounds both running and terminating threads.
    const done = (async () => {
      await worker.terminate(); await exited;
      this.settleReleases(worker);
      slot.worker = undefined; slot.exited = undefined;
    })();
    slot.terminating = done.finally(() => { slot.terminating = undefined; });
    return slot.terminating;
  }

  private settleReleases(worker: Worker): void {
    const pending = this.releases.get(worker);
    if (!pending) return;
    for (const resolve of pending.values()) resolve();
    this.releases.delete(worker);
  }
  private clearKillTimer(slot: Slot): void {
    if (slot.killTimer) clearTimeout(slot.killTimer);
    slot.killTimer = undefined;
  }
  private updateRef(): void {
    for (const slot of this.slots) if (slot.worker) {
      if (slot.running || slot.terminating || this.queue.length > 0 || this.releases.has(slot.worker)) slot.worker.ref();
      else slot.worker.unref();
    }
  }
}

let shared: QueryWorkerPool | undefined;
let sharedOptions: QueryWorkerOptions = {};

/** Explicit experimental configuration; an active pool cannot be replaced. */
export function configureSharedQueryWorker(options: QueryWorkerOptions): void {
  if (shared && !shared.isClosed()) throw new Error("shared query worker is active; close it before configuring");
  if (options.workerCount !== undefined && options.workerCount !== 1 && options.workerCount !== 2) throw new Error("query workerCount must be 1 or 2");
  if (options.queueMax !== undefined && (!Number.isInteger(options.queueMax) || options.queueMax < 1 || options.queueMax > QUERY_WORKER_QUEUE_MAX)) throw new Error("query queueMax must be 1..32");
  sharedOptions = { ...options };
}

/** Process-wide static readers; production default remains one thread. */
export function sharedQueryWorker(): QueryWorkerPool {
  if (!shared || shared.isClosed()) shared = new QueryWorkerPool(sharedOptions);
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
    const workerStartedAt = absoluteNow();
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
      parentPort!.postMessage({ id, ok: true, result, workerStartedAt, workerFinishedAt: absoluteNow() } satisfies WorkerReply);
    } catch (error) {
      parentPort!.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error), workerStartedAt, workerFinishedAt: absoluteNow() } satisfies WorkerReply);
    }
  });
}

if (!isMainThread && (workerData as { role?: string } | null)?.role === QUERY_WORKER_ROLE) {
  void runWorker();
}

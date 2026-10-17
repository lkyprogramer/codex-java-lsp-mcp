import type { ChildProcess } from "node:child_process";
import type { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";

/** Owner lease token: release is synchronous and non-throwing. */
export type QueryLease = { readonly snapshotId: string; release(): void };
export type QueryCompletion<T> =
  | { status: "ok"; value: T }
  | { status: "deadline" | "cancelled" | "queue_full" | "stopped" | "error"; error?: string };
export type QueryTask<T> = {
  budget: DeadlineBudget;
  signal?: AbortSignal;
  /** May wait (a file lease); `signal` aborts once the caller no longer needs it.
   * A lease delivered after that is released at once. */
  acquire(signal: AbortSignal): QueryLease | Promise<QueryLease>;
  /** The worker message body for this task under `lease`; the worker caches its connection under lease.snapshotId. */
  payload(lease: QueryLease): unknown;
  /** Converts the worker's value (structured-clone IPC) into the caller's result. */
  decode?(value: unknown): T;
};
export type QueryPoolEvent =
  | { type: "forced-exit"; pid?: number }
  | { type: "reap-overdue"; pid?: number; exited: boolean }
  | { type: "worker-spawn"; pid?: number }
  | { type: "worker-close"; pid?: number; code: number | null; signal: NodeJS.Signals | null; leases: number };
export type QueryPoolOptions = {
  queueMax?: number;
  /** Start one persistent query worker. It keeps the owner's PGID and lock fd (fd4) and speaks the QueryWorker protocol. */
  spawn(): ChildProcess;
  /** Static admission: no lease or process is taken while false. wake() re-checks it. */
  admitted?(): boolean;
  /** A worker may keep a snapshot's connection (and the lease covering it) only while this holds. */
  retain?(snapshotId: string): boolean;
  onEvent?(event: QueryPoolEvent): void;
  timing?: { exitGraceMs?: number; reapWatchMs?: number };
};

/** Parent → worker. `key` names the cached connection, always the lease's snapshot. */
export type QueryWorkerRequest =
  | { type: "run"; id: number; key: string; remainingMs: number; payload: unknown }
  | { type: "close"; keys: string[] }
  /** Close every connection and exit; a worker that does not is killed after the exit grace. */
  | { type: "exit" };
/** Worker → parent. `open` lists every key the worker still holds a connection for after this message. */
export type QueryWorkerReply =
  | { type: "started"; id: number }
  | { type: "result"; id: number; value: unknown; open: string[] }
  | { type: "failed"; id: number; error: string; open: string[] }
  | { type: "closed"; open: string[] };

type Pending<T> = {
  task: QueryTask<T>;
  resolve(result: QueryCompletion<T>): void;
  settled: boolean;
  control: AbortController;
  worker?: Worker<T>;
  /** A free slot reserved for a new worker, spawned only once the lease arrived. */
  newSlot?: boolean;
  lease?: QueryLease;
  timer?: NodeJS.Timeout;
  abort(): void;
  done: Promise<void>;
  reaped(): void;
};
type Worker<T> = {
  child: ChildProcess;
  /** The task this worker is reserved for (acquiring) or running. */
  task?: Pending<T>;
  runId?: number;
  /** One lease per snapshot whose connection the worker reported open. */
  held: Map<string, QueryLease>;
  exited: boolean;
  closed: boolean;
  killed: boolean;
  retiring: boolean;
  reapOverdue: boolean;
  timers: Set<NodeJS.Timeout>;
  done: Promise<void>;
  reaped(): void;
};

export const MAX_QUERY_WORKERS = 2;
/** A stopping worker that was told to exit does so well within this. */
const EXIT_GRACE_MS = 1_000;
/** G06B: a killed worker is reaped within 2 s, or reported. */
const REAP_WATCH_MS = 2_000;

/**
 * At most two persistent query workers and a bounded FIFO queue (contract §2.6).
 * A caller settles at its result or deadline; a worker that is cancelled mid-task is
 * killed, and only its actual close frees the slot and releases every lease it held.
 * Between tasks a worker keeps its connections open, each covered by a query-worker lease.
 */
export class QueryPool<T> {
  private readonly queue: Pending<T>[] = [];
  private readonly workers = new Set<Worker<T>>();
  private readonly queueMax: number;
  private readonly exitGraceMs: number;
  private readonly reapWatchMs: number;
  /** Callers holding a free slot (no worker yet) while their lease is acquired. */
  private readonly reserved = new Set<Pending<T>>();
  private nextRun = 1;
  private stopped = false;
  private pumping = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: QueryPoolOptions) {
    this.queueMax = options.queueMax ?? 32;
    if (!Number.isInteger(this.queueMax) || this.queueMax < 1 || this.queueMax > 32) throw new Error("query queueMax must be 1..32");
    this.exitGraceMs = options.timing?.exitGraceMs ?? EXIT_GRACE_MS;
    this.reapWatchMs = options.timing?.reapWatchMs ?? REAP_WATCH_MS;
  }

  submit(task: QueryTask<T>): Promise<QueryCompletion<T>> {
    if (this.stopped) return Promise.resolve({ status: "stopped" });
    if (task.signal?.aborted) return Promise.resolve({ status: "cancelled" });
    if (task.budget.expired()) return Promise.resolve({ status: "deadline" });
    if (this.queue.length >= this.queueMax) return Promise.resolve({ status: "queue_full" });
    return new Promise(resolve => {
      let reaped!: () => void;
      const done = new Promise<void>(finish => { reaped = finish; });
      const pending: Pending<T> = { task, resolve, settled: false, control: new AbortController(), done, reaped,
        abort: () => this.cancel(pending, { status: "cancelled" }) };
      this.queue.push(pending);
      task.signal?.addEventListener("abort", pending.abort, { once: true });
      this.armDeadline(pending);
      this.pump();
    });
  }

  /** Re-check admission and capacity, e.g. once an owner restart opens its slots. */
  wake(): void {
    this.pump();
  }

  /** Ask idle workers to close connections `retain` no longer allows (e.g. after a publish). */
  trim(): void {
    for (const worker of this.workers) if (!worker.task && worker.runId === undefined) this.trimWorker(worker);
  }

  status() {
    const workers = [...this.workers];
    return { admitted: this.admitted(), workers: workers.length + this.reserved.size, queued: this.queue.length,
      acquiring: this.reserved.size + workers.filter(worker => worker.task && !worker.task.lease && !worker.task.settled).length,
      running: workers.filter(worker => worker.runId !== undefined).length,
      leases: workers.reduce((sum, worker) => sum + worker.held.size + (worker.task?.lease ? 1 : 0), 0),
      reaping: workers.filter(worker => worker.killed && !worker.closed).length,
      reapOverdue: workers.filter(worker => worker.reapOverdue).length,
      pids: workers.flatMap(worker => worker.child.pid === undefined ? [] : [worker.child.pid]) };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    for (const pending of [...this.queue, ...this.reserved]) this.cancel(pending, { status: "stopped" });
    const reserved = [...this.reserved];
    const running = [...this.workers];
    for (const worker of running) {
      if (worker.task) this.cancel(worker.task, { status: "stopped" });
      if (worker.runId === undefined) this.retire(worker);
    }
    this.stopPromise = Promise.all([...running.map(worker => worker.done), ...reserved.map(pending => pending.done)]).then(() => undefined);
    return this.stopPromise;
  }

  private admitted(): boolean {
    return this.options.admitted?.() ?? true;
  }

  private armDeadline(pending: Pending<T>): void {
    // Node timers above int32 wrap to 1ms. Preserve the original budget even
    // for a long-lived caller, rather than treating such a timer as expiry.
    pending.timer = setTimeout(() => {
      if (pending.task.budget.expired()) this.cancel(pending, { status: "deadline" });
      else this.armDeadline(pending);
    }, pending.task.budget.remainingMs(2_147_483_647));
  }

  private arm(worker: Worker<T>, ms: number, action: () => void): void {
    const timer = setTimeout(() => { worker.timers.delete(timer); if (!worker.closed) action(); }, ms);
    worker.timers.add(timer);
  }

  /** An idle worker, else a free slot (true), else nothing. */
  private freeSlot(): Worker<T> | true | undefined {
    for (const worker of this.workers) if (!worker.task && !worker.killed && !worker.closed && !worker.retiring) return worker;
    return this.workers.size + this.reserved.size < MAX_QUERY_WORKERS ? true : undefined;
  }

  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (!this.stopped && this.queue.length && this.admitted()) {
        const head = this.queue[0];
        if (head.task.signal?.aborted || head.task.budget.expired()) {
          this.queue.shift();
          this.settle(head, { status: head.task.signal?.aborted ? "cancelled" : "deadline" });
          head.reaped();
          continue;
        }
        const slot = this.freeSlot();
        if (!slot) return;
        const pending = this.queue.shift()!;
        // The slot is reserved while the lease is acquired, so task leases never exceed workers.
        if (slot === true) { this.reserved.add(pending); pending.newSlot = true; }
        else { slot.task = pending; pending.worker = slot; }
        let acquired: QueryLease | Promise<QueryLease>;
        try { acquired = pending.task.acquire(pending.control.signal); }
        catch (error) { this.unleased(pending, error); continue; }
        if (acquired instanceof Promise) acquired.then(lease => this.leased(pending, lease), error => this.unleased(pending, error));
        else this.leased(pending, acquired);
      }
    } finally { this.pumping = false; }
  }

  private spawnWorker(): Worker<T> {
    const child = this.options.spawn();
    let reaped!: () => void;
    const done = new Promise<void>(finish => { reaped = finish; });
    const worker: Worker<T> = { child, held: new Map(), exited: false, closed: false, killed: false, retiring: false, reapOverdue: false, timers: new Set(), done, reaped };
    this.workers.add(worker);
    this.options.onEvent?.({ type: "worker-spawn", pid: child.pid });
    child.on("message", (message: QueryWorkerReply) => this.onReply(worker, message));
    // ChildProcess may emit "error" more than once (spawn, kill, send).
    child.on("error", error => {
      const running = worker.task;
      if (running?.lease) this.settle(running, { status: "error", error: error.message });
      this.kill(worker);
    });
    child.once("exit", () => { worker.exited = true; });
    child.once("close", (code, signal) => this.closed(worker, code, signal));
    return worker;
  }

  /** No run was sent: the reservation ends and the worker stays idle. */
  private unleased(pending: Pending<T>, error: unknown): void {
    this.settle(pending, { status: "error", error: error instanceof Error ? error.message : String(error) });
    this.free(pending);
  }

  private leased(pending: Pending<T>, lease: QueryLease): void {
    pending.lease = lease;
    if (pending.newSlot && (pending.settled || this.stopped || pending.task.budget.expired())) {
      this.settle(pending, { status: this.stopped ? "stopped" : "deadline" });
      this.free(pending);
      return;
    }
    let payload: unknown;
    try { payload = pending.task.payload(lease); }
    catch (error) { this.unleased(pending, error); return; }
    if (pending.newSlot) {
      pending.newSlot = false;
      this.reserved.delete(pending);
      try { pending.worker = this.spawnWorker(); }
      catch (error) { this.unleased(pending, error); return; }
      pending.worker.task = pending;
    }
    const worker = pending.worker;
    if (!worker || pending.settled || this.stopped || worker.closed || worker.killed || pending.task.budget.expired()) {
      const lost = !worker || worker.closed || worker.killed;
      this.settle(pending, { status: this.stopped ? "stopped" : lost ? "error" : "deadline", ...(lost ? { error: "query worker unavailable" } : {}) });
      this.free(pending);
      return;
    }
    const id = this.nextRun++;
    worker.runId = id;
    const message: QueryWorkerRequest = { type: "run", id, key: lease.snapshotId, remainingMs: pending.task.budget.remainingMs(), payload };
    try {
      worker.child.send(message, error => { if (error) this.kill(worker); });
    } catch {
      this.kill(worker);
    }
  }

  private onReply(worker: Worker<T>, message: QueryWorkerReply): void {
    if (worker.closed || worker.killed) return;
    if (message?.type === "closed" && Array.isArray(message.open)) { this.sync(worker, message.open); return; }
    if ((message?.type !== "result" && message?.type !== "failed") || !Array.isArray(message.open)) return;
    const pending = worker.task;
    if (!pending || worker.runId !== message.id) return;
    worker.runId = undefined;
    if (!pending.settled) {
      if (message.type === "failed") this.settle(pending, { status: "error", error: message.error });
      // The deadline is checked when the result arrives, not only when its timer runs.
      else if (pending.task.budget.expired()) this.settle(pending, { status: "deadline" });
      else {
        try { this.settle(pending, { status: "ok", value: pending.task.decode ? pending.task.decode(message.value) : message.value as T }); }
        catch (error) { this.settle(pending, { status: "error", error: error instanceof Error ? error.message : String(error) }); }
      }
    }
    // The task's lease becomes the worker's while the worker reports the connection open.
    const lease = pending.lease;
    pending.lease = undefined;
    if (lease && message.open.includes(lease.snapshotId) && !worker.held.has(lease.snapshotId)) worker.held.set(lease.snapshotId, lease);
    else lease?.release();
    this.sync(worker, message.open);
    worker.task = undefined;
    pending.worker = undefined;
    pending.reaped();
    if (this.stopped) this.retire(worker);
    else { this.trimWorker(worker); this.pump(); }
  }

  /** Leases follow what the worker still holds open: a key it closed releases its lease. */
  private sync(worker: Worker<T>, open: readonly string[]): void {
    const still = new Set(open);
    for (const [key, lease] of worker.held) if (!still.has(key)) { worker.held.delete(key); lease.release(); }
  }

  private trimWorker(worker: Worker<T>): void {
    const retain = this.options.retain;
    if (!retain || worker.killed || worker.closed) return;
    const keys = [...worker.held.keys()].filter(key => !retain(key));
    if (keys.length === 0) return;
    const message: QueryWorkerRequest = { type: "close", keys };
    try { worker.child.send(message, error => { if (error) this.kill(worker); }); } catch { this.kill(worker); }
  }

  private closed(worker: Worker<T>, code: number | null, signal: NodeJS.Signals | null): void {
    if (worker.closed) return;
    worker.closed = true;
    for (const timer of worker.timers) clearTimeout(timer);
    worker.timers.clear();
    const pending = worker.task;
    const leases = worker.held.size + (pending?.lease ? 1 : 0);
    if (pending) {
      this.settle(pending, pending.task.budget.expired() ? { status: "deadline" }
        : { status: "error", error: `query worker exited ${code ?? signal} without a successful result` });
    }
    // Only now, after the actual close, is any connection lease released.
    for (const lease of worker.held.values()) lease.release();
    worker.held.clear();
    if (pending) {
      pending.lease?.release();
      pending.lease = undefined;
      pending.worker = undefined;
      pending.reaped();
    }
    worker.task = undefined;
    worker.runId = undefined;
    this.workers.delete(worker);
    this.options.onEvent?.({ type: "worker-close", pid: worker.child.pid, code, signal, leases });
    worker.reaped();
    this.pump();
  }

  private cancel(pending: Pending<T>, outcome: QueryCompletion<T>): void {
    if (pending.settled) return;
    this.settle(pending, outcome);
    const index = this.queue.indexOf(pending);
    if (index >= 0) {
      this.queue.splice(index, 1);
      pending.reaped();
      this.pump();
      return;
    }
    const worker = pending.worker;
    if (!worker) return;
    // A lease still being acquired is released when it arrives (leased()); a running native step is killed.
    if (worker.runId !== undefined) this.kill(worker);
  }

  /** The reservation ends without a run: release the task lease and return the worker to idle. */
  private free(pending: Pending<T>): void {
    const worker = pending.worker;
    if (pending.newSlot) { pending.newSlot = false; this.reserved.delete(pending); }
    pending.lease?.release();
    pending.lease = undefined;
    pending.worker = undefined;
    if (worker && worker.task === pending) worker.task = undefined;
    pending.reaped();
    if (worker && this.stopped) this.retire(worker);
    this.pump();
  }

  /** An idle worker that must go: it is told to exit (a parent-side disconnect would never emit "close"); a stuck one is killed after the grace period. */
  private retire(worker: Worker<T>): void {
    if (worker.closed || worker.killed || worker.retiring) return;
    worker.retiring = true;
    this.arm(worker, this.exitGraceMs, () => {
      this.options.onEvent?.({ type: "forced-exit", pid: worker.child.pid });
      this.kill(worker);
    });
    const message: QueryWorkerRequest = { type: "exit" };
    try { worker.child.send(message, error => { if (error) this.kill(worker); }); } catch { this.kill(worker); }
  }

  /** Only the actual close frees the slot; a kill that is not reaped in time is reported, never assumed. */
  private kill(worker: Worker<T>): void {
    // SIGKILL is sent once: a failed kill emits "error" synchronously, which re-enters kill.
    if (worker.closed || worker.killed) return;
    worker.killed = true;
    this.arm(worker, this.reapWatchMs, () => {
      worker.reapOverdue = true;
      this.options.onEvent?.({ type: "reap-overdue", pid: worker.child.pid, exited: worker.exited });
    });
    worker.child.kill("SIGKILL");
  }

  private settle(pending: Pending<T>, outcome: QueryCompletion<T>): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    pending.control.abort();
    pending.task.signal?.removeEventListener("abort", pending.abort);
    pending.resolve(outcome);
  }
}

/** Cancel only this caller's waiting right. The scheduler owns the shared job. */
export function waitForSharedBuild<T>(shared: Promise<T>, budget: DeadlineBudget, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      complete();
    };
    const abort = () => finish(() => reject(new JavaIntelligenceError("CANCELLED", "Caller cancelled shared build wait")));
    const expiry = () => {
      if (budget.expired()) finish(() => reject(new JavaIntelligenceError("DEADLINE_EXCEEDED", "Shared build wait exceeded caller deadline")));
      else timer = setTimeout(expiry, budget.remainingMs(2_147_483_647));
    };
    // Always observe shared rejection, including an already-expired caller.
    const deliver = (complete: () => void) => budget.expired() ? expiry() : finish(complete);
    shared.then(value => deliver(() => resolve(value)), error => deliver(() => reject(error)));
    if (signal?.aborted) abort();
    else if (budget.expired()) expiry();
    else {
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(expiry, budget.remainingMs(2_147_483_647));
    }
  });
}

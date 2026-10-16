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
  /** Start one request-owned process, preserving the owner's PGID and lock fd.
   * `result` settles before the child closes. */
  start(lease: QueryLease): { child: ChildProcess; result: Promise<T> };
};
export type QueryPoolEvent =
  | { type: "forced-exit"; pid?: number }
  | { type: "reap-overdue"; pid?: number; exited: boolean };
export type QueryPoolOptions = {
  queueMax?: number;
  /** Static admission: no lease or process is taken while false. wake() re-checks it. */
  admitted?(): boolean;
  onEvent?(event: QueryPoolEvent): void;
  timing?: { exitGraceMs?: number; reapWatchMs?: number };
};
type Pending<T> = {
  task: QueryTask<T>;
  resolve(result: QueryCompletion<T>): void;
  settled: boolean;
  control: AbortController;
  lease?: QueryLease;
  child?: ChildProcess;
  exited: boolean;
  closed: boolean;
  killed: boolean;
  reapOverdue: boolean;
  timer?: NodeJS.Timeout;
  timers: Set<NodeJS.Timeout>;
  abort(): void;
  done: Promise<void>;
  reaped(): void;
};

export const MAX_QUERY_WORKERS = 2;
/** A worker that sent its result exits on its own well within this. */
const EXIT_GRACE_MS = 1_000;
/** G06B: a killed worker is reaped within 2 s, or reported. */
const REAP_WATCH_MS = 2_000;
/** A result posted just before exit may be delivered after the close event. */
const RESULT_AFTER_CLOSE_MS = 50;

/** Process slots and lease tokens; the SQL adapter and file leases attach in C/07/08.
 * A caller settles at its result or deadline; only the actual close releases
 * the worker slot and its lease. */
export class QueryPool<T> {
  private readonly queue: Pending<T>[] = [];
  private readonly active = new Set<Pending<T>>();
  private readonly queueMax: number;
  private readonly exitGraceMs: number;
  private readonly reapWatchMs: number;
  private stopped = false;
  private pumping = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: QueryPoolOptions | number = {}) {
    const resolved = typeof options === "number" ? { queueMax: options } : options;
    this.queueMax = resolved.queueMax ?? 32;
    if (!Number.isInteger(this.queueMax) || this.queueMax < 1 || this.queueMax > 32) throw new Error("query queueMax must be 1..32");
    this.exitGraceMs = resolved.timing?.exitGraceMs ?? EXIT_GRACE_MS;
    this.reapWatchMs = resolved.timing?.reapWatchMs ?? REAP_WATCH_MS;
  }

  private get settings(): QueryPoolOptions {
    return typeof this.options === "number" ? {} : this.options;
  }

  submit(task: QueryTask<T>): Promise<QueryCompletion<T>> {
    if (this.stopped) return Promise.resolve({ status: "stopped" });
    if (task.signal?.aborted) return Promise.resolve({ status: "cancelled" });
    if (task.budget.expired()) return Promise.resolve({ status: "deadline" });
    if (this.queue.length >= this.queueMax) return Promise.resolve({ status: "queue_full" });
    return new Promise(resolve => {
      let reaped!: () => void;
      const done = new Promise<void>(finish => { reaped = finish; });
      const pending: Pending<T> = { task, resolve, settled: false, control: new AbortController(), exited: false, closed: false,
        killed: false, reapOverdue: false, timers: new Set(), done, reaped,
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

  status() {
    const active = [...this.active];
    return { admitted: this.admitted(), workers: active.length, queued: this.queue.length,
      acquiring: active.filter(item => !item.lease && !item.settled).length,
      leases: active.filter(item => item.lease).length,
      reaping: active.filter(item => item.settled).length,
      reapOverdue: active.filter(item => item.reapOverdue).length,
      pids: active.flatMap(item => item.child?.pid === undefined ? [] : [item.child.pid]) };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    for (const pending of [...this.queue]) this.cancel(pending, { status: "stopped" });
    const running = [...this.active];
    for (const pending of running) this.cancel(pending, { status: "stopped" });
    this.stopPromise = Promise.all(running.map(item => item.done)).then(() => undefined);
    return this.stopPromise;
  }

  private admitted(): boolean {
    return this.settings.admitted?.() ?? true;
  }

  private armDeadline(pending: Pending<T>): void {
    // Node timers above int32 wrap to 1ms. Preserve the original budget even
    // for a long-lived caller, rather than treating such a timer as expiry.
    pending.timer = setTimeout(() => {
      if (pending.task.budget.expired()) this.cancel(pending, { status: "deadline" });
      else this.armDeadline(pending);
    }, pending.task.budget.remainingMs(2_147_483_647));
  }

  private arm(pending: Pending<T>, ms: number, action: () => void): void {
    const timer = setTimeout(() => { pending.timers.delete(timer); if (!pending.closed) action(); }, ms);
    pending.timers.add(timer);
  }

  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (!this.stopped && this.active.size < MAX_QUERY_WORKERS && this.queue.length && this.admitted()) {
        const pending = this.queue.shift()!;
        if (pending.task.signal?.aborted || pending.task.budget.expired()) {
          this.settle(pending, { status: pending.task.signal?.aborted ? "cancelled" : "deadline" });
          pending.reaped();
          continue;
        }
        // The slot is taken while the lease is acquired, so leases never exceed workers.
        this.active.add(pending);
        let acquired: QueryLease | Promise<QueryLease>;
        try { acquired = pending.task.acquire(pending.control.signal); }
        catch (error) { this.fail(pending, error); continue; }
        if (acquired instanceof Promise) acquired.then(lease => this.leased(pending, lease), error => this.fail(pending, error));
        else this.leased(pending, acquired);
      }
    } finally { this.pumping = false; }
  }

  /** No child was started: settle and free the slot. */
  private fail(pending: Pending<T>, error: unknown): void {
    this.settle(pending, { status: "error", error: error instanceof Error ? error.message : String(error) });
    this.release(pending);
  }

  private leased(pending: Pending<T>, lease: QueryLease): void {
    pending.lease = lease;
    if (pending.settled || this.stopped || pending.task.budget.expired()) {
      this.settle(pending, { status: this.stopped ? "stopped" : "deadline" });
      this.release(pending);
      return;
    }
    let attempt: { child: ChildProcess; result: Promise<T> };
    try { attempt = pending.task.start(lease); }
    catch (error) { this.fail(pending, error); return; }
    const child = attempt.child;
    pending.child = child;
    let resultSettled = false;
    const settledResult = attempt.result.then(value => {
      resultSettled = true;
      if (pending.closed) return;
      // The deadline is checked when the result arrives, not only when its timer runs.
      if (!pending.settled) this.settle(pending, pending.task.budget.expired() ? { status: "deadline" } : { status: "ok", value });
      this.arm(pending, this.exitGraceMs, () => {
        this.settings.onEvent?.({ type: "forced-exit", pid: child.pid });
        this.kill(pending);
      });
    }, error => {
      resultSettled = true;
      this.cancel(pending, { status: "error", error: error instanceof Error ? error.message : String(error) });
    });
    // ChildProcess may emit "error" more than once (spawn, kill, send).
    child.on("error", error => this.cancel(pending, { status: "error", error: error.message }));
    child.once("exit", () => { pending.exited = true; });
    child.once("close", (code, signal) => {
      const finish = () => this.closed(pending, code, signal);
      // Only a child that exited on its own may still have a result in flight.
      if (resultSettled || pending.killed) { finish(); return; }
      const timer = setTimeout(finish, RESULT_AFTER_CLOSE_MS);
      void settledResult.then(() => { clearTimeout(timer); finish(); });
    });
    // acquire/start callbacks may synchronously stop or cancel the pool.
    if (pending.settled) this.kill(pending);
  }

  private closed(pending: Pending<T>, code: number | null, signal: NodeJS.Signals | null): void {
    if (pending.closed) return;
    pending.closed = true;
    for (const timer of pending.timers) clearTimeout(timer);
    pending.timers.clear();
    this.settle(pending, pending.task.budget.expired() ? { status: "deadline" }
      : { status: "error", error: `query worker exited ${code ?? signal} without a successful result` });
    this.release(pending);
  }

  private cancel(pending: Pending<T>, outcome: QueryCompletion<T>): void {
    if (pending.settled) {
      // A settled caller whose worker errors or hangs is still reaped.
      if (outcome.status === "error" || outcome.status === "stopped") this.kill(pending);
      return;
    }
    this.settle(pending, outcome);
    const index = this.queue.indexOf(pending);
    if (index >= 0) {
      this.queue.splice(index, 1);
      pending.reaped();
      this.pump();
    } else if (this.active.has(pending)) {
      // A lease still being acquired is released when it arrives (leased()).
      this.kill(pending);
    }
  }

  /** Only the actual close frees the slot; a kill that is not reaped in time is reported, never assumed. */
  private kill(pending: Pending<T>): void {
    // SIGKILL is sent once: a failed kill emits "error" synchronously, which re-enters cancel.
    if (!pending.child || pending.closed || pending.killed) return;
    pending.killed = true;
    this.arm(pending, this.reapWatchMs, () => {
      pending.reapOverdue = true;
      this.settings.onEvent?.({ type: "reap-overdue", pid: pending.child?.pid, exited: pending.exited });
    });
    pending.child.kill("SIGKILL");
  }

  private settle(pending: Pending<T>, outcome: QueryCompletion<T>): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    pending.control.abort();
    pending.task.signal?.removeEventListener("abort", pending.abort);
    pending.resolve(outcome);
  }

  private release(pending: Pending<T>): void {
    if (!this.active.has(pending)) return;
    pending.lease?.release();
    this.active.delete(pending);
    pending.reaped();
    this.pump();
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

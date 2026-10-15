import type { ChildProcess } from "node:child_process";
import type { DeadlineBudget } from "../../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";

/** In-memory owner token: release is synchronous and non-throwing. */
export type QueryLease = { readonly snapshotId: string; release(): void };
export type QueryCompletion<T> =
  | { status: "ok"; value: T }
  | { status: "deadline" | "cancelled" | "queue_full" | "stopped" | "error"; error?: string };
export type QueryTask<T> = {
  budget: DeadlineBudget;
  signal?: AbortSignal;
  acquire(): QueryLease;
  /** Start one request-owned process, preserving the owner's PGID and lock fd. */
  start(lease: QueryLease): { child: ChildProcess; result: Promise<T> };
};
type Pending<T> = {
  task: QueryTask<T>;
  resolve(result: QueryCompletion<T>): void;
  settled: boolean;
  lease?: QueryLease;
  child?: ChildProcess;
  value?: T;
  received: boolean;
  timer?: NodeJS.Timeout;
  abort(): void;
  done: Promise<void>;
  reaped(): void;
};

/** Process slots and lease tokens; the SQL adapter and file leases attach in C/07/08.
 * A deadline settles the caller, but only actual close releases its resources. */
export class QueryPool<T> {
  private readonly queue: Pending<T>[] = [];
  private readonly active = new Set<Pending<T>>();
  private stopped = false;
  private pumping = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly queueMax = 32) {
    if (!Number.isInteger(queueMax) || queueMax < 1 || queueMax > 32) throw new Error("query queueMax must be 1..32");
  }

  submit(task: QueryTask<T>): Promise<QueryCompletion<T>> {
    if (this.stopped) return Promise.resolve({ status: "stopped" });
    if (task.signal?.aborted) return Promise.resolve({ status: "cancelled" });
    if (task.budget.expired()) return Promise.resolve({ status: "deadline" });
    if (this.queue.length >= this.queueMax) return Promise.resolve({ status: "queue_full" });
    return new Promise(resolve => {
      let reaped!: () => void;
      const done = new Promise<void>(finish => { reaped = finish; });
      const pending: Pending<T> = { task, resolve, settled: false, received: false, done, reaped,
        abort: () => this.cancel(pending, { status: "cancelled" }) };
      this.queue.push(pending);
      task.signal?.addEventListener("abort", pending.abort, { once: true });
      this.armDeadline(pending);
      this.pump();
    });
  }

  status() {
    return { workers: this.active.size, queued: this.queue.length,
      reaping: [...this.active].filter(item => item.settled).length,
      pids: [...this.active].flatMap(item => item.child?.pid === undefined ? [] : [item.child.pid]) };
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

  private armDeadline(pending: Pending<T>): void {
    // Node timers above int32 wrap to 1ms. Preserve the original budget even
    // for a long-lived caller, rather than treating such a timer as expiry.
    pending.timer = setTimeout(() => {
      if (pending.task.budget.expired()) this.cancel(pending, { status: "deadline" });
      else this.armDeadline(pending);
    }, pending.task.budget.remainingMs(2_147_483_647));
  }

  private pump(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      while (!this.stopped && this.active.size < 2 && this.queue.length) {
        const pending = this.queue.shift()!;
        if (pending.task.signal?.aborted || pending.task.budget.expired()) {
          this.settle(pending, { status: pending.task.signal?.aborted ? "cancelled" : "deadline" });
          pending.reaped();
          continue;
        }
        this.active.add(pending);
        try {
          pending.lease = pending.task.acquire();
          if (pending.settled || this.stopped || pending.task.budget.expired()) {
            this.settle(pending, { status: this.stopped ? "stopped" : "deadline" });
            this.release(pending);
            continue;
          }
          const attempt = pending.task.start(pending.lease);
          pending.child = attempt.child;
          attempt.child.once("error", error => this.cancel(pending, { status: "error", error: error.message }));
          attempt.child.once("close", (code, signal) => {
            this.settle(pending, pending.task.budget.expired() ? { status: "deadline" } : code === 0 && pending.received
              ? { status: "ok", value: pending.value as T }
              : { status: "error", error: `query worker exited ${code ?? signal} without a successful result` });
            this.release(pending);
          });
          attempt.result.then(value => {
            if (!this.active.has(pending) || pending.settled) return;
            pending.received = true;
            pending.value = value;
          }, error => this.cancel(pending, { status: "error", error: error instanceof Error ? error.message : String(error) }));
          // acquire/start callbacks may synchronously stop or cancel the pool.
          if (pending.settled) attempt.child.kill("SIGKILL");
        } catch (error) {
          this.settle(pending, { status: "error", error: error instanceof Error ? error.message : String(error) });
          this.release(pending); // No child was returned, so there is nothing to reap.
        }
      }
    } finally { this.pumping = false; }
  }

  private cancel(pending: Pending<T>, outcome: QueryCompletion<T>): void {
    if (pending.settled) return;
    this.settle(pending, outcome);
    const index = this.queue.indexOf(pending);
    if (index >= 0) {
      this.queue.splice(index, 1);
      pending.reaped();
      this.pump();
    } else if (this.active.has(pending)) {
      pending.child?.kill("SIGKILL");
    }
  }

  private settle(pending: Pending<T>, outcome: QueryCompletion<T>): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    pending.task.signal?.removeEventListener("abort", pending.abort);
    pending.resolve(outcome);
  }

  private release(pending: Pending<T>): void {
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

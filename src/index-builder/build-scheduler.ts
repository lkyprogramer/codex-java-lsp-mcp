import type { ChildProcess } from "node:child_process";
import path from "node:path";
import type { SourceCapture } from "../java-index/source-capture.js";
import type { BuilderJobResult } from "./incremental.js";

export type BuildKind = "full" | "delta";
export type BuildHint = {
  workspaceId: string;
  kind: BuildKind;
  generation: number;
  changed?: readonly string[];
  deleted?: readonly string[];
  rescan?: boolean;
};
export type BuildOutcome =
  | { kind: "result"; result: BuilderJobResult }
  | { kind: "needs-full"; captures: readonly SourceCapture[]; reason: string };
export type BuildGrant = { parserTokens: number; captures: readonly SourceCapture[] };
/** `result` settles before the child closes: the adapter sends it only after
 * the job's writes are durable, then exits. */
export type BuildAttempt = { child: ChildProcess; result: Promise<BuildOutcome> };
export type BuildSelection = {
  kind: BuildKind;
  baseId?: string;
  start(grant: BuildGrant): BuildAttempt;
  /** Called exactly once by the scheduler: when the selection is discarded
   * unstarted, or after its started process closed. select() itself must not
   * spawn; anything it reserves is returned here. */
  release?(): void;
};
export type BuildCompletion = {
  ok: boolean;
  error?: string;
  result?: BuilderJobResult;
  baseId?: string;
  /** The result arrived, but the builder did not exit within the grace period and was killed. */
  forcedExit?: boolean;
};
export type BuildSchedulerEvent =
  | { type: "forced-exit"; workspaceId: string; pid?: number }
  | { type: "reap-overdue"; workspaceId: string; pid?: number; exited: boolean }
  /** Lifecycle telemetry (§5.3): queue → dispatch → result → close, with the slot occupancy at dispatch. */
  | { type: "queued"; workspaceId: string; kind: BuildKind; queued: number }
  | { type: "dispatched"; workspaceId: string; kind: BuildKind; pid?: number; baseId?: string; waitedMs: number; builders: number; full: number; parserTokens: number }
  | { type: "result"; workspaceId: string; kind: BuildKind; pid?: number; ok: boolean; escalation?: string; files?: number; stages?: unknown; runMs: number }
  | { type: "closed"; workspaceId: string; kind: BuildKind; pid?: number; code: number | null; signal: NodeJS.Signals | null; runMs: number; failure?: string; forcedExit?: boolean };
export type BuildSchedulerOptions = {
  /** Select from the owner's current bindings at admission, never from a queued CURRENT path. */
  select(hint: Readonly<BuildHint>): BuildSelection;
  /** Static admission: no builder starts while false (an owner restart before
   * its slots are open). wake() re-checks it. */
  admitted?(): boolean;
  onEvent?(event: BuildSchedulerEvent): void;
  timing?: { exitGraceMs?: number; reapWatchMs?: number };
};

type Change = { deleted: boolean; generation: number };
/** One process run for an entry; a delta that escalates runs a second attempt. */
type Attempt = {
  selection: BuildSelection;
  startedAt: number;
  kind: BuildKind;
  child?: ChildProcess;
  state: "RUNNING" | "RESULT_RECEIVED" | "REAPING";
  outcome?: BuildOutcome;
  failure?: string;
  forcedExit?: boolean;
  exited: boolean;
  closed: boolean;
  /** SIGKILL is sent once: a failed kill emits "error" synchronously, which re-enters terminate. */
  killSent: boolean;
  reapOverdue: boolean;
  timers: Set<NodeJS.Timeout>;
};
/** One workspace's merged request, from its first submit to its completion. */
type Entry = {
  hint: BuildHint;
  order: number;
  changes: Map<string, Change>;
  waiters: Array<(result: BuildCompletion) => void>;
  captures: readonly SourceCapture[];
  escalated?: boolean;
  attempt?: Attempt;
  baseId?: string;
  done: Promise<void>;
  reaped(): void;
  /** When this entry (re)entered the queue. */
  queuedAt: number;
};

/** ILV2 §6.1: a closure above this many files is published as an explicit full, never a delta. */
export const DELTA_CLOSURE_LIMIT = 400;
export const MAX_BUILDERS = 2;
export const PARSERS_PER_BUILDER = 2;
const JOB_MS = { delta: 60_000, full: 1_230_000 };
/** A builder that sent its result exits on its own well within this. */
const EXIT_GRACE_MS = 5_000;
/** G06B/G06C: a killed process is reaped within 2 s, or reported. */
const REAP_WATCH_MS = 2_000;
/** A result posted just before exit may be delivered after the close event. */
const RESULT_AFTER_CLOSE_MS = 50;

/** Owner-scoped scheduling primitive. Transport/bindings switch to it in MAC-08;
 * the process adapter must use the grant, and must report escalation before doing a full. */
export class BuildScheduler {
  private readonly queue: Entry[] = [];
  private readonly active = new Map<string, Entry>();
  private readonly released = new WeakSet<BuildSelection>();
  private readonly exitGraceMs: number;
  private readonly reapWatchMs: number;
  private order = 0;
  private pumping = false;
  private stopped = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: BuildSchedulerOptions) {
    this.exitGraceMs = options.timing?.exitGraceMs ?? EXIT_GRACE_MS;
    this.reapWatchMs = options.timing?.reapWatchMs ?? REAP_WATCH_MS;
  }

  submit(hint: BuildHint): Promise<BuildCompletion> {
    if (this.stopped) return Promise.resolve({ ok: false, error: "scheduler stopped" });
    if (!hint.workspaceId || !Number.isSafeInteger(hint.generation) || hint.generation < 0
      || !["full", "delta"].includes(hint.kind)) {
      return Promise.resolve({ ok: false, error: "invalid build hint" });
    }
    return new Promise(resolve => {
      let entry = this.queue.find(item => item.hint.workspaceId === hint.workspaceId);
      if (!entry) {
        let reaped!: () => void;
        const done = new Promise<void>(finish => { reaped = finish; });
        entry = { hint: { ...hint }, order: this.order++, changes: new Map(), waiters: [], captures: [], done, reaped, queuedAt: performance.now() };
        this.queue.push(entry);
        this.options.onEvent?.({ type: "queued", workspaceId: hint.workspaceId, kind: hint.kind, queued: this.queue.length });
      }
      this.mergeHint(entry, hint);
      entry.waiters.push(resolve);
      this.schedule();
    });
  }

  /** Re-check admission and capacity, e.g. once an owner restart opens its slots. */
  wake(): void {
    this.schedule();
  }

  status() {
    const jobs = [...this.active.values()].flatMap(entry => entry.attempt ? [{ workspaceId: entry.hint.workspaceId,
      kind: entry.attempt.kind, state: entry.attempt.state, pid: entry.attempt.child?.pid, baseId: entry.baseId,
      exited: entry.attempt.exited, reapOverdue: entry.attempt.reapOverdue }] : []);
    return { stopped: this.stopped, admitted: this.admitted(), builders: this.active.size,
      full: jobs.filter(job => job.kind === "full").length, parserTokens: this.active.size * PARSERS_PER_BUILDER,
      queued: this.queue.length, reapOverdue: jobs.filter(job => job.reapOverdue).length, jobs };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    for (const entry of this.queue.splice(0)) this.complete(entry, { ok: false, error: "scheduler stopped" });
    const running = [...this.active.values()];
    for (const entry of running) {
      // A received result stands: its writes are durable.
      if (entry.attempt) this.terminate(entry, entry.attempt, "scheduler stopped");
    }
    this.stopPromise = Promise.all(running.map(entry => entry.done)).then(() => undefined);
    return this.stopPromise;
  }

  private admitted(): boolean {
    return this.options.admitted?.() ?? true;
  }

  private mergeHint(entry: Entry, hint: BuildHint, changes?: ReadonlyMap<string, Change>): void {
    const updates = changes ?? new Map<string, Change>([
      ...(hint.changed ?? []).map(name => [name, { deleted: false, generation: hint.generation }] as const),
      ...(hint.deleted ?? []).map(name => [name, { deleted: true, generation: hint.generation }] as const)
    ]);
    const touched = new Set(updates.keys());
    entry.captures = hint.rescan ? [] : entry.captures.filter(capture =>
      !touched.has(capture.inputPath) && !touched.has(path.relative(capture.repoRoot, capture.inputPath).split(path.sep).join("/")));
    for (const [name, update] of updates) {
      const prior = entry.changes.get(name);
      if (!prior || update.generation >= prior.generation) entry.changes.set(name, update);
    }
    entry.hint = { workspaceId: hint.workspaceId,
      kind: entry.hint.kind === "full" || hint.kind === "full" ? "full" : "delta",
      generation: Math.max(entry.hint.generation, hint.generation), rescan: entry.hint.rescan || hint.rescan,
      changed: [...entry.changes].filter(([, value]) => !value.deleted).map(([name]) => name).sort(),
      deleted: [...entry.changes].filter(([, value]) => value.deleted).map(([name]) => name).sort() };
  }

  private schedule(): void {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    queueMicrotask(() => {
      try { this.pump(); } finally { this.pumping = false; }
    });
  }

  private release(selection: BuildSelection): void {
    if (this.released.has(selection)) return;
    this.released.add(selection);
    selection.release?.();
  }

  private pump(): void {
    const considered = new Set<Entry>();
    while (!this.stopped && this.active.size < MAX_BUILDERS && this.admitted()) {
      const fullBusy = [...this.active.values()].some(entry => entry.attempt?.kind === "full");
      const eligible = this.queue.filter(entry => !considered.has(entry) && !this.active.has(entry.hint.workspaceId)
        && (entry.hint.kind !== "full" || !fullBusy));
      // Once a full exits, an older waiting full gets the newly free slot.
      eligible.sort((a, b) => Number(b.hint.kind === "full") - Number(a.hint.kind === "full") || a.order - b.order);
      const entry = eligible[0];
      if (!entry) return;
      considered.add(entry);
      this.queue.splice(this.queue.indexOf(entry), 1);
      this.active.set(entry.hint.workspaceId, entry);
      let selection: BuildSelection | undefined;
      try {
        selection = this.options.select(entry.hint);
        if (this.stopped) {
          this.release(selection);
          this.complete(entry, { ok: false, error: "scheduler stopped" });
          continue;
        }
        if (entry.escalated && selection.kind !== "full") throw new Error("escalated build requires a full selection");
        if (selection.kind === "full" && fullBusy) {
          this.release(selection);
          this.active.delete(entry.hint.workspaceId);
          entry.hint.kind = "full";
          this.queue.push(entry);
          continue; // Discard this selection: admission must select the then-current base again.
        }
        this.launch(entry, selection);
      } catch (error) {
        if (selection && !entry.attempt?.child) this.release(selection);
        entry.attempt = undefined;
        this.complete(entry, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private launch(entry: Entry, selection: BuildSelection): void {
    const attempt: Attempt = { selection, startedAt: performance.now(), kind: selection.kind, state: "RUNNING", exited: false, closed: false,
      killSent: false, reapOverdue: false, timers: new Set() };
    entry.attempt = attempt;
    entry.baseId = selection.baseId;
    const started = selection.start({ parserTokens: PARSERS_PER_BUILDER, captures: entry.captures });
    const child = started.child;
    attempt.child = child;
    const full = [...this.active.values()].filter(item => item.attempt?.kind === "full").length;
    this.options.onEvent?.({ type: "dispatched", workspaceId: entry.hint.workspaceId, kind: attempt.kind, pid: child.pid, ...(selection.baseId ? { baseId: selection.baseId } : {}),
      waitedMs: attempt.startedAt - entry.queuedAt, builders: this.active.size, full, parserTokens: this.active.size * PARSERS_PER_BUILDER });
    let resultSettled = false;
    const settledResult = started.result.then(outcome => {
      resultSettled = true;
      if (entry.attempt !== attempt || attempt.closed) return;
      attempt.outcome = outcome;
      this.options.onEvent?.({ type: "result", workspaceId: entry.hint.workspaceId, kind: attempt.kind, pid: child.pid,
        ...(outcome.kind === "result" ? { ok: outcome.result.ok, files: outcome.result.files, stages: outcome.result.stages } : { ok: false, escalation: outcome.reason }),
        runMs: performance.now() - attempt.startedAt });
      if (attempt.state !== "RUNNING") return;
      attempt.state = "RESULT_RECEIVED";
      this.arm(attempt, this.exitGraceMs, () => {
        attempt.forcedExit = true;
        this.options.onEvent?.({ type: "forced-exit", workspaceId: entry.hint.workspaceId, pid: child.pid });
        this.kill(entry, attempt);
      });
    }, error => {
      resultSettled = true;
      this.terminate(entry, attempt, error instanceof Error ? error.message : String(error));
    });
    // ChildProcess may emit "error" more than once (spawn, kill, send).
    child.on("error", error => this.terminate(entry, attempt, error.message));
    child.once("exit", () => { attempt.exited = true; });
    child.once("close", (code, signal) => {
      const finish = () => this.closed(entry, attempt, code, signal);
      // Only a child that exited on its own may still have a result in flight.
      if (resultSettled || attempt.state === "REAPING") { finish(); return; }
      const timer = setTimeout(finish, RESULT_AFTER_CLOSE_MS);
      void settledResult.then(() => { clearTimeout(timer); finish(); });
    });
    this.arm(attempt, JOB_MS[attempt.kind], () => this.terminate(entry, attempt, `${attempt.kind} build deadline exceeded`));
    if (this.stopped) this.terminate(entry, attempt, "scheduler stopped");
  }

  private arm(attempt: Attempt, ms: number, action: () => void): void {
    const timer = setTimeout(() => { attempt.timers.delete(timer); if (!attempt.closed) action(); }, ms);
    attempt.timers.add(timer);
  }

  private terminate(entry: Entry, attempt: Attempt, error: string): void {
    if (entry.attempt !== attempt || attempt.closed) return;
    // After a durable result, ending the process is a forced exit, not a failure.
    if (attempt.outcome) attempt.forcedExit = true;
    else attempt.failure ??= error;
    this.kill(entry, attempt);
  }

  /** Only the actual close frees the slot; a kill that is not reaped in time is reported, never assumed. */
  private kill(entry: Entry, attempt: Attempt): void {
    if (attempt.closed) return;
    if (attempt.state !== "REAPING") {
      attempt.state = "REAPING";
      this.arm(attempt, this.reapWatchMs, () => {
        attempt.reapOverdue = true;
        this.options.onEvent?.({ type: "reap-overdue", workspaceId: entry.hint.workspaceId, pid: attempt.child?.pid, exited: attempt.exited });
      });
    }
    if (!attempt.child || attempt.killSent) return;
    attempt.killSent = true;
    attempt.child.kill("SIGKILL");
  }

  private closed(entry: Entry, attempt: Attempt, code: number | null, signal: NodeJS.Signals | null): void {
    if (attempt.closed) return;
    attempt.closed = true;
    for (const timer of attempt.timers) clearTimeout(timer);
    attempt.timers.clear();
    this.options.onEvent?.({ type: "closed", workspaceId: entry.hint.workspaceId, kind: attempt.kind, pid: attempt.child?.pid, code, signal,
      runMs: performance.now() - attempt.startedAt, ...(attempt.failure ? { failure: attempt.failure } : {}), ...(attempt.forcedExit ? { forcedExit: true } : {}) });
    this.release(attempt.selection);
    if (entry.attempt !== attempt) return;
    const outcome = attempt.outcome;
    if (!outcome || attempt.failure || (code !== 0 && !attempt.forcedExit)) {
      this.complete(entry, { ok: false, error: attempt.failure ?? `builder exited ${code ?? signal} without a successful result` });
      return;
    }
    if (outcome.kind === "needs-full") {
      if (attempt.kind === "full" || entry.escalated) { this.complete(entry, { ok: false, error: "full builder requested another full" }); return; }
      if (this.stopped) { this.complete(entry, { ok: false, error: "scheduler stopped" }); return; }
      this.active.delete(entry.hint.workspaceId);
      entry.attempt = undefined;
      entry.captures = outcome.captures;
      entry.escalated = true;
      entry.hint.kind = "full";
      entry.queuedAt = performance.now();
      const pending = this.queue.find(item => item.hint.workspaceId === entry.hint.workspaceId);
      if (pending) {
        this.mergeHint(entry, pending.hint, pending.changes);
        entry.waiters.push(...pending.waiters);
        this.queue.splice(this.queue.indexOf(pending), 1);
        pending.reaped();
      }
      this.queue.push(entry);
      this.schedule();
      return;
    }
    this.complete(entry, { ok: outcome.result.ok, result: outcome.result, baseId: entry.baseId,
      ...(outcome.result.error ? { error: outcome.result.error } : {}), ...(attempt.forcedExit ? { forcedExit: true } : {}) });
  }

  private complete(entry: Entry, result: BuildCompletion): void {
    if (this.active.get(entry.hint.workspaceId) === entry) this.active.delete(entry.hint.workspaceId);
    for (const resolve of entry.waiters.splice(0)) resolve(result);
    entry.reaped();
    this.schedule();
  }
}

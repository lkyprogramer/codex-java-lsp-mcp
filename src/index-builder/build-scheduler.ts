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
export type BuildAttempt = { child: ChildProcess; result: Promise<BuildOutcome> };
export type BuildSelection = {
  kind: BuildKind;
  baseId?: string;
  start(grant: BuildGrant): BuildAttempt;
};
export type BuildCompletion = { ok: boolean; error?: string; result?: BuilderJobResult; baseId?: string };
export type BuildSchedulerOptions = {
  /** Select from the owner's current bindings at admission, never from a queued CURRENT path. */
  select(hint: Readonly<BuildHint>): BuildSelection;
};

type Change = { deleted: boolean; generation: number };
type Entry = {
  hint: BuildHint;
  order: number;
  changes: Map<string, Change>;
  waiters: Array<(result: BuildCompletion) => void>;
  captures: readonly SourceCapture[];
  escalated?: boolean;
  state: "RUNNING" | "RESULT_RECEIVED" | "REAPING";
  kind: BuildKind;
  child?: ChildProcess;
  outcome?: BuildOutcome;
  failure?: string;
  baseId?: string;
  timer?: NodeJS.Timeout;
  done: Promise<void>;
  reaped(): void;
};

const PARSERS_PER_BUILDER = 2;
const JOB_MS = { delta: 60_000, full: 1_230_000 };

/** Owner-scoped scheduling primitive. Transport/bindings switch to it in MAC-08;
 * the process adapter must use the grant, and must report escalation before doing a full. */
export class BuildScheduler {
  private readonly queue: Entry[] = [];
  private readonly active = new Map<string, Entry>();
  private order = 0;
  private pumping = false;
  private stopped = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly options: BuildSchedulerOptions) {}

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
        entry = { hint: { ...hint }, order: this.order++, changes: new Map(), waiters: [], captures: [],
          state: "RUNNING", kind: hint.kind, done, reaped };
        this.queue.push(entry);
      }
      this.mergeHint(entry, hint);
      entry.waiters.push(resolve);
      this.schedule();
    });
  }

  status() {
    const jobs = [...this.active.values()].map(entry => ({ workspaceId: entry.hint.workspaceId,
      kind: entry.kind, state: entry.state, pid: entry.child?.pid, baseId: entry.baseId }));
    return { stopped: this.stopped, builders: jobs.length, full: jobs.filter(job => job.kind === "full").length,
      parserTokens: jobs.length * PARSERS_PER_BUILDER, queued: this.queue.length, jobs };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    for (const entry of this.queue.splice(0)) this.complete(entry, { ok: false, error: "scheduler stopped" });
    const running = [...this.active.values()];
    for (const entry of running) {
      entry.failure = "scheduler stopped";
      entry.state = "REAPING";
      entry.child?.kill("SIGKILL");
    }
    this.stopPromise = Promise.all(running.map(entry => entry.done)).then(() => undefined);
    return this.stopPromise;
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

  private pump(): void {
    const considered = new Set<Entry>();
    while (!this.stopped && this.active.size < 2) {
      const fullBusy = this.status().full !== 0;
      const eligible = this.queue.filter(entry => !considered.has(entry) && !this.active.has(entry.hint.workspaceId)
        && (entry.hint.kind !== "full" || !fullBusy));
      // Once a full exits, an older waiting full gets the newly free slot.
      eligible.sort((a, b) => Number(b.hint.kind === "full") - Number(a.hint.kind === "full") || a.order - b.order);
      const entry = eligible[0];
      if (!entry) return;
      considered.add(entry);
      this.queue.splice(this.queue.indexOf(entry), 1);
      entry.kind = entry.hint.kind;
      entry.state = "RUNNING";
      this.active.set(entry.hint.workspaceId, entry);
      try {
        const selection = this.options.select(entry.hint);
        if (this.stopped) { this.complete(entry, { ok: false, error: "scheduler stopped" }); continue; }
        if (entry.escalated && selection.kind !== "full") throw new Error("escalated build requires a full selection");
        if (selection.kind === "full" && fullBusy) {
          this.active.delete(entry.hint.workspaceId);
          entry.hint.kind = "full";
          this.queue.push(entry);
          continue; // Discard this selection: admission must select the then-current base again.
        }
        entry.kind = selection.kind;
        entry.baseId = selection.baseId;
        const attempt = selection.start({ parserTokens: PARSERS_PER_BUILDER, captures: entry.captures });
        entry.child = attempt.child;
        entry.child.once("error", error => this.terminate(entry, error.message));
        entry.child.once("close", (code, signal) => this.closed(entry, code, signal));
        attempt.result.then(outcome => {
          if (this.active.get(entry.hint.workspaceId) !== entry) return;
          entry.outcome = outcome;
          if (!entry.failure) entry.state = "RESULT_RECEIVED";
        }, error => this.terminate(entry, error instanceof Error ? error.message : String(error)));
        entry.timer = setTimeout(() => this.terminate(entry, `${entry.kind} build deadline exceeded`), JOB_MS[entry.kind]);
        if (this.stopped) this.terminate(entry, "scheduler stopped");
      } catch (error) {
        this.complete(entry, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private terminate(entry: Entry, error: string): void {
    if (this.active.get(entry.hint.workspaceId) !== entry) return;
    entry.failure ??= error;
    entry.state = "REAPING";
    entry.child?.kill("SIGKILL");
  }

  private closed(entry: Entry, code: number | null, signal: NodeJS.Signals | null): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.failure || code !== 0 || !entry.outcome) {
      this.complete(entry, { ok: false, error: entry.failure ?? `builder exited ${code ?? signal} without a successful result` });
      return;
    }
    const outcome = entry.outcome;
    if (outcome.kind === "needs-full") {
      if (entry.kind === "full" || entry.escalated) { this.complete(entry, { ok: false, error: "full builder requested another full" }); return; }
      this.active.delete(entry.hint.workspaceId);
      entry.child = undefined;
      entry.outcome = undefined;
      entry.captures = outcome.captures;
      entry.escalated = true;
      entry.hint.kind = "full";
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
      ...(outcome.result.error ? { error: outcome.result.error } : {}) });
  }

  private complete(entry: Entry, result: BuildCompletion): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (this.active.get(entry.hint.workspaceId) === entry) this.active.delete(entry.hint.workspaceId);
    for (const resolve of entry.waiters.splice(0)) resolve(result);
    entry.reaped();
    this.schedule();
  }
}

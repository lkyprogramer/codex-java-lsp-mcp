// input: builder jobs for one mutable development index database.
// output: each job run by its own one-shot build process (build-process.ts), serialized; a delta
//         that needs a full is rerun as a full.
// pos: Tests, benchmarks and offline tools only. The production call graph builds through the
//      owner's BuildScheduler (index-owner.ts); nothing here is reachable from the daemon or stdio.
import { once } from "node:events";
import { startBuildProcess } from "../index-builder/build-process.js";
import type { BuilderJob, BuilderJobResult } from "../index-builder/incremental.js";

export type LocalBuilderJob = { id?: number; kind: "refresh" | "resources" | "reconcile"; generation?: number; changed?: string[]; deleted?: string[] };
export type LocalBuilderResult = { id: number; ok: boolean; indexedGeneration: number; files: number; error?: string };
export type LocalBuilderState = "idle" | "busy" | "cold-building";
export type LocalBuilderStatus = { state: LocalBuilderState; pid?: number; queued: number };

const DEFAULT_PARALLELISM = 4;

/** One job at a time; every job is a fresh process that writes the database and exits. */
export class LocalBuilder {
  private nextId = 1;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private running?: { pid?: number; cold: boolean };
  private stopped = false;
  private readonly children = new Set<import("node:child_process").ChildProcess>();

  constructor(private readonly options: { repoRoot: string; dbPath: string; parallelism?: number; env?: NodeJS.ProcessEnv }) {}

  status(): LocalBuilderStatus {
    const pid = this.running?.pid;
    const state: LocalBuilderState = this.running ? this.running.cold ? "cold-building" : "busy" : "idle";
    return { state, ...(pid !== undefined ? { pid } : {}), queued: this.queued };
  }

  /** A full build of the whole repository. */
  async coldBuild(): Promise<void> {
    const result = await this.enqueue({ kind: "full", generation: 1 }, true);
    if (!result.ok) throw new Error(result.error ?? "cold build failed");
  }

  submit(job: LocalBuilderJob): Promise<LocalBuilderResult> {
    return this.enqueue(job, false);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const child of this.children) child.kill("SIGKILL");
    await this.tail.catch(() => undefined);
  }

  private enqueue(job: BuilderJob, cold: boolean): Promise<LocalBuilderResult> {
    const id = job.id ?? this.nextId++;
    this.queued += 1;
    const run = this.tail.then(async () => {
      this.queued -= 1;
      if (this.stopped) return failed(id, "builder stopped");
      this.running = { cold };
      try {
        const first = await this.runOnce({ ...job, id });
        // A delta that needs a full reports it without writing; the full then rebuilds everything.
        return first.escalation !== undefined ? await this.runOnce({ kind: "full", generation: job.generation, id }) : first;
      } catch (error) {
        return failed(id, error instanceof Error ? error.message : String(error));
      } finally {
        this.running = undefined;
      }
    });
    this.tail = run.catch(() => undefined);
    return run.then(result => ({ id, ok: result.ok, indexedGeneration: result.indexedGeneration, files: result.files,
      ...(result.error !== undefined ? { error: result.error } : {}) }));
  }

  private async runOnce(job: BuilderJob): Promise<BuilderJobResult & { escalation?: string }> {
    const attempt = startBuildProcess({ repoRoot: this.options.repoRoot, dbPath: this.options.dbPath, job,
      grant: { parserTokens: this.options.parallelism ?? DEFAULT_PARALLELISM, captures: [] }, env: this.options.env });
    this.children.add(attempt.child);
    if (this.running) this.running.pid = attempt.child.pid;
    const closed = once(attempt.child, "close").catch(() => undefined);
    try {
      const outcome = await Promise.race([
        attempt.result,
        closed.then(() => { throw new Error("builder exited without a result"); })
      ]);
      return outcome.kind === "needs-full"
        ? { id: job.id ?? -1, ok: false, indexedGeneration: 0, files: 0, escalation: outcome.reason }
        : outcome.result;
    } finally {
      await closed;
      this.children.delete(attempt.child);
    }
  }
}

function failed(id: number, error: string): BuilderJobResult {
  return { id, ok: false, indexedGeneration: 0, files: 0, error };
}

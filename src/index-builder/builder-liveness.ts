// input: the builder's stage transitions and progress commits.
// output: one liveness line per second on an inherited pipe, written by a separate thread.
// pos: contract §2.6 heartbeat. The builder's main thread may sit in one long synchronous SQL step;
//      liveness comes from a coordinator thread, the work counter from real progress, kept apart so a
//      heartbeat never hides a stage that makes no progress.
import { Worker } from "node:worker_threads";

/** Stage names reported by the builders' onStage seams; anything else is "other". */
const STAGES = ["start", "capture", "parse-declare", "resolve", "graph-search", "publication-metadata", "resource-capture-parse", "resource-graph-search", "other"];
const STAGE = 0, WORK = 1;

let shared: Int32Array | undefined;

/** One unit of real progress (a committed batch). A no-op outside a builder with liveness. */
export function noteBuilderWork(): void {
  if (shared) Atomics.add(shared, WORK, 1);
}

/** The stage the builder has just finished; a stage transition is progress too. */
export function noteBuilderStage(name: string): void {
  if (!shared) return;
  const index = STAGES.indexOf(name);
  Atomics.store(shared, STAGE, index < 0 ? STAGES.length - 1 : index);
  Atomics.add(shared, WORK, 1);
}

/** Start the coordinator thread writing `{seq, at, stage, work}` lines to `fd` every `intervalMs` (at most 1 Hz). */
export function startBuilderLiveness(fd: number, intervalMs = 1000): () => Promise<void> {
  if (shared) throw new Error("builder liveness already started");
  shared = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(`
    const { workerData } = require("node:worker_threads");
    const { writeSync } = require("node:fs");
    const view = new Int32Array(workerData.buffer);
    let seq = 0;
    let timer;
    const beat = () => {
      const line = JSON.stringify({ seq: ++seq, at: Date.now(), stage: workerData.stages[Atomics.load(view, 0)], work: Atomics.load(view, 1) }) + "\\n";
      try { writeSync(workerData.fd, line); } catch { clearInterval(timer); }
    };
    beat();
    timer = setInterval(beat, workerData.intervalMs);
  `, { eval: true, workerData: { buffer: shared.buffer, fd, intervalMs: Math.max(1000, intervalMs), stages: STAGES } });
  worker.unref();
  worker.on("error", () => undefined);
  return async () => { await worker.terminate(); };
}

import { Worker } from "node:worker_threads";
import type { JavaFileBundle } from "../java-index/index-types.js";
import type { parseJavaSourceFile } from "../java-index/java-index-file-parse.js";

export type ParseArgs = Omit<Parameters<typeof parseJavaSourceFile>[0], "backend" | "cache">;
export type ParseOutcome = { bundle: JavaFileBundle } | { error: Error };

/**
 * parseJavaSourceFile for each input on `workers` threads, each with its own parser: outcomes in
 * input order, so callers see what a serial loop would. A failed parse is that input's outcome
 * (its message and errno code); a dead worker rejects the whole call.
 */
export async function parseOffThread(inputs: readonly ParseArgs[], workers: number, onDone?: (done: number) => void): Promise<ParseOutcome[]> {
  const outcomes = new Array<ParseOutcome>(inputs.length);
  let next = 0, done = 0;
  const pool = Array.from({ length: Math.min(Math.max(1, workers), inputs.length) },
    () => new Worker(new URL("./parse-worker.js", import.meta.url), { execArgv: ["--disable-warning=ExperimentalWarning"] }));
  try {
    await Promise.all(pool.map(worker => new Promise<void>((resolve, reject) => {
      const send = () => {
        if (next >= inputs.length) { resolve(); return; }
        const id = next++;
        worker.postMessage({ id, args: inputs[id] });
      };
      worker.on("message", (reply: { id: number; bundle?: JavaFileBundle; error?: string; code?: string }) => {
        outcomes[reply.id] = reply.error !== undefined ? { error: Object.assign(new Error(reply.error), reply.code ? { code: reply.code } : {}) } : { bundle: reply.bundle! };
        // A listener that throws would be an uncaught exception, not this call's rejection.
        try { onDone?.(++done); } catch (error) { reject(error); return; }
        send();
      });
      worker.on("error", reject);
      worker.on("exit", code => reject(new Error(`parse worker exited ${code}`)));
      send();
    })));
  } finally {
    await Promise.all(pool.map(worker => worker.terminate()));
  }
  return outcomes;
}

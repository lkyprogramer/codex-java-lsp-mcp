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
  let next = 0, done = 0, failed = false;
  const pool = Array.from({ length: Math.min(Math.max(1, workers), inputs.length) },
    () => new Worker(new URL("./parse-worker.js", import.meta.url), { execArgv: ["--disable-warning=ExperimentalWarning"] }));
  // Each worker's in-flight parse. Terminating a worker inside a native parser
  // call aborts the whole process (an uncaught Napi::Error), so a failed call
  // stops dispatching and lets every in-flight parse finish first.
  const inFlight = pool.map(() => Promise.resolve());
  try {
    await Promise.all(pool.map((worker, index) => new Promise<void>((resolve, reject) => {
      let settle: (() => void) | undefined;
      const idle = () => { settle?.(); settle = undefined; };
      const fail = (error: unknown) => { failed = true; reject(error); };
      const send = () => {
        if (failed || next >= inputs.length) { resolve(); return; }
        const id = next++;
        inFlight[index] = new Promise<void>(release => { settle = release; });
        worker.postMessage({ id, args: inputs[id] });
      };
      worker.on("message", (reply: { id: number; bundle?: JavaFileBundle; error?: string; code?: string }) => {
        idle();
        outcomes[reply.id] = reply.error !== undefined ? { error: Object.assign(new Error(reply.error), reply.code ? { code: reply.code } : {}) } : { bundle: reply.bundle! };
        // A listener that throws would be an uncaught exception, not this call's rejection.
        try { onDone?.(++done); } catch (error) { fail(error); return; }
        send();
      });
      worker.on("error", error => { idle(); fail(error); });
      worker.on("exit", code => { idle(); fail(new Error(`parse worker exited ${code}`)); });
      send();
    })));
  } finally {
    await Promise.all(inFlight);
    await Promise.all(pool.map(worker => worker.terminate()));
  }
  return outcomes;
}

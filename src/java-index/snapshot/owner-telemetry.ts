// input: IndexOwner lifecycle events (rounds, scheduler, pool, GC, builder liveness).
// output: one JSONL record per event, stamped with epoch and monotonic ms and the owner pid, plus a
//         `process` record every PROCESS_SAMPLE_MS (RSS/heap and the event loop's delay over that window).
// pos: MAC-11 lifecycle telemetry (§5.3 jobs/timeline). Isolated validation only: the file is named by
//      JAVA_LSP_OWNER_TELEMETRY and honoured only under JAVA_LSP_ISOLATED_VALIDATION=1.
import { createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { OwnerEvent } from "./index-owner.js";

const PROCESS_SAMPLE_MS = 5000;
/** One sink (one stream, one sampler) per file per process, however often the owner factory is built. */
const sinks = new Map<string, (event: OwnerEvent) => void>();

/** The sink for this process, or undefined when no telemetry was asked for. */
export function ownerTelemetrySink(env: NodeJS.ProcessEnv = process.env): ((event: OwnerEvent) => void) | undefined {
  const file = env.JAVA_LSP_OWNER_TELEMETRY;
  if (!file || env.JAVA_LSP_ISOLATED_VALIDATION !== "1") return undefined;
  if (!path.isAbsolute(file)) throw new Error("JAVA_LSP_OWNER_TELEMETRY must be absolute");
  const existing = sinks.get(file);
  if (existing) return existing;
  let stream: WriteStream | undefined = createWriteStream(file, { flags: "a" });
  // A failing telemetry file never fails the owner: it stops recording.
  stream.on("error", () => { stream = undefined; });
  const pid = process.pid;
  const write = (event: object) => {
    stream?.write(`${JSON.stringify({ at: Date.now(), mono: performance.timeOrigin + performance.now(), pid, ...event })}\n`);
  };
  // Inherited MAC-11 measurements: publish stalls show as event-loop delay, cache growth as RSS.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const ms = (nanos: number) => Math.round(nanos / 1e4) / 100;
  setInterval(() => {
    const memory = process.memoryUsage();
    write({ type: "process", rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external,
      loop: { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) } });
    loop.reset();
  }, PROCESS_SAMPLE_MS).unref();
  sinks.set(file, write);
  return write;
}

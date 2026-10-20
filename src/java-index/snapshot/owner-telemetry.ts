// input: IndexOwner lifecycle events (rounds, scheduler, pool, GC, builder liveness).
// output: one JSONL record per event, stamped with epoch and monotonic ms and the owner pid, plus a
//         `process` record every PROCESS_SAMPLE_MS (RSS/heap, process CPU, GC pauses and the event loop's
//         delay over that window); a window whose loop stalled past STALL_PROFILE_MS also leaves its CPU
//         profile next to the telemetry file.
// pos: MAC-11 lifecycle telemetry (§5.3 jobs/timeline). Isolated validation only: the file is named by
//      JAVA_LSP_OWNER_TELEMETRY and honoured only under JAVA_LSP_ISOLATED_VALIDATION=1.
import { createWriteStream, writeFile, type WriteStream } from "node:fs";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver, constants } from "node:perf_hooks";
import type { OwnerEvent } from "./index-owner.js";

const PROCESS_SAMPLE_MS = 5000;
/** A window whose event loop stalled this long keeps its CPU profile (sampled every PROFILE_INTERVAL_US). */
const STALL_PROFILE_MS = 1500;
const PROFILE_INTERVAL_US = 10_000;
const MAX_STALL_PROFILES = 40;
const GC_KINDS: Record<number, string> = {
  [constants.NODE_PERFORMANCE_GC_MAJOR]: "major", [constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental", [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb"
};
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
  // Inherited MAC-11 measurements: publish stalls show as event-loop delay, cache growth as RSS. CPU time against
  // the window tells a busy stall (JS or GC on some thread) from a blocked or descheduled one; GC pauses are per kind.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let gc = { count: 0, totalMs: 0, maxMs: 0, maxKind: "" };
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const kind = GC_KINDS[(entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind ?? -1] ?? "other";
      gc.count += 1; gc.totalMs += entry.duration;
      if (entry.duration > gc.maxMs) gc = { ...gc, maxMs: entry.duration, maxKind: kind };
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const profiler = stallProfiler(file, write);
  const ms = (nanos: number) => Math.round(nanos / 1e4) / 100;
  const round = (value: number) => Math.round(value * 100) / 100;
  let cpu = process.cpuUsage();
  setInterval(() => {
    const memory = process.memoryUsage();
    const used = process.cpuUsage(cpu);
    cpu = process.cpuUsage();
    const max = ms(loop.max);
    write({ type: "process", rss: memory.rss, heapUsed: memory.heapUsed, external: memory.external,
      loop: { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max },
      cpu: { userMs: Math.round(used.user / 1000), systemMs: Math.round(used.system / 1000) },
      gc: { count: gc.count, totalMs: round(gc.totalMs), maxMs: round(gc.maxMs), maxKind: gc.maxKind } });
    loop.reset();
    gc = { count: 0, totalMs: 0, maxMs: 0, maxKind: "" };
    void profiler?.(max >= STALL_PROFILE_MS);
  }, PROCESS_SAMPLE_MS).unref();
  sinks.set(file, write);
  return write;
}

/**
 * A rolling V8 CPU profile of the owner thread: each window's profile is dropped unless that window stalled, then
 * written as `<telemetry>.stall-<epoch ms>.cpuprofile`. The sampler interrupts the thread, so a synchronous stall is
 * sampled too. Any inspector failure turns profiling off; it never fails the owner.
 */
function stallProfiler(file: string, write: (event: object) => void): ((stalled: boolean) => Promise<void>) | undefined {
  let session: Session | undefined = new Session();
  let kept = 0;
  let busy = false;
  const off = () => { try { session?.disconnect(); } catch { /* already gone */ } session = undefined; };
  try {
    session.connect();
  } catch {
    session = undefined;
    return undefined;
  }
  const start = async () => {
    await session?.post("Profiler.enable");
    await session?.post("Profiler.setSamplingInterval", { interval: PROFILE_INTERVAL_US });
    await session?.post("Profiler.start");
  };
  start().catch(off);
  return async stalled => {
    if (!session || busy) return;
    busy = true;
    try {
      const { profile } = await session.post("Profiler.stop");
      if (stalled && kept < MAX_STALL_PROFILES) {
        kept += 1;
        const out = `${file}.stall-${Date.now()}.cpuprofile`;
        writeFile(out, JSON.stringify(profile), () => undefined);
        write({ type: "stall-profile", file: path.basename(out) });
      }
      await session.post("Profiler.start");
    } catch {
      off();
    } finally {
      busy = false;
    }
  };
}

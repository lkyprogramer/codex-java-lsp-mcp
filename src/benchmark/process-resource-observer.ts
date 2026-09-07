// input: An opt-in benchmark resource sidecar path and request-local queue observations.
// output: In-process Node memory/CPU/event-loop/GC samples without affecting normal MCP requests.
// pos: V3.2-05 benchmark-only telemetry; never loaded by the production server.
import { randomUUID } from "node:crypto";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay, PerformanceObserver, performance } from "node:perf_hooks";
export type JavaIndexPresence = "PRESENT" | "NOT_PRESENT";
export type BenchmarkProcessResourceObserverOptions = { outputFile?: string; intervalMs?: number; profile: string; javaIndex: JavaIndexPresence; isolated?: boolean };
export type BenchmarkProcessResourceHandle = { recordQueueDepth(source: string, depth: number): void; stop(): Promise<Record<string, unknown>> };
type Sample = { tMs: number; rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number;
  arrayBuffersBytes: number; cpuUserMicros: number; cpuSystemMicros: number };
type GcAggregate = { count: number; durationMs: number };
export function startBenchmarkProcessResourceObserver(options: BenchmarkProcessResourceObserverOptions): BenchmarkProcessResourceHandle | undefined {
  if (!options.outputFile) return undefined;
  const isolated = options.isolated ?? process.env.JAVA_LSP_ISOLATED_VALIDATION === "1";
  if (!isolated) throw new Error("in-process resource telemetry is allowed only inside isolated validation");
  const intervalMs = positiveInteger(options.intervalMs ?? 100);
  const outputFile = path.resolve(options.outputFile);
  const startedAt = performance.now();
  const initialCpu = process.cpuUsage();
  const samples: Sample[] = [];
  const queueDepths = new Map<string, { count: number; max: number }>();
  const gcByKind = new Map<number, GcAggregate>();
  let gcCount = 0;
  let gcDurationMs = 0;
  let stopped = false;
  const eventLoop = monitorEventLoopDelay({ resolution: Math.max(1, Math.min(20, intervalMs)) });
  eventLoop.enable();
  const gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      const detail = (entry as PerformanceEntry & { detail?: { kind?: number }; kind?: number });
      const kind = detail.detail?.kind ?? detail.kind ?? 0;
      const aggregate = gcByKind.get(kind) ?? { count: 0, durationMs: 0 };
      aggregate.count += 1; aggregate.durationMs += entry.duration;
      gcByKind.set(kind, aggregate);
      gcCount += 1; gcDurationMs += entry.duration;
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });
  const sample = (): void => {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(initialCpu);
    samples.push({ tMs: round(performance.now() - startedAt), rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system });
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    recordQueueDepth(source, depth) {
      if (stopped || !source || !Number.isInteger(depth) || depth < 0) return;
      const aggregate = queueDepths.get(source) ?? { count: 0, max: 0 };
      aggregate.count += 1;
      aggregate.max = Math.max(aggregate.max, depth);
      queueDepths.set(source, aggregate);
    },
    async stop() {
      if (stopped) throw new Error("benchmark resource observer already stopped");
      stopped = true; clearInterval(timer); sample();
      eventLoop.disable(); gcObserver.disconnect();
      const queueObservation = options.javaIndex === "NOT_PRESENT"
        ? { status: "NOT_APPLICABLE", reason: "this benchmark profile does not create JavaIndex" }
        : queueDepths.size > 0
          ? { status: "MEASURED", sources: sortedEntries(queueDepths) }
          : { status: "UNMEASURED", reason: "no JavaIndex queue-depth observation was emitted" };
      const payload = {
        schemaVersion: "java-intelligence-v32-in-process-resources/v1",
        generatedAt: new Date().toISOString(), profile: options.profile,
        process: { pid: process.pid, node: process.version, platform: process.platform, arch: process.arch },
        configuration: { intervalMs },
        observations: {
          memory: { status: "MEASURED" }, cpu: { status: "MEASURED", unit: "microseconds since observer start" },
          eventLoopDelay: eventLoopObservation(eventLoop),
          gc: gcObservation(gcByKind, gcCount, gcDurationMs), queueDepth: queueObservation
        },
        summary: summarizeInProcessSamples(samples), samples
      };
      await writeJsonWithoutOverwrite(outputFile, payload);
      return payload;
    }
  };
}
export function startBenchmarkProcessResourceObserverFromEnvironment(
  profile: string,
  javaIndex: JavaIndexPresence,
  env: NodeJS.ProcessEnv = process.env
): BenchmarkProcessResourceHandle | undefined {
  const intervalMs = env.JAVA_LSP_RESOURCE_INTERVAL_MS ? Number(env.JAVA_LSP_RESOURCE_INTERVAL_MS) : undefined;
  return startBenchmarkProcessResourceObserver({
    outputFile: env.JAVA_LSP_RESOURCE_TELEMETRY_FILE,
    intervalMs,
    profile,
    javaIndex
  });
}
export function summarizeInProcessSamples(samples: readonly Sample[]): Record<string, number | undefined> {
  if (samples.length === 0) {
    return { sampleCount: 0, peakRssBytes: undefined, peakHeapUsedBytes: undefined, cpuUserMicros: undefined, cpuSystemMicros: undefined };
  }
  const last = samples[samples.length - 1]!;
  return {
    sampleCount: samples.length, peakRssBytes: Math.max(...samples.map(sample => sample.rssBytes)),
    peakHeapUsedBytes: Math.max(...samples.map(sample => sample.heapUsedBytes)),
    cpuUserMicros: last.cpuUserMicros, cpuSystemMicros: last.cpuSystemMicros
  };
}
function eventLoopObservation(eventLoop: ReturnType<typeof monitorEventLoopDelay>): Record<string, unknown> {
  const count = Number(eventLoop.count);
  if (count === 0) return { status: "UNMEASURED", reason: "event-loop histogram collected no samples" };
  return {
    status: "MEASURED", unit: "milliseconds", count, min: finiteNanoseconds(eventLoop.min),
    max: finiteNanoseconds(eventLoop.max), mean: finiteNanoseconds(eventLoop.mean), p50: finiteNanoseconds(eventLoop.percentile(50)),
    p95: finiteNanoseconds(eventLoop.percentile(95)), p99: finiteNanoseconds(eventLoop.percentile(99))
  };
}
function gcObservation(gcByKind: ReadonlyMap<number, GcAggregate>, count: number, durationMs: number): Record<string, unknown> {
  return {
    status: "MEASURED", count, durationMs: round(durationMs),
    byKind: Object.fromEntries([...gcByKind.entries()].sort(([left], [right]) => left - right)
      .map(([kind, value]) => [String(kind), { count: value.count, durationMs: round(value.durationMs) }]))
  };
}
function sortedEntries<T>(values: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries([...values.entries()].sort(([left], [right]) => left.localeCompare(right)));
}
async function writeJsonWithoutOverwrite(target: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
function finiteNanoseconds(value: number): number | undefined { return Number.isFinite(value) ? round(value / 1_000_000) : undefined; }
function positiveInteger(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error("resource interval must be a positive integer");
  return value;
}
function round(value: number): number { return Math.round(Math.max(0, value) * 1000) / 1000; }

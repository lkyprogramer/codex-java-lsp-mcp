// input: a synthetic repository (--files N), sample count, concurrency steps and an output directory.
// output: query-request-load-report.json - per step: request-path latency (public tool call in -> reply out),
//         the owner process's event-loop delay, query-pool queue peak, workers and leases, previews served,
//         and a with-updates step during which tracker publishes land while requests hold their views.
// pos: MAC-08C K29 driver. Every sample is one public java_symbol call through createMcpServer ->
//      RepoRuntimeManager -> one request view (one acquire, a snapshot lease) -> persistent query workers
//      over IPC -> head previews. It replaces the R09 driver (measure-query-load.ts), whose SQL ran on an
//      in-process worker thread and never passed the request view or the query pool.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AliasRegistry } from "../alias-registry.js";
import { JavaLspApplication } from "../application.js";
import { createMcpServer } from "../mcp-server-factory.js";
import { RepoResolver } from "../repo-resolver.js";
import { RepoRuntimeManager } from "../repo-runtime-manager.js";
import { IndexOwner, type PublishEvent } from "../java-index/snapshot/index-owner.js";
import { FSEVENT_FLAGS, type TrackerSourceFactory } from "../java-index/snapshot/workspace-tracker.js";
import { generateRepo, type LoadQuery } from "./measure-query-load.js";

export const REQUEST_LOAD_PROTOCOL = "k29-request-path-v1";
const FILE_MODIFIED = 0x1000 | FSEVENT_FLAGS.ItemIsFile;

type RequestLoadArgs = { files: number; samples: number; steps: number[]; updateIntervalMs: number; output: string; readyTimeoutMs: number };

export function parseRequestLoadArgs(argv: string[]): RequestLoadArgs {
  const value = (name: string) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
  const files = Number(value("--files") ?? 1000);
  const samples = Number(value("--samples") ?? 100);
  const steps = (value("--steps") ?? "1,5,20").split(",").map(Number);
  const updateIntervalMs = Number(value("--update-interval-ms") ?? 200);
  const readyTimeoutMs = Number(value("--ready-timeout-ms") ?? 300_000);
  const output = value("--output");
  if (!output) throw new Error("--output is required");
  if (!Number.isInteger(files) || files < 1 || !Number.isInteger(samples) || samples < 1 || steps.some(step => !Number.isInteger(step) || step < 1)
    || !(updateIntervalMs > 0) || !(readyTimeoutMs > 0)) {
    throw new Error("invalid --files/--samples/--steps/--update-interval-ms/--ready-timeout-ms");
  }
  return { files, samples, steps, updateIntervalMs, output: path.resolve(output), readyTimeoutMs };
}

/** Signals are injected: the corpus is generated here, and edits are made and announced by the driver. */
function injectedSource(): { factory: TrackerSourceFactory; emit(file: string): void } {
  let onSignal: ((flags: number, file: string) => void) | undefined;
  return {
    factory: async listener => {
      onSignal = listener;
      return { epoch: randomBytes(16).toString("hex"), fence: async () => {}, stop: async () => {}, closed: new Promise<void>(() => {}) };
    },
    emit: file => {
      if (!onSignal) throw new Error("tracker source not started");
      onSignal(FILE_MODIFIED, file);
    }
  };
}

type PoolProbe = { submits: number; queuePeak: number; workersPeak: number; pids: Set<number> };

export type RequestStepReport = {
  concurrency: number;
  requests: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  byKind: Record<string, { n: number; p50: number; p95: number; p99: number }>;
  eventLoopDelayMs: { p50: number; p95: number; p99: number; max: number };
  rawLatencies: Array<{ sample: number; round: number; slot: number; kind: string; ms: number; scopeState: string; stopReason: string; previews: number; error?: string }>;
  errors: number;
  previews: number;
  scopeStates: Record<string, number>;
  stopReasons: Record<string, number>;
  /** Query-pool counters for this step: every request reaches the pool at least once. */
  worker: { queuePeak: number; submits: number; workersPeak: number; pids: number[]; leasesAfter: number };
  /** Tracker publishes that landed while this step's requests were running. */
  publishes: number;
  edits: number;
  /** After the step: nothing queued, acquiring or running in the pool, and no request in the application. */
  settled: boolean;
  wallMs: number;
};

const QUERIES: LoadQuery[] = [
  { kind: "rare-fqn", mode: "exact", query: "com.synth.p00000.Service00000" },
  { kind: "common-word", mode: "text", query: "order" },
  { kind: "broad", mode: "text", query: "order refund ledger payment" },
  { kind: "fuzzy", mode: "auto", query: "refundOrder" }
];

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const summary = (values: number[]) => ({ p50: round3(percentile(values, 50)), p95: round3(percentile(values, 95)), p99: round3(percentile(values, 99)), max: round3(Math.max(0, ...values)) });

type Harness = {
  client: Client;
  owner: IndexOwner;
  application: JavaLspApplication;
  repoRoot: string;
  files: string[];
  probe: PoolProbe;
  publishes: PublishEvent[];
  emit(file: string): void;
};

async function callSymbol(harness: Harness, query: LoadQuery): Promise<{ ms: number; scopeState: string; stopReason: string; previews: number; error?: string }> {
  const started = performance.now();
  const result = await harness.client.callTool({ name: "java_symbol", arguments: {
    repoRoot: harness.repoRoot, operation: "query", query: query.query, searchMode: query.mode, limit: 8, preview: "head"
  } }, undefined, { timeout: 30_000 });
  const ms = performance.now() - started;
  const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.find(item => item.type === "text")?.text ?? "";
  if (result.isError) return { ms, scopeState: "ERROR", stopReason: "error", previews: 0, error: text.slice(0, 300) };
  const body = JSON.parse(text) as { scopeState: string; stopReason?: string; candidates: Array<{ preview?: string }> };
  return { ms, scopeState: body.scopeState, stopReason: body.stopReason ?? "none", previews: body.candidates.filter(item => typeof item.preview === "string").length };
}

function poolSettled(harness: Harness): boolean {
  const pool = harness.owner.pool.status();
  return pool.queued === 0 && pool.acquiring === 0 && pool.running === 0 && harness.application.state().activeRequests === 0;
}

/** `concurrency` public calls in flight at once, `rounds` times; with `updateIntervalMs`, a file edit is published that often. */
export async function runRequestStep(harness: Harness, input: { concurrency: number; rounds: number; updateIntervalMs?: number }): Promise<RequestStepReport> {
  harness.probe.submits = 0; harness.probe.queuePeak = 0; harness.probe.workersPeak = 0; harness.probe.pids.clear();
  const publishedBefore = harness.publishes.length;
  let edits = 0;
  const edit = () => {
    const absolute = path.join(harness.repoRoot, harness.files[edits % harness.files.length]!);
    // Appending keeps every edit a real content change.
    writeFileSync(absolute, `${readFileSync(absolute, "utf8")}// edit ${edits}\n`);
    harness.emit(absolute);
    edits += 1;
  };
  if (input.updateIntervalMs) {
    // The measured rounds start once the first edit's round is in flight, so its publish lands under load.
    edit();
    const deadline = performance.now() + 5_000;
    while (!harness.owner.status().workspaces.some(workspace => workspace.roundInFlight) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  }
  const editTimer = input.updateIntervalMs ? setInterval(edit, input.updateIntervalMs) : undefined;
  const latencies: RequestStepReport["rawLatencies"] = [];
  const delay = monitorEventLoopDelay({ resolution: 1 });
  const started = performance.now();
  delay.enable();
  try {
    for (let round = 0; round < input.rounds; round += 1) {
      await Promise.all(Array.from({ length: input.concurrency }, async (_, slot) => {
        const sample = round * input.concurrency + slot;
        const query = QUERIES[sample % QUERIES.length]!;
        const outcome = await callSymbol(harness, query);
        latencies.push({ sample, round, slot, kind: query.kind, ...outcome });
      }));
    }
  } finally {
    delay.disable();
    if (editTimer) clearInterval(editTimer);
  }
  const wallMs = performance.now() - started;
  const publishes = harness.publishes.length - publishedBefore;
  const count = (key: "scopeState" | "stopReason") => latencies.reduce<Record<string, number>>((acc, row) => { acc[row[key]] = (acc[row[key]] ?? 0) + 1; return acc; }, {});
  const byKind: RequestStepReport["byKind"] = {};
  for (const kind of new Set(latencies.map(row => row.kind))) {
    const values = latencies.filter(row => row.kind === kind).map(row => row.ms);
    byKind[kind] = { n: values.length, p50: round3(percentile(values, 50)), p95: round3(percentile(values, 95)), p99: round3(percentile(values, 99)) };
  }
  // Settling is part of the contract: the step is not done until the pool and the application are idle.
  const settleDeadline = performance.now() + 5_000;
  while (!poolSettled(harness) && performance.now() < settleDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  return {
    concurrency: input.concurrency,
    requests: latencies.length,
    latencyMs: summary(latencies.map(row => row.ms)),
    byKind,
    eventLoopDelayMs: { p50: round3(delay.percentile(50) / 1e6), p95: round3(delay.percentile(95) / 1e6), p99: round3(delay.percentile(99) / 1e6), max: round3(delay.max / 1e6) },
    rawLatencies: latencies,
    errors: latencies.filter(row => row.error !== undefined).length,
    previews: latencies.reduce((sum, row) => sum + row.previews, 0),
    scopeStates: count("scopeState"),
    stopReasons: count("stopReason"),
    worker: { queuePeak: harness.probe.queuePeak, submits: harness.probe.submits, workersPeak: harness.probe.workersPeak, pids: [...harness.probe.pids].sort((a, b) => a - b), leasesAfter: harness.owner.pool.status().leases },
    publishes,
    edits,
    settled: poolSettled(harness),
    wallMs: round3(wallMs)
  };
}

/** Start the in-process daemon stack over a generated corpus and wait until its snapshot is FRESH. */
export async function startRequestHarness(scratch: string, files: number, readyTimeoutMs: number): Promise<Harness & { readyMs: number; stop(): Promise<void> }> {
  const repoRoot = path.join(scratch, "repo");
  const relative = generateRepo(repoRoot, files);
  // Isolated state for the leases, ownership and JDT settings the manager opens; JDT is never started.
  for (const [name, dir] of [["JAVA_LSP_CACHE_BASE", "cache-base"], ["JAVA_LSP_OWNERSHIP_BASE", "ownership"]] as const) {
    mkdirSync(path.join(scratch, dir), { recursive: true });
    process.env[name] = path.join(scratch, dir);
  }
  process.env.JDTLS_BIN = "/usr/bin/false";
  const projectsConfigPath = path.join(scratch, "projects.json");
  writeFileSync(projectsConfigPath, '{"aliases":[],"defaults":{}}\n');
  const source = injectedSource();
  const publishes: PublishEvent[] = [];
  const probe: PoolProbe = { submits: 0, queuePeak: 0, workersPeak: 0, pids: new Set() };
  let opened: IndexOwner | undefined;
  const registry = new AliasRegistry(projectsConfigPath);
  const resolver = new RepoResolver(registry, { cwdFallback: "reject" });
  const runtimes = new RepoRuntimeManager(resolver, {
    transportMode: "streamable_http",
    index: async () => {
      const owner = await IndexOwner.open({ cacheRoot: path.join(scratch, "owner-cache"), trackerSource: () => source.factory });
      owner.onPublished(event => publishes.push(event));
      // Observation only: the pool is the production one; this records its queue depth at each admission.
      const pool = owner.pool as { submit: typeof owner.pool.submit };
      const submit = owner.pool.submit.bind(owner.pool);
      pool.submit = task => {
        const pending = submit(task);
        const status = owner.pool.status();
        probe.submits += 1;
        probe.queuePeak = Math.max(probe.queuePeak, status.queued);
        probe.workersPeak = Math.max(probe.workersPeak, status.workers);
        for (const pid of status.pids) probe.pids.add(pid);
        return pending;
      };
      opened = owner;
      return owner;
    }
  });
  const application = new JavaLspApplication({ transportMode: "streamable_http", registry, resolver, runtimes, cacheJanitorIntervalMs: 0,
    cleanup: () => ({ scanned: 0, removed: 0, skipped: 0, failures: 0, removedDirs: [] }) });
  await application.initialize();
  const server = createMcpServer(application);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "k29-request-load", version: "1.0.0" });
  await client.connect(clientTransport);
  const started = performance.now();
  // The first indexed call starts the workspace (full build); status then reads its labels from memory.
  await client.callTool({ name: "java_symbol", arguments: { repoRoot, operation: "query", query: QUERIES[0]!.query, searchMode: "exact", preview: "none" } }, undefined, { timeout: readyTimeoutMs });
  for (;;) {
    const status = await client.callTool({ name: "java_status", arguments: { repoRoot } });
    const text = (status.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    if ((JSON.parse(text) as { indexView?: { state?: string } }).indexView?.state === "FRESH") break;
    if (performance.now() - started > readyTimeoutMs) throw new Error(`snapshot not FRESH within ${readyTimeoutMs} ms: ${text.slice(0, 400)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const readyMs = performance.now() - started;
  if (!opened) throw new Error("index owner was not opened by the request path");
  const harness: Harness = { client, owner: opened, application, repoRoot, files: relative, probe, publishes, emit: source.emit };
  return { ...harness, readyMs, stop: async () => { await client.close(); await server.close(); await application.close(); } };
}

export async function runRequestLoad(args: RequestLoadArgs): Promise<Record<string, unknown>> {
  mkdirSync(args.output, { recursive: true });
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "k29-request-load-")));
  try {
    const harness = await startRequestHarness(scratch, args.files, args.readyTimeoutMs);
    try {
      // Warm-up: every query once through the same path (workers spawned, connections open).
      for (const query of QUERIES) {
        const warm = await callSymbol(harness, query);
        if (warm.error) throw new Error(`warm query ${query.kind} failed: ${warm.error}`);
      }
      const steps: RequestStepReport[] = [];
      for (const concurrency of args.steps) steps.push(await runRequestStep(harness, { concurrency, rounds: Math.ceil(args.samples / concurrency) }));
      const peak = Math.max(...args.steps);
      const withUpdates = await runRequestStep(harness, { concurrency: peak, rounds: Math.ceil(args.samples / peak), updateIntervalMs: args.updateIntervalMs });
      const report = {
        protocol: REQUEST_LOAD_PROTOCOL,
        kind: "synthetic-request-load",
        path: "public java_symbol (in-memory MCP) -> RepoRuntimeManager -> withRequestView (one acquire, snapshot lease) -> QueryPool workers (IPC) -> head preview",
        timing: "per sample: callTool issued -> reply parsed; event-loop delay of the owner process over the measured rounds",
        files: args.files,
        readySeconds: round3(harness.readyMs / 1000),
        host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, node: process.version, loadavg: os.loadavg() },
        queries: QUERIES,
        steps,
        withUpdates,
        gates: { warmStaticP95LimitMs: 150, eventLoopP95LimitMs: 20, note: "fixed generated corpus; not an all-repository capacity claim" }
      };
      writeFileSync(path.join(args.output, "query-request-load-report.json"), `${JSON.stringify(report, null, 2)}\n`);
      return report;
    } finally {
      await harness.stop();
    }
  } finally {
    removeScratch(scratch);
  }
}

/** Sealed snapshot directories are read-only by mode: restore write access before removing the scratch tree. */
function removeScratch(dir: string): void {
  const writable = (current: string): void => {
    try { chmodSync(current, 0o755); } catch { return; }
    for (const entry of readdirSync(current, { withFileTypes: true })) if (entry.isDirectory()) writable(path.join(current, entry.name));
  };
  writable(dir);
  rmSync(dir, { recursive: true, force: true });
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMainModule()) {
  runRequestLoad(parseRequestLoadArgs(process.argv.slice(2))).then(report => {
    const steps = [...(report.steps as RequestStepReport[]), report.withUpdates as RequestStepReport];
    process.stdout.write(`${JSON.stringify({ ok: true, protocol: report.protocol, steps: steps.map(step => ({ c: step.concurrency, p95: step.latencyMs.p95, loopP95: step.eventLoopDelayMs.p95, queuePeak: step.worker.queuePeak, errors: step.errors, publishes: step.publishes })) })}\n`);
  }, error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

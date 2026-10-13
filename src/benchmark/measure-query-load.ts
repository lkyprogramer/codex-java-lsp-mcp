// input: a repository (synthetic --files N, or a real --repo with its own
//        --db), an output directory.
// output: raw load report - EXPLAIN QUERY PLAN captures, rare-exact vs
//         broad-term comparisons, and (R09) a step load through the real
//         query boundary: SqlClient -> runStaticDiscovery on this thread,
//         SQL on the shared read-only worker, with event-loop delay, queue
//         peak, P50/P95/P99, deadline stops and concurrent writer commits.
// pos: T07/R09 evidence helper. A synthetic corpus proves mechanisms only;
//      the warm 150ms / 20ms gates are judged on a real corpus on the gate
//      machine and are never extrapolated from here.
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openIndexDb, close, type IndexDatabase } from "../java-index/sql/driver.js";
import { ensureSchema } from "../java-index/sql/schema.js";
import { runSqlColdBuild } from "../index-builder/cold-build.js";
import { SqlEntitySearch, readIndexGeneration } from "../java-index/sql/entity-search.js";
import { SqlJavaIndexClient } from "../java-index/sql/sql-client.js";
import { runStaticDiscovery, type DiscoveryResult } from "../discovery/query.js";
import { configureSharedQueryWorker, sharedQueryWorker, type QueryWorkerStats, type QueryWorkerTiming } from "../discovery/query-worker.js";
import { classifyQuery } from "../discovery/query-intent.js";
import { repoCacheBase } from "../repo-layout.js";

function isInside(file: string, dir: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

interface LoadArgs {
  files: number;
  workerCount: 1 | 2;
  output: string;
  repo?: string;
  db?: string;
  deadlineMs: number;
  samples: number;
  steps: number[];
  writerIntervalMs: number;
  queries?: LoadQuery[];
}

export function parseArgs(argv: string[]): LoadArgs {
  let files = 1000;
  let workerCount: number = 1;
  let output: string | undefined;
  let repo: string | undefined;
  let db: string | undefined;
  let deadlineMs = 1000;
  let samples = 100;
  let writerIntervalMs = 100;
  let steps = [1, 5, 10, 20];
  let queries: LoadQuery[] | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--files" && argv[i + 1]) files = Number(argv[i + 1]);
    else if (argv[i] === "--worker-count") workerCount = Number(argv[++i]);
    else if (argv[i] === "--output" && argv[i + 1]) output = argv[i + 1];
    else if (argv[i] === "--repo" && argv[i + 1]) repo = path.resolve(argv[i + 1]!);
    else if (argv[i] === "--db" && argv[i + 1]) db = path.resolve(argv[i + 1]!);
    else if (argv[i] === "--deadline-ms" && argv[i + 1]) deadlineMs = Number(argv[i + 1]);
    else if (argv[i] === "--samples" && argv[i + 1]) samples = Number(argv[i + 1]);
    else if (argv[i] === "--writer-interval-ms" && argv[i + 1]) writerIntervalMs = Number(argv[i + 1]);
    else if (argv[i] === "--steps" && argv[i + 1]) steps = argv[i + 1]!.split(",").map(Number);
    // kind:mode:text, repeatable (e.g. --query broad:text:order)
    else if (argv[i] === "--query" && argv[i + 1]) {
      const [kind, mode, ...text] = argv[i + 1]!.split(":");
      (queries ??= []).push({ kind: kind!, mode: mode as LoadQuery["mode"], query: text.join(":") });
    }
  }
  if (!Number.isInteger(files) || files < 1) throw new Error("--files must be a positive integer");
  if (workerCount !== 1 && workerCount !== 2) throw new Error("--worker-count must be 1 or 2");
  if (!output) throw new Error("--output is required");
  if (repo && !db) throw new Error("--repo requires --db (a scratch index path; never the production cache)");
  // The writer step bumps indexedGeneration: never point it at a live cache.
  if (db && isInside(db, repoCacheBase())) throw new Error(`--db must not be inside the index cache (${repoCacheBase()})`);
  if (!(deadlineMs > 0) || !Number.isInteger(samples) || samples < 1 || !(writerIntervalMs > 0) || steps.some(step => !Number.isInteger(step) || step < 1)) {
    throw new Error("invalid --deadline-ms/--rounds/--steps");
  }
  return { files, workerCount, output, repo, db, deadlineMs, samples, steps, writerIntervalMs, queries };
}

export function generateRepo(root: string, count: number): string[] {
  const written: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const pkg = `p${String(Math.floor(i / 50)).padStart(5, "0")}`;
    const simple = `Service${String(i).padStart(5, "0")}`;
    const relative = path.join("src", "main", "java", "com", "synth", pkg, `${simple}.java`).split(path.sep).join("/");
    const content = `package com.synth.${pkg};
/** Keeps the order record for ${simple}. */
public class ${simple} {
    public void updateOrder(int id) {
        // touch the order ledger
    }

    public void refundOrder(long id) {
        // reverse the order payment
    }
}
`;
    const absolute = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
    written.push(relative);
  }
  return written;
}

function explainPlans(db: IndexDatabase, sampleFqn: string, sampleSimple: string): Record<string, string[][]> {
  const plans: Record<string, string[]> = {
    "exact:fqn_like": [
      `EXPLAIN QUERY PLAN SELECT s.text AS entityId FROM entity e JOIN sym s ON s.id = e.sym WHERE e.fqn = '${sampleFqn}' OR e.fqn LIKE '${sampleFqn}%' LIMIT 10`
    ],
    "suffix:simple_in": [
      `EXPLAIN QUERY PLAN SELECT e.sym FROM entity e WHERE e.kind='type' AND e.simple_name_lc = '${sampleSimple.toLowerCase()}' LIMIT 10`
    ],
    "bm25:entity_postings": [
      "EXPLAIN QUERY PLAN SELECT t.token_sym FROM entity_token t WHERE t.field = 0 AND t.token_sym IN (1, 2, 3)"
    ],
    "doc:search_doc_postings": [
      "EXPLAIN QUERY PLAN SELECT t.doc_sym, t.tf FROM search_doc_token t WHERE t.token_sym IN (1, 2, 3)"
    ],
    "old:avg_length_scan": ["EXPLAIN QUERY PLAN SELECT count(*) AS n, coalesce(sum(ident_len), 0) AS total FROM entity"]
  };
  const out: Record<string, string[][]> = {};
  for (const [name, statements] of Object.entries(plans)) {
    out[name] = statements.map(statement =>
      (db.prepare(statement).all() as Array<Record<string, unknown>>)
        .map(row => Object.values(row).join(" | "))
    );
  }
  return out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}


export type LoadQuery = { kind: string; mode: "auto" | "exact" | "text"; query: string };

export type StepLoadReport = {
  workerCount: 1 | 2;
  rawLatencies: Array<{ sample: number; round: number; slot: number; kind: string; query: string; ms: number; stopReason: string; scopeState: string }>;
  workerRequests: QueryWorkerTiming[];
  warmup: { requests: number; writerCommits: number; workerSlots: number[]; workerRequests: QueryWorkerTiming[] };
  measuredWorkerSpawned: number;
  measuredWriterCommits: number;
  measuredWorkerCompleted: number;
  resources: { wallMs: number; cpuUserUs: number; cpuSystemUs: number; cpuEquivalentCores: number; rssStartMb: number; rssEndMb: number; rssSampledPeakMb: number; rssSamplingIntervalMs: number; scope: string };
  concurrency: number;
  requests: number;
  deadlineMs: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number };
  byKind: Record<string, { n: number; p50: number; p95: number; p99: number }>;
  eventLoopDelayMs: { p50: number; p95: number; p99: number; max: number };
  stopReasons: Record<string, number>;
  scopeStates: Record<string, number>;
  writerCommits: number;
  writerIntervalMs: number | null;
  rssMb: number;
  /** Worker counters for this step only (queuePeak is the step's peak). */
  worker: QueryWorkerStats;
  /** After the step: nothing queued, nothing running. */
  settled: boolean;
};

/**
 * R09: `concurrency` requests in flight at once, `rounds` times, each with its
 * own absolute deadline, through the real boundary (SqlClient.querySearch ->
 * shared worker). With `writerIntervalMs`, a separate connection commits a
 * generation bump that often while the step runs (query/update interleaving;
 * answers straddling a commit must come back PARTIAL, never mixed).
 */
export async function runStepLoad(input: {
  repoRoot: string;
  dbPath: string;
  workerCount?: 1 | 2;
  queries: readonly LoadQuery[];
  concurrency: number;
  rounds: number;
  deadlineMs: number;
  /** Commit (and bump indexedGeneration) on a separate connection this often. */
  writerIntervalMs?: number;
}): Promise<StepLoadReport> {
  const workerCount = input.workerCount ?? 1;
  await sharedQueryWorker().close();
  const timings: QueryWorkerTiming[] = [];
  const warmTimings: QueryWorkerTiming[] = [];
  let measuring = false;
  configureSharedQueryWorker({ workerCount, onTiming: event => (measuring ? timings : warmTimings).push(event) });
  const client = new SqlJavaIndexClient(input.repoRoot, input.dbPath);
  await client.open(1);
  const worker = sharedQueryWorker();
  const before = worker.stats();
  worker.resetPeak();
  let writerCommits = 0;
  const writerDb = input.writerIntervalMs ? openIndexDb(input.dbPath) : undefined;
  const writerTimer = writerDb
    ? setInterval(() => {
      writerDb.exec("BEGIN IMMEDIATE");
      writerDb.prepare("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='indexedGeneration'").run();
      writerDb.exec("COMMIT");
      writerCommits += 1;
    }, input.writerIntervalMs)
    : undefined;
  const latencies: StepLoadReport["rawLatencies"] = [];
  let measuredCommitsBefore = 0;
  let measuredCompletedBefore = 0;
  let measuredSpawnedBefore = 0;
  let cpuBefore = process.cpuUsage();
  let cpuUsed = { user: 0, system: 0 };
  let measuredStarted = 0;
  let wallMs = 0;
  let rssStartMb = 0;
  let rssEndMb = 0;
  let rssPeakMb = 0;
  let rssTimer: NodeJS.Timeout | undefined;
  const rssMb = () => process.memoryUsage().rss / 1024 / 1024;
  const stopReasons: Record<string, number> = {};
  const scopeStates: Record<string, number> = {};
  const delay = monitorEventLoopDelay({ resolution: 1 });
  try {
    // Warm-up: one pass of every query (connection open, statement prep).
    for (const query of input.queries) {
      await Promise.all(Array.from({ length: workerCount }, () => discover(client, input.repoRoot, query, input.deadlineMs)));
    }
    // Every reader warms the same query set; the measured sample count is unchanged.
    for (let slot = 0; slot < workerCount; slot += 1) {
      for (const query of input.queries) {
        if (!warmTimings.some(event => event.workerSlot === slot && event.request.task === query.query && event.request.mode === classifyQuery(query.query, query.mode) && event.outcome === "completed" && event.actualServiceMs !== null)) {
          throw new Error(`reader ${slot} did not complete warm query ${query.kind}`);
        }
      }
    }
    measuredCommitsBefore = writerCommits;
    measuredCompletedBefore = worker.stats().completed;
    measuredSpawnedBefore = worker.stats().spawned;
    cpuBefore = process.cpuUsage();
    rssStartMb = rssPeakMb = rssMb();
    measuredStarted = performance.now();
    rssTimer = setInterval(() => { rssPeakMb = Math.max(rssPeakMb, rssMb()); }, 10);
    measuring = true;
    delay.enable();
    for (let round = 0; round < input.rounds; round += 1) {
      await Promise.all(Array.from({ length: input.concurrency }, async (_, slot) => {
        const query = input.queries[(round * input.concurrency + slot) % input.queries.length]!;
        const started = performance.now();
        const result = await discover(client, input.repoRoot, query, input.deadlineMs);
        latencies.push({ sample: round * input.concurrency + slot, round, slot, kind: query.kind, query: query.query, ms: performance.now() - started, stopReason: result.stopReason ?? "none", scopeState: result.scopeState });
        const reason = result.stopReason ?? "none";
        stopReasons[reason] = (stopReasons[reason] ?? 0) + 1;
        scopeStates[result.scopeState] = (scopeStates[result.scopeState] ?? 0) + 1;
      }));
    }
    delay.disable();
    wallMs = performance.now() - measuredStarted;
    cpuUsed = process.cpuUsage(cpuBefore);
    rssEndMb = rssMb();
    rssPeakMb = Math.max(rssPeakMb, rssEndMb);
    measuring = false;
  } finally {
    delay.disable();
    if (rssTimer) clearInterval(rssTimer);
    if (writerTimer) clearInterval(writerTimer);
    if (writerDb) close(writerDb);
    await client.close();
  }
  const after = worker.stats();
  const all = latencies.map(item => item.ms);
  const byKind: StepLoadReport["byKind"] = {};
  for (const kind of new Set(latencies.map(item => item.kind))) {
    const values = latencies.filter(item => item.kind === kind).map(item => item.ms);
    byKind[kind] = { n: values.length, p50: round3(percentile(values, 50)), p95: round3(percentile(values, 95)), p99: round3(percentile(values, 99)) };
  }
  return {
    workerCount,
    rawLatencies: latencies,
    workerRequests: timings,
    warmup: { requests: warmTimings.length, writerCommits: measuredCommitsBefore, workerRequests: warmTimings, workerSlots: [...new Set(warmTimings.flatMap(event => event.workerSlot === undefined ? [] : [event.workerSlot]))] },
    measuredWriterCommits: writerCommits - measuredCommitsBefore,
    measuredWorkerCompleted: after.completed - measuredCompletedBefore,
    measuredWorkerSpawned: after.spawned - measuredSpawnedBefore,
    resources: { wallMs, cpuUserUs: cpuUsed.user, cpuSystemUs: cpuUsed.system, cpuEquivalentCores: wallMs > 0 ? (cpuUsed.user + cpuUsed.system) / (wallMs * 1000) : 0, rssStartMb, rssEndMb, rssSampledPeakMb: rssPeakMb, rssSamplingIntervalMs: 10, scope: "whole process, including all worker threads; measured requests only; sampled RSS is not an exact peak" },
    concurrency: input.concurrency,
    requests: latencies.length,
    deadlineMs: input.deadlineMs,
    latencyMs: { p50: round3(percentile(all, 50)), p95: round3(percentile(all, 95)), p99: round3(percentile(all, 99)), max: round3(Math.max(0, ...all)) },
    byKind,
    eventLoopDelayMs: {
      p50: round3(delay.percentile(50) / 1e6),
      p95: round3(delay.percentile(95) / 1e6),
      p99: round3(delay.percentile(99) / 1e6),
      max: round3(delay.max / 1e6)
    },
    stopReasons,
    scopeStates,
    writerCommits,
    writerIntervalMs: input.writerIntervalMs ?? null,
    rssMb: round3(process.memoryUsage().rss / 1024 / 1024),
    worker: {
      ...after,
      completed: after.completed - before.completed,
      rejectedQueueFull: after.rejectedQueueFull - before.rejectedQueueFull,
      expiredInQueue: after.expiredInQueue - before.expiredInQueue,
      terminated: after.terminated - before.terminated,
      spawned: after.spawned - before.spawned
    },
    settled: after.queued === 0 && !after.running
  };
}

function discover(client: SqlJavaIndexClient, repoRoot: string, query: LoadQuery, deadlineMs: number): Promise<DiscoveryResult> {
  const deadline = performance.now() + deadlineMs;
  return runStaticDiscovery(client, {
    repoRoot,
    query: query.query,
    searchMode: query.mode,
    limit: 8,
    budget: { remainingMs: () => Math.max(0, deadline - performance.now()) }
  });
}

const SYNTHETIC_QUERIES: LoadQuery[] = [
  { kind: "rare-fqn", mode: "exact", query: "com.synth.p00000.Service00000" },
  { kind: "common-word", mode: "text", query: "order" },
  { kind: "broad", mode: "text", query: "order refund ledger payment" },
  { kind: "fuzzy", mode: "auto", query: "refundOrder" }
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.output, { recursive: true });
  const scratch = path.join(os.tmpdir(), `devkit-load-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const repoRoot = args.repo ?? scratch;
  const dbPath = args.db ?? path.join(scratch, "load.sqlite");
  let buildSeconds = 0;
  let buildCounts: unknown = "reused";
  try {
    mkdirSync(scratch, { recursive: true });
    let generateSeconds = 0;
    if (!args.repo) {
      const generatedAt = performance.now();
      generateRepo(repoRoot, args.files);
      generateSeconds = (performance.now() - generatedAt) / 1000;
    }
    if (!existsSyncSafe(dbPath)) {
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const buildDb = openIndexDb(dbPath);
      ensureSchema(buildDb);
      const buildStarted = performance.now();
      buildCounts = await runSqlColdBuild({ db: buildDb, repoRoot });
      buildSeconds = (performance.now() - buildStarted) / 1000;
      close(buildDb);
    }

    const db = openIndexDb(dbPath, { readOnly: true });
    let mechanism: Record<string, unknown>;
    try {
      const search = new SqlEntitySearch(db);
      const generation = readIndexGeneration(db);
      const sampleFqn = "com.synth.p00000.Service00000";
      const plans = explainPlans(db, sampleFqn, "service00000");
      // Rare exact: point lookup must not visit a single posting row.
      const exactDeadline = performance.now() + 500;
      const exact = search.searchDetailed(sampleFqn, 10, "exact", {
        budget: { maxPostings: 1, remainingMs: () => Math.max(0, exactDeadline - performance.now()) }
      });
      // Expired entry: no SQL, PARTIAL/deadline (Q03).
      const expired = search.searchDetailed(sampleFqn, 10, "exact", { budget: { remainingMs: () => 0 } });
      const broadStarted = performance.now();
      const broad = search.searchDetailed("order", 10, "text", { budget: { remainingMs: () => 60_000 } });
      const broadMs = performance.now() - broadStarted;
      mechanism = {
        generation,
        explain: plans,
        exact: { fqn: sampleFqn, hits: exact.hits.length, stopReason: exact.stopReason ?? null, postingsVisited: exact.work.postings },
        expiredEntry: { stopReason: expired.stopReason ?? null, postingsVisited: expired.work.postings, stages: expired.trace?.length ?? 0 },
        broadInProcess: { term: "order", ms: round3(broadMs), postingsVisited: broad.work.postings, stopReason: broad.stopReason ?? null, trace: broad.trace }
      };
      writeFileSync(
        path.join(args.output, "query-load-explain.txt"),
        Object.entries(plans).map(([name, rows]) => `# ${name}\n${rows.flat().join("\n")}\n`).join("\n"),
        "utf8"
      );
    } finally {
      close(db);
    }

    const queries = args.queries ?? SYNTHETIC_QUERIES;
    const steps: StepLoadReport[] = [];
    for (const concurrency of args.steps) {
      const rounds = Math.ceil(args.samples / concurrency);
      steps.push(await runStepLoad({ repoRoot, dbPath, workerCount: args.workerCount, queries, concurrency, rounds, deadlineMs: args.deadlineMs }));
    }
    const peak = Math.max(...args.steps);
    const withUpdates = await runStepLoad({
      repoRoot, dbPath, workerCount: args.workerCount, queries, concurrency: peak, rounds: Math.ceil(args.samples / peak), deadlineMs: args.deadlineMs, writerIntervalMs: args.writerIntervalMs
    });
    const finalWorker = sharedQueryWorker();
    await finalWorker.close();
    const shutdown = finalWorker.stats();
    const report = {
      shutdown,
      protocol: "p3-capacity-v1",
      workerCount: args.workerCount,
      kind: args.repo ? "real-repo-load" : "synthetic-load",
      repo: args.repo ? path.basename(args.repo) : null,
      files: args.repo ? null : args.files,
      generateSeconds: args.repo ? null : round3(generateSeconds),
      buildSeconds: round3(buildSeconds),
      build: buildCounts,
      host: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, node: process.version },
      ...mechanism,
      queries,
      steps,
      withUpdates,
      gates: {
        note: "Reference targets only (gates.json): warm static P95 <= 150ms, event-loop P95 <= 20ms. Not signed from this run.",
        warmStaticP95TargetMs: 150,
        eventLoopP95TargetMs: 20
      }
    };
    writeFileSync(path.join(args.output, "query-load-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      kind: report.kind,
      steps: steps.map(step => ({ c: step.concurrency, p95: step.latencyMs.p95, loopP95: step.eventLoopDelayMs.p95, loopMax: step.eventLoopDelayMs.max, queuePeak: step.worker.queuePeak, stops: step.stopReasons })),
      withUpdates: { p95: withUpdates.latencyMs.p95, loopP95: withUpdates.eventLoopDelayMs.p95, commits: withUpdates.writerCommits, stops: withUpdates.stopReasons }
    })}\n`);
  } finally {
    await sharedQueryWorker().close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function existsSyncSafe(file: string): boolean {
  try {
    return realpathSync(file) !== "";
  } catch {
    return false;
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

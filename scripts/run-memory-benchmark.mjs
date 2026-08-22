#!/usr/bin/env node
// input: Three frozen golden Java repos plus golden/*.scenarios.jsonl.
// output: Hot heapUsed, RSS peak/steady, snapshot load, first-hydrate vs steady warm p95, S1/S2/S4, fact-graph attribution.
// pos: M0 measurement. Isolated. Does not change production query/selection.
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import { fileURLToPath } from "node:url";
import { JavaIndexClient } from "../dist/java-index/java-index-client.js";
import { RouterJavaIndex } from "../dist/java-index/router-java-index.js";
import { probeLayout } from "../dist/layout-probe.js";
import { discoverJavaFiles } from "../dist/java-index/manifest.js";

const PROJECTS = ["lishuedu", "cipherlink", "exam-parent-v3"];
const SNAPSHOT_FILE_NAME = "java-index-snapshot.json.gz";
const GRAPH_SNAPSHOT_FILE_NAME = "java-knowledge-graph.json.gz";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const sourceRoot = path.resolve(path.dirname(SCRIPT_PATH), "..");
const OBJECT_HEADER_BYTES = 64;
const ARRAY_HEADER_BYTES = 48;
const POINTER_BYTES = 8;
const STRING_HEADER_BYTES = 24;
const QUERY_BATCH = 40;
const ATTRIBUTION_SAMPLE = 96;

export const M0_GATES = {
  G1_LISHUEDU_HEAP_MIB: 200,
  G1_SMALL_HEAP_MIB: 64,
  G1_STAGING_LISHUEDU_HEAP_MIB: 500,
  G2_LISHUEDU_RSS_MIB: 400,
  G2_SMALL_RSS_MIB: 128,
  G3_CHILD_PEAK_MIB: 1536,
  G3_PARENT_COLD_INCREMENT_MIB: 100,
  G4_SNAPSHOT_LOAD_MS: 2000,
  G5_P95_RATIO: 1.1,
  G5_FIRST_HYDRATE_MS: 2000,
  S1_RSS_MIB: 1024,
  S2_RSS_MIB: 1433.6,
  S4_HIBERNATE_HEAP_MIB: 32
};

/** M0 all-scenario warm p95. G5 steady compares against this, not the first hydrate sample. */
export const M0_WARM_P95_MS = {
  lishuedu: 77.2,
  cipherlink: 40.9,
  "exam-parent-v3": 38.5
};

export function parseMemoryBenchmarkCli(args) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (key === "--skip-concurrent") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    help: false,
    skipConcurrent: flags.has("--skip-concurrent"),
    timeoutMs: Number(options.get("--timeout-ms") || 600_000),
    holdMs: Number(options.get("--hold-ms") || 8_000),
    output: options.get("--output"),
    project: options.get("--project"),
    repo: options.get("--repo"),
    cacheRoot: options.get("--cache-root"),
    mode: options.get("--mode") || "project",
    runtimeId: options.get("--runtime-id"),
    repositories: {
      lishuedu: options.get("--lishuedu"),
      cipherlink: options.get("--cipherlink"),
      "exam-parent-v3": options.get("--exam-parent-v3")
    }
  };
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function splitWarmLatencies(latencies) {
  const samples = Array.isArray(latencies) ? latencies.map(Number) : [];
  const firstHydrateMs = samples[0] ?? 0;
  const steady = samples.slice(1);
  return {
    scenarios: samples.length,
    firstHydrateMs,
    steadyScenarios: steady.length,
    steadyWarmP50Ms: percentile(steady, 50),
    steadyWarmP95Ms: percentile(steady, 95),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    latenciesMs: samples
  };
}

export function g5SteadyRatio(project, steadyWarmP95Ms) {
  const baseline = M0_WARM_P95_MS[project];
  if (!baseline) return null;
  return Number((steadyWarmP95Ms / baseline).toFixed(3));
}

export function bytesToMiB(bytes) {
  return Math.round((Number(bytes) || 0) / 1024 / 1024);
}

export function sampleEven(items, limit) {
  if (items.length <= limit) return [...items];
  const step = items.length / limit;
  return Array.from({ length: limit }, (_, index) => items[Math.floor(index * step)]);
}

export function classifyFactValue(value) {
  if (value == null || typeof value !== "object") return "primitive";
  if (Array.isArray(value)) return "array";
  if (isSourcePoint(value)) return "SourcePoint";
  if (isSourceRange(value)) return "SourceRange";
  if (typeof value.edgeId === "string" && typeof value.fromId === "string" && typeof value.toId === "string") return "StaticEdge";
  if (value.kind === "METHOD_INVOCATION" || value.kind === "CONSTRUCTOR_INVOCATION" || value.kind === "METHOD_REFERENCE") {
    return "JavaCallSiteFact";
  }
  if (Array.isArray(value.typeArguments) && value.resolution && typeof value.simpleName === "string" && typeof value.text === "string") {
    return "JavaTypeRef";
  }
  if (typeof value.methodId === "string" && Array.isArray(value.callSites)) return "JavaMethodFacts";
  if (typeof value.fieldId === "string" && typeof value.ownerTypeId === "string") return "JavaFieldFacts";
  if (typeof value.typeId === "string" && typeof value.simpleName === "string" && typeof value.kind === "string") return "JavaTypeFacts";
  if (typeof value.relativePath === "string" && typeof value.contentHash === "string" && Array.isArray(value.imports)) return "JavaFileFacts";
  if (typeof value.qualifiedName === "string" && typeof value.wildcard === "boolean") return "JavaImportFact";
  if (typeof value.name === "string" && value.range && (value.qualifiedName !== undefined || value.argumentsText !== undefined || Array.isArray(value.bounds))) {
    return value.bounds ? "JavaTypeParameterFact" : "JavaAnnotationFact";
  }
  if (typeof value.state === "string" && (value.strategy !== undefined || value.typeId !== undefined || value.candidates !== undefined || value.name !== undefined)) {
    return "TypeResolution";
  }
  return "other";
}

export function attributeBundles(bundles) {
  const seen = new Set();
  const uniqueStrings = new Map();
  const constructors = Object.create(null);
  const stats = {
    objects: 0,
    arrays: 0,
    strings: 0,
    stringBytes: 0,
    uniqueStringBytes: 0,
    objectHeaderBytes: 0,
    arrayBytes: 0,
    estimatedBytes: 0
  };

  function visit(value) {
    if (value == null) return;
    if (typeof value === "string") {
      stats.strings += 1;
      const bytes = STRING_HEADER_BYTES + value.length * 2;
      stats.stringBytes += bytes;
      uniqueStrings.set(value, bytes);
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      stats.arrays += 1;
      stats.arrayBytes += ARRAY_HEADER_BYTES + value.length * POINTER_BYTES;
      for (const item of value) visit(item);
      return;
    }
    const kind = classifyFactValue(value);
    constructors[kind] = (constructors[kind] ?? 0) + 1;
    stats.objects += 1;
    const keys = Object.keys(value);
    stats.objectHeaderBytes += OBJECT_HEADER_BYTES + keys.length * POINTER_BYTES;
    for (const key of keys) visit(value[key]);
  }

  for (const bundle of bundles) visit(bundle);
  stats.uniqueStringBytes = [...uniqueStrings.values()].reduce((sum, bytes) => sum + bytes, 0);
  stats.estimatedBytes = stats.stringBytes + stats.objectHeaderBytes + stats.arrayBytes;
  const share = denominator => stats.estimatedBytes === 0 ? 0 : Number((denominator / stats.estimatedBytes).toFixed(4));
  return {
    sampledBundles: bundles.length,
    constructors,
    ...stats,
    duplicatedStringBytes: Math.max(0, stats.stringBytes - stats.uniqueStringBytes),
    shares: {
      strings: share(stats.stringBytes),
      uniqueStrings: share(stats.uniqueStringBytes),
      objects: share(stats.objectHeaderBytes),
      arrays: share(stats.arrayBytes)
    }
  };
}

export function concurrentRuntimePlan() {
  return {
    S1: PROJECTS.map(project => ({ project, runtimeId: project, worktree: false })),
    S2: [
      ...PROJECTS.map(project => ({ project, runtimeId: project, worktree: false })),
      { project: "lishuedu", runtimeId: "lishuedu-wt2", worktree: true },
      { project: "cipherlink", runtimeId: "cipherlink-wt2", worktree: true }
    ]
  };
}

export function unmeasuredScenario(id, reason) {
  return { id, status: "UNMEASURED", reason, rssSumBytes: null, rssDeltaBytes: null, heapUsedSumBytes: null, runtimes: [] };
}

function isSourcePoint(value) {
  return Number.isInteger(value.line) && Number.isInteger(value.column) && Object.keys(value).length === 2;
}

function isSourceRange(value) {
  return isSourcePoint(value.start ?? {}) && isSourcePoint(value.end ?? {}) && (value.start !== undefined) && (value.end !== undefined);
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function collectHeap() {
  const gcFn = globalThis.gc;
  if (typeof gcFn === "function") gcFn();
  return {
    ...process.memoryUsage(),
    heapStatistics: v8.getHeapStatistics()
  };
}

async function waitForComplete(index, timeoutMs, onTick) {
  const started = Date.now();
  let peakRss = process.memoryUsage().rss;
  while (Date.now() - started < timeoutMs) {
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    onTick?.(usage);
    const status = await index.routerStatus(true);
    const pending = (status.javaIndex?.pendingBackground ?? 0) + (status.javaIndex?.pendingForeground ?? 0);
    if (status.coverage === "complete" && pending === 0) return { status, peakRssBytes: peakRss };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("JavaIndex did not reach complete coverage before timeout");
}

async function loadScenarios(project) {
  const file = path.join(sourceRoot, "golden", `${project}.scenarios.jsonl`);
  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function snapshotBytes(cacheDir) {
  const target = path.join(cacheDir, SNAPSHOT_FILE_NAME);
  try {
    return (await stat(target)).size;
  } catch {
    return 0;
  }
}

async function attributeSample(index, repoRoot) {
  const discovered = await discoverJavaFiles(repoRoot, probeLayout(repoRoot));
  const sample = sampleEven(discovered, ATTRIBUTION_SAMPLE);
  const bundles = [];
  for (let offset = 0; offset < sample.length; offset += QUERY_BATCH) {
    const slice = sample.slice(offset, offset + QUERY_BATCH);
    const found = await index.queryFiles(slice.map(item => item.absolutePath));
    bundles.push(...found);
  }
  return {
    discovered: discovered.length,
    ...attributeBundles(bundles)
  };
}

async function warmQueries(index, project) {
  const scenarios = await loadScenarios(project);
  const latencies = [];
  for (const scenario of scenarios) {
    const anchor = scenario.anchor?.file;
    if (!anchor) continue;
    const started = performance.now();
    await index.queryContextGraph({
      fromRelativePath: anchor,
      intent: "auto",
      taskText: `${scenario.name ?? ""} ${(scenario.anchor?.taskKeywords ?? []).join(" ")}`,
      profile: scenario.anchor?.profile,
      maxHops: 4,
      maxExpansions: 4096,
      tokenBudget: 32000
    });
    latencies.push(performance.now() - started);
  }
  return splitWarmLatencies(latencies);
}

export async function benchProject(project, repoRoot, timeoutMs, cacheRoot) {
  const cacheDir = path.join(cacheRoot, project);
  await mkdir(cacheDir, { recursive: true });
  const rssBefore = collectHeap();
  const client = new JavaIndexClient(repoRoot, cacheDir);
  const index = new RouterJavaIndex(repoRoot, client);
  try {
    const coldStarted = performance.now();
    await index.open(1);
    await index.reconcile(1);
    const cold = await waitForComplete(index, timeoutMs);
    await client.flush();
    const coldDigest = await index.queryGraphDigest();
    const coldMs = performance.now() - coldStarted;
    const attribution = await attributeSample(index, repoRoot);
    await index.close();

    const reloadClient = new JavaIndexClient(repoRoot, cacheDir);
    const reloadIndex = new RouterJavaIndex(repoRoot, reloadClient);
    let snapshotLoadMs = 0;
    let loaded;
    let loadDigest;
    let warm;
    let hotDigest;
    let hotHeap;
    let hibernate = { heapUsedBytes: null, reheatMs: null, hibernated: false };
    try {
      const loadStarted = performance.now();
      await reloadIndex.open(1);
      loaded = await waitForComplete(reloadIndex, timeoutMs);
      snapshotLoadMs = performance.now() - loadStarted;
      loadDigest = await reloadIndex.queryGraphDigest();
      warm = await warmQueries(reloadIndex, project);
      hotDigest = await reloadIndex.queryGraphDigest();
      hotHeap = collectHeap();
      const hibernatedStatus = await reloadClient.hibernate();
      const reheatStarted = performance.now();
      await reloadClient.status();
      hibernate = {
        heapUsedBytes: hibernatedStatus.heapUsedBytes ?? null,
        reheatMs: performance.now() - reheatStarted,
        hibernated: hibernatedStatus.hibernated === true
      };
    } finally {
      await reloadIndex.close().catch(() => undefined);
    }

    const heapUsedBytes = loadDigest.heapUsedBytes ?? coldDigest.heapUsedBytes;
    const loadRssBytes = loadDigest.rssBytes ?? coldDigest.rssBytes;
    return {
      project,
      coldMs,
      snapshotLoadMs,
      rssBeforeBytes: rssBefore.rss,
      rssPeakBytes: cold.peakRssBytes,
      rssSteadySameProcessBytes: loadRssBytes,
      rssDeltaSameProcessBytes: Math.max(0, loadRssBytes - rssBefore.rss),
      heapUsedBytes,
      coldHeapUsedBytes: coldDigest.heapUsedBytes,
      hotHeapUsedBytes: hotDigest.heapUsedBytes ?? heapUsedBytes,
      clientHeapUsedBytes: hotHeap.heapUsed,
      parentHeapStatistics: {
        usedHeapSize: hotHeap.heapStatistics.used_heap_size,
        totalHeapSize: hotHeap.heapStatistics.total_heap_size,
        heapSizeLimit: hotHeap.heapStatistics.heap_size_limit,
        mallocedMemory: hotHeap.heapStatistics.malloced_memory,
        peakMallocedMemory: hotHeap.heapStatistics.peak_malloced_memory,
        numberOfNativeContexts: hotHeap.heapStatistics.number_of_native_contexts
      },
      snapshotGzBytes: await snapshotBytes(cacheDir),
      childColdPeakRssBytes: coldDigest.childColdPeakRssBytes,
      parentColdIncrementBytes: coldDigest.parentColdIncrementBytes,
      nodes: coldDigest.nodes,
      edges: coldDigest.edges,
      files: loaded.status.javaIndex?.files ?? cold.status.javaIndex?.files,
      types: loaded.status.javaIndex?.types ?? cold.status.javaIndex?.types,
      methods: loaded.status.javaIndex?.methods ?? cold.status.javaIndex?.methods,
      warm,
      attribution,
      hibernate
    };
  } finally {
    await index.close().catch(() => undefined);
  }
}

export async function holdProject(project, repoRoot, timeoutMs, cacheDir, holdMs, runtimeId) {
  await mkdir(cacheDir, { recursive: true });
  const before = collectHeap();
  const client = new JavaIndexClient(repoRoot, cacheDir);
  const index = new RouterJavaIndex(repoRoot, client);
  try {
    await index.open(1);
    const ready = await waitForComplete(index, timeoutMs);
    const digest = await index.queryGraphDigest();
    process.stdout.write(`${JSON.stringify({
      status: "ready",
      project,
      runtimeId: runtimeId ?? project,
      rssBytes: digest.rssBytes ?? process.memoryUsage().rss,
      heapUsedBytes: digest.heapUsedBytes ?? process.memoryUsage().heapUsed,
      rssPeakBytes: ready.peakRssBytes,
      rssBeforeBytes: before.rss,
      files: ready.status.javaIndex?.files
    })}\n`);
    await new Promise(resolve => {
      const timer = setTimeout(resolve, holdMs);
      const onStop = () => {
        clearTimeout(timer);
        resolve();
      };
      process.once("SIGTERM", onStop);
      process.once("SIGINT", onStop);
    });
    return { project, runtimeId: runtimeId ?? project };
  } finally {
    await index.close().catch(() => undefined);
  }
}

function spawnJson(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", SCRIPT_PATH, ...args], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", code => {
      const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
      if (code !== 0) {
        reject(new Error(`exited ${code}: ${line}`));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`invalid JSON (${line || error})`));
      }
    });
  });
}

function spawnHold(args, readyTimeoutMs) {
  const child = spawn(process.execPath, ["--expose-gc", SCRIPT_PATH, ...args], {
    stdio: ["ignore", "pipe", "inherit"]
  });
  let stdout = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hold runtime ready timeout")), readyTimeoutMs + 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
      try {
        const parsed = JSON.parse(line);
        if (parsed.status === "ready") {
          clearTimeout(timer);
          resolve(parsed);
        }
      } catch {
        // Hold processes emit one JSON line when the index is hot.
      }
    });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      if (code && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`hold runtime exited ${code}`));
      }
    });
  });
  return { child, ready };
}

async function emptyNodeRss() {
  const sample = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", "-e", "if (global.gc) gc(); process.stdout.write(JSON.stringify(process.memoryUsage()))"], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`empty node exited ${code}`)));
  });
  return sample.rss;
}

async function copyCache(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}

async function measureConcurrent(label, runtimes, repositories, timeoutMs, cacheRoot, holdMs) {
  const holders = [];
  try {
    for (const runtime of runtimes) {
      holders.push(spawnHold([
        "--mode", "hold",
        "--project", runtime.project,
        "--runtime-id", runtime.runtimeId,
        "--repo", repositories[runtime.project],
        "--cache-root", cacheRoot,
        "--timeout-ms", String(timeoutMs),
        "--hold-ms", String(holdMs)
      ], timeoutMs));
    }
    const ready = await Promise.all(holders.map(item => item.ready));
    const emptyRss = await emptyNodeRss();
    const rssSumBytes = ready.reduce((sum, item) => sum + item.rssBytes, 0);
    const heapUsedSumBytes = ready.reduce((sum, item) => sum + (item.heapUsedBytes ?? 0), 0);
    return {
      id: label,
      status: "MEASURED",
      emptyRssBytes: emptyRss,
      rssSumBytes,
      rssDeltaBytes: Math.max(0, rssSumBytes - emptyRss * ready.length),
      heapUsedSumBytes,
      runtimes: ready
    };
  } catch (error) {
    return unmeasuredScenario(label, error instanceof Error ? error.message : String(error));
  } finally {
    for (const holder of holders) {
      try {
        holder.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    await Promise.all(holders.map(item => new Promise(resolve => {
      const timer = setTimeout(() => {
        try {
          item.child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 2_000);
      item.child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    })));
  }
}

async function main() {
  const cli = parseMemoryBenchmarkCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/run-memory-benchmark.mjs --lishuedu <root> --cipherlink <root> --exam-parent-v3 <root> --output <json>");
    return;
  }
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("run-memory-benchmark must run through isolated validation");
  }
  const cacheRoot = cli.cacheRoot ? path.resolve(cli.cacheRoot) : path.join(os.tmpdir(), "m0-memory-cache");
  await mkdir(cacheRoot, { recursive: true });
  if (cli.mode === "hold") {
    const project = required(cli.project, "--project");
    const cacheDir = path.join(cacheRoot, cli.runtimeId || project);
    await holdProject(project, path.resolve(required(cli.repo, "--repo")), cli.timeoutMs, cacheDir, cli.holdMs, cli.runtimeId);
    return;
  }
  if (cli.project) {
    const result = await benchProject(
      cli.project,
      path.resolve(required(cli.repo, "--repo")),
      cli.timeoutMs,
      cacheRoot
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  const output = required(cli.output, "--output");
  const repositories = Object.fromEntries(PROJECTS.map(project => [project, path.resolve(required(cli.repositories[project], `--${project}`))]));
  const projects = [];
  for (const project of PROJECTS) {
    console.error(`memory-benchmark: ${project}`);
    projects.push(await spawnJson([
      "--project", project,
      "--repo", repositories[project],
      "--timeout-ms", String(cli.timeoutMs),
      "--cache-root", cacheRoot
    ]));
  }
  let scenarios = {
    S1: unmeasuredScenario("S1", "skipped"),
    S2: unmeasuredScenario("S2", "skipped"),
    S4: {
      id: "S4",
      status: "MEASURED",
      projects: []
    }
  };
  if (!cli.skipConcurrent) {
    const plan = concurrentRuntimePlan();
    console.error("memory-benchmark: S1");
    scenarios.S1 = await measureConcurrent("S1", plan.S1, repositories, cli.timeoutMs, cacheRoot, cli.holdMs);
    await copyCache(path.join(cacheRoot, "lishuedu"), path.join(cacheRoot, "lishuedu-wt2"));
    await copyCache(path.join(cacheRoot, "cipherlink"), path.join(cacheRoot, "cipherlink-wt2"));
    console.error("memory-benchmark: S2");
    scenarios.S2 = await measureConcurrent("S2", plan.S2, repositories, cli.timeoutMs, cacheRoot, cli.holdMs);
  }
  scenarios.S4 = {
    id: "S4",
    status: "MEASURED",
    projects: projects.map(item => item.hibernate)
  };
  const payload = {
    schemaVersion: "m0-memory-benchmark/v2",
    dated: new Date().toISOString().slice(0, 10),
    gates: M0_GATES,
    m0WarmP95Ms: M0_WARM_P95_MS,
    projects,
    scenarios
  };
  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    output: path.resolve(output),
    projects: projects.map(item => ({
      project: item.project,
      heapUsedMiB: bytesToMiB(item.heapUsedBytes),
      coldHeapUsedMiB: bytesToMiB(item.coldHeapUsedBytes),
      childColdPeakMiB: item.childColdPeakRssBytes != null ? bytesToMiB(item.childColdPeakRssBytes) : undefined,
      parentColdIncrementMiB: item.parentColdIncrementBytes != null ? bytesToMiB(item.parentColdIncrementBytes) : undefined,
      rssPeakMiB: bytesToMiB(item.rssPeakBytes),
      rssSteadySameProcessMiB: bytesToMiB(item.rssSteadySameProcessBytes),
      snapshotLoadMs: Math.round(item.snapshotLoadMs),
      firstHydrateMs: Math.round(item.warm?.firstHydrateMs ?? 0),
      steadyWarmP95Ms: Math.round(item.warm?.steadyWarmP95Ms ?? 0),
      warmP95Ms: Math.round(item.warm?.p95Ms ?? 0),
      g5SteadyRatio: g5SteadyRatio(item.project, item.warm?.steadyWarmP95Ms ?? 0),
      g4Pass: item.snapshotLoadMs <= M0_GATES.G4_SNAPSHOT_LOAD_MS,
      g5FirstHydratePass: (item.warm?.firstHydrateMs ?? 0) <= M0_GATES.G5_FIRST_HYDRATE_MS,
      g5SteadyPass: (() => {
        const ratio = g5SteadyRatio(item.project, item.warm?.steadyWarmP95Ms ?? 0);
        return ratio != null && ratio <= M0_GATES.G5_P95_RATIO;
      })(),
      stringShare: item.attribution?.shares?.strings
    })),
    S1: scenarios.S1.status === "MEASURED" ? bytesToMiB(scenarios.S1.rssDeltaBytes) : scenarios.S1,
    S2: scenarios.S2.status === "MEASURED" ? bytesToMiB(scenarios.S2.rssDeltaBytes) : scenarios.S2,
    S4: projects.map(item => ({
      project: item.project,
      hibernateHeapMiB: item.hibernate?.heapUsedBytes != null ? bytesToMiB(item.hibernate.heapUsedBytes) : null,
      reheatMs: item.hibernate?.reheatMs != null ? Math.round(item.hibernate.reheatMs) : null
    }))
  }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

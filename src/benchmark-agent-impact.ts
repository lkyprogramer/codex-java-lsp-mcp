// input: External Java navigation golden scenarios.
// output: java_impact payload, latency, precision, recall, read-plan metrics, and run metadata.
// pos: Repeatable benchmark entrypoint for the clean agent router.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { AgentRouter, type ImpactInternalObserver } from "./agent-router/index.js";
import {
  asImpactResult,
  isCompactImpact,
  viewDistinctReadFiles,
  viewImpactFiles,
  viewReadPlanBytes,
  viewReadPlanRangeCount,
  viewSelectedRangesByFile,
  type CompactImpact
} from "./agent-router/output-compact.js";
import type { CandidateEvidence } from "./agent-router/evidence.js";
import { FRAMEWORK_ADAPTERS } from "./agent-router/providers/framework-provider.js";
import type { ImpactOptions, ImpactResult } from "./agent-types.js";
import { projectImpactResultV6 } from "./agent-router/format.js";
import { readRuntimeBuild } from "./build-info.js";
import {
  buildGoldenAttributionV3,
  buildGoldenCounterfactualV3,
  buildImpactPayloadProjectionV3,
  buildProductionRankingSnapshot,
  type ProductionRankingSnapshot
} from "./benchmark/attribution-v3.js";
import { buildImpactDeterminismSnapshot } from "./benchmark/determinism.js";
import { isJavaIndexQuiescent } from "./benchmark/java-index-idle.js";
import { jsonBytesForImpactTokens } from "./benchmark/identity-token-json.js";
import { startBenchmarkProcessResourceObserverFromEnvironment } from "./benchmark/process-resource-observer.js";
import {
  firstTaskBlockingRank,
  goldenEntries,
  goldenFiles,
  loadScenarios,
  ndcgReadAt6,
  readPlanCoordinateRecall,
  readPlanRangeRecall,
  taskBlockingFiles,
  type GoldenKind,
  type Scenario,
  type WarmState
} from "./benchmark/golden-scenario.js";
import { SqlJavaIndexClient } from "./java-index/sql/sql-client.js";
import type { JavaIndexStatus } from "./java-index/index-types.js";
import { RouterJavaIndex } from "./java-index/router-java-index.js";
import { repoCacheRoot } from "./repo-layout.js";
import { DeadlineBudget } from "./runtime/deadline-budget.js";
import { createRequestContext, defaultDeadlineMs, MAX_REQUEST_DEADLINE_MS } from "./runtime/request-context.js";
import type { SourceRange } from "./runtime/source-range.js";
import { JdtlsSession } from "./jdtls-session.js";
import { DEFAULT_TOKEN_BUDGET } from "./context-engine/context-planner.js";
import { toCompactFromContract } from "./context-engine/compact-bridge.js";

type BenchmarkStrategy = "impact" | "no-lsp";

type GoldenSource = "calls" | "methodRelation" | "framework" | "rg" | "typeGraph" | "importGraph" | "seed" | "reference" | "typeHierarchy" | "typeReference" | "no-lsp" | "absent" | "unknown";
type GoldenBlockedBy = "hit" | "readplan-full" | "absent";
type GoldenAbsentReason = "not-recalled-implementer" | "no-type-edge" | "cross-module-cold" | "profile-gate" | "golden-stale-or-low-value";

type GoldenAttributionContext = {
  readonly repoRoot: string;
  readonly semanticPolicy?: string;
  readonly semanticUsed: boolean;
};

type Cli = {
  repoRoot: string;
  /** Optional benchmark-only cache root so fresh/snapshot runs never touch the normal runtime cache. */
  indexCacheDir: string;
  scenarioFile: string;
  projectId: string;
  layoutProfile: string;
  warmState: WarmState;
  mode: ImpactOptions["mode"];
  semanticPolicy: ImpactOptions["semanticPolicy"];
  verbosity: NonNullable<ImpactOptions["verbosity"]>;
  /** Benchmark-only: derive all verbosity payloads from one diagnostic router execution. */
  payloadProjections: boolean;
  runs: number;
  readPlanMaxItems?: number;
  readPlanMaxBytes?: number;
  listScenarios: boolean;
  strategy: BenchmarkStrategy;
  /** V3.2-29 benchmark-only ablation: FrameworkAdapter.id to exclude, e.g. "spring". Empty = full registry. */
  excludeFrameworkAdapter: string;
  deadlineMs: number;
  /** Startup reconciliation is excluded from request P95 but must finish before the steady-state sample. */
  indexPrepareTimeoutMs: number;
};

const DEFAULT_INDEX_PREPARE_TIMEOUT_MS = 600_000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const cli = parseCli(process.argv.slice(2), projectDir);
const jinEngine = process.env.JAVA_LSP_ENGINE === "jin";
if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
  throw new Error(
    "benchmark-agent-impact requires the detached isolated validation harness; refusing to use a caller runtime cache"
  );
}
if (cli.warmState !== "cold-nolsp" && process.env.JAVA_LSP_ISOLATED_REPO_WORKTREE !== "1") {
  throw new Error("warm benchmark-agent-impact runs require a detached Java repository from run-isolated-jdt-benchmark.mjs");
}
const scenarios = loadScenarios(cli.scenarioFile).filter(scenario => !scenario.projectId || scenario.projectId === cli.projectId);
const runtimeBuild = readRuntimeBuild();
const metadata = {
  generatedAt: new Date().toISOString(),
  repoRoot: cli.repoRoot,
  indexCacheDir: cli.indexCacheDir,
  repoCommit: git(cli.repoRoot, ["rev-parse", "--short=12", "HEAD"]) || "unknown",
  projectId: cli.projectId,
  layoutProfile: cli.layoutProfile,
  warmState: cli.warmState,
  mode: cli.mode,
  semanticPolicy: effectiveSemanticPolicy(cli),
  verbosity: cli.verbosity,
  payloadProjections: cli.payloadProjections,
  strategy: cli.strategy,
  engine: jinEngine ? "jin" : "default",
  indexBackend: "v2",
  // Recorded so a run is comparable only against runs with the same budget.
  deadlineMs: cli.deadlineMs,
  runs: cli.runs,
  readPlanMaxItems: cli.readPlanMaxItems,
  readPlanMaxBytes: cli.readPlanMaxBytes,
  scenarioFile: cli.scenarioFile,
  runtimeBuild,
  // The V2 runtime reconciles its static index before serving requests.  This
  // records that one-time setup separately from request P50/P95 (Task 22
  // explicitly forbids folding the initial sweep into steady impact latency).
  prepareJavaIndexMs: 0,
  prepareJavaIndexReconciled: false,
  prepareJavaIndexStatus: undefined as JavaIndexStatus | undefined,
  indexPrepareTimeoutMs: cli.indexPrepareTimeoutMs,
  prepareWarmMs: 0,
  prepareWarmPhaseMs: {} as Record<string, number>
};

if (cli.listScenarios) {
  console.log(JSON.stringify({
    metadata,
    scenarios: scenarios.map(scenario => ({
      id: scenario.id,
      name: scenario.name,
      projectId: scenario.projectId,
      layoutProfile: scenario.layoutProfile,
      warmState: scenario.warmState,
      mustHit: goldenFiles(scenario, "mustHit").length,
      taskBlocking: goldenFiles(scenario, "taskBlocking").length,
      shouldHit: goldenFiles(scenario, "shouldHit").length,
      support: goldenFiles(scenario, "support").length
    }))
  }, null, 2));
  process.exit(0);
}

const processResources = startBenchmarkProcessResourceObserverFromEnvironment(
  `benchmark-agent-impact:${cli.warmState}`,
  cli.strategy === "impact" ? "PRESENT" : "NOT_PRESENT"
);

const session = cli.strategy === "impact" && !jinEngine ? new JdtlsSession(cli.repoRoot) : undefined;
// A benchmark has no runtime coordinator, so it must close the worker itself
// after printing its results.
const javaIndexClient = cli.strategy === "impact"
  ? new SqlJavaIndexClient(cli.repoRoot, path.join(cli.indexCacheDir, "index.sqlite"))
  : undefined;
const routerJavaIndex = javaIndexClient
  ? new RouterJavaIndex(cli.repoRoot, javaIndexClient)
  : undefined;
const javaIndex = routerJavaIndex;
const frameworkAdapters = cli.excludeFrameworkAdapter
  ? FRAMEWORK_ADAPTERS.filter(adapter => adapter.id !== cli.excludeFrameworkAdapter)
  : FRAMEWORK_ADAPTERS;
const router = session && javaIndex
  ? new AgentRouter(cli.repoRoot, session, javaIndex, undefined, undefined, undefined, undefined, frameworkAdapters)
  : undefined;
if (routerJavaIndex && javaIndexClient) {
  const startedAt = performance.now();
  const preparation = await prepareJavaIndex(cli, routerJavaIndex, javaIndexClient);
  metadata.prepareJavaIndexMs = performance.now() - startedAt;
  metadata.prepareJavaIndexReconciled = preparation.reconciled;
  metadata.prepareJavaIndexStatus = preparation.status;
}
if (session && cli.warmState !== "cold-nolsp") {
  const startedAt = performance.now();
  await prepareWarmState(cli, session, scenarios);
  metadata.prepareWarmMs = performance.now() - startedAt;
  metadata.prepareWarmPhaseMs = session.drainPhaseMetrics();
}

const rows = [];
for (const scenario of scenarios) {
  const attempts = [];
  for (let run = 0; run < cli.runs; run += 1) {
    attempts.push(
      cli.strategy === "no-lsp"
        ? noLspAttempt(cli.repoRoot, scenario)
        : jinEngine
          ? await jinAttempt(routerJavaIndex as RouterJavaIndex, cli, scenario)
          : await impactAttempt(router as AgentRouter, session as JdtlsSession, cli, scenario)
    );
  }
  rows.push({
    id: scenario.id,
    name: scenario.name,
    attempts,
    summary: summarize(attempts)
  });
}

console.log(JSON.stringify({
  metadata,
  totals: summarize(rows.flatMap(row => row.attempts)),
  rows
}, null, 2));

if (session) {
  await session.stop();
}
if (javaIndexClient) {
  await javaIndexClient.close();
}
await processResources?.stop();

function parseCli(args: string[], root: string): Cli {
  if (args.includes("--retrieval-enabled") || args.includes("--continue-policy")) {
    throw new Error("retrieval continuation was removed in JIN N0");
  }
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--list-scenarios" || item === "--payload-projections") {
      values.set(item, true);
      continue;
    }
    if (item.startsWith("--")) {
      values.set(item, args[index + 1]);
      index += 1;
    }
  }
  const projectId = stringArg(values, "--project-id", process.env.JAVA_LSP_BENCH_PROJECT_ID || "lishuedu");
  const warmState = stringArg(values, "--warm-state", process.env.JAVA_LSP_BENCH_WARM_STATE || "cold-nolsp") as WarmState;
  const mode = stringArg(values, "--mode", process.env.JAVA_LSP_BENCH_MODE || "balanced") as ImpactOptions["mode"];
  const semanticPolicy = stringArg(values, "--semantic-policy", process.env.JAVA_LSP_BENCH_SEMANTIC_POLICY || "auto") as ImpactOptions["semanticPolicy"];
  // Match the policy java_impact will actually run under for this warm state,
  // so the derived deadline equals what a real caller gets. Using the raw
  // --semantic-policy default (auto) would budget 3000ms while a cold-nolsp
  // request is forced to fast and budgets 2000ms.
  const effectivePolicy: "fast" | "auto" | "required" =
    warmState === "cold-nolsp" ? "fast" : warmState === "warm-required" ? "required" : semanticPolicy;
  const repoRoot = stringArg(
    values,
    "--repo-root",
    process.env.JAVA_LSP_BENCH_REPO_ROOT || process.env.LISHUEDU_ROOT || path.resolve(root, "..", "..")
  );
  return {
    repoRoot,
    indexCacheDir: path.resolve(stringArg(
      values,
      "--index-cache-dir",
      process.env.JAVA_LSP_BENCH_INDEX_CACHE_DIR || repoCacheRoot(repoRoot)
    )),
    scenarioFile: stringArg(values, "--scenarios", process.env.JAVA_LSP_BENCH_SCENARIOS || path.join(root, "golden", `${projectId}.scenarios.jsonl`)),
    projectId,
    layoutProfile: stringArg(values, "--layout-profile", process.env.JAVA_LSP_BENCH_LAYOUT_PROFILE || (projectId === "exam-parent-v3" ? "maven-reactor" : projectId === "generic-java" || projectId === "java-index-v2" ? "generic-java" : "ddd-gradle")),
    warmState,
    mode,
    semanticPolicy,
    verbosity: stringArg(values, "--verbosity", process.env.JAVA_LSP_BENCH_VERBOSITY || "standard") as NonNullable<ImpactOptions["verbosity"]>,
    payloadProjections: values.get("--payload-projections") === true,
    runs: Number(stringArg(values, "--runs", process.env.JAVA_LSP_BENCH_RUNS || "1")),
    readPlanMaxItems: optionalPositiveIntegerArg(values, "--read-plan-max-items", process.env.JAVA_LSP_BENCH_READ_PLAN_MAX_ITEMS),
    readPlanMaxBytes: optionalPositiveIntegerArg(values, "--read-plan-max-bytes", process.env.JAVA_LSP_BENCH_READ_PLAN_MAX_BYTES),
    listScenarios: values.get("--list-scenarios") === true,
    strategy: stringArg(values, "--strategy", process.env.JAVA_LSP_BENCH_STRATEGY || "impact") as BenchmarkStrategy,
    excludeFrameworkAdapter: stringArg(values, "--exclude-framework-adapter", process.env.JAVA_LSP_BENCH_EXCLUDE_FRAMEWORK_ADAPTER || ""),
    // The same absolute deadline java_impact gives a real caller in this warm
    // state, so the benchmark measures what users actually get.
    deadlineMs: Math.min(
      MAX_REQUEST_DEADLINE_MS,
      optionalPositiveIntegerArg(values, "--deadline-ms", process.env.JAVA_LSP_BENCH_DEADLINE_MS)
        ?? defaultDeadlineMs(mode, effectivePolicy)
    ),
    // This is startup-only work and is deliberately excluded from steady P95.
    // Large real repositories can legitimately need longer than the old 120s
    // hard stop for their first snapshot; callers can lower it for a bounded
    // diagnostic run without changing the benchmark's request budget.
    indexPrepareTimeoutMs: optionalPositiveIntegerArg(
      values,
      "--index-prepare-timeout-ms",
      process.env.JAVA_LSP_BENCH_INDEX_PREPARE_TIMEOUT_MS
    ) ?? DEFAULT_INDEX_PREPARE_TIMEOUT_MS
  };
}

async function jinAttempt(javaIndex: RouterJavaIndex, cli: Cli, scenario: Scenario): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  const graph = await javaIndex.queryContextGraph({
    fromRelativePath: scenario.anchor.file,
    intent: "auto",
    taskText: `${scenario.name ?? ""} ${(scenario.anchor.taskKeywords ?? []).join(" ")}`,
    profile: scenario.anchor.profile,
    maxHops: 4,
    maxExpansions: 4096,
    tokenBudget: DEFAULT_TOKEN_BUDGET,
    plan: true,
    includeSource: false,
    anchorLine: scenario.anchor.line,
    anchorColumn: scenario.anchor.column
  });
  const elapsedMs = performance.now() - startedAt;
  if (!graph.contract) {
    throw new Error("JAVA_LSP_ENGINE=jin expected QUERY_CONTEXT_GRAPH contract");
  }
  const result = toCompactFromContract(graph.contract, elapsedMs);
  const rawSearchPayload = jsonBytesForImpactTokens(result);
  const readingPayload = readPlanBytes(result);
  const candidatePaths = viewImpactFiles(result);
  const readFiles = distinctReadFiles(result);
  const quality = evaluate(candidatePaths, readFiles, scenario);
  const kibVisible = (rawSearchPayload + readingPayload) / 1024;
  const blockingHitsInReadPlan = readFiles.filter(file => taskBlockingFiles(scenario).has(file)).length;
  const rangeLineRecall = readPlanRangeRecall(scenario, selectedRangesByFile(result));
  const rangeCoordinateRecall = readPlanCoordinateRecall(scenario, new Map());
  const qualityV3 = {
    "NDCG_read@6": ndcgReadAt6(scenario, readFiles),
    firstTaskBlockingRank: firstTaskBlockingRank(scenario, candidatePaths),
    readPlanRangeRecall: rangeLineRecall,
    RangeLineRecall: rangeLineRecall,
    RangeCoordinateRecall: rangeCoordinateRecall,
    evidencePerKiB: kibVisible > 0 ? quality.hitFiles / kibVisible : 0,
    taskBlockingHitsPerKiB: kibVisible > 0 ? blockingHitsInReadPlan / kibVisible : 0
  };
  return {
    ...attemptPayload("impact", quality, rawSearchPayload, readingPayload, elapsedMs, 1, viewReadPlanRangeCount(result) || viewDistinctReadFiles(result).length, result.cost.suppressedRawBytes, 0),
    ...readPlanMetrics(result),
    ...qualityV3,
    timing: timingPayload(result, {}),
    payloadProjection: undefined,
    payloadProjectionElapsedMs: undefined,
    goldenAttribution: undefined,
    counterfactual: undefined,
    frameworkEvidence: { mapstruct: { selected: 0, readPlan: 0, golden: 0, byKind: {} } },
    determinism: compactDeterminismSnapshot(result)
  };
}

async function impactAttempt(router: AgentRouter, session: JdtlsSession, cli: Cli, scenario: Scenario): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  let coordinateRangesByAbsolutePath: ReadonlyMap<string, readonly SourceRange[]> = new Map();
  let rankingSource: {
    ranked: readonly CandidateEvidence[];
    selectedPaths: readonly string[];
  } | undefined;
  const observer: ImpactInternalObserver = {
    readPlanCoordinates(rangesByAbsolutePath) {
      coordinateRangesByAbsolutePath = rangesByAbsolutePath;
    }
  };
  if (cli.payloadProjections || cli.verbosity === "diagnostic") {
    observer.productionRanking = (ranked, selectedPaths) => {
      rankingSource = { ranked, selectedPaths };
    };
  }
  const request = createRequestContext({
    repoRoot: cli.repoRoot,
    repoHash: "benchmark",
    generation: 0,
    freshnessMode: "NORMAL",
    cacheReadAllowed: true,
    cacheWriteAllowed: true,
    negativeLookupAllowed: false,
    mode: cli.mode,
    semanticPolicy: effectiveSemanticPolicy(cli),
    budget: DeadlineBudget.fromTimeout(cli.deadlineMs)
  });
  const canonical = await router.impact(
    {
      anchors: [scenario.anchor],
      mode: cli.mode,
      profile: scenario.anchor.profile,
      semanticPolicy: effectiveSemanticPolicy(cli),
      semanticTimeoutMs: effectiveSemanticTimeoutMs(cli),
      testReadMode: "defer",
      focusModules: scenario.anchor.focusModules || [],
      excludeModules: [],
      taskKeywords: scenario.anchor.taskKeywords || [],
      crossModulePolicy: "auto",
      verbosity: cli.payloadProjections ? "diagnostic" : cli.verbosity,
      readPlanMaxItems: cli.readPlanMaxItems,
      readPlanMaxBytes: cli.readPlanMaxBytes
    },
    // The benchmark has no live watcher, so it uses generation 0 with caches
    // enabled — the pre-freshness behavior — under the same production budget.
    request,
    observer
  );
  const routerElapsedMs = performance.now() - startedAt;
  const productionRanking: ProductionRankingSnapshot | undefined = rankingSource
    ? buildProductionRankingSnapshot(rankingSource.ranked, rankingSource.selectedPaths)
    : undefined;
  recordJavaIndexQueueDepth(canonical);
  const projectionStartedAt = performance.now();
  const diagnosticCanonical = cli.payloadProjections || cli.verbosity === "diagnostic"
    ? asImpactResult(canonical)
    : undefined;
  const payloadProjection = diagnosticCanonical && cli.payloadProjections
    ? buildImpactPayloadProjectionV3(diagnosticCanonical)
    : undefined;
  const result = diagnosticCanonical && cli.payloadProjections
    ? projectImpactResultV6(diagnosticCanonical, cli.verbosity)
    : canonical;
  const payloadProjectionElapsedMs = cli.payloadProjections
    ? performance.now() - projectionStartedAt
    : undefined;
  const elapsedMs = routerElapsedMs;
  const rawSearchPayload = jsonBytesForImpactTokens(result);
  const readingPayload = readPlanBytes(result);
  const candidatePaths = viewImpactFiles(result);
  const readFiles = distinctReadFiles(result);
  const quality = evaluate(candidatePaths, readFiles, scenario);
  const kibVisible = (rawSearchPayload + readingPayload) / 1024;
  const blockingHitsInReadPlan = readFiles.filter(file => taskBlockingFiles(scenario).has(file)).length;
  const rangeLineRecall = readPlanRangeRecall(scenario, selectedRangesByFile(result));
  const rangeCoordinateRecall = readPlanCoordinateRecall(
    scenario,
    relativeCoordinateRanges(cli.repoRoot, coordinateRangesByAbsolutePath)
  );
  const qualityV3 = {
    "NDCG_read@6": ndcgReadAt6(scenario, readFiles),
    firstTaskBlockingRank: firstTaskBlockingRank(scenario, candidatePaths),
    readPlanRangeRecall: rangeLineRecall,
    RangeLineRecall: rangeLineRecall,
    RangeCoordinateRecall: rangeCoordinateRecall,
    evidencePerKiB: kibVisible > 0 ? quality.hitFiles / kibVisible : 0,
    taskBlockingHitsPerKiB: kibVisible > 0 ? blockingHitsInReadPlan / kibVisible : 0
  };
  const diagnosticResult = diagnosticCanonical ?? result;
  const sessionPhaseMs = session.drainPhaseMetrics();
  const attributionContext = productionRanking && diagnosticCanonical && {
    repoRoot: cli.repoRoot,
    mode: cli.mode,
    profile: scenario.anchor.profile,
    semanticUsed: diagnosticCanonical.semantic.used,
    semanticTimeout: diagnosticCanonical.metrics?.semantic?.timeout === true,
    coverage: metadata.prepareJavaIndexStatus?.coverage ?? []
  };
  const firstAttempt = {
    // Task 30 makes the whole read-plan range lookup one batched worker
    // request. `roundTrips` measures the agent-visible impact exchange plus
    // that range batch; it must not grow with selected read-plan files.
    ...attemptPayload("impact", quality, rawSearchPayload, readingPayload, elapsedMs, 2, viewReadPlanRangeCount(result) || viewDistinctReadFiles(result).length, result.cost.suppressedRawBytes, 0),
    ...readPlanMetrics(result),
    ...qualityV3,
    timing: timingPayload(diagnosticResult, sessionPhaseMs),
    payloadProjection,
    payloadProjectionElapsedMs,
    // Attribution observes the exact production family rank and read-plan;
    // no second ranker or provider pass is executed for benchmark evidence.
    goldenAttribution: attributionContext && productionRanking
      ? buildGoldenAttributionV3(scenario, productionRanking, attributionContext)
      : undefined,
    counterfactual: productionRanking
      ? buildGoldenCounterfactualV3()
      : undefined,
    frameworkEvidence: { mapstruct: mapstructEvidenceSummary(diagnosticResult, scenario) },
    // Task 36's 20-run verifier consumes only semantic ordering/state. Keep
    // latency/cache counters in their ordinary attempt fields so benign
    // diagnostic variance cannot mask or manufacture semantic drift.
    determinism: diagnosticCanonical
      ? buildImpactDeterminismSnapshot(diagnosticCanonical, cli.repoRoot, productionRanking)
      : compactDeterminismSnapshot(result)
  };
  return firstAttempt;
}

function compactDeterminismSnapshot(result: ImpactResult | CompactImpact): {
  candidatePaths: string[];
  readPlan: Array<{ path: string; priority: string; ranges: Array<{ startLine: number; endLine: number; reason: string }> }>;
  completion: {
    semantic: string;
    semanticUsed: boolean;
    coverage: string;
    requestGeneration: number;
    indexedGeneration: number;
    changedDuringRequest: boolean;
  };
} {
  const ranges = viewSelectedRangesByFile(result);
  const readPlan = [...ranges.entries()].map(([file, spans]) => ({
    path: file,
    priority: "",
    ranges: spans.map(span => ({ startLine: span.startLine, endLine: span.endLine, reason: "" }))
  }));
  if (isCompactImpact(result)) {
    return {
      candidatePaths: viewImpactFiles(result),
      readPlan,
      completion: {
        semantic: result.semantic.completion,
        semanticUsed: result.semantic.used,
        coverage: result.freshness.coverage,
        requestGeneration: result.freshness.requestGeneration,
        indexedGeneration: result.freshness.indexedGeneration,
        changedDuringRequest: result.freshness.changedDuringRequest
      }
    };
  }
  return {
    candidatePaths: viewImpactFiles(result),
    readPlan,
    completion: {
      semantic: result.semantic.completion,
      semanticUsed: result.semantic.used,
      coverage: result.freshness.coverage,
      requestGeneration: result.freshness.requestGeneration,
      indexedGeneration: result.freshness.indexedGeneration,
      changedDuringRequest: result.freshness.changedDuringRequest
    }
  };
}

function recordJavaIndexQueueDepth(result: ImpactResult | CompactImpact): void {
  if (isCompactImpact(result)) return;
  const rpc = result.metrics?.javaIndex?.rpc;
  if (!rpc || typeof rpc !== "object") return;
  const operations = (rpc as { operations?: unknown }).operations;
  if (!operations || typeof operations !== "object") return;
  for (const [operation, value] of Object.entries(operations)) {
    if (!value || typeof value !== "object") continue;
    const depth = (value as { maxWorkerQueueDepth?: unknown }).maxWorkerQueueDepth;
    if (typeof depth === "number") processResources?.recordQueueDepth(`java-index:${operation}`, depth);
  }
}

function noLspAttempt(repoRoot: string, scenario: Scenario): Record<string, unknown> {
  const startedAt = performance.now();
  const rg = runNoLspRg(repoRoot, scenario);
  const candidatePaths = unique([scenario.anchor.file, ...rg.files]);
  const readFiles = candidatePaths.slice(0, 6);
  const readingPayload = readMatchedFilesBytes(repoRoot, readFiles, rg.lineByPath, scenario);
  const rawSearchPayload = Buffer.byteLength(rg.stdout, "utf8");
  const quality = evaluate(candidatePaths, readFiles, scenario);
  const kibVisible = (rawSearchPayload + readingPayload) / 1024;
  const blockingHitsInReadPlan = readFiles.filter(file => taskBlockingFiles(scenario).has(file)).length;
  return {
    ...attemptPayload("no-lsp", quality, rawSearchPayload, readingPayload, performance.now() - startedAt, 1 + readFiles.length, readFiles.length, 0, rawSearchPayload),
    "NDCG_read@6": ndcgReadAt6(scenario, readFiles),
    firstTaskBlockingRank: firstTaskBlockingRank(scenario, candidatePaths),
    // no-lsp has no range-aware read plan at all - a scenario that later
    // carries mustReadRanges genuinely gets 0 coverage here, not "unmeasured".
    readPlanRangeRecall: readPlanRangeRecall(scenario, new Map()),
    RangeLineRecall: readPlanRangeRecall(scenario, new Map()),
    RangeCoordinateRecall: readPlanCoordinateRecall(scenario, new Map()),
    evidencePerKiB: kibVisible > 0 ? quality.hitFiles / kibVisible : 0,
    taskBlockingHitsPerKiB: kibVisible > 0 ? blockingHitsInReadPlan / kibVisible : 0,
    goldenAttribution: goldenAttributionForNoLsp(repoRoot, candidatePaths, readFiles, scenario)
  };
}

function attemptPayload(
  strategy: BenchmarkStrategy,
  quality: Record<string, number>,
  rawSearchPayload: number,
  readingPayload: number,
  elapsedMs: number,
  roundTrips: number,
  readPlanItems: number,
  rgRawBytesSuppressed: number,
  rgRawBytesExposed: number
): Record<string, unknown> {
  return {
    strategy,
    rawSearchPayload,
    readingPayload,
    totalAgentVisiblePayload: rawSearchPayload + readingPayload,
    estimatedTokens: Math.round((rawSearchPayload + readingPayload) / 4),
    elapsedMs,
    roundTrips,
    returnedFiles: quality.returnedFiles,
    hitFiles: quality.hitFiles,
    precision: quality.precision,
    recall: quality.recall,
    pCandAt5: quality.pCandAt5,
    pCandAt10: quality.pCandAt10,
    rCand: quality.recall,
    pRead: quality.pRead,
    rReadMust: quality.rReadMust,
    rTaskBlocking: quality.rTaskBlocking,
    readPlanItems,
    rgRawBytesSuppressed,
    rgRawBytesExposed
  };
}

function stringArg(values: Map<string, string | true>, name: string, fallback: string): string {
  const value = values.get(name);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function optionalPositiveIntegerArg(values: Map<string, string | true>, name: string, fallback?: string): number | undefined {
  const raw = values.get(name);
  const value = typeof raw === "string" && raw.length > 0 ? raw : fallback;
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function effectiveSemanticPolicy(cli: Cli): ImpactOptions["semanticPolicy"] {
  return cli.warmState === "cold-nolsp" ? "fast" : cli.warmState === "warm-required" ? "required" : cli.semanticPolicy;
}

function effectiveSemanticTimeoutMs(cli: Cli): number {
  return cli.warmState === "warm-required" ? 10000 : 1500;
}

async function prepareWarmState(cli: Cli, session: JdtlsSession, items: Scenario[]): Promise<void> {
  if (cli.warmState === "cold-nolsp") {
    return;
  }
  await session.ensureStarted();
  if (cli.warmState === "warm-auto") {
    await waitForProgressIdle(session, 30000);
  }
  if (cli.warmState === "warm-required") {
    for (const scenario of items) {
      await session.documentSymbolsWithRetry(path.resolve(cli.repoRoot, scenario.anchor.file), 45000);
    }
  }
}

/**
 * Mirrors RepoRuntimeManager's V2 OPEN/reconcile lifecycle without starting
 * JDTLS.  The static sweep is startup work, not an impact request, so the
 * benchmark reports it in metadata and only times the steady router calls.
 */
async function prepareJavaIndex(
  cli: Cli,
  index: RouterJavaIndex,
  client: SqlJavaIndexClient
): Promise<{ reconciled: boolean; status: JavaIndexStatus }> {
  await index.open(0);
  let reconciled = false;
  const opened = await index.routerStatus();
  if (opened.coverage !== "complete" && !opened.javaIndex.snapshotVerificationPending) {
    await index.reconcile(0);
    reconciled = true;
  }
  return { reconciled, status: await waitForJavaIndexIdle(client, cli.indexPrepareTimeoutMs) };
}

async function waitForJavaIndexIdle(client: SqlJavaIndexClient, timeoutMs: number): Promise<JavaIndexStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = await client.status();
  while (!isJavaIndexQuiescent(status)) {
    if (Date.now() >= deadline) {
      throw new Error(`JavaIndex did not finish startup reconciliation within ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    status = await client.status();
  }
  return status;
}

async function waitForProgressIdle(session: JdtlsSession, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = session.status().progress;
    if (status.active === 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function readPlanBytes(result: ImpactResult | CompactImpact): number {
  return viewReadPlanBytes(result);
}

function readPlanMetrics(result: ImpactResult | CompactImpact): Record<string, unknown> {
  const readPlan = !isCompactImpact(result) ? result.metrics?.readPlan : undefined;
  const bytes = readPlanBytes(result);
  const maxReadBytes = Number(readPlan?.maxReadBytes || 0);
  return {
    readPlanFiles: viewDistinctReadFiles(result).length,
    readPlanRanges: viewReadPlanRangeCount(result),
    readPlanBytes: bytes,
    budgetUtilization: maxReadBytes > 0 ? bytes / maxReadBytes : 0,
    budgetExceededByAnchor: readPlan?.budgetExceededByAnchor === true,
    marginalUtilityBySelectedFile: readPlan?.marginalUtilityBySelectedFile
  };
}

function selectedRangesByFile(result: ImpactResult | CompactImpact): Map<string, Array<{ startLine: number; endLine: number }>> {
  return viewSelectedRangesByFile(result);
}

function relativeCoordinateRanges(
  repoRoot: string,
  rangesByAbsolutePath: ReadonlyMap<string, readonly SourceRange[]>
): Map<string, readonly SourceRange[]> {
  return new Map([...rangesByAbsolutePath].map(([absolutePath, ranges]) => [
    path.relative(repoRoot, absolutePath).split(path.sep).join("/"),
    ranges
  ]));
}

function readMatchedFilesBytes(repoRoot: string, files: string[], lineByPath: Map<string, number>, scenario: Scenario): number {
  let bytes = 0;
  for (const file of files) {
    const absolutePath = path.join(repoRoot, file);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const line = file === scenario.anchor.file ? scenario.anchor.line : lineByPath.get(file) || 1;
    const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
    bytes += Buffer.byteLength(lines.slice(Math.max(0, line - 17), line + 32).join("\n"), "utf8");
  }
  return bytes;
}

function distinctReadFiles(result: ImpactResult | CompactImpact): string[] {
  return viewDistinctReadFiles(result);
}

function timingPayload(result: ImpactResult | CompactImpact, sessionPhaseMs: Record<string, number>): Record<string, unknown> {
  if (isCompactImpact(result)) {
    return compactRecord({
      sessionPhaseMs,
      elapsedMs: result.metrics?.elapsedMs
    });
  }
  const metrics = result.metrics;
  return compactRecord({
    phaseMs: metrics?.phaseMs,
    sessionPhaseMs,
    semantic: metrics?.semantic,
    typeReference: metrics?.typeReference,
    importGraph: metrics?.importGraph,
    persistedSemantic: metrics?.persistedSemantic,
    javaIndex: metrics?.javaIndex
  });
}

type MapstructEvidenceCounts = {
  selected: number;
  readPlan: number;
  golden: number;
  byKind: Record<string, { selected: number; readPlan: number; golden: number }>;
};

/**
 * Preserves framework evidence outcomes separately from generic recall. A
 * golden file may already be recalled through imports/rg, while a MapStruct
 * signal still changes its rank; selected/readPlan/golden counts make that
 * distinction explicit for canary comparisons without changing router output.
 */
function mapstructEvidenceSummary(
  result: ImpactResult | CompactImpact,
  scenario: Scenario
): MapstructEvidenceCounts {
  const goldenPaths = new Set(goldenEntries(scenario).map(entry => entry.file));
  const selectedPaths = new Set<string>();
  const readPaths = new Set<string>();
  const goldenSelectedPaths = new Set<string>();
  const byKind: MapstructEvidenceCounts["byKind"] = {};
  const files = isCompactImpact(result)
    ? result.contexts.map(context => ({
      path: context.path,
      reasons: context.proof,
      inReadPlan: context.spans.length > 0
    }))
    : result.files.map(file => ({
      path: String(file.path),
      reasons: Array.isArray(file.reasons) ? file.reasons : [],
      inReadPlan: result.readPlan.some(item => item.fileId === file.id)
    }));

  for (const file of files) {
    const filePath = file.path;
    const reasons = file.reasons.filter(reason => reason.startsWith("MAPSTRUCT_"));
    if (!filePath || reasons.length === 0) continue;
    const inGolden = goldenPaths.has(filePath);
    selectedPaths.add(filePath);
    if (file.inReadPlan) readPaths.add(filePath);
    if (inGolden) goldenSelectedPaths.add(filePath);
    for (const kind of new Set(reasons)) {
      const counts = byKind[kind] ??= { selected: 0, readPlan: 0, golden: 0 };
      counts.selected += 1;
      if (file.inReadPlan) counts.readPlan += 1;
      if (inGolden) counts.golden += 1;
    }
  }

  return {
    selected: selectedPaths.size,
    readPlan: readPaths.size,
    golden: goldenSelectedPaths.size,
    byKind
  };
}

function goldenAttributionForNoLsp(repoRoot: string, candidatePaths: string[], readFiles: string[], scenario: Scenario): Array<Record<string, unknown>> {
  const candidates = new Set(candidatePaths);
  const readSet = new Set(readFiles);
  const context = { repoRoot, semanticPolicy: "fast", semanticUsed: false };
  return goldenEntries(scenario).map(({ file, kind }) => {
    const inFiles = candidates.has(file);
    const inReadPlan = readSet.has(file);
    return goldenAttributionRow(scenario, file, kind, inFiles, inReadPlan, inFiles ? "no-lsp" : "absent", context);
  });
}

function goldenAttributionRow(
  scenario: Scenario,
  file: string,
  kind: GoldenKind,
  inFiles: boolean,
  inReadPlan: boolean,
  source: GoldenSource,
  context: GoldenAttributionContext
): Record<string, unknown> {
  const blocked = blockedBy(inFiles, inReadPlan);
  return compactRecord({
    scenario: scenario.name,
    file,
    kind,
    inFiles,
    inReadPlan,
    source,
    blockedBy: blocked,
    absentReason: blocked === "absent" ? goldenAbsentReason(context, scenario, file, kind) : undefined,
    profile: scenario.anchor.profile,
    semanticUsed: context.semanticUsed
  });
}

function blockedBy(inFiles: boolean, inReadPlan: boolean): GoldenBlockedBy {
  return inReadPlan ? "hit" : inFiles ? "readplan-full" : "absent";
}

function goldenAbsentReason(context: GoldenAttributionContext, scenario: Scenario, file: string, kind: GoldenKind): GoldenAbsentReason {
  const absolutePath = path.join(context.repoRoot, file);
  if (!existsSync(absolutePath) || kind === "support") {
    return "golden-stale-or-low-value";
  }

  const anchorText = readJavaFile(context.repoRoot, scenario.anchor.file);
  const goldenText = readJavaFile(context.repoRoot, file);
  const anchorType = simpleTypeName(scenario.anchor.file);
  const goldenType = simpleTypeName(file);
  if (implementsOrExtends(goldenText, anchorType)) {
    return "not-recalled-implementer";
  }
  if (mentionsType(anchorText, goldenType) || mentionsType(goldenText, anchorType)) {
    return "no-type-edge";
  }

  const goldenModule = moduleName(file);
  if (goldenModule && goldenModule !== moduleName(scenario.anchor.file) && context.semanticPolicy !== "required") {
    return "cross-module-cold";
  }
  if (context.semanticPolicy === "auto" && !context.semanticUsed) {
    return "profile-gate";
  }
  return "golden-stale-or-low-value";
}

function readJavaFile(repoRoot: string, file: string): string {
  const absolutePath = path.join(repoRoot, file);
  return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
}

function simpleTypeName(file: string): string {
  return path.basename(file, ".java");
}

function implementsOrExtends(content: string, typeName: string): boolean {
  return new RegExp(`\\b(?:implements|extends)\\b[^{};]*\\b${regexLiteral(typeName)}\\b`).test(content);
}

function mentionsType(content: string, typeName: string): boolean {
  return new RegExp(`\\b${regexLiteral(typeName)}\\b`).test(content);
}

function moduleName(file: string): string | undefined {
  const segments = file.split(/[\\/]+/).filter(Boolean);
  const modulesIndex = segments.indexOf("modules");
  if (modulesIndex >= 0) {
    return segments[modulesIndex + 1];
  }
  const srcIndex = segments.indexOf("src");
  return srcIndex > 0 ? segments.slice(0, srcIndex).join("/") : undefined;
}

function runNoLspRg(repoRoot: string, scenario: Scenario): { stdout: string; files: string[]; lineByPath: Map<string, number> } {
  const pattern = unique(noLspTerms(repoRoot, scenario)).map(regexLiteral).join("|") || regexLiteral(path.basename(scenario.anchor.file, ".java"));
  // Task 36 classification: KEEP_NON_REQUEST_PATH_WITH_REASON. This fallback
  // is confined to the offline benchmark harness; MCP request paths use the
  // bounded streaming RgRunner and never execute synchronous rg.
  const result = spawnSync("rg", ["--line-number", "--no-heading", "-g", "*.java", pattern, "."], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024
  });
  if (result.status && result.status !== 1) {
    throw new Error(`no-lsp rg failed: ${(result.stderr || "").trim()}`);
  }
  const lineByPath = new Map<string, number>();
  const files: string[] = [];
  for (const line of (result.stdout || "").split(/\r?\n/)) {
    const match = line.match(/^(.+?):(\d+):/);
    if (!match) {
      continue;
    }
    const file = normalizeRelative(match[1]);
    if (!lineByPath.has(file)) {
      lineByPath.set(file, Number(match[2]));
      files.push(file);
    }
  }
  return { stdout: result.stdout || "", files, lineByPath };
}

function noLspTerms(repoRoot: string, scenario: Scenario): string[] {
  const anchorPath = path.join(repoRoot, scenario.anchor.file);
  const line = existsSync(anchorPath) ? readFileSync(anchorPath, "utf8").split(/\r?\n/)[scenario.anchor.line - 1] || "" : "";
  const identifiers = line.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
  return [
    path.basename(scenario.anchor.file, ".java"),
    ...(scenario.anchor.taskKeywords || []),
    ...identifiers.filter(item => item.length >= 4)
  ];
}

function normalizeRelative(file: string): string {
  return file.replace(/^\.\//, "");
}

function evaluate(candidateFiles: string[], readFiles: string[], scenario: Scenario): Record<string, number> {
  const candidates = new Set(candidateFiles);
  const goldenAll = new Set([
    ...goldenFiles(scenario, "mustHit"),
    ...goldenFiles(scenario, "taskBlocking"),
    ...goldenFiles(scenario, "shouldHit"),
    ...goldenFiles(scenario, "support")
  ]);
  const mustHit = new Set(goldenFiles(scenario, "mustHit"));
  const blocking = taskBlockingFiles(scenario);
  const hitFiles = [...candidates].filter(file => goldenAll.has(file)).length;
  return {
    returnedFiles: candidates.size,
    hitFiles,
    precision: candidates.size ? hitFiles / candidates.size : 0,
    recall: goldenAll.size ? hitFiles / goldenAll.size : 1,
    pCandAt5: precisionAt(candidateFiles, goldenAll, 5),
    pCandAt10: precisionAt(candidateFiles, goldenAll, 10),
    pRead: readFiles.length ? readFiles.filter(file => goldenAll.has(file)).length / readFiles.length : 1,
    rReadMust: mustHit.size ? readFiles.filter(file => mustHit.has(file)).length / mustHit.size : 1,
    // Task 32 Step 7: the stricter superset gate metric - mustHit alone can
    // read 1.0 while a real shouldBlocksTask file the task also needs is
    // silently missed.
    rTaskBlocking: blocking.size ? readFiles.filter(file => blocking.has(file)).length / blocking.size : 1
  };
}

function precisionAt(files: string[], expected: Set<string>, limit: number): number {
  const selected = files.slice(0, limit);
  return selected.length ? selected.filter(file => expected.has(file)).length / selected.length : 0;
}

function summarize(items: Array<Record<string, unknown>>): Record<string, number> {
  if (items.length === 0) {
    return {};
  }
  const summed: Record<string, number> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (typeof value !== "number") {
        continue;
      }
      summed[key] = (summed[key] || 0) + value;
    }
  }
  for (const key of Object.keys(summed)) {
    summed[key] = summed[key] / items.length;
  }
  for (const key of ["elapsedMs", "rawSearchPayload", "readingPayload", "totalAgentVisiblePayload", "estimatedTokens"]) {
    const values = items.map(item => item[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value)).sort((left, right) => left - right);
    if (values.length > 0) {
      summed[`${key}P50`] = percentile(values, 0.5);
      summed[`${key}P95`] = percentile(values, 0.95);
    }
  }
  return summed;
}

function regexLiteral(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function percentile(sortedValues: number[], percentileValue: number): number {
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1));
  return sortedValues[index];
}

function git(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

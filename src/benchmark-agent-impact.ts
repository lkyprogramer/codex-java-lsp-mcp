// input: External Java navigation golden scenarios.
// output: java_impact payload, latency, precision, recall, read-plan metrics, and run metadata.
// pos: Repeatable benchmark entrypoint for the clean agent router.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { AgentRouter } from "./agent-router/index.js";
import type { ImpactOptions } from "./agent-types.js";
import { readRuntimeBuild } from "./build-info.js";
import { JdtlsSession } from "./jdtls-session.js";
import { SourceIndex } from "./source-index.js";

type WarmState = "cold-nolsp" | "cold-lsp" | "warm-auto" | "warm-required";
type BenchmarkStrategy = "impact" | "no-lsp";

type Scenario = {
  id: string;
  name: string;
  projectId?: string;
  layoutProfile?: string;
  repoCommit?: string;
  scenarioVersion?: number;
  warmState?: WarmState;
  skippedProfiles?: string[];
  anchor: {
    file: string;
    line: number;
    column: number;
    profile: ImpactOptions["profile"];
    focusModules?: string[];
    taskKeywords?: string[];
  };
  golden?: {
    mustHit?: string[];
    shouldHit?: string[];
    side?: string[];
  };
  goldenMeta?: Record<string, {
    shouldBlocksTask?: boolean;
    note?: string;
  }>;
  groundTruth?: string[];
};

type GoldenKind = "must" | "should" | "side";
type GoldenSource = "rg" | "typeGraph" | "seed" | "reference" | "typeHierarchy" | "typeReference" | "no-lsp" | "absent" | "unknown";
type GoldenBlockedBy = "hit" | "readplan-full" | "absent";

type Cli = {
  repoRoot: string;
  scenarioFile: string;
  projectId: string;
  layoutProfile: string;
  warmState: WarmState;
  mode: ImpactOptions["mode"];
  semanticPolicy: ImpactOptions["semanticPolicy"];
  verbosity: NonNullable<ImpactOptions["verbosity"]>;
  runs: number;
  listScenarios: boolean;
  strategy: BenchmarkStrategy;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const cli = parseCli(process.argv.slice(2), projectDir);
const scenarios = loadScenarios(cli.scenarioFile).filter(scenario => !scenario.projectId || scenario.projectId === cli.projectId);
const runtimeBuild = readRuntimeBuild();
const metadata = {
  generatedAt: new Date().toISOString(),
  repoRoot: cli.repoRoot,
  repoCommit: git(cli.repoRoot, ["rev-parse", "--short=12", "HEAD"]) || "unknown",
  projectId: cli.projectId,
  layoutProfile: cli.layoutProfile,
  warmState: cli.warmState,
  mode: cli.mode,
  semanticPolicy: effectiveSemanticPolicy(cli),
  verbosity: cli.verbosity,
  strategy: cli.strategy,
  runs: cli.runs,
  scenarioFile: cli.scenarioFile,
  runtimeBuild
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
      shouldHit: goldenFiles(scenario, "shouldHit").length,
      side: goldenFiles(scenario, "side").length
    }))
  }, null, 2));
  process.exit(0);
}

const session = cli.strategy === "impact" ? new JdtlsSession(cli.repoRoot) : undefined;
const router = session ? new AgentRouter(cli.repoRoot, session, new SourceIndex(cli.repoRoot)) : undefined;
if (session) {
  await prepareWarmState(cli, session, scenarios);
}

const rows = [];
for (const scenario of scenarios) {
  const attempts = [];
  for (let run = 0; run < cli.runs; run += 1) {
    attempts.push(cli.strategy === "no-lsp" ? noLspAttempt(cli.repoRoot, scenario) : await impactAttempt(router as AgentRouter, cli, scenario));
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

function parseCli(args: string[], root: string): Cli {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--list-scenarios") {
      values.set(item, true);
      continue;
    }
    if (item.startsWith("--")) {
      values.set(item, args[index + 1]);
      index += 1;
    }
  }
  const projectId = stringArg(values, "--project-id", process.env.JAVA_LSP_BENCH_PROJECT_ID || "lishuedu");
  return {
    repoRoot: stringArg(values, "--repo-root", process.env.JAVA_LSP_BENCH_REPO_ROOT || process.env.LISHUEDU_ROOT || path.resolve(root, "..", "..")),
    scenarioFile: stringArg(values, "--scenarios", process.env.JAVA_LSP_BENCH_SCENARIOS || path.join(root, "golden", `${projectId}.scenarios.jsonl`)),
    projectId,
    layoutProfile: stringArg(values, "--layout-profile", process.env.JAVA_LSP_BENCH_LAYOUT_PROFILE || (projectId === "exam-parent-v3" ? "maven-reactor" : projectId === "generic-java" ? "generic-java" : "ddd-gradle")),
    warmState: stringArg(values, "--warm-state", process.env.JAVA_LSP_BENCH_WARM_STATE || "cold-nolsp") as WarmState,
    mode: stringArg(values, "--mode", process.env.JAVA_LSP_BENCH_MODE || "balanced") as ImpactOptions["mode"],
    semanticPolicy: stringArg(values, "--semantic-policy", process.env.JAVA_LSP_BENCH_SEMANTIC_POLICY || "auto") as ImpactOptions["semanticPolicy"],
    verbosity: stringArg(values, "--verbosity", process.env.JAVA_LSP_BENCH_VERBOSITY || "standard") as NonNullable<ImpactOptions["verbosity"]>,
    runs: Number(stringArg(values, "--runs", process.env.JAVA_LSP_BENCH_RUNS || "1")),
    listScenarios: values.get("--list-scenarios") === true,
    strategy: stringArg(values, "--strategy", process.env.JAVA_LSP_BENCH_STRATEGY || "impact") as BenchmarkStrategy
  };
}

async function impactAttempt(router: AgentRouter, cli: Cli, scenario: Scenario): Promise<Record<string, unknown>> {
  const startedAt = performance.now();
  const result = await router.impact({
    anchors: [scenario.anchor],
    mode: cli.mode,
    profile: scenario.anchor.profile,
    semanticPolicy: effectiveSemanticPolicy(cli),
    semanticTimeoutMs: 1500,
    testReadMode: "defer",
    focusModules: scenario.anchor.focusModules || [],
    excludeModules: [],
    taskKeywords: scenario.anchor.taskKeywords || [],
    crossModulePolicy: "auto",
    verbosity: cli.verbosity
  });
  const elapsedMs = performance.now() - startedAt;
  const rawSearchPayload = Buffer.byteLength(JSON.stringify(result), "utf8");
  const readingPayload = readPlanBytes(cli.repoRoot, result);
  const candidatePaths = result.files.map(file => String(file.path));
  const readFiles = distinctReadFiles(result);
  const quality = evaluate(candidatePaths, readFiles, scenario);
  return {
    ...attemptPayload("impact", quality, rawSearchPayload, readingPayload, elapsedMs, 1 + result.readPlan.length, result.readPlan.length, Number(result.counts.totalRgRawBytes || 0), 0),
    goldenAttribution: goldenAttributionForImpact(result, scenario)
  };
}

function noLspAttempt(repoRoot: string, scenario: Scenario): Record<string, unknown> {
  const startedAt = performance.now();
  const rg = runNoLspRg(repoRoot, scenario);
  const candidatePaths = unique([scenario.anchor.file, ...rg.files]);
  const readFiles = candidatePaths.slice(0, 6);
  const readingPayload = readMatchedFilesBytes(repoRoot, readFiles, rg.lineByPath, scenario);
  const rawSearchPayload = Buffer.byteLength(rg.stdout, "utf8");
  const quality = evaluate(candidatePaths, readFiles, scenario);
  return {
    ...attemptPayload("no-lsp", quality, rawSearchPayload, readingPayload, performance.now() - startedAt, 1 + readFiles.length, readFiles.length, 0, rawSearchPayload),
    goldenAttribution: goldenAttributionForNoLsp(candidatePaths, readFiles, scenario)
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
    readPlanItems,
    rgRawBytesSuppressed,
    rgRawBytesExposed
  };
}

function stringArg(values: Map<string, string | true>, name: string, fallback: string): string {
  const value = values.get(name);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function loadScenarios(file: string): Scenario[] {
  if (!existsSync(file)) {
    throw new Error(`Scenario file does not exist: ${file}`);
  }
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Scenario;
      } catch (error) {
        throw new Error(`Invalid scenario JSON at ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function effectiveSemanticPolicy(cli: Cli): ImpactOptions["semanticPolicy"] {
  return cli.warmState === "cold-nolsp" ? "fast" : cli.warmState === "warm-required" ? "required" : cli.semanticPolicy;
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

function readPlanBytes(repoRoot: string, result: Awaited<ReturnType<AgentRouter["impact"]>>): number {
  const files = new Map(result.files.map(file => [String(file.id), String(file.path)]));
  let bytes = 0;
  for (const item of result.readPlan) {
    const file = files.get(item.fileId);
    if (!file) {
      continue;
    }
    const absolutePath = path.join(repoRoot, file);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
    bytes += Buffer.byteLength(lines.slice(item.startLine - 1, item.endLine).join("\n"), "utf8");
  }
  return bytes;
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

function distinctReadFiles(result: Awaited<ReturnType<AgentRouter["impact"]>>): string[] {
  const files = new Map(result.files.map(file => [String(file.id), String(file.path)]));
  return [...new Set(result.readPlan.map(item => files.get(item.fileId)).filter((file): file is string => Boolean(file)))];
}

function goldenAttributionForImpact(result: Awaited<ReturnType<AgentRouter["impact"]>>, scenario: Scenario): Array<Record<string, unknown>> {
  const fileByPath = new Map(result.files.map(file => [String(file.path), file]));
  const pathById = new Map(result.files.map(file => [String(file.id), String(file.path)]));
  const readSet = new Set(result.readPlan.map(item => pathById.get(item.fileId)).filter(Boolean));
  const semanticUsed = semanticWasUsed(result.metrics);
  return goldenEntries(scenario).map(({ file, kind }) => {
    const candidate = fileByPath.get(file);
    const inReadPlan = readSet.has(file);
    return goldenAttributionRow(scenario, file, kind, Boolean(candidate), inReadPlan, candidate ? goldenSource(candidate) : "absent", semanticUsed);
  });
}

function goldenAttributionForNoLsp(candidatePaths: string[], readFiles: string[], scenario: Scenario): Array<Record<string, unknown>> {
  const candidates = new Set(candidatePaths);
  const readSet = new Set(readFiles);
  return goldenEntries(scenario).map(({ file, kind }) => {
    const inFiles = candidates.has(file);
    const inReadPlan = readSet.has(file);
    return goldenAttributionRow(scenario, file, kind, inFiles, inReadPlan, inFiles ? "no-lsp" : "absent", false);
  });
}

function goldenAttributionRow(
  scenario: Scenario,
  file: string,
  kind: GoldenKind,
  inFiles: boolean,
  inReadPlan: boolean,
  source: GoldenSource,
  semanticUsed: boolean
): Record<string, unknown> {
  const shouldBlocksTask = kind === "should" ? scenario.goldenMeta?.[file]?.shouldBlocksTask : undefined;
  return compactRecord({
    scenario: scenario.name,
    file,
    kind,
    inFiles,
    inReadPlan,
    source,
    blockedBy: blockedBy(inFiles, inReadPlan),
    profile: scenario.anchor.profile,
    semanticUsed,
    shouldBlocksTask
  });
}

function goldenEntries(scenario: Scenario): Array<{ file: string; kind: GoldenKind }> {
  return [
    ...goldenFiles(scenario, "mustHit").map(file => ({ file, kind: "must" as const })),
    ...goldenFiles(scenario, "shouldHit").map(file => ({ file, kind: "should" as const })),
    ...goldenFiles(scenario, "side").map(file => ({ file, kind: "side" as const }))
  ];
}

function blockedBy(inFiles: boolean, inReadPlan: boolean): GoldenBlockedBy {
  return inReadPlan ? "hit" : inFiles ? "readplan-full" : "absent";
}

function goldenSource(candidate: Record<string, unknown>): GoldenSource {
  const verifiedBy = Array.isArray(candidate.verifiedBy) ? candidate.verifiedBy.map(String) : [];
  const sources = Array.isArray(candidate.scoreBreakdown)
    ? candidate.scoreBreakdown
      .map(item => item && typeof item === "object" ? (item as Record<string, unknown>).source : undefined)
      .map(String)
    : [];
  if (verifiedBy.includes("reference")) {
    return "reference";
  }
  if (verifiedBy.includes("typeHierarchy")) {
    return "typeHierarchy";
  }
  if (verifiedBy.includes("typeReference")) {
    return "typeReference";
  }
  if (verifiedBy.includes("semantic-definition") || verifiedBy.includes("semantic-implementation") || sources.includes("semantic-seed")) {
    return "seed";
  }
  if (verifiedBy.includes("typeGraph")) {
    return "typeGraph";
  }
  if (sources.includes("rg")) {
    return "rg";
  }
  return "unknown";
}

function semanticWasUsed(metrics: Record<string, unknown>): boolean {
  const semantic = metrics.semantic;
  return Boolean(semantic && typeof semantic === "object" && (semantic as Record<string, unknown>).used);
}

function runNoLspRg(repoRoot: string, scenario: Scenario): { stdout: string; files: string[]; lineByPath: Map<string, number> } {
  const pattern = unique(noLspTerms(repoRoot, scenario)).map(regexLiteral).join("|") || regexLiteral(path.basename(scenario.anchor.file, ".java"));
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
  const goldenAll = new Set([...goldenFiles(scenario, "mustHit"), ...goldenFiles(scenario, "shouldHit"), ...goldenFiles(scenario, "side")]);
  const mustHit = new Set(goldenFiles(scenario, "mustHit"));
  const hitFiles = [...candidates].filter(file => goldenAll.has(file)).length;
  return {
    returnedFiles: candidates.size,
    hitFiles,
    precision: candidates.size ? hitFiles / candidates.size : 0,
    recall: goldenAll.size ? hitFiles / goldenAll.size : 1,
    pCandAt5: precisionAt(candidateFiles, goldenAll, 5),
    pCandAt10: precisionAt(candidateFiles, goldenAll, 10),
    pRead: readFiles.length ? readFiles.filter(file => goldenAll.has(file)).length / readFiles.length : 1,
    rReadMust: mustHit.size ? readFiles.filter(file => mustHit.has(file)).length / mustHit.size : 1
  };
}

function goldenFiles(scenario: Scenario, key: "mustHit" | "shouldHit" | "side"): string[] {
  if (scenario.golden) {
    return scenario.golden[key] || [];
  }
  return key === "mustHit" ? scenario.groundTruth || [] : [];
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

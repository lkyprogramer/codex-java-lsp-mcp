#!/usr/bin/env node
// input: Isolated old/new runtimes plus the A2a ruoyi golden jsonl.
// output: F1 ruoyi old-vs-new observation. Tuning only. Holdout unread.
// pos: Option C sentinel. Quality must be bit-identical; token P50 drop >= 20%.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTuningScenes } from "./audit-golden-quality.mjs";
import { toCrossVersionScenarioJsonl } from "./run-three-repo-cold-matrix.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const F1_RUOYI_SCHEMA = "f-f1-ruoyi-observation/v1";
export const F1_QUALITY_METRICS = Object.freeze(["recall", "pRead", "rReadMust", "RangeLineRecall"]);
export const F1_TOKEN_DROP_GATE = 0.2;
export const F1_RUOYI_LAYOUT = "maven-reactor";
export const F1_RUOYI_DEADLINE_MS = 30_000;

export function parseF1RuoyiCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    help: false,
    oldRuntime: options.get("--old-runtime"),
    newRuntime: options.get("--new-runtime"),
    repo: options.get("--repo"),
    jsonl: options.get("--jsonl") || path.join(sourceRoot, "golden", "ruoyi-vue-pro.scenarios.jsonl"),
    output: options.get("--output"),
    runs: Number(options.get("--runs") || 5),
    deadlineMs: Number(options.get("--deadline-ms") || F1_RUOYI_DEADLINE_MS)
  };
}

export function writeTuningScenarioJsonl(sourceText) {
  const { tuning, holdoutSkipped } = loadTuningScenes(sourceText);
  if (tuning.some(row => row?.evaluationSplit === "holdout")) {
    throw new Error("holdout row leaked into the F1 ruoyi tuning jsonl");
  }
  const jsonl = toCrossVersionScenarioJsonl(tuning.map(row => JSON.stringify(row)).join("\n"));
  return { jsonl, tuningCount: tuning.length, holdoutSkipped };
}

export function metricsFromBenchmark(payload) {
  const totals = payload?.totals && typeof payload.totals === "object" ? payload.totals : {};
  const range = totals.RangeLineRecall ?? totals.readPlanRangeRecall;
  return {
    recall: numberOrNull(totals.recall),
    pRead: numberOrNull(totals.pRead),
    rReadMust: numberOrNull(totals.rReadMust),
    RangeLineRecall: numberOrNull(range),
    estimatedTokensP50: numberOrNull(totals.estimatedTokensP50 ?? totals.estimatedTokens),
    scenarios: Array.isArray(payload?.rows) ? payload.rows.length : 0
  };
}

export function qualityIdentity(oldMetrics, newMetrics, metrics = F1_QUALITY_METRICS) {
  const diffs = [];
  const unmeasured = [];
  for (const metric of metrics) {
    const oldValue = oldMetrics?.[metric];
    const newValue = newMetrics?.[metric];
    if (!isFiniteNumber(oldValue) && !isFiniteNumber(newValue)) {
      unmeasured.push(metric);
      continue;
    }
    if (!isFiniteNumber(oldValue)) {
      unmeasured.push(metric);
      continue;
    }
    if (oldValue !== newValue) diffs.push({ metric, old: oldValue, new: newValue ?? null });
  }
  return { identical: diffs.length === 0, diffs, unmeasured };
}

export function tokenDrop(oldP50, newP50, gate = F1_TOKEN_DROP_GATE) {
  if (!isFiniteNumber(oldP50) || oldP50 <= 0 || !isFiniteNumber(newP50)) {
    return { drop: null, pass: false, gate, reason: "token P50 not measurable" };
  }
  const drop = (oldP50 - newP50) / oldP50;
  return { drop, pass: drop + Number.EPSILON >= gate, gate };
}

export function adjudicateRuoyiObservation({ identity, token }) {
  if (!identity?.identical) return "QUALITY_IDENTITY_FAIL";
  if (!token?.pass) return "TOKEN_FAIL";
  return "GO";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrNull(value) {
  return isFiniteNumber(value) ? value : null;
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("benchmark did not emit JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function runBenchmark({ runtimeRoot, repoRoot, scenarioFile, runs, deadlineMs, cacheDir }) {
  const script = path.join(runtimeRoot, "dist", "benchmark-agent-impact.js");
  const args = [
    "--max-old-space-size=8192",
    script,
    "--project-id", "ruoyi-vue-pro",
    "--repo-root", repoRoot,
    "--scenarios", scenarioFile,
    "--layout-profile", F1_RUOYI_LAYOUT,
    "--warm-state", "cold-nolsp",
    "--mode", "balanced",
    "--semantic-policy", "fast",
    "--strategy", "impact",
    "--verbosity", "standard",
    "--deadline-ms", String(deadlineMs),
    "--runs", String(runs),
    "--index-cache-dir", cacheDir
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: runtimeRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`ruoyi observation benchmark exit ${code}`));
        return;
      }
      resolve(extractJson(stdout));
    });
  });
}

async function main() {
  const cli = parseF1RuoyiCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/run-f1-ruoyi-observation.mjs --old-runtime <dir> --new-runtime <dir> --repo <ruoyi-pin> --output <json>");
    return;
  }
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("run-f1-ruoyi-observation must run through isolated validation");
  }
  if (!cli.oldRuntime || !cli.newRuntime || !cli.repo || !cli.output) {
    throw new Error("--old-runtime, --new-runtime, --repo, and --output are required");
  }
  if (!(Number.isInteger(cli.runs) && cli.runs === 5)) {
    throw new Error("F1 ruoyi observation requires --runs 5");
  }
  const sourceText = await readFile(path.resolve(cli.jsonl), "utf8");
  const filtered = writeTuningScenarioJsonl(sourceText);
  const workDir = path.join(path.dirname(path.resolve(cli.output)), "f1-ruoyi-work");
  await mkdir(workDir, { recursive: true });
  const scenarioFile = path.join(workDir, "ruoyi-vue-pro.tuning.jsonl");
  await writeFile(scenarioFile, filtered.jsonl);
  const repoRoot = path.resolve(cli.repo);
  const variants = [
    { name: "old", runtimeRoot: path.resolve(cli.oldRuntime) },
    { name: "new", runtimeRoot: path.resolve(cli.newRuntime) }
  ];
  const payloads = {};
  const metrics = {};
  for (const variant of variants) {
    console.error(`f1-ruoyi: ${variant.name}`);
    payloads[variant.name] = await runBenchmark({
      runtimeRoot: variant.runtimeRoot,
      repoRoot,
      scenarioFile,
      runs: cli.runs,
      deadlineMs: cli.deadlineMs,
      cacheDir: path.join(workDir, `${variant.name}-cache`)
    });
    metrics[variant.name] = metricsFromBenchmark(payloads[variant.name]);
  }
  const identity = qualityIdentity(metrics.old, metrics.new);
  const token = tokenDrop(metrics.old.estimatedTokensP50, metrics.new.estimatedTokensP50);
  const decision = adjudicateRuoyiObservation({ identity, token });
  const result = {
    schemaVersion: F1_RUOYI_SCHEMA,
    dated: new Date().toISOString().slice(0, 10),
    card: "F1",
    repo: "ruoyi-vue-pro",
    evaluationSplit: "tuning",
    holdoutInspected: false,
    holdoutSkipped: filtered.holdoutSkipped,
    tuningCount: filtered.tuningCount,
    runs: cli.runs,
    layoutProfile: F1_RUOYI_LAYOUT,
    deadlineMs: cli.deadlineMs,
    old: metrics.old,
    new: metrics.new,
    identity,
    token,
    decision,
    taskSuccess: "UNMEASURED",
    mergeToMain: false,
    note: decision === "QUALITY_IDENTITY_FAIL"
      ? "Quality is not bit-identical vs main. Default chain moved; stop and bisect."
      : decision === "TOKEN_FAIL"
        ? "Quality identity held; token P50 drop missed the 20% F1 door."
        : "Quality identity vs main; token P50 drop meets the F1 door."
  };
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(path.resolve(cli.output), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    decision: result.decision,
    output: path.resolve(cli.output),
    identity: result.identity.identical,
    tokenDrop: result.token.drop
  }));
  if (decision !== "GO") process.exitCode = 2;
}

const isMain = process.argv[1] && path.normalize(process.argv[1]).endsWith("run-f1-ruoyi-observation.mjs");
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
// input: Four frozen golden Java checkouts plus golden/*.scenarios.jsonl.
// output: Leave-one-repo-out recall/pRead/rReadMust drops. Does not retune or invent TaskSuccess.
// pos: Harvest G2. T3-scale one cold pass per repo via benchmark-agent-impact.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FOURTH_EVAL_REPO,
  FROZEN_GOLDEN_REPOS,
  LORO_DROP_GATE,
  leaveOneRepoOutFolds,
  leaveOneRepoOutScores
} from "./leave-one-repo-out.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const G2_LAYOUT_PROFILE = Object.freeze({
  lishuedu: "ddd-gradle",
  cipherlink: "ddd-gradle",
  "exam-parent-v3": "maven-reactor",
  "ruoyi-vue-pro": "maven-reactor"
});

function parseCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    help: false,
    output: options.get("--output"),
    runs: Number(options.get("--runs") || 1),
    only: options.get("--only"),
    repositories: {
      lishuedu: options.get("--lishuedu"),
      cipherlink: options.get("--cipherlink"),
      "exam-parent-v3": options.get("--exam-parent-v3"),
      "ruoyi-vue-pro": options.get("--ruoyi-vue-pro")
    }
  };
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("benchmark did not emit JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function runBenchmark(project, repoRoot, runs) {
  const script = path.join(sourceRoot, "dist", "benchmark-agent-impact.js");
  const args = [
    script,
    "--project-id", project,
    "--repo-root", repoRoot,
    "--scenarios", path.join(sourceRoot, "golden", `${project}.scenarios.jsonl`),
    "--layout-profile", G2_LAYOUT_PROFILE[project],
    "--warm-state", "cold-nolsp",
    "--mode", "balanced",
    "--semantic-policy", "fast",
    "--strategy", "impact",
    // M6-5 first hydrate on lishuedu is ~9s; the formal T3 2s deadline retires the worker.
    "--deadline-ms", "30000",
    "--runs", String(runs)
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=8192", ...args], {
      cwd: sourceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`${project} benchmark exit ${code}`));
        return;
      }
      resolve(extractJson(stdout));
    });
  });
}

function totalsOf(payload) {
  const totals = payload?.totals ?? {};
  return {
    recall: totals.recall ?? null,
    pRead: totals.pRead ?? null,
    rReadMust: totals.rReadMust ?? null,
    scenarios: Array.isArray(payload?.rows) ? payload.rows.length : null,
    prepareJavaIndexMs: payload?.metadata?.prepareJavaIndexMs ?? null
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/run-g2-loro.mjs --lishuedu <root> --cipherlink <root> --exam-parent-v3 <root> --ruoyi-vue-pro <root> --output <json>");
    return;
  }
  if (!cli.output) throw new Error("--output is required");
  const selected = cli.only
    ? FROZEN_GOLDEN_REPOS.filter(project => project === cli.only)
    : FROZEN_GOLDEN_REPOS;
  if (cli.only && selected.length === 0) throw new Error(`unknown --only ${cli.only}`);
  for (const project of selected) {
    if (!cli.repositories[project]) throw new Error(`--${project} is required`);
  }
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("run-g2-loro must run through isolated validation");
  }
  const metricsByRepo = {};
  const repos = {};
  for (const project of selected) {
    console.error(`g2-loro: ${project}`);
    const payload = await runBenchmark(project, path.resolve(cli.repositories[project]), cli.runs);
    const totals = totalsOf(payload);
    metricsByRepo[project] = {
      recall: totals.recall,
      pRead: totals.pRead,
      rReadMust: totals.rReadMust
    };
    repos[project] = {
      root: path.resolve(cli.repositories[project]),
      ...totals
    };
  }
  const scores = Object.keys(metricsByRepo).length >= 3
    ? leaveOneRepoOutScores(metricsByRepo, LORO_DROP_GATE)
    : { schemaVersion: "g2-loro-scores/v1", decision: "UNMEASURED", failed: false, folds: [], note: "fewer than three repos measured" };
  const result = {
    schemaVersion: "g-g2-loro/v1",
    dated: new Date().toISOString().slice(0, 10),
    retune: false,
    taskSuccess: "UNMEASURED",
    protocolFolds: leaveOneRepoOutFolds(),
    fourthRepo: FOURTH_EVAL_REPO,
    gate: LORO_DROP_GATE,
    runs: cli.runs,
    repos,
    scores,
    decision: scores.decision,
    mergeToMain: false
  };
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    decision: result.decision,
    output: path.resolve(cli.output),
    repos: Object.fromEntries(Object.entries(repos).map(([name, row]) => [name, {
      recall: row.recall,
      pRead: row.pRead,
      rReadMust: row.rReadMust
    }]))
  }));
  if (result.decision === "G2_OVERFIT_FAIL") process.exitCode = 2;
}

const isMain = process.argv[1] && path.normalize(process.argv[1]).endsWith("run-g2-loro.mjs");
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

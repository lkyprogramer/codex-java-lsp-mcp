#!/usr/bin/env node
// input: Three frozen golden Java repos, golden scenes, and N3 commit-task train splits.
// output: Planned EvidenceBundle mustHit coverage and cold latency JSON. Holdout is not read.
// pos: JIN N4-04 T2. Isolated. JAVA_LSP_ENGINE is not required; QUERY_CONTEXT_GRAPH plan=true.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JavaIndexClient } from "../dist/java-index/java-index-client.js";
import { RouterJavaIndex } from "../dist/java-index/router-java-index.js";

const PROJECTS = ["lishuedu", "cipherlink", "exam-parent-v3"];
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    timeoutMs: Number(options.get("--timeout-ms") || 180_000),
    output: required(options.get("--output"), "--output"),
    repositories: {
      lishuedu: required(options.get("--lishuedu"), "--lishuedu"),
      cipherlink: required(options.get("--cipherlink"), "--cipherlink"),
      "exam-parent-v3": required(options.get("--exam-parent-v3"), "--exam-parent-v3")
    }
  };
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function loadScenarios(project) {
  const file = path.join(sourceRoot, "golden", `${project}.scenarios.jsonl`);
  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function loadTrainTasks(project) {
  const file = path.join(sourceRoot, "docs", "phase-jin", `jin-commit-tasks-${project}.json`);
  const payload = JSON.parse(await readFile(file, "utf8"));
  return payload.train ?? [];
}

async function waitForComplete(index, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await index.routerStatus(true);
    const pending = (status.javaIndex?.pendingBackground ?? 0) + (status.javaIndex?.pendingForeground ?? 0);
    if (status.coverage === "complete" && pending === 0) return status;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("JavaIndex did not reach complete coverage before timeout");
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function queryPlan(index, fromRelativePath, taskText, profile, anchorLine) {
  return index.queryContextGraph({
    fromRelativePath,
    intent: "auto",
    taskText,
    profile,
    maxHops: 4,
    maxExpansions: 4096,
    tokenBudget: 2500,
    plan: true,
    includeSource: false,
    anchorLine
  });
}

async function replayProject(project, repoRoot, timeoutMs, cacheRoot) {
  const scenarios = await loadScenarios(project);
  const train = await loadTrainTasks(project);
  const client = new JavaIndexClient(repoRoot, path.join(cacheRoot, project));
  const index = new RouterJavaIndex(repoRoot, client);
  const latencies = [];
  let hits = 0;
  let must = 0;
  let selectedHits = 0;
  let trainHits = 0;
  let trainMust = 0;
  try {
    await index.open(1);
    await index.reconcile(1);
    await waitForComplete(index, timeoutMs);
    for (const scenario of scenarios) {
      const anchor = scenario.anchor?.file;
      const mustHit = [...(scenario.golden?.mustHit ?? [])].filter(file => String(file).endsWith(".java"));
      if (!anchor || mustHit.length === 0) continue;
      const started = performance.now();
      const result = await queryPlan(index, anchor, `${scenario.name ?? ""} ${(scenario.anchor?.taskKeywords ?? []).join(" ")}`, scenario.anchor?.profile, scenario.anchor?.line);
      latencies.push(performance.now() - started);
      const found = new Set(result.bundles.map(bundle => bundle.path));
      const selected = new Set((result.contract?.contexts ?? []).map(item => item.path));
      for (const file of mustHit) {
        must += 1;
        if (found.has(file)) hits += 1;
        if (selected.has(file)) selectedHits += 1;
      }
    }
    for (const task of train) {
      const javaFiles = (task.files ?? []).map(item => item.path).filter(file => String(file).endsWith(".java"));
      if (javaFiles.length < 2) continue;
      const anchor = javaFiles[0];
      const targets = javaFiles.slice(1);
      const result = await queryPlan(index, anchor, task.task ?? "", "auto", task.files?.[0]?.methods?.[0]?.range?.start?.line);
      const selected = new Set((result.contract?.contexts ?? []).map(item => item.path));
      for (const file of targets) {
        trainMust += 1;
        if (selected.has(file)) trainHits += 1;
      }
    }
  } finally {
    await index.close();
  }
  return {
    project,
    scenarios: scenarios.length,
    mustHit: must,
    discoveryHits: hits,
    discoveryRate: must === 0 ? 0 : hits / must,
    selectedHits,
    selectedRate: must === 0 ? 0 : selectedHits / must,
    trainMust,
    trainHits,
    trainSelectedRate: trainMust === 0 ? 0 : trainHits / trainMust,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95)
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/run-jin-planner-replay.mjs --lishuedu <root> --cipherlink <root> --exam-parent-v3 <root> --output <json>");
    return;
  }
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("run-jin-planner-replay must run through isolated validation");
  }
  const cacheRoot = path.join(os.tmpdir(), "jin-n4-planner-cache");
  await mkdir(cacheRoot, { recursive: true });
  const projects = [];
  for (const project of PROJECTS) {
    console.error(`jin-planner-replay: ${project}`);
    projects.push(await replayProject(project, path.resolve(cli.repositories[project]), cli.timeoutMs, cacheRoot));
  }
  const passed = projects.every(item => item.discoveryRate >= 0.95);
  const payload = { schemaVersion: "jin-planner-replay/v1", dated: new Date().toISOString().slice(0, 10), passed, projects };
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    output: path.resolve(cli.output),
    passed,
    projects: projects.map(item => ({
      project: item.project,
      discoveryRate: Number(item.discoveryRate.toFixed(3)),
      selectedRate: Number(item.selectedRate.toFixed(3)),
      trainSelectedRate: Number(item.trainSelectedRate.toFixed(3)),
      p95Ms: Math.round(item.p95Ms)
    }))
  }));
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

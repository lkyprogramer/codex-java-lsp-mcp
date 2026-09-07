#!/usr/bin/env node
// input: Three frozen golden Java repos plus golden/*.scenarios.jsonl.
// output: QUERY_CONTEXT_GRAPH mustHit reachability and cold latency JSON.
// pos: JIN N3-05 T2. Isolated. Benchmark-only; does not register java_context.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SqlJavaIndexClient } from "../dist/java-index/sql/sql-client.js";
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

async function replayProject(project, repoRoot, timeoutMs, cacheRoot) {
  const scenarios = await loadScenarios(project);
  const client = new SqlJavaIndexClient(repoRoot, path.join(cacheRoot, project));
  const index = new RouterJavaIndex(repoRoot, client);
  const latencies = [];
  let hits = 0;
  let must = 0;
  let fallback = 0;
  try {
    await index.open(1);
    await index.reconcile(1);
    await waitForComplete(index, timeoutMs);
    for (const scenario of scenarios) {
      const anchor = scenario.anchor?.file;
      const mustHit = [...(scenario.golden?.mustHit ?? [])].filter(file => String(file).endsWith(".java"));
      if (!anchor || mustHit.length === 0) continue;
      const started = performance.now();
      const result = await index.queryContextGraph({
        fromRelativePath: anchor,
        intent: "auto",
        taskText: `${scenario.name ?? ""} ${(scenario.anchor?.taskKeywords ?? []).join(" ")}`,
        profile: scenario.anchor?.profile,
        maxHops: 4,
        maxExpansions: 4096,
        tokenBudget: 32000
      });
      latencies.push(performance.now() - started);
      const found = new Set(result.bundles.map(bundle => bundle.path));
      for (const file of mustHit) {
        must += 1;
        if (found.has(file)) hits += 1;
      }
      if (result.unresolved.length > 0 && result.bundles.some(bundle => bundle.provingPath.length === 0 && bundle.hops > 0)) fallback += 1;
    }
  } finally {
    await index.close();
  }
  const rate = must === 0 ? 0 : hits / must;
  return {
    project,
    scenarios: scenarios.length,
    mustHit: must,
    hits,
    rate,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    fallbackRate: scenarios.length === 0 ? 0 : fallback / scenarios.length
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/run-jin-candidate-replay.mjs --lishuedu <root> --cipherlink <root> --exam-parent-v3 <root> --output <json>");
    return;
  }
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("run-jin-candidate-replay must run through isolated validation");
  }
  const cacheRoot = path.join(os.tmpdir(), "jin-n3-candidate-cache");
  await mkdir(cacheRoot, { recursive: true });
  const projects = [];
  for (const project of PROJECTS) {
    console.error(`jin-candidate-replay: ${project}`);
    projects.push(await replayProject(project, path.resolve(cli.repositories[project]), cli.timeoutMs, cacheRoot));
  }
  const passed = projects.every(item => item.rate >= 0.95);
  const payload = { schemaVersion: "jin-candidate-replay/v1", dated: new Date().toISOString().slice(0, 10), passed, projects };
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    output: path.resolve(cli.output),
    passed,
    projects: projects.map(item => ({
      project: item.project,
      rate: Number(item.rate.toFixed(3)),
      p95Ms: Math.round(item.p95Ms),
      fallbackRate: Number(item.fallbackRate.toFixed(3))
    }))
  }));
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

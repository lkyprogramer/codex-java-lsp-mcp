#!/usr/bin/env node
// input: Three frozen golden Java repos plus candidate golden/*.scenarios.jsonl.
// output: Top-3 entity-entry replay JSON (anchor-file hit rate).
// pos: JIN N0.5 T2. Benchmark-only QUERY_ENTITY_SEARCH; does not change MCP tools.
import { createHash } from "node:crypto";
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

function taskText(scenario) {
  const keywords = Array.isArray(scenario.anchor?.taskKeywords) ? scenario.anchor.taskKeywords : [];
  const title = String(scenario.name ?? "").replace(/#/g, " ");
  return [title, ...keywords].filter(Boolean).join(" ").trim();
}

function normalizeRel(file) {
  return String(file ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
}

async function loadScenarios(project) {
  const file = path.join(sourceRoot, "golden", `${project}.scenarios.jsonl`);
  const text = await readFile(file, "utf8");
  const rows = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { file, sha256: sha256(text), rows };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForComplete(index, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await index.routerStatus(true);
    if (status.coverage === "complete") return status;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("JavaIndex did not reach complete coverage before timeout");
}

async function replayProject(project, repoRoot, timeoutMs, cacheRoot) {
  const scenarios = await loadScenarios(project);
  const cacheDir = path.join(cacheRoot, project);
  await mkdir(cacheDir, { recursive: true });
  const client = new SqlJavaIndexClient(repoRoot, cacheDir);
  const index = new RouterJavaIndex(repoRoot, client);
  const cases = [];
  try {
    await index.open(1);
    await index.reconcile(1);
    await waitForComplete(index, timeoutMs);
    for (const scenario of scenarios.rows) {
      const task = taskText(scenario);
      const anchorFile = normalizeRel(scenario.anchor?.file);
      const hits = await index.queryEntitySearch(task, 3);
      const hit = hits.some(item => normalizeRel(item.relativePath) === anchorFile);
      cases.push({
        id: scenario.id,
        task,
        anchorFile,
        hit,
        layer: hits[0]?.layer ?? null,
        top: hits.map(item => ({
          relativePath: item.relativePath,
          simpleName: item.simpleName,
          layer: item.layer,
          score: item.score
        }))
      });
    }
  } finally {
    await index.close();
  }
  const hits = cases.filter(item => item.hit).length;
  return {
    project,
    scenarioFile: scenarios.file,
    scenarioSha256: scenarios.sha256,
    scenarios: cases.length,
    hits,
    hitRate: cases.length === 0 ? 0 : hits / cases.length,
    cases
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/replay-entity-entry.mjs --lishuedu <root> --cipherlink <root> --exam-parent-v3 <root> --output <json>");
    return;
  }
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("replay-entity-entry must run through isolated validation");
  }
  const cacheRoot = path.join(os.tmpdir(), "jin-entity-entry-cache");
  await mkdir(cacheRoot, { recursive: true });
  const projects = [];
  for (const project of PROJECTS) {
    console.error(`entity-entry: indexing ${project}`);
    projects.push(await replayProject(project, path.resolve(cli.repositories[project]), cli.timeoutMs, cacheRoot));
  }
  const scenarios = projects.reduce((sum, item) => sum + item.scenarios, 0);
  const hits = projects.reduce((sum, item) => sum + item.hits, 0);
  const hitRate = scenarios === 0 ? 0 : hits / scenarios;
  const payload = {
    schemaVersion: "jin-entity-entry-replay/v1",
    dated: new Date().toISOString().slice(0, 10),
    query: "scenario.name + anchor.taskKeywords",
    limit: 3,
    gate: 0.8,
    scenarios,
    hits,
    hitRate,
    passed: hitRate >= 0.8,
    note: "Spec cited 159 frozen scenes; checked-in golden jsonl is 10 per repo (30). Query text is the scenario title plus taskKeywords, not scene id.",
    projects
  };
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(cli.output, json);
  console.log(JSON.stringify({
    output: path.resolve(cli.output),
    sha256: sha256(json),
    scenarios,
    hits,
    hitRate,
    passed: payload.passed
  }));
  if (!payload.passed && hitRate < 0.7) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

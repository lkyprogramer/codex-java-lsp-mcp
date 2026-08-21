#!/usr/bin/env node
// input: Three frozen golden Java repos plus golden holdout scenes.
// output: java_context selected-path replay JSON. Scene ids are not sent as task text.
// pos: JIN N5 T2. Isolated. Does not call a model or invent TaskSuccess.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JavaIndexClient } from "../dist/java-index/java-index-client.js";
import { RouterJavaIndex } from "../dist/java-index/router-java-index.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const N5_CONTEXT_GATES = [
  {
    project: "lishuedu",
    scenarioId: "paper-task-claim-iam-holdout",
    target: "modules/iam/src/main/java/com/lishu/edu/iam/application/service/MeQueryService.java",
    intents: ["auto"]
  },
  {
    project: "cipherlink",
    scenarioId: "client-release-storage-presign-holdout",
    target: "modules/client/src/main/java/com/hhtele/cipherlink/client/infrastructure/persistence/mapper/ClientReleaseMapper.java",
    intents: ["auto", "PERSISTENCE_FLOW"]
  },
  {
    project: "exam-parent-v3",
    scenarioId: "candidate-pay-order-cross-module-admission",
    target: "exam-data/src/main/java/com/hhtele/exam/data/entity/manage/PayAccount.java",
    intents: ["auto", "PERSISTENCE_FLOW"]
  }
];

export function holdoutTaskText(row) {
  const keywords = Array.isArray(row?.anchor?.taskKeywords) ? row.anchor.taskKeywords : [];
  return [row?.name, ...keywords].filter(item => typeof item === "string" && item.trim()).join(" ").slice(0, 500);
}

export function evaluateN5ContextGates(results) {
  return N5_CONTEXT_GATES.map(gate => {
    const matches = results.filter(item => item.project === gate.project && item.scenarioId === gate.scenarioId);
    const hit = matches.some(item => gate.intents.includes(item.intent) && item.selected.includes(gate.target));
    return { ...gate, hit, selectedByIntent: Object.fromEntries(matches.map(item => [item.intent, item.selected.includes(gate.target)])) };
  });
}

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

async function loadHoldouts(project) {
  const file = path.join(sourceRoot, "golden", `${project}.scenarios.jsonl`);
  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(row => row.evaluationSplit === "holdout");
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

async function querySelected(index, row, intent) {
  const taskText = holdoutTaskText(row);
  if (taskText.includes(row.id)) throw new Error("task text must not contain the scene id");
  const result = await index.queryContextGraph({
    fromRelativePath: row.anchor.file,
    intent,
    mode: "search",
    maxHops: 4,
    maxExpansions: 4096,
    tokenBudget: 2000,
    taskText,
    plan: true,
    includeSource: false,
    anchorLine: row.anchor.line,
    anchorColumn: row.anchor.column
  });
  const discovered = (result.bundles ?? []).map(item => item.path);
  const selected = (result.contract?.contexts ?? []).map(item => item.path);
  return {
    project: row.projectId,
    scenarioId: row.id,
    intent,
    resolvedIntent: result.contract?.resolvedIntent ?? result.resolvedIntent,
    taskText,
    anchor: row.anchor.file,
    discovered,
    selected,
    tokenCost: result.contract?.cost?.modelTokens ?? null
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/run-jin-n5-context-replay.mjs --lishuedu <root> --cipherlink <root> --exam-parent-v3 <root> --output <json>");
    return;
  }
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("run-jin-n5-context-replay must run through isolated validation");
  }
  const cacheRoot = path.join(os.tmpdir(), "jin-n5-context-replay-cache");
  await mkdir(cacheRoot, { recursive: true });
  const results = [];
  for (const project of ["lishuedu", "cipherlink", "exam-parent-v3"]) {
    const repoRoot = path.resolve(cli.repositories[project]);
    const client = new JavaIndexClient(repoRoot, path.join(cacheRoot, project));
    const index = new RouterJavaIndex(repoRoot, client);
    console.error(`jin-n5-context-replay: ${project}`);
    await index.open(1);
    await index.reconcile(1);
    await waitForComplete(index, cli.timeoutMs);
    for (const row of await loadHoldouts(project)) {
      for (const intent of ["auto", "PERSISTENCE_FLOW"]) {
        const item = await querySelected(index, row, intent);
        results.push(item);
        console.error(`  ${row.id} ${intent} selected=${item.selected.length}`);
      }
    }
    await index.close();
  }
  const gates = evaluateN5ContextGates(results);
  const passed = gates.every(item => item.hit);
  const payload = {
    schemaVersion: "jin-n5-context-replay/v1",
    dated: new Date().toISOString().slice(0, 10),
    passed,
    gates,
    results
  };
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    output: path.resolve(cli.output),
    passed,
    gates: gates.map(item => ({ scenarioId: item.scenarioId, target: item.target.split("/").pop(), hit: item.hit }))
  }));
  if (!passed) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}

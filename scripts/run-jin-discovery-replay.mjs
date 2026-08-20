#!/usr/bin/env node
// input: Three frozen golden Java repos plus holdout oracle target files.
// output: Graph-reachability replay JSON (anchor → target ≤ maxHops, no scene-id in src/).
// pos: JIN N2a-03 T2. Isolated. Does not start JDT or change MCP tools.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JavaIndexClient } from "../dist/java-index/java-index-client.js";
import { RouterJavaIndex } from "../dist/java-index/router-java-index.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CASES = [
  {
    project: "lishuedu",
    scenarioId: "paper-task-claim-iam-holdout",
    target: "modules/iam/src/main/java/com/lishu/edu/iam/application/service/MeQueryService.java",
    maxHops: 2
  },
  {
    project: "cipherlink",
    scenarioId: "backend-operation-log-aspect-async-audit-holdout",
    target: "modules/audit/src/main/java/com/hhtele/cipherlink/audit/application/DefaultOperationLogAppService.java",
    maxHops: 3
  },
  {
    project: "cipherlink",
    scenarioId: "client-release-storage-presign-holdout",
    target: "modules/client/src/main/java/com/hhtele/cipherlink/client/infrastructure/persistence/mapper/ClientReleaseMapper.java",
    maxHops: 3
  },
  {
    project: "exam-parent-v3",
    scenarioId: "exam-room-print-download-types-persistent-bundle",
    target: "exam-data/src/main/java/com/hhtele/exam/data/entity/examination/ExamRoomPrintBundleJob.java",
    maxHops: 3
  },
  {
    project: "exam-parent-v3",
    scenarioId: "exam-room-print-download-types-persistent-bundle",
    target: "exam-data/src/main/java/com/hhtele/exam/data/repository/examination/ExamRoomPrintBundleJobTemplate.java",
    maxHops: 3
  },
  {
    project: "exam-parent-v3",
    scenarioId: "candidate-pay-order-cross-module-admission",
    target: "exam-data/src/main/java/com/hhtele/exam/data/repository/order/ApplyPayTemplate.java",
    maxHops: 3
  },
  {
    project: "exam-parent-v3",
    scenarioId: "candidate-pay-order-cross-module-admission",
    target: "exam-data/src/main/java/com/hhtele/exam/data/repository/order/OrderRepository.java",
    maxHops: 3
  },
  {
    project: "exam-parent-v3",
    scenarioId: "candidate-pay-order-cross-module-admission",
    target: "exam-data/src/main/java/com/hhtele/exam/data/entity/manage/PayAccount.java",
    maxHops: 4
  }
];

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

async function loadAnchor(project, scenarioId) {
  const file = path.join(sourceRoot, "golden", `${project}.scenarios.jsonl`);
  const text = await readFile(file, "utf8");
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.id === scenarioId) return row.anchor.file;
  }
  throw new Error(`scenario ${scenarioId} missing from ${file}`);
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

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/run-jin-discovery-replay.mjs --lishuedu <root> --cipherlink <root> --exam-parent-v3 <root> --output <json>");
    return;
  }
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("run-jin-discovery-replay must run through isolated validation");
  }
  const cacheRoot = path.join(os.tmpdir(), "jin-n2a-discovery-cache");
  await mkdir(cacheRoot, { recursive: true });
  const indexes = new Map();
  const results = [];
  for (const item of CASES) {
    if (!indexes.has(item.project)) {
      const repoRoot = path.resolve(cli.repositories[item.project]);
      const client = new JavaIndexClient(repoRoot, path.join(cacheRoot, item.project));
      const index = new RouterJavaIndex(repoRoot, client);
      await index.open(1);
      await index.reconcile(1);
      await waitForComplete(index, cli.timeoutMs);
      indexes.set(item.project, index);
    }
    const index = indexes.get(item.project);
    const anchor = await loadAnchor(item.project, item.scenarioId);
    const reached = await index.queryGraphReachable(anchor, item.maxHops);
    const hop = reached.hops[item.target];
    const hit = Number.isFinite(hop) && hop <= item.maxHops;
    results.push({
      project: item.project,
      scenarioId: item.scenarioId,
      anchor,
      target: item.target,
      maxHops: item.maxHops,
      hop: hop ?? null,
      hit
    });
    console.error(`jin-discovery: ${item.target.split("/").pop()} hop=${hop ?? "miss"} hit=${hit}`);
  }
  for (const index of indexes.values()) await index.close();
  const passed = results.every(item => item.hit);
  const payload = {
    schemaVersion: "jin-n2a-discovery-replay/v1",
    dated: new Date().toISOString().slice(0, 10),
    passed,
    results
  };
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({ output: path.resolve(cli.output), passed, hits: results.filter(item => item.hit).length, total: results.length }));
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

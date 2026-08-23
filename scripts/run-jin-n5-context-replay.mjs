#!/usr/bin/env node
// input: Three frozen golden Java repos plus golden holdout scenes.
// output: java_context selected-path replay JSON. Scene ids are not sent as task text.
// pos: JIN N5 T2. Isolated. Does not call a model or invent TaskSuccess.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JavaIndexClient } from "../dist/java-index/java-index-client.js";
import { RouterJavaIndex } from "../dist/java-index/router-java-index.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const IMPACT_PROFILES = new Set([
  "auto", "controller", "service", "port", "repository", "parser",
  "dto", "entity", "mapper", "vo", "job", "listener"
]);

export function impactProfileOf(profile) {
  return IMPACT_PROFILES.has(profile) ? profile : "auto";
}

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

export function requiredFilesFromHoldout(row) {
  return [...new Set([...(row?.golden?.mustHit ?? []), ...(row?.golden?.taskBlocking ?? [])])].filter(Boolean);
}

export const MISS_DISCOVERY_GAP = "DISCOVERY_GAP";
export const MISS_IN_POOL_NOT_PACKED = "IN_POOL_NOT_PACKED";

export function coverageUnion(result) {
  return [...new Set([
    ...(result?.evidence ?? result?.selected ?? []),
    ...(result?.candidates ?? [])
  ])];
}

export function searchPoolPaths(bundles) {
  const byPath = new Map();
  for (const bundle of bundles ?? []) {
    if (typeof bundle?.path !== "string" || !bundle.path) continue;
    const existing = byPath.get(bundle.path);
    if (!existing || (bundle.hops ?? 99) < (existing.hops ?? 99)) byPath.set(bundle.path, bundle);
  }
  return [...byPath.values()]
    .sort((left, right) => (left.hops ?? 99) - (right.hops ?? 99) || left.path.localeCompare(right.path))
    .map(bundle => bundle.path);
}

export function classifyMissingPath(path, { poolPaths, wireCandidates, evidence } = {}) {
  const pool = poolPaths ?? [];
  const poolRank = pool.indexOf(path);
  const onWire = (wireCandidates ?? []).includes(path);
  const onEvidence = (evidence ?? []).includes(path);
  if (onEvidence || onWire) {
    return {
      path,
      label: "HIT",
      poolRank: poolRank >= 0 ? poolRank + 1 : null,
      poolSize: pool.length,
      onWire,
      onEvidence
    };
  }
  if (poolRank >= 0) {
    return {
      path,
      label: MISS_IN_POOL_NOT_PACKED,
      poolRank: poolRank + 1,
      poolSize: pool.length,
      onWire: false,
      onEvidence: false
    };
  }
  return {
    path,
    label: MISS_DISCOVERY_GAP,
    poolRank: null,
    poolSize: pool.length,
    onWire: false,
    onEvidence: false
  };
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function evaluateC2FirstCallBytes(results, { gate = 1.2 } = {}) {
  const autos = (results ?? []).filter(item => item.intent === "auto"
    && Number.isFinite(item.contextBytes)
    && Number.isFinite(item.impactBytes)
    && item.impactBytes > 0);
  const rows = autos.map(item => ({
    project: item.project,
    scenarioId: item.scenarioId,
    contextBytes: item.contextBytes,
    impactBytes: item.impactBytes,
    ratio: item.contextBytes / item.impactBytes
  }));
  const p50 = percentile(rows.map(row => row.ratio), 50);
  return {
    schemaVersion: "c2-bytes/v2",
    n: rows.length,
    p50,
    gate,
    passed: p50 != null && p50 <= gate && rows.length === 6,
    rows
  };
}

export function evaluateC1HoldoutCoverage(results, { minMean = 0.9 } = {}) {
  const autos = (results ?? []).filter(item => item.intent === "auto");
  const rows = autos.map(item => {
    const required = item.requiredFiles ?? [];
    const union = new Set(coverageUnion(item));
    const hit = required.filter(file => union.has(file));
    const missing = required.filter(file => !union.has(file));
    const poolPaths = item.poolPaths ?? searchPoolPaths(item.searchBundles);
    const missLabels = missing.map(path => classifyMissingPath(path, {
      poolPaths,
      wireCandidates: item.candidates ?? [],
      evidence: item.evidence ?? item.selected ?? []
    }));
    return {
      project: item.project,
      scenarioId: item.scenarioId,
      required: required.length,
      hit: hit.length,
      rate: required.length ? hit.length / required.length : null,
      missing,
      missLabels,
      poolSize: poolPaths.length
    };
  });
  const rates = rows.map(row => row.rate).filter(rate => typeof rate === "number");
  const mean = rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null;
  const missLabels = rows.flatMap(row => row.missLabels ?? []);
  const inPoolNotPacked = missLabels.filter(item => item.label === MISS_IN_POOL_NOT_PACKED);
  const discoveryGap = missLabels.filter(item => item.label === MISS_DISCOVERY_GAP);
  const passed = mean != null && mean >= minMean && rows.length === 6;
  return {
    schemaVersion: "c1-holdout-coverage/v2",
    n: rows.length,
    mean,
    minMean,
    passed,
    inPoolNotPacked: inPoolNotPacked.length,
    discoveryGap: discoveryGap.length,
    floorEligible: !passed && missLabels.length > 0 && inPoolNotPacked.length === 0,
    rows
  };
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
  let last = "";
  while (Date.now() - started < timeoutMs) {
    const status = await index.routerStatus(true);
    const pending = (status.javaIndex?.pendingBackground ?? 0) + (status.javaIndex?.pendingForeground ?? 0);
    const line = `${status.coverage} files=${status.javaIndex?.files ?? 0} pending=${pending} state=${status.javaIndex?.state ?? "?"}`;
    if (line !== last) {
      process.stderr.write(`[replay] wait ${line}\n`);
      last = line;
    }
    if (status.coverage === "complete" && pending === 0) return status;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`JavaIndex did not reach complete coverage before timeout (${last || "no-status"})`);
}

async function querySelected(toolContext, handlers, row, intent) {
  const taskText = holdoutTaskText(row);
  if (taskText.includes(row.id)) throw new Error("task text must not contain the scene id");
  const contract = await handlers.javaContext(toolContext, {
    intent,
    file: row.anchor.file,
    line: row.anchor.line,
    column: row.anchor.column,
    task: taskText,
    mode: "search",
    includeSource: false
  });
  const impact = await handlers.javaImpact(toolContext, {
    file: row.anchor.file,
    line: row.anchor.line,
    column: row.anchor.column,
    mode: "balanced",
    profile: impactProfileOf(row.anchor.profile),
    semanticPolicy: "fast",
    focusModules: row.anchor.focusModules || [],
    taskKeywords: row.anchor.taskKeywords || [],
    verbosity: "compact"
  });
  const contextCompact = handlers.compactContextForModel(contract);
  const evidence = (contract?.evidence ?? contract?.contexts ?? []).map(item => item.path);
  const candidates = (contract?.candidates ?? []).map(item => item.path);
  const graphResult = await toolContext.javaIndex.queryContextGraph({
    fromRelativePath: row.anchor.file,
    intent,
    mode: "search",
    maxHops: 4,
    maxExpansions: 4096,
    tokenBudget: 1400,
    taskText,
    plan: true,
    includeSource: false,
    anchorLine: row.anchor.line,
    anchorColumn: row.anchor.column
  });
  const searchBundles = (graphResult?.bundles ?? []).map(bundle => ({
    path: bundle.path,
    hops: bundle.hops
  }));
  const poolPaths = searchPoolPaths(searchBundles);
  return {
    project: row.projectId,
    scenarioId: row.id,
    intent,
    resolvedIntent: contract?.resolvedIntent,
    taskText,
    anchor: row.anchor.file,
    requiredFiles: requiredFilesFromHoldout(row),
    selected: evidence,
    evidence,
    candidates,
    searchBundles,
    poolPaths,
    contextBytes: Buffer.byteLength(contextCompact.text),
    impactBytes: Buffer.byteLength(JSON.stringify(impact)),
    tokenCost: contract?.cost?.modelTokens ?? null
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
  const [
    { javaContext },
    { javaImpact },
    { AgentRouter },
    { JdtlsSession },
    { compactContextForModel, compactImpactForModel }
  ] = await Promise.all([
    import("../dist/tools/java-context.js"),
    import("../dist/tools/impact.js"),
    import("../dist/agent-router/index.js"),
    import("../dist/jdtls-session.js"),
    import("./run-agent-trace-live.mjs")
  ]);
  const handlers = { javaContext, javaImpact, compactContextForModel, compactImpactForModel };
  const cacheRoot = path.join(os.tmpdir(), "jin-n5-context-replay-cache");
  await mkdir(cacheRoot, { recursive: true });
  const results = [];
  for (const project of ["lishuedu", "cipherlink", "exam-parent-v3"]) {
    const repoRoot = path.resolve(cli.repositories[project]);
    console.error(`jin-n5-context-replay: ${project} root=${repoRoot} exists=${existsSync(repoRoot)}`);
    const client = new JavaIndexClient(repoRoot, path.join(cacheRoot, project));
    const index = new RouterJavaIndex(repoRoot, client);
    const session = new JdtlsSession(repoRoot);
    const router = new AgentRouter(repoRoot, session, index);
    const toolContext = { repoRoot, session, javaIndex: index, javaIndexClient: client, router };
    try {
      await index.open(1);
      await index.reconcile(1);
      await waitForComplete(index, cli.timeoutMs);
      for (const row of await loadHoldouts(project)) {
        for (const intent of ["auto", "PERSISTENCE_FLOW"]) {
          const item = await querySelected(toolContext, handlers, row, intent);
          results.push(item);
          console.error(`  ${row.id} ${intent} selected=${item.selected.length} ctx=${item.contextBytes} impact=${item.impactBytes}`);
        }
      }
    } finally {
      await index.close();
      await session.stop?.().catch(() => undefined);
    }
  }
  const gates = evaluateN5ContextGates(results);
  const c1 = evaluateC1HoldoutCoverage(results);
  const c2 = evaluateC2FirstCallBytes(results);
  const passed = c1.passed && c2.passed;
  const payload = {
    schemaVersion: "jin-n5-context-replay/v3",
    dated: new Date().toISOString().slice(0, 10),
    passed,
    gates,
    c1Coverage: c1,
    c2Bytes: c2,
    results
  };
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify({
    output: path.resolve(cli.output),
    passed,
    c1Mean: c1.mean,
    c1FloorEligible: c1.floorEligible,
    inPoolNotPacked: c1.inPoolNotPacked,
    discoveryGap: c1.discoveryGap,
    c2P50: c2.p50,
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

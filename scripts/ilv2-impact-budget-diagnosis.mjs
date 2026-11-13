#!/usr/bin/env node
// D15 step F, model-free. Replays the retrieval runner's product driver (product-mcp/v1) on a frozen MAC-10 dev
// split: per planned term, java_symbol at limit 8 (a window at every candidate), then java_impact at the first
// candidate, read span by span. The impact call is repeated under the pre-registered read-plan configurations of
// D15 §9 (public knobs only: mode and readPlanMaxItems). Every call is issued twice, compact (the driver's wire,
// whose spans are read) and diagnostic (the full candidate pool, read plan and evidence gaps); a configuration whose
// two projections select different spans is refused. Scoring reuses the runner's own reader and scoreSlot, so the
// baseline configuration must reproduce W2's product recall on the calibration tasks before any other number counts.
// Private rows (paths, terms, responses) stay under --out; summary.json carries counts only.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { materializeCorpus, nearestRank, planQueries, readSpan, readWindow, scoreSlot } from "./ilv2-mac-retrieval-eval.mjs";
import { openProductSession } from "./ilv2-ranking-diagnosis.mjs";

export const IMPACT_DIAGNOSIS_SCHEMA = "post-ilv2/impact-budget-diagnosis/v1";
export const SYMBOL_LIMIT = 8; // the W2 product driver's java_symbol limit
export const IMPACT_DEADLINE_MS = 15000; // the driver's cap per impact call
// D15 §9.2. C0 is the driver as W2 ran it; the others change one public knob each.
export const IMPACT_CONFIGS = Object.freeze({
  C0: Object.freeze({ mode: "balanced" }),
  C1: Object.freeze({ mode: "balanced", readPlanMaxItems: 12 }),
  C2: Object.freeze({ mode: "balanced", readPlanMaxItems: 20 }),
  C3: Object.freeze({ mode: "recall" })
});
// src/agent-router/read-plan.ts: the protected core is capped at 4 files whatever the file budget.
export const CORE_EXCEEDED_GAP = "Protected core exceeded read-plan limits";
// read-plan.ts PROTECTED_CORE_KINDS: a file carrying one of these reasons can take a protected-core slot.
export const PROTECTED_CORE_KINDS = Object.freeze(new Set(["DEFINITION", "IMPLEMENTATION", "TYPEHIERARCHY", "IMPLEMENTS", "TYPE_RELATION", "TYPE_SYMMETRIC", "METHOD_RELATION",
  "IMPLEMENTATION_METHOD_TYPE", "CALLS", "definition", "implementation", "typeHierarchy", "typeGraph:implementation-lookup", "SPRING_INJECTION", "SPRING_CALL_PATH",
  "MYBATIS_NAMESPACE", "MYBATIS_STATEMENT_METHOD"]));
export const TARGET_LABELS = Object.freeze(["SYMBOL_WINDOW", "IMPACT_SPAN", "SELECTED_RANGE_MISS", "UNSELECTED", "POOL_ABSENT", "NO_IMPACT_CALL"]);

const spanKey = (file, startLine, endLine) => `${file}:${startLine}-${endLine}`;
/** The spans one compact response asks the driver to read, as a sorted key list. */
export function compactSpanKeys(compact) {
  return (compact?.contexts ?? []).flatMap(context => (context.spans ?? []).map(span => spanKey(context.path, span.s, span.e))).sort();
}
/** The same selection seen through the diagnostic projection: read-plan ranges mapped from fileId to path. */
export function diagnosticSpanKeys(diagnostic) {
  const byId = new Map((diagnostic?.files ?? []).map(file => [file.id, file.path]));
  return (diagnostic?.readPlan ?? []).flatMap(item => (item.ranges ?? []).map(range => spanKey(byId.get(item.fileId) ?? "?", range.startLine, range.endLine))).sort();
}

/** Keep only what scoring and attribution need from a diagnostic response. */
export function trimDiagnostic(diagnostic) {
  return {
    files: (diagnostic.files ?? []).map(file => ({ id: file.id, path: file.path, role: file.role, reasons: file.reasons ?? [] })),
    readPlan: (diagnostic.readPlan ?? []).map(item => ({ fileId: item.fileId, ranges: (item.ranges ?? []).map(range => ({ startLine: range.startLine, endLine: range.endLine })) })),
    evidenceGaps: diagnostic.evidenceGaps ?? [],
    freshness: { coverage: diagnostic.freshness?.coverage ?? null },
    semantic: { completion: diagnostic.semantic?.completion ?? null },
    status: diagnostic.status ?? null
  };
}

/** One task through the driver's calls, every configuration. `call` returns { value, bytes } like the runner's. */
export async function observeTask({ task, call, configs = IMPACT_CONFIGS }) {
  const plan = planQueries(task);
  const terms = [];
  for (const term of plan.terms) {
    const symbol = await call("java_symbol", { operation: "query", query: term, limit: SYMBOL_LIMIT, preview: "none" });
    const first = symbol.value.candidates?.[0];
    const row = { term, symbol: symbol.value, symbolBytes: symbol.bytes, exact: symbol.value.exact ?? null, impacts: {} };
    if (first) {
      const { relativePath, selection } = first.declaration;
      const base = { file: relativePath, line: selection.line, column: selection.column, semanticPolicy: "fast", deadlineMs: IMPACT_DEADLINE_MS };
      for (const [name, config] of Object.entries(configs)) {
        const compact = await call("java_impact", { ...base, ...config, verbosity: "compact" });
        const diagnostic = await call("java_impact", { ...base, ...config, verbosity: "diagnostic" });
        row.impacts[name] = { compact: compact.value, compactBytes: compact.bytes, diagnostic: trimDiagnostic(diagnostic.value) };
      }
    }
    terms.push(row);
  }
  return { taskId: task.taskId, plan, terms };
}

/** The driver's receipts for one configuration, in its order: symbol windows, then impact spans, term by term. */
export async function receiptsFor(observation, configName, corpusRoot) {
  const receipts = [];
  let payloadBytes = 0;
  const push = (term, source, receipt) => receipts.push({ ordinal: receipts.length + 1, term, atMs: 0, source, ...receipt });
  for (const row of observation.terms) {
    payloadBytes += row.symbolBytes;
    for (const candidate of row.symbol.candidates ?? []) {
      const located = candidate.evidenceRange ?? { relativePath: candidate.declaration.relativePath, startLine: candidate.declaration.selection.line };
      push(row.term, "symbol", await readWindow(corpusRoot, located.relativePath, located.startLine));
    }
    const impact = row.impacts[configName];
    if (!impact) continue;
    payloadBytes += impact.compactBytes;
    for (const context of impact.compact.contexts ?? []) {
      for (const span of context.spans ?? []) push(row.term, "impact", await readSpan(corpusRoot, context.path, span.s, span.e));
    }
  }
  return { receipts, payloadBytes };
}

const overlaps = (item, startLine, endLine) => !(endLine < item.startLine || startLine > item.endLine);
/** Why one required range was or was not received under one configuration. */
export function labelTarget({ item, credited, receipts, observation, configName }) {
  if (credited) {
    const hit = receipts.find(receipt => receipt.path === item.path && receipt.startLine <= item.startLine && receipt.endLine >= item.endLine);
    return { label: hit?.source === "symbol" ? "SYMBOL_WINDOW" : "IMPACT_SPAN" };
  }
  const calls = observation.terms.map(row => row.impacts[configName]).filter(Boolean);
  if (calls.length === 0) return { label: "NO_IMPACT_CALL" };
  for (const call of calls) {
    const file = call.diagnostic.files.find(entry => entry.path === item.path);
    const ranges = call.diagnostic.readPlan.filter(entry => entry.fileId === file?.id).flatMap(entry => entry.ranges);
    if (file && ranges.length > 0) return { label: "SELECTED_RANGE_MISS", overlapping: ranges.some(range => overlaps(item, range.startLine, range.endLine)) };
  }
  for (const call of calls) {
    const file = call.diagnostic.files.find(entry => entry.path === item.path);
    // coreCapped needs both: the call evicted core files, and this file itself carries a protected-core reason.
    if (file) {
      const coreExceeded = call.diagnostic.evidenceGaps.some(gap => gap.startsWith(CORE_EXCEEDED_GAP));
      const protectedReason = (file.reasons ?? []).some(reason => PROTECTED_CORE_KINDS.has(reason));
      return { label: "UNSELECTED", role: file.role ?? null, coreExceeded, protectedReason, coreCapped: coreExceeded && protectedReason };
    }
  }
  return { label: "POOL_ABSENT" };
}

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const spread = values => ({ n: values.length, p50: nearestRank(values, 0.5), p95: nearestRank(values, 0.95), mean: mean(values) });

/** Counts only. `scored`: per task { taskId, category, configs: { name: { score, payloadBytes, targets: [{ kind, credited, label... }], partialCalls } } }. */
export function summarizeConfigs(scored, configNames = Object.keys(IMPACT_CONFIGS)) {
  const out = {};
  for (const name of configNames) {
    const rows = scored.map(task => ({ task, own: task.configs[name] }));
    const targets = rows.flatMap(({ task, own }) => own.targets.map((target, index) => ({ task, target, index })));
    const credited = targets.filter(item => item.target.credited);
    const base = scored.flatMap(task => task.configs[configNames[0]].targets);
    const labels = Object.fromEntries(TARGET_LABELS.map(label => [label, targets.filter(item => item.target.label === label).length]));
    const unselected = targets.filter(item => item.target.label === "UNSELECTED");
    const complete = rows.filter(({ own }) => own.partialCalls === 0);
    out[name] = {
      config: IMPACT_CONFIGS[name] ?? null,
      tasks: rows.length,
      targets: targets.length,
      meanRecall: mean(rows.map(({ own }) => own.score.recall ?? 0)),
      fullRecallTasks: rows.filter(({ own }) => own.score.required > 0 && own.score.credited === own.score.required).length,
      creditedTargets: credited.length,
      creditedByKind: { java: credited.filter(item => item.target.kind === "java").length, other: credited.filter(item => item.target.kind === "other").length },
      creditedByCategory: Object.fromEntries([...new Set(scored.map(task => task.category))].sort().map(category => [category, {
        targets: targets.filter(item => item.task.category === category).length,
        credited: credited.filter(item => item.task.category === category).length
      }])),
      gainedVsC0: targets.filter((item, index) => item.target.credited && !base[index].credited).length,
      lostVsC0: targets.filter((item, index) => !item.target.credited && base[index].credited).length,
      labels,
      unselectedByRole: unselected.reduce((acc, item) => ({ ...acc, [item.target.role ?? "?"]: (acc[item.target.role ?? "?"] ?? 0) + 1 }), {}),
      unselectedWithCoreExceeded: unselected.filter(item => item.target.coreExceeded).length,
      unselectedCoreCapped: unselected.filter(item => item.target.coreCapped).length,
      unselectedCoreCappedJava: unselected.filter(item => item.target.coreCapped && item.target.kind === "java").length,
      uncreditedJava: targets.filter(item => !item.target.credited && item.target.kind === "java").length,
      selectedRangeMissOverlapping: targets.filter(item => item.target.label === "SELECTED_RANGE_MISS" && item.target.overlapping).length,
      // W2's cost: received source bytes per task, duplicates included; tool payload bytes separately.
      receivedBytesPerTask: spread(rows.map(({ own }) => own.score.bytes)),
      payloadBytesPerTask: spread(rows.map(({ own }) => own.payloadBytes)),
      impactCallBytes: spread(rows.flatMap(({ own }) => own.callBytes)),
      calls: rows.reduce((sum, { own }) => sum + own.callBytes.length, 0),
      callsByAnchorExact: rows.flatMap(({ own }) => own.callExact).reduce((acc, outcome) => ({ ...acc, [outcome]: (acc[outcome] ?? 0) + 1 }), {}),
      partialCalls: rows.reduce((sum, { own }) => sum + own.partialCalls, 0),
      coreExceededCalls: rows.reduce((sum, { own }) => sum + own.coreExceededCalls, 0),
      sensitivityCompleteCallsOnly: { tasks: complete.length, meanRecall: mean(complete.map(({ own }) => own.score.recall ?? 0)) }
    };
  }
  return out;
}

export async function scoreObservation({ observation, required, corpusRoot, configNames = Object.keys(IMPACT_CONFIGS) }) {
  const configs = {};
  for (const name of configNames) {
    const { receipts, payloadBytes } = await receiptsFor(observation, name, corpusRoot);
    const score = scoreSlot({ required, receipts, status: "COMPLETE" });
    const calls = observation.terms.map(row => row.impacts[name]).filter(Boolean);
    const targets = required.map(item => {
      const credited = scoreSlot({ required: [item], receipts, status: "COMPLETE" }).credited === 1;
      return { kind: item.path.endsWith(".java") ? "java" : "other", credited, ...labelTarget({ item, credited, receipts, observation, configName: name }) };
    });
    configs[name] = {
      score, payloadBytes, targets,
      callBytes: calls.map(call => call.compactBytes),
      callExact: observation.terms.filter(row => row.impacts[name]).map(row => row.exact ?? "text"),
      // From the compact wire the driver reads: freshness.coverage and semantic.completion.
      partialCalls: calls.filter(call => call.compact.freshness?.coverage !== "COMPLETE" || (call.compact.semantic?.completion ?? "COMPLETE") !== "COMPLETE").length,
      coreExceededCalls: calls.filter(call => call.diagnostic.evidenceGaps.some(gap => gap.startsWith(CORE_EXCEEDED_GAP))).length
    };
  }
  return configs;
}

/** Every call's two projections must select the same spans; returns the differing calls. */
export function projectionMismatches(observations) {
  let mismatches = 0;
  for (const observation of observations) for (const row of observation.terms) for (const impact of Object.values(row.impacts)) {
    if (JSON.stringify(compactSpanKeys(impact.compact)) !== JSON.stringify(diagnosticSpanKeys(impact.diagnostic))) mismatches += 1;
  }
  return mismatches;
}

const sameNumber = (a, b) => Math.abs(a - b) < 1e-9;

export async function runImpactDiagnosis({ datasetFile, tasksFile, goldFile, inputsFile, serverJs, out, calibration, readyTimeoutMs = 900000, openSession = openProductSession, materialize = materializeCorpus }) {
  const { root, manifest } = await verifyDataset(datasetFile);
  const tasksBytes = await readFile(tasksFile);
  requireValue(manifest.parts["tasks-dev"]?.sha256 === sha256(tasksBytes), "tasks file is not this dataset's dev split; step F never runs on holdout");
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts["gold-dev"]?.sha256 === sha256(goldBytes), "gold file is not this dataset's dev gold");
  const tasks = tasksBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const known = new Set(tasks.map(task => task.taskId));
  requireValue(calibration && calibration.taskIds.length > 0 && calibration.taskIds.every(id => known.has(id)), "calibration task ids must be dev tasks");
  await mkdir(out);
  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  // Phase 1: product calls from the agent-visible task only.
  const observations = new Map();
  const roots = new Map();
  const sessions = {};
  const responsesFile = path.join(out, "responses.jsonl");
  await writeFile(responsesFile, "");
  for (const corpusId of [...new Set(tasks.map(task => task.corpusId))]) {
    const record = inputs.get(corpusId);
    const corpus = corpusManifest.corpora.find(row => row.corpusId === corpusId);
    requireValue(record && corpus && record.head === corpus.head && record.manifestSha256 === corpus.inputManifestSha256, `corpus ${corpusId} does not match its frozen input`);
    const corpusRoot = await materialize({ record, corpus, oraclesRoot: path.join(root, "private/oracles"), target: path.join(out, "corpora", corpusId) });
    roots.set(corpusId, corpusRoot);
    const workDir = path.join(out, "sessions", corpusId);
    await mkdir(workDir, { recursive: true });
    const session = await openSession({ serverJs, corpusRoot, workDir, readyTimeoutMs });
    sessions[corpusId] = { readyMs: Math.round(session.readyMs) };
    const call = session.callRaw ?? (async (name, args) => {
      const value = await session.call(name, args);
      return { value, bytes: Buffer.byteLength(JSON.stringify(value)) };
    });
    try {
      // Appended per task, so a failed call still leaves every earlier observation on disk.
      for (const task of tasks.filter(item => item.corpusId === corpusId)) {
        const observation = await observeTask({ task, call });
        observations.set(task.taskId, observation);
        await appendFile(responsesFile, `${JSON.stringify(observation)}\n`);
      }
    } finally { await session.close(); }
  }
  const mismatches = projectionMismatches([...observations.values()]);
  requireValue(mismatches === 0, `${mismatches} impact calls select different spans in compact and diagnostic projections; refusing to score`);
  // Phase 2: gold.
  const gold = new Map(goldBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).map(row => [row.taskId, row]));
  const scored = [];
  for (const task of tasks) {
    const configs = await scoreObservation({ observation: observations.get(task.taskId), required: gold.get(task.taskId)?.requiredEvidence ?? [], corpusRoot: roots.get(task.corpusId) });
    scored.push({ taskId: task.taskId, category: task.category, planTerms: observations.get(task.taskId).plan.terms.length, configs });
  }
  await writeFile(path.join(out, "rows.jsonl"), scored.map(row => JSON.stringify(row)).join("\n") + "\n");
  const cohort = scored.filter(row => calibration.taskIds.includes(row.taskId));
  const baseline = summarizeConfigs(cohort).C0;
  const calibrated = sameNumber(baseline.meanRecall, calibration.meanRecall) && baseline.fullRecallTasks === calibration.fullRecallTasks;
  const summary = {
    schema: IMPACT_DIAGNOSIS_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, split: "dev", tasksSha256: sha256(tasksBytes), goldSha256: sha256(goldBytes),
      serverBuildStampSha256: sha256(await readFile(path.join(path.dirname(serverJs), "build-stamp.json"))), symbolLimit: SYMBOL_LIMIT, configs: IMPACT_CONFIGS },
    sessions,
    projectionMismatches: 0,
    calibration: { tasks: cohort.length, expected: { meanRecall: calibration.meanRecall, fullRecallTasks: calibration.fullRecallTasks },
      observed: { meanRecall: baseline.meanRecall, fullRecallTasks: baseline.fullRecallTasks }, status: calibrated ? "PASS" : "FAIL" },
    ...(calibrated ? { dev: summarizeConfigs(scored), calibrationCohort: summarizeConfigs(cohort) } : {}),
    notClaimed: "Driver replay without slot deadlines: retrieval recall and received bytes only. No agent, answer or task success is measured. Public knobs only; the protected-core cap is observed through evidence gaps, not varied."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  requireValue(calibrated, `baseline C0 does not reproduce W2 on the calibration tasks (mean recall ${baseline.meanRecall}, full ${baseline.fullRecallTasks}); only the calibration block was written`);
  return summary;
}

async function main(args) {
  const options = cliOptions(args, ["--dataset", "--tasks", "--gold", "--inputs", "--server-js", "--out", "--calibration-task-ids", "--expect-mean-recall", "--expect-full-recall"]);
  for (const name of ["dataset", "tasks", "gold", "inputs", "server-js", "out", "calibration-task-ids", "expect-mean-recall", "expect-full-recall"]) requireValue(options[name], `--${name} is required`);
  const summary = await runImpactDiagnosis({ datasetFile: path.resolve(options.dataset), tasksFile: path.resolve(options.tasks), goldFile: path.resolve(options.gold),
    inputsFile: path.resolve(options.inputs), serverJs: path.resolve(options["server-js"]), out: path.resolve(options.out),
    calibration: { taskIds: options["calibration-task-ids"].split(",").filter(Boolean), meanRecall: Number(options["expect-mean-recall"]), fullRecallTasks: Number(options["expect-full-recall"]) } });
  console.log(JSON.stringify(summary, null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));

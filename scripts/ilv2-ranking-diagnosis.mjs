#!/usr/bin/env node
// D15 ranking diagnosis, model-free. For each task of a frozen MAC-10 split it issues the retrieval runner's own
// agent-visible query plan (planQueries) against the product's java_symbol static query at the maximum limit, then
// locates every required evidence range in the returned candidate list. It separates the candidate mechanisms that
// can put a direct declaration at rank 8-11 (an ambiguous exact lookup ordered by declaration identity, i.e. by
// path; the text route's per-route rank interleave; test sources ahead of main). Two real product probes run per
// term: searchMode=text when the default took the exact route, and query+terms (the plan's other terms; auto mode
// with terms is the text route, src/discovery/query.ts validateArgs). Two deterministic re-orderings of the SAME
// returned list (main before test, co-anchor file match) bound what a pure re-ranking could gain. Gold is read only
// after every query has returned.
// Private rows (paths, terms) stay under --out; summary.json carries counts only.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, readJson, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { TEST_SOURCE, verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { materializeCorpus, planQueries } from "./ilv2-mac-retrieval-eval.mjs";

export const DIAGNOSIS_SCHEMA = "post-ilv2/ranking-diagnosis/v1";
export const DIAGNOSIS_LIMIT = 20;
// The retrieval runner's read: a window from line-20, at most 80 lines, ending by line+60 (ilv2-mac-retrieval-eval WINDOW_DEFAULT).
export const DRIVER_WINDOW = Object.freeze({ before: 20, after: 60, maxLines: 80 });
export const CUTOFFS = Object.freeze([1, 3, 8, 20]);
export const MECHANISMS = Object.freeze(["TOP1", "EXACT_AMBIGUOUS", "EXACT_OTHER", "TEXT_MERGE", "FILE_ONLY", "NOT_RETURNED"]);
export const MAX_CONTEXT_TERMS = 5; // planQueries yields at most 6 terms: the query plus at most 5 others, within DISCOVERY_MAX_TERMS (6).

// src/discovery/query-intent.ts classifyQuery (auto mode), mirrored to check that the wire reports the route it took.
const CODE_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:[.$][A-Za-z_$][A-Za-z0-9_$]*)*(?:#[A-Za-z_$][A-Za-z0-9_$]*(?:\([^()]*\))?)?$/;
export function predictedIntent(raw) {
  const q = raw.trim();
  if (/\s/.test(q) || /[\u3400-\u9fff]/.test(q) || !CODE_SHAPE.test(q)) return "text";
  return /[.#()]/.test(q) || /[A-Z]/.test(q) ? "exact" : "text";
}

/** True when the runner's window at this candidate's declaration would receive the whole target range. */
export function windowCovers(candidate, target, window = DRIVER_WINDOW) {
  const declaration = candidate.declaration;
  if (declaration?.relativePath !== target.path || !Number.isInteger(declaration.selection?.line)) return false;
  const line = declaration.selection.line;
  const start = Math.max(1, line - window.before);
  const end = Math.min(start + window.maxLines - 1, line + window.after);
  return target.startLine >= start && target.endLine <= end;
}

/**
 * A declaration target (sealed-set gold, role "declaration") is found only by the candidate that IS that declaration:
 * same file and the candidate's selection (the 1-based name line) inside the declaration head. A window rule would
 * credit the enclosing type's candidate for every short member, which is not the ranking of the member.
 */
export function matchesTarget(candidate, target) {
  if (target.role !== "declaration") return windowCovers(candidate, target);
  const declaration = candidate.declaration;
  const line = declaration?.selection?.line;
  return declaration?.relativePath === target.path && Number.isInteger(line) && line >= target.startLine && line <= target.endLine;
}

/** 1-based rank of the first candidate that finds the target, or null. */
export function rankOf(candidates, target) {
  const index = candidates.findIndex(candidate => matchesTarget(candidate, target));
  return index < 0 ? null : index + 1;
}

const isTest = candidate => TEST_SOURCE.test(candidate.declaration?.relativePath ?? "");
/** Declaration identity order for one kind: entityId is `[method:]type:v2:<encoded path>#<encoded fqn>...`, compared with localeCompare. */
export function identityKey(candidate) {
  const { relativePath = "", fqn = "" } = candidate.declaration ?? {};
  return `${encodeURIComponent(relativePath)}#${encodeURIComponent(fqn.split("#")[0])}`;
}
export function inIdentityOrder(candidates) {
  for (let i = 1; i < candidates.length; i += 1) {
    if (identityKey(candidates[i - 1]).localeCompare(identityKey(candidates[i])) > 0) return false;
  }
  return true;
}

/** Stable re-orderings of one returned list; none adds or drops a candidate. */
export function mainFirst(candidates) {
  return [...candidates.filter(candidate => !isTest(candidate)), ...candidates.filter(isTest)];
}
export function coAnchorOrder(candidates, coTerms, fileText) {
  const words = coTerms.filter(term => /^[A-Za-z_$][\w$]*$/.test(term));
  if (words.length === 0) return [...candidates];
  const score = new Map(candidates.map(candidate => {
    const text = fileText(candidate.declaration?.relativePath) ?? "";
    return [candidate, words.filter(word => new RegExp(`(?<![\\w$])${word.replace(/\$/g, "\\$")}(?![\\w$])`).test(text)).length];
  }));
  return candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) => score.get(b.candidate) - score.get(a.candidate) || a.index - b.index).map(row => row.candidate);
}

/**
 * One target against the plan's responses. The term with the best rank decides; without any covering candidate the
 * first term that returned the target's file explains it (FILE_ONLY), else NOT_RETURNED.
 */
export function classifyTarget({ target, plan, responses, fileText }) {
  let best = null;
  for (const [index, term] of plan.terms.entries()) {
    const response = responses.get(term);
    const candidates = response?.auto?.candidates ?? [];
    const rank = rankOf(candidates, target);
    if (rank !== null && (best === null || rank < best.rank)) best = { term, index, rank, response, candidates };
  }
  const kind = target.path.endsWith(".java") ? "java" : "other";
  // D15 §7: sealed-set gold labels each range; only role "declaration" counts for the primary product metric.
  const role = target.role ?? null;
  const probes = { textRoute: probeRank(plan, responses, target, "text"), withTerms: probeRank(plan, responses, target, "withTerms") };
  if (best === null) {
    const fileHit = plan.terms.some(term => (responses.get(term)?.auto?.candidates ?? []).some(candidate => candidate.declaration?.relativePath === target.path));
    const exactOutcomes = plan.terms.map(term => responses.get(term)?.auto?.exact).filter(outcome => outcome !== undefined);
    return { kind, role, rank: null, mechanism: fileHit ? "FILE_ONLY" : "NOT_RETURNED", intent: exactOutcomes.length ? "exact" : "text", exactOutcomes,
      counterfactual: { mainFirst: null, coAnchor: null, mainFirstCoAnchor: null, ...probes } };
  }
  const { response, candidates, rank } = best;
  const intent = response.auto.exact !== undefined ? "exact" : "text";
  const ahead = candidates.slice(0, rank - 1);
  const hit = candidates[rank - 1];
  const coTerms = plan.terms.filter(term => term !== best.term);
  const mechanism = rank === 1 ? "TOP1" : intent === "exact" ? (response.auto.exact === "ambiguous" ? "EXACT_AMBIGUOUS" : "EXACT_OTHER") : "TEXT_MERGE";
  return {
    kind, role, rank, mechanism, intent, exact: response.auto.exact ?? null, termIndex: best.index,
    selectionLimited: response.auto.selectionLimited === true,
    returned: candidates.length,
    ahead: {
      sameName: ahead.filter(candidate => candidate.declaration?.name === hit.declaration?.name).length,
      test: ahead.filter(isTest).length,
      sameFile: ahead.filter(candidate => candidate.declaration?.relativePath === target.path).length
    },
    targetIsTest: isTest(hit),
    identityOrdered: intent === "exact" ? inIdentityOrder(candidates) : null,
    matchedBy: hit.matchedBy ?? [],
    counterfactual: {
      mainFirst: rankOf(mainFirst(candidates), target),
      coAnchor: rankOf(coAnchorOrder(candidates, coTerms, fileText), target),
      mainFirstCoAnchor: rankOf(coAnchorOrder(mainFirst(candidates), coTerms, fileText), target),
      ...probes
    }
  };
}
function probeRank(plan, responses, target, probe) {
  let best = null;
  for (const term of plan.terms) {
    const candidates = responses.get(term)?.[probe]?.candidates;
    if (!candidates) continue;
    const rank = rankOf(candidates, target);
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}

const minRank = (a, b) => a === null ? b : b === null ? a : Math.min(a, b);
const hitAt = (ranks, cutoff) => ranks.filter(rank => rank !== null && rank <= cutoff).length;
/** Counts only: no task id, path or term leaves this function. */
export function summarize(rows) {
  const targets = rows.flatMap(row => row.targets);
  const byMechanism = Object.fromEntries(MECHANISMS.map(name => [name, targets.filter(item => item.mechanism === name).length]));
  const series = {
    observed: targets.map(item => item.rank),
    mainFirst: targets.map(item => item.counterfactual.mainFirst),
    coAnchor: targets.map(item => item.counterfactual.coAnchor),
    mainFirstCoAnchor: targets.map(item => item.counterfactual.mainFirstCoAnchor),
    // Real product probes. Best of the default answer and the probe, i.e. what a caller issuing both would see.
    orTextRoute: targets.map(item => minRank(item.rank, item.counterfactual.textRoute)),
    orWithTerms: targets.map(item => minRank(item.rank, item.counterfactual.withTerms))
  };
  const declarations = targets.filter(item => item.role === "declaration");
  const missed = targets.filter(item => item.rank === null);
  const exactTargets = targets.filter(item => item.intent === "exact");
  const ambiguous = targets.filter(item => item.mechanism === "EXACT_AMBIGUOUS");
  return {
    tasks: rows.length,
    emptyPlanTasks: rows.filter(row => row.planTerms === 0).length,
    targets: targets.length,
    javaTargets: targets.filter(item => item.kind === "java").length,
    // Primary product metric on role-labelled gold (sealed set); null when the gold carries no roles (mac10-v3).
    declarationTargets: declarations.length,
    declarationHitAt: declarations.length ? Object.fromEntries(CUTOFFS.map(cutoff => [cutoff, hitAt(declarations.map(item => item.rank), cutoff)])) : null,
    byMechanism,
    hitAt: Object.fromEntries(Object.entries(series).map(([name, ranks]) => [name, Object.fromEntries(CUTOFFS.map(cutoff => [cutoff, hitAt(ranks, cutoff)]))])),
    exactRoute: {
      targets: exactTargets.length,
      textRouteHitAt: Object.fromEntries(CUTOFFS.map(cutoff => [cutoff, hitAt(exactTargets.map(item => item.counterfactual.textRoute), cutoff)]))
    },
    ambiguous: {
      targets: ambiguous.length,
      identityOrdered: ambiguous.filter(item => item.identityOrdered === true).length,
      selectionLimited: ambiguous.filter(item => item.selectionLimited).length,
      sameNameAheadTotal: ambiguous.reduce((sum, item) => sum + item.ahead.sameName, 0),
      testAheadTotal: ambiguous.reduce((sum, item) => sum + item.ahead.test, 0)
    },
    testAheadOfTarget: targets.filter(item => item.rank !== null && item.ahead.test > 0).length,
    notCovered: {
      targets: missed.length,
      afterExactRoute: missed.filter(item => item.intent === "exact").length,
      recoveredByTextRoute: missed.filter(item => item.counterfactual.textRoute !== null).length,
      recoveredByWithTerms: missed.filter(item => item.counterfactual.withTerms !== null).length
    },
    // The plan's terms whose predicted route (classifyQuery mirror) disagrees with the wire's exact field. Non-zero
    // means the EXACT_* / TEXT_MERGE labels are not trustworthy for those terms.
    intentMismatchTerms: rows.reduce((sum, row) => sum + (row.intentMismatchTerms ?? 0), 0)
  };
}

/** One task: every planned term with the production default mode; searchMode=text when that took the exact route; query+terms (the plan's other terms) when the plan has more than one term. */
export async function diagnoseTask({ task, call, limit = DIAGNOSIS_LIMIT }) {
  const plan = planQueries(task);
  const responses = new Map();
  let intentMismatchTerms = 0;
  for (const term of plan.terms) {
    const base = { operation: "query", query: term, limit, preview: "none" };
    const auto = await call("java_symbol", base);
    if ((auto.exact !== undefined) !== (predictedIntent(term) === "exact")) intentMismatchTerms += 1;
    const text = auto.exact !== undefined ? await call("java_symbol", { ...base, searchMode: "text" }) : undefined;
    const others = plan.terms.filter(other => other !== term).slice(0, MAX_CONTEXT_TERMS);
    const withTerms = others.length ? await call("java_symbol", { ...base, terms: others }) : undefined;
    responses.set(term, { auto, ...(text ? { text } : {}), ...(withTerms ? { withTerms } : {}) });
  }
  return { plan, responses, intentMismatchTerms };
}

export async function openProductSession({ serverJs, corpusRoot, workDir, readyTimeoutMs }) {
  const { startOwnerDaemon } = await import("./owner-daemon.mjs");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const env = { PATH: `/opt/homebrew/bin:${process.env.PATH ?? "/usr/bin:/bin"}`, TMPDIR: workDir, JDTLS_BIN: "/usr/bin/false" };
  const owner = await startOwnerDaemon({ serverJs, cacheRoot: path.join(workDir, "cache"), env, ephemeralCache: false });
  const client = new Client({ name: "ilv2-ranking-diagnosis", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverJs], cwd: corpusRoot, env: owner.relayEnv, stderr: "ignore" }));
    // callRaw mirrors the retrieval runner's call: the parsed value and the UTF-8 bytes of the tool text.
    const callRaw = async (name, args) => {
      const result = await client.callTool({ name, arguments: { repoRoot: corpusRoot, ...args } }, undefined, { timeout: 120000 });
      const text = result.content?.map(part => part.text).join("\n") ?? "";
      requireValue(!result.isError, `${name} failed: ${text.slice(0, 300)}`);
      return { value: JSON.parse(text), bytes: Buffer.byteLength(text) };
    };
    const call = async (name, args) => (await callRaw(name, args)).value;
    const started = performance.now();
    await call("java_status", { start: true });
    for (;;) {
      const status = await call("java_status", {});
      if (status.indexView?.state === "FRESH") break;
      requireValue(performance.now() - started < readyTimeoutMs, `product index not FRESH within ${readyTimeoutMs} ms (state ${status.indexView?.state})`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { call, callRaw, readyMs: performance.now() - started, close: async () => { try { await client.close(); } finally { await owner.stop(); } } };
  } catch (error) {
    try { await client.close(); } finally { await owner.stop(); }
    throw error;
  }
}

export async function runDiagnosis({ datasetFile, tasksFile, goldFile, inputsFile, serverJs, out, taskIds, readyTimeoutMs = 900000, openSession = openProductSession, materialize = materializeCorpus }) {
  const { root, manifest } = await verifyDataset(datasetFile);
  const tasksBytes = await readFile(tasksFile);
  const split = ["dev", "holdout"].find(name => manifest.parts[`tasks-${name}`]?.sha256 === sha256(tasksBytes));
  requireValue(split, "tasks file is not a part of this dataset");
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts[`gold-${split}`].sha256 === sha256(goldBytes), `gold file is not this dataset's ${split} gold`);
  let tasks = tasksBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  if (taskIds) {
    const known = new Set(tasks.map(task => task.taskId));
    for (const id of taskIds) requireValue(known.has(id), `unknown task ${id}`);
    tasks = tasks.filter(task => taskIds.includes(task.taskId));
  }
  requireValue(tasks.length > 0, "no tasks selected");
  await mkdir(out);
  const corpusManifest = await readJson(path.join(root, manifest.parts.corpus.file));
  const inputs = new Map((await readJson(inputsFile)).map(record => [record.name, record]));
  // Phase 1: queries from the agent-visible task only.
  const observed = new Map();
  const sessions = {};
  const roots = new Map();
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
    try {
      for (const task of tasks.filter(item => item.corpusId === corpusId)) observed.set(task.taskId, await diagnoseTask({ task, call: session.call }));
    } finally { await session.close(); }
  }
  await writeFile(path.join(out, "responses.jsonl"), [...observed].map(([taskId, { plan, responses }]) => JSON.stringify({ taskId, plan, responses: Object.fromEntries(responses) })).join("\n") + "\n");
  // Phase 2: gold.
  const gold = new Map(goldBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).map(row => [row.taskId, row]));
  const rows = [];
  for (const task of tasks) {
    const { plan, responses, intentMismatchTerms } = observed.get(task.taskId);
    const corpusRoot = roots.get(task.corpusId);
    const cache = new Map();
    const fileText = relativePath => cache.get(relativePath) ?? null;
    for (const candidate of [...responses.values()].flatMap(item => item.auto.candidates ?? [])) {
      const file = candidate.declaration?.relativePath;
      if (file && !cache.has(file)) cache.set(file, await readFile(path.join(corpusRoot, file), "utf8").catch(() => null));
    }
    const targets = (gold.get(task.taskId)?.requiredEvidence ?? []).map(target => classifyTarget({ target, plan, responses, fileText }));
    rows.push({ taskId: task.taskId, corpusId: task.corpusId, category: task.category, planTerms: plan.terms.length, intentMismatchTerms, targets });
  }
  await writeFile(path.join(out, "rows.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const summary = {
    schema: DIAGNOSIS_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, split, tasksSha256: sha256(tasksBytes), goldSha256: sha256(goldBytes),
      serverBuildStampSha256: sha256(await readFile(path.join(path.dirname(serverJs), "build-stamp.json"))), limit: DIAGNOSIS_LIMIT, window: DRIVER_WINDOW, planner: "planQueries" },
    sessions,
    ...summarize(rows),
    notClaimed: "Candidate order only. mainFirst/coAnchor re-order the returned top-20 and do not measure a changed product; textRoute/withTerms are real calls of the current product. No reads or task success are measured."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(args) {
  const options = cliOptions(args, ["--dataset", "--tasks", "--gold", "--inputs", "--server-js", "--out", "--task-ids"]);
  for (const name of ["dataset", "tasks", "gold", "inputs", "server-js", "out"]) requireValue(options[name], `--${name} is required`);
  const summary = await runDiagnosis({ datasetFile: path.resolve(options.dataset), tasksFile: path.resolve(options.tasks), goldFile: path.resolve(options.gold),
    inputsFile: path.resolve(options.inputs), serverJs: path.resolve(options["server-js"]), out: path.resolve(options.out),
    taskIds: options["task-ids"] ? options["task-ids"].split(",").filter(Boolean) : undefined });
  console.log(JSON.stringify(summary, null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));

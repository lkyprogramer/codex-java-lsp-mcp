#!/usr/bin/env node
// D15 step B, model-free and product-free. Replays the candidate lists W1 already captured (responses.jsonl: the
// default auto answer and, for exact-route terms, the searchMode=text probe, both at limit 20, preview none) through
// the pre-registered merge strategies of D15 §8, and scores them against the dev gold with the diagnosis matcher.
// Before any strategy number it recomputes W1's own observed and text-probe ranks and refuses to report when they
// differ from rows.jsonl, so a pairing or matching error on the real corpus cannot pass silently.
// Private per-target rows stay under --out; summary.json carries counts only.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { matchesTarget, rankOf } from "./ilv2-ranking-diagnosis.mjs";

export const SIMULATION_SCHEMA = "post-ilv2/merge-simulation/v1";
export const SIM_CUTOFFS = Object.freeze([1, 3, 5, 8, 20]);
export const SIM_LIMITS = Object.freeze([3, 5, 8]);
// src/discovery/query.ts head preview: at most 1024 B per candidate and 2048 B per request (not captured by W1).
export const HEAD_PREVIEW = Object.freeze({ perCandidate: 1024, perRequest: 2048 });
export const OUTCOMES = Object.freeze(["match", "ambiguous", "miss", "text"]);

/** A candidate's identity for de-duplication: the locator id, plus the evidence source when it is not the declaration (MyBatis XML). */
export function candidateKey(candidate) {
  const evidence = candidate.evidenceRange;
  return `${candidate.declaration?.id ?? JSON.stringify(candidate.declaration)}|${evidence ? `${evidence.relativePath}:${evidence.startLine}` : ""}`;
}
function dedupe(list) {
  const seen = new Set();
  return list.filter(candidate => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function interleave(left, right) {
  const out = [];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if (i < left.length) out.push(left[i]);
    if (i < right.length) out.push(right[i]);
  }
  return out;
}

/** The route outcome of one term: the exact lookup outcome, or "text" when auto mode took the text route. */
export function outcomeOf(response) {
  return response.auto.exact ?? "text";
}

/**
 * Pre-registered strategies (D15 §8.2). Each maps one term's captured responses to the list the changed product would
 * return; text-route terms are never changed. The order does not depend on the limit, so a limit is a prefix.
 * - baseline:        today's auto answer.
 * - fillAfterHit:    an exact match/ambiguous answer first, then the text route fills the rest. A miss stays empty (R07).
 * - fillAlways:      as fillAfterHit, and an exact miss returns the text route (reverses R07 "a miss never falls back").
 * - interleaveAlways: exact and text answers alternate, misses included.
 */
export const STRATEGIES = Object.freeze({
  baseline: response => response.auto.candidates ?? [],
  fillAfterHit: response => {
    const auto = response.auto.candidates ?? [];
    if (response.auto.exact === undefined || response.auto.exact === "miss") return auto;
    return dedupe([...auto, ...(response.text?.candidates ?? [])]);
  },
  fillAlways: response => response.auto.exact === undefined ? response.auto.candidates ?? [] : dedupe([...(response.auto.candidates ?? []), ...(response.text?.candidates ?? [])]),
  interleaveAlways: response => response.auto.exact === undefined ? response.auto.candidates ?? [] : dedupe(interleave(response.auto.candidates ?? [], response.text?.candidates ?? []))
});

/** Best rank of one target over the plan's terms under one strategy, with the outcome of the term that gave it. */
export function bestRank(plan, responses, target, strategy) {
  let best = { rank: null, outcome: null };
  for (const term of plan.terms) {
    const response = responses[term];
    if (!response) continue;
    const rank = rankOf(strategy(response), target);
    if (rank !== null && (best.rank === null || rank < best.rank)) best = { rank, outcome: outcomeOf(response) };
  }
  return best;
}
function probeRank(plan, responses, target, probe) {
  let best = null;
  for (const term of plan.terms) {
    const candidates = responses[term]?.[probe]?.candidates;
    if (!candidates) continue;
    const rank = rankOf(candidates, target);
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}
const minRank = (a, b) => a === null ? b : b === null ? a : Math.min(a, b);
const hits = (ranks, cutoff) => ranks.filter(rank => rank !== null && rank <= cutoff).length;
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;
};
const spread = values => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null });
const bytesOf = value => Buffer.byteLength(JSON.stringify(value));

/** Locator bytes of the response a strategy would return at a limit: the captured envelope plus the kept candidates. */
export function responseBytes(response, list, limit) {
  const { candidates, ...envelope } = response.auto;
  const kept = list.slice(0, limit);
  return bytesOf({ ...envelope, candidates: kept });
}

/**
 * Self-check against W1: every target's recomputed default rank and text-probe rank must equal rows.jsonl.
 * Returns the mismatch count; the caller refuses to report on any.
 */
export function checkAgainstRows({ tasks, rows }) {
  const byTask = new Map(rows.map(row => [row.taskId, row]));
  let mismatches = 0;
  for (const task of tasks) {
    const row = byTask.get(task.taskId);
    if (!row || row.targets.length !== task.targets.length) { mismatches += 1; continue; }
    task.targets.forEach((target, index) => {
      const recorded = row.targets[index];
      const observed = bestRank(task.plan, task.responses, target, STRATEGIES.baseline).rank;
      const textRoute = probeRank(task.plan, task.responses, target, "text");
      if (observed !== recorded.rank || textRoute !== recorded.counterfactual.textRoute) mismatches += 1;
    });
  }
  return mismatches + rows.filter(row => !tasks.some(task => task.taskId === row.taskId)).length;
}

/** Counts only. `tasks`: [{ taskId, category, plan, responses, targets }] with gold targets attached. */
export function simulate(tasks) {
  const targets = tasks.flatMap(task => task.targets.map(target => ({ task, target, kind: target.path.endsWith(".java") ? "java" : "other" })));
  const result = { tasks: tasks.length, targets: targets.length, javaTargets: targets.filter(item => item.kind === "java").length, strategies: {} };
  const ranks = {};
  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    ranks[name] = targets.map(item => bestRank(item.task.plan, item.task.responses, item.target, strategy));
  }
  // Upper bound for any merge of the two captured lists: the better of the default rank and the text-probe rank.
  const bound = targets.map((item, index) => minRank(ranks.baseline[index].rank, probeRank(item.task.plan, item.task.responses, item.target, "text")));
  result.bestOfBothHitAt = Object.fromEntries(SIM_CUTOFFS.map(cutoff => [cutoff, hits(bound, cutoff)]));
  const terms = tasks.flatMap(task => task.plan.terms.filter(term => task.responses[term]).map(term => ({ task, response: task.responses[term] })));
  result.termsByOutcome = Object.fromEntries(OUTCOMES.map(outcome => [outcome, terms.filter(term => outcomeOf(term.response) === outcome).length]));
  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    const own = ranks[name].map(item => item.rank);
    const byKind = kind => Object.fromEntries(SIM_CUTOFFS.map(cutoff => [cutoff, hits(own.filter((_, index) => targets[index].kind === kind), cutoff)]));
    const categories = [...new Set(tasks.map(task => task.category))].sort();
    const gained = {};
    const lost = {};
    for (const limit of SIM_LIMITS) {
      gained[limit] = Object.fromEntries(OUTCOMES.map(outcome => [outcome, 0]));
      lost[limit] = 0;
      targets.forEach((_, index) => {
        const before = ranks.baseline[index].rank;
        const after = ranks[name][index];
        const was = before !== null && before <= limit;
        const now = after.rank !== null && after.rank <= limit;
        if (now && !was) gained[limit][after.outcome] += 1;
        if (was && !now) lost[limit] += 1;
      });
    }
    const exceedsBound = SIM_CUTOFFS.some(cutoff => hits(own, cutoff) > result.bestOfBothHitAt[cutoff]);
    result.strategies[name] = {
      hitAt: Object.fromEntries(SIM_CUTOFFS.map(cutoff => [cutoff, hits(own, cutoff)])),
      hitAtByKind: { java: byKind("java"), other: byKind("other") },
      hitAt8ByCategory: Object.fromEntries(categories.map(category => [category, {
        targets: targets.filter(item => item.task.category === category).length,
        hits: hits(own.filter((_, index) => targets[index].task.category === category), 8)
      }])),
      // Targets newly within the limit, attributed to the route outcome of the term that now finds them.
      gainedVsBaseline: gained,
      lostVsBaseline: lost,
      fullRecallTasks: Object.fromEntries(SIM_LIMITS.map(limit => [limit, tasks.filter(task => task.targets.length > 0 && task.targets.every(target => {
        const index = targets.findIndex(item => item.task === task && item.target === target);
        return own[index] !== null && own[index] <= limit;
      })).length])),
      exceedsBestOfBoth: exceedsBound,
      perLimit: Object.fromEntries(SIM_LIMITS.map(limit => {
        const lists = terms.map(term => ({ outcome: outcomeOf(term.response), response: term.response, list: strategy(term.response).slice(0, limit) }));
        const exact = lists.filter(item => item.outcome !== "text");
        const perTask = tasks.map(task => task.plan.terms.filter(term => task.responses[term]).map(term => strategy(task.responses[term]).slice(0, limit)));
        return [limit, {
          candidatesPerExactTerm: spread(exact.map(item => item.list.length)),
          locatorBytesPerExactTerm: spread(exact.map(item => responseBytes(item.response, item.list, limit))),
          locatorBytesPerTerm: spread(lists.map(item => responseBytes(item.response, item.list, limit))),
          // Labelled bound, not a measurement: what head previews could add under the product caps.
          headPreviewBoundBytesPerTerm: spread(lists.map(item => Math.min(HEAD_PREVIEW.perRequest, item.list.length * HEAD_PREVIEW.perCandidate))),
          candidatesPerTask: spread(perTask.map(lists => lists.reduce((sum, list) => sum + list.length, 0))),
          distinctFilesPerTask: spread(perTask.map(lists => new Set(lists.flat().map(candidate => candidate.declaration?.relativePath)).size))
        }];
      }))
    };
  }
  return result;
}

const readJsonl = async file => (await readFile(file, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));

export async function runSimulation({ datasetFile, goldFile, responsesFile, rowsFile, out }) {
  const { manifest } = await verifyDataset(datasetFile);
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts["gold-dev"]?.sha256 === sha256(goldBytes), "gold file is not this dataset's dev gold; the simulation never reads holdout gold");
  const gold = new Map(goldBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).map(row => [row.taskId, row]));
  const rows = await readJsonl(rowsFile);
  const categories = new Map(rows.map(row => [row.taskId, row.category]));
  const tasks = (await readJsonl(responsesFile)).map(({ taskId, plan, responses }) => {
    requireValue(gold.has(taskId), `task ${taskId} has no dev gold`);
    return { taskId, category: categories.get(taskId) ?? null, plan, responses, targets: gold.get(taskId).requiredEvidence ?? [] };
  });
  const mismatches = checkAgainstRows({ tasks, rows });
  requireValue(mismatches === 0, `${mismatches} targets or tasks differ from W1 rows.jsonl; refusing to report strategy numbers`);
  const summary = simulate(tasks);
  for (const [name, item] of Object.entries(summary.strategies)) requireValue(!item.exceedsBestOfBoth, `strategy ${name} exceeds the best-of-both bound`);
  await mkdir(out);
  await writeFile(path.join(out, "targets.jsonl"), tasks.flatMap(task => task.targets.map(target => JSON.stringify({ taskId: task.taskId, path: target.path,
    ranks: Object.fromEntries(Object.entries(STRATEGIES).map(([name, strategy]) => [name, bestRank(task.plan, task.responses, target, strategy)])) }))).join("\n") + "\n");
  const report = {
    schema: SIMULATION_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, split: "dev", goldSha256: sha256(goldBytes),
      responsesSha256: sha256(await readFile(responsesFile)), rowsSha256: sha256(await readFile(rowsFile)) },
    selfCheck: { rowsMatched: rows.length, mismatches: 0 },
    ...summary,
    notClaimed: "Replays W1's captured lists (limit 20, preview none); top-L at limit L is assumed to be the limit-20 prefix. Locator bytes are measured on those lists; head-preview bytes are a bound from the product caps. Candidate order only: no reads, runner recall or task success."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main(args) {
  const options = cliOptions(args, ["--dataset", "--gold", "--responses", "--rows", "--out"]);
  for (const name of ["dataset", "gold", "responses", "rows", "out"]) requireValue(options[name], `--${name} is required`);
  const report = await runSimulation({ datasetFile: path.resolve(options.dataset), goldFile: path.resolve(options.gold), responsesFile: path.resolve(options.responses),
    rowsFile: path.resolve(options.rows), out: path.resolve(options.out) });
  console.log(JSON.stringify(report, null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));

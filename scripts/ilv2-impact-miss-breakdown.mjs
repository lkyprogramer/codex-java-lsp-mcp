#!/usr/bin/env node
// D16, offline and model-free. Re-reads D15 step F's private artifacts (responses.jsonl, rows.jsonl) with the dev
// gold and splits every uncredited Java target into one pre-registered cause (docs/post-ilv2/d16-impact-miss-breakdown.md).
// No product call is made: the causes come from the anchors, candidate pools, reasons and evidence gaps F already
// recorded. Private rows (paths, reasons) stay under --out; summary.json carries counts only.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cliOptions, isMain, requireValue, runCli, sha256 } from "./ilv2-mac-contracts.mjs";
import { verifyDataset } from "./ilv2-mac-eval-dataset.mjs";
import { CORE_EXCEEDED_GAP, PROTECTED_CORE_KINDS } from "./ilv2-impact-budget-diagnosis.mjs";

export const MISS_BREAKDOWN_SCHEMA = "post-ilv2/impact-miss-breakdown/v1";
export const CONFIGS = Object.freeze(["C0", "C3"]);
export const FOCUS = Object.freeze(["implementations", "callers"]);
// First matching cause wins, in this order (d16 §2).
export const CAUSES = Object.freeze(["NO_IMPACT_CALL", "SELECTED_RANGE_MISS", "ANCHOR_CONFOUND", "RELATION_MISSING", "CORE_CAPPED", "PROTECTED_UNSELECTED", "WEAK_RELATION"]);
export const GATE = 5; // d16 §3, the same size as D15 W3's implementation gate

const EXACT = "match";
const hasProtectedReason = file => (file?.reasons ?? []).some(reason => PROTECTED_CORE_KINDS.has(reason));
const coreExceeded = diagnostic => (diagnostic?.evidenceGaps ?? []).some(gap => gap.startsWith(CORE_EXCEEDED_GAP));

/** The impact calls one task made under one configuration, with the anchor's exactness. */
export function callsOf(observation, config) {
  return observation.terms.filter(row => row.impacts?.[config]).map(row => ({ exact: row.exact ?? "text", anchorFile: row.symbol?.candidates?.[0]?.declaration?.relativePath ?? null, diagnostic: row.impacts[config].diagnostic }));
}

/** One uncredited target's cause. `label` is F's own label for it; the cause only refines it. */
export function classifyMiss({ item, label, calls }) {
  const anyExact = calls.some(call => call.exact === EXACT);
  const base = { anchorExactCalls: calls.filter(call => call.exact === EXACT).length, calls: calls.length };
  if (label === "NO_IMPACT_CALL" || calls.length === 0) return { cause: "NO_IMPACT_CALL", ...base };
  if (label === "SELECTED_RANGE_MISS") return { cause: "SELECTED_RANGE_MISS", ...base };
  const present = calls.map(call => ({ call, file: call.diagnostic.files.find(entry => entry.path === item.path) })).filter(entry => entry.file);
  if (present.length === 0) return { cause: anyExact ? "RELATION_MISSING" : "ANCHOR_CONFOUND", ...base };
  // F labels UNSELECTED from the first call whose pool holds the file; keep that call.
  const { call, file } = present[0];
  const files = call.diagnostic.files;
  const detail = { ...base, inPoolCalls: present.length, presentAnchorExact: call.exact === EXACT, poolRank: files.indexOf(file) + 1, poolSize: files.length,
    role: file.role ?? null, protectedReasons: (file.reasons ?? []).filter(reason => PROTECTED_CORE_KINDS.has(reason)), coreExceeded: coreExceeded(call.diagnostic) };
  if (!hasProtectedReason(file)) return { cause: "WEAK_RELATION", ...detail };
  return { cause: detail.coreExceeded ? "CORE_CAPPED" : "PROTECTED_UNSELECTED", ...detail };
}

/** Pool files whose reasons carry a protected-core kind but whose output role is `related` (output-v6 roleOf). */
export function roleAudit(observations, config) {
  let files = 0, relatedProtected = 0;
  const kinds = {};
  for (const observation of observations) for (const call of callsOf(observation, config)) for (const file of call.diagnostic.files) {
    files += 1;
    if (file.role !== "related" || !hasProtectedReason(file)) continue;
    relatedProtected += 1;
    for (const reason of file.reasons.filter(entry => PROTECTED_CORE_KINDS.has(entry))) kinds[reason] = (kinds[reason] ?? 0) + 1;
  }
  return { poolFiles: files, relatedWithProtectedReason: relatedProtected, protectedKinds: kinds };
}

const tally = (rows, key) => rows.reduce((acc, row) => { const value = row[key] ?? "?"; if (!Object.hasOwn(acc, value)) acc[value] = 0; acc[value] += 1; return acc; }, {});
const zeroed = () => Object.fromEntries(CAUSES.map(cause => [cause, 0]));

/** Counts only, plus the d16 §3 rule outcomes. */
export function summarize(missRows, audit) {
  const byConfig = {};
  for (const config of CONFIGS) {
    const rows = missRows.filter(row => row.config === config);
    const byCategory = {};
    for (const row of rows) {
      byCategory[row.category] ??= zeroed();
      byCategory[row.category][row.cause] += 1;
    }
    byConfig[config] = { uncreditedJava: rows.length, byCause: { ...zeroed(), ...tally(rows, "cause") }, byCategory,
      unselectedPresentAnchorExact: tally(rows.filter(row => row.poolRank), "presentAnchorExact") };
  }
  const focus = config => missRows.filter(row => row.config === config && FOCUS.includes(row.category));
  const count = (rows, causes) => rows.filter(row => causes.includes(row.cause)).length;
  const c0 = focus("C0");
  const selection = c0.filter(row => ["CORE_CAPPED", "PROTECTED_UNSELECTED"].includes(row.cause));
  const persistsInC3 = selection.filter(row => missRows.some(other => other.config === "C3" && other.taskId === row.taskId && other.index === row.index)).length;
  const weak = count(c0, ["WEAK_RELATION"]);
  const rules = {
    focusMissesC0: c0.length,
    R1_replay: { value: count(c0, ["RELATION_MISSING", "ANCHOR_CONFOUND"]), gate: GATE },
    R2_selection: { value: selection.length, persistsInC3, gate: GATE },
    R3_weak: { value: weak, half: c0.length / 2 },
    R4_range: { value: count(c0, ["SELECTED_RANGE_MISS"]), gate: 3 }
  };
  rules.R1_replay.triggered = rules.R1_replay.value >= GATE;
  rules.R2_selection.triggered = selection.length >= GATE && persistsInC3 * 2 >= selection.length;
  rules.R3_weak.triggered = c0.length > 0 && weak * 2 >= c0.length;
  rules.R4_range.triggered = rules.R4_range.value >= 3;
  return { byConfig, rules, roleAudit: audit };
}

export function breakdown({ rows, observations, gold }) {
  const byTask = new Map(observations.map(observation => [observation.taskId, observation]));
  const missRows = [];
  for (const row of rows) {
    const observation = byTask.get(row.taskId);
    const required = gold.get(row.taskId)?.requiredEvidence ?? [];
    requireValue(observation, `no F observation for ${row.taskId}`);
    for (const config of CONFIGS) {
      const targets = row.configs[config]?.targets ?? [];
      requireValue(targets.length === required.length, `${row.taskId} ${config}: ${targets.length} scored targets vs ${required.length} gold ranges`);
      targets.forEach((target, index) => {
        const item = required[index];
        requireValue(target.kind === (item.path.endsWith(".java") ? "java" : "other"), `${row.taskId} ${config} #${index}: target kind does not match gold path`);
        if (target.credited || target.kind !== "java") return;
        missRows.push({ taskId: row.taskId, category: row.category, config, index, path: item.path, label: target.label,
          ...classifyMiss({ item, label: target.label, calls: callsOf(observation, config) }) });
      });
    }
  }
  return missRows;
}

const jsonl = bytes => bytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

export async function runMissBreakdown({ datasetFile, goldFile, responsesFile, rowsFile, expect, out }) {
  const { manifest } = await verifyDataset(datasetFile);
  const goldBytes = await readFile(goldFile);
  requireValue(manifest.parts["gold-dev"]?.sha256 === sha256(goldBytes), "gold file is not this dataset's dev gold");
  const responsesBytes = await readFile(responsesFile);
  const rowsBytes = await readFile(rowsFile);
  // Bind to the exact F run recorded in docs/post-ilv2/results/D15-F.json rawEvidence.
  requireValue(sha256(responsesBytes) === expect.responses, "responses.jsonl is not the recorded D15-F artifact");
  requireValue(sha256(rowsBytes) === expect.rows, "rows.jsonl is not the recorded D15-F artifact");
  const gold = new Map(jsonl(goldBytes).map(row => [row.taskId, row]));
  const observations = jsonl(responsesBytes);
  const missRows = breakdown({ rows: jsonl(rowsBytes), observations, gold });
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "miss-rows.jsonl"), missRows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const summary = {
    schema: MISS_BREAKDOWN_SCHEMA,
    identity: { datasetId: manifest.datasetId, datasetDigest: manifest.datasetDigest, goldSha256: sha256(goldBytes), responsesSha256: expect.responses, rowsSha256: expect.rows },
    ...summarize(missRows, roleAudit(observations, "C0")),
    notClaimed: "Offline re-read of D15-F (semanticPolicy fast, first-candidate anchors). No product or model call. Protected-core status is approximated from reasons; the product also uses plannerEvidence, which F did not keep."
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main(args) {
  const options = cliOptions(args, ["--dataset", "--gold", "--responses", "--rows", "--expect-responses-sha256", "--expect-rows-sha256", "--out"]);
  for (const name of ["dataset", "gold", "responses", "rows", "expect-responses-sha256", "expect-rows-sha256", "out"]) requireValue(options[name], `--${name} is required`);
  const summary = await runMissBreakdown({ datasetFile: path.resolve(options.dataset), goldFile: path.resolve(options.gold), responsesFile: path.resolve(options.responses),
    rowsFile: path.resolve(options.rows), expect: { responses: options["expect-responses-sha256"], rows: options["expect-rows-sha256"] }, out: path.resolve(options.out) });
  console.log(JSON.stringify(summary, null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));

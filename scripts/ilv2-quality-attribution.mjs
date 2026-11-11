// input: evaluator-side stage observations per failed task (from dev / exposed-regression runs only).
// output: the earliest provable break per task, a ledger by label, and which conditional cards
//         (Q05–Q08) have trigger evidence.
// pos: post-ILV2 Q02 (docs/java-specialist-post-ilv2-v1/docs/06-evaluation.md §6.3). Labels are evaluator
//      facts: the runtime never sees gold. A null stage before the first failure is UNMEASURED; the
//      tool never guesses a downstream cause past an unmeasured stage.
import { readFile, writeFile } from "node:fs/promises";
import { isMain, requireValue, runCli } from "./ilv2-mac-contracts.mjs";

/** Pipeline order and the label of a break at each stage (06 §6.3). */
export const STAGES = Object.freeze([
  ["discovered", "NOT_DISCOVERED"],
  ["declarationCorrect", "WRONG_DECLARATION"],
  ["relationAvailable", "RELATION_MISSING"],
  ["selected", "CANDIDATE_EVICTED"],
  ["rangeCovered", "RANGE_MISS"],
  ["serialized", "SERIALIZATION_LOSS"],
  ["deliveryConfirmed", "DELIVERY_UNCONFIRMED"],
  ["taskPassed", "TASK_REASONING_OR_EDIT_FAILURE"]
]);

/**
 * The earliest stage known false. A stage that is null before any false one leaves the cause
 * UNMEASURED: whatever comes after it is not observed. Every stage true is PASSED.
 */
export function classifyFailure(stage) {
  requireValue(stage && typeof stage === "object", "stage observations required");
  for (const [key] of STAGES) {
    const value = stage[key];
    requireValue(value === true || value === false || value === null, `${key} must be true, false or null`);
  }
  for (const [key, label] of STAGES) {
    const value = stage[key];
    if (value === null) return "UNMEASURED";
    if (value === false) return label;
  }
  return "PASSED";
}

/**
 * Which conditional card a label is evidence for (G2: at least two distinct task groups, or one
 * recorded deterministic critical defect). Q09 is triggered by measured waits, not by this ledger.
 */
export const CARD_FOR_LABEL = Object.freeze({
  NOT_DISCOVERED: "Q06",
  RELATION_MISSING: "Q05",
  CANDIDATE_EVICTED: "Q07",
  RANGE_MISS: "Q07",
  WRONG_DECLARATION: "Q08"
});
export const TRIGGER_MIN_GROUPS = 2;

/**
 * rows: {taskId, taskGroup, split, stage, plannerQueries?, criticalDefect?}. Holdout rows are refused:
 * the queue must not be chosen on held-out tasks (exposed holdouts are recorded as split "regression").
 * A row whose planner issued zero queries is NOT_PLANNED, kept apart from a real search miss.
 */
export function buildLedger(rows) {
  requireValue(Array.isArray(rows), "rows required");
  const seen = new Set();
  const entries = rows.map(row => {
    requireValue(row && typeof row === "object", "row must be an object");
    requireValue(typeof row.taskId === "string" && typeof row.taskGroup === "string", "taskId and taskGroup required");
    requireValue(row.split === "dev" || row.split === "regression", `${row.taskId}: only dev or exposed regression rows may choose the queue (got ${row.split})`);
    requireValue(!seen.has(row.taskId), `${row.taskId}: duplicate task`);
    seen.add(row.taskId);
    // The stage record is validated even when the planner issued no query.
    const classified = classifyFailure(row.stage);
    const label = row.plannerQueries === 0 ? "NOT_PLANNED" : classified;
    return { taskId: row.taskId, taskGroup: row.taskGroup, split: row.split, label, criticalDefect: row.criticalDefect ?? null };
  });
  const byLabel = {};
  for (const entry of entries) (byLabel[entry.label] ??= []).push(entry.taskId);
  const cards = {};
  for (const card of ["Q05", "Q06", "Q07", "Q08"]) {
    const evidence = entries.filter(entry => CARD_FOR_LABEL[entry.label] === card);
    const groups = [...new Set(evidence.map(entry => entry.taskGroup))].sort();
    const defects = evidence.filter(entry => typeof entry.criticalDefect === "string" && entry.criticalDefect !== "").map(entry => entry.criticalDefect);
    cards[card] = { status: groups.length >= TRIGGER_MIN_GROUPS || defects.length > 0 ? "TRIGGERED" : "NOT_TRIGGERED", taskGroups: groups, criticalDefects: defects };
  }
  // A critical defect on a row whose label maps to no card is kept visible, not dropped.
  const unmappedDefects = entries.filter(entry => entry.criticalDefect && !CARD_FOR_LABEL[entry.label]).map(entry => ({ taskId: entry.taskId, label: entry.label, criticalDefect: entry.criticalDefect }));
  return { schema: "post-ilv2-attribution/v1", rows: entries, byLabel, cards, unmappedDefects,
    unmeasured: entries.filter(entry => entry.label === "UNMEASURED").length };
}

async function main(args) {
  const [input, output] = args;
  requireValue(input && output, "usage: ilv2-quality-attribution.mjs ROWS_JSON OUT_JSON (rows: [{taskId, taskGroup, split, stage, plannerQueries?, criticalDefect?}])");
  const ledger = buildLedger(JSON.parse(await readFile(input, "utf8")));
  await writeFile(output, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ byLabel: Object.fromEntries(Object.entries(ledger.byLabel).map(([label, ids]) => [label, ids.length])), cards: ledger.cards }, null, 2));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));

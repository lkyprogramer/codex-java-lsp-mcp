#!/usr/bin/env node
// input: three-repo matrix-summary.json project rows (old/new totals).
// output: F1 quality / token / p95 door adjudication. Does not invent TaskSuccess.
// pos: F1 closeout helper. Verifier `passed` is not the F1 door (minReadMust===1 residual).
import { readFileSync } from "node:fs";
import path from "node:path";

export const F1_QUALITY_TOLERANCE = 0.005;
export const F1_TOKEN_DROP_GATE = 0.2;
export const F1_P95_LIMIT = 1.1;
export const F1_QUALITY_METRICS = Object.freeze(["recall", "pRead", "rReadMust", "RangeLineRecall"]);
export const F1_G1_ANCHOR = Object.freeze({ lishuedu: 173, cipherlink: 29, "exam-parent-v3": 46 });
export const F1_G1_REGRESSION = 0.1;
export const F1_S1_MIB = 1024;
export const F1_S2_MIB = 1433.6;
export const F1_PUBLIC_TOOLS = Object.freeze([
  "java_status",
  "java_impact",
  "java_symbol",
  "java_diagnostics",
  "java_runtime"
]);

export function f1NonWorse(oldValue, newValue, tolerance = F1_QUALITY_TOLERANCE) {
  if (!isFiniteNumber(oldValue)) return null;
  if (!isFiniteNumber(newValue)) return false;
  return newValue + Number.EPSILON >= oldValue - tolerance;
}

export function f1TokenDrop(oldP50, newP50, gate = F1_TOKEN_DROP_GATE) {
  if (!isFiniteNumber(oldP50) || oldP50 <= 0 || !isFiniteNumber(newP50)) {
    return { drop: null, pass: false, gate };
  }
  const drop = (oldP50 - newP50) / oldP50;
  return { drop, pass: drop + Number.EPSILON >= gate, gate };
}

export function f1P95Pass(ratio, limit = F1_P95_LIMIT) {
  return isFiniteNumber(ratio) && ratio <= limit + Number.EPSILON;
}

export function rangeLineRecallOf(side) {
  const evidence = side?.rangeEvidence?.line;
  if (evidence && isFiniteNumber(evidence.mean)) return evidence.mean;
  if (isFiniteNumber(side?.RangeLineRecall)) return side.RangeLineRecall;
  if (isFiniteNumber(side?.readPlanRangeRecall)) return side.readPlanRangeRecall;
  return null;
}

export function holdoutMetric(side, metric) {
  const holdout = side?.splits?.holdout ?? side?.holdout;
  if (!holdout) return null;
  return isFiniteNumber(holdout[metric]) ? holdout[metric] : null;
}

export function adjudicateF1Project(project) {
  const oldSide = project?.old ?? {};
  const newSide = project?.new ?? {};
  const quality = {};
  for (const metric of F1_QUALITY_METRICS) {
    const oldValue = metric === "RangeLineRecall" ? rangeLineRecallOf(oldSide) : oldSide[metric];
    const newValue = metric === "RangeLineRecall" ? rangeLineRecallOf(newSide) : newSide[metric];
    quality[metric] = metricRow(oldValue, newValue);
  }
  const holdout = {};
  for (const metric of ["recall", "pRead", "rReadMust", "RangeLineRecall"]) {
    const oldValue = metric === "RangeLineRecall"
      ? rangeLineRecallOf(oldSide?.splits?.holdout ?? oldSide?.holdout)
      : holdoutMetric(oldSide, metric);
    const newValue = metric === "RangeLineRecall"
      ? rangeLineRecallOf(newSide?.splits?.holdout ?? newSide?.holdout)
      : holdoutMetric(newSide, metric);
    holdout[metric] = metricRow(oldValue, newValue);
  }
  const token = f1TokenDrop(oldSide.estimatedTokensP50, newSide.estimatedTokensP50);
  const p95Ratio = isFiniteNumber(project?.delta?.p95Ratio)
    ? project.delta.p95Ratio
    : (isFiniteNumber(oldSide.p95) && oldSide.p95 > 0 && isFiniteNumber(newSide.p95)
      ? newSide.p95 / oldSide.p95
      : null);
  const p95 = { ratio: p95Ratio, pass: f1P95Pass(p95Ratio) };
  const qualityPass = Object.values(quality).every(row => row.pass !== false);
  const holdoutPass = Object.values(holdout).every(row => row.pass !== false);
  return {
    project: project?.project,
    quality,
    holdout,
    token,
    p95,
    pass: qualityPass && holdoutPass && token.pass && p95.pass
  };
}

export function adjudicateF1Summary(summary) {
  const projects = Array.isArray(summary?.projects) ? summary.projects.map(adjudicateF1Project) : [];
  return {
    projects,
    pass: projects.length > 0 && projects.every(project => project.pass),
    verifierPassed: summary?.passed ?? null
  };
}

export function adjudicateMemory(memory) {
  const g1 = {};
  let g1Pass = true;
  for (const [project, anchor] of Object.entries(F1_G1_ANCHOR)) {
    const actual = memory?.g1?.[project];
    const pass = isFiniteNumber(actual) && actual <= anchor * (1 + F1_G1_REGRESSION) + Number.EPSILON;
    g1[project] = { actual: actual ?? null, anchor, pass };
    g1Pass = g1Pass && pass;
  }
  const s1 = isFiniteNumber(memory?.s1) ? memory.s1 : null;
  const s2 = isFiniteNumber(memory?.s2) ? memory.s2 : null;
  return {
    g1,
    s1: { actual: s1, gate: F1_S1_MIB, pass: s1 !== null && s1 <= F1_S1_MIB + Number.EPSILON },
    s2: { actual: s2, gate: F1_S2_MIB, pass: s2 !== null && s2 <= F1_S2_MIB + Number.EPSILON },
    pass: g1Pass
      && s1 !== null && s1 <= F1_S1_MIB + Number.EPSILON
      && s2 !== null && s2 <= F1_S2_MIB + Number.EPSILON
  };
}

export function adjudicateTools(measured) {
  const names = Array.isArray(measured?.names) ? measured.names : [];
  const expected = [...F1_PUBLIC_TOOLS];
  const same = names.length === expected.length && expected.every((name, index) => names[index] === expected[index]);
  const tokensOk = !isFiniteNumber(measured?.mainTokens)
    || (isFiniteNumber(measured?.tokens) && measured.tokens <= measured.mainTokens + Number.EPSILON);
  return {
    tools: names,
    expected,
    countPass: names.length === 5 && !names.includes("java_context") && same,
    tokenPass: tokensOk,
    pass: names.length === 5 && !names.includes("java_context") && same && tokensOk
  };
}

function metricRow(oldValue, newValue) {
  const pass = f1NonWorse(oldValue, newValue);
  return {
    old: oldValue ?? null,
    new: newValue ?? null,
    pass: pass === null ? "UNMEASURED_ON_BASELINE" : pass
  };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

const isMain = process.argv[1] && path.normalize(process.argv[1]).endsWith("adjudicate-f1-doors.mjs");
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/adjudicate-f1-doors.mjs <matrix-summary.json>");
    process.exit(2);
  }
  const summary = JSON.parse(readFileSync(file, "utf8"));
  console.log(JSON.stringify(adjudicateF1Summary(summary), null, 2));
}

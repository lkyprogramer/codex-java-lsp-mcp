#!/usr/bin/env node
// input: Frozen golden/*.scenarios.jsonl repo ids.
// output: Leave-one-repo-out folds. Matrix cells stay UNMEASURED until a real run.
// pos: V5R Phase 7 offline protocol. Does not retune ranking or invent TaskSuccess.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LEAVE_ONE_REPO_OUT_SCHEMA = "v5r-leave-one-repo-out/v1";
export const FOURTH_EVAL_REPO = "ruoyi-vue-pro";
export const FROZEN_GOLDEN_REPOS = Object.freeze(["cipherlink", "exam-parent-v3", "lishuedu", FOURTH_EVAL_REPO]);
export const LORO_DROP_GATE = 0.15;
export const LORO_METRICS = Object.freeze(["recall", "pRead", "rReadMust"]);

export function goldenReposFrom(goldenDir) {
  return readdirSync(goldenDir)
    .filter(name => name.endsWith(".scenarios.jsonl"))
    .map(name => name.slice(0, -".scenarios.jsonl".length))
    .sort();
}

export function leaveOneRepoOutFolds(repos = FROZEN_GOLDEN_REPOS) {
  if (repos.length < 3) {
    throw new Error("leave-one-repo-out requires at least three frozen repos");
  }
  const ordered = [...repos].sort();
  return ordered.map(heldOut => ({
    heldOut,
    train: ordered.filter(repo => repo !== heldOut),
    matrix: "UNMEASURED",
    taskSuccess: "UNMEASURED",
    retune: false
  }));
}

export function fourthRepoStatus(declaredFourth) {
  if (!declaredFourth) {
    return {
      status: "UNMEASURED",
      frozen: false,
      reason: "No fourth evaluation golden is declared. Fixture jsonl under golden/ is not a held-out repo. Freeze one before any new ranking knife."
    };
  }
  return { status: "FROZEN", frozen: true, repos: [declaredFourth] };
}

export function meanFinite(values) {
  const nums = (values ?? []).filter(value => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

export function leaveOneRepoOutScores(metricsByRepo, gate = LORO_DROP_GATE) {
  const repos = Object.keys(metricsByRepo ?? {}).sort();
  if (repos.length < 3) {
    throw new Error("leave-one-repo-out scores require at least three repos");
  }
  const folds = [];
  let failed = false;
  let measured = 0;
  for (const heldOut of repos) {
    const rest = repos.filter(repo => repo !== heldOut);
    const metrics = {};
    for (const metric of LORO_METRICS) {
      const held = metricsByRepo[heldOut]?.[metric];
      const restMean = meanFinite(rest.map(repo => metricsByRepo[repo]?.[metric]));
      if (typeof held !== "number" || !Number.isFinite(held) || restMean === null || restMean === 0) {
        metrics[metric] = { status: "UNMEASURED", held: held ?? null, restMean };
        continue;
      }
      const drop = (restMean - held) / restMean;
      const pass = drop <= gate;
      if (!pass) failed = true;
      measured += 1;
      metrics[metric] = { status: "MEASURED", held, restMean, drop, gate, pass };
    }
    folds.push({
      heldOut,
      train: rest,
      retune: false,
      taskSuccess: "UNMEASURED",
      metrics
    });
  }
  return {
    schemaVersion: "g2-loro-scores/v1",
    gate,
    measuredMetricCells: measured,
    failed,
    decision: measured === 0 ? "UNMEASURED" : failed ? "G2_OVERFIT_FAIL" : "GO",
    folds
  };
}

export function leaveOneRepoOutManifest(goldenDir = path.join(root, "golden")) {
  const repos = goldenReposFrom(goldenDir);
  return {
    schemaVersion: LEAVE_ONE_REPO_OUT_SCHEMA,
    frozenRepos: FROZEN_GOLDEN_REPOS,
    discoveredRepos: repos,
    folds: leaveOneRepoOutFolds(FROZEN_GOLDEN_REPOS),
    fourthRepo: fourthRepoStatus(FOURTH_EVAL_REPO),
    dropGate: LORO_DROP_GATE,
    note: "Folds are a scoring partition. They do not change first-plan ranking. TaskSuccess stays UNMEASURED without a live trace."
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(leaveOneRepoOutManifest(), null, 2));
}

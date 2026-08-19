#!/usr/bin/env node
// input: Frozen golden/*.scenarios.jsonl repo ids.
// output: Leave-one-repo-out folds. Matrix cells stay UNMEASURED until a real run.
// pos: V5R Phase 7 offline protocol. Does not retune ranking or invent TaskSuccess.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const LEAVE_ONE_REPO_OUT_SCHEMA = "v5r-leave-one-repo-out/v1";
export const FROZEN_GOLDEN_REPOS = Object.freeze(["cipherlink", "exam-parent-v3", "lishuedu"]);

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

export function leaveOneRepoOutManifest(goldenDir = path.join(root, "golden")) {
  const repos = goldenReposFrom(goldenDir);
  return {
    schemaVersion: LEAVE_ONE_REPO_OUT_SCHEMA,
    frozenRepos: FROZEN_GOLDEN_REPOS,
    discoveredRepos: repos,
    folds: leaveOneRepoOutFolds(FROZEN_GOLDEN_REPOS),
    fourthRepo: fourthRepoStatus(),
    note: "Folds are a scoring partition. They do not change first-plan ranking. TaskSuccess stays UNMEASURED without a live trace."
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(leaveOneRepoOutManifest(), null, 2));
}

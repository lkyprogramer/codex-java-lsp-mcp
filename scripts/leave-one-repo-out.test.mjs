import assert from "node:assert/strict";
import test from "node:test";
import {
  FROZEN_GOLDEN_REPOS,
  fourthRepoStatus,
  leaveOneRepoOutFolds,
  leaveOneRepoOutManifest
} from "./leave-one-repo-out.mjs";

test("leave-one-repo-out yields three folds and never invents TaskSuccess", () => {
  const folds = leaveOneRepoOutFolds();
  assert.equal(folds.length, 3);
  assert.deepEqual(folds.map(fold => fold.heldOut).sort(), [...FROZEN_GOLDEN_REPOS].sort());
  for (const fold of folds) {
    assert.equal(fold.train.includes(fold.heldOut), false);
    assert.equal(fold.train.length, 2);
    assert.equal(fold.matrix, "UNMEASURED");
    assert.equal(fold.taskSuccess, "UNMEASURED");
    assert.equal(fold.retune, false);
    assert.equal(fold.taskSuccess === 0, false);
  }
});

test("fourth evaluation golden stays UNMEASURED; fixture jsonl is not a fourth repo", () => {
  const manifest = leaveOneRepoOutManifest();
  assert.ok(FROZEN_GOLDEN_REPOS.every(repo => manifest.discoveredRepos.includes(repo)));
  assert.equal(manifest.fourthRepo.status, "UNMEASURED");
  assert.equal(manifest.fourthRepo.frozen, false);
  assert.equal(fourthRepoStatus().status, "UNMEASURED");
  assert.equal(fourthRepoStatus("held-out-repo").frozen, true);
});

test("leave-one-repo-out does not special-case scenario ids", () => {
  const manifest = JSON.stringify(leaveOneRepoOutManifest());
  assert.equal(manifest.includes("exam-score-export"), false);
  assert.equal(manifest.includes("paper-task-claim"), false);
  assert.equal(manifest.includes("taskKeywords"), false);
});

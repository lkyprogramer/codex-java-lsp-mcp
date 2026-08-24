import assert from "node:assert/strict";
import test from "node:test";
import {
  FOURTH_EVAL_REPO,
  FROZEN_GOLDEN_REPOS,
  LORO_DROP_GATE,
  fourthRepoStatus,
  leaveOneRepoOutFolds,
  leaveOneRepoOutManifest,
  leaveOneRepoOutScores
} from "./leave-one-repo-out.mjs";

test("leave-one-repo-out yields four folds and never invents TaskSuccess", () => {
  const folds = leaveOneRepoOutFolds();
  assert.equal(folds.length, 4);
  assert.deepEqual(folds.map(fold => fold.heldOut).sort(), [...FROZEN_GOLDEN_REPOS].sort());
  assert.ok(FROZEN_GOLDEN_REPOS.includes(FOURTH_EVAL_REPO));
  for (const fold of folds) {
    assert.equal(fold.train.includes(fold.heldOut), false);
    assert.equal(fold.train.length, 3);
    assert.equal(fold.matrix, "UNMEASURED");
    assert.equal(fold.taskSuccess, "UNMEASURED");
    assert.equal(fold.retune, false);
    assert.equal(fold.taskSuccess === 0, false);
  }
});

test("fourth evaluation golden is the frozen ruoyi-vue-pro jsonl", () => {
  const manifest = leaveOneRepoOutManifest();
  assert.ok(FROZEN_GOLDEN_REPOS.every(repo => manifest.discoveredRepos.includes(repo)));
  assert.equal(manifest.fourthRepo.status, "FROZEN");
  assert.equal(manifest.fourthRepo.frozen, true);
  assert.deepEqual(manifest.fourthRepo.repos, [FOURTH_EVAL_REPO]);
  assert.equal(fourthRepoStatus().status, "UNMEASURED");
  assert.equal(fourthRepoStatus(FOURTH_EVAL_REPO).frozen, true);
});

test("leave-one-repo-out scores fail when a held-out repo drops more than 15%", () => {
  const go = leaveOneRepoOutScores({
    a: { recall: 0.9, pRead: 0.8, rReadMust: 0.7 },
    b: { recall: 0.91, pRead: 0.81, rReadMust: 0.71 },
    c: { recall: 0.89, pRead: 0.79, rReadMust: 0.69 }
  });
  assert.equal(go.decision, "GO");
  assert.equal(go.failed, false);
  assert.equal(go.gate, LORO_DROP_GATE);

  const fail = leaveOneRepoOutScores({
    a: { recall: 0.9, pRead: 0.8, rReadMust: 0.7 },
    b: { recall: 0.9, pRead: 0.8, rReadMust: 0.7 },
    c: { recall: 0.5, pRead: 0.8, rReadMust: 0.7 }
  });
  assert.equal(fail.decision, "G2_OVERFIT_FAIL");
  const heldC = fail.folds.find(fold => fold.heldOut === "c");
  assert.equal(heldC.metrics.recall.pass, false);
  assert.ok(heldC.metrics.recall.drop > LORO_DROP_GATE);
  assert.equal(heldC.taskSuccess, "UNMEASURED");
});

test("leave-one-repo-out scores stay UNMEASURED instead of inventing zeros", () => {
  const scored = leaveOneRepoOutScores({
    a: {},
    b: {},
    c: {}
  });
  assert.equal(scored.decision, "UNMEASURED");
  assert.equal(scored.measuredMetricCells, 0);
  const mixed = leaveOneRepoOutScores({
    a: { recall: 0.9, pRead: 0.8, rReadMust: 0.7 },
    b: { recall: 0.9, pRead: 0.8, rReadMust: 0.7 },
    c: {}
  });
  const heldC = mixed.folds.find(fold => fold.heldOut === "c");
  assert.equal(heldC.metrics.recall.status, "UNMEASURED");
  assert.equal(heldC.metrics.recall.held, null);
  assert.equal(JSON.stringify(mixed).includes("TaskSuccess"), false);
  for (const fold of mixed.folds) assert.equal(fold.taskSuccess, "UNMEASURED");
});

test("leave-one-repo-out does not special-case scenario ids", () => {
  const manifest = JSON.stringify(leaveOneRepoOutManifest());
  assert.equal(manifest.includes("exam-score-export"), false);
  assert.equal(manifest.includes("paper-task-claim"), false);
  assert.equal(manifest.includes("taskKeywords"), false);
});

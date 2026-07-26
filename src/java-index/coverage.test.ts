import assert from "node:assert/strict";
import test from "node:test";
import { CoverageTracker } from "./coverage.js";

const root = "src/main/java";

test("canAnswerNegative requires COMPLETE at the matching generation with zero failed/recovered files", () => {
  const tracker = new CoverageTracker();
  const generation = 1;

  tracker.begin(root, generation, 3);
  assert.equal(tracker.canAnswerNegative(root, generation), false); // BUILDING
  tracker.complete(root, generation);
  assert.equal(tracker.canAnswerNegative(root, generation), true);

  tracker.begin(root, generation + 1, 1);
  tracker.recovered(root, "src/main/java/demo/Broken.java", 2);
  tracker.complete(root, generation + 1);
  assert.equal(tracker.snapshot()[0]?.recoveredFiles, 1);
  assert.equal(tracker.canAnswerNegative(root, generation + 1), false);

  tracker.invalidate(root, generation + 2);
  assert.equal(tracker.canAnswerNegative(root, generation + 2), false);
});

test("an unknown root never answers negative", () => {
  const tracker = new CoverageTracker();
  assert.equal(tracker.canAnswerNegative("never/begun", 1), false);
});

test("a failed file also blocks negative answers, independent of recovered files", () => {
  const tracker = new CoverageTracker();
  tracker.begin(root, 1, 2);
  tracker.failed(root, "src/main/java/demo/Unreadable.java", new Error("EACCES"));
  tracker.complete(root, 1);
  assert.equal(tracker.canAnswerNegative(root, 1), false);
  assert.equal(tracker.snapshot()[0]?.failedFiles, 1);
});

test("a stale generation (query generation behind the root's own) never answers negative", () => {
  const tracker = new CoverageTracker();
  tracker.begin(root, 5, 1);
  tracker.complete(root, 5);
  assert.equal(tracker.canAnswerNegative(root, 4), false);
  assert.equal(tracker.canAnswerNegative(root, 6), false);
  assert.equal(tracker.canAnswerNegative(root, 5), true);
});

test("complete() advancing a root directly to a new generation without a preceding begin() keeps its counts", () => {
  // Models the "reliable incremental batch" path: a root that was already
  // COMPLETE, with a healthy watcher and every add/change/delete applied
  // successfully, advances straight to COMPLETE at the new generation - no
  // forced full re-sweep after every save.
  const tracker = new CoverageTracker();
  tracker.begin(root, 1, 2);
  tracker.indexed(root);
  tracker.indexed(root);
  tracker.complete(root, 1);
  assert.equal(tracker.canAnswerNegative(root, 1), true);

  tracker.complete(root, 2);
  assert.equal(tracker.canAnswerNegative(root, 2), true);
  assert.equal(tracker.snapshot()[0]?.indexedFiles, 2);
});

test("snapshot reflects multiple independently tracked roots", () => {
  const tracker = new CoverageTracker();
  tracker.begin("src/main/java", 1, 1);
  tracker.begin("module/src/test/java", 1, 1);
  tracker.complete("src/main/java", 1);

  const snapshot = tracker.snapshot();
  assert.equal(snapshot.length, 2);
  const main = snapshot.find(entry => entry.root === "src/main/java")!;
  const test_ = snapshot.find(entry => entry.root === "module/src/test/java")!;
  assert.equal(main.state, "COMPLETE");
  assert.equal(test_.state, "BUILDING");
});

import assert from "node:assert/strict";
import test from "node:test";
import { GenerationClock, isStormBatch, mergeChangeKind } from "./repo-generation.js";

test("generation advances monotonically and dirty clear is compare-and-set", () => {
  const clock = new GenerationClock();
  assert.deepEqual(clock.snapshot(), { value: 1, dirty: false });
  assert.equal(clock.rebaseAtLeast(41), 41);
  assert.equal(clock.rebaseAtLeast(3), 41);
  assert.equal(clock.advance("java change"), 42);
  assert.equal(clock.markDirty("watcher failure"), 43);
  assert.deepEqual(clock.snapshot(), { value: 43, dirty: true });
  clock.clearDirty(42);
  assert.equal(clock.snapshot().dirty, true);
  clock.clearDirty(43);
  assert.equal(clock.snapshot().dirty, false);
});

test("rebaseAtLeast rejects non-positive and non-integer values", () => {
  const clock = new GenerationClock();
  assert.throws(() => clock.rebaseAtLeast(0), /invalid generation rebase/);
  assert.throws(() => clock.rebaseAtLeast(-1), /invalid generation rebase/);
  assert.throws(() => clock.rebaseAtLeast(1.5), /invalid generation rebase/);
});

test("status reports the last reason and a timestamp", () => {
  const clock = new GenerationClock();
  clock.advance("java change");
  const status = clock.status();
  assert.equal(status.value, 2);
  assert.equal(status.lastReason, "java change");
  assert.equal(typeof status.lastChangedAt, "string");
});

test("change kinds merge within one debounce window", () => {
  for (const [oldKind, newKind, expected] of [
    ["JAVA_ADD", "JAVA_CHANGE", "JAVA_ADD"],
    ["JAVA_CHANGE", "JAVA_DELETE", "JAVA_DELETE"],
    ["JAVA_DELETE", "JAVA_ADD", "JAVA_CHANGE"]
  ] as const) {
    assert.equal(mergeChangeKind(oldKind, newKind), expected);
  }
  assert.equal(mergeChangeKind("JAVA_ADD", "JAVA_DELETE"), undefined);
});

test("isStormBatch flags an absolutely large batch or one large relative to the indexed repo", () => {
  assert.equal(isStormBatch(99, 5_000), false);
  assert.equal(isStormBatch(100, 5_000), true);
  assert.equal(isStormBatch(50, 400), true);
  assert.equal(isStormBatch(19, 100), false);
});

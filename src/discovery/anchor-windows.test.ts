import assert from "node:assert/strict";
import test from "node:test";
import { anchorWindows } from "./anchor-windows.js";

test("T03: a mid-method anchor keeps an anchor-centered window inside an extreme method", () => {
  const windows = anchorWindows(2, 421, [201]);
  assert.ok(windows.some(w => w.startLine <= 201 && 201 <= w.endLine), `line 201 must stay covered, got ${JSON.stringify(windows)}`);
  for (const window of windows) {
    assert.ok(window.startLine >= 2, "windows clamp to the method start");
    assert.ok(window.endLine <= 421, "windows clamp to the method end");
  }
});

test("T03: multiple anchors inside one extreme method all survive", () => {
  const windows = anchorWindows(2, 421, [100, 350]);
  for (const line of [100, 350]) {
    assert.ok(windows.some(w => w.startLine <= line && line <= w.endLine), `line ${line} must stay covered, got ${JSON.stringify(windows)}`);
  }
});

test("T03: overlapping anchor windows merge into one inclusive span", () => {
  const windows = anchorWindows(1, 100, [10, 20, 30]);
  assert.equal(windows.length, 1, "anchors within two radii of each other merge");
  assert.ok(windows[0]!.startLine <= 10 && 10 <= windows[0]!.endLine);
  assert.ok(windows[0]!.startLine <= 30 && 30 <= windows[0]!.endLine);
});

test("T03: adjacent windows merge and anchor order does not matter", () => {
  const forward = anchorWindows(1, 1000, [10, 27]);
  const backward = anchorWindows(1, 1000, [27, 10]);
  assert.deepEqual(forward, backward);
  assert.equal(forward.length, 1, "windows touching within the merge rule collapse");
});

test("T03: anchors at method bounds clamp instead of escaping the method", () => {
  const first = anchorWindows(5, 50, [5]);
  assert.ok(first[0]!.startLine === 5, "an anchor on the first line clamps to the method start");
  const last = anchorWindows(5, 50, [50]);
  assert.ok(last[0]!.endLine === 50, "an anchor on the last line clamps to the method end");
});

test("T03: invalid bounds, radius, and out-of-range anchors throw", () => {
  assert.throws(() => anchorWindows(0, 10, [5]), /invalid method bounds/);
  assert.throws(() => anchorWindows(10, 5, []), /invalid method bounds/);
  assert.throws(() => anchorWindows(1.5, 10, []), /invalid method bounds/);
  assert.throws(() => anchorWindows(1, 10, [5], -1), /invalid radius/);
  assert.throws(() => anchorWindows(1, 10, [5], 2.5), /invalid radius/);
  assert.throws(() => anchorWindows(1, 10, [11]), /anchor outside method/);
  assert.throws(() => anchorWindows(1, 10, [0]), /anchor outside method/);
});
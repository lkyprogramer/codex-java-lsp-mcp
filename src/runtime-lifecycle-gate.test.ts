import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RuntimeLifecycleGate } from "./runtime-lifecycle-gate.js";

test("RuntimeLifecycleGate allows concurrent queries", async () => {
  const gate = new RuntimeLifecycleGate();
  const first = deferred();
  const second = deferred();
  let entered = 0;
  const queryA = gate.withQuery(async () => { entered += 1; await first.promise; }, 1000);
  const queryB = gate.withQuery(async () => { entered += 1; await second.promise; }, 1000);

  await delay(10);
  assert.equal(entered, 2);
  assert.equal(gate.state().activeQueries, 2);
  first.resolve();
  second.resolve();
  await Promise.all([queryA, queryB]);
  assert.equal(gate.isIdle(), true);
});

test("RuntimeLifecycleGate drains earlier queries, blocks later queries, and serializes controls", async () => {
  const gate = new RuntimeLifecycleGate();
  const releaseQuery = deferred();
  const releaseFirstControl = deferred();
  const events: string[] = [];
  const query = gate.withQuery(async () => {
    events.push("query-enter");
    await releaseQuery.promise;
    events.push("query-exit");
  }, 1000);
  const firstControl = gate.withControl(async () => {
    events.push("control-1-enter");
    await releaseFirstControl.promise;
    events.push("control-1-exit");
  }, 1000);
  const secondControl = gate.withControl(async () => {
    events.push("control-2");
  }, 1000);
  const laterQuery = gate.withQuery(async () => {
    events.push("query-later");
  }, 1000);

  await delay(10);
  assert.deepEqual(events, ["query-enter"]);
  releaseQuery.resolve();
  await query;
  await delay(10);
  assert.deepEqual(events, ["query-enter", "query-exit", "control-1-enter"]);
  releaseFirstControl.resolve();
  await Promise.all([firstControl, secondControl, laterQuery]);
  assert.deepEqual(events, [
    "query-enter",
    "query-exit",
    "control-1-enter",
    "control-1-exit",
    "control-2",
    "query-later"
  ]);
});

test("RuntimeLifecycleGate control does not count itself as a query", async () => {
  const gate = new RuntimeLifecycleGate();
  await gate.withControl(async () => {
    assert.deepEqual(gate.state(), { activeQueries: 0, controlActive: true, pendingControls: 0 });
  }, 50);
  assert.equal(gate.isIdle(), true);
});

test("RuntimeLifecycleGate removes a timed-out control and admits queries again", async () => {
  const gate = new RuntimeLifecycleGate();
  const release = deferred();
  const query = gate.withQuery(async () => release.promise, 1000);
  await delay(5);
  await assert.rejects(() => gate.withControl(async () => undefined, 10), /runtime lifecycle draining 1 query/);

  let laterEntered = false;
  const later = gate.withQuery(async () => { laterEntered = true; }, 1000);
  await delay(10);
  assert.equal(laterEntered, true, "a timed-out control must no longer block new queries");
  release.resolve();
  await Promise.all([query, later]);
});

test("RuntimeLifecycleGate admits an older query between a continuous control burst", async () => {
  const gate = new RuntimeLifecycleGate();
  const releaseFirstControl = deferred();
  const events: string[] = [];
  const firstControl = gate.withControl(async () => {
    events.push("control-1-enter");
    await releaseFirstControl.promise;
    events.push("control-1-exit");
  }, 1000);
  await delay(5);

  const query = gate.withQuery(async () => {
    events.push("query");
  }, 1000);
  const laterControls = Array.from({ length: 10 }, (_, index) => gate.withControl(async () => {
    events.push(`control-${index + 2}`);
  }, 1000));

  releaseFirstControl.resolve();
  await Promise.all([firstControl, query, ...laterControls]);
  assert.deepEqual(events.slice(0, 3), ["control-1-enter", "control-1-exit", "query"]);
});

test("RuntimeLifecycleGate detached query lease drains before control and is rejected behind control", async () => {
  const gate = new RuntimeLifecycleGate();
  const releaseBackground = deferred();
  const events: string[] = [];
  const background = gate.tryRunQuery(async () => {
    events.push("background-enter");
    await releaseBackground.promise;
    events.push("background-exit");
  });
  assert.ok(background);
  const control = gate.withControl(async () => {
    events.push("control");
  }, 1000);
  assert.equal(gate.tryRunQuery(async () => undefined), undefined,
    "optional background work must not jump ahead of a pending control");

  await delay(5);
  assert.deepEqual(events, ["background-enter"]);
  releaseBackground.resolve();
  await Promise.all([background, control]);
  assert.deepEqual(events, ["background-enter", "background-exit", "control"]);
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

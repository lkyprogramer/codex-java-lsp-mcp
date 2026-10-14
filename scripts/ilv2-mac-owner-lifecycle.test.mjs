import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createOwnerFixture, eventually, processAlive, processGroup } from "./ilv2-mac-owner-fixture.mjs";
import { execute, writeJson } from "./ilv2-mac-contracts.mjs";

async function evidence(name, result) {
  if (process.env.ILV2_RUN_ROOT) await writeJson(path.join(process.env.ILV2_EVIDENCE_ROOT ?? path.join(process.env.ILV2_RUN_ROOT, "raw"), `${name}.json`), result);
}
async function busy(fixture) {
  return eventually(async () => {
    const stdout = await readFile(path.join(fixture.root, "stdout.log"), "utf8").catch(() => "");
    return stdout.includes('"code":"OWNER_BUSY"') ? stdout : false;
  }, 6500);
}

test("same-root-second-owner-is-rejected", { timeout: 22000 }, async t => {
  const one = await createOwnerFixture(t); const ready = await one.ready();
  const two = await createOwnerFixture(t, { cacheRoot: one.cacheRoot });
  const started = performance.now(); await busy(two);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 4500 && elapsed < 6500);
  assert.equal((await two.records()).length, 0, "busy launcher must not exec Node");
  assert.ok(processAlive(ready.pid));
  await evidence(t.name, { elapsedMs: elapsed, owner: ready, rejectedEntryExecutions: 0 });
  await two.close(); await one.close();
});

test("bounded-lock-wait-and-owner-busy-restart", { timeout: 24000 }, async t => {
  const one = await createOwnerFixture(t); const ready = await one.ready();
  const two = await createOwnerFixture(t, { cacheRoot: one.cacheRoot });
  await busy(two);
  assert.equal((await two.records()).length, 0);
  const releasedAt = performance.now(); await one.close();
  const admitted = await two.ready();
  assert.notEqual(admitted.pid, ready.pid);
  assert.ok(performance.now() - releasedAt < 10000);
  const printed = (await execute("/bin/launchctl", ["print", `gui/${process.getuid()}/${two.label}`])).stdout;
  await writeFile(path.join(two.root, "launchctl-print.log"), printed);
  assert.match(printed, /minimum runtime = 1/);
  await evidence(t.name, { owner: ready, admitted, releaseToReadyMs: performance.now() - releasedAt, print: printed });
  await two.close();
});

for (const name of ["crash-soon-after-start-honors-recovery-budget", "stable-sigkill-reaps-owned-group-and-preserves-lock-until-exit"]) {
  test(name, { timeout: 22000 }, async t => {
    const fixture = await createOwnerFixture(t, { child: true, depth: 2 });
    const ready = await fixture.ready();
    if (name !== "crash-soon-after-start-honors-recovery-budget") await delay(1100);
    const descendants = await eventually(async () => {
      const rows = (await fixture.records()).filter(row => row.type === "descendant"); return rows.length === 2 ? rows : false;
    });
    for (const child of descendants) assert.equal(child.pgid, ready.pgid);
    const faultAt = performance.now();
    process.kill(ready.pid, "SIGKILL");
    await eventually(() => !processAlive(ready.pid) && descendants.every(row => !processAlive(row.pid)), 10000);
    const oldExitedMs = performance.now() - faultAt;
    const restarted = await fixture.ready(ready.pid);
    assert.ok(performance.now() - faultAt < 10000);
    assert.notEqual(restarted.pgid, ready.pgid);
    await evidence(t.name, { contracts: ["launchd-restart-reaps-owned-group", "lock-survives-daemon-sigkill-until-descendants-exit"], owner: ready, descendants, restarted, oldExitedMs, recoveryMs: performance.now() - faultAt });
    await fixture.close();
  });
}

test("child-alive-after-parent-sigkill", { timeout: 22000 }, async t => {
  const fixture = await createOwnerFixture(t, { child: true, depth: 2 }); const ready = await fixture.ready();
  const descendants = await eventually(async () => {
    const rows = (await fixture.records()).filter(row => row.type === "descendant"); return rows.length === 2 ? rows : false;
  });
  const parent = descendants.find(row => row.depth === 2), child = descendants.find(row => row.depth === 1);
  process.kill(parent.pid, "SIGKILL");
  await eventually(() => !processAlive(parent.pid)); assert.ok(processAlive(child.pid));
  await fixture.command({ type: "close-lock" });
  await eventually(async () => (await fixture.records()).some(row => row.type === "lock-closed"));
  const other = await createOwnerFixture(t, { cacheRoot: fixture.cacheRoot });
  await busy(other); assert.equal((await other.records()).length, 0);
  await evidence(t.name, { ready, parent, child, childSurvivesParent: true, childHoldsLockAfterOwnerClosesFd: true });
  await other.close(); await fixture.close();
});

test("real-builder-parses-and-preserves-lock-and-pgid", { timeout: 22000 }, async t => {
  const fixture = await createOwnerFixture(t, { builder: true }); const ready = await fixture.ready();
  const row = await eventually(async () => (await fixture.records()).find(row => row.type === "builder-serving"));
  assert.equal(row.status.state, "idle"); assert.ok(row.status.pid > 0);
  assert.equal(await processGroup(row.status.pid), ready.pgid);
  await fixture.command({ type: "close-lock" });
  await eventually(async () => (await fixture.records()).some(item => item.type === "lock-closed"));
  const other = await createOwnerFixture(t, { cacheRoot: fixture.cacheRoot });
  await busy(other); assert.equal((await other.records()).length, 0);
  await evidence(t.name, { ready, builder: row, sharedPgid: true, parsedSyntheticJava: true, lockRetained: true });
  await other.close(); await fixture.close();
});

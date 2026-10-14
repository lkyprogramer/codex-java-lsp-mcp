import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createOwnerFixture, eventually, processAlive, processGroup } from "./ilv2-mac-owner-fixture.mjs";
import { writeJson } from "./ilv2-mac-contracts.mjs";

async function busy(fixture) {
  return eventually(async () => (await readFile(path.join(fixture.root, "stdout.log"), "utf8").catch(() => "")).includes('"code":"OWNER_BUSY"'), 6500);
}
async function evidence(name, result) {
  await writeJson(path.join(process.env.ILV2_RUN_ROOT, "raw", `${name}.json`), { ...result, launchd: "NOT_RUN" });
}
test("native-bounded-lock-wait-does-not-exec-second-owner", { timeout: 22000 }, async t => {
  const one = await createOwnerFixture(t, { route: "direct" }); const ready = await one.ready();
  const two = await createOwnerFixture(t, { route: "direct", cacheRoot: one.cacheRoot });
  const started = performance.now(); await busy(two); const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs >= 4500 && elapsedMs < 6500); assert.equal((await two.records()).length, 0);
  assert.ok(processAlive(ready.pid));
  await evidence(t.name, { elapsedMs, ready, rejectedEntryExecutions: 0 });
  await two.close(); await one.close();
  const three = await createOwnerFixture(t, { route: "direct", cacheRoot: one.cacheRoot });
  assert.ok((await three.ready()).pid !== ready.pid); await three.close();
});
test("native-child-survives-parent-and-retains-same-ofd", { timeout: 22000 }, async t => {
  const one = await createOwnerFixture(t, { route: "direct", child: true, depth: 2 }); const ready = await one.ready();
  const rows = await eventually(async () => { const rows = (await one.records()).filter(row => row.type === "descendant"); return rows.length === 2 ? rows : false; });
  for (const row of rows) assert.equal(row.pgid, ready.pgid);
  const parent = rows.find(row => row.depth === 2), child = rows.find(row => row.depth === 1);
  process.kill(parent.pid, "SIGKILL"); await eventually(() => !processAlive(parent.pid)); assert.ok(processAlive(child.pid));
  await one.command({ type: "close-lock" }); await eventually(async () => (await one.records()).some(row => row.type === "lock-closed"));
  const two = await createOwnerFixture(t, { route: "direct", cacheRoot: one.cacheRoot });
  await busy(two); assert.equal((await two.records()).length, 0);
  await evidence(t.name, { ready, parent, child, inheritedOFD: true }); await two.close(); await one.close();
});
test("native-real-builder-parses-with-inherited-lock", { timeout: 24000 }, async t => {
  const one = await createOwnerFixture(t, { route: "direct", builder: true }); const ready = await one.ready();
  const builder = await eventually(async () => (await one.records()).find(row => row.type === "builder-serving"));
  assert.equal(builder.status.state, "idle"); assert.equal(await processGroup(builder.status.pid), ready.pgid);
  await one.command({ type: "close-lock" }); await eventually(async () => (await one.records()).some(row => row.type === "lock-closed"));
  const two = await createOwnerFixture(t, { route: "direct", cacheRoot: one.cacheRoot });
  await busy(two); assert.equal((await two.records()).length, 0);
  await evidence(t.name, { ready, builder, parsedSyntheticJava: true, inheritedLock: true }); await two.close(); await one.close();
});
test("native-owner-rejects-closed-fd-and-erased-child-binding", { timeout: 15000 }, async t => {
  const fixture = await createOwnerFixture(t, { route: "direct" }); await fixture.ready();
  await fixture.command({ type: "check-child-binding" });
  const binding = await eventually(async () => (await fixture.records()).find(row => row.type === "child-binding-rejected"));
  assert.match(binding.error, /preserve the owner binding/);
  await fixture.command({ type: "close-lock" });
  await eventually(async () => (await fixture.records()).some(row => row.type === "lock-closed"));
  await fixture.command({ type: "check-lock" });
  const invalid = await eventually(async () => (await fixture.records()).find(row => row.type === "lock-invalid"));
  assert.ok(invalid.code); await evidence(t.name, { invalid, binding, didNotReopenLock: true }); await fixture.close();
});
test("native-calls-preserve-owned-lock-and-pgid", { timeout: 15000 }, async t => {
  const fixture = await createOwnerFixture(t, { route: "direct" }); const ready = await fixture.ready();
  await fixture.command({ type: "check-native-call" });
  const call = await eventually(async () => (await fixture.records()).find(row => row.type === "native-call"));
  assert.equal(call.ok, true, call.error);
  assert.equal(call.result.kind, "owner-lock"); assert.equal(call.result.fd, 4);
  assert.equal(call.result.pgid, ready.pgid);
  await evidence(t.name, { ready, call, realNativeExecutor: true }); await fixture.close();
});

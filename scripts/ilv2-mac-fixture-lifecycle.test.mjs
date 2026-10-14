import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { acquireFixtureSlot, inspectFixtureSlots } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT } from "./ilv2-mac-contracts.mjs";

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}
async function gone(pid) {
  const limit = performance.now() + 2000;
  while (performance.now() < limit) {
    if (!alive(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`owned process ${pid} did not exit`);
}
async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function reapSharedReservation() {
  const lease = await acquireFixtureSlot(MAC_WORK_ROOT); await lease.release();
}
for (const phase of ["uncommitted-quota", "before-registration", "uncommitted-registration", "before-start", "running"]) {
  test(`controller SIGKILL at ${phase} cannot leave a serving unregistered child`, { timeout: 10000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ilv2-launch-window-test-"));
    const port = await freePort();
    const holder = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/ilv2-mac/quota-holder.mjs", import.meta.url)), root, phase, String(port)], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    holder.stderr.resume();
    const closed = new Promise(resolve => holder.once("close", resolve));
    let marker;
    t.after(async () => {
      if (holder.exitCode === null && holder.signalCode === null) { holder.kill("SIGKILL"); await closed; }
      if (marker?.launcherPid && alive(-marker.launcherPid)) { process.kill(-marker.launcherPid, "SIGKILL"); await gone(-marker.launcherPid); }
      await reapSharedReservation();
      await rm(root, { recursive: true, force: true });
    });
    marker = await new Promise((resolve, reject) => { holder.once("message", resolve); holder.once("close", () => reject(new Error("controller exited before fault window"))); });
    assert.equal(marker.phase, phase);
    if (phase === "running") {
      const limit = performance.now() + 2000;
      let identity;
      while (performance.now() < limit) {
        try { identity = await (await fetch(`http://127.0.0.1:${port}/identity`, { signal: AbortSignal.timeout(200) })).json(); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
      assert.equal(identity.pid, marker.servicePid);
    }
    holder.kill("SIGKILL"); await closed;
    if (marker.launcherPid) { await gone(marker.launcherPid); await gone(-marker.launcherPid); }
    if (marker.servicePid) await gone(marker.servicePid);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/identity`, { signal: AbortSignal.timeout(200) }));
    // A killed transaction rolls back; dead reservations can then be reused.
    const one = await acquireFixtureSlot(root); const two = await acquireFixtureSlot(root);
    assert.equal(inspectFixtureSlots(root).length, 2);
    await assert.rejects(acquireFixtureSlot(root, { timeoutMs: 100 }), /timed out/);
    await one.release(); await two.release();
    assert.equal(inspectFixtureSlots(root).length, 0);
  });
}
for (const action of ["controller SIGKILL", "service exit"]) {
  test(`${action} reaps a live same-group descendant`, { timeout: 10000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ilv2-descendant-window-test-"));
    const port = await freePort();
    const holder = spawn(process.execPath, [fileURLToPath(new URL("../fixtures/ilv2-mac/quota-holder.mjs", import.meta.url)), root, "running", String(port), "descendant"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    holder.stderr.resume();
    const closed = new Promise(resolve => holder.once("close", resolve));
    const marker = await new Promise((resolve, reject) => { holder.once("message", resolve); holder.once("close", () => reject(new Error("controller exited before child started"))); });
    t.after(async () => {
      if (holder.exitCode === null && holder.signalCode === null) { holder.kill("SIGKILL"); await closed; }
      if (alive(-marker.launcherPid)) { process.kill(-marker.launcherPid, "SIGKILL"); await gone(-marker.launcherPid); }
      await reapSharedReservation();
      await rm(root, { recursive: true, force: true });
    });
    let identity;
    const limit = performance.now() + 2000;
    while (performance.now() < limit) {
      try { identity = await (await fetch(`http://127.0.0.1:${port}/identity`, { signal: AbortSignal.timeout(200) })).json(); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    assert.equal(identity.pid, marker.servicePid);
    assert.equal(alive(identity.descendantPid), true);
    if (action === "controller SIGKILL") { holder.kill("SIGKILL"); await closed; }
    else await fetch(`http://127.0.0.1:${port}/exit`, { signal: AbortSignal.timeout(200) });
    await gone(identity.descendantPid); await gone(-marker.launcherPid);
    if (holder.exitCode === null && holder.signalCode === null) { holder.kill("SIGKILL"); await closed; }
    const reclaimed = await acquireFixtureSlot(root); await reclaimed.release();
    assert.equal(inspectFixtureSlots(root).length, 0);
  });
}

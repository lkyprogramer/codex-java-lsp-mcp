import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { CONTRACT_VERSION, MAC_WORK_ROOT } from "./ilv2-mac-contracts.mjs";
import { connectDriver } from "./ilv2-mac-driver.mjs";
import { replay } from "./ilv2-mac-burst-replay.mjs";
import { runFaultCase } from "./ilv2-mac-fault-matrix.mjs";
import { acquireFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";

async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function fixture(t, behavior = "correct") {
  const root = await mkdtemp(path.join(os.tmpdir(), "ilv2-driver-test-"));
  let driver;
  t.after(async () => { await driver?.stop(); await rm(root, { recursive: true, force: true }); });
  const config = {
    contractVersion: CONTRACT_VERSION, protocol: "http-json/v1", startTimeoutMs: 2000,
    argv: [process.execPath, fileURLToPath(new URL("../fixtures/ilv2-mac/fake-driver.mjs", import.meta.url)), "{port}", behavior],
    expected: { sourceDigest: "fixture-source", buildDigest: "fixture-build", nativeDigest: "NOT_BUILT", runtimeManifestSha256: "fixture-runtime" },
    operations: Object.fromEntries(["identity", "status", "query", "prewarm", "barrier-arm", "barrier-wait", "barrier-release"].map(operation => [operation, {
      method: "POST", path: `/${operation}`, body: { start: "{start}", phase: "{phase}" }, readOnlyField: "start", normalize: { ...Object.fromEntries([
        "instanceId", "sourceDigest", "buildDigest", "nativeDigest", "runtimeManifestSha256", "cacheRoot", "ownerRoot", "contractVersion", "pid",
        "status", "workspaceId", "sourceHash", "snapshotId", "token", "queryCount", "prewarmCount", "start", "phase", "blocked"
      ].map(key => [key, key])) }
    }]))
  };
  const options = { mode: "start", runtime: { runtimeManifestSha256: "fixture-runtime" }, runtimeManifest: "/fixture/runtime.json",
    runRoot: root, workRoot: MAC_WORK_ROOT, serviceWork: path.join(root, "service"), port: await port() };
  driver = await connectDriver(config, options);
  return { root, config, options, driver };
}
function queryPlan() {
  return { contractVersion: CONTRACT_VERSION, concurrency: 1, slots: [{ id: "s1", operation: "query", window: "normal", workspaceId: "fixture-w1",
    atMs: 0, deadlineMs: 100, stopAfterMs: 200, pollMs: 100,
    expected: { workspaceId: "fixture-w1", sourceHash: "fixture-source-hash", match: { token: "fresh-token" } }
  }], slos: [{ id: "first", metric: "firstCorrectMs", window: "normal", percentile: 0.95, minSamples: 1, limitMs: 200 }] };
}
test("start measures first-correct and stops only its owned instance", async t => {
  const { root, driver } = await fixture(t);
  const out = path.join(root, "replay"); await mkdir(out);
  assert.equal((await replay(queryPlan(), driver, { out, runRoot: root })).status, "PASS");
  await driver.stop();
  assert.throws(() => process.kill(driver.ownedPid, 0), { code: "ESRCH" });
});
for (const behavior of ["wrong-hash", "wrong-workspace", "hang"]) test(`${behavior} preserves a failed first-correct slot`, async t => {
  const { root, driver } = await fixture(t, behavior);
  const out = path.join(root, "replay"); await mkdir(out);
  const result = await replay(queryPlan(), driver, { out, runRoot: root });
  assert.equal(result.status, "FAIL");
  assert.equal(result.metrics[0].n, 0);
  assert.equal(result.expectedSlots, 1);
});
test("attach checks the complete identity and never stops the attached service", async t => {
  const { driver, config, options, root } = await fixture(t);
  const attachOptions = { ...options, mode: "attach", url: `http://127.0.0.1:${options.port}`, expectedInstance: driver.identity.instanceId, expectedSource: "fixture-source" };
  const attached = await connectDriver({ ...config, expected: driver.identity }, attachOptions);
  await attached.stop();
  assert.doesNotThrow(() => process.kill(driver.ownedPid, 0));
  assert.equal((await attached.request("status", { start: false })).value.start, false);
  await assert.rejects(connectDriver({ ...config, expected: driver.identity }, { ...attachOptions, expectedInstance: "wrong" }), /instance identity/);
  await assert.rejects(connectDriver({ ...config, expected: { ...driver.identity, nativeDigest: "wrong" } }, attachOptions), /nativeDigest/);
  await assert.rejects(connectDriver({ ...config, expected: { ...driver.identity, cacheRoot: path.join(os.userInfo().homedir, "Library/Caches/codex-java-lsp") } }, attachOptions), /path/);
  assert.equal((await readFile(path.join(root, "service/requests.jsonl"), "utf8")).includes("prewarm"), false);
});
test("production port is rejected before any attach request", async t => {
  const { config, options, driver } = await fixture(t);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("fetch must not run"); };
  try {
    await assert.rejects(connectDriver({ ...config, expected: driver.identity }, { ...options, mode: "attach", url: "http://127.0.0.1:38456", expectedInstance: driver.identity.instanceId, expectedSource: "fixture-source" }), /production port/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});
test("occupied start port does not attach or stop another instance", async t => {
  const { driver, config, options } = await fixture(t);
  await assert.rejects(connectDriver(config, { ...options, serviceWork: `${options.serviceWork}-other` }), /occupied/);
  assert.doesNotThrow(() => process.kill(driver.ownedPid, 0));
});
test("a per-run quota root or host source script cannot start a fixture", async t => {
  const { config, options, root } = await fixture(t);
  await assert.rejects(connectDriver(config, { ...options, workRoot: root, serviceWork: `${options.serviceWork}-other`, port: await port() }), /shared work root/);
  await assert.rejects(connectDriver({ ...config, argv: [process.execPath, "/outside-managed-root/fixture.mjs"] }, { ...options, serviceWork: `${options.serviceWork}-outside`, port: await port() }), /outside managed/);
});
test("status-only replay sends start=false and neither query nor prewarm", async t => {
  const { driver, root } = await fixture(t);
  const plan = queryPlan();
  plan.slots[0] = { ...plan.slots[0], operation: "status", pollMs: undefined };
  plan.slos[0].metric = "elapsedMs";
  const out = path.join(root, "status"); await mkdir(out);
  assert.equal((await replay(plan, driver, { out, runRoot: root })).status, "PASS");
  const status = (await driver.request("status", { start: false })).value;
  assert.equal(status.queryCount, 0); assert.equal(status.prewarmCount, 0); assert.equal(status.start, false);
});
test("external controller kills a real process held at a phase barrier", async t => {
  const { driver } = await fixture(t);
  const result = await runFaultCase(driver, { id: "seal-kill", phase: "before-seal", action: "SIGKILL", timeoutMs: 2000, assertions: [{ field: "exited", equals: true }] });
  assert.equal(result.status, "PASS");
  assert.equal(result.ack.blocked, true);
  assert.throws(() => process.kill(driver.ownedPid, 0), { code: "ESRCH" });
});
test("a missing phase acknowledgement cannot be treated as injected", async () => {
  let stopped = false;
  await assert.rejects(runFaultCase({ ownedPid: process.pid, ownedPgid: process.pid, request: async () => ({ value: { phase: "other", blocked: false } }), stop: async () => { stopped = true; } },
    { id: "bad", phase: "seal", action: "SIGKILL", timeoutMs: 60, assertions: [{ field: "exited", equals: true }] }), /not acknowledged/);
  assert.equal(stopped, false);
});
test("third fixture waits and cancellation releases the quota", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ilv2-quota-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const one = await acquireFixtureSlot(root); const two = await acquireFixtureSlot(root);
  let acquired = false;
  const pending = acquireFixtureSlot(root).then(value => { acquired = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(acquired, false);
  await one.release(); const three = await pending;
  const controller = new AbortController();
  const cancelled = acquireFixtureSlot(root, { signal: controller.signal });
  controller.abort(); await assert.rejects(cancelled, /abort/i);
  await two.release(); await three.release();
  const next = await acquireFixtureSlot(root); await next.release();
});
test("separate runner processes share the quota and a dead holder is reclaimed", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ilv2-quota-process-test-"));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async child => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await child.closed; } }));
    await rm(root, { recursive: true, force: true });
  });
  const module = new URL("./ilv2-mac-fixture-quota.mjs", import.meta.url).href;
  const code = `import {acquireFixtureSlot} from ${JSON.stringify(module)}; process.send('started'); const lease=await acquireFixtureSlot(process.argv[1]); process.send('acquired'); process.on('message',async()=>{await lease.release();process.exit(0)});`;
  function start() {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.closed = new Promise(resolve => child.once("close", resolve));
    child.acquired = false;
    child.startedPromise = new Promise(resolve => child.on("message", value => { if (value === "started") resolve(); }));
    child.acquiredPromise = new Promise(resolve => child.on("message", value => { if (value === "acquired") { child.acquired = true; resolve(); } }));
    children.push(child); return child;
  }
  const one = start(); const two = start();
  await Promise.all([one.acquiredPromise, two.acquiredPromise]);
  const three = start(); await three.startedPromise;
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(three.acquired, false);
  one.kill("SIGKILL"); await one.closed;
  await three.acquiredPromise;
  two.send("release"); three.send("release");
  await Promise.all([two.closed, three.closed]);
  const next = await acquireFixtureSlot(root); await next.release();
});

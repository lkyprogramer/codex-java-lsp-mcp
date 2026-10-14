import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, realpath, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { acquireFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT, verifyRuntime, execute, writeJson } from "./ilv2-mac-contracts.mjs";
import { eventually, processAlive } from "./ilv2-mac-owner-fixture.mjs";
import { ownerLaunchArguments } from "../dist/mac-platform/owner-lock.js";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("real-fsevents-ready-fence-root-restart-and-owner-inheritance", { timeout: 65000 }, async () => {
  await verifyRuntime();
  assert.ok(process.env.ILV2_RUN_ROOT, "registered run root required");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-fsevents-")));
  const cache = path.join(root, "cache"); const watched = path.join(root, "watched");
  for (const name of ["cache", "watched", "home", "tmp"]) await mkdir(path.join(root, name));
  const probeEntry = path.join(root, "probe.mjs"); await writeFile(probeEntry, 'process.stdout.write("admitted\\n");\n');
  const launch = await ownerLaunchArguments(cache, path.join(sourceRoot, "scripts/ilv2-mac-fsevents-entry.mjs"), [watched]);
  const lease = await acquireFixtureSlot(MAC_WORK_ROOT);
  const env = { ...process.env, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp") };
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_REPL_HISTORY", "NODE_V8_COVERAGE", "NODE_COMPILE_CACHE", "NODE_REDIRECT_WARNINGS", "NODE_TEST_CONTEXT"]) delete env[key];
  const child = spawn(launch.binary, launch.args, { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", requestId = 0, failure, first, second, rootChanged, busy, afterStop;
  const pending = new Map();
  const closed = new Promise((resolve, reject) => { child.once("close", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
  void closed.catch(() => {});
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  createInterface({ input: child.stdout }).on("line", line => {
    try { const row = JSON.parse(line); const waiting = pending.get(row.id); if (waiting) { clearTimeout(waiting.timer); pending.delete(row.id); row.error ? waiting.reject(new Error(row.error)) : waiting.resolve(row.result); } }
    catch (error) { for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); } pending.clear(); }
  });
  const command = op => new Promise((resolve, reject) => {
    const id = ++requestId; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`fixture ${op} timeout`)); }, 12000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, op }) + "\n");
  });
  try {
    await lease.registerChild(child.pid, child.pid);
    first = await command("start");
    assert.equal(first.volumeIdentity, (await stat(watched, { bigint: true })).dev.toString());
    assert.equal(first.pgid, child.pid); assert.equal(first.fd, 4); assert.notEqual(first.pid, child.pid);
    await writeFile(path.join(watched, "after-ready.java"), "class AfterReady {}\n");
    const mutation = await eventually(async () => {
      const row = await command("fence");
      const prefix = row.events.filter(event => event.epoch === row.fence.epoch && BigInt(event.seq) < BigInt(row.fence.seq));
      return prefix.some(event => event.path.endsWith("after-ready.java")) ? { ...row, prefix } : false;
    }, 10000);
    assert.ok(mutation.prefix.some(row => row.path.endsWith("after-ready.java")));
    assert.ok(mutation.events.every(row => row.volumeIdentity === first.volumeIdentity));
    await rename(watched, path.join(root, "renamed"));
    rootChanged = await eventually(async () => { const row = await command("fence"); return row.events.some(event => (event.flags & 32) !== 0) ? row : false; }, 10000);
    await command("stop"); await mkdir(watched);
    second = await command("start"); assert.equal(second.volumeIdentity, (await stat(watched, { bigint: true })).dev.toString()); assert.notEqual(second.epoch, first.epoch); assert.equal(second.seq, "1");
    await writeFile(path.join(watched, "rebuilt.java"), "class Rebuilt {}\n");
    await eventually(async () => { const row = await command("fence"); return row.events.some(event => event.epoch === second.epoch && BigInt(event.seq) < BigInt(row.fence.seq) && event.path.endsWith("rebuilt.java")); }, 10000);
    await command("close-parent-fd");
    const probe = await ownerLaunchArguments(cache, probeEntry);
    try { await execute(probe.binary, probe.args, { env, timeout: 7000 }); assert.fail("helper must keep the OFD lock"); }
    catch (error) { assert.match(error.stdout ?? "", /OWNER_BUSY/); busy = { stdout: error.stdout, code: error.code }; }
    assert.ok(processAlive(second.pid));
    await command("stop"); await eventually(() => !processAlive(second.pid), 5000);
    afterStop = await execute(probe.binary, probe.args, { env, timeout: 5000 }); assert.equal(afterStop.stdout, "admitted\n");
    await command("exit"); child.stdin.end(); const result = await closed; assert.equal(result.code, 0);
  } catch (error) { failure = error; throw error; }
  finally {
    // Kill only the detached fixture's owned process group. Release the quota
    // only after ESRCH proves every inherited native reference has exited.
    let closeoutError;
    try {
      if (child.pid && processAlive(child.pid)) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
      // Spawn error has no process; its close event still settles pipes.
      await closed.catch(error => { if (child.pid) throw error; });
      if (child.pid) await eventually(() => !processAlive(child.pid) && !processAlive(-child.pid), 5000);
      await lease.release();
    }
    catch (error) { closeoutError = error; }
    await writeJson(path.join(process.env.ILV2_EVIDENCE_ROOT ?? path.join(process.env.ILV2_RUN_ROOT, "raw"), "fsevents-native-acceptance.json"), {
      route: "G01-direct-owned-fixture", launchd: "NOT_RUN", first, second, rootChanged, busy, afterStop,
      actualOsDrop: "NOT_INDUCED", fakeDropTests: "PROTOCOL_ONLY", stdout, stderr, failure: failure && String(failure), closeoutError: closeoutError && String(closeoutError), quotaReleased: !closeoutError
    });
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("fixture closed")); } pending.clear();
    if (closeoutError) throw closeoutError;
  }
});

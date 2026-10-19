import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { acquireFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";
import { MAC_WORK_ROOT, execute, verifyRuntime, writeJson } from "./ilv2-mac-contracts.mjs";
import { eventually, processAlive } from "./ilv2-mac-owner-fixture.mjs";
import { ownerLaunchArguments } from "../dist/mac-platform/owner-lock.js";

// MAC-03B: the tracker on the real native FSEvents helper, under the owner launcher (not launchd).
// Real OS events drive every step; drops are not induced here (protocol-level in workspace-tracker.test).
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(sourceRoot, "fixtures", "java-index-v2");
const serviceRel = "src/main/java/demospring/OrderService.java";

test("real-fsevents-drive-tracker-rounds-noop-restart-and-root-replacement", { timeout: 120000 }, async () => {
  await verifyRuntime();
  assert.ok(process.env.ILV2_RUN_ROOT, "registered run root required");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-tracker-")));
  const cache = path.join(root, "cache"); const repo = path.join(root, "repo");
  for (const name of ["cache", "home", "tmp"]) await mkdir(path.join(root, name));
  await cp(fixture, repo, { recursive: true });
  const launch = await ownerLaunchArguments(cache, path.join(sourceRoot, "scripts/ilv2-mac-tracker-entry.mjs"), [repo, cache]);
  const lease = await acquireFixtureSlot(MAC_WORK_ROOT);
  // The helper's resume test hook (SIGUSR1 replays its IOKit wake path); the service never sets it.
  const env = { ...process.env, HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), ILV2_NATIVE_TEST_HOOKS: "1" };
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_REPL_HISTORY", "NODE_V8_COVERAGE", "NODE_COMPILE_CACHE", "NODE_REDIRECT_WARNINGS", "NODE_TEST_CONTEXT"]) delete env[key];
  const child = spawn(launch.binary, launch.args, { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", requestId = 0, failure;
  const steps = {};
  const pending = new Map();
  const closed = new Promise((resolve, reject) => { child.once("close", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
  void closed.catch(() => {});
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  createInterface({ input: child.stdout }).on("line", line => {
    try { const row = JSON.parse(line); const waiting = pending.get(row.id); if (waiting) { clearTimeout(waiting.timer); pending.delete(row.id); row.error ? waiting.reject(new Error(row.error)) : waiting.resolve(row.result); } }
    catch (error) { for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); } pending.clear(); }
  });
  const command = op => new Promise((resolve, reject) => {
    const id = ++requestId; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`fixture ${op} timeout`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, op }) + "\n");
  });
  // Late events of the same edit may land after a fence: the round stays STALE and the next one confirms.
  // Bounded: a quiet tree must reach FRESH within 4 rounds, and every follow-up round must be a noop.
  const settle = async () => {
    const rounds = [await command("cycle")];
    while (rounds.at(-1).status !== "FRESH") {
      assert.ok(rounds.length < 4, `no FRESH within 4 rounds: ${JSON.stringify(rounds)}`);
      rounds.push(await command("cycle"));
    }
    for (const later of rounds.slice(1)) assert.equal(later.noop, true, "follow-up rounds confirm, they do not rebuild");
    return { ...rounds[0], status: rounds.at(-1).status, rounds: rounds.length, followUps: rounds.slice(1) };
  };
  const observed = want => eventually(async () => { const row = await command("status"); return row.status === want ? row : false; }, 10000);
  try {
    await lease.registerChild(child.pid, child.pid);
    steps.start = await command("start");
    assert.equal(steps.start.status, "STALE", "startup is never FRESH before the full hash");
    steps.initial = await settle();
    assert.deepEqual([steps.initial.mode, steps.initial.hashed, steps.initial.status, steps.initial.agree], ["full-hash", 29, "FRESH", true]);

    // Same size and whole-second mtime: only the real event (and ctime) can reveal it.
    const service = path.join(repo, serviceRel);
    const second = Math.floor(Date.now() / 1000) - 60;
    await utimes(service, second, second);
    steps.settled = await settle(); // the utimes itself is a real event; nothing changed in content
    const before = await lstat(service);
    await writeFile(service, (await readFile(service, "utf8")).replace("class OrderService", "class OrderServicf"));
    await utimes(service, second, second);
    const after = await lstat(service);
    assert.deepEqual([after.size, after.mtimeMs], [before.size, before.mtimeMs]);
    steps.sameStatSeen = await observed("STALE");
    steps.sameStat = await settle();
    assert.deepEqual([steps.sameStat.mode, steps.sameStat.changed, steps.sameStat.status, steps.sameStat.agree], ["paths", [serviceRel], "FRESH", true]);

    await utimes(service, new Date(), new Date(Date.now() + 3000));
    steps.touchSeen = await observed("STALE");
    steps.touch = await settle();
    assert.deepEqual([steps.touch.noop, steps.touch.snapshotId, steps.touch.status], [true, steps.sameStat.snapshotId, "FRESH"]);

    await rename(path.join(repo, "src/main/java/demojpa"), path.join(repo, "src/main/java/demojpa2"));
    steps.renameSeen = await observed("STALE");
    steps.rename = await settle();
    assert.equal(steps.rename.mode, "paths");
    assert.deepEqual([steps.rename.changed.length, steps.rename.deleted.length, steps.rename.status, steps.rename.agree], [3, 3, "FRESH", true]);

    steps.restart = await command("restart");
    assert.notEqual(steps.restart.epoch, steps.start.epoch);
    assert.equal(steps.restart.status, "STALE");
    steps.afterRestart = await settle();
    assert.deepEqual([steps.afterRestart.mode, steps.afterRestart.hashed, steps.afterRestart.noop, steps.afterRestart.coveredThroughSeq, steps.afterRestart.status],
      ["full-hash", 29, true, steps.afterRestart.cut, "FRESH"]);

    // MAC-09: a wake from the native helper owes a full hash; the workspace is STALE until it confirms.
    const helpers = (await execute("/usr/bin/pgrep", ["-P", String(child.pid)])).stdout.trim().split("\n").filter(Boolean).map(Number);
    assert.equal(helpers.length, 1, "one native watch helper");
    steps.resumeBefore = await command("status");
    process.kill(helpers[0], "SIGUSR1");
    steps.resumeSeen = await observed("STALE");
    assert.equal(steps.resumeSeen.diagnostics.epoch, steps.resumeBefore.diagnostics.epoch, "a wake is a signal in the same stream, not a restart");
    assert.ok(steps.resumeSeen.diagnostics.fullHashThrough > steps.afterRestart.cut);
    steps.resume = await settle();
    assert.deepEqual([steps.resume.mode, steps.resume.hashed, steps.resume.noop, steps.resume.status], ["full-hash", 29, true, "FRESH"]);
    assert.ok(processAlive(helpers[0]), "the helper survives its wake");

    await rename(repo, `${repo}.old`);
    await cp(fixture, repo, { recursive: true });
    steps.rootSeen = await observed("INVALID_ROOT");
    assert.equal(steps.rootSeen.invalid.length, 1);
    steps.rootRefused = await command("dispatch-invalid");
    assert.deepEqual([steps.rootRefused.refused, steps.rootRefused.served], [true, false]);
    await command("exit"); child.stdin.end(); const result = await closed; assert.equal(result.code, 0);
  } catch (error) { failure = error; throw error; }
  finally {
    let closeoutError;
    try {
      if (child.pid && processAlive(child.pid)) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
      await closed.catch(error => { if (child.pid) throw error; });
      if (child.pid) await eventually(() => !processAlive(child.pid) && !processAlive(-child.pid), 5000);
      await lease.release();
    }
    catch (error) { closeoutError = error; }
    await writeJson(path.join(process.env.ILV2_EVIDENCE_ROOT ?? path.join(process.env.ILV2_RUN_ROOT, "raw"), "tracker-native-acceptance.json"), {
      route: "G01-direct-owned-fixture", launchd: "NOT_RUN", steps, actualOsDrop: "NOT_INDUCED", fakeDropTests: "PROTOCOL_ONLY", resumeSignal: "NATIVE_TEST_HOOK_REPLAY (IOKit registration real; the host was not slept)",
      stdout, stderr, failure: failure && String(failure), closeoutError: closeoutError && String(closeoutError), quotaReleased: !closeoutError
    });
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("fixture closed")); } pending.clear();
    if (closeoutError) throw closeoutError;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMacNative } from "./build-macos-native.mjs";
import { MAC_WORK_ROOT, writeJson } from "./ilv2-mac-contracts.mjs";
import { acquireFixtureSlot } from "./ilv2-mac-fixture-quota.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// These entries exit immediately. Await close even after timeout; a launcher
// exit cannot stand in for exit of its process group.
async function launch(binary, cache, entry) {
  const lease = await acquireFixtureSlot(MAC_WORK_ROOT);
  const child = spawn(binary, ["owner", cache, entry], { detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } });
  let stdout = "", stderr = "", timedOut = false, killError;
  child.stdout.on("data", bytes => { stdout += bytes; });
  child.stderr.on("data", bytes => { stderr += bytes; });
  const kill = () => {
    if (!(child.pid > 1)) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") killError = error; }
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, 5000);
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ pid: child.pid, code, signal, stdout, stderr, timedOut }));
  });
  let result, primaryError;
  try {
    if (child.pid) await lease.registerChild(child.pid, child.pid);
    result = await closed;
  } catch (error) {
    primaryError = error; kill();
    try { result = await closed; } catch { result = { pid: child.pid, stdout, stderr, timedOut }; }
  } finally { clearTimeout(timer); }
  let groupAbsent = !child.pid;
  if (child.pid) {
    try { process.kill(-child.pid, 0); } catch (error) {
      if (error.code === "ESRCH") groupAbsent = true;
      else throw Object.assign(error, { launchResult: result, preserveFixture: true });
    }
  }
  result.groupAbsent = groupAbsent; result.killError = killError?.message;
  if (!groupAbsent) throw Object.assign(new Error("owned group must actually exit"), { launchResult: result, preserveFixture: true });
  await lease.release();
  if (primaryError) throw Object.assign(primaryError, { launchResult: result });
  if (timedOut) throw Object.assign(new Error("owner entry timed out"), { launchResult: result });
  return result;
}

test("native-build-relocates-with-identical-bytes-and-loads-only-bundled-guard", { timeout: 60000 }, async () => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "mac-native-relocation-")));
  const records = [], manifests = [];
  let error;
  try {
    const entry = path.join(directory, "entry.mjs");
    await writeFile(entry, 'import { fstatSync } from "node:fs"; console.log(JSON.stringify({ entered: true, fd4: fstatSync(4).isFile() }));\n');
    for (const name of ["first", "different-candidate-path"]) {
      const candidate = path.join(directory, name);
      await mkdir(path.join(candidate, "scripts"), { recursive: true });
      await mkdir(path.join(candidate, "dist"));
      await cp(path.join(sourceRoot, "native"), path.join(candidate, "native"), { recursive: true });
      await cp(path.join(sourceRoot, "scripts/build-macos-native.mjs"), path.join(candidate, "scripts/build-macos-native.mjs"));
      await cp(path.join(sourceRoot, "dist/mac-platform"), path.join(candidate, "dist/mac-platform"), { recursive: true });
      await cp(path.join(sourceRoot, "package.json"), path.join(candidate, "package.json"));
      await mkdir(path.join(candidate, "cache"));
      const manifest = await buildMacNative(candidate); manifests.push(manifest);
      assert.ok(manifest.compilerArgs.every(arg => !arg.startsWith("-DILV2_OWNER_GUARD=")));
      const result = await launch(path.join(candidate, "dist/native/ilv2-mac"), path.join(candidate, "cache"), entry);
      records.push({ name, result });
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.deepEqual(JSON.parse(result.stdout), { entered: true, fd4: true });
    }
    assert.equal(manifests[0].sourceDigest, manifests[1].sourceDigest);
    assert.equal(manifests[0].binarySha256, manifests[1].binarySha256, "candidate directory must not alter executable identity");
    assert.notDeepEqual(manifests[0].compilerArgs, manifests[1].compilerArgs, "manifest retains actual build paths");
    const candidate = path.join(directory, "different-candidate-path");
    const guard = path.join(candidate, "dist/mac-platform/owner-lock-guard.js");
    const original = await readFile(guard);
    await rm(guard);
    async function rejected(name, expected, nativeFailure = true) {
      const result = await launch(path.join(candidate, "dist/native/ilv2-mac"), path.join(candidate, "cache"), entry);
      records.push({ name, result });
      assert.notEqual(result.code, 0);
      assert.ok(!result.stdout.includes('"entered":true'), "entry must not execute without valid guard");
      assert.match(nativeFailure ? result.stdout : result.stderr, expected);
    }
    await rejected("missing-guard", /OWNER_GUARD_INVALID/);
    const outside = path.join(directory, "outside-guard.js"); await writeFile(outside, original);
    await symlink(outside, guard);
    await rejected("guard-symlink-outside-bundle", /OWNER_GUARD_INVALID/);
    await rm(guard); await writeFile(guard, 'throw new Error("bundled-guard-was-preloaded");\n');
    await rejected("guard-preloaded-before-entry", /bundled-guard-was-preloaded/, false);
    await writeFile(guard, original);
    const platform = path.dirname(guard), redirected = path.join(directory, "redirected-platform");
    await cp(platform, redirected, { recursive: true }); await rm(platform, { recursive: true }); await symlink(redirected, platform);
    await rejected("platform-symlink-outside-bundle", /OWNER_GUARD_INVALID/);
  } catch (failure) { error = failure; if (failure.launchResult) records.push({ name: "launch-failure", result: failure.launchResult }); throw failure; }
  finally {
    if (process.env.ILV2_RUN_ROOT) await writeJson(path.join(process.env.ILV2_EVIDENCE_ROOT ?? path.join(process.env.ILV2_RUN_ROOT, "raw"), "native-relocation.json"), {
      status: error ? "FAIL" : "PASS", error: error?.stack, manifests, records
    });
    if (!error?.preserveFixture) await rm(directory, { recursive: true, force: true });
  }
});

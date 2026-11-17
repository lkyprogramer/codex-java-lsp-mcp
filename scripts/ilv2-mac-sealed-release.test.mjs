import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertReleaseInventory, releaseInventory, validateUpgradeTarget } from "./ilv2-mac-sealed-release.mjs";

test("sealed release identity follows the bytes, modes, and relative dependency links across paths", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sealed-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, "candidate");
  const installed = path.join(root, "installed");
  for (const directory of [candidate, installed]) {
    await mkdir(path.join(directory, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(directory, "run.sh"), "exit 0\n", { mode: 0o755 });
    await writeFile(path.join(directory, "node_modules", "cli.js"), "export {};\n");
    await symlink("../cli.js", path.join(directory, "node_modules", ".bin", "cli"));
  }
  await mkdir(path.join(candidate, ".git"));
  const seal = await releaseInventory(candidate);
  assertReleaseInventory(seal, await releaseInventory(installed));
  const script = path.join(installed, "run.sh");
  const originalMode = (await stat(script)).mode & 0o7777;
  await chmod(script, originalMode ^ 0o100);
  const changedMode = await releaseInventory(installed);
  assert.throws(() => assertReleaseInventory(seal, changedMode), /file tree mismatch/);
  await chmod(script, originalMode);
  await writeFile(path.join(installed, "node_modules", "cli.js"), "throw 0;\n");
  const changedDependency = await releaseInventory(installed);
  assert.throws(() => assertReleaseInventory(seal, changedDependency), /dependency tree mismatch/);
});

const RELEASE = "0123456789ab-20261117T000000Z";
async function upgradeTarget(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "sealed-upgrade-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "run-root.txt"), `${root}\n`);
  const runtime = path.join(root, "runtime");
  await mkdir(path.join(runtime, "releases", RELEASE), { recursive: true });
  await mkdir(path.join(runtime, "state"));
  await symlink(path.join("releases", RELEASE), path.join(runtime, "current"));
  await writeFile(path.join(runtime, "state", "daemon.env"), "JAVA_LSP_HTTP_INSTANCE_ID=fixture\n", { mode: 0o600 });
  await writeFile(path.join(runtime, "daemonctl.sh"), "exit 0\n", { mode: 0o755 });
  const label = "com.lky.ilv2-mac-upgrade.fixture";
  const plist = path.join(root, "LaunchAgents", `${label}.plist`);
  await mkdir(path.dirname(plist));
  await writeFile(plist, "<plist/>\n", { mode: 0o600 });
  const args = { runtime, plist, logs: path.join(root, "logs"), cache: path.join(root, "cache"), ownership: path.join(root, "ownership"), label, port: "39101", candidatePort: "39102" };
  const saved = { ILV2_RUN_ROOT: process.env.ILV2_RUN_ROOT, JAVA_LSP_ISOLATED_VALIDATION: process.env.JAVA_LSP_ISOLATED_VALIDATION };
  process.env.ILV2_RUN_ROOT = root;
  process.env.JAVA_LSP_ISOLATED_VALIDATION = "1";
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const run = (overrides = {}) => {
    const value = { ...args, ...overrides };
    return validateUpgradeTarget([value.runtime, value.plist, value.logs, value.cache, value.ownership, value.label, value.port, value.candidatePort]);
  };
  return { root, runtime, run };
}

test("isolated upgrade target returns the installed immutable release", async t => {
  const { runtime, run } = await upgradeTarget(t);
  assert.equal(await run(), path.join(runtime, "releases", RELEASE));
});

test("isolated upgrade rejects production label and ports, and paths outside the run", async t => {
  const { root, run } = await upgradeTarget(t);
  await assert.rejects(run({ label: "com.lky.codex-java-lsp-ilv2" }), /isolated upgrade label and ports required/);
  await assert.rejects(run({ port: "38456" }), /isolated upgrade label and ports required/);
  await assert.rejects(run({ candidatePort: "38457" }), /isolated upgrade label and ports required/);
  await assert.rejects(run({ logs: path.join(path.dirname(root), "outside-logs") }), /path outside managed root/);
  await assert.rejects(run({ cache: root }), /isolated upgrade path escapes run/);
});

test("upgrade requires a registered run root", async t => {
  const { root, run } = await upgradeTarget(t);
  await writeFile(path.join(root, "run-root.txt"), "/elsewhere\n");
  await assert.rejects(run(), /registered upgrade run required/);
});

test("upgrade requires current to link into an immutable release", async t => {
  const { runtime, run } = await upgradeTarget(t);
  const current = path.join(runtime, "current");
  await rm(current);
  await mkdir(current);
  await assert.rejects(run(), /installed current release link required/);
  await rm(current, { recursive: true });
  await mkdir(path.join(runtime, "releases", "not-a-release"));
  await symlink(path.join("releases", "not-a-release"), current);
  await assert.rejects(run(), /outside the immutable releases/);
});

test("upgrade rejects group- or world-writable installed state", async t => {
  const { runtime, run } = await upgradeTarget(t);
  await chmod(path.join(runtime, "state", "daemon.env"), 0o620);
  await assert.rejects(run(), /invalid installed upgrade state/);
});

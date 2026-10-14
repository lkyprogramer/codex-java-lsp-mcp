import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "./ilv2-mac-contracts.mjs";
import { isolatedValidationEnvironment, validationIdentity, verifyValidationIdentity, validationResultDirectory, recordValidationCommand, registeredReuseRoot, verifyNativeToolchain } from "./run-isolated-validation.mjs";

test("isolated validation never inherits or accepts overrides for active LSP state directories", () => {
  const root = "/tmp/v32-isolated";
  const env = isolatedValidationEnvironment(root, {
    TASK_MARKER: "yes",
    HOME: "/active/home",
    JAVA_LSP_CACHE_ROOT: "/active/cache",
    XDG_CACHE_HOME: "/active/xdg",
    XDG_CONFIG_HOME: "/active/xdg-config",
    XDG_DATA_HOME: "/active/xdg-data",
    XDG_STATE_HOME: "/active/xdg-state",
    TMPDIR: "/active/tmp",
    JDTLS_DATA_DIR: "/active/jdt-workspace",
    JDTLS_LOG_DIR: "/active/jdt-logs",
    JAVA_LSP_PROJECTS_JSON: "/active/projects.json",
    JAVA_LSP_ISOLATED_VALIDATION: "0",
    JAVA_TOOL_OPTIONS: "-Duser.home=/active/home",
    _JAVA_OPTIONS: "-Djava.io.tmpdir=/active/tmp",
    JDK_JAVA_OPTIONS: "-Duser.home=/active/home",
    MAVEN_OPTS: "-Dmaven.repo.local=/active/m2",
    GRADLE_OPTS: "-Dgradle.user.home=/active/gradle",
    NODE_OPTIONS: "--require=/active/mutator.cjs",
    NODE_PATH: "/active/node_modules",
    NODE_REPL_HISTORY: "/active/node-repl-history",
    NODE_V8_COVERAGE: "/active/coverage",
    NODE_COMPILE_CACHE: "/active/compile-cache",
    NODE_REDIRECT_WARNINGS: "/active/node-warnings.log"
  });
  assert.equal(env.HOME, path.join(root, "home"));
  assert.equal(env.JAVA_LSP_CACHE_ROOT, path.join(root, "cache"));
  assert.equal(env.XDG_CACHE_HOME, path.join(root, "xdg-cache"));
  assert.equal(env.XDG_CONFIG_HOME, path.join(root, "xdg-config"));
  assert.equal(env.XDG_DATA_HOME, path.join(root, "xdg-data"));
  assert.equal(env.XDG_STATE_HOME, path.join(root, "xdg-state"));
  assert.equal(env.TMPDIR, path.join(root, "tmp"));
  assert.equal(env.JDTLS_DATA_DIR, path.join(root, "cache", "jdt-workspace"));
  assert.equal(env.JDTLS_LOG_DIR, path.join(root, "cache", "jdt-logs"));
  assert.equal(env.JAVA_LSP_PROJECTS_JSON, path.join(root, "projects.json"));
  assert.equal(env.JAVA_LSP_ISOLATED_VALIDATION, "1");
  assert.equal(env.JAVA_TOOL_OPTIONS, undefined);
  assert.equal(env._JAVA_OPTIONS, undefined);
  assert.equal(env.JDK_JAVA_OPTIONS, undefined);
  assert.equal(env.MAVEN_OPTS, undefined);
  assert.equal(env.GRADLE_OPTS, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
  assert.equal(env.NODE_REPL_HISTORY, undefined);
  assert.equal(env.NODE_V8_COVERAGE, undefined);
  assert.equal(env.NODE_COMPILE_CACHE, undefined);
  assert.equal(env.NODE_REDIRECT_WARNINGS, undefined);
  assert.equal(env.GRADLE_USER_HOME, path.join(root, "service-state", "jdt-gradle-home"));
  assert.equal(env.JAVA_LSP_SERVICE_STATE_ROOT, path.join(root, "service-state"));
  assert.equal(env.MAVEN_USER_HOME, path.join(root, "maven-home"));
  assert.equal(env.JDTLS_BIN, "/usr/bin/false");
  assert.equal(env.TASK_MARKER, "yes");
});

test("isolated validation drops inherited repo selectors and benchmark cache overrides", () => {
  const previous = {
    smoke: process.env.JAVA_LSP_SMOKE_REPO_ROOT,
    benchmark: process.env.JAVA_LSP_BENCH_REPO_ROOT,
    indexCache: process.env.JAVA_LSP_BENCH_INDEX_CACHE_DIR,
    lishuedu: process.env.LISHUEDU_ROOT,
    extraArgs: process.env.JDTLS_EXTRA_ARGS,
    resourceTelemetry: process.env.JAVA_LSP_RESOURCE_TELEMETRY_FILE
  };
  process.env.JAVA_LSP_SMOKE_REPO_ROOT = "/active/smoke-repo";
  process.env.JAVA_LSP_BENCH_REPO_ROOT = "/active/benchmark-repo";
  process.env.JAVA_LSP_BENCH_INDEX_CACHE_DIR = "/active/index-cache";
  process.env.LISHUEDU_ROOT = "/active/lishuedu";
  process.env.JDTLS_EXTRA_ARGS = "-data /active/jdt";
  process.env.JAVA_LSP_RESOURCE_TELEMETRY_FILE = "/active/telemetry.json";
  try {
    const env = isolatedValidationEnvironment("/tmp/v32-isolated", {
      JAVA_LSP_RESOURCE_TELEMETRY_FILE: "/also-active/telemetry.json",
      JAVA_LSP_BENCH_INDEX_CACHE_DIR: "/also-active/index-cache",
      JAVA_LSP_ISOLATED_REPO_ROOT: "/also-active/repo",
      JAVA_LSP_ISOLATED_REPO_WORKTREE: "1",
      JAVA_LSP_REPO_ROOT: "/also-active/repo",
      JAVA_LSP_SMOKE_REPO_ROOT: "/also-active/repo"
    });
    assert.equal(env.JAVA_LSP_SMOKE_REPO_ROOT, undefined);
    assert.equal(env.JAVA_LSP_BENCH_REPO_ROOT, undefined);
    assert.equal(env.JAVA_LSP_BENCH_INDEX_CACHE_DIR, undefined);
    assert.equal(env.LISHUEDU_ROOT, undefined);
    assert.equal(env.JDTLS_EXTRA_ARGS, undefined);
    assert.equal(env.JAVA_LSP_RESOURCE_TELEMETRY_FILE, undefined);
    assert.equal(env.JAVA_LSP_BENCH_INDEX_CACHE_DIR, undefined);
    assert.equal(env.JAVA_LSP_ISOLATED_REPO_ROOT, undefined);
    assert.equal(env.JAVA_LSP_ISOLATED_REPO_WORKTREE, undefined);
    assert.equal(env.JAVA_LSP_REPO_ROOT, undefined);
    assert.equal(env.JAVA_LSP_SMOKE_REPO_ROOT, undefined);
  } finally {
    restore("JAVA_LSP_SMOKE_REPO_ROOT", previous.smoke);
    restore("JAVA_LSP_BENCH_REPO_ROOT", previous.benchmark);
    restore("JAVA_LSP_BENCH_INDEX_CACHE_DIR", previous.indexCache);
    restore("LISHUEDU_ROOT", previous.lishuedu);
    restore("JDTLS_EXTRA_ARGS", previous.extraArgs);
    restore("JAVA_LSP_RESOURCE_TELEMETRY_FILE", previous.resourceTelemetry);
  }
});

test("isolated validation accepts only candidate-cwd repo selector overrides", () => {
  const safe = isolatedValidationEnvironment("/tmp/v32-isolated", { JAVA_LSP_SMOKE_REPO_ROOT: "." });
  const unsafe = isolatedValidationEnvironment("/tmp/v32-isolated", { JAVA_LSP_SMOKE_REPO_ROOT: "/active/repo" });
  assert.equal(safe.JAVA_LSP_SMOKE_REPO_ROOT, ".");
  assert.equal(unsafe.JAVA_LSP_SMOKE_REPO_ROOT, undefined);
});

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function frozenFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ilv2-runner-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"), candidate = path.join(root, "candidate");
  for (const directory of [workspace, candidate]) {
    await mkdir(directory);
    await promisify(execFile)("git", ["init", "--quiet", directory]);
    for (const name of ["src", "docs", "dist", "node_modules"]) await mkdir(path.join(directory, name));
    await writeFile(path.join(directory, "src", "main.ts"), "export const value = 1;\n");
    await writeFile(path.join(directory, "docs", "manual.md"), "initial\n");
    await mkdir(path.join(directory, "dist", "native"));
    await writeFile(path.join(directory, "dist", "native", "manifest.json"), '{"binarySha256":"frozen-native"}\n');
    await writeFile(path.join(directory, "dist", "build-stamp.json"), '{"gitSha":"frozen-build"}\n');
    await writeFile(path.join(directory, "dist", "main.js"), "export const value = 1;\n");
    await writeFile(path.join(directory, "node_modules", "dependency.js"), "module.exports = 1;\n");
  }
  const runtime = { nodeSha256: "frozen-node", runtimeManifestSha256: "frozen-manifest" };
  return { root, workspace, candidate, runtime, frozen: await validationIdentity(candidate, workspace, runtime) };
}

test("frozen candidate reuse allows documentation edits without a rebuild and rejects source edits", async t => {
  const f = await frozenFixture(t);
  await writeFile(path.join(f.workspace, "docs", "manual.md"), "updated requirements prose\n");
  assert.deepEqual(await verifyValidationIdentity(f.frozen, f.candidate, f.workspace, f.runtime), f.frozen);
  await writeFile(path.join(f.workspace, "src", "main.ts"), "export const value = 2;\n");
  await assert.rejects(verifyValidationIdentity(f.frozen, f.candidate, f.workspace, f.runtime), /candidate drift: source/);
  assert.equal(await readFile(path.join(f.candidate, "dist", "main.js"), "utf8"), "export const value = 1;\n");
});

test("reuse rejects compiled output, runtime and dependency drift independently", async t => {
  const f = await frozenFixture(t);
  await assert.rejects(verifyValidationIdentity(f.frozen, f.candidate, f.workspace, { ...f.runtime, nodeSha256: "changed" }), /candidate drift: runtime/);
  await writeFile(path.join(f.candidate, "dist", "main.js"), "corrupted output\n");
  await assert.rejects(verifyValidationIdentity(f.frozen, f.candidate, f.workspace, f.runtime), /candidate drift: dist/);
  await writeFile(path.join(f.candidate, "dist", "main.js"), "export const value = 1;\n");
  await writeFile(path.join(f.candidate, "node_modules", "dependency.js"), "module.exports = 2;\n");
  await assert.rejects(verifyValidationIdentity(f.frozen, f.candidate, f.workspace, f.runtime), /candidate drift: dependencies/);
});

test("unique evidence names reject overwrite and traversal", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ilv2-results-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = await validationResultDirectory(root, "independent-1");
  await writeFile(path.join(directory, "sentinel"), "original");
  await assert.rejects(validationResultDirectory(root, "independent-1"), { code: "EEXIST" });
  await assert.rejects(validationResultDirectory(root, "../escaped"), /invalid validation run name/);
  assert.equal(await readFile(path.join(directory, "sentinel"), "utf8"), "original");
});

test("a failing selected command preserves both output streams and its actual exit", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ilv2-command-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(recordValidationCommand(root, process.execPath,
    ["-e", "process.stdout.write('main evidence'); process.stderr.write('original error'); process.exitCode = 3"],
    { cwd: root, env: { PATH: process.env.PATH, UNRELATED_SECRET: "must-not-record" } }), /exited with 3/);
  const record = JSON.parse(await readFile(path.join(root, "0.command.json"), "utf8"));
  assert.equal(record.exitCode, 3);
  assert.equal(record.signal, null);
  assert.ok(record.elapsedMs >= 0);
  assert.equal(record.environment.UNRELATED_SECRET, undefined);
  assert.equal(await readFile(path.join(root, record.stdout), "utf8"), "main evidence");
  assert.equal(await readFile(path.join(root, record.stderr), "utf8"), "original error");
});

test("reuse requires the registered broker and rejects escaping symlinks", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "ilv2-broker-unit-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "tmp"));
  const broker = path.join(root, "tmp", "broker");
  await mkdir(broker);
  await writeFile(path.join(root, "run-root.txt"), `${root}\n`);
  await writeFile(path.join(broker, "broker-root.json"), JSON.stringify({ root: broker, parentRunRoot: root }));
  assert.equal(await registeredReuseRoot(root, broker), broker);
  await assert.rejects(registeredReuseRoot(undefined, broker), /preregistered/);
  await mkdir(path.join(root, "outside-tmp"));
  await symlink(path.join(root, "outside-tmp"), path.join(root, "tmp", "escaped"));
  await assert.rejects(registeredReuseRoot(root, path.join(root, "tmp", "escaped")), /outside managed root/);
  await symlink(broker, path.join(root, "tmp", "alias"));
  await assert.rejects(registeredReuseRoot(root, path.join(root, "tmp", "alias")), /symlink rejected/);
});

test("reuse checks actual compiler bytes, version and selected SDK", async () => {
  const native = { compiler: process.execPath, compilerSha256: "wrong" };
  await assert.rejects(verifyNativeToolchain(native), /compiler bytes/);
  native.compilerSha256 = sha256(await readFile(process.execPath));
  native.toolchain = "wrong";
  await assert.rejects(verifyNativeToolchain(native), /compiler version/);
  native.toolchain = (await promisify(execFile)(process.execPath, ["--version"])).stdout;
  native.sdk = "/not-the-selected-sdk";
  await assert.rejects(verifyNativeToolchain(native), /SDK/);
});

test("controller SIGKILL preserves in-flight identity and both received streams", { timeout: 7000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ilv2-command-kill-"));
  const module = new URL("./run-isolated-validation.mjs", import.meta.url).href;
  const code = `import {recordValidationCommand} from ${JSON.stringify(module)}; await recordValidationCommand(${JSON.stringify(root)}, process.execPath, ['-e', 'console.log("partial stdout"); console.error("partial stderr"); setInterval(()=>{},1000)'], {cwd:${JSON.stringify(root)}, env:{}});`;
  const controller = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "ignore", env: isolatedValidationEnvironment(root) });
  const closed = new Promise(resolve => controller.once("close", resolve));
  let childPid;
  t.after(async () => {
    if (controller.exitCode === null && controller.signalCode === null) controller.kill("SIGKILL");
    await closed;
    if (childPid) {
      try { process.kill(childPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      for (let i = 0; i < 100; i++) {
        try { process.kill(childPid, 0); } catch (error) { if (error.code === "ESRCH") { await rm(root, { recursive: true, force: true }); return; } throw error; }
        await delay(20);
      }
      throw new Error("owned interrupted command did not actually exit");
    }
    await rm(root, { recursive: true, force: true });
  });
  let record;
  for (let i = 0; i < 100; i++) {
    try {
      record = JSON.parse(await readFile(path.join(root, "0.command.json"), "utf8"));
      childPid = record.pid;
      if (childPid && (await readFile(path.join(root, record.stdout), "utf8")).includes("partial stdout") && (await readFile(path.join(root, record.stderr), "utf8")).includes("partial stderr")) break;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(20);
  }
  assert.ok(childPid > 1); controller.kill("SIGKILL"); await closed;
  assert.equal(record.status, "IN_PROGRESS"); assert.equal(record.exitCode, null);
  assert.match(await readFile(path.join(root, record.stdout), "utf8"), /partial stdout/);
  assert.match(await readFile(path.join(root, record.stderr), "utf8"), /partial stderr/);
});

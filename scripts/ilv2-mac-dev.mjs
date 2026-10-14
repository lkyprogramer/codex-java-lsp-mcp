#!/usr/bin/env node
// Tier-0 dev loop. One persistent patched tree per name under the work root:
// incremental tsc, native rebuilt only when its inputs or runtime change, and a
// fresh isolated state/run root per command. Results are never gate evidence;
// gates still run through run-isolated-validation.mjs (Tier-1).
import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MAC_WORK_ROOT, execute, isMain, readJson, requireUnprotectedRoot, requireValue, runCli, sha256, verifyRuntime, writeJson } from "./ilv2-mac-contracts.mjs";
import { captureCandidatePatch } from "./run-three-repo-cold-matrix.mjs";
import { bindCandidateNodeCommand, copyIsolatedNodeModules } from "./isolation-utils.mjs";
import { isolatedValidationEnvironment, verifyNativeToolchain } from "./run-isolated-validation.mjs";
import { verifyOwnedExit } from "./ilv2-mac-closeout.mjs";
import { collectOwnedResources } from "./ilv2-mac-task-result.mjs";
import { fixtureQuotaFile } from "./ilv2-mac-fixture-quota.mjs";
import { nativeSourceFiles } from "./build-macos-native.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIRS = ["home", "cache", "xdg-cache", "xdg-config", "xdg-data", "xdg-state", "maven-home", "tmp", "raw"];

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

export function parseDevCli(args) {
  const separator = args.indexOf("--");
  const options = separator >= 0 ? args.slice(0, separator) : args;
  const parsed = { name: "main", keepRuns: 3, environment: {}, command: separator >= 0 ? args.slice(separator + 1) : [] };
  for (let index = 0; index < options.length; index += 1) {
    const [arg, value] = [options[index], options[index + 1]];
    requireValue(value !== undefined, `${arg} requires a value`);
    if (arg === "--name") { requireValue(/^[a-z0-9][a-z0-9-]{0,31}$/.test(value), "dev tree name must be [a-z0-9-]"); parsed.name = value; }
    else if (arg === "--keep-runs") { parsed.keepRuns = Number(value); requireValue(Number.isInteger(parsed.keepRuns) && parsed.keepRuns >= 1, "--keep-runs must be >= 1"); }
    else if (arg === "--env") { const equals = value.indexOf("="); requireValue(equals > 0, "--env requires NAME=VALUE"); parsed.environment[value.slice(0, equals)] = value.slice(equals + 1); }
    else throw new Error(`unknown argument: ${arg}`);
    index += 1;
  }
  return parsed;
}

/**
 * One dev run per tree at a time; a lock left by a dead process is taken over.
 * Two runs started together against a stale lock can both take it over; pruning
 * therefore never touches a run that has not finished (see prunableRuns).
 */
export async function acquireDevLock(devRoot) {
  const file = path.join(devRoot, "lock.json");
  try { await writeFile(file, JSON.stringify({ pid: process.pid }), { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const holder = await readJson(file).catch(() => ({}));
    requireValue(!(Number.isInteger(holder.pid) && alive(holder.pid)), `dev tree busy: pid ${holder.pid}`);
    await writeFile(file, JSON.stringify({ pid: process.pid }));
  }
  return () => rm(file, { force: true });
}

/** tsc never deletes outputs, so a removed src/*.ts would leave its compiled test runnable. */
export async function pruneStaleDist(tree) {
  const removed = [];
  async function visit(relative) {
    let entries;
    try { entries = await readdir(path.join(tree, "dist", relative), { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) { if (name !== "native") await visit(name); continue; }
      const match = /^(.*)\.js(\.map)?$/.exec(name);
      if (match && !(await exists(path.join(tree, "src", `${match[1]}.ts`)))) { await rm(path.join(tree, "dist", name)); removed.push(name); }
    }
  }
  await visit("");
  return removed.sort();
}

export function runsToPrune(names, keep) {
  return [...names].sort().reverse().slice(keep);
}

/** Older runs that have finished (dev-run.json written); a concurrent live run is never a candidate. */
export async function prunableRuns(runsRoot, currentId, keep) {
  const finished = [];
  for (const entry of await readdir(runsRoot)) {
    if (entry !== currentId && await exists(path.join(runsRoot, entry, "dev-run.json"))) finished.push(entry);
  }
  return runsToPrune(finished, keep);
}

function spawnStep(command, args, { cwd, env }) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, elapsedMs: Math.round(performance.now() - started) }));
  });
}
async function step(label, args, options) {
  const result = await spawnStep(process.execPath, args, options);
  requireValue(result.exitCode === 0, `${label} exited with ${result.exitCode ?? result.signal}`);
  return result.elapsedMs;
}

async function refreshTree(devRoot, tree) {
  const git = (...args) => execute("git", args, { maxBuffer: 64 * 1024 * 1024 });
  const commit = (await git("-C", sourceRoot, "rev-parse", "HEAD^{commit}")).stdout.trim();
  if (!(await exists(path.join(tree, ".git")))) await git("clone", "--shared", "--no-checkout", "-q", sourceRoot, tree);
  // reset/checkout/clean below are destructive: they must act on this clone only,
  // never on a parent repository reached through a broken .git or a symlink.
  requireValue(await realpath(tree) === tree && (await git("-C", tree, "rev-parse", "--show-toplevel")).stdout.trim() === tree
    && (await git("-C", tree, "rev-parse", "--absolute-git-dir")).stdout.trim() === path.join(tree, ".git"), `dev tree is not its own clone: ${tree}`);
  // Reset to the source commit, drop the previous patch, keep ignored dist/ for incremental builds.
  await git("-C", tree, "reset", "--hard", "-q");
  await git("-C", tree, "checkout", "--detach", "--force", "-q", commit);
  await git("-C", tree, "clean", "-fdq");
  const { patch } = await captureCandidatePatch(sourceRoot);
  const patchFile = path.join(devRoot, "candidate.patch");
  await writeFile(patchFile, patch);
  if (patch.length) await git("-C", tree, "apply", "--index", patchFile);
  return { commit, patchSha256: sha256(patch) };
}

async function ensureDependencies(devRoot, tree, state) {
  const lock = await readFile(path.join(sourceRoot, "node_modules/.package-lock.json")).catch(() => Buffer.alloc(0));
  const lockSha256 = sha256(Buffer.concat([await readFile(path.join(sourceRoot, "package-lock.json")), lock]));
  const target = path.join(devRoot, "node_modules");
  let copied = false;
  if (state.lockSha256 !== lockSha256 || !(await exists(target))) {
    await rm(target, { recursive: true, force: true });
    await copyIsolatedNodeModules(sourceRoot, devRoot);
    await rm(path.join(devRoot, "tsconfig.tsbuildinfo"), { force: true });
    copied = true;
  }
  await rm(path.join(tree, "node_modules"), { force: true });
  await symlink(target, path.join(tree, "node_modules"), "dir");
  return { lockSha256, copied };
}

async function nativeCurrent(tree, runtime) {
  try {
    const native = await readJson(path.join(tree, "dist/native/manifest.json"));
    if (native.sourceDigest !== sha256(JSON.stringify(await nativeSourceFiles(tree)))) return false;
    if (native.runtime.runtimeManifestSha256 !== runtime.runtimeManifestSha256) return false;
    if (sha256(await readFile(path.join(tree, "dist/native/ilv2-mac"))) !== native.binarySha256) return false;
    await verifyNativeToolchain(native);
    return true;
  } catch { return false; }
}

async function residualCheck(runRoot) {
  try {
    const resources = await collectOwnedResources(runRoot);
    const workRoot = await exists(fixtureQuotaFile(MAC_WORK_ROOT)) ? MAC_WORK_ROOT : undefined;
    await verifyOwnedExit({ ...resources, runRoot, workRoot });
    return { status: "PASS", processes: resources.processes.length, launchdJobs: resources.launchdJobs.length };
  } catch (error) { return { status: "RESIDUAL", error: error.message }; }
}

export async function runDev({ name, keepRuns, environment, command }) {
  const devRoot = path.join(MAC_WORK_ROOT, "dev", name), tree = path.join(devRoot, "tree");
  const runsRoot = path.join(MAC_WORK_ROOT, "runs", `dev-${name}`);
  await mkdir(devRoot, { recursive: true });
  await mkdir(runsRoot, { recursive: true });
  for (const [label, directory] of [["dev tree", devRoot], ["dev runs", runsRoot]]) {
    requireValue(await realpath(directory) === directory, `${label} must not traverse a symlink: ${directory}`);
    requireUnprotectedRoot(directory, label);
  }
  const release = await acquireDevLock(devRoot);
  const id = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(2).toString("hex")}`;
  const runRoot = path.join(runsRoot, id);
  const timings = {}, report = { schema: "ilv2-mac-dev-run/v1", evidence: "NONE: Tier-0 dev loop, not gate evidence", name, tree, runRoot };
  try {
    const runtime = await verifyRuntime();
    const statePath = path.join(devRoot, "state.json");
    const state = await readJson(statePath).catch(() => ({}));
    let started = performance.now();
    Object.assign(report, await refreshTree(devRoot, tree));
    timings.refreshMs = Math.round(performance.now() - started);
    started = performance.now();
    const dependencies = await ensureDependencies(devRoot, tree, state);
    timings.dependenciesMs = Math.round(performance.now() - started);
    report.dependencies = dependencies.copied ? "COPIED" : "REUSED";

    await mkdir(runRoot);
    await writeFile(path.join(runRoot, "run-root.txt"), `${runRoot}\n`);
    for (const directory of STATE_DIRS) await mkdir(path.join(runRoot, directory));
    await writeFile(path.join(runRoot, "projects.json"), '{"aliases":[],"defaults":{}}\n');
    const env = { ...isolatedValidationEnvironment(runRoot, environment), ILV2_RUN_ROOT: runRoot, ILV2_EVIDENCE_ROOT: path.join(runRoot, "raw") };
    const options = { cwd: tree, env };

    const buildInfo = path.join(devRoot, "tsconfig.tsbuildinfo");
    if (!(await exists(path.join(tree, "dist")))) await rm(buildInfo, { force: true });
    timings.tscMs = await step("tsc", [path.join(tree, "node_modules/.bin/tsc"), "-p", path.join(tree, "tsconfig.json"), "--incremental", "--tsBuildInfoFile", buildInfo], options);
    report.prunedDist = await pruneStaleDist(tree);
    report.native = await nativeCurrent(tree, runtime) ? "REUSED" : "REBUILT";
    if (report.native === "REBUILT") timings.nativeMs = await step("native build", [path.join(tree, "scripts/build-macos-native.mjs")], options);
    timings.stampMs = await step("build stamp", [path.join(tree, "scripts/write-build-stamp.mjs")], options);
    await writeJson(statePath, { lockSha256: dependencies.lockSha256 });

    if (command.length) {
      const bound = bindCandidateNodeCommand(command, { candidateRoot: tree, stateRoot: runRoot });
      const result = await spawnStep(bound[0], bound.slice(1), options);
      Object.assign(report, { argv: bound, exitCode: result.exitCode, signal: result.signal });
      timings.commandMs = result.elapsedMs;
    } else report.exitCode = 0;
    report.residual = await residualCheck(runRoot);
  } catch (error) {
    report.error = error.message;
    report.exitCode = report.exitCode ?? 1;
  } finally {
    report.timings = timings;
    if (await exists(runRoot)) await writeJson(path.join(runRoot, "dev-run.json"), report);
    // Older dev runs are deleted only after their recorded processes/jobs/quota rows are gone.
    report.prunedRuns = [];
    report.keptResidualRuns = [];
    for (const old of await prunableRuns(runsRoot, id, keepRuns - 1)) {
      const root = path.join(runsRoot, old);
      const residual = await residualCheck(root);
      if (residual.status === "PASS") { await rm(root, { recursive: true, force: true }); report.prunedRuns.push(old); }
      else report.keptResidualRuns.push({ run: old, error: residual.error });
    }
    await release();
  }
  return report;
}

if (isMain(import.meta.url)) runCli(async () => {
  const report = await runDev(parseDevCli(process.argv.slice(2)));
  console.error(JSON.stringify({ dev: report.name, runRoot: report.runRoot, exitCode: report.exitCode, error: report.error ?? null, native: report.native,
    dependencies: report.dependencies, prunedDist: report.prunedDist?.length ?? 0, residual: report.residual?.status ?? null, timings: report.timings,
    prunedRuns: report.prunedRuns.length, keptResidualRuns: report.keptResidualRuns, evidence: "NONE" }));
  process.exitCode = report.exitCode === 0 && report.residual?.status === "PASS" ? 0 : report.exitCode || 3;
});

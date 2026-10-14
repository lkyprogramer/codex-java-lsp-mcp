#!/usr/bin/env node
// input: The current source worktree plus either a targeted command or the full local validation profile.
// output: Validation executed in a detached patched local clone with isolated caches and JDT disabled.
// pos: Mandatory safety boundary between development validation and the user's active LSP runtime.
import { appendFile, mkdir, rm, symlink, writeFile, readFile, realpath, lstat } from "node:fs/promises";
import { openSync, writeSync, closeSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureCandidatePatch } from "./run-three-repo-cold-matrix.mjs";
import { createRegisteredBrokerRoot, verifyRuntime, managedPath, readJson, writeJson, contains, execute } from "./ilv2-mac-contracts.mjs";
import {
  bindCandidateNodeCommand,
  copyIsolatedNodeModules,
  createDetachedLocalClone,
  dependencyTreeInventory,
  sameDependencyInventory,
  scrubHostNodeRuntimeState,
  expandCandidateTestGlobs
} from "./isolation-utils.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_CWD_REPO_SELECTORS = new Set([
  "JAVA_LSP_REPO_ROOT",
  "JAVA_LSP_SMOKE_REPO_ROOT",
  "JAVA_LSP_TEST_REPO_ROOT",
  "JAVA_LSP_BENCH_REPO_ROOT"
]);

export function isolatedValidationEnvironment(root, overrides = {}) {
  const {
    HOME: _home,
    JAVA_LSP_CACHE_ROOT: _cacheRoot,
    JAVA_LSP_CACHE_BASE: _cacheBase,
    JAVA_LSP_OWNERSHIP_BASE: _ownershipBase,
    XDG_CACHE_HOME: _xdgCacheHome,
    XDG_CONFIG_HOME: _xdgConfigHome,
    XDG_DATA_HOME: _xdgDataHome,
    XDG_STATE_HOME: _xdgStateHome,
    TMPDIR: _tmpDir,
    JDTLS_DATA_DIR: _jdtlsDataDir,
    JDTLS_LOG_DIR: _jdtlsLogDir,
    JAVA_LSP_PROJECTS_JSON: _projectsJson,
    JAVA_LSP_ISOLATED_VALIDATION: _isolationMarker,
    JAVA_LSP_ISOLATED_REPO_ROOT: _isolatedRepoRoot,
    JAVA_LSP_ISOLATED_REPO_WORKTREE: _isolatedRepoWorktree,
    JAVA_LSP_BENCH_INDEX_CACHE_DIR: _benchmarkIndexCache,
    JAVA_LSP_RESOURCE_TELEMETRY_FILE: _resourceTelemetryFile,
    JAVA_LSP_RESOURCE_INTERVAL_MS: _resourceIntervalMs,
    ...safeOverrides
  } = overrides;
  const environment = {
    ...process.env,
    ...safeOverrides,
    HOME: path.join(root, "home"),
    JAVA_LSP_CACHE_ROOT: path.join(root, "cache"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    TMPDIR: path.join(root, "tmp"),
    JDTLS_DATA_DIR: path.join(root, "cache", "jdt-workspace"),
    JDTLS_LOG_DIR: path.join(root, "cache", "jdt-logs"),
    JAVA_LSP_PROJECTS_JSON: path.join(root, "projects.json"),
    GRADLE_USER_HOME: path.join(root, "service-state", "jdt-gradle-home"),
    JAVA_LSP_SERVICE_STATE_ROOT: path.join(root, "service-state"),
    MAVEN_USER_HOME: path.join(root, "maven-home"),
    JAVA_LSP_ISOLATED_VALIDATION: "1",
    ILV2_RUN_ROOT: process.env.ILV2_RUN_ROOT,
    ILV2_RUNTIME_MANIFEST: process.env.ILV2_RUNTIME_MANIFEST,
    JDTLS_BIN: typeof overrides.JDTLS_BIN === "string" ? overrides.JDTLS_BIN : "/usr/bin/false"
  };
  delete environment.JAVA_LSP_CACHE_BASE;
  delete environment.JAVA_LSP_OWNERSHIP_BASE;
  for (const inheritedSelector of [
    "JAVA_LSP_REPO_ROOT",
    "JAVA_LSP_SMOKE_REPO_ROOT",
    "JAVA_LSP_SMOKE_PROJECT_ID",
    "JAVA_LSP_SMOKE_START",
    "JAVA_LSP_TEST_REPO_ROOT",
    "JAVA_LSP_BENCH_REPO_ROOT",
    "JAVA_LSP_BENCH_PROJECT_ID",
    "JAVA_LSP_BENCH_INDEX_CACHE_DIR",
    "JAVA_LSP_ISOLATED_REPO_ROOT",
    "JAVA_LSP_ISOLATED_REPO_WORKTREE",
    "LISHUEDU_ROOT",
    "CIPHERLINK_ROOT",
    "EXAM_PARENT_V3_ROOT",
    "JDTLS_EXTRA_ARGS",
    "JAVA_LSP_RESOURCE_TELEMETRY_FILE",
    "JAVA_LSP_RESOURCE_INTERVAL_MS",
    "JAVA_LSP_ENGINE",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "MAVEN_OPTS",
    "GRADLE_OPTS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_REPL_HISTORY",
    "NODE_V8_COVERAGE",
    "NODE_COMPILE_CACHE",
    "NODE_REDIRECT_WARNINGS"
  ]) {
    if (CANDIDATE_CWD_REPO_SELECTORS.has(inheritedSelector) && safeOverrides[inheritedSelector] === ".") {
      environment[inheritedSelector] = ".";
    } else {
      delete environment[inheritedSelector];
    }
  }
  return scrubHostNodeRuntimeState(environment);
}

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceInput = file => /^(src|golden|fixtures|scripts|native)\//.test(file) || /^(?:package(?:-lock)?\.json|tsconfig\.json)$/.test(file);

export async function validationSourceIdentity(root) {
  const names = (await capture("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
    .split("\0").filter(Boolean).filter(sourceInput);
  const rows = [];
  for (const name of [...new Set(names)].sort()) {
    const file = path.join(root, name);
    try {
      if (!(await lstat(file)).isFile() || !contains(await realpath(root), await realpath(file))) throw new Error(`invalid source file: ${name}`);
      rows.push({ path: name, sha256: hash(await readFile(file)) });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return hash(JSON.stringify(rows));
}

export async function validationIdentity(candidateRoot, workspaceRoot, runtime) {
  return {
    source: await validationSourceIdentity(workspaceRoot),
    candidateSource: await validationSourceIdentity(candidateRoot), runtime,
    native: await readJson(path.join(candidateRoot, "dist/native/manifest.json")),
    build: await readJson(path.join(candidateRoot, "dist/build-stamp.json")),
    dist: await dependencyTreeInventory(path.join(candidateRoot, "dist")),
    dependencies: await dependencyTreeInventory(path.join(candidateRoot, "node_modules")),
    workspaceDependencies: await dependencyTreeInventory(path.join(workspaceRoot, "node_modules"))
  };
}

export async function verifyValidationIdentity(frozen, candidateRoot, workspaceRoot, runtime) {
  const actual = await validationIdentity(candidateRoot, workspaceRoot, runtime);
  for (const key of Object.keys(actual)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(frozen[key])) throw new Error(`candidate drift: ${key}`);
  }
  return actual;
}

export async function verifyNativeToolchain(native) {
  if (hash(await readFile(native.compiler)) !== native.compilerSha256) throw new Error("native toolchain drift: compiler bytes");
  if ((await execute(native.compiler, ["--version"])).stdout !== native.toolchain) throw new Error("native toolchain drift: compiler version");
  if ((await execute("/usr/bin/xcrun", ["--show-sdk-path"])).stdout.trim() !== native.sdk) throw new Error("native toolchain drift: SDK");
}

export async function validationResultDirectory(root, name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(name)) throw new Error("invalid validation run name");
  const directory = path.join(root, name);
  await mkdir(directory); // exclusive: a repeated name never overwrites evidence
  return directory;
}

function evidenceEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:HOME|TMPDIR|PATH|ILV2_(?:RUN_ROOT|RUNTIME_MANIFEST|NODE_BIN|TOOLCHAINS)|JAVA_LSP_(?:ISOLATED_VALIDATION|CACHE_ROOT|SERVICE_STATE_ROOT)|GRADLE_USER_HOME|MAVEN_USER_HOME|JDTLS_(?:BIN|DATA_DIR|LOG_DIR))$/.test(key)));
}

export async function recordValidationCommand(directory, command, args, { cwd, env }, index = 0) {
  const fixtureEvidence = path.join(directory, `${index}.evidence`);
  await mkdir(fixtureEvidence);
  env = { ...env, ILV2_EVIDENCE_ROOT: fixtureEvidence };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const outputFile = path.join(directory, `${index}.stdout.txt`), errorFile = path.join(directory, `${index}.stderr.txt`);
  const stdoutFd = openSync(outputFile, "wx"), stderrFd = openSync(errorFile, "wx");
  const running = { status: "IN_PROGRESS", argv: [command, ...args], cwd, fixtureEvidence, environment: evidenceEnvironment(env), startedAt,
    stdout: `${index}.stdout.txt`, stderr: `${index}.stderr.txt`, pid: null, exitCode: null };
  await writeJson(path.join(directory, `${index}.command.json`), running);
  let failure, pid;
  const outcome = await new Promise(resolve => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    pid = child.pid;
    writeFileSync(path.join(directory, `${index}.command.json`), JSON.stringify({ ...running, pid: pid ?? null }) + "\n");
    child.stdout.on("data", chunk => { writeSync(stdoutFd, chunk); process.stdout.write(chunk); });
    child.stderr.on("data", chunk => { writeSync(stderrFd, chunk); process.stderr.write(chunk); });
    child.once("error", error => { failure = error.message; });
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  closeSync(stdoutFd); closeSync(stderrFd);
  const output = await readFile(outputFile), errors = await readFile(errorFile);
  const record = { ...running, status: failure || outcome.exitCode !== 0 ? "FAIL" : "PASS", pid: pid ?? null,
    endedAt: new Date().toISOString(), elapsedMs: performance.now() - started, ...outcome,
    error: failure ?? null, stdout: `${index}.stdout.txt`, stderr: `${index}.stderr.txt`,
    stdoutSha256: hash(output), stderrSha256: hash(errors) };
  await writeJson(path.join(directory, `${index}.command.json`), record);
  if (failure || outcome.exitCode !== 0) throw Object.assign(new Error(failure ?? `${command} exited with ${outcome.exitCode} (${outcome.signal ?? "no signal"})`), { commandRecord: record });
  return record;
}

export function tapCounts(text) {
  const counts = Object.fromEntries([...text.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(([, key, value]) => [key, Number(value)]));
  return Object.keys(counts).length ? counts : null;
}

export function compactValidationIdentity(identity) {
  if (!identity) return null;
  return { sourceDigest: identity.source, runtimeManifestSha256: identity.runtime?.runtimeManifestSha256 ?? null,
    nativeSha256: identity.native?.binarySha256 ?? null, nativeSourceDigest: identity.native?.sourceDigest ?? null,
    buildStampSha256: identity.build ? hash(JSON.stringify(identity.build)) : null,
    distInventorySha256: identity.dist?.sha256 ?? null, dependencySha256: identity.dependencies?.sha256 ?? null };
}

// RAW validation directories are archived and deleted at gate closeout; this
// LOCAL index keeps the compact facts that task-result.json is generated from.
export async function appendValidationIndex(runRoot, { name, directory, validationRoot, identity, commands, mainError }) {
  const rows = [];
  for (const record of commands) {
    rows.push({ argv: record.argv, exitCode: record.exitCode ?? null, signal: record.signal ?? null, elapsedMs: record.elapsedMs ?? null,
      startedAt: record.startedAt, endedAt: record.endedAt ?? null, pid: record.pid ?? null,
      stdoutSha256: record.stdoutSha256 ?? null, stderrSha256: record.stderrSha256 ?? null,
      tap: tapCounts(await readFile(path.join(directory, record.stdout), "utf8")) });
  }
  const entry = { schema: "ilv2-validation-index/v1", name, status: mainError ? "FAIL" : "SELECTED_COMMANDS_PASSED", mainError: mainError?.message ?? null,
    result: path.relative(runRoot, path.join(directory, "result.json")), validationRoot, identity: compactValidationIdentity(identity), commands: rows };
  await appendFile(path.join(runRoot, "validation-index.jsonl"), `${JSON.stringify(entry)}\n`);
  return entry;
}

export async function registeredReuseRoot(runRoot, brokerRoot) {
  if (!runRoot || (await readFile(path.join(runRoot, "run-root.txt"), "utf8")).trim() !== path.resolve(runRoot)) throw new Error("reuse requires preregistered ILV2_RUN_ROOT");
  const validationRoot = await managedPath(path.join(runRoot, "tmp"), path.resolve(brokerRoot));
  if (validationRoot !== path.resolve(brokerRoot)) throw new Error("reuse broker symlink rejected");
  const broker = await readJson(path.join(validationRoot, "broker-root.json"));
  if (broker.root !== validationRoot || broker.parentRunRoot !== runRoot) throw new Error("broker ownership mismatch");
  return validationRoot;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  let runtime;
  let validationRoot;
  if (cli.reuse) {
    validationRoot = await registeredReuseRoot(process.env.ILV2_RUN_ROOT, cli.reuse);
  } else validationRoot = await createRegisteredBrokerRoot("codex-java-lsp-isolated-validation-");
  const candidateRoot = path.join(validationRoot, "candidate");
  if (cli.reuse && await managedPath(validationRoot, candidateRoot) !== candidateRoot) throw new Error("candidate symlink rejected");
  const evidenceRoot = process.env.ILV2_RUN_ROOT
    ? await managedPath(process.env.ILV2_RUN_ROOT, path.join(process.env.ILV2_RUN_ROOT, "raw", "validation"))
    : path.join(validationRoot, "results");
  await mkdir(evidenceRoot, { recursive: true });
  const directory = await validationResultDirectory(evidenceRoot, cli.name ?? `${Date.now()}-${randomUUID()}`);
  let identity, mainError, cleanupError, index = 0;
  const commands = [];
  const invoke = async (command, args, options) => {
    try { const record = await recordValidationCommand(directory, command, args, options, index++); commands.push(record); return record; }
    catch (error) { if (error.commandRecord) commands.push(error.commandRecord); throw error; }
  };
  try {
    runtime = await verifyRuntime();
    let env;
    if (cli.reuse) {
      const frozen = await readJson(path.join(validationRoot, "validation-candidate.json"));
      if (frozen.schema !== "ilv2-validation-candidate/v1" || frozen.workspaceRoot !== sourceRoot || frozen.candidateRoot !== candidateRoot) throw new Error("candidate root mismatch");
      identity = await verifyValidationIdentity(frozen.identity, candidateRoot, sourceRoot, runtime);
      await verifyNativeToolchain(identity.native);
      env = isolatedValidationEnvironment(validationRoot, { ...frozen.environment, ...cli.environment });
    } else {
      await Promise.all(["home", "cache", "xdg-cache", "xdg-config", "xdg-data", "xdg-state", "maven-home", "tmp"].map(name => mkdir(path.join(validationRoot, name), { recursive: true })));
      await writeFile(path.join(validationRoot, "projects.json"), '{"aliases":[],"defaults":{}}\n');
      const snapshot = await captureCandidatePatch(sourceRoot);
      const patchFile = path.join(validationRoot, "candidate.patch");
      await writeFile(patchFile, snapshot.patch);
      const sourceCommit = (await capture("git", ["-C", sourceRoot, "rev-parse", "HEAD^{commit}"])).trim();
      await createDetachedLocalClone(sourceRoot, candidateRoot, sourceCommit, run);
      if (snapshot.patch.length) await run("git", ["-C", candidateRoot, "apply", "--index", patchFile]);
      const before = await dependencyTreeInventory(path.join(sourceRoot, "node_modules"));
      const isolatedNodeModules = await copyIsolatedNodeModules(sourceRoot, validationRoot);
      if (!sameDependencyInventory(before, await dependencyTreeInventory(isolatedNodeModules))) throw new Error("isolated dependency copy does not match source node_modules");
      await symlink(isolatedNodeModules, path.join(candidateRoot, "node_modules"), "dir");
      env = isolatedValidationEnvironment(validationRoot, cli.environment);
      for (const args of [[path.join(candidateRoot, "node_modules", ".bin", "tsc"), "-p", path.join(candidateRoot, "tsconfig.json")],
        [path.join(candidateRoot, "scripts", "build-macos-native.mjs")], [path.join(candidateRoot, "scripts", "write-build-stamp.mjs")]]) {
        await invoke(process.execPath, args, { cwd: candidateRoot, env });
      }
      identity = await validationIdentity(candidateRoot, sourceRoot, runtime);
      if (identity.source !== identity.candidateSource) throw new Error("candidate source does not match workspace");
      await writeJson(path.join(validationRoot, "validation-candidate.json"), { schema: "ilv2-validation-candidate/v1", workspaceRoot: sourceRoot, candidateRoot, identity, environment: cli.environment });
    }
    const dependencyInventoryFile = path.join(validationRoot, "dependency-inventory.json");
    await writeJson(dependencyInventoryFile, identity.dependencies);
    env.JAVA_LSP_ISOLATED_DEPENDENCY_INVENTORY_FILE = dependencyInventoryFile;
    if (cli.profile === "full") {
      for (const glob of ["dist/**/*.test.js", "scripts/*.test.mjs"]) await invoke(process.execPath, expandCandidateTestGlobs(["--test", "--test-concurrency=1", glob], candidateRoot), { cwd: candidateRoot, env });
      await invoke(process.execPath, [path.join(candidateRoot, "dist", "smoke.js")], { cwd: candidateRoot, env: { ...env, JAVA_LSP_SMOKE_REPO_ROOT: candidateRoot, JAVA_LSP_SMOKE_START: "false" } });
    }
    if (cli.command.length) {
      const command = bindCandidateNodeCommand(cli.command, { candidateRoot, stateRoot: validationRoot });
      await invoke(command[0], command.slice(1), { cwd: candidateRoot, env });
    }
    await verifyValidationIdentity(identity, candidateRoot, sourceRoot, await verifyRuntime());
    await verifyNativeToolchain(identity.native);
  } catch (error) { mainError = error; }
  finally {
    // Only the gate closeout can prove descendants/launchd/Gradle have exited.
    // Retain the registered broker here; deleting it on command exit would erase
    // diagnostic evidence and could unlink files still owned by descendants.
    try {
      await writeJson(path.join(directory, "result.json"), { schema: "ilv2-validation-result/v1", validationRoot, candidateRoot, identity: identity ?? null,
      status: mainError ? "FAIL" : "SELECTED_COMMANDS_PASSED", gateStatus: "NOT_CLAIMED", commandCount: index,
      mainError: mainError?.message ?? null, cleanupError: cleanupError?.message ?? null, cleanupStatus: "PENDING_GATE_CLOSEOUT" });
    } catch (error) {
      cleanupError = error;
      console.error(JSON.stringify({ mainError: mainError?.message ?? null, evidenceError: error.message }));
    }
    if (process.env.ILV2_RUN_ROOT && !cleanupError) {
      try { await appendValidationIndex(process.env.ILV2_RUN_ROOT, { name: path.basename(directory), directory, validationRoot, identity, commands, mainError }); }
      catch (error) { cleanupError = error; console.error(JSON.stringify({ indexError: error.message })); }
    }
    let resultFile = path.join(directory, "result.json");
    if (!process.env.ILV2_RUN_ROOT && !cli.keep && !cli.reuse && !mainError && !cleanupError) {
      try { await rm(validationRoot, { recursive: true, force: true }); resultFile = null; }
      catch (error) {
        cleanupError = error;
        const record = await readJson(resultFile);
        await writeJson(resultFile, { ...record, cleanupError: error.message, cleanupStatus: "FAILED" });
      }
    }
    console.log(JSON.stringify({ validationRoot, result: resultFile, gateStatus: "NOT_CLAIMED", cleanupError: cleanupError?.message ?? null }));
  }
  if (mainError) throw mainError;
  if (cleanupError) throw cleanupError;
}

function parseCli(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator >= 0 ? args.slice(0, separator) : args;
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  let profile = "targeted";
  let keep = false;
  let reuse, name;
  const environment = {};
  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--keep") {
      keep = true;
      continue;
    }
    if (arg === "--profile") {
      profile = optionArgs[++index];
      continue;
    }
    if (arg === "--reuse" || arg === "--name") {
      const value = optionArgs[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--reuse") reuse = value; else name = value;
      continue;
    }
    if (arg === "--env") {
      const entry = optionArgs[++index];
      const equals = entry?.indexOf("=") ?? -1;
      if (equals <= 0) throw new Error("--env requires NAME=VALUE");
      environment[entry.slice(0, equals)] = entry.slice(equals + 1);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!new Set(["compile", "targeted", "full"]).has(profile)) {
    throw new Error("--profile must be compile, targeted or full");
  }
  if (profile === "targeted" && command.length === 0) throw new Error("targeted validation requires a command after --");
  return { profile, keep, reuse, name, environment, command };
}

function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env ?? process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`)));
  });
}

function printUsage() {
  console.log("Usage: node scripts/run-isolated-validation.mjs [--keep | --reuse BROKER_ROOT] [--name UNIQUE_NAME] --profile compile|full | --profile targeted -- COMMAND [ARGS...]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

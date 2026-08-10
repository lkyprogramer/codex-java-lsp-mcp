#!/usr/bin/env node
// input: The current source worktree plus either a targeted command or the full local validation profile.
// output: Validation executed in a detached patched local clone with isolated caches and JDT disabled.
// pos: Mandatory safety boundary between development validation and the user's active LSP runtime.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureCandidatePatch } from "./run-three-repo-cold-matrix.mjs";
import {
  bindCandidateNodeCommand,
  copyIsolatedNodeModules,
  createDetachedLocalClone,
  dependencyTreeInventory,
  sameDependencyInventory,
  scrubHostNodeRuntimeState
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
    GRADLE_USER_HOME: path.join(root, "gradle-home"),
    MAVEN_USER_HOME: path.join(root, "maven-home"),
    JAVA_LSP_ISOLATED_VALIDATION: "1",
    JDTLS_BIN: typeof overrides.JDTLS_BIN === "string" ? overrides.JDTLS_BIN : "/usr/bin/false"
  };
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

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  const validationRoot = await mkdtemp(path.join(os.tmpdir(), "codex-java-lsp-isolated-validation-"));
  const candidateRoot = path.join(validationRoot, "candidate");
  const patchFile = path.join(validationRoot, "candidate.patch");
  try {
    await Promise.all([
      mkdir(path.join(validationRoot, "home"), { recursive: true }),
      mkdir(path.join(validationRoot, "cache"), { recursive: true }),
      mkdir(path.join(validationRoot, "xdg-cache"), { recursive: true }),
      mkdir(path.join(validationRoot, "xdg-config"), { recursive: true }),
      mkdir(path.join(validationRoot, "xdg-data"), { recursive: true }),
      mkdir(path.join(validationRoot, "xdg-state"), { recursive: true }),
      mkdir(path.join(validationRoot, "gradle-home"), { recursive: true }),
      mkdir(path.join(validationRoot, "maven-home"), { recursive: true }),
      mkdir(path.join(validationRoot, "tmp"), { recursive: true }),
      writeFile(path.join(validationRoot, "projects.json"), "{\"aliases\":[],\"defaults\":{}}\n")
    ]);
    const snapshot = await captureCandidatePatch(sourceRoot);
    await writeFile(patchFile, snapshot.patch);
    const sourceCommit = (await capture("git", ["-C", sourceRoot, "rev-parse", "HEAD^{commit}"])).trim();
    await createDetachedLocalClone(sourceRoot, candidateRoot, sourceCommit, run);
    if (snapshot.patch.length > 0) {
      await run("git", ["-C", candidateRoot, "apply", "--index", patchFile]);
    }
    const sourceDependencyInventory = await dependencyTreeInventory(path.join(sourceRoot, "node_modules"));
    const isolatedNodeModules = await copyIsolatedNodeModules(sourceRoot, validationRoot);
    const isolatedDependencyInventory = await dependencyTreeInventory(isolatedNodeModules);
    if (!sameDependencyInventory(sourceDependencyInventory, isolatedDependencyInventory)) {
      throw new Error("isolated dependency copy does not match source node_modules");
    }
    const nodeModules = path.join(candidateRoot, "node_modules");
    if (!existsSync(nodeModules)) await symlink(isolatedNodeModules, nodeModules, "dir");
    const env = isolatedValidationEnvironment(validationRoot, cli.environment);
    const executableTree = (await capture("git", ["-C", candidateRoot, "write-tree"])).trim();
    console.log(JSON.stringify({
      isolation: "detached-local-clone",
      candidateRoot,
      cacheRoot: env.JAVA_LSP_CACHE_ROOT,
      jdtlsBin: env.JDTLS_BIN,
      executableTree
    }));
    await run(process.execPath, [path.join(candidateRoot, "node_modules", ".bin", "tsc"), "-p", path.join(candidateRoot, "tsconfig.json")], { cwd: candidateRoot, env });
    await run(process.execPath, [path.join(candidateRoot, "scripts", "write-build-stamp.mjs")], { cwd: candidateRoot, env });
    if (cli.profile === "full") {
      await run(process.execPath, ["--test", "--test-concurrency=1", "dist/**/*.test.js"], { cwd: candidateRoot, env });
      await run(process.execPath, ["--test", "--test-concurrency=1", "scripts/*.test.mjs"], { cwd: candidateRoot, env });
      await run(process.execPath, [path.join(candidateRoot, "dist", "smoke.js")], {
        cwd: candidateRoot,
        env: {
          ...env,
          JAVA_LSP_SMOKE_REPO_ROOT: candidateRoot,
          JAVA_LSP_SMOKE_START: "false"
        }
      });
    }
    if (cli.command.length > 0) {
      const command = bindCandidateNodeCommand(cli.command, { candidateRoot, stateRoot: validationRoot });
      await run(command[0], command.slice(1), { cwd: candidateRoot, env });
    }
    const dependencyInventoryAfter = await dependencyTreeInventory(isolatedNodeModules);
    if (!sameDependencyInventory(isolatedDependencyInventory, dependencyInventoryAfter)) {
      throw new Error("isolated validation mutated its private node_modules");
    }
  } finally {
    if (!cli.keep) await rm(validationRoot, { recursive: true, force: true });
    else console.log(`preserved isolated validation root: ${validationRoot}`);
  }
}

function parseCli(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator >= 0 ? args.slice(0, separator) : args;
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  let profile = "targeted";
  let keep = false;
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
  return { profile, keep, environment, command };
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
  console.log("Usage: node scripts/run-isolated-validation.mjs --profile compile|full | --profile targeted -- COMMAND [ARGS...]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

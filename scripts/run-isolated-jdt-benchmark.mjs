#!/usr/bin/env node
// input: A source Java repository, an exact revision, and a benchmark command containing optional {repo} placeholders.
// output: The command executed against a detached Java local clone with private JDT/cache/config/temp state.
// pos: Mandatory second isolation boundary for any validation that starts a real JDT process.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createDetachedLocalClone,
  scrubHostNodeRuntimeState,
  validateCandidateNodeCommand
} from "./isolation-utils.mjs";

const ISOLATED_STATE_FLAGS = new Set([
  "--index-cache-dir",
  "--cache-dir",
  "--output",
  "--output-dir",
  "--artifact-root"
]);

export function isolatedJdtBenchmarkEnvironment(root, repoRoot, overrides = {}) {
  const safeOverrides = { ...overrides };
  for (const protectedName of [
    "HOME",
    "JAVA_LSP_CACHE_ROOT",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "TMPDIR",
    "JDTLS_DATA_DIR",
    "JDTLS_LOG_DIR",
    "JAVA_LSP_PROJECTS_JSON",
    "JAVA_LSP_ISOLATED_VALIDATION",
    "JAVA_LSP_ISOLATED_REPO_WORKTREE",
    "JAVA_LSP_REPO_ROOT",
    "JAVA_LSP_BENCH_REPO_ROOT",
    "JAVA_LSP_BENCH_INDEX_CACHE_DIR",
    "JAVA_LSP_SMOKE_REPO_ROOT",
    "JAVA_LSP_TEST_REPO_ROOT",
    "JAVA_LSP_ISOLATED_REPO_ROOT",
    "JDTLS_EXTRA_ARGS",
    "JAVA_LSP_RESOURCE_TELEMETRY_FILE",
    "JAVA_LSP_RESOURCE_INTERVAL_MS",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "MAVEN_OPTS",
    "GRADLE_OPTS",
    "GRADLE_USER_HOME",
    "MAVEN_USER_HOME",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_REPL_HISTORY",
    "NODE_V8_COVERAGE",
    "NODE_COMPILE_CACHE",
    "NODE_REDIRECT_WARNINGS"
  ]) {
    delete safeOverrides[protectedName];
  }
  const isolatedUserHomeArg = `--jvm-arg=-Duser.home=${path.join(root, "jdt-home")}`;
  const environment = {
    ...process.env,
    ...safeOverrides,
    HOME: path.join(root, "jdt-home"),
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
    JAVA_LSP_ISOLATED_REPO_WORKTREE: "1",
    JAVA_LSP_ISOLATED_REPO_ROOT: repoRoot,
    JAVA_LSP_REPO_ROOT: repoRoot,
    JAVA_LSP_BENCH_REPO_ROOT: repoRoot,
    JAVA_LSP_SMOKE_REPO_ROOT: repoRoot,
    JAVA_LSP_TEST_REPO_ROOT: repoRoot,
    JDTLS_EXTRA_ARGS: isolatedUserHomeArg
  };
  delete environment.JAVA_LSP_RESOURCE_TELEMETRY_FILE;
  delete environment.JAVA_LSP_RESOURCE_INTERVAL_MS;
  for (const inherited of [
    "JAVA_LSP_BENCH_INDEX_CACHE_DIR",
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
    delete environment[inherited];
  }
  return scrubHostNodeRuntimeState(environment);
}

export function replaceRepoPlaceholder(values, repoRoot, isolationRoot = path.dirname(repoRoot)) {
  return values.map(value => value.replaceAll("{repo}", repoRoot).replaceAll("{state}", isolationRoot));
}

export function bindCommandToIsolatedRepository(values, repoRoot, isolationRoot = path.dirname(repoRoot)) {
  validateCandidateNodeCommand(values);
  if (values.some(value => value.startsWith("--repo-root="))) {
    throw new Error("isolated JDT benchmark command must not use --repo-root=<value>");
  }
  const repoRootIndexes = values
    .map((value, index) => value === "--repo-root" ? index : -1)
    .filter(index => index >= 0);
  if (repoRootIndexes.length !== 1 || values[repoRootIndexes[0] + 1] !== "{repo}") {
    throw new Error("isolated JDT benchmark command must pass exactly one --repo-root {repo}");
  }
  const repoRootIndex = repoRootIndexes[0];
  for (let index = 0; index < values.length; index += 1) {
    if ([...ISOLATED_STATE_FLAGS].some(flag => values[index].startsWith(`${flag}=`))) {
      throw new Error("isolated JDT benchmark state paths must use a separate flag and {repo} or {state} placeholder");
    }
    if (!ISOLATED_STATE_FLAGS.has(values[index])) continue;
    const rawPath = values[index + 1];
    if (!(rawPath?.includes("{repo}") || rawPath?.includes("{state}"))) {
      throw new Error(`${values[index]} must use a {repo} or {state} placeholder`);
    }
  }
  const command = replaceRepoPlaceholder(values, repoRoot, isolationRoot);
  if (path.resolve(command[repoRootIndex + 1]) !== path.resolve(repoRoot)) {
    throw new Error("benchmark command repo root does not match the detached Java clone");
  }
  for (let index = 0; index < command.length; index += 1) {
    if (!ISOLATED_STATE_FLAGS.has(command[index])) continue;
    const target = path.resolve(command[index + 1]);
    if (!isWithin(repoRoot, target) && !isWithin(isolationRoot, target)) {
      throw new Error(`${command[index]} must stay inside the isolated Java repository or state root`);
    }
  }
  return command;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("run-isolated-jdt-benchmark must itself run inside run-isolated-validation.mjs");
  }
  const sourceRepo = path.resolve(cli.repoRoot);
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-java-lsp-isolated-jdt-"));
  const detachedRepo = path.join(root, "repo");
  try {
    await Promise.all([
      mkdir(path.join(root, "cache"), { recursive: true }),
      mkdir(path.join(root, "xdg-cache"), { recursive: true }),
      mkdir(path.join(root, "xdg-config"), { recursive: true }),
      mkdir(path.join(root, "xdg-data"), { recursive: true }),
      mkdir(path.join(root, "xdg-state"), { recursive: true }),
      mkdir(path.join(root, "tmp"), { recursive: true }),
      mkdir(path.join(root, "jdt-home"), { recursive: true }),
      mkdir(path.join(root, "gradle-home"), { recursive: true }),
      mkdir(path.join(root, "maven-home"), { recursive: true }),
      writeFile(path.join(root, "projects.json"), "{\"aliases\":[],\"defaults\":{}}\n")
    ]);
    const requestedRevision = (await capture("git", ["-C", sourceRepo, "rev-parse", `${cli.revision}^{commit}`])).trim();
    await createDetachedLocalClone(sourceRepo, detachedRepo, requestedRevision, run);
    const observedRevision = (await capture("git", ["-C", detachedRepo, "rev-parse", "HEAD^{commit}"])).trim();
    const status = await capture("git", ["-C", detachedRepo, "status", "--porcelain"]);
    if (status.trim()) throw new Error("detached benchmark repository is not clean");
    const env = isolatedJdtBenchmarkEnvironment(root, detachedRepo, cli.environment);
    const command = bindCommandToIsolatedRepository(cli.command, detachedRepo, root);
    console.log(JSON.stringify({
      isolation: "detached-code-and-java-local-clones",
      sourceRepo,
      repoRoot: detachedRepo,
      repoCommit: observedRevision,
      cacheRoot: env.JAVA_LSP_CACHE_ROOT,
      dataDir: env.JDTLS_DATA_DIR,
      logDir: env.JDTLS_LOG_DIR,
      jdtlsBin: env.JDTLS_BIN ?? "UNRESOLVED"
    }));
    await run(command[0], command.slice(1), { cwd: process.cwd(), env });
  } finally {
    if (!cli.keep) await rm(root, { recursive: true, force: true });
    else console.log(`preserved isolated JDT benchmark root: ${root}`);
  }
}

function parseCli(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator >= 0 ? args.slice(0, separator) : args;
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  const environment = {};
  let repoRoot;
  let revision = "HEAD";
  let keep = false;
  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--keep") {
      keep = true;
      continue;
    }
    if (arg === "--repo-root") {
      repoRoot = optionArgs[++index];
      continue;
    }
    if (arg === "--revision") {
      revision = optionArgs[++index];
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
  if (!repoRoot) throw new Error("--repo-root is required");
  if (!existsSync(repoRoot)) throw new Error(`repository does not exist: ${repoRoot}`);
  if (command.length === 0) throw new Error("a benchmark command is required after --");
  return { repoRoot, revision, keep, environment, command };
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
  console.log("Usage: node scripts/run-isolated-jdt-benchmark.mjs --repo-root PATH [--revision SHA] [--env NAME=VALUE] -- COMMAND [ARGS with {repo}/{state}]");
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

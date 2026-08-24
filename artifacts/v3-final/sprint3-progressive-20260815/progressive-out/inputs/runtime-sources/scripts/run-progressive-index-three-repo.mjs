#!/usr/bin/env node
// input: The isolated candidate runtime, three clean Java repositories and a frozen progressive scenario lock.
// output: Fifteen fresh-cache progressive attempts plus a hash-bound manifest and integrity summary.
// pos: Formal V3.2-16 quiet baseline/candidate runner; never uses the active runtime or its caches.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createDetachedLocalClone,
  dependencyTreeInventory
} from "./isolation-utils.mjs";
import {
  assertCleanRepository,
  assertOutputOutsideSource,
  isolatedChildEnvironment,
  matrixRuntimeEnvironment
} from "./run-three-repo-cold-matrix.mjs";
import {
  PROGRESSIVE_PROJECTS,
  PROGRESSIVE_RUNS,
  PROGRESSIVE_VERIFIER_VERSION,
  verifyProgressiveManifest
} from "./verify-progressive-index.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_LOCK_FILES = [
  "src/benchmark/progressive-index.ts",
  "src/benchmark/java-index-idle.ts",
  "scripts/run-progressive-index.mjs",
  "scripts/run-progressive-index-three-repo.mjs",
  "scripts/verify-progressive-index.mjs"
];

export function parseProgressiveMatrixCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  const runs = Number(options.get("--runs") ?? PROGRESSIVE_RUNS);
  const generation = positiveInteger(options.get("--generation") ?? "1", "--generation");
  const pollMs = positiveInteger(options.get("--poll-ms") ?? "50", "--poll-ms");
  const timeoutMs = positiveInteger(options.get("--timeout-ms") ?? "180000", "--timeout-ms");
  if (runs !== PROGRESSIVE_RUNS) throw new Error(`formal progressive gate requires --runs ${PROGRESSIVE_RUNS}`);
  return {
    candidateRoot: options.get("--candidate-root") ?? scriptRoot,
    outputDir: required(options.get("--output-dir"), "--output-dir"),
    scenarioLock: options.get("--scenario-lock") ?? "golden/progressive-index-v1.json",
    runs,
    generation,
    pollMs,
    timeoutMs,
    repositories: {
      lishuedu: required(options.get("--lishuedu"), "--lishuedu"),
      cipherlink: required(options.get("--cipherlink"), "--cipherlink"),
      "exam-parent-v3": required(options.get("--exam-parent-v3"), "--exam-parent-v3")
    }
  };
}

export function validateProgressiveScenarioDocument(document) {
  if (document?.schemaVersion !== 1 || !Array.isArray(document.scenarios)) {
    throw new Error("progressive scenario lock must use schemaVersion 1");
  }
  const projects = document.scenarios.map(item => item?.projectId).sort();
  if (JSON.stringify(projects) !== JSON.stringify([...PROGRESSIVE_PROJECTS].sort())) {
    throw new Error("progressive scenario lock must contain exactly one scenario per formal project");
  }
  for (const scenario of document.scenarios) {
    if (!/^[a-f0-9]{40}$/.test(scenario.repoCommit ?? "") || !scenario.anchorScenarioId
      || !scenario.anchor?.file || !Array.isArray(scenario.requiredTypeDefinitions)
      || scenario.requiredTypeDefinitions.length === 0 || !scenario.missingTypeFqn) {
      throw new Error(`progressive scenario ${scenario.projectId ?? "unknown"} is incomplete`);
    }
  }
  return document;
}

export function progressiveAttemptEnvironment(root) {
  return isolatedChildEnvironment(matrixRuntimeEnvironment(root, "0"));
}

// runtimeRoot/node_modules is a symlink onto the same directory the isolated
// validation wrapper already hashed before invoking this script; reuse that
// result instead of paying a second full-tree hash walk here.
async function dependenciesInventory(runtimeRoot) {
  const precomputed = process.env.JAVA_LSP_ISOLATED_DEPENDENCY_INVENTORY_FILE;
  if (precomputed) return JSON.parse(await readFile(precomputed, "utf8"));
  return dependencyTreeInventory(path.join(runtimeRoot, "node_modules"));
}

async function main() {
  const cli = parseProgressiveMatrixCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("progressive three-repository runner must run inside isolated validation");
  }
  const runtimeRoot = path.resolve(cli.candidateRoot);
  const outputDir = path.resolve(cli.outputDir);
  const scenarioSource = path.resolve(runtimeRoot, cli.scenarioLock);
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-java-lsp-progressive-"));
  try {
    await preflight(runtimeRoot, outputDir, scenarioSource, cli.repositories);
    await mkdir(outputDir, { recursive: false });
    const inputDir = path.join(outputDir, "inputs");
    const rawDir = path.join(outputDir, "raw");
    const logDir = path.join(outputDir, "logs");
    await Promise.all([mkdir(inputDir), mkdir(rawDir), mkdir(logDir)]);

    const scenarioTarget = path.join(inputDir, "progressive-index-v1.json");
    await copyFile(scenarioSource, scenarioTarget);
    const scenarioDocument = validateProgressiveScenarioDocument(JSON.parse(await readFile(scenarioTarget, "utf8")));
    const scenarioLock = await descriptor(outputDir, scenarioTarget);

    const runtimePatchFile = path.join(inputDir, "runtime.patch");
    const runtimePatch = await capture("git", ["-C", runtimeRoot, "diff", "HEAD", "--binary"]);
    await writeFile(runtimePatchFile, runtimePatch, { flag: "wx" });
    const untrackedSource = (await capture("git", ["-C", runtimeRoot, "ls-files", "--others", "--exclude-standard"]))
      .split(/\r?\n/).filter(Boolean).filter(item => /^(?:src|scripts|golden|fixtures)\//.test(item));
    if (untrackedSource.length > 0) {
      throw new Error(`isolated candidate contains unbound source inputs: ${untrackedSource.join(", ")}`);
    }

    const sourceFiles = [];
    for (const relativeFile of [...SOURCE_LOCK_FILES, path.relative(runtimeRoot, scenarioSource)]) {
      const source = path.resolve(runtimeRoot, relativeFile);
      if (!isWithin(runtimeRoot, source)) throw new Error(`source lock file escapes runtime: ${relativeFile}`);
      const target = path.join(inputDir, "runtime-sources", relativeFile);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
      sourceFiles.push(await descriptor(outputDir, target));
    }

    const repositories = {};
    const isolatedRepositories = {};
    for (const project of PROGRESSIVE_PROJECTS) {
      const source = await assertCleanRepository(path.resolve(cli.repositories[project]), project);
      const scenario = scenarioDocument.scenarios.find(item => item.projectId === project);
      if (source.head !== scenario.repoCommit) {
        throw new Error(`${project} HEAD does not match progressive scenario lock`);
      }
      const target = path.join(workspaceRoot, "repositories", project);
      await mkdir(path.dirname(target), { recursive: true });
      await createDetachedLocalClone(source.root, target, source.head, run);
      const isolated = await assertCleanRepository(target, project);
      if (isolated.head !== source.head || isolated.tree !== source.tree) {
        throw new Error(`${project} isolated clone identity mismatch`);
      }
      repositories[project] = {
        sourceRoot: source.root,
        head: source.head,
        tree: source.tree,
        statusSha256: source.statusSha256
      };
      isolatedRepositories[project] = target;
    }

    const runtime = {
      commit: (await capture("git", ["-C", runtimeRoot, "rev-parse", "HEAD^{commit}"])).trim(),
      commitTree: (await capture("git", ["-C", runtimeRoot, "rev-parse", "HEAD^{tree}"])).trim(),
      executableTree: (await capture("git", ["-C", runtimeRoot, "write-tree"])).trim(),
      statusSha256: sha256(await capture("git", ["-C", runtimeRoot, "status", "--porcelain=v1", "--untracked-files=all"])),
      changedPaths: (await capture("git", ["-C", runtimeRoot, "diff", "--name-only", "HEAD"]))
        .split(/\r?\n/).filter(Boolean).sort(),
      patch: await descriptor(outputDir, runtimePatchFile),
      buildStamp: JSON.parse(await readFile(path.join(runtimeRoot, "dist", "build-stamp.json"), "utf8")),
      dependencies: await dependenciesInventory(runtimeRoot)
    };

    const protocol = {
      runs: cli.runs,
      generation: cli.generation,
      pollMs: cli.pollMs,
      timeoutMs: cli.timeoutMs,
      cache: "EMPTY_PRIVATE_PER_ATTEMPT",
      percentile: "nearest-rank-ceil",
      jdtlsDisabled: true,
      runtimeState: "PRIVATE_PER_ATTEMPT",
      scope: "QUIET_PROGRESSIVE_ONLY_STORM_GATE_SEPARATE"
    };
    const runPlanFile = path.join(outputDir, "progressive-run-plan.json");
    await writeFile(runPlanFile, `${JSON.stringify({
      schemaVersion: 1,
      kind: "v32-progressive-index-run-plan",
      verifierVersion: PROGRESSIVE_VERIFIER_VERSION,
      createdAt: new Date().toISOString(),
      runtime,
      scenarioLock: { ...scenarioLock, projectIds: PROGRESSIVE_PROJECTS },
      sourceFiles,
      repositories,
      protocol
    }, null, 2)}\n`, { flag: "wx" });
    const runPlan = await descriptor(outputDir, runPlanFile);

    const artifacts = [];
    const cacheIdentities = new Set();
    const runtimeStateIdentities = new Set();
    for (const project of PROGRESSIVE_PROJECTS) {
      for (let runIndex = 1; runIndex <= cli.runs; runIndex += 1) {
        const attemptId = `${project}-r${runIndex}`;
        const stateRoot = path.join(workspaceRoot, "attempt-state", attemptId);
        const cacheDir = path.join(workspaceRoot, "index-cache", attemptId);
        const rawFile = path.join(rawDir, `${attemptId}.json`);
        const stdoutFile = path.join(logDir, `${attemptId}.stdout`);
        const stderrFile = path.join(logDir, `${attemptId}.stderr`);
        const environment = progressiveAttemptEnvironment(stateRoot);
        const cacheIdentity = sha256(path.resolve(cacheDir));
        const runtimeStateIdentity = sha256(path.resolve(stateRoot));
        if (cacheIdentities.has(cacheIdentity) || runtimeStateIdentities.has(runtimeStateIdentity)) {
          throw new Error(`progressive attempt state reused: ${attemptId}`);
        }
        cacheIdentities.add(cacheIdentity);
        runtimeStateIdentities.add(runtimeStateIdentity);
        await prepareRuntimeState(environment);
        await mkdir(path.dirname(cacheDir), { recursive: true });
        const exitCode = await runToFiles(process.execPath, [
          path.join(runtimeRoot, "scripts", "run-progressive-index.mjs"),
          "--repo-root", isolatedRepositories[project],
          "--project-id", project,
          "--scenario-lock", scenarioTarget,
          "--index-cache-dir", cacheDir,
          "--output", rawFile,
          "--generation", String(cli.generation),
          "--poll-ms", String(cli.pollMs),
          "--timeout-ms", String(cli.timeoutMs)
        ], stdoutFile, stderrFile, { cwd: runtimeRoot, env: environment });
        await stampAttempt(rawFile, {
          runPlanSha256: runPlan.sha256,
          project,
          run: runIndex,
          runtimeCommit: runtime.commit,
          runtimeCommitTree: runtime.commitTree,
          runtimeExecutableTree: runtime.executableTree,
          runtimePatchSha256: runtime.patch.sha256,
          repoHead: repositories[project].head,
          repoTree: repositories[project].tree,
          repoStatusSha256: repositories[project].statusSha256,
          scenarioLockSha256: scenarioLock.sha256,
          cachePolicy: protocol.cache,
          cacheIdentity,
          runtimeStateIdentity
        });
        artifacts.push({
          project,
          run: runIndex,
          exitCode,
          cacheIdentity,
          runtimeStateIdentity,
          raw: await descriptor(outputDir, rawFile),
          stdout: await descriptor(outputDir, stdoutFile),
          stderr: await descriptor(outputDir, stderrFile)
        });
      }
    }

    for (const project of PROGRESSIVE_PROJECTS) {
      const after = await assertCleanRepository(path.resolve(cli.repositories[project]), project);
      const before = repositories[project];
      if (after.head !== before.head || after.tree !== before.tree || after.statusSha256 !== before.statusSha256) {
        throw new Error(`${project} source repository changed during isolated progressive run`);
      }
    }

    const manifestFile = path.join(outputDir, "progressive-manifest.json");
    const manifest = {
      schemaVersion: 1,
      kind: "v32-progressive-index-three-repo",
      verifierVersion: PROGRESSIVE_VERIFIER_VERSION,
      createdAt: new Date().toISOString(),
      platform: { node: process.version, platform: process.platform, arch: process.arch },
      runtime,
      runPlan,
      scenarioLock: { ...scenarioLock, projectIds: PROGRESSIVE_PROJECTS },
      sourceFiles,
      repositories,
      protocol,
      artifacts
    };
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await writeFile(`${manifestFile}.sha256`, `${sha256(await readFile(manifestFile))}  progressive-manifest.json\n`, { flag: "wx" });
    const verification = verifyProgressiveManifest(manifestFile);
    const summaryFile = path.join(outputDir, "progressive-summary.json");
    await writeFile(summaryFile, `${JSON.stringify({ status: "BASELINE_RECORDED", ...verification }, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ manifestFile, summaryFile, status: "BASELINE_RECORDED", projects: verification.projects }, null, 2));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function preflight(runtimeRoot, outputDir, scenarioFile, repositories) {
  if (!existsSync(path.join(runtimeRoot, ".git")) || !existsSync(path.join(runtimeRoot, "node_modules"))) {
    throw new Error("progressive runtime must be an isolated Git checkout with private dependencies");
  }
  await readFile(scenarioFile);
  await assertOutputOutsideSource(runtimeRoot, outputDir);
  if (existsSync(outputDir)) throw new Error(`output directory already exists: ${outputDir}`);
  for (const repoRoot of Object.values(repositories)) {
    const canonicalRepo = await realpath(repoRoot);
    const canonicalParent = await realpath(path.dirname(outputDir));
    const canonicalOutput = path.join(canonicalParent, path.basename(outputDir));
    if (isWithin(canonicalRepo, canonicalOutput)) {
      throw new Error("progressive output must stay outside every Java repository");
    }
  }
}

async function prepareRuntimeState(environment) {
  await Promise.all([
    "HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "TMPDIR",
    "JAVA_LSP_CACHE_ROOT", "JDTLS_DATA_DIR", "JDTLS_LOG_DIR", "GRADLE_USER_HOME", "MAVEN_USER_HOME"
  ].map(name => mkdir(environment[name], { recursive: true })));
  await mkdir(path.dirname(environment.JAVA_LSP_PROJECTS_JSON), { recursive: true });
  await writeFile(environment.JAVA_LSP_PROJECTS_JSON, "{\"aliases\":[],\"defaults\":{}}\n", { flag: "wx" });
}

async function descriptor(root, file) {
  const bytes = await readFile(file);
  const relativeFile = path.relative(root, file).split(path.sep).join("/");
  if (relativeFile.startsWith("../") || path.isAbsolute(relativeFile)) throw new Error(`artifact escapes output root: ${file}`);
  return { file: relativeFile, bytes: bytes.length, sha256: sha256(bytes) };
}

async function stampAttempt(file, provenance) {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || !value.attempt) throw new Error(`${file}: invalid progressive attempt`);
  value.matrixProvenance = provenance;
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: isolatedChildEnvironment(env), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function runToFiles(command, args, stdoutFile, stderrFile, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const stdout = createWriteStream(stdoutFile, { flags: "wx" });
    const stderr = createWriteStream(stderrFile, { flags: "wx" });
    const stdoutFinished = finished(stdout);
    const stderrFinished = finished(stderr);
    const child = spawn(command, args, { cwd, env: isolatedChildEnvironment(env), stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.once("error", reject);
    child.once("exit", code => {
      stdout.end();
      stderr.end();
      Promise.all([stdoutFinished, stderrFinished]).then(() => resolve(code ?? 1), reject);
    });
  });
}

function finished(stream) {
  return new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
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

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function printUsage() {
  console.log("Usage: node scripts/run-progressive-index-three-repo.mjs --output-dir DIR --lishuedu DIR --cipherlink DIR --exam-parent-v3 DIR [--candidate-root DIR] [--scenario-lock FILE] [--runs 5] [--generation 1] [--poll-ms 50] [--timeout-ms 180000]");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}

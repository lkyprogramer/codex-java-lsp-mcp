#!/usr/bin/env node
// input: A baseline Git revision, a candidate worktree, and three local Java repositories.
// output: An isolated AB/BA/AB cold-nolsp impact matrix plus a strict paired-gate summary.
// pos: Reusable real-repository acceptance runner; never compiles or starts JDT in the caller's active worktree.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MATRIX_PROJECTS, verifyMatrix } from "./verify-three-repo-cold-matrix.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLD_ENV = { JDTLS_BIN: "/usr/bin/false", JAVA_LSP_FILE_WATCH: "0", JAVA_LSP_SHADOW_RANKING: "0" };
const ROUND_ORDER = [["old", "new"], ["new", "old"], ["old", "new"]];

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();

  const sourceRoot = path.resolve(cli.candidateRoot);
  const outputDir = path.resolve(cli.outputDir || path.join(sourceRoot, "artifacts", "model-eval", `three-repo-cold-${timestamp()}`));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-java-lsp-mcp-three-repo-"));
  const baselineRoot = path.join(workspaceRoot, "baseline");
  const candidateRoot = path.join(workspaceRoot, "candidate");
  const scenarioDir = path.join(outputDir, "frozen-scenarios");
  const matrixDir = path.join(outputDir, "matrix");
  const cacheDir = path.join(workspaceRoot, "caches");
  const isolatedEnv = { ...COLD_ENV, JAVA_LSP_CACHE_ROOT: path.join(workspaceRoot, "process-cache") };
  let baselineCreated = false;
  let candidateCreated = false;
  let worktreesRemoved = true;

  try {
    await preflight({ cli, sourceRoot, outputDir });
    await mkdir(outputDir, { recursive: false });
    await mkdir(scenarioDir, { recursive: true });
    await mkdir(matrixDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });

    const candidatePatch = await capture("git", ["-C", sourceRoot, "diff", "HEAD", "--binary"]);
    const candidatePatchFile = path.join(outputDir, "candidate.patch");
    await writeFile(candidatePatchFile, candidatePatch);
    await writeFile(`${candidatePatchFile}.sha256`, `${sha256(candidatePatch)}  candidate.patch\n`);

    await run("git", ["-C", sourceRoot, "worktree", "add", "--detach", baselineRoot, cli.baseline]);
    baselineCreated = true;
    await run("git", ["-C", sourceRoot, "worktree", "add", "--detach", candidateRoot, "HEAD"]);
    candidateCreated = true;
    if (candidatePatch.length > 0) await run("git", ["-C", candidateRoot, "apply", candidatePatchFile]);

    await symlinkNodeModules(sourceRoot, baselineRoot);
    await symlinkNodeModules(sourceRoot, candidateRoot);

    const scenarioHashes = await freezeScenarios(candidateRoot, scenarioDir);
    await writeFile(path.join(outputDir, "frozen-scenarios.sha256"), Object.entries(scenarioHashes)
      .map(([project, hash]) => `${hash}  frozen-scenarios/${project}.scenarios.jsonl`)
      .join("\n") + "\n");
    await writeManifest(outputDir, {
      sourceRoot,
      baseline: cli.baseline,
      candidateHead: (await capture("git", ["-C", sourceRoot, "rev-parse", "HEAD"])).trim(),
      candidatePatchSha256: sha256(candidatePatch),
      runs: cli.runs,
      rounds: ROUND_ORDER.map(order => order.join("/")),
      repositories: cli.repositories,
      scenarios: scenarioHashes,
      jdtlsDisabled: true,
      workspaceRoot
    });

    await build(baselineRoot, isolatedEnv);
    await build(candidateRoot, isolatedEnv);
    await runCandidateTests(candidateRoot, isolatedEnv);

    for (let roundIndex = 0; roundIndex < ROUND_ORDER.length; roundIndex += 1) {
      const round = roundIndex + 1;
      for (const variant of ROUND_ORDER[roundIndex]) {
        const runtimeRoot = variant === "old" ? baselineRoot : candidateRoot;
        for (const project of MATRIX_PROJECTS) {
          await runCell({
            runtimeRoot,
            variant,
            round,
            project,
            repoRoot: cli.repositories[project],
            scenarioFile: path.join(scenarioDir, `${project}.scenarios.jsonl`),
            cacheDir: path.join(cacheDir, `${project}-r${round}-${variant}`),
            outputFile: path.join(matrixDir, `${project}-r${round}-${variant}.json`),
            runs: cli.runs,
            env: isolatedEnv
          });
        }
      }
    }

    const result = verifyMatrix({
      matrixDir,
      expectedRuns: cli.runs,
      p95Limit: cli.p95Limit,
      summaryFile: path.join(outputDir, "matrix-summary.json")
    });
    printResult(result);
    if (!result.passed) process.exitCode = 1;
  } finally {
    if (!cli.keepWorktrees) {
      worktreesRemoved = await removeWorktree(sourceRoot, candidateRoot, candidateCreated) && worktreesRemoved;
      worktreesRemoved = await removeWorktree(sourceRoot, baselineRoot, baselineCreated) && worktreesRemoved;
      if (worktreesRemoved) {
        await rm(workspaceRoot, { recursive: true, force: true });
      } else {
        console.warn(`preserved temporary workspace after worktree cleanup failure: ${workspaceRoot}`);
      }
    } else {
      console.log(`preserved isolated worktrees/cache: ${workspaceRoot}`);
    }
  }
}

async function preflight({ cli, sourceRoot, outputDir }) {
  await access(path.join(sourceRoot, ".git"));
  await access(path.join(sourceRoot, "node_modules"));
  await run("git", ["-C", sourceRoot, "merge-base", "--is-ancestor", cli.baseline, "HEAD"]);
  if (existsSync(outputDir)) throw new Error(`output directory already exists: ${outputDir}`);
  for (const [project, repoRoot] of Object.entries(cli.repositories)) {
    await access(repoRoot).catch(() => {
      throw new Error(`${project} repository is not readable: ${repoRoot}`);
    });
  }
  const untracked = (await capture("git", ["-C", sourceRoot, "ls-files", "--others", "--exclude-standard"]))
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(file => /^(src|golden|fixtures|scripts)\//.test(file) || /^(?:package(?:-lock)?\.json|tsconfig\.json)$/.test(file));
  if (untracked.length > 0) {
    throw new Error(`untracked source inputs cannot be reproduced by git diff: ${untracked.join(", ")}`);
  }
  if (!(Number.isInteger(cli.runs) && cli.runs === 5)) {
    throw new Error("formal three-repository gate requires --runs 5");
  }
}

async function freezeScenarios(candidateRoot, scenarioDir) {
  const hashes = {};
  for (const project of MATRIX_PROJECTS) {
    const source = path.join(candidateRoot, "golden", `${project}.scenarios.jsonl`);
    const target = path.join(scenarioDir, `${project}.scenarios.jsonl`);
    await copyFile(source, target);
    hashes[project] = sha256(await readFile(target));
  }
  return hashes;
}

async function symlinkNodeModules(sourceRoot, worktreeRoot) {
  const target = path.join(worktreeRoot, "node_modules");
  if (existsSync(target)) return;
  const { symlink } = await import("node:fs/promises");
  await symlink(path.join(sourceRoot, "node_modules"), target, "dir");
}

async function build(root, env) {
  await run(process.execPath, [path.join(root, "node_modules", ".bin", "tsc"), "-p", path.join(root, "tsconfig.json")], { cwd: root, env });
  await run(process.execPath, [path.join(root, "scripts", "write-build-stamp.mjs")], { cwd: root, env });
}

async function runCandidateTests(candidateRoot, env) {
  await run(process.execPath, ["--test", "--test-concurrency=1", "dist/**/*.test.js"], { cwd: candidateRoot, env });
}

async function runCell({ runtimeRoot, variant, round, project, repoRoot, scenarioFile, cacheDir, outputFile, runs, env }) {
  await mkdir(cacheDir, { recursive: true });
  console.log(`matrix: r${round} ${variant} ${project}`);
  await runToFiles(
    process.execPath,
    [
      path.join(runtimeRoot, "dist", "benchmark-agent-impact.js"),
      "--repo-root", repoRoot,
      "--project-id", project,
      "--scenarios", scenarioFile,
      "--warm-state", "cold-nolsp",
      "--strategy", "impact",
      "--runs", String(runs),
      "--verbosity", "diagnostic",
      "--index-cache-dir", cacheDir
    ],
    outputFile,
    `${outputFile}.stderr`,
    { cwd: runtimeRoot, env }
  );
}

async function writeManifest(outputDir, value) {
  await writeFile(path.join(outputDir, "run-manifest.json"), `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), ...value }, null, 2)}\n`);
}

async function removeWorktree(sourceRoot, worktreeRoot, created) {
  if (!created) return true;
  try {
    await run("git", ["-C", sourceRoot, "worktree", "remove", "--force", worktreeRoot]);
    return true;
  } catch (error) {
    console.warn(`could not remove temporary worktree ${worktreeRoot}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const errors = [];
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.once("error", reject);
    child.once("exit", code => code === 0
      ? resolve(Buffer.concat(chunks).toString("utf8"))
      : reject(new Error(`${command} ${args.join(" ")} exited with ${code}: ${Buffer.concat(errors).toString("utf8")}`)));
  });
}

function runToFiles(command, args, stdoutFile, stderrFile, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const stdout = createWriteStream(stdoutFile);
    const stderr = createWriteStream(stderrFile);
    const stdoutFinished = streamFinished(stdout);
    const stderrFinished = streamFinished(stderr);
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.once("error", error => {
      stdout.end();
      stderr.end();
      Promise.allSettled([stdoutFinished, stderrFinished]).finally(() => reject(error));
    });
    child.once("exit", async code => {
      stdout.end();
      stderr.end();
      try {
        await Promise.all([stdoutFinished, stderrFinished]);
        if (code === 0) resolve();
        else reject(new Error(`${command} exited with ${code}; see ${stderrFile}`));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function streamFinished(stream) {
  return new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
  });
}

function parseCli(args) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "--keep-worktrees") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[index + 1]);
    index += 1;
  }
  if (flags.has("--help")) return { help: true };
  const candidateRoot = options.get("--candidate-root") || scriptRoot;
  return {
    help: flags.has("--help"),
    keepWorktrees: flags.has("--keep-worktrees"),
    candidateRoot,
    baseline: required(options.get("--baseline") || process.env.THREE_REPO_BASELINE_SHA, "--baseline"),
    outputDir: options.get("--output-dir"),
    runs: numberOption(options.get("--runs"), 5, "--runs"),
    p95Limit: numberOption(options.get("--p95-limit"), 1.10, "--p95-limit"),
    repositories: {
      lishuedu: required(options.get("--lishuedu") || process.env.LISHUEDU_ROOT, "--lishuedu or LISHUEDU_ROOT"),
      cipherlink: required(options.get("--cipherlink") || process.env.CIPHERLINK_ROOT, "--cipherlink or CIPHERLINK_ROOT"),
      "exam-parent-v3": required(options.get("--exam-parent-v3") || process.env.EXAM_PARENT_V3_ROOT, "--exam-parent-v3 or EXAM_PARENT_V3_ROOT")
    }
  };
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function numberOption(value, fallback, flag) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be numeric`);
  return parsed;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function printResult(result) {
  console.table(result.projects.map(project => ({
    project: project.project,
    oldRecall: project.old.recall.toFixed(4),
    newRecall: project.new.recall.toFixed(4),
    oldPRead: project.old.pRead.toFixed(4),
    newPRead: project.new.pRead.toFixed(4),
    newRReadMust: project.new.rReadMust.toFixed(4),
    p95Ratio: project.delta.p95Ratio.toFixed(3),
    gate: project.passed ? "PASS" : "FAIL"
  })));
  console.log(`summary: ${result.summaryFile}`);
  if (result.warnings.length > 0) console.warn(`warnings:\n${result.warnings.join("\n")}`);
}

function printUsage() {
  console.log(`usage: node scripts/run-three-repo-cold-matrix.mjs \\
  --baseline <sha> \\
  --lishuedu <repo-root> --cipherlink <repo-root> --exam-parent-v3 <repo-root> \\
  [--candidate-root <codex-java-lsp-mcp-root>] [--output-dir <new-dir>] \\
  [--runs 5] [--p95-limit 1.10] [--keep-worktrees]`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 2;
});

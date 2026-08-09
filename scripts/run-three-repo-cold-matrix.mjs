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
import { MATRIX_PROJECTS, VERIFIER_VERSION, verifyMatrix } from "./verify-three-repo-cold-matrix.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLD_ENV = { JDTLS_BIN: "/usr/bin/false", JAVA_LSP_SHADOW_RANKING: "0" };
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

    const candidateSnapshot = await captureCandidatePatch(sourceRoot);
    const candidatePatch = candidateSnapshot.patch;
    const candidatePatchFile = path.join(outputDir, "candidate.patch");
    await writeFile(candidatePatchFile, candidatePatch);
    await writeFile(`${candidatePatchFile}.sha256`, `${sha256(candidatePatch)}  candidate.patch\n`);
    const candidateUntrackedInputs = await persistUntrackedInputs(
      sourceRoot,
      path.join(outputDir, "candidate-untracked"),
      candidateSnapshot.untrackedInputs
    );

    await run("git", ["-C", sourceRoot, "worktree", "add", "--detach", baselineRoot, cli.baseline]);
    baselineCreated = true;
    await run("git", ["-C", sourceRoot, "worktree", "add", "--detach", candidateRoot, "HEAD"]);
    candidateCreated = true;
    if (candidatePatch.length > 0) await run("git", ["-C", candidateRoot, "apply", "--index", candidatePatchFile]);

    await symlinkNodeModules(sourceRoot, baselineRoot);
    await symlinkNodeModules(sourceRoot, candidateRoot);

    const scenarios = await freezeScenarios(candidateRoot, scenarioDir);
    await writeFile(path.join(outputDir, "frozen-scenarios.sha256"), Object.entries(scenarios)
      .map(([project, scenario]) => `${scenario.sha256}  frozen-scenarios/${project}.scenarios.jsonl`)
      .join("\n") + "\n");

    await build(baselineRoot, isolatedEnv);
    await build(candidateRoot, isolatedEnv);
    await runCandidateTests(candidateRoot, isolatedEnv);

    const runtimes = {
      old: await runtimeIdentity(baselineRoot),
      new: await runtimeIdentity(candidateRoot)
    };
    const repositories = await repositoryIdentities(cli.repositories);
    const manifest = await writeManifest(outputDir, {
      sourceRoot,
      verifierVersion: VERIFIER_VERSION,
      runtimes,
      candidatePatch: {
        file: candidatePatchFile,
        sha256: sha256(candidatePatch),
        bytes: Buffer.byteLength(candidatePatch),
        appliedToCommit: runtimes.new.commit,
        appliedToCommitTree: runtimes.new.commitTree,
        resultingExecutableTree: runtimes.new.executableTree,
        untrackedInputs: candidateUntrackedInputs
      },
      runs: cli.runs,
      p95Limit: cli.p95Limit,
      comparisonPolicy: {
        baseline: "executable-code-baseline",
        baselineRevision: runtimes.old.commit,
        goldenSchema: "task36-cross-version-v1",
        pReadTolerance: 0.02,
        p95AbsoluteSlackMs: 50,
        taskBlockingBaseline: "attempt-or-derived-attribution"
      },
      rounds: ROUND_ORDER.map(order => order.join("/")),
      repositories,
      scenarios,
      jdtlsDisabled: true,
      workspaceRoot
    });

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
            repoRoot: repositories[project].root,
            repository: repositories[project],
            scenarioFile: scenarios[project].file,
            cacheDir: path.join(cacheDir, `${project}-r${round}-${variant}`),
            outputFile: path.join(matrixDir, `${project}-r${round}-${variant}.json`),
            runs: cli.runs,
            env: isolatedEnv,
            provenance: {
              manifestSha256: manifest.sha256,
              variant,
              runtimeCommit: runtimes[variant].commit,
              runtimeCommitTree: runtimes[variant].commitTree,
              runtimeExecutableTree: runtimes[variant].executableTree,
              candidatePatchSha256: sha256(candidatePatch)
            }
          });
        }
      }
    }

    const result = verifyMatrix({
      matrixDir,
      manifestFile: manifest.file,
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
  const baselineCommit = (await capture("git", ["-C", sourceRoot, "rev-parse", `${cli.baseline}^{commit}`])).trim();
  const candidateCommit = (await capture("git", ["-C", sourceRoot, "rev-parse", "HEAD^{commit}"])).trim();
  if (baselineCommit === candidateCommit) {
    throw new Error("baseline and candidate must resolve to different commits");
  }
  if (existsSync(outputDir)) throw new Error(`output directory already exists: ${outputDir}`);
  for (const [project, repoRoot] of Object.entries(cli.repositories)) {
    await access(repoRoot).catch(() => {
      throw new Error(`${project} repository is not readable: ${repoRoot}`);
    });
  }
  if (!(Number.isInteger(cli.runs) && cli.runs === 5)) {
    throw new Error("formal three-repository gate requires --runs 5");
  }
}

async function freezeScenarios(candidateRoot, scenarioDir) {
  const scenarios = {};
  for (const project of MATRIX_PROJECTS) {
    const source = path.join(candidateRoot, "golden", `${project}.scenarios.jsonl`);
    const target = path.join(scenarioDir, `${project}.scenarios.jsonl`);
    const sourceContents = await readFile(source, "utf8");
    await writeFile(target, toCrossVersionScenarioJsonl(sourceContents, source));
    const bytes = await readFile(target);
    scenarios[project] = {
      file: target,
      sha256: sha256(bytes),
      rowIds: scenarioIds(bytes.toString("utf8"), target)
    };
  }
  return scenarios;
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

async function runCell({ runtimeRoot, variant, round, project, repoRoot, repository, scenarioFile, cacheDir, outputFile, runs, env, provenance }) {
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
  const observedRepository = await assertCleanRepository(repoRoot, project);
  if (observedRepository.head !== repository.head || observedRepository.tree !== repository.tree) {
    throw new Error(`${project} repository identity changed during the formal matrix`);
  }
  await stampCellProvenance(outputFile, {
    ...provenance,
    repoHead: observedRepository.head,
    repoTree: observedRepository.tree,
    repoStatusSha256: observedRepository.statusSha256,
    scenarioSha256: sha256(await readFile(scenarioFile)),
    scenarioIds: scenarioIds(await readFile(scenarioFile, "utf8"), scenarioFile)
  });
}

async function writeManifest(outputDir, value) {
  const file = path.join(outputDir, "run-manifest.json");
  const manifest = { version: VERIFIER_VERSION, createdAt: new Date().toISOString(), ...value };
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(file, contents);
  return { file, value: manifest, sha256: sha256(contents) };
}

async function runtimeIdentity(root) {
  return {
    commit: (await capture("git", ["-C", root, "rev-parse", "HEAD^{commit}"])).trim(),
    commitTree: (await capture("git", ["-C", root, "rev-parse", "HEAD^{tree}"])).trim(),
    executableTree: (await capture("git", ["-C", root, "write-tree"])).trim(),
    buildStamp: JSON.parse(await readFile(path.join(root, "dist", "build-stamp.json"), "utf8"))
  };
}

async function repositoryIdentities(repositories) {
  const result = {};
  for (const project of MATRIX_PROJECTS) {
    const root = path.resolve(repositories[project]);
    result[project] = await assertCleanRepository(root, project);
  }
  return result;
}

export async function captureCandidatePatch(sourceRoot) {
  const trackedPatch = await capture("git", ["-C", sourceRoot, "diff", "HEAD", "--binary"]);
  const untrackedPaths = (await capture("git", ["-C", sourceRoot, "ls-files", "--others", "--exclude-standard"]))
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(isCandidateSourceInput)
    .sort((left, right) => left.localeCompare(right));
  const untrackedInputs = [];
  const patches = [trackedPatch];
  for (const relativePath of untrackedPaths) {
    const bytes = await readFile(path.join(sourceRoot, relativePath));
    untrackedInputs.push({
      path: relativePath,
      sha256: sha256(bytes),
      bytes: bytes.length
    });
    patches.push(await captureWithAllowedExitCodes(
      "git",
      ["-C", sourceRoot, "diff", "--no-index", "--binary", "--", "/dev/null", relativePath],
      new Set([0, 1])
    ));
  }
  return { patch: patches.join(""), untrackedInputs };
}

async function persistUntrackedInputs(sourceRoot, outputRoot, inputs) {
  const persisted = [];
  for (const input of inputs) {
    const target = path.join(outputRoot, input.path);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(sourceRoot, input.path), target);
    persisted.push({ ...input, file: target });
  }
  return persisted;
}

function isCandidateSourceInput(file) {
  return /^(src|golden|fixtures|scripts)\//.test(file)
    || /^(?:package(?:-lock)?\.json|tsconfig\.json)$/.test(file);
}

export function toCrossVersionScenarioJsonl(contents, file = "<scenario>") {
  return contents.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${file}:${index + 1}: invalid scenario JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!row || typeof row !== "object") throw new Error(`${file}:${index + 1}: scenario must be an object`);
    if (!row.golden || typeof row.golden !== "object") return JSON.stringify(row);
    const mustHit = uniqueStrings(row.golden.mustHit);
    const taskBlocking = uniqueStrings(row.golden.taskBlocking);
    const shouldHit = uniqueStrings([...taskBlocking, ...uniqueStrings(row.golden.shouldHit)]);
    const support = uniqueStrings(row.golden.support ?? row.golden.side);
    const goldenMeta = { ...(row.goldenMeta ?? {}) };
    for (const blockingFile of taskBlocking) {
      goldenMeta[blockingFile] = { ...(goldenMeta[blockingFile] ?? {}), shouldBlocksTask: true };
    }
    return JSON.stringify({
      ...row,
      golden: {
        ...row.golden,
        mustHit,
        taskBlocking,
        shouldHit,
        support,
        side: support
      },
      goldenMeta
    });
  }).join("\n") + "\n";
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(value => typeof value === "string" && value.length > 0))];
}

export async function assertCleanRepository(root, project) {
  const status = await capture("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length > 0) {
    throw new Error(`${project} repository must be clean for a formal matrix: ${root}`);
  }
  return {
    root: path.resolve(root),
    head: (await capture("git", ["-C", root, "rev-parse", "HEAD^{commit}"])).trim(),
    tree: (await capture("git", ["-C", root, "rev-parse", "HEAD^{tree}"])).trim(),
    clean: true,
    statusSha256: sha256(status)
  };
}

async function stampCellProvenance(file, provenance) {
  const payload = JSON.parse(await readFile(file, "utf8"));
  if (!payload || typeof payload !== "object" || !payload.metadata || !Array.isArray(payload.rows)) {
    throw new Error(`${file}: benchmark output is missing metadata or rows`);
  }
  payload.metadata.matrixProvenance = provenance;
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function scenarioIds(contents, file) {
  const seen = new Set();
  return contents.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${file}:${index + 1}: invalid scenario JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!row || typeof row.id !== "string" || !row.id) {
      throw new Error(`${file}:${index + 1}: scenario id is required`);
    }
    if (seen.has(row.id)) throw new Error(`${file}:${index + 1}: duplicate scenario id ${row.id}`);
    seen.add(row.id);
    return row.id;
  });
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
  return captureWithAllowedExitCodes(command, args, new Set([0]));
}

function captureWithAllowedExitCodes(command, args, allowedExitCodes) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    const errors = [];
    child.stdout.on("data", chunk => chunks.push(chunk));
    child.stderr.on("data", chunk => errors.push(chunk));
    child.once("error", reject);
    child.once("exit", code => allowedExitCodes.has(code)
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
    p95Limit: numberOption(options.get("--p95-limit"), 1.25, "--p95-limit"),
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
  [--runs 5] [--p95-limit 1.25] [--keep-worktrees]`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 2;
  });
}

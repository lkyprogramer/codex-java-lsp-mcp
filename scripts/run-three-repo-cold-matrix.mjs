#!/usr/bin/env node
// input: A baseline Git revision, a candidate source checkout, and three local Java repositories.
// output: An isolated AB/BA/AB cold-nolsp impact matrix plus a strict paired-gate summary.
// pos: Reusable real-repository acceptance runner; all code and Java inputs run from private local clones.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  aggregateJavaIndexRpcSidecar,
  DIAGNOSTIC_RPC_GATE_POLICY
} from "./aggregate-java-index-rpc-sidecar.mjs";
import {
  assignmentsFromPairs,
  buildEnvLock,
  COMPARISON_POLICY_ENV_LOCKED,
  COMPARISON_POLICY_EXECUTABLE,
  ENV_AB_ALLOWLIST,
  fingerprintTreatment,
  FORMAL_REQUEST_DEADLINE_MS,
  MATRIX_PROJECTS,
  parseEnvAssignment,
  VERIFIER_VERSION,
  verifyMatrix
} from "./verify-three-repo-cold-matrix.mjs";
import {
  copyIsolatedNodeModules,
  createDetachedLocalClone,
  dependencyTreeInventory,
  scrubHostNodeRuntimeState
} from "./isolation-utils.mjs";
import { inspectHostQuiet, THREE_REPO_LOADAVG_PROCEED_BELOW } from "./host-quiet.mjs";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLD_ENV = {
  JDTLS_BIN: "/usr/bin/false",
  JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY: "0",
  JAVA_LSP_ISOLATED_VALIDATION: "1"
};
const ROUND_ORDER = [["old", "new"], ["new", "old"], ["old", "new"]];
const RUNTIME_STATE_KEYS = [
  "HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "TMPDIR",
  "JAVA_LSP_CACHE_ROOT",
  "JDTLS_DATA_DIR",
  "JDTLS_LOG_DIR",
  "JAVA_LSP_PROJECTS_JSON",
  "GRADLE_USER_HOME",
  "MAVEN_USER_HOME"
];

export function matrixRuntimeEnvironment(root, telemetry = "0") {
  return {
    ...COLD_ENV,
    JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY: telemetry,
    HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
    TMPDIR: path.join(root, "tmp"),
    JAVA_LSP_CACHE_ROOT: path.join(root, "process-cache"),
    JDTLS_DATA_DIR: path.join(root, "jdt-data"),
    JDTLS_LOG_DIR: path.join(root, "jdt-logs"),
    JAVA_LSP_PROJECTS_JSON: path.join(root, "projects.json"),
    GRADLE_USER_HOME: path.join(root, "gradle-home"),
    MAVEN_USER_HOME: path.join(root, "maven-home")
  };
}

export function assertDisjointRuntimeState(left, right) {
  const leftPaths = RUNTIME_STATE_KEYS.map(key => path.resolve(left[key]));
  const rightPaths = RUNTIME_STATE_KEYS.map(key => path.resolve(right[key]));
  for (const leftPath of leftPaths) {
    for (const rightPath of rightPaths) {
      if (leftPath === rightPath || isWithin(leftPath, rightPath) || isWithin(rightPath, leftPath)) {
        throw new Error(`standard and diagnostic runtime state overlap: ${leftPath} <-> ${rightPath}`);
      }
    }
  }
}

async function prepareMatrixRuntimeState(root) {
  await Promise.all([
    "home",
    "xdg-cache",
    "xdg-config",
    "xdg-data",
    "xdg-state",
    "tmp",
    "process-cache",
    "jdt-data",
    "jdt-logs",
    "gradle-home",
    "maven-home"
  ].map(directory => mkdir(path.join(root, directory), { recursive: true })));
  await writeFile(path.join(root, "projects.json"), "{\"aliases\":[],\"defaults\":{}}\n");
}

function runtimeStateDescriptor(environment) {
  return Object.fromEntries(RUNTIME_STATE_KEYS.map(key => [key, path.resolve(environment[key])]));
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();

  const sourceRoot = path.resolve(cli.candidateRoot);
  const outputDir = path.resolve(cli.outputDir);
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-java-lsp-mcp-three-repo-"));
  const baselineRoot = path.join(workspaceRoot, "baseline");
  const candidateRoot = path.join(workspaceRoot, "candidate");
  const scenarioDir = path.join(outputDir, "frozen-scenarios");
  const matrixDir = path.join(outputDir, "matrix");
  const cacheDir = path.join(workspaceRoot, "caches");
  const diagnosticRpcDir = path.join(outputDir, "diagnostic-java-index-rpc");
  const diagnosticRpcRawDir = path.join(diagnosticRpcDir, "raw");
  const diagnosticRpcCacheDir = path.join(workspaceRoot, "diagnostic-rpc-caches");
  const diagnosticRuntimeRoot = path.join(workspaceRoot, "diagnostic-rpc-runtime");
  const isolatedEnv = matrixRuntimeEnvironment(workspaceRoot, "0");
  const diagnosticEnv = matrixRuntimeEnvironment(diagnosticRuntimeRoot, "1");
  assertDisjointRuntimeState(isolatedEnv, diagnosticEnv);

  try {
    const host = inspectHostQuiet();
    console.log(
      `three-repo host: load ${host.loadavg1.toFixed(2)} `
      + `(proceed window < ${THREE_REPO_LOADAVG_PROCEED_BELOW}: ${host.loadPolicy.belowThreshold ? "yes" : "above-window, still running"}; `
      + `refuse=${host.loadPolicy.refuse})`
    );
    await preflight({ cli, sourceRoot, outputDir });
    await mkdir(outputDir, { recursive: false });
    await mkdir(scenarioDir, { recursive: true });
    await mkdir(matrixDir, { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    if (cli.diagnosticRpcSidecar) {
      await mkdir(diagnosticRpcRawDir, { recursive: true });
      await mkdir(diagnosticRpcCacheDir, { recursive: true });
    }
    await prepareMatrixRuntimeState(workspaceRoot);
    if (cli.diagnosticRpcSidecar) await prepareMatrixRuntimeState(diagnosticRuntimeRoot);

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

    const baselineCommit = (await capture("git", ["-C", sourceRoot, "rev-parse", `${cli.baseline}^{commit}`])).trim();
    const candidateCommit = (await capture("git", ["-C", sourceRoot, "rev-parse", "HEAD^{commit}"])).trim();
    if (cli.comparisonPolicy === COMPARISON_POLICY_ENV_LOCKED && baselineCommit !== candidateCommit) {
      throw new Error("env-locked-same-tree requires --baseline to equal HEAD");
    }
    await createDetachedLocalClone(sourceRoot, baselineRoot, baselineCommit, run);
    await createDetachedLocalClone(sourceRoot, candidateRoot, candidateCommit, run);
    if (candidatePatch.length > 0) {
      await run("git", ["-C", candidateRoot, "apply", "--index", candidatePatchFile]);
      if (cli.comparisonPolicy === COMPARISON_POLICY_ENV_LOCKED) {
        await run("git", ["-C", baselineRoot, "apply", "--index", candidatePatchFile]);
      }
    }

    const sourceDependencyBefore = await dependencyTreeInventory(path.join(sourceRoot, "node_modules"));
    const isolatedNodeModules = await copyIsolatedNodeModules(sourceRoot, workspaceRoot);
    const [sourceDependencyAfter, isolatedDependency] = await Promise.all([
      dependencyTreeInventory(path.join(sourceRoot, "node_modules")),
      dependencyTreeInventory(isolatedNodeModules)
    ]);
    if (!sameDependencyInventory(sourceDependencyBefore, sourceDependencyAfter)
      || !sameDependencyInventory(sourceDependencyBefore, isolatedDependency)) {
      throw new Error("node_modules changed during the isolated dependency snapshot");
    }
    await symlinkNodeModules(isolatedNodeModules, baselineRoot);
    await symlinkNodeModules(isolatedNodeModules, candidateRoot);

    const sourceRepositories = await repositoryIdentities(cli.repositories);
    const repositories = await cloneRepositories(sourceRepositories, path.join(workspaceRoot, "repositories"));
    const scenarios = await freezeScenarios(candidateRoot, scenarioDir, repositories);
    await writeFile(path.join(outputDir, "frozen-scenarios.sha256"), Object.entries(scenarios)
      .map(([project, scenario]) => `${scenario.sha256}  frozen-scenarios/${project}.scenarios.jsonl`)
      .join("\n") + "\n");

    await build(baselineRoot, isolatedEnv);
    await build(candidateRoot, isolatedEnv);
    const candidateTests = await runCandidateTests(candidateRoot, isolatedEnv, path.join(outputDir, "candidate-tests"));

    const runtimes = {
      old: await runtimeIdentity(baselineRoot),
      new: await runtimeIdentity(candidateRoot)
    };
    if (cli.comparisonPolicy === COMPARISON_POLICY_ENV_LOCKED
      && (runtimes.old.commit !== runtimes.new.commit
        || runtimes.old.commitTree !== runtimes.new.commitTree
        || runtimes.old.executableTree !== runtimes.new.executableTree)) {
      throw new Error("env-locked-same-tree old/new executable trees diverged after clone/patch");
    }
    const envLock = cli.comparisonPolicy === COMPARISON_POLICY_ENV_LOCKED
      ? buildEnvLock(cli.oldTreatment, cli.newTreatment)
      : undefined;
    const manifest = await writeManifest(outputDir, {
      sourceRoot,
      verifierVersion: VERIFIER_VERSION,
      hostLoad: host,
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
      requestDeadlineMs: FORMAL_REQUEST_DEADLINE_MS,
      comparisonPolicy: {
        baseline: cli.comparisonPolicy,
        baselineRevision: runtimes.old.commit,
        goldenSchema: "java-intelligence-v32-range-holdout-v2",
        pReadTolerance: 0.02,
        p95AbsoluteSlackMs: 50,
        taskBlockingBaseline: "attempt-or-derived-attribution",
        ...(envLock ? { envLock } : {})
      },
      rounds: ROUND_ORDER.map(order => order.join("/")),
      repositories,
      scenarios,
      candidateTests,
      dependencies: {
        copyMode: "private-content-verified-copy",
        inventory: isolatedDependency
      },
      diagnosticRpc: {
        requested: cli.diagnosticRpcSidecar,
        role: "DIAGNOSTIC_ONLY_NOT_STANDARD_TOKEN_GATE",
        gatePolicy: cli.diagnosticRpcSidecar ? DIAGNOSTIC_RPC_GATE_POLICY : null,
        runtimeState: cli.diagnosticRpcSidecar ? {
          standard: runtimeStateDescriptor(isolatedEnv),
          diagnostic: runtimeStateDescriptor(diagnosticEnv)
        } : null,
        telemetryMode: cli.diagnosticRpcSidecar ? {
          standard: isolatedEnv.JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY,
          diagnostic: diagnosticEnv.JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY
        } : null,
        outputFile: cli.diagnosticRpcSidecar
          ? path.join(diagnosticRpcDir, "java-index-rpc-sidecar.json")
          : null
      },
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
            verbosity: "standard",
            extraArgs: variant === "new" ? cli.newTreatment.benchArgs : cli.oldTreatment.benchArgs,
            env: { ...isolatedEnv, ...(variant === "new" ? cli.newTreatment.env : cli.oldTreatment.env) },
            provenance: {
              manifestSha256: manifest.sha256,
              variant,
              runtimeCommit: runtimes[variant].commit,
              runtimeCommitTree: runtimes[variant].commitTree,
              runtimeExecutableTree: runtimes[variant].executableTree,
              candidatePatchSha256: sha256(candidatePatch),
              ...(envLock ? { treatmentFingerprint: envLock[variant].fingerprint } : {})
            }
          });
        }
      }
    }

    if (cli.diagnosticRpcSidecar) {
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
              cacheDir: path.join(diagnosticRpcCacheDir, `${project}-r${round}-${variant}`),
              outputFile: path.join(diagnosticRpcRawDir, `${project}-r${round}-${variant}.json`),
              runs: cli.runs,
              verbosity: "diagnostic",
              extraArgs: variant === "new" ? cli.newTreatment.benchArgs : cli.oldTreatment.benchArgs,
              env: { ...diagnosticEnv, ...(variant === "new" ? cli.newTreatment.env : cli.oldTreatment.env) },
              provenance: {
                manifestSha256: manifest.sha256,
                variant,
                runtimeCommit: runtimes[variant].commit,
                runtimeCommitTree: runtimes[variant].commitTree,
                runtimeExecutableTree: runtimes[variant].executableTree,
                candidatePatchSha256: sha256(candidatePatch),
                ...(envLock ? { treatmentFingerprint: envLock[variant].fingerprint } : {})
              }
            });
          }
        }
      }
      const sidecar = await aggregateJavaIndexRpcSidecar({
        manifestFile: manifest.file,
        diagnosticDir: diagnosticRpcDir,
        outputFile: path.join(diagnosticRpcDir, "java-index-rpc-sidecar.json")
      });
      console.log(`diagnostic JavaIndex RPC sidecar: ${sidecar.payloadSha256}`);
    }

    const finalDependency = await dependencyTreeInventory(isolatedNodeModules);
    if (!sameDependencyInventory(isolatedDependency, finalDependency)) {
      throw new Error("isolated node_modules changed during build, tests, or matrix execution");
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
      await rm(workspaceRoot, { recursive: true, force: true });
    } else {
      console.log(`preserved isolated local clones/cache: ${workspaceRoot}`);
    }
  }
}

async function preflight({ cli, sourceRoot, outputDir }) {
  await access(path.join(sourceRoot, ".git"));
  await access(path.join(sourceRoot, "node_modules"));
  await run("git", ["-C", sourceRoot, "merge-base", "--is-ancestor", cli.baseline, "HEAD"]);
  const baselineCommit = (await capture("git", ["-C", sourceRoot, "rev-parse", `${cli.baseline}^{commit}`])).trim();
  const candidateCommit = (await capture("git", ["-C", sourceRoot, "rev-parse", "HEAD^{commit}"])).trim();
  await assertOutputOutsideSource(sourceRoot, outputDir);
  if (existsSync(outputDir)) throw new Error(`output directory already exists: ${outputDir}`);
  for (const [project, repoRoot] of Object.entries(cli.repositories)) {
    await access(repoRoot).catch(() => {
      throw new Error(`${project} repository is not readable: ${repoRoot}`);
    });
  }
  if (!(Number.isInteger(cli.runs) && (cli.runs === 2 || cli.runs === 5))) {
    throw new Error("formal three-repository gate requires --runs 2 (identity) or --runs 5");
  }
}

export async function assertOutputOutsideSource(sourceRoot, outputDir) {
  const outputParent = path.dirname(path.resolve(outputDir));
  const [canonicalSource, canonicalParent] = await Promise.all([
    realpath(sourceRoot),
    realpath(outputParent).catch(() => {
      throw new Error("formal matrix --output-dir parent must already exist");
    })
  ]);
  const canonicalOutput = path.join(canonicalParent, path.basename(path.resolve(outputDir)));
  if (isWithin(canonicalSource, canonicalOutput)) {
    throw new Error("formal matrix --output-dir must be outside the candidate source checkout");
  }
}

async function freezeScenarios(candidateRoot, scenarioDir, repositories) {
  const scenarios = {};
  for (const project of MATRIX_PROJECTS) {
    const source = path.join(candidateRoot, "golden", `${project}.scenarios.jsonl`);
    const target = path.join(scenarioDir, `${project}.scenarios.jsonl`);
    const sourceContents = await readFile(source, "utf8");
    await writeFile(target, toCrossVersionScenarioJsonl(sourceContents, source));
    const bytes = await readFile(target);
    const rows = scenarioRows(bytes.toString("utf8"), target);
    await validateScenarioSet(rows, repositories[project], target);
    scenarios[project] = {
      file: target,
      sha256: sha256(bytes),
      rowIds: rows.map(row => row.id),
      tuningRowIds: rows.filter(row => row.evaluationSplit === "tuning").map(row => row.id),
      holdoutRowIds: rows.filter(row => row.evaluationSplit === "holdout").map(row => row.id)
    };
  }
  return scenarios;
}

async function symlinkNodeModules(isolatedNodeModules, worktreeRoot) {
  const target = path.join(worktreeRoot, "node_modules");
  if (existsSync(target)) return;
  const { symlink } = await import("node:fs/promises");
  await symlink(isolatedNodeModules, target, "dir");
}

async function build(root, env) {
  await run(process.execPath, [path.join(root, "node_modules", ".bin", "tsc"), "-p", path.join(root, "tsconfig.json")], { cwd: root, env });
  await run(process.execPath, [path.join(root, "scripts", "write-build-stamp.mjs")], { cwd: root, env });
}

async function runCandidateTests(candidateRoot, env, evidenceRoot) {
  await mkdir(evidenceRoot, { recursive: true });
  const scriptTests = (await readdir(path.join(candidateRoot, "scripts"), { recursive: true }))
    .filter(file => file.endsWith(".test.mjs"))
    .map(file => path.join("scripts", file))
    .sort((left, right) => left.localeCompare(right));
  if (scriptTests.length === 0) throw new Error("candidate scripts test suite discovered zero test files");
  const dist = await runTestSuite(
    process.execPath,
    ["--test", "--test-concurrency=1", "dist/**/*.test.js"],
    { cwd: candidateRoot, env, label: "dist", evidenceRoot }
  );
  const scripts = await runTestSuite(
    process.execPath,
    ["--test", "--test-concurrency=1", ...scriptTests],
    { cwd: candidateRoot, env, label: "scripts", evidenceRoot }
  );
  return { dist, scripts };
}

function runTestSuite(command, args, { cwd, env, label, evidenceRoot }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: isolatedChildEnvironment(env),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => {
      stdout.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("exit", async code => {
      try {
        const stdoutBytes = Buffer.concat(stdout);
        const stderrBytes = Buffer.concat(stderr);
        const stdoutFile = path.join(evidenceRoot, `${label}.tap`);
        const stderrFile = path.join(evidenceRoot, `${label}.stderr`);
        await Promise.all([writeFile(stdoutFile, stdoutBytes), writeFile(stderrFile, stderrBytes)]);
        const stdoutText = stdoutBytes.toString("utf8");
        const tests = [...stdoutText.matchAll(/^# tests (\d+)$/gm)].at(-1);
        const passed = [...stdoutText.matchAll(/^# pass (\d+)$/gm)].at(-1);
        const discoveredTests = tests ? Number(tests[1]) : 0;
        const passedTests = passed ? Number(passed[1]) : 0;
        if (code !== 0) {
          reject(new Error(`${label} candidate tests exited with ${code}: ${stderrBytes.toString("utf8")}`));
        } else if (discoveredTests <= 0 || passedTests !== discoveredTests) {
          reject(new Error(`${label} candidate tests did not prove a non-empty all-green suite`));
        } else {
          resolve({
            discoveredTests,
            passedTests,
            stdout: { file: stdoutFile, bytes: stdoutBytes.byteLength, sha256: sha256(stdoutBytes) },
            stderr: { file: stderrFile, bytes: stderrBytes.byteLength, sha256: sha256(stderrBytes) }
          });
        }
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sameDependencyInventory(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const NODE_CELL_DISABLE_EXPERIMENTAL_WARNING = "--disable-warning=ExperimentalWarning";

export function cellProcessArguments(scriptArgs) {
  return [NODE_CELL_DISABLE_EXPERIMENTAL_WARNING, ...scriptArgs];
}

export function benchmarkCellArguments({ runtimeRoot, repoRoot, project, scenarioFile, cacheDir, runs, verbosity, extraArgs = [] }) {
  return [
    path.join(runtimeRoot, "dist", "benchmark-agent-impact.js"),
    "--repo-root", repoRoot,
    "--project-id", project,
    "--scenarios", scenarioFile,
    "--warm-state", "cold-nolsp",
    "--mode", "balanced",
    "--semantic-policy", "fast",
    "--strategy", "impact",
    "--runs", String(runs),
    "--deadline-ms", String(FORMAL_REQUEST_DEADLINE_MS),
    // Diagnostic telemetry is a separate source-locked run and is never
    // charged to the default standard Token gate.
    "--verbosity", verbosity,
    "--index-cache-dir", cacheDir,
    ...extraArgs
  ];
}

async function runCell({ runtimeRoot, variant, round, project, repoRoot, repository, scenarioFile, cacheDir, outputFile, runs, verbosity, env, extraArgs = [], provenance }) {
  await mkdir(cacheDir, { recursive: true });
  console.log(`${verbosity === "standard" ? "matrix" : "diagnostic-rpc"}: r${round} ${variant} ${project}`);
  await runToFiles(
    process.execPath,
    cellProcessArguments(benchmarkCellArguments({ runtimeRoot, repoRoot, project, scenarioFile, cacheDir, runs, verbosity, extraArgs })),
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
    round,
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

async function cloneRepositories(sourceRepositories, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true });
  const result = {};
  for (const project of MATRIX_PROJECTS) {
    const source = sourceRepositories[project];
    const target = path.join(destinationRoot, project);
    await createDetachedLocalClone(source.root, target, source.head, run);
    const isolated = await assertCleanRepository(target, project);
    if (isolated.head !== source.head || isolated.tree !== source.tree) {
      throw new Error(`${project} isolated clone does not match its source identity`);
    }
    result[project] = { ...isolated, sourceRoot: source.root };
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

function scenarioRows(contents, file) {
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
    return row;
  });
}

function scenarioIds(contents, file) {
  return scenarioRows(contents, file).map(row => row.id);
}

export async function validateScenarioSet(rows, repository, file) {
  if (rows.length !== 10) throw new Error(`${file}: formal V3.2 matrix requires exactly 10 scenarios`);
  const tuning = rows.filter(row => row.evaluationSplit === "tuning");
  const holdout = rows.filter(row => row.evaluationSplit === "holdout");
  if (tuning.length !== 8 || holdout.length !== 2) {
    throw new Error(`${file}: expected 8 tuning and 2 holdout scenarios`);
  }
  const contentByFile = new Map();
  const sourceLines = async relativeFile => {
    if (!(typeof relativeFile === "string" && relativeFile.length > 0 && !path.isAbsolute(relativeFile))) {
      throw new Error(`${file}: scenario source path must be repository-relative`);
    }
    const absolute = path.resolve(repository.root, relativeFile);
    const relative = path.relative(repository.root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`${file}: scenario source escapes the isolated repository: ${relativeFile}`);
    }
    if (!contentByFile.has(relativeFile)) {
      const content = await readFile(absolute, "utf8").catch(error => {
        throw new Error(`${file}: cannot read frozen source ${relativeFile}: ${error instanceof Error ? error.message : String(error)}`);
      });
      contentByFile.set(relativeFile, content.split(/\r?\n/));
    }
    return contentByFile.get(relativeFile);
  };

  for (const row of rows) {
    if (row.repoCommit !== repository.head) {
      throw new Error(`${file}: ${row.id} repoCommit must equal frozen repository HEAD ${repository.head}`);
    }
    const anchorLines = await sourceLines(row.anchor?.file);
    validatePosition(row.anchor, anchorLines, `${file}: ${row.id} anchor`);
    const lineRanges = row.golden?.mustReadRanges;
    const coordinateRanges = row.golden?.mustReadCoordinateRangesV2;
    if (!lineRanges || typeof lineRanges !== "object" || Array.isArray(lineRanges) || Object.keys(lineRanges).length === 0) {
      throw new Error(`${file}: ${row.id} must carry mustReadRanges`);
    }
    if (!Array.isArray(coordinateRanges) || coordinateRanges.length === 0) {
      throw new Error(`${file}: ${row.id} must carry mustReadCoordinateRangesV2`);
    }
    for (const [relativeFile, ranges] of Object.entries(lineRanges)) {
      const lines = await sourceLines(relativeFile);
      if (!Array.isArray(ranges) || ranges.length === 0) throw new Error(`${file}: ${row.id} has an empty line range set`);
      for (const range of ranges) {
        if (!Number.isInteger(range?.startLine) || !Number.isInteger(range?.endLine)
          || range.startLine < 1 || range.endLine < range.startLine || range.endLine > lines.length) {
          throw new Error(`${file}: ${row.id} has an invalid line range for ${relativeFile}`);
        }
      }
    }
    for (const range of coordinateRanges) {
      const lines = await sourceLines(range?.file);
      validatePosition(range?.start, lines, `${file}: ${row.id} coordinate start`);
      validatePosition(range?.end, lines, `${file}: ${row.id} coordinate end`);
      if (comparePosition(range.start, range.end) >= 0) {
        throw new Error(`${file}: ${row.id} coordinate range must be end-exclusive and non-empty`);
      }
    }
  }
}

function validatePosition(position, lines, context) {
  if (!Number.isInteger(position?.line) || !Number.isInteger(position?.column)
    || position.line < 1 || position.line > lines.length
    || position.column < 1 || position.column > lines[position.line - 1].length + 1) {
    throw new Error(`${context} is not a valid 1-based UTF-16 source position`);
  }
}

function comparePosition(left, right) {
  return left.line - right.line || left.column - right.column;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: isolatedChildEnvironment(env),
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
    const child = spawn(command, args, { cwd, env: isolatedChildEnvironment(env), stdio: ["ignore", "pipe", "pipe"] });
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

export function parseCli(args) {
  const options = new Map();
  const flags = new Set();
  const candidateEnvPairs = [];
  const baselineEnvPairs = [];
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "--keep-worktrees" || key === "--diagnostic-rpc-sidecar") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    const value = args[index + 1];
    index += 1;
    if (key === "--candidate-env") {
      candidateEnvPairs.push(parseEnvAssignment(value, key));
      continue;
    }
    if (key === "--baseline-env") {
      baselineEnvPairs.push(parseEnvAssignment(value, key));
      continue;
    }
    options.set(key, value);
  }
  if (flags.has("--help")) return { help: true };
  const candidateRoot = options.get("--candidate-root") || scriptRoot;
  const comparisonPolicy = options.get("--comparison-policy") || COMPARISON_POLICY_EXECUTABLE;
  if (comparisonPolicy !== COMPARISON_POLICY_EXECUTABLE && comparisonPolicy !== COMPARISON_POLICY_ENV_LOCKED) {
    throw new Error("--comparison-policy must be executable-code-baseline or env-locked-same-tree");
  }
  if (options.get("--candidate-continue")) {
    throw new Error("retrieval continuation was removed in JIN N0");
  }
  const oldTreatment = {
    env: assignmentsFromPairs(baselineEnvPairs, "--baseline-env"),
    benchArgs: []
  };
  const newTreatment = {
    env: assignmentsFromPairs(candidateEnvPairs, "--candidate-env"),
    benchArgs: []
  };
  const emptyFingerprint = fingerprintTreatment({ env: {}, benchArgs: [] });
  const hasTreatment = fingerprintTreatment(oldTreatment) !== emptyFingerprint
    || fingerprintTreatment(newTreatment) !== emptyFingerprint;
  if (hasTreatment && comparisonPolicy !== COMPARISON_POLICY_ENV_LOCKED) {
    throw new Error("--candidate-env/--baseline-env require --comparison-policy env-locked-same-tree");
  }
  if (comparisonPolicy === COMPARISON_POLICY_ENV_LOCKED
    && fingerprintTreatment(oldTreatment) === fingerprintTreatment(newTreatment)) {
    throw new Error("env-locked-same-tree requires different old/new treatments");
  }
  return {
    help: flags.has("--help"),
    keepWorktrees: flags.has("--keep-worktrees"),
    diagnosticRpcSidecar: flags.has("--diagnostic-rpc-sidecar"),
    candidateRoot,
    baseline: required(options.get("--baseline") || process.env.THREE_REPO_BASELINE_SHA, "--baseline"),
    outputDir: required(options.get("--output-dir"), "--output-dir"),
    runs: numberOption(options.get("--runs"), 5, "--runs"),
    p95Limit: numberOption(options.get("--p95-limit"), 1.25, "--p95-limit"),
    comparisonPolicy,
    oldTreatment,
    newTreatment,
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

export function isolatedChildEnvironment(overrides = {}) {
  const environment = scrubHostNodeRuntimeState({ ...process.env, ...overrides });
  for (const name of Object.keys(environment)) {
    if (name.startsWith("JAVA_LSP_BENCH_") && !(name in overrides)) delete environment[name];
  }
  for (const name of ENV_AB_ALLOWLIST) {
    if (!(name in overrides)) delete environment[name];
  }
  for (const name of [
    "JDTLS_EXTRA_ARGS",
    "JAVA_LSP_RESOURCE_TELEMETRY_FILE",
    "JAVA_LSP_RESOURCE_INTERVAL_MS",
    "JAVA_LSP_REPO_ROOT",
    "JAVA_LSP_BENCH_REPO_ROOT",
    "JAVA_LSP_SMOKE_REPO_ROOT",
    "JAVA_LSP_TEST_REPO_ROOT",
    "JAVA_LSP_BENCH_INDEX_CACHE_DIR",
    "JAVA_LSP_JAVA_INDEX_RPC_TELEMETRY",
    "JAVA_LSP_ISOLATED_REPO_ROOT",
    "JAVA_LSP_ISOLATED_REPO_WORKTREE",
    "JAVA_TOOL_OPTIONS",
    "_JAVA_OPTIONS",
    "JDK_JAVA_OPTIONS",
    "MAVEN_OPTS",
    "GRADLE_OPTS",
    "LISHUEDU_ROOT",
    "CIPHERLINK_ROOT",
    "EXAM_PARENT_V3_ROOT"
  ]) {
    if (!(name in overrides)) delete environment[name];
  }
  return environment;
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
  [--candidate-root <codex-java-lsp-mcp-root>] --output-dir <new-dir-outside-source-checkout> \\
  [--runs 5] [--p95-limit 1.25] [--diagnostic-rpc-sidecar] [--keep-worktrees] \\
  [--comparison-policy executable-code-baseline|env-locked-same-tree]`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 2;
  });
}

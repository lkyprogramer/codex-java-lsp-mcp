#!/usr/bin/env node
// input: A three-repository AB/BA/AB cold-nolsp impact matrix.
// output: Reproducible paired quality/latency gate summary with a failing exit code on any hard-gate regression.
// pos: Shared verifier for Task 30 and later ranking/framework changes.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MATRIX_PROJECTS = ["lishuedu", "cipherlink", "exam-parent-v3"];
export const MATRIX_ROUNDS = [1, 2, 3];
export const MATRIX_VARIANTS = ["old", "new"];
export const VERIFIER_VERSION = 4;

const EPSILON = 1e-12;
const P_READ_TOLERANCE = 0.02;
const P95_ABSOLUTE_SLACK_MS = 50;

export function verifyMatrix({ matrixDir, manifestFile, expectedRuns = 5, p95Limit = 1.25, summaryFile } = {}) {
  if (!matrixDir) throw new MatrixValidationError("--matrix-dir is required");
  if (!Number.isInteger(expectedRuns) || expectedRuns <= 0) {
    throw new MatrixValidationError("expectedRuns must be a positive integer");
  }
  if (!(Number.isFinite(p95Limit) && p95Limit > 0)) {
    throw new MatrixValidationError("p95Limit must be a positive number");
  }

  const resolvedMatrixDir = path.resolve(matrixDir);
  const manifest = readAndValidateManifest(
    manifestFile ? path.resolve(manifestFile) : path.join(path.dirname(resolvedMatrixDir), "run-manifest.json"),
    expectedRuns,
    p95Limit
  );
  const cells = [];
  const projectSummaries = [];

  for (const project of MATRIX_PROJECTS) {
    const byVariant = new Map();
    for (const variant of MATRIX_VARIANTS) {
      const aggregate = aggregateProject(resolvedMatrixDir, project, variant, expectedRuns, cells, manifest);
      byVariant.set(variant, aggregate);
    }

    const oldRun = byVariant.get("old");
    const newRun = byVariant.get("new");
    const p95Ratio = newRun.p95 / oldRun.p95;
    const p95ThresholdMs = Math.max(oldRun.p95 * p95Limit, oldRun.p95 + P95_ABSOLUTE_SLACK_MS);
    const gate = {
      rReadMust: newRun.minReadMust === 1,
      rTaskBlocking: newRun.rTaskBlocking + EPSILON >= oldRun.rTaskBlocking,
      recall: newRun.recall + EPSILON >= oldRun.recall,
      pRead: newRun.pRead + P_READ_TOLERANCE + EPSILON >= oldRun.pRead,
      estimatedTokens: newRun.estimatedTokensP50 <= oldRun.estimatedTokensP50 + EPSILON,
      p95: newRun.p95 <= p95ThresholdMs + EPSILON
    };
    projectSummaries.push({
      project,
      old: oldRun,
      new: newRun,
      delta: {
        recall: newRun.recall - oldRun.recall,
        pRead: newRun.pRead - oldRun.pRead,
        rReadMust: newRun.rReadMust - oldRun.rReadMust,
        rTaskBlocking: newRun.rTaskBlocking - oldRun.rTaskBlocking,
        estimatedTokensP50: newRun.estimatedTokensP50 - oldRun.estimatedTokensP50,
        p95Ratio,
        p95ThresholdMs
      },
      gate,
      passed: Object.values(gate).every(Boolean)
    });
  }

  const scenarioFiles = scenarioFilesByProject(cells);
  const inputSha256 = sha256(JSON.stringify({
    manifest: manifest.sha256,
    verifierVersion: VERIFIER_VERSION,
    expectedRuns,
    p95Limit,
    cells: cells.map(cell => ({
      file: path.basename(cell.file),
      sha256: cell.sha256,
      stderrSha256: cell.stderrSha256
    }))
  }));
  const result = {
    version: VERIFIER_VERSION,
    verifiedAt: new Date().toISOString(),
    matrixDir: resolvedMatrixDir,
    manifest: {
      file: manifest.file,
      sha256: manifest.sha256,
      verifierVersion: manifest.value.verifierVersion,
      runtimes: manifest.value.runtimes,
      repositories: manifest.value.repositories,
      scenarios: manifest.value.scenarios,
      candidatePatch: manifest.value.candidatePatch
    },
    inputSha256,
    configuration: {
      projects: MATRIX_PROJECTS,
      rounds: MATRIX_ROUNDS,
      variants: MATRIX_VARIANTS,
      expectedCells: MATRIX_PROJECTS.length * MATRIX_ROUNDS.length * MATRIX_VARIANTS.length,
      expectedRuns,
      p95Limit
    },
    scenarioFiles,
    cells,
    projects: projectSummaries,
    warnings: [],
    passed: projectSummaries.every(project => project.passed)
  };

  const target = summaryFile ? path.resolve(summaryFile) : path.join(resolvedMatrixDir, "matrix-summary.json");
  result.summaryFile = target;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function aggregateProject(matrixDir, project, variant, expectedRuns, cells, manifest) {
  const attempts = [];
  const scenarioFiles = new Set();
  for (const round of MATRIX_ROUNDS) {
    const file = path.join(matrixDir, `${project}-r${round}-${variant}.json`);
    const payloadRead = readPayload(file);
    const payload = payloadRead.value;
    validateMetadata(payload, { file, project, variant, expectedRuns, manifest });
    validateRows(payload.rows, { file, expectedRowIds: manifest.value.scenarios[project].rowIds });
    scenarioFiles.add(payload.metadata.scenarioFile);
    const stderr = readStderr(file);
    cells.push({
      project,
      round,
      variant,
      file,
      sha256: payloadRead.sha256,
      scenarioFile: payload.metadata.scenarioFile,
      stderrBytes: stderr.bytes,
      stderrSha256: stderr.sha256,
      rows: payload.rows.length
    });
    for (const row of payload.rows) {
      if (!Array.isArray(row.attempts) || row.attempts.length !== expectedRuns) {
        throw new MatrixValidationError(`${file}: ${String(row.id || "unknown scenario")} must contain exactly ${expectedRuns} attempts`);
      }
      for (const attempt of row.attempts) {
        validateAttempt(attempt, file, row.id);
        attempts.push({ scenario: row.id, ...attempt, rTaskBlocking: taskBlockingRecall(attempt, file, row.id) });
      }
    }
  }
  if (scenarioFiles.size !== 1) {
    throw new MatrixValidationError(`${project}/${variant} did not use exactly one frozen scenario file`);
  }
  if (attempts.length === 0) throw new MatrixValidationError(`${project}/${variant} contains no attempts`);
  return {
    attempts: attempts.length,
    scenarioFile: scenarioFiles.values().next().value,
    recall: mean(attempts, "recall"),
    pRead: mean(attempts, "pRead"),
    rReadMust: mean(attempts, "rReadMust"),
    rTaskBlocking: mean(attempts, "rTaskBlocking"),
    minReadMust: Math.min(...attempts.map(attempt => attempt.rReadMust)),
    minTaskBlocking: Math.min(...attempts.map(attempt => attempt.rTaskBlocking)),
    estimatedTokensP50: percentile(attempts.map(attempt => attempt.estimatedTokens), 0.5),
    estimatedTokensP95: percentile(attempts.map(attempt => attempt.estimatedTokens), 0.95),
    rangeEvidence: summarizeRangeEvidence(attempts),
    p50: percentile(attempts.map(attempt => attempt.elapsedMs), 0.5),
    p95: percentile(attempts.map(attempt => attempt.elapsedMs), 0.95),
    max: Math.max(...attempts.map(attempt => attempt.elapsedMs)),
    mustFailureScenarios: [...new Set(attempts
      .filter(attempt => attempt.rReadMust !== 1)
      .map(attempt => attempt.scenario))]
  };
}

function validateMetadata(payload, { file, project, variant, expectedRuns, manifest }) {
  if (!payload || typeof payload !== "object" || !payload.metadata || !Array.isArray(payload.rows)) {
    throw new MatrixValidationError(`${file}: missing metadata or rows`);
  }
  const metadata = payload.metadata;
  if (metadata.projectId !== project) throw new MatrixValidationError(`${file}: projectId mismatch`);
  if (metadata.warmState !== "cold-nolsp") throw new MatrixValidationError(`${file}: warmState must be cold-nolsp`);
  if (metadata.strategy !== "impact") throw new MatrixValidationError(`${file}: strategy must be impact`);
  if (metadata.verbosity !== "diagnostic") throw new MatrixValidationError(`${file}: verbosity must be diagnostic`);
  if (metadata.runs !== expectedRuns) throw new MatrixValidationError(`${file}: metadata.runs must be ${expectedRuns}`);
  if (!(typeof metadata.scenarioFile === "string" && path.isAbsolute(metadata.scenarioFile))) {
    throw new MatrixValidationError(`${file}: scenarioFile must be an absolute frozen path`);
  }
  const expectedRepo = manifest.value.repositories[project];
  const expectedScenario = manifest.value.scenarios[project];
  const expectedRuntime = manifest.value.runtimes[variant];
  if (path.resolve(metadata.repoRoot || "") !== path.resolve(expectedRepo.root)) {
    throw new MatrixValidationError(`${file}: repoRoot does not match manifest`);
  }
  if (!(typeof metadata.repoCommit === "string" && metadata.repoCommit.length >= 12 && expectedRepo.head.startsWith(metadata.repoCommit))) {
    throw new MatrixValidationError(`${file}: repoCommit does not match manifest repo HEAD`);
  }
  if (path.resolve(metadata.scenarioFile) !== path.resolve(expectedScenario.file)) {
    throw new MatrixValidationError(`${file}: scenarioFile does not match manifest`);
  }
  if (stableJson(normalizeBuildStamp(metadata.runtimeBuild)) !== stableJson(expectedRuntime.buildStamp)) {
    throw new MatrixValidationError(`${file}: runtime build stamp does not match manifest ${variant} runtime`);
  }
  const provenance = metadata.matrixProvenance;
  if (!provenance || typeof provenance !== "object") {
    throw new MatrixValidationError(`${file}: missing matrixProvenance`);
  }
  const exactFields = {
    manifestSha256: manifest.sha256,
    variant,
    runtimeCommit: expectedRuntime.commit,
    runtimeCommitTree: expectedRuntime.commitTree,
    runtimeExecutableTree: expectedRuntime.executableTree,
    candidatePatchSha256: manifest.value.candidatePatch.sha256,
    repoHead: expectedRepo.head,
    repoTree: expectedRepo.tree,
    repoStatusSha256: expectedRepo.statusSha256,
    scenarioSha256: expectedScenario.sha256
  };
  for (const [key, expected] of Object.entries(exactFields)) {
    if (provenance[key] !== expected) {
      throw new MatrixValidationError(`${file}: matrixProvenance.${key} does not match manifest`);
    }
  }
  if (!sameStringArray(provenance.scenarioIds, expectedScenario.rowIds)) {
    throw new MatrixValidationError(`${file}: matrixProvenance scenario ids do not match manifest`);
  }
}

function validateRows(rows, { file, expectedRowIds }) {
  const rowIds = rows.map(row => row?.id);
  if (rowIds.some(id => typeof id !== "string" || id.length === 0)) {
    throw new MatrixValidationError(`${file}: every row must have a non-empty id`);
  }
  if (new Set(rowIds).size !== rowIds.length) {
    throw new MatrixValidationError(`${file}: duplicate scenario row id`);
  }
  if (!sameStringSet(rowIds, expectedRowIds)) {
    throw new MatrixValidationError(`${file}: scenario row set does not match manifest`);
  }
}

function validateAttempt(attempt, file, scenarioId) {
  if (!attempt || typeof attempt !== "object" || attempt.strategy !== "impact") {
    throw new MatrixValidationError(`${file}: ${scenarioId} attempt strategy must be impact`);
  }
  const semantic = attempt.timing?.semantic;
  if (!semantic || semantic.policy !== "fast" || semantic.used !== false || semantic.timeout !== false) {
    throw new MatrixValidationError(`${file}: ${scenarioId} violates cold-nolsp semantic completion policy`);
  }
  for (const metric of ["recall", "pRead", "rReadMust"]) {
    requireMetric(attempt[metric], metric, file, scenarioId, { max: 1 });
  }
  for (const metric of ["estimatedTokens", "elapsedMs"]) {
    requireMetric(attempt[metric], metric, file, scenarioId);
  }
  if (attempt.readPlanRangeRecall !== undefined
    && (!(typeof attempt.readPlanRangeRecall === "number" && Number.isFinite(attempt.readPlanRangeRecall))
      || attempt.readPlanRangeRecall < 0
      || attempt.readPlanRangeRecall > 1)) {
    throw new MatrixValidationError(`${file}: ${scenarioId} has invalid readPlanRangeRecall`);
  }
}

function taskBlockingRecall(attempt, file, scenarioId) {
  if (attempt.rTaskBlocking !== undefined) {
    requireMetric(attempt.rTaskBlocking, "rTaskBlocking", file, scenarioId, { max: 1 });
    return attempt.rTaskBlocking;
  }
  if (!Array.isArray(attempt.goldenAttribution)) {
    throw new MatrixValidationError(`${file}: ${scenarioId} has no rTaskBlocking or derivable golden attribution`);
  }
  const blockingByFile = new Map();
  for (const row of attempt.goldenAttribution) {
    if (!row || typeof row.file !== "string") continue;
    if (row.kind === "must" || (row.kind === "should" && row.shouldBlocksTask === true)) {
      blockingByFile.set(row.file, row.inReadPlan === true);
    }
  }
  if (blockingByFile.size === 0) return 1;
  return [...blockingByFile.values()].filter(Boolean).length / blockingByFile.size;
}

function requireMetric(value, metric, file, scenarioId, { max } = {}) {
  if (!(typeof value === "number" && Number.isFinite(value) && value >= 0 && (max === undefined || value <= max))) {
    throw new MatrixValidationError(`${file}: ${scenarioId} has invalid ${metric}`);
  }
}

function summarizeRangeEvidence(attempts) {
  const measured = attempts
    .map(attempt => attempt.readPlanRangeRecall)
    .filter(value => typeof value === "number" && Number.isFinite(value));
  const measuredAttempts = measured.length;
  const unmeasuredAttempts = attempts.length - measuredAttempts;
  return {
    status: measuredAttempts === 0 ? "UNMEASURED" : unmeasuredAttempts === 0 ? "MEASURED" : "PARTIAL",
    measuredAttempts,
    unmeasuredAttempts,
    mean: measuredAttempts > 0 ? measured.reduce((total, value) => total + value, 0) / measuredAttempts : undefined,
    min: measuredAttempts > 0 ? Math.min(...measured) : undefined
  };
}

function scenarioFilesByProject(cells) {
  const result = {};
  for (const project of MATRIX_PROJECTS) {
    const files = new Set(cells.filter(cell => cell.project === project).map(cell => cell.scenarioFile));
    if (files.size !== 1) {
      throw new MatrixValidationError(`${project} old/new cells did not share the same frozen scenario file`);
    }
    result[project] = files.values().next().value;
  }
  return result;
}

function readPayload(file) {
  try {
    const bytes = readFileSync(file);
    return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256(bytes) };
  } catch (error) {
    throw new MatrixValidationError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readStderr(file) {
  try {
    const bytes = readFileSync(`${file}.stderr`);
    if (bytes.length > 0) {
      throw new MatrixValidationError(`${file}.stderr must be empty for a formal matrix`);
    }
    return { bytes: bytes.length, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof MatrixValidationError) throw error;
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new MatrixValidationError(`${file}.stderr is missing`);
    }
    throw error;
  }
}

function readAndValidateManifest(file, expectedRuns, p95Limit) {
  let bytes;
  let value;
  try {
    bytes = readFileSync(file);
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new MatrixValidationError(`cannot read manifest ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || value.version !== VERIFIER_VERSION || value.verifierVersion !== VERIFIER_VERSION) {
    throw new MatrixValidationError(`${file}: manifest version/verifierVersion must be ${VERIFIER_VERSION}`);
  }
  if (value.runs !== expectedRuns) {
    throw new MatrixValidationError(`${file}: manifest runs must be ${expectedRuns}`);
  }
  if (value.p95Limit !== p95Limit) {
    throw new MatrixValidationError(`${file}: manifest p95Limit must be ${p95Limit}`);
  }
  const policy = value.comparisonPolicy;
  if (!policy
    || policy.baseline !== "executable-code-baseline"
    || policy.baselineRevision !== value.runtimes?.old?.commit
    || policy.goldenSchema !== "task36-cross-version-v1"
    || policy.pReadTolerance !== P_READ_TOLERANCE
    || policy.p95AbsoluteSlackMs !== P95_ABSOLUTE_SLACK_MS
    || policy.taskBlockingBaseline !== "attempt-or-derived-attribution") {
    throw new MatrixValidationError(`${file}: invalid executable-baseline comparison policy`);
  }
  if (!sameStringArray(value.rounds, ["old/new", "new/old", "old/new"])) {
    throw new MatrixValidationError(`${file}: manifest rounds must be AB/BA/AB`);
  }
  for (const variant of MATRIX_VARIANTS) validateRuntime(value.runtimes?.[variant], file, variant);
  if (value.runtimes.old.commit === value.runtimes.new.commit
    || value.runtimes.old.executableTree === value.runtimes.new.executableTree) {
    throw new MatrixValidationError(`${file}: old and new runtime commits and trees must be different`);
  }
  validateHashBoundFile(value.candidatePatch, file, "candidate patch");
  if (value.candidatePatch.appliedToCommit !== value.runtimes.new.commit
    || value.candidatePatch.appliedToCommitTree !== value.runtimes.new.commitTree
    || value.candidatePatch.resultingExecutableTree !== value.runtimes.new.executableTree) {
    throw new MatrixValidationError(`${file}: candidate patch resulting executable tree does not match the new runtime identity`);
  }
  if (!Array.isArray(value.candidatePatch.untrackedInputs)) {
    throw new MatrixValidationError(`${file}: candidate patch untracked input manifest is missing`);
  }
  const untrackedPaths = new Set();
  for (const input of value.candidatePatch.untrackedInputs) {
    if (!input || typeof input.path !== "string" || path.isAbsolute(input.path) || input.path.split(/[\\/]+/).includes("..")) {
      throw new MatrixValidationError(`${file}: invalid untracked source input path`);
    }
    if (untrackedPaths.has(input.path)) {
      throw new MatrixValidationError(`${file}: duplicate untracked source input ${input.path}`);
    }
    untrackedPaths.add(input.path);
    validateHashBoundFile(input, file, `untracked source input ${input.path}`);
  }
  for (const project of MATRIX_PROJECTS) {
    const repo = value.repositories?.[project];
    if (!repo
      || typeof repo.root !== "string"
      || !path.isAbsolute(repo.root)
      || !gitObjectId(repo.head)
      || !gitObjectId(repo.tree)
      || repo.clean !== true
      || repo.statusSha256 !== sha256("")) {
      throw new MatrixValidationError(`${file}: invalid repository manifest for ${project}`);
    }
    const scenario = value.scenarios?.[project];
    if (!scenario || typeof scenario.file !== "string" || !path.isAbsolute(scenario.file) || !sha256Value(scenario.sha256)) {
      throw new MatrixValidationError(`${file}: invalid scenario manifest for ${project}`);
    }
    if (!Array.isArray(scenario.rowIds) || scenario.rowIds.length === 0 || scenario.rowIds.some(id => typeof id !== "string" || !id)) {
      throw new MatrixValidationError(`${file}: ${project} scenario row-id manifest is empty or invalid`);
    }
    if (new Set(scenario.rowIds).size !== scenario.rowIds.length) {
      throw new MatrixValidationError(`${file}: ${project} scenario row-id manifest contains duplicates`);
    }
    validateHashBoundFile(scenario, file, `${project} scenario`);
    const actualScenarioIds = scenarioIdsFromJsonl(scenario.file);
    if (!sameStringSet(actualScenarioIds, scenario.rowIds)) {
      throw new MatrixValidationError(`${file}: ${project} scenario row ids do not match frozen scenario contents`);
    }
  }
  return { file, value, sha256: sha256(bytes) };
}

function validateRuntime(runtime, manifestFile, variant) {
  if (!runtime
    || !gitObjectId(runtime.commit)
    || !gitObjectId(runtime.commitTree)
    || !gitObjectId(runtime.executableTree)) {
    throw new MatrixValidationError(`${manifestFile}: invalid ${variant} runtime commit/tree`);
  }
  if (variant === "old" && runtime.commitTree !== runtime.executableTree) {
    throw new MatrixValidationError(`${manifestFile}: baseline executable tree must equal its commit tree`);
  }
  if (!runtime.buildStamp || typeof runtime.buildStamp !== "object") {
    throw new MatrixValidationError(`${manifestFile}: missing ${variant} runtime build stamp`);
  }
  const gitSha = runtime.buildStamp.gitSha;
  if (!(typeof gitSha === "string" && gitSha.length >= 12 && runtime.commit.startsWith(gitSha))) {
    throw new MatrixValidationError(`${manifestFile}: ${variant} build stamp gitSha does not match runtime commit`);
  }
}

function validateHashBoundFile(entry, manifestFile, label) {
  if (!entry || typeof entry.file !== "string" || !path.isAbsolute(entry.file) || !sha256Value(entry.sha256)) {
    throw new MatrixValidationError(`${manifestFile}: invalid ${label} file/hash binding`);
  }
  let bytes;
  try {
    bytes = readFileSync(entry.file);
  } catch (error) {
    throw new MatrixValidationError(`${manifestFile}: cannot read ${label} ${entry.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sha256(bytes) !== entry.sha256) {
    throw new MatrixValidationError(`${manifestFile}: ${label} sha256 does not match current bytes`);
  }
  if (entry.bytes !== undefined && entry.bytes !== bytes.length) {
    throw new MatrixValidationError(`${manifestFile}: ${label} byte length does not match current bytes`);
  }
}

function scenarioIdsFromJsonl(file) {
  const seen = new Set();
  return readFileSync(file, "utf8").split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new MatrixValidationError(`${file}:${index + 1}: invalid scenario JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!row || typeof row.id !== "string" || !row.id) {
      throw new MatrixValidationError(`${file}:${index + 1}: scenario id is required`);
    }
    if (seen.has(row.id)) throw new MatrixValidationError(`${file}:${index + 1}: duplicate scenario id ${row.id}`);
    seen.add(row.id);
    return row.id;
  });
}

function normalizeBuildStamp(value) {
  if (!value || typeof value !== "object") return value;
  const { stampPath: _stampPath, ...stamp } = value;
  return stamp;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameStringArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameStringSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every(value => expected.includes(value));
}

function gitObjectId(value) {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
}

function sha256Value(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function mean(items, key) {
  return items.reduce((total, item) => total + item[key], 0) / items.length;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export class MatrixValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MatrixValidationError";
  }
}

function parseCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) {
      throw new MatrixValidationError(`invalid argument: ${key}`);
    }
    options.set(key, args[index + 1]);
    index += 1;
  }
  return {
    matrixDir: options.get("--matrix-dir"),
    expectedRuns: numberOption(options.get("--expected-runs"), 5, "--expected-runs"),
    p95Limit: numberOption(options.get("--p95-limit"), 1.25, "--p95-limit"),
    manifestFile: options.get("--manifest"),
    summaryFile: options.get("--summary-file")
  };
}

function numberOption(value, fallback, flag) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new MatrixValidationError(`${flag} must be numeric`);
  return parsed;
}

function printUsage() {
  console.log(`usage: node scripts/verify-three-repo-cold-matrix.mjs --matrix-dir <dir> [--manifest <run-manifest.json>] [--expected-runs 5] [--p95-limit 1.10] [--summary-file <file>]`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const cli = parseCli(process.argv.slice(2));
    if (cli.help) {
      printUsage();
    } else {
      const result = verifyMatrix(cli);
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
      if (!result.passed) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

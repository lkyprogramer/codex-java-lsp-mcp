#!/usr/bin/env node
// input: A three-repository AB/BA/AB cold-nolsp impact matrix.
// output: Reproducible paired quality/latency gate summary with a failing exit code on any hard-gate regression.
// pos: Shared verifier for Task 30 and later ranking/framework changes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MATRIX_PROJECTS = ["lishuedu", "cipherlink", "exam-parent-v3"];
export const MATRIX_ROUNDS = [1, 2, 3];
export const MATRIX_VARIANTS = ["old", "new"];

const EPSILON = 1e-12;

export function verifyMatrix({ matrixDir, expectedRuns = 5, p95Limit = 1.10, summaryFile } = {}) {
  if (!matrixDir) throw new MatrixValidationError("--matrix-dir is required");
  if (!Number.isInteger(expectedRuns) || expectedRuns <= 0) {
    throw new MatrixValidationError("expectedRuns must be a positive integer");
  }
  if (!(Number.isFinite(p95Limit) && p95Limit > 0)) {
    throw new MatrixValidationError("p95Limit must be a positive number");
  }

  const resolvedMatrixDir = path.resolve(matrixDir);
  const cells = [];
  const projectSummaries = [];

  for (const project of MATRIX_PROJECTS) {
    const byVariant = new Map();
    for (const variant of MATRIX_VARIANTS) {
      const aggregate = aggregateProject(resolvedMatrixDir, project, variant, expectedRuns, cells);
      byVariant.set(variant, aggregate);
    }

    const oldRun = byVariant.get("old");
    const newRun = byVariant.get("new");
    const p95Ratio = newRun.p95 / oldRun.p95;
    const gate = {
      rReadMust: newRun.minReadMust === 1,
      recall: newRun.recall + EPSILON >= oldRun.recall,
      pRead: newRun.pRead + EPSILON >= oldRun.pRead,
      p95: p95Ratio <= p95Limit + EPSILON
    };
    projectSummaries.push({
      project,
      old: oldRun,
      new: newRun,
      delta: {
        recall: newRun.recall - oldRun.recall,
        pRead: newRun.pRead - oldRun.pRead,
        rReadMust: newRun.rReadMust - oldRun.rReadMust,
        p95Ratio
      },
      gate,
      passed: Object.values(gate).every(Boolean)
    });
  }

  const scenarioFiles = scenarioFilesByProject(cells);
  const warnings = cells
    .filter(cell => cell.stderrBytes > 0)
    .map(cell => `${path.basename(cell.file)} has ${cell.stderrBytes} stderr byte(s)`);
  const result = {
    version: 1,
    verifiedAt: new Date().toISOString(),
    matrixDir: resolvedMatrixDir,
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
    warnings,
    passed: projectSummaries.every(project => project.passed)
  };

  const target = summaryFile ? path.resolve(summaryFile) : path.join(resolvedMatrixDir, "matrix-summary.json");
  result.summaryFile = target;
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function aggregateProject(matrixDir, project, variant, expectedRuns, cells) {
  const attempts = [];
  const scenarioFiles = new Set();
  for (const round of MATRIX_ROUNDS) {
    const file = path.join(matrixDir, `${project}-r${round}-${variant}.json`);
    const payload = readPayload(file);
    validateMetadata(payload, { file, project, expectedRuns });
    scenarioFiles.add(payload.metadata.scenarioFile);
    const stderrBytes = readStderrBytes(file);
    cells.push({
      project,
      round,
      variant,
      file,
      scenarioFile: payload.metadata.scenarioFile,
      stderrBytes,
      rows: payload.rows.length
    });
    for (const row of payload.rows) {
      if (!Array.isArray(row.attempts) || row.attempts.length !== expectedRuns) {
        throw new MatrixValidationError(`${file}: ${String(row.id || "unknown scenario")} must contain exactly ${expectedRuns} attempts`);
      }
      for (const attempt of row.attempts) {
        for (const metric of ["recall", "pRead", "rReadMust", "elapsedMs"]) {
          if (!(typeof attempt[metric] === "number" && Number.isFinite(attempt[metric]))) {
            throw new MatrixValidationError(`${file}: ${String(row.id || "unknown scenario")} has invalid ${metric}`);
          }
        }
        attempts.push({ scenario: row.id, ...attempt });
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
    minReadMust: Math.min(...attempts.map(attempt => attempt.rReadMust)),
    p50: percentile(attempts.map(attempt => attempt.elapsedMs), 0.5),
    p95: percentile(attempts.map(attempt => attempt.elapsedMs), 0.95),
    max: Math.max(...attempts.map(attempt => attempt.elapsedMs)),
    mustFailureScenarios: [...new Set(attempts
      .filter(attempt => attempt.rReadMust !== 1)
      .map(attempt => attempt.scenario))]
  };
}

function validateMetadata(payload, { file, project, expectedRuns }) {
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
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new MatrixValidationError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readStderrBytes(file) {
  try {
    return readFileSync(`${file}.stderr`).length;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return 0;
    throw error;
  }
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
    p95Limit: numberOption(options.get("--p95-limit"), 1.10, "--p95-limit"),
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
  console.log(`usage: node scripts/verify-three-repo-cold-matrix.mjs --matrix-dir <dir> [--expected-runs 5] [--p95-limit 1.10] [--summary-file <file>]`);
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

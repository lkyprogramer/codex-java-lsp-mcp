// input: One diagnostic java_impact result, or a benchmark JSON containing repeated attempts.
// output: A latency-free semantic snapshot and a strict 20-run drift verification summary.
// pos: Task 36 determinism gate; benchmark-only evidence, never part of the public MCP payload.
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ImpactResult } from "../agent-types.js";
import type { ProductionRankingSnapshot } from "./attribution-v3.js";

const SCORE_PRECISION = 4;
const DEFAULT_EXPECTED_RUNS = 20;

type DeterminismRange = {
  startLine: number;
  endLine: number;
  reason: string;
};

type DeterminismReadPlanItem = {
  path: string;
  priority: string;
  ranges: DeterminismRange[];
};

type DeterminismFamilyScores = {
  path: string;
  finalScore: number;
  families: Record<string, number>;
};

export type ImpactDeterminismSnapshot = {
  candidatePaths: string[];
  readPlan: DeterminismReadPlanItem[];
  /** Undefined means the run did not enable diagnostic shadow ranking and cannot satisfy Task 36. */
  familyScores?: DeterminismFamilyScores[];
  completion: {
    semantic: string;
    semanticUsed: boolean;
    readiness?: string;
    coverage: string;
    requestGeneration: number;
    indexedGeneration: number;
    changedDuringRequest: boolean;
  };
};

export type ImpactDeterminismSummary = {
  rows: number;
  attempts: number;
  expectedRuns: number;
  stable: true;
};

/**
 * Extracts only fields that must be invariant across identical cold runs.
 * Latency, byte counters, cache hits and phase timing deliberately stay out.
 */
export function buildImpactDeterminismSnapshot(
  result: ImpactResult,
  repoRoot: string,
  productionRanking?: ProductionRankingSnapshot
): ImpactDeterminismSnapshot {
  const pathById = new Map(result.files.map(file => [file.id, file.path]));
  return {
    candidatePaths: result.files.map(file => file.path),
    readPlan: result.readPlan.map(item => ({
      path: pathById.get(item.fileId) ?? `<missing:${item.fileId}>`,
      priority: item.priority,
      ranges: item.ranges.map(range => ({
        startLine: range.startLine,
        endLine: range.endLine,
        reason: range.reason ?? ""
      }))
    })),
    familyScores: productionRanking?.candidates.map(candidate => ({
      path: repoRelativePath(repoRoot, candidate.path),
      finalScore: rounded(candidate.finalScore),
      families: sortedRoundedRecord(candidate.familyScores)
    })),
    completion: {
      semantic: result.semantic.completion,
      semanticUsed: result.semantic.used,
      readiness: result.semantic.readiness,
      coverage: result.freshness.coverage,
      requestGeneration: result.freshness.requestGeneration,
      indexedGeneration: result.freshness.indexedGeneration,
      changedDuringRequest: result.freshness.changedDuringRequest
    }
  };
}

/**
 * Verifies a benchmark payload produced with `--warm-state cold-nolsp
 * --runs 20 --verbosity diagnostic` with the production-ranking observer. Each row is
 * compared to its first attempt; rows need not equal one another.
 */
export function verifyImpactDeterminismPayload(
  payload: unknown,
  expectedRuns = DEFAULT_EXPECTED_RUNS
): ImpactDeterminismSummary {
  const root = record(payload, "benchmark payload");
  const metadata = record(root.metadata, "metadata");
  if (metadata.warmState !== "cold-nolsp") {
    throw new Error(`determinism gate requires warmState=cold-nolsp, got ${String(metadata.warmState)}`);
  }
  if (metadata.runs !== expectedRuns) {
    throw new Error(`determinism gate expected metadata.runs=${expectedRuns}, got ${String(metadata.runs)}`);
  }
  if (!Array.isArray(root.rows) || root.rows.length === 0) {
    throw new Error("determinism gate requires at least one benchmark row");
  }

  let attempts = 0;
  for (const rawRow of root.rows) {
    const row = record(rawRow, "row");
    const rowId = typeof row.id === "string" && row.id.length > 0 ? row.id : "<unknown-row>";
    if (!Array.isArray(row.attempts) || row.attempts.length !== expectedRuns) {
      throw new Error(`${rowId}: expected ${expectedRuns} attempts, got ${Array.isArray(row.attempts) ? row.attempts.length : "missing"}`);
    }
    const snapshots = row.attempts.map((rawAttempt, index) => {
      const attempt = record(rawAttempt, `${rowId} attempt ${index + 1}`);
      return validatedSnapshot(attempt.determinism, `${rowId} attempt ${index + 1}`);
    });
    const baseline = snapshots[0]!;
    for (let index = 1; index < snapshots.length; index += 1) {
      const candidate = snapshots[index]!;
      for (const field of ["candidatePaths", "readPlan", "familyScores", "completion"] as const) {
        if (!isDeepStrictEqual(candidate[field], baseline[field])) {
          throw new Error(`${rowId}: attempt ${index + 1} drifted in ${field}`);
        }
      }
    }
    attempts += snapshots.length;
  }

  return { rows: root.rows.length, attempts, expectedRuns, stable: true };
}

function validatedSnapshot(value: unknown, context: string): ImpactDeterminismSnapshot {
  const snapshot = record(value, `${context} determinism snapshot`);
  if (!Array.isArray(snapshot.candidatePaths)) {
    throw new Error(`${context}: missing determinism.candidatePaths`);
  }
  if (!Array.isArray(snapshot.readPlan)) {
    throw new Error(`${context}: missing determinism.readPlan`);
  }
  if (!Array.isArray(snapshot.familyScores)) {
    throw new Error(`${context}: missing determinism.familyScores; rerun through the diagnostic production-ranking observer`);
  }
  record(snapshot.completion, `${context} determinism.completion`);
  return snapshot as ImpactDeterminismSnapshot;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function repoRelativePath(repoRoot: string, candidatePath: string): string {
  const relative = path.isAbsolute(candidatePath) ? path.relative(repoRoot, candidatePath) : candidatePath;
  return relative.split(path.sep).join("/");
}

function rounded(value: number): number {
  return Number(value.toFixed(SCORE_PRECISION));
}

function sortedRoundedRecord(values: Partial<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(values)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, rounded(value)]));
}

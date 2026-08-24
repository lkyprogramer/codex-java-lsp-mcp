// input: A scenario's golden files plus the exact production family rank/read-plan snapshot.
// output: Typed GoldenAttributionV3 rows sourced from real provider/family evidence.
// pos: Task 32 Step 2 - replaces V2's regex-based goldenAttributionRow for the "impact"
//      strategy. Every field here traces to a concrete diagnostic (familyScores, providers,
//      rank, coverage state, semantic completion) rather than a reread-and-guess heuristic.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ImpactMode, ImpactResult, ImpactVerbosity } from "../agent-types.js";
import type { CandidateEvidence, EvidenceFamily } from "../agent-router/evidence.js";
import { projectImpactResultV6 } from "../agent-router/format.js";
import { candidateLimit } from "../agent-router/read-plan.js";
import type { SourceRootCoverage } from "../java-index/index-types.js";
import { goldenEntries, type GoldenKind, type Scenario } from "./golden-scenario.js";

export type ImpactPayloadFieldAttributionV3 = {
  occurrences: number;
  valueJsonBytes: number;
  /** Marginal wire bytes after removing every occurrence and reconverging cost. Nested field deltas are not additive. */
  omitDeltaBytes: number;
};

export type ImpactPayloadProjectionEntryV3 = {
  serializedBytes: number;
  costResultBytes: number;
  projectionEstimatedTokens: number;
  candidateReadPlanSha256: string;
  fields: Record<string, ImpactPayloadFieldAttributionV3>;
};

export type ImpactPayloadProjectionV3 = {
  schemaVersion: "impact-payload-projection-v3";
  canonicalExecutions: 1;
  canonicalVerbosity: "diagnostic";
  defaultToolResponse: "standard";
  defaultToolSerializedBytes: number;
  defaultToolEstimatedTokens: number;
  diagnosticSerializedBytes: number;
  diagnosticEstimatedTokens: number;
  standardToDiagnosticBytesRatio: number;
  candidateReadPlanSha256: string;
  projections: Record<ImpactVerbosity, ImpactPayloadProjectionEntryV3>;
};

const PAYLOAD_VERBOSITIES: readonly ImpactVerbosity[] = ["compact", "standard", "diagnostic"];
const PAYLOAD_FIELDS = [
  "files",
  "readPlan",
  "metrics",
  "evidenceGaps",
  "files.locations",
  "files.reasons",
  "files.scoreBreakdown",
  "files.verifiedBy"
] as const;

export function buildImpactPayloadProjectionV3(canonicalDiagnostic: ImpactResult): ImpactPayloadProjectionV3 {
  const projections = {} as Record<ImpactVerbosity, ImpactPayloadProjectionEntryV3>;
  const fingerprint = candidateReadPlanFingerprint(canonicalDiagnostic);
  for (const verbosity of PAYLOAD_VERBOSITIES) {
    const payload = projectImpactResultV6(canonicalDiagnostic, verbosity);
    const serializedBytes = jsonBytes(payload);
    if (payload.cost.resultBytes !== serializedBytes) {
      throw new Error(`${verbosity} ImpactResultV6 cost.resultBytes does not match serialized bytes`);
    }
    const projectionFingerprint = candidateReadPlanFingerprint(payload);
    if (projectionFingerprint !== fingerprint) {
      throw new Error(`${verbosity} projection changed candidate/read-plan identity`);
    }
    projections[verbosity] = {
      serializedBytes,
      costResultBytes: payload.cost.resultBytes,
      projectionEstimatedTokens: Math.ceil(serializedBytes / 4),
      candidateReadPlanSha256: projectionFingerprint,
      fields: Object.fromEntries(PAYLOAD_FIELDS.map(field => [field, fieldAttribution(payload, field)]))
    };
  }
  const standard = projections.standard;
  const diagnostic = projections.diagnostic;
  return {
    schemaVersion: "impact-payload-projection-v3",
    canonicalExecutions: 1,
    canonicalVerbosity: "diagnostic",
    defaultToolResponse: "standard",
    defaultToolSerializedBytes: standard.serializedBytes,
    defaultToolEstimatedTokens: standard.projectionEstimatedTokens,
    diagnosticSerializedBytes: diagnostic.serializedBytes,
    diagnosticEstimatedTokens: diagnostic.projectionEstimatedTokens,
    standardToDiagnosticBytesRatio: diagnostic.serializedBytes > 0
      ? standard.serializedBytes / diagnostic.serializedBytes
      : 0,
    candidateReadPlanSha256: fingerprint,
    projections
  };
}

function candidateReadPlanFingerprint(payload: ImpactResult): string {
  return sha256(JSON.stringify({
    files: payload.files.map(file => ({
      id: file.id,
      path: file.path,
      role: file.role,
      confidence: file.confidence,
      evidence: file.evidence,
      locations: file.locations
    })),
    readPlan: payload.readPlan.map(item => ({ ...item, ranges: item.ranges.map(({ reason: _reason, ...range }) => range) }))
  }));
}

function fieldAttribution(
  payload: ImpactResult,
  field: typeof PAYLOAD_FIELDS[number]
): ImpactPayloadFieldAttributionV3 {
  const values = fieldValues(payload, field);
  if (values.length === 0) return { occurrences: 0, valueJsonBytes: 0, omitDeltaBytes: 0 };
  const without = structuredClone(payload) as ImpactResult;
  omitField(without, field);
  const converged = projectImpactResultV6(without, "diagnostic");
  return {
    occurrences: values.length,
    valueJsonBytes: values.reduce<number>((sum, value) => sum + jsonBytes(value), 0),
    omitDeltaBytes: payload.cost.resultBytes - converged.cost.resultBytes
  };
}

function fieldValues(payload: ImpactResult, field: typeof PAYLOAD_FIELDS[number]): unknown[] {
  if (field.startsWith("files.")) {
    const property = field.slice("files.".length) as "locations" | "reasons" | "scoreBreakdown" | "verifiedBy";
    return payload.files.filter(file => Object.hasOwn(file, property)).map(file => file[property]);
  }
  return Object.hasOwn(payload, field) ? [(payload as unknown as Record<string, unknown>)[field]] : [];
}

function omitField(payload: ImpactResult, field: typeof PAYLOAD_FIELDS[number]): void {
  if (field.startsWith("files.")) {
    const property = field.slice("files.".length);
    for (const file of payload.files) delete (file as unknown as Record<string, unknown>)[property];
    return;
  }
  delete (payload as unknown as Record<string, unknown>)[field];
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type GoldenBlockedByV3 = "hit" | "readplan-budget" | "candidate-limit" | "absent";

export type GoldenAbsentReasonV3 =
  | "coverage-partial"
  | "no-static-edge"
  | "semantic-not-used"
  | "semantic-timeout"
  | "golden-stale-or-low-value";

export type GoldenAttributionV3 = {
  scenarioId: string;
  file: string;
  kind: GoldenKind;
  inCandidates: boolean;
  inReadPlan: boolean;
  firstRank?: number;
  sourceFamilies: EvidenceFamily[];
  providers: string[];
  blockedBy: GoldenBlockedByV3;
  absentReason?: GoldenAbsentReasonV3;
};

export type AttributionV3Context = {
  readonly repoRoot: string;
  readonly mode: ImpactMode;
  readonly profile?: string;
  readonly semanticUsed: boolean;
  readonly semanticTimeout: boolean;
  readonly coverage: readonly SourceRootCoverage[];
};

export type ProductionRankingCandidate = {
  path: string;
  finalScore: number;
  rank: number;
  familyScores: Partial<Record<EvidenceFamily, number>>;
  selectedByReadPlan: boolean;
  providers: string[];
};

export type ProductionRankingSnapshot = {
  productionSelectedPaths: string[];
  candidates: ProductionRankingCandidate[];
};

/** Projects the already-computed production order; it never invokes a provider or ranker. */
export function buildProductionRankingSnapshot(
  ranked: readonly CandidateEvidence[],
  selectedPaths: readonly string[]
): ProductionRankingSnapshot {
  const selected = new Set(selectedPaths);
  return {
    productionSelectedPaths: [...selectedPaths],
    candidates: ranked.map((candidate, index) => ({
      path: candidate.file,
      finalScore: candidate.finalScore,
      rank: index + 1,
      familyScores: candidate.familyScores,
      selectedByReadPlan: selected.has(candidate.file),
      providers: [...new Set(candidate.signals.map(signal => signal.providerId))]
    }))
  };
}

export function buildGoldenAttributionV3(
  scenario: Scenario,
  ranking: ProductionRankingSnapshot,
  context: AttributionV3Context
): GoldenAttributionV3[] {
  const candidateByPath = new Map(ranking.candidates.map(candidate => [candidate.path, candidate]));
  const productionSelectedPaths = new Set(ranking.productionSelectedPaths);
  const limit = candidateLimit(context.mode, resolvedProfile(context.profile));
  const repoRoot = path.resolve(context.repoRoot);
  return goldenEntries(scenario).map(({ file, kind }) => {
    const absolutePath = path.join(repoRoot, file);
    const candidate = candidateByPath.get(absolutePath);
    const inCandidates = candidate !== undefined;
    const inReadPlan = productionSelectedPaths.has(absolutePath);
    const blockedBy = resolveBlockedBy(inReadPlan, candidate?.rank, limit);
    const sourceFamilies = candidate
      ? (Object.keys(candidate.familyScores) as EvidenceFamily[]).filter(family => (candidate.familyScores[family] ?? 0) > 0)
      : [];
    return {
      scenarioId: scenario.id,
      file,
      kind,
      inCandidates,
      inReadPlan,
      firstRank: candidate?.rank,
      sourceFamilies,
      providers: candidate?.providers ?? [],
      blockedBy,
      absentReason: blockedBy === "absent" ? absentReason(scenario, file, kind, absolutePath, context) : undefined
    };
  });
}

function resolvedProfile(profile: string | undefined): Parameters<typeof candidateLimit>[1] {
  return profile && profile !== "auto" ? (profile as Parameters<typeof candidateLimit>[1]) : undefined;
}

function resolveBlockedBy(inReadPlan: boolean, rank: number | undefined, limit: number): GoldenBlockedByV3 {
  if (inReadPlan) return "hit";
  if (rank === undefined) return "absent";
  return rank <= limit ? "readplan-budget" : "candidate-limit";
}

/**
 * Ordered most-certain-first: a file can satisfy several of these at once
 * (e.g. missing on disk and also uncovered), and the strongest real signal
 * should win rather than the first one checked incidentally matching.
 * `ambiguous-type`, `framework-not-detected`, and `lexical-miss` are not
 * reachable here on purpose - once a file has zero candidate evidence its
 * familyScores are empty by construction, so nothing distinguishes those
 * three from plain `no-static-edge` without re-querying the index per file.
 */
function absentReason(
  scenario: Scenario,
  file: string,
  kind: GoldenKind,
  absolutePath: string,
  context: AttributionV3Context
): GoldenAbsentReasonV3 {
  if (!existsSync(absolutePath) || kind === "support") {
    return "golden-stale-or-low-value";
  }
  if (context.semanticTimeout) {
    return "semantic-timeout";
  }
  if (!context.semanticUsed) {
    return "semantic-not-used";
  }
  const root = context.coverage.find(entry => file.startsWith(`${entry.root}/`) || file === entry.root);
  if (root && root.state !== "COMPLETE") {
    return "coverage-partial";
  }
  return "no-static-edge";
}

export type CounterfactualResult = {
  candidateHitLost: string[];
  readPlanHitLost: string[];
  /** False when exact range-aware read-plan ablation was not replayed; an empty readPlanHitLost must then not be read as "no gain". */
  measured: boolean;
};

export type GoldenCounterfactualV3 = {
  withoutExactSemantic: CounterfactualResult;
  withoutStaticStructure: CounterfactualResult;
  withoutFramework: CounterfactualResult;
  withoutLexical: CounterfactualResult;
  withoutTaskContext: CounterfactualResult;
  withoutSupport: CounterfactualResult;
};

/** Exact range-aware family ablation is retired; empty losses are explicitly unmeasured. */
export function buildGoldenCounterfactualV3(): GoldenCounterfactualV3 {
  const unmeasured = (): CounterfactualResult => ({
    candidateHitLost: [],
    readPlanHitLost: [],
    measured: false
  });
  return {
    withoutExactSemantic: unmeasured(),
    withoutStaticStructure: unmeasured(),
    withoutFramework: unmeasured(),
    withoutLexical: unmeasured(),
    withoutTaskContext: unmeasured(),
    withoutSupport: unmeasured()
  };
}

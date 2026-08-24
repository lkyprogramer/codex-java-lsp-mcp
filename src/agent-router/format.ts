import type {
  CandidateFile,
  ImpactFreshnessV6,
  ImpactOptions,
  ImpactResult,
  ImpactVerbosity,
  ReadPlanItem,
  ResolvedAnchor
} from "../agent-types.js";
import type { Completion } from "../runtime/completion.js";
import { unique } from "./candidate-helpers.js";
import type { ImportGraphMetrics } from "./candidate-collectors.js";
import type { SemanticMetrics } from "./impact-metrics.js";
import { toCompactImpact, type CompactImpact } from "./output-compact.js";
import { buildImpactFileV6, buildImpactTargetV6, withConvergedCostV6 } from "./output-v6.js";
import type { RgExecutionResult } from "./rg-execution.js";
import type { TypeReferenceMetrics } from "./type-reference.js";

type BuildImpactResultInput = {
  readonly startedAt: number;
  readonly phaseMs: Record<string, number>;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly ranked: readonly CandidateFile[];
  readonly readPlan: ReadPlanItem[];
  readonly rgExecution: RgExecutionResult;
  readonly suppressed: Record<string, number>;
  readonly evidenceGaps: string[];
  readonly freshness: ImpactFreshnessV6;
  readonly semanticCompletion: Completion;
  readonly semanticReadiness?: string;
  readonly metrics: {
    readonly semantic: SemanticMetrics;
    readonly typeReference: TypeReferenceMetrics;
    readonly importGraph: ImportGraphMetrics;
    readonly persistedSemantic: Record<string, unknown>;
    readonly cache: Record<string, unknown>;
    readonly rgCache: Record<string, unknown>;
    readonly sourceFacts: Record<string, unknown>;
    readonly javaIndex: Record<string, unknown>;
    readonly readPlan?: unknown;
    readonly framework?: Record<string, unknown>;
  };
};

export function buildImpactResult(input: BuildImpactResultInput): ImpactResult | CompactImpact {
  const verbosity = input.options.verbosity || "standard";
  const formattedFiles = input.ranked.map((file, index) => buildImpactFileV6(file, `F${index + 1}`, verbosity));
  const framework = input.metrics.framework;
  const generatedCode = framework?.generatedCode as Record<string, unknown> | undefined;
  const generatedSemantics = generatedCode?.semantics as "OK" | "INCOMPLETE" | "NOT_DETECTED" | undefined;

  const payload: ImpactResult = {
    version: 6,
    target: buildImpactTargetV6(input.anchors[0]!),
    freshness: input.freshness,
    semantic: {
      policy: input.options.semanticPolicy,
      used: input.metrics.semantic.used,
      completion: input.semanticCompletion,
      readiness: input.semanticReadiness
    },
    files: formattedFiles,
    readPlan: input.readPlan,
    evidenceGaps: unique(input.evidenceGaps),
    cost: { resultBytes: 0, readBytes: 0, estimatedTokens: 0, suppressedRawBytes: 0 },
    metrics: {
      routingVersion: 6,
      elapsedMs: Date.now() - input.startedAt,
      generatedSemantics,
      phaseMs: input.phaseMs,
      semantic: input.metrics.semantic,
      typeReference: input.metrics.typeReference,
      importGraph: input.metrics.importGraph,
      persistedSemantic: input.metrics.persistedSemantic,
      cache: input.metrics.cache,
      rgCache: input.metrics.rgCache,
      sourceFacts: input.metrics.sourceFacts,
      javaIndex: input.metrics.javaIndex,
      readPlan: input.metrics.readPlan as Record<string, unknown> | undefined,
      framework: input.metrics.framework,
      suppressed: input.suppressed
    }
  };
  const sourceFiles = payload.files;
  applyVerbosity(payload, verbosity);
  const v6 = withConvergedCostV6(payload, readPlanBytes(input.readPlan), input.rgExecution.rawBytes);
  if (verbosity === "diagnostic") return v6;
  // Compact proof needs provider kinds; applyVerbosity already stripped them
  // from the V6 wire clone. Reattach the pre-strip files only for serialization.
  return toCompactImpact({ ...v6, files: sourceFiles });
}

function readPlanBytes(readPlan: ReadPlanItem[]): number {
  return readPlan.reduce((sum, item) => sum + item.estimatedBytes, 0);
}

/**
 * Diagnostic mode returns every metrics section as collected. Standard/compact
 * keep only generatedSemantics (Task 29's Lombok completeness signal must
 * survive every verbosity - it is not a diagnostic-only detail) alongside the
 * two bookkeeping fields already present at every verbosity pre-V6.
 */
export function applyVerbosity(payload: ImpactResult, verbosity: ImpactVerbosity): void {
  const metrics = payload.metrics!;
  if (verbosity === "diagnostic") {
    return;
  }
  payload.files = payload.files.map(file => {
    const { reasons: _reasons, verifiedBy: _verifiedBy, scoreBreakdown: _scoreBreakdown, ...publicFile } = file;
    return publicFile;
  });
  payload.readPlan = payload.readPlan.map(item => ({
    ...item,
    ranges: item.ranges.map(({ reason: _reason, ...publicRange }) => publicRange)
  }));
  const preservedGaps = payload.evidenceGaps.filter(isLombokCompletenessGap);
  const ordinaryGaps = payload.evidenceGaps.filter(gap => !isLombokCompletenessGap(gap));
  payload.evidenceGaps = [...preservedGaps, ...ordinaryGaps]
    .map(shortEvidenceGap)
    .slice(0, verbosity === "compact" ? 2 : 3);
  payload.metrics = {
    routingVersion: metrics.routingVersion,
    elapsedMs: metrics.elapsedMs,
    ...(metrics.generatedSemantics === undefined ? {} : { generatedSemantics: metrics.generatedSemantics })
  };
}

/**
 * Produces a wire-ready verbosity projection from one diagnostic result.
 * The canonical object is never mutated, so payload attribution can compare
 * compact/standard/diagnostic without a second provider/rank/read-plan run.
 */
export function projectImpactResultV6(
  canonicalDiagnostic: Readonly<ImpactResult>,
  verbosity: ImpactVerbosity
): ImpactResult {
  const payload = structuredClone(canonicalDiagnostic) as ImpactResult;
  applyVerbosity(payload, verbosity);
  return withConvergedCostV6(payload, payload.cost.readBytes, payload.cost.suppressedRawBytes);
}

function shortEvidenceGap(gap: string): string {
  if (gap === "Run Gradle compile/test before claiming behavior.") {
    return "Run compile/test before claims.";
  }
  if (gap === "Use rg/runtime evidence for Spring wiring, SQL/XML/YAML, logs, Nacos, and DB state.") {
    return "Check rg/runtime evidence for wiring and DB/config.";
  }
  if (gap === "LSP semantic enrichment was skipped by policy; raise semanticPolicy or mode if exact symbol binding is required.") {
    return "Semantic skipped; raise semanticPolicy for exact binding.";
  }
  if (gap === "LSP semantic enrichment hit the configured timeout and fell back to JavaIndex plus rg evidence.") {
    return "Semantic timed out; using JavaIndex plus rg.";
  }
  if (gap === "Some source facts used the degraded fallback because JavaIndex facts were unavailable.") {
    return "Some source facts used fallback evidence.";
  }
  if (gap === "Review persistence/config evidence in the returned files (role=config or framework) before changing behavior.") {
    return "Review persistence/config evidence.";
  }
  if (gap === "Tests are returned as lower-priority candidates; use testReadMode=priority when verification planning is the main task.") {
    return "Tests are lower-priority; use testReadMode=priority for verification.";
  }
  if (gap === "Lombok is detected but the JDT javaagent is missing/disabled; generated members (getters/setters/builders) on types in scope may not resolve - verify with a full compile before assuming a member is absent.") {
    return "Lombok agent missing; generated members may not resolve.";
  }
  return gap;
}

function isLombokCompletenessGap(gap: string): boolean {
  return gap.startsWith("Lombok is detected but the JDT javaagent is missing/disabled;");
}

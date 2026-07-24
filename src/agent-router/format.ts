import type {
  CandidateFile,
  ImpactResult,
  ImpactOptions,
  ImpactVerbosity,
  ReadPlanItem,
  ResolvedAnchor
} from "../agent-types.js";
import { unique } from "./candidate-helpers.js";
import type { ImportGraphMetrics } from "./candidate-collectors.js";
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
  readonly metrics: {
    readonly semantic: Record<string, unknown>;
    readonly typeReference: TypeReferenceMetrics;
    readonly importGraph: ImportGraphMetrics;
    readonly persistedSemantic: Record<string, unknown>;
    readonly cache: Record<string, unknown>;
    readonly rgCache: Record<string, unknown>;
    readonly sourceFacts: Record<string, unknown>;
    readonly freshness: Record<string, unknown>;
  };
};

export function buildImpactResult(input: BuildImpactResultInput): ImpactResult {
  const verbosity = input.options.verbosity || "standard";
  const formattedFiles = input.ranked.map((file, index) => formatCandidate(file, `F${index + 1}`, verbosity));
  const payload: ImpactResult = {
    target: formatAnchor(input.anchors[0]),
    options: {
      mode: input.options.mode,
      profile: input.options.profile,
      semanticPolicy: input.options.semanticPolicy,
      readPlanMaxItems: input.readPlan.length,
      testReadMode: input.options.testReadMode,
      focusModules: input.options.focusModules,
      excludeModules: input.options.excludeModules,
      taskKeywords: input.options.taskKeywords,
      crossModulePolicy: input.options.crossModulePolicy,
      verbosity
    },
    counts: {
      anchors: input.anchors.length,
      rgCommands: input.rgExecution.commandCount,
      rgFiles: input.rgExecution.files.length,
      totalRgMatches: input.rgExecution.totalMatches,
      totalRgRawBytes: input.rgExecution.rawBytes,
      returnedFiles: formattedFiles.length,
      readPlanItems: input.readPlan.length
    },
    files: formattedFiles,
    readPlan: input.readPlan,
    rgSummary: {
      sections: input.rgExecution.sections,
      suppressed: input.rgExecution.suppressed
    },
    suppressed: input.suppressed,
    evidenceGaps: input.evidenceGaps,
    metrics: {
      routingVersion: 5,
      elapsedMs: Date.now() - input.startedAt,
      phaseMs: input.phaseMs,
      semantic: input.metrics.semantic,
      typeReference: input.metrics.typeReference,
      importGraph: input.metrics.importGraph,
      persistedSemantic: input.metrics.persistedSemantic,
      cache: input.metrics.cache,
      rgCache: input.metrics.rgCache,
      sourceFacts: input.metrics.sourceFacts,
      freshness: input.metrics.freshness,
      outputBytes: 0
    }
  };
  applyVerbosity(payload, verbosity);
  updateOutputBytes(payload);
  return payload;
}

export function formatCandidate(file: CandidateFile, id: string, verbosity: ImpactVerbosity): Record<string, unknown> {
  return compact({
    id,
    path: file.path || file.absolutePath,
    module: file.module,
    layer: file.layer,
    sourceSet: file.sourceSet,
    score: Math.round(file.score),
    matchCount: file.matchCount,
    categories: file.categories,
    reasons: file.reasons,
    positions: file.positions.slice(0, 3),
    confidence: verbosity === "diagnostic" ? file.confidence || "medium" : undefined,
    verifiedBy: verbosity === "diagnostic" ? file.verifiedBy || [] : undefined,
    scoreBreakdown: verbosity === "diagnostic" ? file.scoreBreakdown : undefined
  });
}

export function formatAnchor(anchor: ResolvedAnchor): Record<string, unknown> {
  return compact({
    id: anchor.id,
    path: anchor.path || anchor.absolutePath,
    module: anchor.module,
    layer: anchor.layer,
    sourceSet: anchor.sourceSet,
    line: anchor.line,
    column: anchor.column,
    profile: anchor.profile,
    symbolName: anchor.symbolName,
    methodName: anchor.methodName,
    className: anchor.className,
    factSource: anchor.factSource,
    kind: anchor.kind
  });
}

export function applyVerbosity(payload: ImpactResult, verbosity: ImpactVerbosity): void {
  payload.evidenceGaps = unique(payload.evidenceGaps);
  if (verbosity === "diagnostic") {
    return;
  }
  payload.rgSummary.sections = payload.rgSummary.sections.map(section => ({
    ...section,
    files: []
  }));
  payload.evidenceGaps = payload.evidenceGaps.map(shortEvidenceGap);
  payload.evidenceGaps = payload.evidenceGaps.slice(0, verbosity === "compact" ? 2 : 3);
  payload.metrics = compact({
    routingVersion: payload.metrics.routingVersion,
    elapsedMs: payload.metrics.elapsedMs,
    semantic: slimSemantic(payload.metrics.semantic),
    // Freshness is a small correctness signal; keep it in every verbosity.
    freshness: payload.metrics.freshness,
    outputBytes: payload.metrics.outputBytes
  });
}

export function updateOutputBytes(payload: ImpactResult): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const outputBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (payload.metrics.outputBytes === outputBytes) {
      return;
    }
    payload.metrics.outputBytes = outputBytes;
  }
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function slimSemantic(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const semantic = value as Record<string, unknown>;
  return compact({
    used: semantic.used,
    skipped: semantic.skipped,
    timeout: semantic.timeout,
    policy: semantic.policy
  });
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
  if (gap === "LSP semantic enrichment hit the configured timeout and fell back to source-index plus rg evidence.") {
    return "Semantic timed out; using source-index plus rg.";
  }
  if (gap === "Source facts are regex-derived and not yet JDT LS documentSymbol confirmed.") {
    return "Source facts are regex-derived.";
  }
  if (gap === "Review persistence/config evidence from rgSummary before changing behavior.") {
    return "Review persistence/config evidence.";
  }
  if (gap === "Tests are returned as lower-priority candidates; use testReadMode=priority when verification planning is the main task.") {
    return "Tests are lower-priority; use testReadMode=priority for verification.";
  }
  return gap;
}

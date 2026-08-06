// input: Per-provider candidate discovery output.
// output: Authoritative evidence vocabulary shared by every candidate source.
// pos: Task 24 - single typed contract providers emit instead of mutating a shared candidate map.
import type { Completion } from "../runtime/completion.js";
import type { SourceRange } from "../java-index/index-types.js";
import type { FrameworkIndexView } from "../java-index/framework-index-view.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { LayoutContext } from "../layout-probe.js";
import type { RoutingPolicy } from "../routing-policy.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { JdtlsSession } from "../jdtls-session.js";
import type { SemanticEdgeStoreV2 } from "../semantic-edge-store.js";
import type { CandidateFile, Confidence, ImpactOptions, ResolvedAnchor, RgPlanSection } from "../agent-types.js";
import type { RgCommandSummary } from "./rg-plan.js";
import type { TypeReferenceMetrics } from "./type-reference.js";
import type { ImportGraphMetrics } from "./candidate-collectors.js";
import type { PersistedSemanticMetrics, SemanticMetrics } from "./impact-metrics.js";

export type EvidenceProvenance =
  | "AST_EXACT"
  | "AST_RESOLVED"
  | "FRAMEWORK_INFERRED"
  | "LEXICAL_RG"
  | "JDT_EXACT"
  | "PERSISTED_JDT";

export type EvidenceFamily =
  | "EXACT_SEMANTIC"
  | "STATIC_STRUCTURE"
  | "FRAMEWORK"
  | "LEXICAL"
  | "TASK_CONTEXT"
  | "SUPPORT";

export type EvidenceCompleteness = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export type EvidenceSignal = {
  signalId: string;
  candidateFile: string;
  candidateNodeId?: string;
  anchorId: string;
  kind: string;
  family: EvidenceFamily;
  provenance: EvidenceProvenance;
  confidence: number;
  completeness: EvidenceCompleteness;
  weight: number;
  sourceFile: string;
  sourceRange?: SourceRange;
  /** Present only for AST-resolved CALLS signals; lower means closer to the anchor expression root. */
  callDepth?: number;
  /** Distinguishes an anchor-body receiver call from a validated implementation continuation. */
  callOrigin?: "anchor" | "implementation";
  positions: Array<{ line: number; column: number }>;
  providerId: string;
  providerVersion: string;
  generation: number;
  detail?: string;
};

export type ProviderOutcome = {
  providerId: string;
  providerVersion: string;
  evidence: EvidenceSignal[];
  /**
   * Transitional metadata from a provider's wrapped collector, in
   * `mergeCandidate`-foldable form. Task 25 ranks only typed `evidence`, but
   * materialization still needs categories, reasons, positions and
   * verification provenance that are not yet reconstructable from families.
   */
  candidates: CandidateFile[];
  completion: Completion;
  elapsedMs: number;
  degradation?: string;
};

/**
 * Per-request context handed to every provider. `existingCandidatePaths` is
 * read-only by design (plan Task 24's "Produces" contract: no provider may
 * mutate a shared candidate map) - a provider that wants to know what is
 * already a candidate (e.g. to skip re-emitting it) reads this list, never a
 * live Map another provider could still be writing to.
 *
 * `phaseMs`/`metrics`/`session`/`edgeStoreV2`/`concurrency`/`loadRgSummary` are
 * Task 24 wrapping plumbing: they let each provider drive its unchanged old
 * collector (which expects these exact side channels) so `ImpactResult`'s
 * `metrics` block and per-phase timings stay byte-identical to the
 * pre-provider pipeline. They are broader than the plan's prose sketch of
 * `ProviderInput` on purpose - narrowing them is Task 25's job once scoring
 * no longer needs to replay the old collectors verbatim.
 */
export type ProviderInput = {
  readonly repoRoot: string;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly javaIndex: RouterIndex;
  /**
   * Bounded, read-only projection over the same underlying JavaIndex as
   * javaIndex - a separate field, not an intersection type on javaIndex,
   * so only a framework-adapter provider reaches frameworkFactsFor/
   * declarationsById/etc.; the other six providers keep the narrower
   * RouterIndex surface they already had (Task 27 Slice B/C).
   */
  readonly frameworkIndex: FrameworkIndexView;
  readonly routingPolicy: RoutingPolicy;
  readonly layoutContext: LayoutContext;
  readonly generation: number;
  readonly budget: DeadlineBudget;
  readonly existingCandidatePaths: readonly string[];
  readonly phaseMs: Record<string, number>;
  readonly session: JdtlsSession;
  /** Task 33's persisted-semantic evidence source: dual-write target for live semantic verify, sole read source for collectPersistedSemanticEvidence. */
  readonly edgeStoreV2: SemanticEdgeStoreV2;
  /** Cached once per repo-runtime (AgentRouter), recomputed only on a BUILD_CHANGE batch - never per request. */
  readonly buildFingerprint: string;
  readonly concurrency: number;
  readonly loadRgSummary: (
    section: RgPlanSection,
    options: ImpactOptions,
    anchors: readonly ResolvedAnchor[]
  ) => Promise<RgCommandSummary>;
  readonly metrics: {
    readonly typeReference: TypeReferenceMetrics;
    readonly importGraph: ImportGraphMetrics;
    readonly persistedSemantic: PersistedSemanticMetrics;
    readonly semantic: SemanticMetrics;
  };
};

export interface CandidateProvider {
  readonly id: string;
  readonly version: string;
  collect(input: ProviderInput): Promise<ProviderOutcome>;
}

export type CandidateEvidence = {
  file: string;
  module?: string;
  layer?: string;
  sourceSet?: string;
  signals: EvidenceSignal[];
  familyScores: Partial<Record<EvidenceFamily, number>>;
  finalScore: number;
  confidence: Confidence;
  degradation: string[];
};

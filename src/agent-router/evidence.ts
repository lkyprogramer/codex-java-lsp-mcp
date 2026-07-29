// input: Per-provider candidate discovery output.
// output: Authoritative evidence vocabulary shared by every candidate source.
// pos: Task 24 - single typed contract providers emit instead of mutating a shared candidate map.
import type { Completion } from "../runtime/completion.js";
import type { SourceRange } from "../java-index/index-types.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { LayoutContext } from "../layout-probe.js";
import type { RoutingPolicy } from "../routing-policy.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { Confidence, ImpactOptions, ResolvedAnchor } from "../agent-types.js";

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
 */
export type ProviderInput = {
  readonly repoRoot: string;
  readonly anchors: readonly ResolvedAnchor[];
  readonly options: ImpactOptions;
  readonly javaIndex: RouterIndex;
  readonly routingPolicy: RoutingPolicy;
  readonly layoutContext: LayoutContext;
  readonly generation: number;
  readonly budget: DeadlineBudget;
  readonly existingCandidatePaths: readonly string[];
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

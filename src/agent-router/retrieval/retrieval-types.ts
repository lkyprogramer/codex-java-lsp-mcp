// input: Candidate files, indexed ranges, and the current impact mode.
// output: Internal ReadUnit, retrieval budget, and diagnostic frontier types. Not a public MCP payload.
// pos: V5R Phase 2/4. Session store stays out until Phase 5.
import type { CandidateEvidenceKey, CandidateFile, ImpactMode, ReadPriority, ReadRange } from "../../agent-types.js";
import type { SourceRange } from "../../runtime/source-range.js";



export type ReadUnitPlannerMode = "off" | "shadow" | "on";
export type FrontierShadowMode = "off" | "shadow";

export type RetrievalStopReason =
  | "NO_FRONTIER"
  | "NO_HIGH_VALUE_FRONTIER"
  | "FRONTIER_AVAILABLE"
  | "FRONTIER_BYTE_CAP"
  | "READ_BUDGET_EXHAUSTED";

export type FrontierItemV1 = {
  readonly id: string;
  readonly fileId: string;
  readonly path: string;
  readonly ranges: Array<{ startLine: number; endLine: number; estimatedBytes: number }>;
  readonly relation: ContinuationRelation;
  readonly expectedEvidence: string[];
  readonly confidence: "high" | "medium" | "low";
  readonly estimatedReadBytes: number;
  readonly hop: 0 | 1 | 2 | "reverse" | "unknown";
};

export type DeferredQueryDesign = {
  readonly relation: "REVERSE_CALLER_QUERY";
  readonly reason: string;
  readonly notOpened: true;
};

export type FrontierShadowReport = {
  readonly items: FrontierItemV1[];
  readonly deferredQueries: DeferredQueryDesign[];
  readonly stopReason: RetrievalStopReason;
  readonly coverage: {
    readonly itemCount: number;
    readonly relationCounts: Record<string, number>;
    readonly familyCounts: Record<string, number>;
    readonly estimatedReadBytes: number;
    readonly responseBytes: number;
    readonly distinctRelations: number;
    readonly distinctFamilies: number;
  };
  readonly caps: {
    readonly maxItems: number;
    readonly maxBytes: number;
    readonly maxPerRelation: number;
    readonly maxPerFile: number;
    readonly maxPerFamily: number;
  };
};

export type ContinuationRelation =
  | "BUDGET_EVICTED"
  | "SECOND_HOP_EXACT"
  | "CLOSED_PORT_IMPLEMENTATION"
  | "SIGNATURE_COLLABORATOR"
  | "WRONG_MEMBER_ALTERNATIVE"
  | "REVERSE_CALLER_QUERY"
  | "FRAMEWORK_SUPPORT"
  | "TEST_VERIFICATION"
  | "AMBIGUOUS_DISPATCH"
  | "CROSS_MODULE_ALTERNATIVE"
  | "FIRST_CALL_ANCHOR"
  | "FIRST_CALL_CORE";

export type RetrievalBudget = {
  maxReadBytes: number;
  maxFiles: number;
  maxSpans: number;
  maxSpansPerFile: number;
  maxCrossModuleUnits: number;
  maxTestUnits: number;
  frontierMaxItems: number;
  frontierMaxBytes: number;
  additionalReadBytes: number;
  maxSteps: number;
};

export type MaterializedReadWindow = {
  readonly file: CandidateFile;
  readonly ranges: ReadRange[];
  readonly coordinateRanges: SourceRange[];
  readonly bytes: number;
  readonly extremeMethod: boolean;
  readonly rangeKinds: readonly string[];
};

export type ReadUnit = {
  readonly id: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly fileId: string;
  readonly memberId?: string;
  readonly ownerTypeId?: string;
  readonly primaryRanges: ReadRange[];
  readonly contextRanges: ReadRange[];
  readonly mergedRanges: ReadRange[];
  readonly coordinateRanges: SourceRange[];
  readonly estimatedBytes: number;
  readonly extremeMethod: boolean;
  readonly priority: ReadPriority;
  readonly confidence: "high" | "medium" | "low";
  readonly evidenceKeys: string[];
  readonly evidenceFamilies: string[];
  readonly plannerEvidence: readonly CandidateEvidenceKey[];
  readonly module?: string;
  readonly layer?: string;
  readonly sourceSet?: string;
  readonly relationClass: ContinuationRelation;
  readonly hop: 0 | 1 | 2 | "reverse" | "unknown";
  readonly utility: number;
  readonly file: CandidateFile;
};

export type ReadUnitIdentity = {
  readonly relativePath: string;
  readonly fileId: string;
  readonly ranges: Array<{ startLine: number; endLine: number; estimatedBytes: number }>;
  readonly estimatedBytes: number;
};

export type RetrievalParityReport = {
  match: boolean;
  selected: ReadUnitIdentity[];
  legacy: ReadUnitIdentity[];
};

export function retrievalBudgetFor(
  mode: ImpactMode,
  limits: { maxFiles: number; maxReadBytes: number }
): RetrievalBudget {
  const maxSpansPerFile = 8;
  return {
    maxReadBytes: limits.maxReadBytes,
    maxFiles: limits.maxFiles,
    maxSpans: limits.maxFiles * maxSpansPerFile,
    maxSpansPerFile,
    maxCrossModuleUnits: limits.maxFiles,
    maxTestUnits: Math.max(1, Math.floor(limits.maxFiles / 6)),
    frontierMaxItems: 8,
    frontierMaxBytes: 8 * 1024,
    additionalReadBytes: 16 * 1024,
    maxSteps: 2
  };
}

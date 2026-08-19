// input: Candidate files, indexed ranges, and the current impact mode.
// output: Internal ReadUnit and retrieval budget types. Not a public MCP payload.
// pos: V5R Phase 2. Frontier/session types stay out until Phase 4/5.
import type { CandidateEvidenceKey, CandidateFile, ImpactMode, ReadPriority, ReadRange } from "../../agent-types.js";
import type { SourceRange } from "../../runtime/source-range.js";

export const JAVA_LSP_READUNIT_PLANNER = "JAVA_LSP_READUNIT_PLANNER";

export type ReadUnitPlannerMode = "off" | "shadow" | "on";

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

export function readUnitPlannerMode(env: NodeJS.ProcessEnv = process.env): ReadUnitPlannerMode {
  const raw = env[JAVA_LSP_READUNIT_PLANNER];
  if (raw === "1" || raw === "on") return "on";
  if (raw === "shadow") return "shadow";
  return "off";
}

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
    frontierMaxItems: 0,
    frontierMaxBytes: 0,
    additionalReadBytes: 0,
    maxSteps: 1
  };
}

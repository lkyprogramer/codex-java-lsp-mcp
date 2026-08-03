// input: Public java_impact options and internal routing state.
// output: Shared v5 agent router types.
// pos: Type contracts for the lishuedu JDT LS MCP v5 router.
import type { Completion } from "./runtime/completion.js";

export type ImpactMode = "minimal" | "balanced" | "precision" | "recall";
export type ImpactProfile = "auto" | "controller" | "service" | "port" | "repository" | "parser" | "dto" | "entity" | "mapper" | "vo" | "job" | "listener";
export type ResolvedImpactProfile = Exclude<ImpactProfile, "auto">;
export type SemanticPolicy = "auto" | "fast" | "required";
export type TestReadMode = "defer" | "include" | "priority";
export type CrossModulePolicy = "auto" | "focused" | "all";
export type ReadPriority = "P0" | "P1" | "P2";
export type ImpactVerbosity = "compact" | "standard" | "diagnostic";
export type Confidence = "high" | "medium" | "low";

export type ScoreBreakdownItem = {
  id: string;
  source: "anchor" | "semantic-seed" | "rg" | "merge" | "policy" | "finalize";
  delta: number;
  reason: string;
};

export type ImpactAnchorInput = {
  file: string;
  line: number;
  column: number;
  role?: string;
};

export type ImpactOptions = {
  anchors: ImpactAnchorInput[];
  mode: ImpactMode;
  profile: ImpactProfile;
  semanticPolicy: SemanticPolicy;
  semanticTimeoutMs: number;
  readPlanMaxItems?: number;
  /** Internal/benchmark override; the MCP schema deliberately exposes no byte knob. */
  readPlanMaxBytes?: number;
  testReadMode: TestReadMode;
  focusModules: string[];
  excludeModules: string[];
  taskKeywords: string[];
  crossModulePolicy: CrossModulePolicy;
  verbosity?: ImpactVerbosity;
};

export type ResolvedAnchor = {
  id: string;
  absolutePath: string;
  path?: string;
  module?: string;
  layer?: string;
  sourceSet?: string;
  line: number;
  column: number;
  role?: string;
  profile: ResolvedImpactProfile;
  symbolName: string;
  methodName?: string;
  className?: string;
  factSource?: "javaIndex" | "fallback";
  kind: string;
};

export type RouterPosition = {
  line: number;
  column: number;
};

export type CandidateFile = {
  absolutePath: string;
  path?: string;
  module?: string;
  layer?: string;
  sourceSet?: string;
  score: number;
  matchCount: number;
  positions: RouterPosition[];
  categories: string[];
  reasons: string[];
  confidence?: Confidence;
  verifiedBy?: string[];
  scoreBreakdown?: ScoreBreakdownItem[];
  /** Internal planner identity; formatCandidate never exposes this field. */
  plannerEvidence?: CandidateEvidenceKey[];
};

export type RoutedCandidate = CandidateFile & {
  confidence: Confidence;
  verifiedBy: string[];
  scoreBreakdown?: ScoreBreakdownItem[];
};

/** Internal Task 30 evidence identity used for diversity/overlap decisions. */
export type CandidateEvidenceKey = {
  family: string;
  kind: string;
  sourceTarget: string;
};

export type ReadRange = {
  startLine: number;
  endLine: number;
  reason: string;
  estimatedBytes: number;
};

export type ReadPlanItemV6 = {
  priority: ReadPriority;
  fileId: string;
  ranges: ReadRange[];
  reason: string;
  expectedEvidence: string[];
  estimatedBytes: number;
};

/** Task 30 keeps the public field name while upgrading its item payload to V6. */
export type ReadPlanItem = ReadPlanItemV6;

export type ReadPlanBudget = {
  maxFiles: number;
  maxReadBytes: number;
};

export type RgPlanSection = {
  /** Internal producer identity for multi-anchor lexical evidence attribution. */
  anchorId?: string;
  category: "java" | "protocol" | "persistence" | "config" | "tests" | "nonJava";
  reason: string;
  pattern: string;
  paths: string[];
  globs: string[];
};

export type RgSectionSummary = {
  category: string;
  reason: string;
  commandCount: number;
  matchedFiles: number;
  totalMatches: number;
  rawBytes: number;
  cacheHits: number;
  completion: Completion;
  files: Array<Record<string, unknown>>;
};

export type ImpactResult = {
  target: Record<string, unknown>;
  options: Record<string, unknown>;
  counts: Record<string, unknown>;
  files: Array<Record<string, unknown>>;
  readPlan: ReadPlanItem[];
  rgSummary: {
    sections: RgSectionSummary[];
    suppressed: Record<string, unknown>;
  };
  suppressed: Record<string, unknown>;
  evidenceGaps: string[];
  metrics: Record<string, unknown>;
  /** Task 25 item 6: present only for verbosity="diagnostic" requests opted into JAVA_LSP_SHADOW_RANKING=1 - see shadow-ranking.ts. */
  shadowRanking?: Record<string, unknown>;
};

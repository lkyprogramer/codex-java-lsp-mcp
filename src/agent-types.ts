// input: Public java_impact options and internal routing state.
// output: Shared agent router types, including the public ImpactResultV6 output contract.
// pos: Type contracts for the lishuedu JDT LS MCP router.
import type { Completion } from "./runtime/completion.js";
import type { SourceRange } from "./runtime/source-range.js";

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
  /** AST nesting depth for a resolved CALLS signal; internal read-plan tie-break metadata. */
  callDepth?: number;
  /** Whether CALLS originates in the anchor body or after one validated implementation dispatch. */
  callOrigin?: "anchor" | "implementation";
};

export type ReadRange = {
  startLine: number;
  endLine: number;
  reason?: string; // diagnostic-only; stripped at standard/compact like files[].scoreBreakdown
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

/** Internal shape of RgExecutionResult.sections - no longer part of the public output contract (Task 31), still used by rg-execution.ts. */
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

// --- ImpactResultV6 (Task 31) - architecture V3.1 §15.2-15.5. ---

export type ImpactTargetV6 = {
  file: string;
  symbol: string;
  type?: string;
  method?: string;
  profile: string;
  range: SourceRange;
};

export type ImpactFreshnessV6 = {
  requestGeneration: number;
  indexedGeneration: number;
  coverage: "COMPLETE" | "PARTIAL" | "DEGRADED";
  changedDuringRequest: boolean;
};

export type ImpactSemanticV6 = {
  policy: SemanticPolicy;
  used: boolean;
  completion: Completion;
  readiness?: string;
};

export type ImpactFileV6 = {
  id: string;
  path: string;
  role: string;
  confidence: Confidence;
  evidence: string[];
  locations: Array<{ line: number; column: number }>;
  /** Diagnostic-only (verbosity="diagnostic"): raw provider-attribution kind strings behind `evidence`'s human phrases. Internal tooling (the benchmark harness) classifies by these, not by parsing phrases. */
  reasons?: string[];
  verifiedBy?: string[];
  scoreBreakdown?: ScoreBreakdownItem[];
};

export type ImpactCostV6 = {
  resultBytes: number;
  readBytes: number;
  estimatedTokens: number;
  suppressedRawBytes: number;
};

/**
 * `metrics` stays populated at every verbosity (routingVersion/elapsedMs/
 * generatedSemantics are load-bearing outside diagnostic mode - the Lombok
 * completeness signal from Task 29 must survive standard/compact requests),
 * but only diagnostic requests get the larger diagnostic-only sections.
 * Optional (`?`) reflects that a caller must not assume any single section
 * is present, not that the whole object is diagnostic-exclusive.
 */
export type ImpactDiagnosticMetrics = {
  routingVersion: number;
  elapsedMs: number;
  generatedSemantics?: "OK" | "INCOMPLETE" | "NOT_DETECTED";
  phaseMs?: Record<string, number>;
  semantic?: Record<string, unknown>;
  typeReference?: Record<string, unknown>;
  importGraph?: Record<string, unknown>;
  persistedSemantic?: Record<string, unknown>;
  javaIndex?: Record<string, unknown>;
  readPlan?: Record<string, unknown>;
  framework?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  rgCache?: Record<string, unknown>;
  sourceFacts?: Record<string, unknown>;
  suppressed?: Record<string, unknown>;
};

export type ImpactResultV6 = {
  version: 6;
  target: ImpactTargetV6;
  freshness: ImpactFreshnessV6;
  semantic: ImpactSemanticV6;
  files: ImpactFileV6[];
  readPlan: ReadPlanItemV6[];
  evidenceGaps: string[];
  cost: ImpactCostV6;
  metrics?: ImpactDiagnosticMetrics;
};

export type ImpactResult = ImpactResultV6;

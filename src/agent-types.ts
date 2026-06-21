// input: Public java_impact options and internal routing state.
// output: Shared v5 agent router types.
// pos: Type contracts for the lishuedu JDT LS MCP v5 router.
export type ImpactMode = "minimal" | "balanced" | "precision" | "recall";
export type ImpactProfile = "auto" | "controller" | "service" | "port" | "repository" | "parser" | "dto" | "entity" | "mapper" | "vo" | "job" | "listener";
export type ResolvedImpactProfile = Exclude<ImpactProfile, "auto">;
export type SemanticPolicy = "auto" | "fast" | "required";
export type TestReadMode = "defer" | "include" | "priority";
export type CrossModulePolicy = "auto" | "focused" | "all";
export type ReadPriority = "P0" | "P1" | "P2";

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
  testReadMode: TestReadMode;
  focusModules: string[];
  excludeModules: string[];
  taskKeywords: string[];
  crossModulePolicy: CrossModulePolicy;
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
  factSource?: "regex" | "documentSymbol";
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
};

export type ReadPlanItem = {
  priority: ReadPriority;
  fileId: string;
  startLine: number;
  endLine: number;
  reason: string;
};

export type RgPlanSection = {
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
};

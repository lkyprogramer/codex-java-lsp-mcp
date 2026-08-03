// input: Ranked candidates and one batched JavaIndex range query.
// output: V6 multi-range plan constrained by file and exact UTF-8 byte budgets.
// pos: Token-aware ReadPlan planner; candidate source bytes stay in the index worker.
import type {
  CandidateFile,
  ImpactMode,
  ImpactOptions,
  ReadPlanBudget,
  ReadPlanItemV6,
  ReadPriority,
  ReadRange,
  ResolvedImpactProfile
} from "../agent-types.js";
import type { IndexedReadRangeResult } from "../java-index/index-types.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import { hasProtectedStructuralSignal } from "./ranking-signals.js";
import { selectWithEvidenceBudget } from "./read-plan-budget.js";

export const READ_PLAN_BUDGETS = {
  minimal: { maxFiles: 4, maxReadBytes: 6 * 1024 },
  balanced: { maxFiles: 6, maxReadBytes: 14 * 1024 },
  precision: { maxFiles: 8, maxReadBytes: 20 * 1024 },
  recall: { maxFiles: 12, maxReadBytes: 32 * 1024 }
} as const satisfies Record<ImpactMode, ReadPlanBudget>;

const SHORTLIST_MULTIPLIER = 4;
const PROTECTED_CORE_KINDS = new Set([
  "DEFINITION",
  "IMPLEMENTATION",
  "TYPEHIERARCHY",
  "IMPLEMENTS",
  "TYPE_RELATION",
  "TYPE_SYMMETRIC",
  "METHOD_RELATION",
  "definition",
  "implementation",
  "typeHierarchy",
  "typeGraph:implementation-lookup",
  "SPRING_INJECTION",
  "SPRING_CALL_PATH",
  "MYBATIS_STATEMENT_METHOD",
  "JPA_REPOSITORY_ENTITY"
]);

const BUCKET_RULES = {
  anchor: { min: 1, max: 1 },
  core: { min: 2, max: 4 },
  framework: { min: 0, max: 2 },
  support: { min: 0, max: 1 },
  lexical: { min: 0, max: 1 }
} as const;

type ReadPlanBucket = keyof typeof BUCKET_RULES;

type BuildReadPlanInput = {
  readonly files: readonly CandidateFile[];
  readonly ids: ReadonlyMap<string, string>;
  readonly options: ImpactOptions;
  readonly javaIndex: RouterIndex;
  readonly protectedPaths?: ReadonlySet<string>;
  readonly generation?: number;
};

type SelectReadPlanInput = {
  readonly files: readonly CandidateFile[];
  readonly options: ImpactOptions;
  readonly maxItems: number;
  readonly protectedPaths?: ReadonlySet<string>;
};

type CandidateWindow = {
  readonly file: CandidateFile;
  readonly ranges: ReadRange[];
  readonly bytes: number;
  readonly extremeMethod: boolean;
};

export type ReadPlanBuildResult = {
  items: ReadPlanItemV6[];
  /** Internal path identity used to re-key fileIds after output-tail truncation. */
  selectedPaths: string[];
  totalBytes: number;
  maxReadBytes: number;
  maxFiles: number;
  budgetExceededByAnchor: boolean;
  evidenceGaps: string[];
  /** Diagnostic-only selection trace; regular output consumers do not expose it. */
  marginalUtilityBySelectedFile: Record<string, number>;
};

/**
 * Shortlists at most four times the final file budget, then does exactly one
 * worker request for AST/XML windows and exact UTF-8 byte counts. This is the
 * hard boundary that keeps candidate-file I/O off the MCP request thread.
 */
export async function buildReadPlan(input: BuildReadPlanInput): Promise<ReadPlanBuildResult> {
  const configuredBudget = readPlanBudget(input.options);
  const protectedPaths = input.protectedPaths || new Set<string>();
  const anchorFileCount = new Set(input.files
    .filter(file => isAnchor(file, input.options))
    .map(file => file.absolutePath)).size;
  const selectionBudget = {
    ...configuredBudget,
    maxFiles: Math.max(configuredBudget.maxFiles, anchorFileCount)
  };
  const shortlist = shortlistCandidates(input.files, input.options, selectionBudget.maxFiles, protectedPaths);
  const rangeResults = shortlist.length === 0
    ? []
    : await input.javaIndex.queryReadRanges(
      shortlist.map(file => ({ file: file.absolutePath, positions: file.positions })),
      input.generation
    );
  const windows = materializeWindows(shortlist, rangeResults);
  const result = selectTokenAwarePlan(windows, input.ids, input.options, selectionBudget, protectedPaths);
  if (anchorFileCount > configuredBudget.maxFiles) {
    result.maxFiles = configuredBudget.maxFiles;
    result.budgetExceededByAnchor = true;
    result.evidenceGaps = [...new Set([
      `Anchor files exceeded the configured read file budget (${anchorFileCount} > ${configuredBudget.maxFiles}); all anchors were retained.`,
      ...result.evidenceGaps
    ])];
  }
  return result;
}

export function readPlanBudget(options: Pick<ImpactOptions, "mode" | "readPlanMaxItems" | "readPlanMaxBytes">): ReadPlanBudget {
  const defaults = READ_PLAN_BUDGETS[options.mode];
  return {
    maxFiles: options.readPlanMaxItems ?? defaults.maxFiles,
    maxReadBytes: options.readPlanMaxBytes ?? defaults.maxReadBytes
  };
}

/** Retained for current ranking/shadow callers that need paths without a worker range batch. */
export function selectReadPlanFiles(input: SelectReadPlanInput): CandidateFile[] {
  const protectedPaths = input.protectedPaths || new Set<string>();
  const sorted = sortedByReadPriority(input.files, input.options);
  return selectWithEvidenceBudget(sorted, input.maxItems, protectedReadPlanPaths(sorted, protectedPaths, input.options))
    .map(file => ({ file, priority: readPriority(file, input.options) }))
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
    .map(entry => entry.file);
}

export function legacyReadPlanSorted(files: readonly CandidateFile[], options: ImpactOptions): CandidateFile[] {
  return sortedByReadPriority(files, options);
}

export function protectedReadPlanPaths(
  files: readonly CandidateFile[],
  protectedPaths: ReadonlySet<string> = new Set<string>(),
  options: Pick<ImpactOptions, "anchors" | "profile" | "focusModules" | "testReadMode"> = {
    anchors: [],
    profile: "auto",
    focusModules: [],
    testReadMode: "defer"
  }
): Set<string> {
  const paths = new Set(protectedPaths);
  for (const file of files) {
    if (file.sourceSet === "test" && options.testReadMode === "defer") continue;
    if (hasProtectedStructuralSignal(file)
      || (file.verifiedBy || []).includes("typeReference")
      || file.reasons.includes("persisted-implementation")
      || file.reasons.includes("persisted-typeHierarchy")
      || file.reasons.includes("implementation")
      || isTaskLocalRepositoryPersistence(file, options)) {
      paths.add(file.absolutePath);
    }
  }
  return paths;
}

export function readPriority(file: CandidateFile, options: ImpactOptions): ReadPriority {
  if (file.sourceSet === "test") return options.testReadMode === "priority" ? "P1" : "P2";
  if (file.categories.includes("config") || file.categories.includes("nonJava")) return "P2";
  if (isPureIndexRecall(file)) return "P2";
  if (file.reasons.includes("target")
    || (file.reasons.includes("implementation") && file.sourceSet === "main")
    || isTaskLocalRepositoryPersistence(file, options)) return "P0";
  return file.sourceSet === "main" ? "P1" : "P2";
}

export function defaultReadPlanMax(mode: ImpactMode): number {
  return READ_PLAN_BUDGETS[mode].maxFiles;
}

export function candidateLimit(mode: ImpactMode, profile?: ResolvedImpactProfile): number {
  if (mode === "minimal") return 18;
  if (mode === "precision") return 45;
  if (mode === "recall") return 70;
  if (profile === "port") return 20;
  if (profile === "parser") return 18;
  if (profile === "controller") return 16;
  if (profile === "dto") return 24;
  return 26;
}

export function priorityRank(priority: ReadPriority): number {
  return priority === "P0" ? 0 : priority === "P1" ? 1 : 2;
}

function shortlistCandidates(
  files: readonly CandidateFile[],
  options: ImpactOptions,
  maxFiles: number,
  protectedPaths: ReadonlySet<string>
): CandidateFile[] {
  const limit = Math.max(1, maxFiles * SHORTLIST_MULTIPLIER);
  const ordered = sortedForV6Shortlist(files, options);
  const shortlisted: CandidateFile[] = [];
  const selected = new Set<string>();
  const add = (file: CandidateFile): void => {
    if (shortlisted.length < limit && !selected.has(file.absolutePath)) {
      shortlisted.push(file);
      selected.add(file.absolutePath);
    }
  };
  // Anchor and direct core cannot be displaced before the byte-aware pass.
  ordered.filter(file => isAnchor(file, options)).forEach(add);
  ordered.filter(file => isProtectedCore(file, options)).forEach(add);
  // The seed planner's high-confidence core is a bounded compatibility set,
  // not a second output plan. Keep it inside the one worker shortlist so the
  // V6 byte pass can preserve safe slots without reading more candidates.
  ordered.filter(file => protectedPaths.has(file.absolutePath)).forEach(add);
  // Preserve early representation for each evidence bucket, but never force
  // one into the final plan when utility/bytes says it is not worthwhile.
  for (const bucket of Object.keys(BUCKET_RULES) as ReadPlanBucket[]) {
    const representative = ordered.find(file =>
      bucketOf(file, options, protectedPaths) === bucket
      && !selected.has(file.absolutePath)
      && !isAnchor(file, options));
    if (representative) add(representative);
  }
  ordered.forEach(add);
  return shortlisted;
}

function materializeWindows(files: readonly CandidateFile[], results: readonly IndexedReadRangeResult[]): CandidateWindow[] {
  const byFile = new Map(results.map(result => [result.file, result]));
  return files.map(file => {
    const result = byFile.get(file.absolutePath);
    const ranges = (result?.ranges || []).map(range => ({
      startLine: range.startLine,
      endLine: range.endLine,
      reason: readRangeReason(range.kinds ?? [range.kind]),
      estimatedBytes: range.estimatedBytes
    }));
    return {
      file,
      ranges,
      bytes: ranges.reduce((sum, range) => sum + range.estimatedBytes, 0),
      extremeMethod: result?.extremeMethod === true
    };
  });
}

function selectTokenAwarePlan(
  windows: readonly CandidateWindow[],
  ids: ReadonlyMap<string, string>,
  options: ImpactOptions,
  budget: ReadPlanBudget,
  protectedPaths: ReadonlySet<string>
): ReadPlanBuildResult {
  const anchors = windows.filter(window => isAnchor(window.file, options));
  const selected: CandidateWindow[] = [];
  const selectedPaths = new Set<string>();
  const bucketCounts: Record<ReadPlanBucket, number> = { anchor: 0, core: 0, framework: 0, support: 0, lexical: 0 };
  const marginalUtilityBySelectedFile: Record<string, number> = {};
  const evidenceGaps: string[] = [];
  let totalBytes = 0;
  let budgetExceededByAnchor = false;
  const add = (window: CandidateWindow, utility: number): void => {
    selected.push(window);
    selectedPaths.add(window.file.absolutePath);
    totalBytes += window.bytes;
    bucketCounts[bucketOf(window.file, options, protectedPaths)] += 1;
    marginalUtilityBySelectedFile[window.file.path || window.file.absolutePath] = utility;
    if (window.extremeMethod) {
      evidenceGaps.push(`Extreme method range was bounded for ${window.file.path || window.file.absolutePath}; inspect omitted middle body if needed.`);
    }
    if (window.ranges.length === 0) {
      evidenceGaps.push(`No indexed read range was available for ${window.file.path || window.file.absolutePath}.`);
    }
  };

  for (const anchor of anchors) {
    add(anchor, anchor.file.score);
    if (anchor.ranges.length === 0) {
      evidenceGaps.push(`Read range unavailable for anchor ${anchor.file.path || anchor.file.absolutePath}.`);
    }
  }
  if (totalBytes > budget.maxReadBytes) {
      budgetExceededByAnchor = true;
      evidenceGaps.push("Anchor range exceeded the read byte budget; no additional file was forced into the plan.");
  }

  const readableWindows = windows.filter(window => window.ranges.length > 0);
  for (const window of windows) {
    if (!isAnchor(window.file, options) && window.ranges.length === 0) {
      evidenceGaps.push(`Read range unavailable for ${window.file.path || window.file.absolutePath}; candidate was omitted.`);
    }
  }

  const canAdd = (window: CandidateWindow): boolean =>
    !selectedPaths.has(window.file.absolutePath)
    && selected.length < budget.maxFiles
    && !budgetExceededByAnchor
    && totalBytes + window.bytes <= budget.maxReadBytes
    && bucketCounts[bucketOf(window.file, options, protectedPaths)] < BUCKET_RULES[bucketOf(window.file, options, protectedPaths)].max;
  // Ordered by absolute utility, not utility/byte ratio: the fleet-wide
  // matrix showed cell-total budget utilization averaging ~0.53 (max 0.86)
  // while a ratio-primary sort still let a small, low-value core candidate
  // (e.g. a coarse mapper) outrank a large, high-value one (e.g. a resolved
  // implementation) whenever it was merely cheaper - the byte constraint was
  // rarely binding, so optimizing for it first was optimizing the wrong
  // thing. `canAdd` below still enforces the hard byte budget per candidate;
  // this only changes which candidate is considered first when several fit.
  const core = readableWindows
    .filter(window => (isProtectedCore(window.file, options) || protectedPaths.has(window.file.absolutePath))
      && !isAnchor(window.file, options))
    .sort((left, right) => protectedUtility(right) - protectedUtility(left) || left.bytes - right.bytes);
  for (const window of core) {
    if (canAdd(window)) add(window, protectedUtility(window));
  }
  if (core.some(window => !selectedPaths.has(window.file.absolutePath))) {
    evidenceGaps.push("Protected core exceeded read budget; lower-value core files were omitted.");
  }

  const remaining = readableWindows.filter(window => !selectedPaths.has(window.file.absolutePath));
  while (true) {
    // Same reasoning as the core sort above: marginalUtility() already
    // subtracts a modest log-scaled bytePenalty, so a further linear
    // division by raw bytes double-penalizes size and is dropped here too.
    const next = remaining
      .filter(canAdd)
      .map(window => ({ window, utility: marginalUtility(window, selected) }))
      .sort((left, right) =>
        right.utility - left.utility
        || right.window.file.score - left.window.file.score
        || left.window.file.absolutePath.localeCompare(right.window.file.absolutePath))[0];
    if (!next) break;
    add(next.window, next.utility);
    remaining.splice(remaining.indexOf(next.window), 1);
  }

  return {
    items: selected.map(window => toPlanItem(window, ids, options)),
    selectedPaths: selected.map(window => window.file.absolutePath),
    totalBytes,
    maxReadBytes: budget.maxReadBytes,
    maxFiles: budget.maxFiles,
    budgetExceededByAnchor,
    evidenceGaps: [...new Set(evidenceGaps)],
    marginalUtilityBySelectedFile
  };
}

function toPlanItem(window: CandidateWindow, ids: ReadonlyMap<string, string>, options: ImpactOptions): ReadPlanItemV6 {
  const priority = v6ReadPriority(window.file, options);
  return {
    priority,
    fileId: ids.get(window.file.absolutePath) || "F?",
    ranges: window.ranges,
    reason: readReason(window.file, priority),
    expectedEvidence: evidenceKeys(window.file).slice(0, 4),
    estimatedBytes: window.bytes
  };
}

function protectedUtility(window: CandidateWindow): number {
  return window.file.score + familyKeys(window.file).size * 10;
}

function marginalUtility(candidate: CandidateWindow, selected: readonly CandidateWindow[]): number {
  const candidateFamilies = familyKeys(candidate.file);
  const selectedFamilies = new Set(selected.flatMap(window => [...familyKeys(window.file)]));
  const uncoveredFamilies = [...candidateFamilies].filter(family => !selectedFamilies.has(family)).length * 12;
  const moduleDiversity = selected.some(window => window.file.module === candidate.file.module) ? 0 : 8;
  const layerDiversity = selected.some(window => window.file.layer === candidate.file.layer) ? 0 : 6;
  const overlap = selected.reduce((maximum, window) => Math.max(maximum, evidenceOverlap(candidate.file, window.file)), 0) * 35;
  const supportValue = candidate.file.sourceSet === "test" ? 2 : candidate.file.categories.some(category => category === "config" || category === "persistence") ? 4 : 0;
  const bytePenalty = Math.log2(1 + Math.max(1, candidate.bytes)) * 3;
  return candidate.file.score + uncoveredFamilies + moduleDiversity + layerDiversity + supportValue - overlap - bytePenalty;
}

function evidenceOverlap(left: CandidateFile, right: CandidateFile): number {
  const leftKeys = plannerEvidenceKeys(left);
  const rightKeys = new Set(plannerEvidenceKeys(right));
  if (leftKeys.length === 0) return 0;
  return leftKeys.filter(key => rightKeys.has(key)).length / leftKeys.length;
}

function plannerEvidenceKeys(file: CandidateFile): string[] {
  if ((file.plannerEvidence?.length ?? 0) > 0) {
    return file.plannerEvidence!.map(item => `${item.family}\0${item.kind}\0${item.sourceTarget}`);
  }
  return evidenceKeys(file);
}

function evidenceKeys(file: CandidateFile): string[] {
  return [...new Set([...file.reasons, ...(file.verifiedBy || [])])];
}

function familyKeys(file: CandidateFile): Set<string> {
  if ((file.plannerEvidence?.length ?? 0) > 0) {
    return new Set(file.plannerEvidence!.map(item => item.family));
  }
  const keys = evidenceKeys(file).map(key => key.split(":", 1)[0]!);
  return new Set(keys.length > 0 ? keys : file.categories);
}

function isAnchor(
  file: CandidateFile,
  options: Pick<ImpactOptions, "anchors">
): boolean {
  return file.reasons.includes("target")
    || options.anchors.some(anchor => anchor.file === file.absolutePath || anchor.file === file.path);
}

function isProtectedCore(file: CandidateFile, options: Pick<ImpactOptions, "testReadMode">): boolean {
  if (file.sourceSet === "test" && options.testReadMode === "defer") return false;
  if ((file.plannerEvidence ?? []).some(evidence => PROTECTED_CORE_KINDS.has(evidence.kind))) return true;
  if (file.reasons.some(reason => PROTECTED_CORE_KINDS.has(reason))
    || (file.verifiedBy || []).some(reason => PROTECTED_CORE_KINDS.has(reason))) return true;
  return (file.scoreBreakdown || []).some(item => item.delta > 0 && (
    item.id === "finalize.type-relation"
    || item.id === "finalize.method-relation"
    || item.id === "finalize.structural.type-symmetric"
  ));
}

function bucketOf(file: CandidateFile, options: ImpactOptions, protectedPaths: ReadonlySet<string>): ReadPlanBucket {
  if (isAnchor(file, options)) return "anchor";
  if (file.sourceSet === "test" && options.testReadMode === "defer") return "support";
  if (isProtectedCore(file, options) || protectedPaths.has(file.absolutePath)) return "core";
  if (file.categories.includes("framework") || file.reasons.some(reason => reason.startsWith("SPRING_") || reason.startsWith("MYBATIS_") || reason.startsWith("JPA_"))) return "framework";
  if ((file.plannerEvidence ?? []).some(evidence =>
    evidence.family === "STATIC_STRUCTURE" || evidence.family === "EXACT_SEMANTIC")) return "core";
  if (file.sourceSet === "test" || file.categories.some(category => category === "config" || category === "persistence" || category === "nonJava")) return "support";
  return "lexical";
}

function readRangeReason(kinds: readonly IndexedReadRangeResult["ranges"][number]["kind"][]): string {
  return [...new Set(kinds.map(readRangeKindReason))].join("; ");
}

function readRangeKindReason(kind: IndexedReadRangeResult["ranges"][number]["kind"]): string {
  if (kind === "method") return "AST method range";
  if (kind === "type") return "AST owner type header";
  if (kind === "xml-statement") return "MyBatis XML statement";
  if (kind === "xml-resultMap") return "MyBatis XML resultMap";
  return "fixed-radius fallback";
}

function sortedByReadPriority(files: readonly CandidateFile[], options: ImpactOptions): CandidateFile[] {
  return [...files]
    .map(file => ({ file, priority: readPriority(file, options) }))
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
    .map(entry => entry.file);
}

function sortedForV6Shortlist(files: readonly CandidateFile[], options: ImpactOptions): CandidateFile[] {
  return [...files].sort((left, right) =>
    Number(isAnchor(right, options)) - Number(isAnchor(left, options))
    || right.score - left.score
    || left.absolutePath.localeCompare(right.absolutePath));
}

function v6ReadPriority(file: CandidateFile, options: ImpactOptions): ReadPriority {
  if (file.sourceSet === "test") return options.testReadMode === "priority" ? "P1" : "P2";
  if (file.categories.includes("config") || file.categories.includes("nonJava")) return "P2";
  if (isPureIndexRecall(file)) return "P2";
  if (file.reasons.includes("target") || (file.reasons.includes("implementation") && file.sourceSet === "main")) return "P0";
  return file.sourceSet === "main" ? "P1" : "P2";
}

const INDEX_RECALL_REASONS = new Set(["typeReference", "importGraph", "importGraph:reverse"]);

function isPureIndexRecall(file: CandidateFile): boolean {
  return file.reasons.length > 0 && file.reasons.every(reason => INDEX_RECALL_REASONS.has(reason));
}

function isTaskLocalRepositoryPersistence(
  file: CandidateFile,
  options: Pick<ImpactOptions, "anchors" | "profile" | "focusModules">
): boolean {
  const candidatePath = file.path || file.absolutePath;
  const persistencePath = /(?:^|\/)(?:persistence|entity|mapper)(?:\/|$)/.test(candidatePath)
    || /(?:DO|Entity|Mapper)\.java$/.test(candidatePath);
  if (options.profile !== "repository" || file.sourceSet !== "main" || !persistencePath || !file.module) return false;
  if (options.focusModules.length > 0 && !options.focusModules.includes(file.module)) return false;
  const candidateType = javaTypeName(file);
  const anchorTypes = options.anchors.map(anchor => repositoryAnchorTypeName(anchor.file)).filter(name => name.length >= 3);
  const exactAnchorMatch = anchorTypes.some(anchorType => candidateType === anchorType || candidateType.endsWith(anchorType));
  const anchorFamilies = anchorTypes.map(repositoryAnchorFamily).filter((family): family is string => family.length >= 3);
  const exactFamilyMatch = anchorFamilies.some(family => candidateType === family);
  const derivativeFamilyMatch = anchorFamilies.some(family => candidateType.startsWith(family) || candidateType.endsWith(family));
  const hasDirectCollaborator = (file.scoreBreakdown || []).some(item =>
    item.id === "finalize.direct-collaborator" && item.delta > 0);
  const taskDiscoveredMapper = /(?:^|\/)mapper(?:\/|$)/.test(candidatePath)
    && file.reasons.includes("rg:persistence")
    && hasDirectCollaborator;
  return exactAnchorMatch || exactFamilyMatch || (derivativeFamilyMatch && hasDirectCollaborator) || taskDiscoveredMapper;
}

function repositoryAnchorTypeName(anchorPath: string): string {
  return anchorPath.slice(anchorPath.lastIndexOf("/") + 1).replace(/\.java$/, "");
}

function repositoryAnchorFamily(anchorType: string): string {
  return anchorType.replace(/(?:Repository|Mapper|Service|Controller|Handler|Adapter)(?:Impl)?$/, "");
}

function javaTypeName(file: CandidateFile): string {
  const candidatePath = file.path || file.absolutePath;
  return candidatePath.slice(candidatePath.lastIndexOf("/") + 1).replace(/\.java$/, "");
}

function readReason(file: CandidateFile, priority: ReadPriority): string {
  if (file.reasons.includes("target")) return "anchor symbol and local behavior";
  if (file.reasons.includes("implementation")) return "main implementation candidate";
  if (file.categories.includes("persistence")) return "persistence or migration evidence";
  if (file.sourceSet === "test") return priority === "P1" ? "priority verification candidate" : "deferred verification candidate";
  return "ranked candidate from Java index, rg summary, and optional LSP";
}

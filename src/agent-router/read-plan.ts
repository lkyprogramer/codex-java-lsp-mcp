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
import type { SourceRange } from "../runtime/source-range.js";
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
  "IMPLEMENTATION_METHOD_TYPE",
  "CALLS",
  "definition",
  "implementation",
  "typeHierarchy",
  "typeGraph:implementation-lookup",
  "SPRING_INJECTION",
  "SPRING_CALL_PATH",
  "MYBATIS_STATEMENT_METHOD"
]);

// A concrete class that directly implements or extends the anchor's type is
// the first actionable hop for an interface/port task. Its method parameter
// and return types are useful follow-up context, but must not consume the
// small protected core before the concrete alternatives themselves.
const FIRST_HOP_IMPLEMENTATION_KINDS = new Set([
  "IMPLEMENTS",
  "IMPLEMENTATION",
  "TYPE_RELATION"
]);
const SECOND_HOP_IMPLEMENTATION_KINDS = new Set(["IMPLEMENTATION_METHOD_TYPE"]);
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
  readonly coordinateRanges: SourceRange[];
  readonly bytes: number;
  readonly extremeMethod: boolean;
};

type ShortlistResult = {
  readonly files: CandidateFile[];
  readonly omittedProtected: number;
};

export type ReadPlanBuildResult = {
  items: ReadPlanItemV6[];
  /** Internal path identity used to re-key fileIds after output-tail truncation. */
  selectedPaths: string[];
  /** Benchmark-only exact coordinates. AgentRouter strips this before building public metrics. */
  selectedCoordinateRangesByPath: ReadonlyMap<string, readonly SourceRange[]>;
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
  const rangeResults = shortlist.files.length === 0
    ? []
    : await input.javaIndex.queryReadRanges(
      shortlist.files.map(file => ({ file: file.absolutePath, positions: file.positions })),
      input.generation
    );
  const windows = materializeWindows(shortlist.files, rangeResults);
  const result = selectTokenAwarePlan(windows, input.ids, input.options, selectionBudget, protectedPaths);
  if (shortlist.omittedProtected > 0) {
    result.evidenceGaps = [...new Set([
      `Protected candidates exceeded shortlist capacity; ${shortlist.omittedProtected} candidate(s) were not range-planned.`,
      ...result.evidenceGaps
    ])];
  }
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
      || file.reasons.includes("persisted-implementation")
      || file.reasons.includes("persisted-typeHierarchy")
      || file.reasons.includes("implementation")) {
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
    || (file.reasons.includes("implementation") && file.sourceSet === "main")) return "P0";
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
): ShortlistResult {
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
  // Anchors and protected core cannot be displaced before the byte-aware pass.
  ordered.filter(file => isAnchor(file, options)).forEach(add);
  const protectedCandidates = ordered
    .filter(file => !isAnchor(file, options)
      && !isDeferredTest(file, options)
      && (isProtectedCore(file, options) || protectedPaths.has(file.absolutePath)))
    .sort((left, right) =>
      protectedCorePriority(right, options) - protectedCorePriority(left, options)
      || right.score - left.score
      || left.absolutePath.localeCompare(right.absolutePath));
  protectedCandidates.forEach(add);
  const omittedProtected = protectedCandidates.filter(file => !selected.has(file.absolutePath)).length;
  // Preserve early representation for each evidence bucket, but never force
  // a representative into the final budgeted plan.
  for (const bucket of Object.keys(BUCKET_RULES) as ReadPlanBucket[]) {
    const representative = ordered.find(file =>
      bucketOf(file, options, protectedPaths) === bucket
      && !selected.has(file.absolutePath)
      && !isAnchor(file, options));
    if (representative) add(representative);
  }
  ordered.forEach(add);
  return { files: shortlisted, omittedProtected };
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
      coordinateRanges: (result?.ranges || []).map(range => range.range),
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

  // Keep deferred tests in discovery and range materialization. Removing them
  // earlier reshapes the bounded shortlist and can displace unrelated main
  // evidence. They are ineligible only when consuming a read-plan slot.
  const readableWindows = windows.filter(window => window.ranges.length > 0);
  for (const window of windows) {
    if (!isAnchor(window.file, options) && window.ranges.length === 0) {
      evidenceGaps.push(`Read range unavailable for ${window.file.path || window.file.absolutePath}; candidate was omitted.`);
    }
  }

  const fitsPlanBudget = (window: CandidateWindow): boolean =>
    !selectedPaths.has(window.file.absolutePath)
    && selected.length < budget.maxFiles
    && !budgetExceededByAnchor
    && totalBytes + window.bytes <= budget.maxReadBytes;
  const canAdd = (window: CandidateWindow): boolean => {
    const bucket = bucketOf(window.file, options, protectedPaths);
    return !isDeferredTest(window.file, options)
      && fitsPlanBudget(window)
      && bucketCounts[bucket] < BUCKET_RULES[bucket].max;
  };
  // Core is a hard maximum: quota release may fill missing framework/support/
  // lexical slots, but must not dilute the bounded exact-evidence core.
  const canAddAfterQuotaRelease = (window: CandidateWindow): boolean => {
    const bucket = bucketOf(window.file, options, protectedPaths);
    return !isDeferredTest(window.file, options)
      && fitsPlanBudget(window)
      && (bucket !== "core" || bucketCounts.core < BUCKET_RULES.core.max);
  };
  const core = readableWindows
    .filter(window => (isProtectedCore(window.file, options) || protectedPaths.has(window.file.absolutePath))
      && !isAnchor(window.file, options)
      && !isDeferredTest(window.file, options));
  const coreUsesByteDensity = byteBudgetCanConstrainSelection(
    core,
    totalBytes,
    budget,
    Math.min(budget.maxFiles - selected.length, BUCKET_RULES.core.max - bucketCounts.core)
  );
  core.sort((left, right) =>
    protectedCorePriority(right.file, options) - protectedCorePriority(left.file, options)
    || compareUtilityAndDensity(protectedUtility(left), left.bytes, protectedUtility(right), right.bytes, coreUsesByteDensity)
    || left.file.absolutePath.localeCompare(right.file.absolutePath));
  for (const window of core) {
    if (canAdd(window)) add(window, protectedUtility(window));
  }
  if (core.some(window => !selectedPaths.has(window.file.absolutePath))) {
    evidenceGaps.push("Protected core exceeded read-plan limits; lower-value core files were omitted.");
  }

  const remaining = readableWindows.filter(window => !selectedPaths.has(window.file.absolutePath));
  const nextByMarginalUtility = (
    canSelect: (window: CandidateWindow) => boolean,
    requireNovelEvidence = false
  ): { window: CandidateWindow; utility: number } | undefined =>
    {
      const eligible = remaining
      .filter(window => canSelect(window) && (!requireNovelEvidence || hasNovelEvidence(window.file, selected)))
      .map(window => ({ window, utility: marginalUtility(window, selected) }));
      const preferDensity = byteBudgetCanConstrainSelection(
        eligible.map(item => item.window),
        totalBytes,
        budget,
        budget.maxFiles - selected.length
      );
      return eligible.sort((left, right) =>
        compareUtilityAndDensity(left.utility, left.window.bytes, right.utility, right.window.bytes, preferDensity)
        || right.window.file.score - left.window.file.score
        || left.window.file.absolutePath.localeCompare(right.window.file.absolutePath))[0];
    };
  while (true) {
    const next = nextByMarginalUtility(canAdd);
    if (!next) break;
    add(next.window, next.utility);
    remaining.splice(remaining.indexOf(next.window), 1);
  }
  // Bucket caps create representation, not dead capacity. Once the bounded
  // pass is exhausted, unavailable bucket capacity is released to the best
  // remaining non-core evidence while retaining every hard file/byte limit.
  while (true) {
    const next = nextByMarginalUtility(canAddAfterQuotaRelease, true);
    if (!next) break;
    add(next.window, next.utility);
    remaining.splice(remaining.indexOf(next.window), 1);
  }

  return {
    items: selected.map(window => toPlanItem(window, ids, options)),
    selectedPaths: selected.map(window => window.file.absolutePath),
    selectedCoordinateRangesByPath: new Map(selected.map(window => [window.file.absolutePath, window.coordinateRanges])),
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

function utilityPerByte(utility: number, bytes: number): number {
  return utility / Math.max(256, bytes);
}

/**
 * The planner has two independent hard caps. Density breaks ties only while
 * the byte cap can actually exclude a feasible choice. When the active limit
 * is file count, favouring a cheap lower-value file would double-count byte
 * cost (marginalUtility already carries a bounded byte penalty) and starve a
 * stronger exact collaborator despite unused byte budget.
 */
function byteBudgetCanConstrainSelection(
  candidates: readonly CandidateWindow[],
  selectedBytes: number,
  budget: ReadPlanBudget,
  remainingSlots: number
): boolean {
  if (remainingSlots <= 0) return false;
  const maximumPotentialBytes = [...candidates]
    .map(candidate => candidate.bytes)
    .sort((left, right) => right - left)
    .slice(0, remainingSlots)
    .reduce((sum, bytes) => sum + bytes, 0);
  return selectedBytes + maximumPotentialBytes > budget.maxReadBytes;
}

function compareUtilityAndDensity(
  leftUtility: number,
  leftBytes: number,
  rightUtility: number,
  rightBytes: number,
  preferDensity: boolean
): number {
  const densityDelta = utilityPerByte(rightUtility, rightBytes) - utilityPerByte(leftUtility, leftBytes);
  const utilityDelta = rightUtility - leftUtility;
  return preferDensity
    ? densityDelta || utilityDelta || leftBytes - rightBytes
    : utilityDelta || densityDelta || leftBytes - rightBytes;
}

function protectedCorePriority(file: CandidateFile, options: Pick<ImpactOptions, "anchors">): number {
  const kinds = new Set(file.plannerEvidence?.map(evidence => evidence.kind) || [
    ...file.reasons,
    ...(file.verifiedBy || [])
  ]);
  if ([...kinds].some(kind => kind === "DEFINITION"
    || kind === "IMPLEMENTATION"
    || kind === "TYPEHIERARCHY"
    || kind === "definition"
    || kind === "implementation"
    || kind === "typeHierarchy")) {
    return 3;
  }
  // A concrete anchor's directly declared interface/parent is its public
  // contract, not a downstream expansion. Keep this inverse type edge ahead
  // of implementation alternatives and field context when the bounded core
  // must choose.
  if (kinds.has("TYPE_SYMMETRIC")) {
    return 2.75;
  }
  if ([...kinds].some(kind => FIRST_HOP_IMPLEMENTATION_KINDS.has(kind)
    || kind === "typeGraph:implementation-lookup"
    || kind === "implementation"
    || kind === "persisted-implementation")) {
    return 2;
  }
  if (kinds.has("METHOD_RELATION")) {
    return 2;
  }
  // An anchor-body call has stronger locality than an implementation merely
  // related to the anchor's declared type: it proves the exact receiver used
  // by this task. Syntax nesting alone does not weaken that fact (response
  // wrappers commonly contain the real receiver call). One-hop continuation
  // calls intentionally remain below the first implementation alternatives,
  // because they are downstream context.
  if (file.plannerEvidence?.some(evidence => evidence.kind === "CALLS"
    && (evidence.callOrigin === "anchor" || (evidence.callOrigin === undefined && evidence.callDepth === 0))
    && (evidence.callDepth ?? Infinity) <= 1)) {
    return 2.5;
  }
  if (file.plannerEvidence?.some(evidence => evidence.kind === "CALLS" && evidence.callDepth === 1)) {
    return 1.75;
  }
  if ([...kinds].some(kind => SECOND_HOP_IMPLEMENTATION_KINDS.has(kind))) {
    return 1.5;
  }
  // Framework inference may reserve a core slot, but never ranks ahead of a
  // resolved call or method-local implementation dependency.
  if (kinds.has("SPRING_INJECTION")) {
    return 1;
  }
  return 0;
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

function hasNovelEvidence(candidate: CandidateFile, selected: readonly CandidateWindow[]): boolean {
  const selectedKeys = new Set(selected.flatMap(window => plannerEvidenceKeys(window.file)));
  return plannerEvidenceKeys(candidate).some(key => !selectedKeys.has(key));
}

function plannerEvidenceKeys(file: CandidateFile): string[] {
  if ((file.plannerEvidence?.length ?? 0) > 0) {
    return file.plannerEvidence!.map(item => `${item.family}\0${item.kind}\0${item.sourceTarget}\0${item.callOrigin ?? ""}`);
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

function isDeferredTest(
  file: Pick<CandidateFile, "sourceSet">,
  options: Pick<ImpactOptions, "testReadMode">
): boolean {
  return file.sourceSet === "test" && options.testReadMode === "defer";
}

function isProtectedCore(file: CandidateFile, options: Pick<ImpactOptions, "testReadMode" | "anchors">): boolean {
  if (file.sourceSet === "test" && options.testReadMode === "defer") return false;
  // Planner evidence retains the source of framework links.  A Spring call
  // discovered while expanding a structural seed is useful framework context,
  // but is not a call on this request's anchor path and therefore must not
  // consume the bounded protected-core quota.  Legacy candidates without the
  // structured projection retain their compatibility fallback below.
  if ((file.plannerEvidence?.length ?? 0) > 0) {
    return file.plannerEvidence!.some(evidence => isProtectedCoreEvidence(evidence, options));
  }
  if (file.reasons.some(reason => PROTECTED_CORE_KINDS.has(reason))
    || (file.verifiedBy || []).some(reason => PROTECTED_CORE_KINDS.has(reason))) return true;
  return (file.scoreBreakdown || []).some(item => item.delta > 0 && (
    item.id === "finalize.type-relation"
    || item.id === "finalize.method-relation"
    || item.id === "finalize.structural.type-symmetric"
  ));
}

function isProtectedCoreEvidence(
  evidence: NonNullable<CandidateFile["plannerEvidence"]>[number],
  options: Pick<ImpactOptions, "anchors">
): boolean {
  if (!PROTECTED_CORE_KINDS.has(evidence.kind)) return false;
  // A CALLS edge receives a protected slot only when relationship-provider
  // retained an exact, shallow anchor path. Native edge IDs without that
  // call-site metadata may still rank normally, but cannot turn a deep
  // getter or generic wrapper into protected core merely by sharing CALLS.
  if (evidence.kind === "CALLS") {
    return (evidence.callDepth ?? Infinity) <= 1;
  }
  if (evidence.kind !== "SPRING_CALL_PATH") return true;
  const arrow = evidence.sourceTarget.indexOf("->");
  if (arrow <= 0) return false;
  const source = evidence.sourceTarget.slice(0, arrow);
  return options.anchors.some((anchor, index) => source === `A${index + 1}:${anchor.file}`);
}

function bucketOf(file: CandidateFile, options: ImpactOptions, protectedPaths: ReadonlySet<string>): ReadPlanBucket {
  if (isAnchor(file, options)) return "anchor";
  if (file.sourceSet === "test" && options.testReadMode === "defer") return "support";
  if (isProtectedCore(file, options) || protectedPaths.has(file.absolutePath)) return "core";
  if (file.categories.includes("framework") || file.reasons.some(reason => reason.startsWith("SPRING_") || reason.startsWith("MYBATIS_") || reason.startsWith("MAPSTRUCT_"))) return "framework";
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

function readReason(file: CandidateFile, priority: ReadPriority): string {
  if (file.reasons.includes("target")) return "anchor symbol and local behavior";
  if (file.reasons.includes("implementation")) return "main implementation candidate";
  if (file.categories.includes("persistence")) return "persistence or migration evidence";
  if (file.sourceSet === "test") return priority === "P1" ? "priority verification candidate" : "deferred verification candidate";
  return "ranked candidate from Java index, rg summary, and optional LSP";
}

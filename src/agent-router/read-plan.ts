// input: Ranked candidates and JavaIndex method/type ranges.
// output: Byte/token-aware read plan windows from AST ranges.
// pos: Read plan builder for AgentRouter (Task 22: AST windows, fixed-radius fallback on FAILED).
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { JavaMethodFact, JavaSourceFacts } from "../java-index/router-facts.js";
import type {
  CandidateFile,
  ImpactMode,
  ImpactOptions,
  ReadPlanItem,
  ReadPriority,
  ResolvedImpactProfile,
  RouterPosition
} from "../agent-types.js";
import { selectWithEvidenceBudget } from "./read-plan-budget.js";

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

export async function buildReadPlan(input: BuildReadPlanInput): Promise<ReadPlanItem[]> {
  const protectedPaths = input.protectedPaths || new Set<string>();
  const maxItems = input.options.readPlanMaxItems ?? defaultReadPlanMax(input.options.mode);
  const selected = input.options.semanticPolicy === "required"
    ? selectLegacyReadPlanFiles({ files: input.files, options: input.options, maxItems, protectedPaths })
    : selectReadPlanFiles({ files: input.files, options: input.options, maxItems, protectedPaths });
  const factsCache = new Map<string, JavaSourceFacts | undefined>();
  const items: ReadPlanItem[] = [];
  for (const file of selected) {
    const priority = readPriority(file, input.options);
    const planWindow = await readWindow(input.javaIndex, file, priority, input.generation, factsCache);
    items.push({
      priority,
      fileId: input.ids.get(file.absolutePath) || "F?",
      startLine: planWindow.startLine,
      endLine: planWindow.endLine,
      reason: readReason(file, priority)
    });
  }
  return items;
}

export function selectReadPlanFiles(input: SelectReadPlanInput): CandidateFile[] {
  const protectedPaths = input.protectedPaths || new Set<string>();
  const sorted = sortedByReadPriority(input.files, input.options);
  return selectWithEvidenceBudget(sorted, input.maxItems, protectedReadPlanPaths(sorted, protectedPaths))
    .map(file => ({ file, priority: readPriority(file, input.options) }))
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
    .map(entry => entry.file);
}

export function legacyReadPlanSorted(files: readonly CandidateFile[], options: ImpactOptions): CandidateFile[] {
  return sortedByReadPriority(files, options);
}

export function protectedReadPlanPaths(files: readonly CandidateFile[], protectedPaths: ReadonlySet<string> = new Set<string>()): Set<string> {
  const paths = new Set(protectedPaths);
  for (const file of files) {
    if (((file.verifiedBy || []).includes("typeGraph") && !file.reasons.includes("typeGraph:implementation-lookup")) || file.reasons.includes("implementation")) {
      paths.add(file.absolutePath);
    }
  }
  return paths;
}

export function readPriority(file: CandidateFile, options: ImpactOptions): ReadPriority {
  if (file.sourceSet === "test") {
    return options.testReadMode === "priority" ? "P1" : "P2";
  }
  if (file.categories.includes("config") || file.categories.includes("nonJava")) {
    return "P2";
  }
  if (isPureIndexRecall(file)) {
    return "P2";
  }
  if (file.reasons.includes("target") || (file.reasons.includes("implementation") && file.sourceSet === "main")) {
    return "P0";
  }
  if (file.sourceSet === "main") {
    return "P1";
  }
  return "P2";
}

export function defaultReadPlanMax(mode: ImpactMode): number {
  return mode === "minimal" ? 4 : mode === "precision" ? 8 : mode === "recall" ? 12 : 6;
}

export function candidateLimit(mode: ImpactMode, profile?: ResolvedImpactProfile): number {
  if (mode === "minimal") {
    return 18;
  }
  if (mode === "precision") {
    return 45;
  }
  if (mode === "recall") {
    return 70;
  }
  if (profile === "port") {
    return 20;
  }
  if (profile === "parser") {
    return 18;
  }
  if (profile === "controller") {
    return 16;
  }
  if (profile === "dto") {
    return 24;
  }
  return 26;
}

export function priorityRank(priority: ReadPriority): number {
  return priority === "P0" ? 0 : priority === "P1" ? 1 : 2;
}

function selectLegacyReadPlanFiles(input: SelectReadPlanInput & { readonly protectedPaths: ReadonlySet<string> }): CandidateFile[] {
  const sorted = legacyReadPlanSorted(input.files, input.options);
  const selected: CandidateFile[] = [];
  const selectedPaths = new Set<string>();
  for (const file of sorted) {
    if (selected.length >= input.maxItems) {
      break;
    }
    if (input.protectedPaths.has(file.absolutePath)) {
      selected.push(file);
      selectedPaths.add(file.absolutePath);
    }
  }
  for (const file of sorted) {
    if (selected.length >= input.maxItems) {
      break;
    }
    if (!selectedPaths.has(file.absolutePath)) {
      selected.push(file);
      selectedPaths.add(file.absolutePath);
    }
  }
  return selected;
}

function sortedByReadPriority(files: readonly CandidateFile[], options: ImpactOptions): CandidateFile[] {
  return [...files]
    .map(file => ({ file, priority: readPriority(file, options) }))
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || right.file.score - left.file.score)
    .map(entry => entry.file);
}

async function readWindow(
  javaIndex: RouterIndex,
  file: CandidateFile,
  priority: ReadPriority,
  generation: number | undefined,
  factsCache: Map<string, JavaSourceFacts | undefined>
): Promise<{ startLine: number; endLine: number }> {
  const basePosition = file.positions[0] || { line: 1, column: 1 };
  const radius = readRadius(priority);
  const fixed = {
    startLine: Math.max(1, basePosition.line - radius.before),
    endLine: basePosition.line + radius.after
  };
  const facts = await cachedFacts(javaIndex, file.absolutePath, generation, factsCache);
  // Only FIXED radius when parse failed or facts are unavailable.
  if (!facts || facts.parseState === "FAILED" || facts.factSource === "fallback") {
    return fixed;
  }
  const position = await readPosition(javaIndex, file, priority, generation, factsCache);
  const method = priority === "P2" ? undefined : methodContaining(facts, position.line);
  if (!method) {
    return fixed;
  }
  const padding = priority === "P0" ? { before: 12, after: 8 } : { before: 8, after: 8 };
  const methodWindow = {
    startLine: Math.max(1, method.line - padding.before),
    endLine: method.endLine + padding.after
  };
  return methodWindow.startLine >= fixed.startLine && methodWindow.endLine <= fixed.endLine ? methodWindow : fixed;
}

async function readPosition(
  javaIndex: RouterIndex,
  file: CandidateFile,
  priority: ReadPriority,
  generation: number | undefined,
  factsCache: Map<string, JavaSourceFacts | undefined>
): Promise<RouterPosition> {
  if (file.categories.includes("target")) {
    return file.positions[0] || { line: 1, column: 1 };
  }
  if (priority !== "P2") {
    const facts = await cachedFacts(javaIndex, file.absolutePath, generation, factsCache);
    if (facts) {
      const methodPosition = file.positions.find(position => methodContaining(facts, position.line));
      if (methodPosition) {
        return methodPosition;
      }
    }
  }
  return file.positions[0] || { line: 1, column: 1 };
}

function methodContaining(facts: JavaSourceFacts, line: number): JavaMethodFact | undefined {
  return facts.methods
    .filter(method => method.line <= line && line <= method.endLine)
    .sort((left, right) => right.line - left.line)[0];
}

async function cachedFacts(
  javaIndex: RouterIndex,
  absolutePath: string,
  generation: number | undefined,
  factsCache: Map<string, JavaSourceFacts | undefined>
): Promise<JavaSourceFacts | undefined> {
  if (!absolutePath.endsWith(".java")) {
    return undefined;
  }
  if (factsCache.has(absolutePath)) {
    return factsCache.get(absolutePath);
  }
  try {
    const facts = await javaIndex.factsFor(absolutePath, generation);
    factsCache.set(absolutePath, facts);
    return facts;
  } catch {
    factsCache.set(absolutePath, undefined);
    return undefined;
  }
}

const INDEX_RECALL_REASONS = new Set(["typeReference", "importGraph", "importGraph:reverse"]);

function isPureIndexRecall(file: CandidateFile): boolean {
  return file.reasons.length > 0 && file.reasons.every(reason => INDEX_RECALL_REASONS.has(reason));
}

function readReason(file: CandidateFile, priority: ReadPriority): string {
  if (file.reasons.includes("target")) {
    return "anchor symbol and local behavior";
  }
  if (file.reasons.includes("implementation")) {
    return "main implementation candidate";
  }
  if (file.categories.includes("persistence")) {
    return "persistence or migration evidence";
  }
  if (file.sourceSet === "test") {
    return priority === "P1" ? "priority verification candidate" : "deferred verification candidate";
  }
  return "ranked candidate from Java index, rg summary, and optional LSP";
}

function readRadius(priority: ReadPriority): { before: number; after: number } {
  return priority === "P0" ? { before: 24, after: 44 } : priority === "P1" ? { before: 16, after: 32 } : { before: 10, after: 22 };
}

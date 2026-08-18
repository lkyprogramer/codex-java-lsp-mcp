import type { PathContext } from "../repo-layout.js";
import type { RoutingPolicy } from "../routing-policy.js";
import type { JavaSourceFacts } from "../java-index/router-facts.js";
import type {
  CandidateFile,
  Confidence,
  ImpactOptions,
  ResolvedAnchor,
  ScoreBreakdownItem
} from "../agent-types.js";

export type FactPositionHint = {
  methodName?: string;
  /** Prefer the unique hydrated method that names this collaborator type. */
  typeName?: string;
};

export function candidateFromFacts(
  facts: JavaSourceFacts,
  score: number,
  verifiedBy: string,
  hint?: FactPositionHint
): CandidateFile {
  return {
    absolutePath: facts.absolutePath,
    path: facts.path,
    module: facts.module,
    layer: facts.layer,
    sourceSet: facts.sourceSet,
    score,
    matchCount: 0,
    positions: [positionFromFacts(facts, hint)],
    categories: ["semantic"],
    reasons: [verifiedBy],
    confidence: "medium",
    verifiedBy: [verifiedBy],
    scoreBreakdown: [breakdown(`semantic.${verifiedBy}`, "semantic-seed", score, verifiedBy)]
  };
}

/** Prefer the hit-reason method. Never invent a type-header stand-in for (1,1). */
export function positionFromFacts(facts: JavaSourceFacts, hint?: FactPositionHint): { line: number; column: number } {
  const methods = facts.methods ?? [];
  const preferred = hint?.methodName
    ? methods.find(method => method.name === hint.methodName)
    : undefined;
  const typeMatches = !preferred && hint?.typeName
    ? methodsReferencingType(methods, hint.typeName)
    : [];
  const method = preferred
    ?? (typeMatches.length === 1 ? typeMatches[0] : undefined)
    ?? (methods.length === 1 ? methods[0] : undefined);
  if (method && method.line >= 1) return { line: method.line, column: 1 };
  return { line: 1, column: 1 };
}

function methodsReferencingType(methods: JavaSourceFacts["methods"], typeName: string): JavaSourceFacts["methods"] {
  const needle = simpleTypeName(typeName);
  if (!needle) return [];
  return methods.filter(method =>
    method.referencedTypes.some(type => simpleTypeName(type) === needle)
    || (method.relations ?? []).some(relation => simpleTypeName(relation.typeName) === needle)
  );
}

export function mergeCandidate(target: Map<string, CandidateFile>, incoming: CandidateFile): void {
  const existing = target.get(incoming.absolutePath);
  if (!existing) {
    target.set(incoming.absolutePath, { ...incoming, positions: [...incoming.positions] });
    return;
  }
  existing.score += incoming.score;
  existing.matchCount += incoming.matchCount;
  existing.categories = unique([...existing.categories, ...incoming.categories]);
  existing.reasons = unique([...existing.reasons, ...incoming.reasons]);
  existing.confidence = maxConfidence(existing.confidence, incoming.confidence);
  existing.verifiedBy = unique([...(existing.verifiedBy || []), ...(incoming.verifiedBy || [])]);
  existing.scoreBreakdown = [...(existing.scoreBreakdown || []), ...(incoming.scoreBreakdown || [breakdown("merge.incoming", "merge", incoming.score, "merged candidate score")])];
  for (const position of incoming.positions) {
    if (existing.positions.length >= 8) {
      break;
    }
    if (!existing.positions.some(item => item.line === position.line && item.column === position.column)) {
      existing.positions.push(position);
    }
  }
}

export function breakdown(id: string, source: ScoreBreakdownItem["source"], delta: number, reason: string): ScoreBreakdownItem {
  return { id, source, delta, reason };
}

export function addScoreDelta(items: ScoreBreakdownItem[], id: string, delta: number, reason: string): number {
  items.push(breakdown(id, "finalize", delta, reason));
  return delta;
}

export function scoreBase(policy: RoutingPolicy, category: string, context: PathContext, anchor: ResolvedAnchor, options: ImpactOptions): number {
  void policy;
  void context;
  void anchor;
  void options;
  return DISCOVERY_CATEGORY_BASE[category] ?? 18;
}

/**
 * Internal CandidateFile seed values retained for legacy collectors whose
 * touched-map/detailed rg summaries still require a positive numeric score.
 * These values never cross the normalized-evidence family rank boundary.
 */
const DISCOVERY_CATEGORY_BASE: Readonly<Record<string, number>> = {
  persistence: 70,
  protocol: 64,
  java: 56,
  semantic: 80,
  tests: 24,
  config: 18,
  nonJava: 18
};

export function simpleTypeName(value: string): string {
  const withoutGenerics = value.replace(/<.*$/, "");
  return withoutGenerics.slice(withoutGenerics.lastIndexOf(".") + 1);
}

export function matchesAny(value: string, keywords: string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some(keyword => keyword.length > 0 && lower.includes(keyword.toLowerCase()));
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function maxConfidence(left: Confidence | undefined, right: Confidence | undefined): Confidence | undefined {
  if (!left) return right;
  if (!right) return left;
  return confidenceRank(right) > confidenceRank(left) ? right : left;
}

function confidenceRank(value: Confidence): number {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

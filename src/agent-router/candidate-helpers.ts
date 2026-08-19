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
  /** Unique callee name from the caller's local-receiver relations, used when methodName is absent on the implementer. */
  calleeNames?: readonly string[];
};

export function calleeNamesFromRelations(
  relations: readonly { kind: string; name?: string }[] | undefined
): string[] {
  return [...new Set(
    (relations ?? [])
      .filter(relation => relation.kind === "local-receiver" && relation.name)
      .map(relation => relation.name!)
  )];
}

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

const BOOT_APPLICATION_ANNOTATIONS = new Set(["SpringBootApplication", "SpringBootConfiguration"]);

/** Prefer the hit-reason method. Never invent a type-header stand-in for (1,1). */
export function positionFromFacts(facts: JavaSourceFacts, hint?: FactPositionHint): { line: number; column: number } {
  // Boot application value is the annotation header (ComponentScan / exclude
  // filters), not the unique `main` method that hydrate otherwise selects.
  if (isSpringBootApplicationType(facts) && (facts.typeStartLine ?? 0) >= 1) {
    return { line: facts.typeStartLine!, column: 1 };
  }
  const methods = facts.methods ?? [];
  const preferred = hint?.methodName
    ? methods.find(method => method.name === hint.methodName)
    : undefined;
  const calleeMatches = !preferred && hint?.calleeNames?.length
    ? methods.filter(method => hint.calleeNames!.includes(method.name))
    : [];
  const typeMatches = !preferred && calleeMatches.length !== 1 && hint?.typeName
    ? methodsReferencingType(methods, hint.typeName)
    : [];
  const method = preferred
    ?? (calleeMatches.length === 1 ? calleeMatches[0] : undefined)
    ?? (typeMatches.length === 1 ? typeMatches[0] : undefined)
    ?? (methods.length === 1 ? methods[0] : undefined);
  if (method && method.line >= 1) return { line: method.line, column: 1 };
  return { line: 1, column: 1 };
}

export function isPrimaryImplementer(facts: JavaSourceFacts): boolean {
  return (facts.annotations ?? []).some(name => simpleTypeName(name) === "Primary");
}

/**
 * One implementer stays as-is (paper-task). Several alternatives keep only
 * `@Primary` when that annotation exists; otherwise every main-source
 * alternative is retained (storage gateways have no Primary). Test fixtures
 * are ignored when a main-source implementer exists.
 */
export function selectPreferredImplementers(implementers: readonly JavaSourceFacts[]): JavaSourceFacts[] {
  const main = implementers.filter(item => item.sourceSet !== "test");
  const pool = main.length > 0 ? main : [...implementers];
  if (pool.length <= 1) return pool;
  const primary = pool.filter(isPrimaryImplementer);
  return primary.length > 0 ? primary : pool;
}

export function isSpringBootApplicationType(facts: JavaSourceFacts): boolean {
  return (facts.annotations ?? []).some(name => BOOT_APPLICATION_ANNOTATIONS.has(simpleTypeName(name)));
}

export function sourceModuleKey(file: { module?: string; absolutePath?: string; path?: string }): string {
  if (file.module) return file.module;
  const candidate = file.absolutePath || file.path || "";
  const parts = candidate.replace(/\\/g, "/").split("/");
  const src = parts.lastIndexOf("src");
  return src > 0 ? parts.slice(0, src).join("/") : "";
}

export function sameSourceModule(
  left: { module?: string; absolutePath?: string; path?: string },
  right: { module?: string; absolutePath?: string; path?: string }
): boolean {
  const leftKey = sourceModuleKey(left);
  const rightKey = sourceModuleKey(right);
  return leftKey.length > 0 && leftKey === rightKey;
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

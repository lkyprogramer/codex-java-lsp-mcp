import type { PathContext } from "../repo-layout.js";
import { scoreWithPolicy, type RoutingPolicy, type ScoreCategory } from "../routing-policy.js";
import type { JavaSourceFacts } from "../java-index/router-facts.js";
import type {
  CandidateFile,
  Confidence,
  ImpactOptions,
  ResolvedAnchor,
  ScoreBreakdownItem
} from "../agent-types.js";

export function candidateFromFacts(facts: JavaSourceFacts, score: number, verifiedBy: string): CandidateFile {
  return {
    absolutePath: facts.absolutePath,
    path: facts.path,
    module: facts.module,
    layer: facts.layer,
    sourceSet: facts.sourceSet,
    score,
    matchCount: 0,
    positions: [{ line: 1, column: 1 }],
    categories: ["semantic"],
    reasons: [verifiedBy],
    confidence: "medium",
    verifiedBy: [verifiedBy],
    scoreBreakdown: [breakdown(`semantic.${verifiedBy}`, "semantic-seed", score, verifiedBy)]
  };
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
  return scoreWithPolicy(policy, category as ScoreCategory, context, anchor, options);
}

export function typeReferenceOrderBonus(order: number | undefined): number {
  return order === undefined ? 0 : Math.max(0, 80 - order * 5);
}

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

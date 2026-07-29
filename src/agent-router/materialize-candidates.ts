// input: family-ranker.ts's ranked CandidateEvidence[] (module/layer/sourceSet populated by normalizeEvidence(..., repoRoot)).
// output: CandidateFile[] compatible with read-plan.ts/format.ts/ranking-signals.ts/read-plan-budget.ts.
// pos: Task 25 item 3 - the boundary between the new evidence ranker and every existing CandidateFile consumer.
//      Not called from index.ts/rank-candidates.ts yet - stays behind the item 6 shadow boundary.
import { classifyPath } from "../repo-layout.js";
import type { CandidateFile, ResolvedAnchor, RouterPosition, ScoreBreakdownItem } from "../agent-types.js";
import { candidateFromAnchor } from "./candidate-collectors.js";
import type { CandidateEvidence, EvidenceFamily } from "./evidence.js";

/**
 * `signal.kind` -> legacy `finalize.*` scoreBreakdown id, for relationships a
 * bare kind string can honestly reconstruct today. `read-plan.ts`/
 * `ranking-signals.ts`/`read-plan-budget.ts` check these ids' *presence*
 * (delta > 0), not their numeric provenance - see Task 25 item 3 review.
 *
 * Only IMPLEMENTS is mapped: static-provider's typeGraph stage looks up
 * implementers of the *anchor's own type*, which is exactly what
 * `finalize.type-relation` used to detect (candidate extends/implements
 * anchor.className). `finalize.direct-collaborator`, `finalize.method-relation`,
 * and the three `finalize.structural.*` ids need anchor context (profile,
 * className, method relations, annotations) a kind string alone cannot carry -
 * those need a real relationship-evidence provider (item 4), not a lookup
 * table. Leaving them unmapped here is the intended, honest state until then,
 * not an oversight.
 */
const KIND_TO_LEGACY_ID: Partial<Record<string, { id: string; reason: string }>> = {
  IMPLEMENTS: { id: "finalize.type-relation", reason: "implements or extends anchor type" }
};

/**
 * `signal.family` -> a `CandidateFile.categories` tag. This is a coarser
 * approximation than the old per-rg-section categories (config/persistence/
 * nonJava/tests were distinguished by which rg section matched, not by a
 * single family) - `read-plan.ts`'s persistence-category prioritization in
 * particular is not fully reconstructable from family alone. Flagged as a
 * known gap for item 4/5, not solved here.
 */
const FAMILY_TO_CATEGORY: Partial<Record<EvidenceFamily, string>> = {
  SUPPORT: "config",
  TASK_CONTEXT: "task-context",
  LEXICAL: "naming",
  EXACT_SEMANTIC: "semantic"
};

const MAX_POSITIONS = 8;

/**
 * The anchor is not evidence - old code (`candidateFromAnchor`) synthesized
 * it directly with a fixed high score, and this keeps doing exactly that
 * rather than inventing an ANCHOR family for family-ranker.ts to rank first.
 * Presence is the guarantee; prepending it is what fixes its position.
 */
export function materializeRankedCandidates(
  ranked: readonly CandidateEvidence[],
  anchors: readonly ResolvedAnchor[],
  repoRoot: string
): CandidateFile[] {
  const anchorFiles = anchors.map(candidateFromAnchor);
  const anchorPaths = new Set(anchorFiles.map(file => file.absolutePath));
  const rest = ranked
    .filter(candidate => !anchorPaths.has(candidate.file))
    .map(candidate => materializeOne(candidate, repoRoot));
  return [...anchorFiles, ...rest];
}

function materializeOne(candidate: CandidateEvidence, repoRoot: string): CandidateFile {
  const path = classifyPath(repoRoot, candidate.file).relativePath;
  const reasons = unique(candidate.signals.map(signal => signal.kind));
  // LEXICAL signal count stands in for the old rg matchCount - it is the
  // closest existing analog, not a literal port of rg's per-line match tally.
  const matchCount = candidate.signals.filter(signal => signal.family === "LEXICAL").length;
  const categories = unique(
    candidate.signals
      .map(signal => FAMILY_TO_CATEGORY[signal.family])
      .filter((category): category is string => Boolean(category))
  );
  const positions = dedupePositions(candidate.signals.flatMap(signal => signal.positions));
  const scoreBreakdown: ScoreBreakdownItem[] = [
    { id: "family-ranker.final-score", source: "policy", delta: candidate.finalScore, reason: "family-saturated score" },
    ...legacyCompatEntries(candidate)
  ];
  return {
    absolutePath: candidate.file,
    path,
    module: candidate.module,
    layer: candidate.layer,
    sourceSet: candidate.sourceSet,
    score: candidate.finalScore,
    matchCount,
    positions,
    categories,
    reasons,
    confidence: candidate.confidence,
    verifiedBy: reasons,
    scoreBreakdown
  };
}

function legacyCompatEntries(candidate: CandidateEvidence): ScoreBreakdownItem[] {
  const seen = new Set<string>();
  const entries: ScoreBreakdownItem[] = [];
  for (const signal of candidate.signals) {
    const mapped = KIND_TO_LEGACY_ID[signal.kind];
    if (!mapped || seen.has(mapped.id)) {
      continue;
    }
    seen.add(mapped.id);
    entries.push({ id: mapped.id, source: "finalize", delta: signal.weight, reason: mapped.reason });
  }
  return entries;
}

function dedupePositions(positions: readonly RouterPosition[]): RouterPosition[] {
  const result: RouterPosition[] = [];
  for (const position of positions) {
    if (result.length >= MAX_POSITIONS) {
      break;
    }
    if (!result.some(item => item.line === position.line && item.column === position.column)) {
      result.push(position);
    }
  }
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

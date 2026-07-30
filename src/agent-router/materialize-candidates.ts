// input: family-ranker.ts's ranked CandidateEvidence[] (module/layer/sourceSet populated by normalizeEvidence(..., repoRoot)).
// output: CandidateFile[] compatible with read-plan.ts/format.ts/ranking-signals.ts/read-plan-budget.ts.
// pos: Task 25 production boundary between the evidence ranker and existing CandidateFile consumers.
//      rank-candidates.ts calls this after evidence normalization.
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
 * IMPLEMENTS (static-provider's typeGraph stage: implementers of the
 * anchor's own type) and TYPE_RELATION (relationship-provider's
 * structuralDeltas, item 4: any typeReference-verified candidate that
 * implements/extends anchor.className, for anchor profiles typeGraph skips)
 * are two different discovery paths to the same relationship, so both map
 * to `finalize.type-relation` - `legacyCompatEntries` takes the max delta
 * per id, matching the old `Math.max()` between directCollaboratorDelta and
 * directReferencedTypeDelta, not a sum.
 */
const KIND_TO_LEGACY_ID: Partial<Record<string, { id: string; reason: string }>> = {
  IMPLEMENTS: { id: "finalize.type-relation", reason: "implements or extends anchor type" },
  TYPE_RELATION: { id: "finalize.type-relation", reason: "implements or extends anchor type" },
  TASK_KEYWORD: { id: "finalize.task-keyword", reason: "task keyword evidence" },
  DIRECT_COLLABORATOR: { id: "finalize.direct-collaborator", reason: "direct type-name collaborator" },
  METHOD_RELATION: { id: "finalize.method-relation", reason: "method relation" },
  ANNOTATION_COLLABORATION: { id: "finalize.structural.annotation", reason: "stereotype collaboration" },
  PACKAGE_PROXIMITY: { id: "finalize.structural.package", reason: "package proximity" },
  TYPE_SYMMETRIC: { id: "finalize.structural.type-symmetric", reason: "anchor is candidate subtype" },
  KIND_PAIRING: { id: "finalize.structural.kind", reason: "interface-impl pairing" }
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
  EXACT_SEMANTIC: "semantic",
  STATIC_STRUCTURE: "semantic",
  TASK_CONTEXT: "task-context",
  // Generic adapter vocabulary (Task 27 Slice C) - not "spring", since
  // Task 28/29's MyBatis/JPA packs will emit the same family through the
  // same runner. read-plan-budget.ts's evidenceClassOf treats this category
  // as "verified": by the time a signal reaches here it already passed an
  // adapter's own high-confidence gate (informational/low-confidence facts
  // go to FrameworkCollectResult.metadata, never to evidence at all).
  FRAMEWORK: "framework",
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
  repoRoot: string,
  /**
   * Candidate discovery metadata is orthogonal to rank evidence. During the
   * shadow transition the production fold already has the authoritative
   * category/reason/verification union; retain it so buildReadPlan compares
   * two rankers, rather than a ranker against a lossy adapter.
   */
  legacyCandidates: ReadonlyMap<string, CandidateFile> = new Map()
): CandidateFile[] {
  const anchorFiles = anchors.map(candidateFromAnchor);
  const anchorPaths = new Set(anchorFiles.map(file => file.absolutePath));
  const rest = ranked
    .filter(candidate => !anchorPaths.has(candidate.file))
    .map(candidate => materializeOne(candidate, repoRoot, legacyCandidates.get(candidate.file)));
  return [...anchorFiles, ...rest];
}

function materializeOne(candidate: CandidateEvidence, repoRoot: string, legacy?: CandidateFile): CandidateFile {
  const path = legacy?.path ?? classifyPath(repoRoot, candidate.file).relativePath;
  const evidenceReasons = candidate.signals.map(signal => lexicalCategory(signal.kind) ? `rg:${lexicalCategory(signal.kind)}` : signal.kind);
  const reasons = unique([...(legacy?.reasons ?? []), ...evidenceReasons]);
  // LEXICAL signal count stands in for the old rg matchCount - it is the
  // closest existing analog, not a literal port of rg's per-line match tally.
  const matchCount = candidate.signals.filter(signal => signal.family === "LEXICAL").length;
  const lexicalCategories = candidate.signals
    .map(signal => lexicalCategory(signal.kind))
    .filter((category): category is string => Boolean(category));
  const categories = unique([
    ...(legacy?.categories ?? []),
    ...lexicalCategories,
    ...candidate.signals
      .map(signal => signal.kind === "SUPPORT_FILE" ? "config" : FAMILY_TO_CATEGORY[signal.family])
      .filter((category): category is string => Boolean(category)),
    ...(candidate.signals.some(signal => signal.family === "LEXICAL") && lexicalCategories.length === 0 ? ["naming"] : [])
  ]);
  const positions = dedupePositions([...candidate.signals.flatMap(signal => signal.positions), ...(legacy?.positions ?? [])]);
  const scoreBreakdown: ScoreBreakdownItem[] = [
    { id: "family-ranker.final-score", source: "policy", delta: candidate.finalScore, reason: "family-saturated score" },
    ...legacyCompatEntries(candidate)
  ];
  return {
    absolutePath: candidate.file,
    path,
    module: candidate.module ?? legacy?.module,
    layer: candidate.layer ?? legacy?.layer,
    sourceSet: candidate.sourceSet ?? legacy?.sourceSet,
    score: candidate.finalScore,
    matchCount: Math.max(matchCount, legacy?.matchCount ?? 0),
    positions,
    categories,
    reasons,
    confidence: candidate.confidence,
    verifiedBy: unique([...(legacy?.verifiedBy ?? []), ...reasons]),
    scoreBreakdown
  };
}

function lexicalCategory(kind: string): string | undefined {
  const category = kind.startsWith("LEXICAL:") ? kind.slice("LEXICAL:".length) : "";
  return category.length > 0 ? category : undefined;
}

function legacyCompatEntries(candidate: CandidateEvidence): ScoreBreakdownItem[] {
  const bestById = new Map<string, ScoreBreakdownItem>();
  for (const signal of candidate.signals) {
    const mapped = KIND_TO_LEGACY_ID[signal.kind];
    if (!mapped) {
      continue;
    }
    const current = bestById.get(mapped.id);
    if (!current || signal.weight > current.delta) {
      bestById.set(mapped.id, { id: mapped.id, source: "finalize", delta: signal.weight, reason: mapped.reason });
    }
  }
  return [...bestById.values()];
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

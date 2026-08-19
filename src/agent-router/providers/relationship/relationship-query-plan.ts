// input: Relationship provider anchors and static-verified candidates.
// output: QUERY_RELATIONSHIP_BUNDLE request plan. Does not score candidates.
// pos: V5R Phase 1 query-plan split of relationship-provider.ts.
import type { CandidateFile, ResolvedAnchor } from "../../../agent-types.js";
import { MAX_FACTS_FOR_FILES } from "../../../java-index/router-facts.js";
import {
  ALL_RELATIONSHIP_BUNDLE_NEEDS,
  DEFAULT_RELATIONSHIP_BUNDLE_LIMITS,
  type RelationshipBundleRequest
} from "../../../java-index/relationship-bundle.js";

export type RelationshipQueryPlanInput = {
  readonly generation: number;
  readonly anchors: readonly ResolvedAnchor[];
  readonly staticVerifiedCandidates: readonly CandidateFile[];
};

export function buildRelationshipQueryPlan(input: RelationshipQueryPlanInput): RelationshipBundleRequest {
  const candidateFiles = uniquePaths([
    ...input.anchors.map(anchor => anchor.absolutePath),
    ...input.staticVerifiedCandidates
      .map(candidate => candidate.absolutePath)
      .filter(candidatePath => candidatePath.endsWith(".java"))
  ]).slice(0, MAX_FACTS_FOR_FILES);
  return {
    generation: input.generation,
    anchors: input.anchors.map(anchor => ({
      anchorId: anchor.id,
      file: anchor.absolutePath,
      line: anchor.line,
      column: anchor.column
    })),
    candidateFiles,
    needs: ALL_RELATIONSHIP_BUNDLE_NEEDS,
    limits: { ...DEFAULT_RELATIONSHIP_BUNDLE_LIMITS }
  };
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

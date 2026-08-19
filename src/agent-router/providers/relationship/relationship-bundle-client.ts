// input: Relationship query plan and optional router bundle facade.
// output: RelationshipBundleView or undefined when the index cannot serve it.
// pos: V5R Phase 1 bundle client. Projector and ranking stay out of this file.
import type { RelationshipBundleRequest, RelationshipBundleView } from "../../../java-index/relationship-bundle.js";

export type RelationshipBundleIndex = {
  queryRelationshipBundle?(
    request: RelationshipBundleRequest,
    generation?: number
  ): Promise<RelationshipBundleView>;
};

export async function fetchRelationshipBundle(
  javaIndex: RelationshipBundleIndex,
  plan: RelationshipBundleRequest
): Promise<RelationshipBundleView | undefined> {
  if (!javaIndex.queryRelationshipBundle) return undefined;
  return javaIndex.queryRelationshipBundle(plan, plan.generation);
}

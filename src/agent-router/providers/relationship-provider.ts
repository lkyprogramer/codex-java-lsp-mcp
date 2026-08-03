// input: Already-discovered candidates (from every provider) plus the subset static-provider verified via typeGraph/typeReference.
// output: ProviderOutcome carrying direct-collaborator/method-relation/structural-pairing EvidenceSignal[].
// pos: Task 25 production relationship-evidence provider. Relationship strength
//      extraction is isolated from final ranking in relationship-deltas.ts.
import type { CandidateFile } from "../../agent-types.js";
import type { JavaMethodFact, JavaSourceFacts } from "../../java-index/router-facts.js";
import type { EvidenceFamily, EvidenceProvenance, EvidenceSignal, ProviderInput, ProviderOutcome } from "../evidence.js";
import {
  directCollaboratorDelta,
  directReferencedTypeDelta,
  methodRelationDelta,
  structuralDeltas
} from "../relationship-deltas.js";
import { nextSignalId } from "./shared.js";

export const RELATIONSHIP_PROVIDER_ID = "relationship";
export const RELATIONSHIP_PROVIDER_VERSION = "1";

export type RelationshipProviderInput = ProviderInput & {
  /**
   * Every candidate already discovered this request, from every provider.
   * directCollaboratorDelta/directReferencedTypeDelta are pure name/path
   * matching and runs without a verifiedBy
   * gate, so this provider runs them the same way, on the full set.
   */
  readonly allCandidates: readonly CandidateFile[];
  /**
   * Candidates static-provider tagged verifiedBy typeGraph/typeReference.
   * The facts-based checks (method relation, annotation, package proximity,
   * type symmetry, kind pairing) fetch each candidate's parsed facts, so
   * relationship extraction gates them to this subset to avoid foreground-parsing
   * a lexical-only rg hit just to rank it. This provider keeps that gate.
   */
  readonly staticVerifiedCandidates: readonly CandidateFile[];
};

/** Fixed, context-independent relationship weights - unlike scoreBase()-derived weights, these were never routing-policy-dependent, so item 5's weight-unification does not need to touch them. */
const SIGNAL_POLICY: Record<string, { family: EvidenceFamily; provenance: EvidenceProvenance; confidence: number }> = {
  // directCollaboratorDelta is a class-name/task-stem match, not a resolved
  // framework edge.  Keep the legacy compatibility marker for read-plan
  // protection, but put its rank effect in the capped SUPPORT family so a
  // broad name match cannot consume the FRAMEWORK budget.
  DIRECT_COLLABORATOR: { family: "SUPPORT", provenance: "LEXICAL_RG", confidence: 0.75 },
  METHOD_RELATION: { family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.9 },
  ANNOTATION_COLLABORATION: { family: "FRAMEWORK", provenance: "FRAMEWORK_INFERRED", confidence: 0.6 },
  PACKAGE_PROXIMITY: { family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.5 },
  TYPE_RELATION: { family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.85 },
  TYPE_SYMMETRIC: { family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.9 },
  KIND_PAIRING: { family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.7 }
};

export async function collectRelationshipEvidence(input: RelationshipProviderInput): Promise<ProviderOutcome> {
  const startedAt = Date.now();
  const anchor = input.anchors[0];
  if (!anchor) {
    return emptyOutcome(startedAt);
  }
  let anchorFacts: JavaSourceFacts | undefined;
  try {
    anchorFacts = await input.javaIndex.factsFor(anchor.absolutePath, input.generation);
  } catch {
    anchorFacts = undefined;
  }
  const factsCache = new Map<string, JavaSourceFacts | undefined>();
  const methodCache = new Map<string, JavaMethodFact | undefined>();
  if (anchorFacts) {
    factsCache.set(anchor.absolutePath, anchorFacts);
  }

  const evidence: EvidenceSignal[] = [];
  for (const candidate of input.allCandidates) {
    const directDelta = Math.max(
      directCollaboratorDelta(candidate, anchor, input.options),
      anchor.profile === "service" ? directReferencedTypeDelta(candidate, anchorFacts) : 0
    );
    pushIfPositive(evidence, input, anchor.id, candidate, "DIRECT_COLLABORATOR", directDelta);
  }

  for (const candidate of input.staticVerifiedCandidates) {
    const methodDelta = await methodRelationDelta(candidate, anchor, input.javaIndex, input.generation, methodCache, factsCache);
    pushIfPositive(evidence, input, anchor.id, candidate, "METHOD_RELATION", methodDelta);

    const structural = await structuralDeltas(input.javaIndex, candidate, anchor, anchorFacts, input.generation, factsCache);
    pushIfPositive(evidence, input, anchor.id, candidate, "ANNOTATION_COLLABORATION", structural.annotation);
    pushIfPositive(evidence, input, anchor.id, candidate, "PACKAGE_PROXIMITY", structural.packageProximity);
    // structural.typeRelation is a *different* discovery path to the same
    // relationship static-provider's IMPLEMENTS signal covers when typeGraph
    // ran for this anchor's profile (interface/port/repository/service) -
    // structuralDeltas runs for any typeReference-verified candidate
    // regardless of anchor profile, so it covers anchors typeGraph skips.
    // Both map to finalize.type-relation in materialize-candidates.ts (max,
    // not sum) and family-ranker.ts saturates per family anyway, so emitting
    // both when they overlap does not double-count.
    pushIfPositive(evidence, input, anchor.id, candidate, "TYPE_RELATION", structural.typeRelation);
    // This is the inverse direction: the anchor implements/extends the
    // candidate type. It is the concrete implementation -> interface/parent
    // relationship that must remain visible in production ranking.
    pushIfPositive(evidence, input, anchor.id, candidate, "TYPE_SYMMETRIC", structural.typeSymmetric);
    pushIfPositive(evidence, input, anchor.id, candidate, "KIND_PAIRING", structural.kind);
  }

  return {
    providerId: RELATIONSHIP_PROVIDER_ID,
    providerVersion: RELATIONSHIP_PROVIDER_VERSION,
    evidence,
    // No legacy CandidateFile fragments: unlike Task 24's providers, this one
    // never nominates a candidate the others did not already find, so it has
    // nothing for rank-candidates.ts's transitional fold to consume.
    candidates: [],
    completion: "COMPLETE",
    elapsedMs: Date.now() - startedAt
  };
}

function pushIfPositive(
  evidence: EvidenceSignal[],
  input: ProviderInput,
  anchorId: string,
  candidate: CandidateFile,
  kind: string,
  weight: number
): void {
  if (weight <= 0) {
    return;
  }
  const policy = SIGNAL_POLICY[kind]!;
  evidence.push({
    signalId: nextSignalId(RELATIONSHIP_PROVIDER_ID),
    candidateFile: candidate.absolutePath,
    anchorId,
    kind,
    family: policy.family,
    provenance: policy.provenance,
    confidence: policy.confidence,
    completeness: "COMPLETE",
    weight,
    sourceFile: candidate.absolutePath,
    positions: candidate.positions,
    providerId: RELATIONSHIP_PROVIDER_ID,
    providerVersion: RELATIONSHIP_PROVIDER_VERSION,
    generation: input.generation
  });
}

function emptyOutcome(startedAt: number): ProviderOutcome {
  return {
    providerId: RELATIONSHIP_PROVIDER_ID,
    providerVersion: RELATIONSHIP_PROVIDER_VERSION,
    evidence: [],
    candidates: [],
    completion: "COMPLETE",
    elapsedMs: Date.now() - startedAt
  };
}

// input: The subset static-provider verified via typeGraph/typeReference.
// output: ProviderOutcome carrying exact call/method-relation/structural-pairing EvidenceSignal[].
// pos: Task 25 production relationship-evidence provider. Relationship strength
//      extraction is isolated from final ranking in relationship-deltas.ts.
import type { CandidateFile, ResolvedAnchor } from "../../agent-types.js";
import type { JavaMethodFact, JavaSourceFacts } from "../../java-index/router-facts.js";
import type { EvidenceFamily, EvidenceProvenance, EvidenceSignal, ProviderInput, ProviderOutcome } from "../evidence.js";
import {
  methodRelationDelta,
  structuralDeltas
} from "../relationship-deltas.js";
import { nextSignalId } from "./shared.js";

export const RELATIONSHIP_PROVIDER_ID = "relationship";
export const RELATIONSHIP_PROVIDER_VERSION = "1";

export type RelationshipProviderInput = ProviderInput & {
  /** Retained request pool metadata for provider sequencing compatibility. */
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
  CALLS: { family: "STATIC_STRUCTURE", provenance: "AST_RESOLVED", confidence: 0.98 },
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
  const resolvedCallTargets = await resolvedAnchorCallTargets(input, anchor, methodCache);

  for (const candidate of input.staticVerifiedCandidates) {
    if (resolvedCallTargets.size > 0) {
      const candidateFacts = await cachedFacts(input.javaIndex, candidate.absolutePath, input.generation, factsCache);
      if (candidateFacts?.methods.some(method => method.methodId && resolvedCallTargets.has(method.methodId))) {
        pushIfPositive(evidence, input, anchor.id, candidate, "CALLS", 120);
      }
    }
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

/**
 * Calls are protected only when the Java index resolved the CALLS edge from
 * the request anchor's method. We intentionally ignore a truncated result:
 * treating a partial callee list as exact would turn an implementation cap
 * into an unsound read-plan guarantee.
 */
async function resolvedAnchorCallTargets(
  input: RelationshipProviderInput,
  anchor: ResolvedAnchor,
  methodCache: Map<string, JavaMethodFact | undefined>
): Promise<ReadonlySet<string>> {
  if (!input.javaIndex.resolvedCallees || input.budget?.expired()) {
    return new Set();
  }
  const key = `${anchor.absolutePath}:${anchor.line}`;
  let method = methodCache.get(key);
  if (!methodCache.has(key)) {
    try {
      method = await input.javaIndex.methodAt(anchor.absolutePath, anchor.line, input.generation);
      methodCache.set(key, method);
    } catch {
      method = undefined;
      methodCache.set(key, method);
    }
  }
  if (!method?.methodId || input.budget?.expired()) {
    return new Set();
  }
  try {
    const result = await input.javaIndex.resolvedCallees(method.methodId, 16);
    if (result.truncated || input.budget?.expired()) {
      return new Set();
    }
    return new Set(result.callees
      .filter(edge => edge.kind === "CALLS")
      .map(edge => edge.targetId));
  } catch {
    return new Set();
  }
}

async function cachedFacts(
  javaIndex: ProviderInput["javaIndex"],
  absolutePath: string,
  generation: number,
  cache: Map<string, JavaSourceFacts | undefined>
): Promise<JavaSourceFacts | undefined> {
  if (cache.has(absolutePath)) {
    return cache.get(absolutePath);
  }
  try {
    const facts = await javaIndex.factsFor(absolutePath, generation);
    cache.set(absolutePath, facts);
    return facts;
  } catch {
    cache.set(absolutePath, undefined);
    return undefined;
  }
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

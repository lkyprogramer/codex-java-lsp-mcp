// input: The subset static-provider verified via typeGraph/typeReference.
// output: ProviderOutcome carrying exact call/method-relation/structural-pairing EvidenceSignal[].
// pos: Task 25 production relationship-evidence provider. Relationship strength
//      extraction is isolated from final ranking in relationship-deltas.ts.
import type { CandidateFile, ResolvedAnchor } from "../../agent-types.js";
import type { FrameworkCallSite, FrameworkFileFacts, FrameworkMethodDeclaration, FrameworkTypeRef } from "../../java-index/framework-index-view.js";
import {
  MAX_FACTS_FOR_FILES,
  type FactsForFileItem,
  type JavaMethodFact,
  type JavaSourceFacts
} from "../../java-index/router-facts.js";
import type { EvidenceFamily, EvidenceProvenance, EvidenceSignal, ProviderInput, ProviderOutcome } from "../evidence.js";
import { JavaIntelligenceError } from "../../runtime/intelligence-error.js";
import { candidateFromFacts } from "../candidate-helpers.js";
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

const MAX_DIRECT_CALL_TARGETS = 12;
const MAX_IMPLEMENTATION_CONTINUATION_CALL_TARGETS = 32;
const MAX_SAME_OWNER_HELPERS = 4;
const MAX_HELPER_CONTINUATION_CALL_TARGETS = 12;
// The static type graph already nominates exact implementations. Prefer that
// evidence and keep the import/reference fallback tiny: parsing a wide
// lexical candidate pool just to prove one dynamic-dispatch hop turns a cold
// request's first relationship check into unbounded foreground work.
const MAX_IMPLEMENTATION_CONTINUATION_SOURCES = 4;

type AnchoredFrameworkMethod = {
  readonly facts: FrameworkFileFacts;
  readonly method: FrameworkMethodDeclaration;
};

type SignatureCandidates = {
  readonly candidates: Map<string, CandidateFile>;
  /** Whether parsed framework facts were available to authoritatively project the method signature. */
  readonly available: boolean;
};

const EXACT_TYPE_RESOLUTION_STRATEGIES = new Set([
  "QUALIFIED",
  "EXPLICIT_IMPORT",
  "SAME_PACKAGE",
  "ENCLOSING_TYPE",
  "JAVA_LANG"
]);
// A wildcard import is not generally strong enough for signatures or
// framework declarations.  For a receiver call, though, the resolver emits
// WILDCARD_IMPORT only after it found exactly one repository declaration
// under all applicable wildcard packages. The later target-method check keeps
// this a bounded declaration fact rather than a spelling-based fallback.
const UNIQUE_REPOSITORY_RECEIVER_STRATEGIES = new Set([
  ...EXACT_TYPE_RESOLUTION_STRATEGIES,
  "WILDCARD_IMPORT"
]);

type DirectCallSpec = {
  readonly targetFqn: string;
  readonly methodName: string;
  readonly arity: number;
  /** One FQN per argument when local AST facts can determine it. */
  readonly argumentTypeFqns: readonly (string | undefined)[];
  readonly range: FrameworkCallSite["range"];
  readonly callDepth: number;
  /** A declared anchor field is a collaborator boundary, ahead of local/parameter value calls when the direct-call cap binds. */
  readonly fieldReceiver: boolean;
};

type DirectCallCandidate = {
  readonly candidate: CandidateFile;
  readonly callDepth: number;
  readonly callOrigin: "anchor" | "implementation" | "helper";
};

type RelationshipBundleCallees = ReadonlyMap<string, {
  readonly targets: ReadonlySet<string>;
  readonly truncated: boolean;
}>;

type RelationshipFactsBatch = {
  readonly cache: Map<string, JavaSourceFacts | undefined>;
  readonly degradedReasons: readonly string[];
  readonly deadlineExceeded: boolean;
  readonly cancelled: boolean;
  readonly partial: boolean;
  readonly bundleCallees?: RelationshipBundleCallees;
};

export async function collectRelationshipEvidence(input: RelationshipProviderInput): Promise<ProviderOutcome> {
  const startedAt = Date.now();
  if (input.budget?.expired()) {
    return {
      providerId: RELATIONSHIP_PROVIDER_ID,
      providerVersion: RELATIONSHIP_PROVIDER_VERSION,
      evidence: [],
      completion: "PARTIAL_TIMEOUT",
      elapsedMs: Date.now() - startedAt,
      degradation: "relationship DEADLINE_EXCEEDED"
    };
  }
  const evidence: EvidenceSignal[] = [];
  const failedAnchors: string[] = [];
  let legacyTerminal: "DEADLINE_EXCEEDED" | "CANCELLED" | undefined;
  const batch = await preloadRelationshipFacts(input);
  // A request deadline/cancellation is terminal for foreground JavaIndex work.
  // Keep any evidence already materialized by earlier stages, but do not issue
  // framework/definition/facts calls after the batch reports a terminal state.
  if (!batch?.deadlineExceeded && !batch?.cancelled) {
    for (const anchor of input.anchors) {
      if (input.budget?.expired()) {
        legacyTerminal = "DEADLINE_EXCEEDED";
        break;
      }
      try {
        evidence.push(...await collectRelationshipEvidenceForAnchor(
          input,
          anchor,
          batch?.cache,
          batch?.bundleCallees
        ));
        if (input.budget?.expired()) {
          legacyTerminal = "DEADLINE_EXCEEDED";
          break;
        }
      } catch (error) {
        const terminal = relationshipTerminalCode(error);
        if (terminal) {
          legacyTerminal = terminal;
          break;
        }
        failedAnchors.push(anchor.id);
      }
    }
  }
  const cancelled = batch?.cancelled || legacyTerminal === "CANCELLED";
  const deadlineExceeded = batch?.deadlineExceeded || legacyTerminal === "DEADLINE_EXCEEDED";
  const completion = failedAnchors.length > 0
    ? "FAILED"
    : cancelled
      ? "CANCELLED"
      : deadlineExceeded
        ? "PARTIAL_TIMEOUT"
        : batch?.partial
          ? "PARTIAL_LIMIT"
          : "COMPLETE";
  const degradation = [
    ...(failedAnchors.length === 0 ? [] : [`relationship failed for anchors: ${failedAnchors.join(", ")}`]),
    ...(batch?.degradedReasons ?? []),
    ...(legacyTerminal ? [`relationship ${legacyTerminal}`] : [])
  ].join("; ");
  return {
    providerId: RELATIONSHIP_PROVIDER_ID,
    providerVersion: RELATIONSHIP_PROVIDER_VERSION,
    evidence,
    completion,
    elapsedMs: Date.now() - startedAt,
    ...(degradation ? { degradation } : {})
  };
}

async function preloadRelationshipFacts(input: RelationshipProviderInput): Promise<RelationshipFactsBatch | undefined> {
  if (input.budget?.expired()) {
    return {
      cache: new Map(),
      degradedReasons: ["relationship facts DEADLINE_EXCEEDED"],
      deadlineExceeded: true,
      cancelled: false,
      partial: true
    };
  }
  return preloadRelationshipFactsLegacy(input);
}

async function preloadRelationshipFactsLegacy(input: RelationshipProviderInput): Promise<RelationshipFactsBatch | undefined> {
  if (!input.javaIndex.factsForFiles) {
    return undefined;
  }
  const allPaths = uniquePaths([
    ...input.anchors.map(anchor => anchor.absolutePath),
    ...input.staticVerifiedCandidates
      .map(candidate => candidate.absolutePath)
      .filter(candidatePath => candidatePath.endsWith(".java"))
  ]);
  const selectedPaths = allPaths.slice(0, MAX_FACTS_FOR_FILES);
  const cache = new Map<string, JavaSourceFacts | undefined>();
  for (const absolutePath of allPaths.slice(MAX_FACTS_FOR_FILES)) cache.set(absolutePath, undefined);
  const degradedReasons: string[] = [];
  if (allPaths.length > MAX_FACTS_FOR_FILES) {
    degradedReasons.push(`relationship facts truncated at ${MAX_FACTS_FOR_FILES} files`);
  }
  try {
    const result = await input.javaIndex.factsForFiles(selectedPaths, input.generation);
    let deadlineExceeded = false;
    let cancelled = false;
    for (let index = 0; index < selectedPaths.length; index += 1) {
      const absolutePath = selectedPaths[index]!;
      const item = result.items[index];
      if (item?.state === "FOUND") {
        cache.set(absolutePath, item.facts);
        continue;
      }
      cache.set(absolutePath, undefined);
      const reason = item?.state === "DEGRADED" ? item.reason : (item?.state === "MISSING" ? item.reason : "INDEX_INCOMPLETE");
      if (reason === "DEADLINE_EXCEEDED") deadlineExceeded = true;
      else if (reason === "CANCELLED") cancelled = true;
      degradedReasons.push(`relationship facts ${reason}`);
    }
    return {
      cache,
      degradedReasons: uniquePaths(degradedReasons),
      deadlineExceeded,
      cancelled,
      partial: allPaths.length > MAX_FACTS_FOR_FILES || result.completion !== "COMPLETE" || result.truncated
    };
  } catch (error) {
    return factsBatchFromQueryFailure(selectedPaths, error, degradedReasons);
  }
}

function factsBatchFromQueryFailure(
  selectedPaths: readonly string[],
  error: unknown,
  extraReasons: readonly string[] = []
): RelationshipFactsBatch {
  const cache = new Map<string, JavaSourceFacts | undefined>();
  for (const absolutePath of selectedPaths) cache.set(absolutePath, undefined);
  const reason = error instanceof JavaIntelligenceError
    && (error.code === "DEADLINE_EXCEEDED" || error.code === "CANCELLED")
    ? error.code
    : "QUERY_FAILED";
  return {
    cache,
    degradedReasons: [...extraReasons, `relationship facts ${reason}`],
    deadlineExceeded: reason === "DEADLINE_EXCEEDED",
    cancelled: reason === "CANCELLED",
    partial: true
  };
}

function relationshipTerminalCode(error: unknown): "DEADLINE_EXCEEDED" | "CANCELLED" | undefined {
  if (!(error instanceof JavaIntelligenceError)) return undefined;
  return error.code === "DEADLINE_EXCEEDED" || error.code === "CANCELLED" ? error.code : undefined;
}

function rethrowRelationshipTerminal(error: unknown): void {
  if (relationshipTerminalCode(error)) throw error;
}

function throwIfRelationshipBudgetExpired(input: RelationshipProviderInput): void {
  if (input.budget?.expired()) {
    throw new JavaIntelligenceError("DEADLINE_EXCEEDED", "relationship provider request budget exhausted");
  }
}

async function collectRelationshipEvidenceForAnchor(
  input: RelationshipProviderInput,
  anchor: ResolvedAnchor,
  preloadedFacts?: Map<string, JavaSourceFacts | undefined>,
  bundleCallees?: RelationshipBundleCallees
): Promise<EvidenceSignal[]> {
  let anchorFacts: JavaSourceFacts | undefined;
  if (preloadedFacts?.has(anchor.absolutePath)) {
    anchorFacts = preloadedFacts.get(anchor.absolutePath);
  } else {
    try {
      anchorFacts = await input.javaIndex.factsFor(anchor.absolutePath, input.generation);
    } catch (error) {
      rethrowRelationshipTerminal(error);
      anchorFacts = undefined;
    }
  }
  throwIfRelationshipBudgetExpired(input);
  const factsCache = preloadedFacts ?? new Map<string, JavaSourceFacts | undefined>();
  const methodCache = new Map<string, JavaMethodFact | undefined>();
  if (anchorFacts) {
    factsCache.set(anchor.absolutePath, anchorFacts);
  }

  const evidence: EvidenceSignal[] = [];
  const legacyAnchorFallbackAllowed = preloadedFacts === undefined;
  const resolvedCallTargets = anchorFacts || legacyAnchorFallbackAllowed
    ? await resolvedAnchorCallTargets(input, anchor, methodCache, bundleCallees)
    : new Set<string>();
  throwIfRelationshipBudgetExpired(input);
  const anchoredFrameworkMethod = await loadAnchoredFrameworkMethod(input, anchor);
  throwIfRelationshipBudgetExpired(input);
  const directCallCandidates = await resolvedDirectCallCandidates(input, anchoredFrameworkMethod);
  throwIfRelationshipBudgetExpired(input);
  const implementationCallCandidates = await resolvedImplementationCallCandidates(input, anchoredFrameworkMethod);
  throwIfRelationshipBudgetExpired(input);
  const helperCallCandidates = await resolvedSameOwnerHelperCallCandidates(input, anchoredFrameworkMethod);
  throwIfRelationshipBudgetExpired(input);
  const callCandidates = mergeCallCandidates(
    directCallCandidates,
    implementationCallCandidates,
    helperCallCandidates
  );
  const signatureCandidates = await resolvedSignatureCandidates(input, anchoredFrameworkMethod);
  throwIfRelationshipBudgetExpired(input);
  const candidates = new Map(input.staticVerifiedCandidates.map(candidate => [candidate.absolutePath, candidate]));
  const staticVerifiedPaths = new Set(candidates.keys());
  for (const directCall of callCandidates.values()) {
    candidates.set(directCall.candidate.absolutePath, directCall.candidate);
  }
  for (const signatureCandidate of signatureCandidates.candidates.values()) {
    candidates.set(signatureCandidate.absolutePath, signatureCandidate);
  }

  for (const candidate of candidates.values()) {
    throwIfRelationshipBudgetExpired(input);
    const directCall = callCandidates.get(candidate.absolutePath);
    if (directCall) {
      pushIfPositive(evidence, input, anchor.id, candidate, "CALLS", 120, directCall.callDepth, directCall.callOrigin);
    } else if (resolvedCallTargets.size > 0) {
      const candidateFacts = await cachedFacts(input.javaIndex, candidate.absolutePath, input.generation, factsCache);
      if (candidateFacts?.methods.some(method => method.methodId && resolvedCallTargets.has(method.methodId))) {
        // resolvedCallees is the index's exact edge from the anchored method.
        // It lacks expression nesting, but it is not an unknown/deep call:
        // represent it as the direct anchor hop so it retains the same
        // protected-core eligibility as the AST re-evaluation path.
        preferResolvedCallPositions(candidate, candidateFacts, resolvedCallTargets);
        pushIfPositive(evidence, input, anchor.id, candidate, "CALLS", 120, 0, "anchor");
      }
    }
    if (signatureCandidates.candidates.has(candidate.absolutePath)) {
      pushIfPositive(evidence, input, anchor.id, candidate, "METHOD_RELATION", 160);
    }
    if (!staticVerifiedPaths.has(candidate.absolutePath)) {
      continue;
    }
    // Parsed framework facts project the method declaration exactly, including
    // generic return arguments. Do not fall back to JavaMethodFact's lossy
    // outer-wrapper relation when that projection is available: e.g.
    // ApiResponse<Result> must protect Result, not consume a slot for the
    // generic transport wrapper. The older projection remains fail-soft when
    // framework facts are unavailable.
    if (!signatureCandidates.available) {
      const methodDelta = anchorFacts || legacyAnchorFallbackAllowed
        ? await methodRelationDelta(candidate, anchor, input.javaIndex, input.generation, methodCache, factsCache)
        : 0;
      pushIfPositive(evidence, input, anchor.id, candidate, "METHOD_RELATION", methodDelta);
    }

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

  return evidence;
}

/**
 * Cold indexes parse the anchor before every imported declaration is present,
 * so the worker cannot always emit a cross-file CALLS edge on that first
 * parse. Rebuild only the missing direct edge from two parsed facts: the
 * anchor's resolved receiver type and exactly one target method with the same
 * name/arity. This is intentionally narrower than name search: unresolved or
 * wildcard receivers, unqualified calls, overloaded targets, and any
 * unparsed target stay out. Static type receivers reach this path only after
 * ast-extractor proved an unshadowed explicit import.
 */
async function loadAnchoredFrameworkMethod(
  input: RelationshipProviderInput,
  anchor: ResolvedAnchor
): Promise<AnchoredFrameworkMethod | undefined> {
  if (anchor.kind.toLowerCase() !== "method" || input.budget?.expired()) {
    return undefined;
  }
  try {
    const facts = await input.frameworkIndex.frameworkFactsFor(anchor.absolutePath, input.generation);
    if (input.budget?.expired()) return undefined;
    const method = anchoredMethod(facts, anchor);
    return method ? { facts, method } : undefined;
  } catch (error) {
    rethrowRelationshipTerminal(error);
    return undefined;
  }
}

/**
 * A method declaration's parameters and concrete generic return values are
 * direct AST collaborators. They must not depend on body-level JavaMethodFact
 * relations, which deliberately omit some parameter uses and flatten generic
 * return wrappers.
 */
async function resolvedSignatureCandidates(
  input: RelationshipProviderInput,
  anchored: AnchoredFrameworkMethod | undefined
): Promise<SignatureCandidates> {
  if (!anchored || input.budget?.expired()) {
    return { candidates: new Map(), available: false };
  }
  const typeFqns = signatureTypeFqns(anchored.method);
  if (typeFqns.length === 0) {
    return { candidates: new Map(), available: true };
  }
  try {
    const definitions = await input.javaIndex.findTypeDefinitions(typeFqns, MAX_DIRECT_CALL_TARGETS, false);
    if (input.budget?.expired()) return { candidates: new Map(), available: true };
    return {
      candidates: new Map(definitions.map(definition => [
        definition.absolutePath,
        candidateFromFacts(definition, 160, "METHOD_RELATION")
      ])),
      available: true
    };
  } catch (error) {
    rethrowRelationshipTerminal(error);
    // The anchor facts remain authoritative; failure to hydrate optional
    // collaborators should not reinstate the older, wrapper-only relation.
    return { candidates: new Map(), available: true };
  }
}

function signatureTypeFqns(method: FrameworkMethodDeclaration): string[] {
  const parameters = method.parameters.flatMap(parameter => typeRefFqns(parameter.type, true));
  // For ResponseEnvelope<Result>, the concrete Result declaration is the
  // contract collaborator. The transport envelope remains a normal candidate
  // but does not obtain a direct method-relation core reservation.
  const returns = method.returnType ? typeRefFqns(method.returnType, method.returnType.typeArguments.length === 0) : [];
  return [...new Set([...parameters, ...returns])];
}

function typeRefFqns(ref: FrameworkTypeRef, includeSelf: boolean): string[] {
  const own = includeSelf && isUniqueRepositoryTypeRef(ref) && ref.resolvedFqn ? [ref.resolvedFqn] : [];
  return [...own, ...ref.typeArguments.flatMap(argument => typeRefFqns(argument, true))];
}

function isExactTypeRef(ref: Pick<FrameworkTypeRef, "resolvedFqn" | "strategy">): boolean {
  return Boolean(ref.resolvedFqn && ref.strategy && EXACT_TYPE_RESOLUTION_STRATEGIES.has(ref.strategy));
}

function isUniqueRepositoryReceiver(ref: Pick<FrameworkTypeRef, "resolvedFqn" | "strategy">): boolean {
  return Boolean(ref.resolvedFqn && ref.strategy && UNIQUE_REPOSITORY_RECEIVER_STRATEGIES.has(ref.strategy));
}

function isUniqueRepositoryTypeRef(ref: Pick<FrameworkTypeRef, "resolvedFqn" | "strategy">): boolean {
  return isUniqueRepositoryReceiver(ref);
}

async function resolvedDirectCallCandidates(
  input: RelationshipProviderInput,
  anchored: AnchoredFrameworkMethod | undefined
): Promise<Map<string, DirectCallCandidate>> {
  if (!anchored || input.budget?.expired()) {
    return new Map();
  }
  const anchorMethod = anchored.method;
  const unresolvedSpecs = directCallSpecs(
    anchorMethod,
    MAX_DIRECT_CALL_TARGETS,
    declaredFieldReceiverNames(anchored)
  );
  if (unresolvedSpecs.length === 0) return new Map();

  let definitions: JavaSourceFacts[];
  try {
    definitions = await input.javaIndex.findTypeDefinitions(
      [...new Set(unresolvedSpecs.map(spec => spec.targetFqn))],
      MAX_DIRECT_CALL_TARGETS,
      false
    );
  } catch (error) {
    rethrowRelationshipTerminal(error);
    return new Map();
  }
  if (input.budget?.expired() || definitions.length === 0) return new Map();

  let factsByPath: FrameworkFileFacts[];
  try {
    factsByPath = await input.frameworkIndex.frameworkFactsForFiles(
      definitions.map(definition => definition.absolutePath),
      input.generation
    );
  } catch (error) {
    rethrowRelationshipTerminal(error);
    return new Map();
  }
  if (input.budget?.expired()) return new Map();

  const frameworkFactsByPath = new Map(factsByPath.map(facts => [facts.relativePath, facts]));
  const frameworkFactsByFqn = new Map<string, FrameworkFileFacts>();
  for (const facts of factsByPath) {
    for (const type of facts.types) {
      if (type.fqn && !frameworkFactsByFqn.has(type.fqn)) {
        frameworkFactsByFqn.set(type.fqn, facts);
      }
    }
  }
  const specs = resolveNestedArgumentTypes(anchorMethod, unresolvedSpecs, frameworkFactsByFqn);
  const candidates = new Map<string, DirectCallCandidate>();
  for (const definition of definitions) {
    const targetFqn = definition.qualifiedName;
    if (!targetFqn) continue;
    const matchingSpecs = specs.filter(spec => spec.targetFqn === targetFqn);
    if (matchingSpecs.length === 0) continue;
    const relativePath = definition.path;
    if (!relativePath) continue;
    const targetFacts = frameworkFactsByPath.get(relativePath);
    if (!targetFacts || !matchesUniqueDeclaredCall(targetFacts, targetFqn, matchingSpecs)) continue;
    const callDepth = Math.min(...matchingSpecs.map(spec => spec.callDepth));
    const existing = candidates.get(definition.absolutePath);
    if (!existing || callDepth < existing.callDepth) {
      candidates.set(definition.absolutePath, {
        candidate: callsCandidateFromFacts(definition, matchingSpecs, targetFacts),
        callDepth,
        callOrigin: "anchor"
      });
    }
  }
  return candidates;
}

/**
 * Follow one exact dynamic-dispatch step for an interface method anchor:
 * interface declaration -> verified concrete implementation -> receiver call
 * in the matching override. This is deliberately not a mapper heuristic.
 * Every hop is proven by resolved FQNs and a unique method signature, and the
 * continuation stops immediately on ambiguity or an unavailable declaration.
 */
async function resolvedImplementationCallCandidates(
  input: RelationshipProviderInput,
  anchored: AnchoredFrameworkMethod | undefined
): Promise<Map<string, DirectCallCandidate>> {
  if (!anchored || input.budget?.expired()) return new Map();
  const anchorType = anchored.facts.types.find(type => type.typeId === anchored.method.ownerTypeId);
  if (!anchorType?.fqn || anchorType.kind !== "interface") return new Map();

  // Candidate discovery order and provenance are deliberately not semantic
  // here: an exact implementation can arrive through importGraph before a
  // typeGraph edge is materialized. The framework projection below performs
  // the actual FQN/override validation. Keep the work bounded to candidates
  // already discovered for this request, prioritising explicit implementation
  // evidence but never requiring its incidental reason label.
  const sourcePaths = prioritizedImplementationContinuationPaths(input)
    .slice(0, MAX_IMPLEMENTATION_CONTINUATION_SOURCES);
  if (sourcePaths.length === 0) return new Map();

  let implementationFacts: FrameworkFileFacts[];
  try {
    implementationFacts = await input.frameworkIndex.frameworkFactsForFiles(sourcePaths, input.generation);
  } catch (error) {
    rethrowRelationshipTerminal(error);
    return new Map();
  }
  if (input.budget?.expired()) return new Map();

  const continuationSpecs: DirectCallSpec[] = [];
  for (const facts of implementationFacts) {
    const implementationTypeId = uniqueDirectImplementationTypeId(facts, anchorType.fqn);
    if (!implementationTypeId) continue;
    const implementationMethod = uniqueDeclaredMethod(facts, implementationTypeId, methodSpec(anchored.method));
    if (!implementationMethod) continue;
    // This call originates after one validated interface dispatch. Its raw
    // expression nesting is irrelevant to that semantic hop: Optional.of(x)
    // must not hide the resolved operation x from the read-plan core.
    continuationSpecs.push(...directCallSpecs(implementationMethod, MAX_IMPLEMENTATION_CONTINUATION_CALL_TARGETS)
      .map(spec => ({ ...spec, callDepth: 1 })));
  }
  return resolveContinuationCallCandidates(
    input,
    continuationSpecs,
    "implementation",
    MAX_IMPLEMENTATION_CONTINUATION_CALL_TARGETS
  );
}

/**
 * A same-owner unqualified/`this` helper is still the anchored method after
 * extract-method. Follow one such hop and keep only its external receivers
 * as depth-1 CALLS so they can fill leftover core slots without outranking
 * the anchor's own first-hop collaborators.
 */
async function resolvedSameOwnerHelperCallCandidates(
  input: RelationshipProviderInput,
  anchored: AnchoredFrameworkMethod | undefined
): Promise<Map<string, DirectCallCandidate>> {
  if (!anchored || input.budget?.expired()) return new Map();
  const fieldNames = declaredFieldReceiverNames(anchored);
  const continuationSpecs: DirectCallSpec[] = [];
  for (const helper of sameOwnerHelperMethods(anchored)) {
    continuationSpecs.push(...directCallSpecs(helper, MAX_HELPER_CONTINUATION_CALL_TARGETS, fieldNames)
      .map(spec => ({ ...spec, callDepth: 1 })));
  }
  return resolveContinuationCallCandidates(
    input,
    continuationSpecs,
    "helper",
    MAX_HELPER_CONTINUATION_CALL_TARGETS
  );
}

async function resolveContinuationCallCandidates(
  input: RelationshipProviderInput,
  continuationSpecs: readonly DirectCallSpec[],
  callOrigin: "implementation" | "helper",
  limit: number
): Promise<Map<string, DirectCallCandidate>> {
  const boundedSpecs = dedupeCallSpecs(continuationSpecs).slice(0, limit);
  if (boundedSpecs.length === 0 || input.budget?.expired()) return new Map();

  let definitions: JavaSourceFacts[];
  try {
    definitions = await input.javaIndex.findTypeDefinitions(
      [...new Set(boundedSpecs.map(spec => spec.targetFqn))],
      limit,
      false
    );
  } catch (error) {
    rethrowRelationshipTerminal(error);
    return new Map();
  }
  if (definitions.length === 0 || input.budget?.expired()) return new Map();

  let targetFacts: FrameworkFileFacts[];
  try {
    targetFacts = await input.frameworkIndex.frameworkFactsForFiles(
      definitions.map(definition => definition.absolutePath),
      input.generation
    );
  } catch (error) {
    rethrowRelationshipTerminal(error);
    return new Map();
  }
  if (input.budget?.expired()) return new Map();
  const targetFactsByPath = new Map(targetFacts.map(facts => [facts.relativePath, facts]));
  const candidates = new Map<string, DirectCallCandidate>();
  for (const definition of definitions) {
    const targetFqn = definition.qualifiedName;
    const relativePath = definition.path;
    if (!targetFqn || !relativePath) continue;
    const matchingSpecs = boundedSpecs.filter(spec => spec.targetFqn === targetFqn);
    if (matchingSpecs.length === 0) continue;
    const facts = targetFactsByPath.get(relativePath);
    if (!facts || !matchesImplementationContinuationTarget(facts, targetFqn, matchingSpecs)) continue;
    candidates.set(definition.absolutePath, {
      candidate: callsCandidateFromFacts(definition, matchingSpecs, facts),
      callDepth: 1,
      callOrigin
    });
  }
  return candidates;
}

function sameOwnerHelperMethods(anchored: AnchoredFrameworkMethod): FrameworkMethodDeclaration[] {
  const helpers: FrameworkMethodDeclaration[] = [];
  const seen = new Set<string>();
  for (const call of anchored.method.callSites) {
    if (!isUnqualifiedOrThisReceiver(call.receiverText)) continue;
    const matches = anchored.facts.methods.filter(method =>
      method.methodId !== anchored.method.methodId
      && method.ownerTypeId === anchored.method.ownerTypeId
      && !method.constructor
      && method.name === call.name
      && method.parameters.length === call.arity
    );
    if (matches.length !== 1) continue;
    const helper = matches[0]!;
    if (seen.has(helper.methodId)) continue;
    seen.add(helper.methodId);
    helpers.push(helper);
    if (helpers.length >= MAX_SAME_OWNER_HELPERS) break;
  }
  return helpers;
}

function isUnqualifiedOrThisReceiver(receiverText: string | undefined): boolean {
  const receiver = receiverText?.trim();
  return !receiver || receiver === "this";
}

function prioritizedImplementationContinuationPaths(input: RelationshipProviderInput): string[] {
  const anchorPaths = new Set(input.anchors.map(anchor => anchor.absolutePath));
  const priority = (candidate: CandidateFile): number => candidate.reasons.includes("typeGraph:implementation-lookup")
    ? 0
    : (candidate.verifiedBy || []).includes("typeGraph") ? 1 : 2;
  const candidates = [...input.allCandidates]
    .filter(candidate => !anchorPaths.has(candidate.absolutePath) && candidate.absolutePath.endsWith(".java"))
    .sort((left, right) => priority(left) - priority(right)
      || right.score - left.score
      || left.absolutePath.localeCompare(right.absolutePath))
    .filter((candidate, index, values) => values.findIndex(value => value.absolutePath === candidate.absolutePath) === index);
  const implementationHints = candidates.filter(candidate => priority(candidate) === 0);
  return (implementationHints.length > 0 ? implementationHints : candidates)
    .slice(0, MAX_IMPLEMENTATION_CONTINUATION_SOURCES)
    .map(candidate => candidate.absolutePath);
}

function uniqueDirectImplementationTypeId(facts: FrameworkFileFacts, anchorFqn: string): string | undefined {
  const matches = facts.types.filter(type => type.kind === "class"
    && type.implements.some(parent => isExactTypeRef(parent) && parent.resolvedFqn === anchorFqn));
  return matches.length === 1 ? matches[0]!.typeId : undefined;
}

function matchesImplementationContinuationTarget(
  facts: FrameworkFileFacts,
  targetFqn: string,
  specs: readonly DirectCallSpec[]
): boolean {
  if (matchesUniqueDeclaredCall(facts, targetFqn, specs)) return true;
  // Some repository collaborators inherit their operation from an external
  // generic base (for example a locally declared port interface extending a
  // library mapper contract). The method declaration is therefore absent
  // from our repository index, but the receiver type and the override-local
  // call are both exact. Accept only that narrow shape; a locally declared
  // ambiguous method remains rejected above.
  const targetTypes = facts.types.filter(type => type.fqn === targetFqn);
  if (targetTypes.length !== 1 || targetTypes[0]!.kind !== "interface") return false;
  const targetTypeId = targetTypes[0]!.typeId;
  return specs.some(spec => !facts.methods.some(method => method.ownerTypeId === targetTypeId
    && method.name === spec.methodName
    && method.parameters.length === spec.arity));
}

function methodSpec(method: FrameworkMethodDeclaration): DirectCallSpec {
  return {
    targetFqn: method.ownerTypeId,
    methodName: method.name,
    arity: method.parameters.length,
    argumentTypeFqns: method.parameters.map(parameter => isExactTypeRef(parameter.type) ? parameter.type.resolvedFqn : undefined),
    range: method.range,
    callDepth: 0,
    fieldReceiver: false
  };
}

function dedupeCallSpecs(specs: readonly DirectCallSpec[]): DirectCallSpec[] {
  const unique = new Map<string, DirectCallSpec>();
  for (const spec of specs) {
    const key = `${spec.targetFqn}\0${spec.methodName}\0${spec.arity}\0${spec.argumentTypeFqns.join(",")}`;
    unique.set(key, spec);
  }
  return [...unique.values()];
}

function mergeCallCandidates(
  ...sources: readonly Map<string, DirectCallCandidate>[]
): Map<string, DirectCallCandidate> {
  const merged = new Map<string, DirectCallCandidate>();
  for (const source of sources) {
    for (const [path, candidate] of source) {
      const current = merged.get(path);
      if (!current || candidate.callDepth < current.callDepth
        || (candidate.callDepth === current.callDepth && candidate.callOrigin === "anchor" && current.callOrigin !== "anchor")) {
        merged.set(path, candidate);
      }
    }
  }
  return merged;
}

function anchoredMethod(facts: FrameworkFileFacts, anchor: ResolvedAnchor): FrameworkMethodDeclaration | undefined {
  const matches = facts.methods.filter(method => method.range.start.line <= anchor.line
    && anchor.line <= method.range.end.line
    && (!anchor.methodName || method.name === anchor.methodName));
  return matches.length === 1 ? matches[0] : undefined;
}

function directCallSpecs(
  method: FrameworkMethodDeclaration,
  limit = MAX_DIRECT_CALL_TARGETS,
  declaredFieldNames: ReadonlySet<string> = new Set()
): DirectCallSpec[] {
  const specs = new Map<string, DirectCallSpec>();
  for (const call of method.callSites) {
    const targetFqn = isUniqueRepositoryReceiver(call.receiverDeclaredType || {})
      ? call.receiverDeclaredType?.resolvedFqn
      : undefined;
    if (!targetFqn) continue;
    const spec = {
      targetFqn,
      methodName: call.name,
      arity: call.arity,
      argumentTypeFqns: call.argumentTypeHints.map(argument => argument.resolvedFqn),
      range: call.range,
      callDepth: callNestingDepth(method.callSites, call.range),
      fieldReceiver: isDeclaredFieldReceiver(call.receiverText, method, declaredFieldNames)
    };
    specs.set(`${targetFqn}\0${call.name}\0${call.arity}\0${rangeKey(call.range)}`, spec);
  }
  return [...specs.values()]
    .sort((left, right) => Number(right.fieldReceiver) - Number(left.fieldReceiver)
      || left.callDepth - right.callDepth
      || rangeKey(left.range).localeCompare(rangeKey(right.range)))
    .slice(0, limit);
}

function declaredFieldReceiverNames(anchored: AnchoredFrameworkMethod): ReadonlySet<string> {
  return new Set(anchored.facts.fields
    .filter(field => field.ownerTypeId === anchored.method.ownerTypeId)
    .map(field => field.name));
}

function isDeclaredFieldReceiver(
  receiverText: string | undefined,
  method: FrameworkMethodDeclaration,
  fieldNames: ReadonlySet<string>
): boolean {
  const receiver = receiverText?.trim();
  if (!receiver) return false;
  const name = receiver.startsWith("this.") ? receiver.slice("this.".length) : receiver;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || !fieldNames.has(name)) return false;
  // A bare parameter masks a same-named field. `this.field` remains
  // unambiguous even when the parameter has that spelling.
  return receiver.startsWith("this.") || !method.parameters.some(parameter => parameter.name === name);
}

function callNestingDepth(callSites: readonly FrameworkCallSite[], range: FrameworkCallSite["range"]): number {
  return callSites.filter(call => rangeStrictlyContains(call.range, range)).length;
}

/**
 * An overloaded outer call is still exact when its sole unresolved argument
 * is the return value of one uniquely resolved nested receiver call. This is
 * deliberately a single AST containment hop: arbitrary expression typing,
 * multiple unknown arguments and ambiguous nested calls remain unresolved.
 */
function resolveNestedArgumentTypes(
  method: FrameworkMethodDeclaration,
  specs: readonly DirectCallSpec[],
  factsByFqn: ReadonlyMap<string, FrameworkFileFacts>
): DirectCallSpec[] {
  return specs.map(spec => {
    const unresolvedArgumentIndexes = spec.argumentTypeFqns
      .map((type, index) => type ? undefined : index)
      .filter((index): index is number => index !== undefined);
    if (unresolvedArgumentIndexes.length !== 1) return spec;
    const nested = immediateNestedCall(method.callSites, spec.range);
    const nestedTargetFqn = nested?.receiverDeclaredType?.resolvedFqn;
    if (!nested || !nestedTargetFqn) return spec;
    const returnedFqn = uniqueCallReturnType(factsByFqn.get(nestedTargetFqn), nestedTargetFqn, nested);
    if (!returnedFqn) return spec;
    const argumentTypeFqns = [...spec.argumentTypeFqns];
    argumentTypeFqns[unresolvedArgumentIndexes[0]!] = returnedFqn;
    return { ...spec, argumentTypeFqns };
  });
}

function immediateNestedCall(
  callSites: readonly FrameworkCallSite[],
  parentRange: FrameworkCallSite["range"]
): FrameworkCallSite | undefined {
  const nested = callSites
    .filter(call => rangeStrictlyContains(parentRange, call.range))
    .map(call => ({ call, span: rangeSpan(call.range) }))
    .sort((left, right) => right.span - left.span || rangeKey(left.call.range).localeCompare(rangeKey(right.call.range)));
  if (nested.length === 0 || (nested.length > 1 && nested[0]!.span === nested[1]!.span)) return undefined;
  return nested[0]!.call;
}

function rangeStrictlyContains(
  outer: FrameworkCallSite["range"],
  inner: FrameworkCallSite["range"]
): boolean {
  return comparePosition(outer.start, inner.start) <= 0
    && comparePosition(inner.end, outer.end) <= 0
    && rangeKey(outer) !== rangeKey(inner);
}

function comparePosition(
  left: FrameworkCallSite["range"]["start"],
  right: FrameworkCallSite["range"]["start"]
): number {
  return left.line - right.line || left.column - right.column;
}

function rangeSpan(range: FrameworkCallSite["range"]): number {
  return (range.end.line - range.start.line) * 10_000 + range.end.column - range.start.column;
}

function rangeKey(range: FrameworkCallSite["range"]): string {
  return `${range.start.line}:${range.start.column}-${range.end.line}:${range.end.column}`;
}

function callsCandidateFromFacts(
  definition: JavaSourceFacts,
  specs: readonly DirectCallSpec[],
  targetFacts?: FrameworkFileFacts
): CandidateFile {
  const names = [...new Set(specs.map(spec => spec.methodName).filter(Boolean))];
  const candidate = candidateFromFacts(
    definition,
    120,
    "CALLS",
    names.length === 1 ? { methodName: names[0] } : undefined
  );
  const positioned = uniqueCallPosition(targetFacts, definition.qualifiedName, specs);
  if (positioned) candidate.positions = [positioned];
  return candidate;
}

function uniqueCallPosition(
  facts: FrameworkFileFacts | undefined,
  targetFqn: string | undefined,
  specs: readonly DirectCallSpec[]
): { line: number; column: number } | undefined {
  if (!facts || !targetFqn) return undefined;
  const targetTypeIds = new Set(facts.types.filter(type => type.fqn === targetFqn).map(type => type.typeId));
  if (targetTypeIds.size !== 1) return undefined;
  const targetTypeId = [...targetTypeIds][0]!;
  const methods = specs
    .map(spec => uniqueDeclaredMethod(facts, targetTypeId, spec))
    .filter((method): method is NonNullable<typeof method> => method !== undefined);
  const lines = [...new Set(methods.map(method => method.range.start.line))];
  if (lines.length !== 1) return undefined;
  const method = methods[0]!;
  return { line: method.range.start.line, column: method.range.start.column };
}

function preferResolvedCallPositions(
  candidate: CandidateFile,
  facts: JavaSourceFacts,
  resolvedCallTargets: ReadonlySet<string>
): void {
  const hits = facts.methods.filter(method => method.methodId && resolvedCallTargets.has(method.methodId) && method.line >= 1);
  if (hits.length === 0) return;
  const next = hits.slice(0, 8).map(method => ({ line: method.line, column: 1 }));
  const placeholderOnly = candidate.positions.length === 0
    || candidate.positions.every(position => position.line === 1 && position.column === 1);
  candidate.positions = placeholderOnly
    ? next
    : [...candidate.positions, ...next.filter(position =>
      !candidate.positions.some(existing => existing.line === position.line && existing.column === position.column)
    )].slice(0, 8);
}

function matchesUniqueDeclaredCall(
  facts: FrameworkFileFacts,
  targetFqn: string,
  specs: readonly DirectCallSpec[]
): boolean {
  const targetTypeIds = new Set(facts.types.filter(type => type.fqn === targetFqn).map(type => type.typeId));
  if (targetTypeIds.size !== 1) return false;
  const targetTypeId = [...targetTypeIds][0]!;
  return specs.some(spec => {
    const method = uniqueDeclaredMethod(facts, targetTypeId, spec);
    return method !== undefined && isActionableCallTarget(method, spec);
  });
}

/**
 * `Envelope.success(T)`-style wrappers are syntactically resolved calls, but
 * an unknown expression passed to a type-variable-only parameter does not
 * identify a concrete collaborator. Keep it discoverable through ordinary
 * type/reference evidence; do not manufacture a high-priority cold CALLS
 * candidate that can displace the nested concrete operation. A known argument
 * type, or any non-type-variable parameter, remains fully eligible.
 */
function isActionableCallTarget(method: FrameworkMethodDeclaration, spec: DirectCallSpec): boolean {
  if (spec.argumentTypeFqns.every(type => type !== undefined)) return true;
  return method.parameters.some(parameter => !isTypeVariableRef(parameter.type));
}

function isTypeVariableRef(ref: FrameworkMethodDeclaration["parameters"][number]["type"]): boolean {
  return ref.resolvedFqn === undefined && ref.typeArguments.length === 0 && /^[A-Z][A-Za-z0-9_]*$/.test(ref.text);
}

function uniqueCallReturnType(
  facts: FrameworkFileFacts | undefined,
  targetFqn: string,
  call: FrameworkCallSite
): string | undefined {
  if (!facts) return undefined;
  const targetTypeIds = new Set(facts.types.filter(type => type.fqn === targetFqn).map(type => type.typeId));
  if (targetTypeIds.size !== 1) return undefined;
  const method = uniqueDeclaredMethod(facts, [...targetTypeIds][0]!, {
    targetFqn,
    methodName: call.name,
    arity: call.arity,
    argumentTypeFqns: call.argumentTypeHints.map(argument => argument.resolvedFqn),
    range: call.range,
    callDepth: 0,
    fieldReceiver: false
  });
  return method?.returnType?.resolvedFqn;
}

function uniqueDeclaredMethod(
  facts: FrameworkFileFacts,
  targetTypeId: string,
  spec: DirectCallSpec
): FrameworkMethodDeclaration | undefined {
  const candidates = facts.methods.filter(method => method.ownerTypeId === targetTypeId
    && method.name === spec.methodName
    && method.parameters.length === spec.arity);
  if (candidates.length === 1) return candidates[0];
  if (!spec.argumentTypeFqns.every((type): type is string => type !== undefined)) return undefined;
  const exactSignature = candidates.filter(method => method.parameters.every((parameter, index) =>
    parameter.type.resolvedFqn === spec.argumentTypeFqns[index]));
  return exactSignature.length === 1 ? exactSignature[0] : undefined;
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
  methodCache: Map<string, JavaMethodFact | undefined>,
  bundleCallees?: RelationshipBundleCallees
): Promise<ReadonlySet<string>> {
  const bundled = bundleCallees?.get(anchor.id);
  if (bundled) {
    return bundled.truncated ? new Set() : bundled.targets;
  }
  if (!input.javaIndex.resolvedCallees || input.budget?.expired()) {
    return new Set();
  }
  const key = `${anchor.absolutePath}:${anchor.line}`;
  let method = methodCache.get(key);
  if (!methodCache.has(key)) {
    try {
      method = await input.javaIndex.methodAt(anchor.absolutePath, anchor.line, input.generation);
      methodCache.set(key, method);
    } catch (error) {
      rethrowRelationshipTerminal(error);
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
  } catch (error) {
    rethrowRelationshipTerminal(error);
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
  } catch (error) {
    rethrowRelationshipTerminal(error);
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
  weight: number,
  callDepth?: number,
  callOrigin?: "anchor" | "implementation" | "helper"
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
    ...(callDepth === undefined ? {} : { callDepth }),
    ...(callOrigin === undefined ? {} : { callOrigin }),
    positions: candidate.positions,
    providerId: RELATIONSHIP_PROVIDER_ID,
    providerVersion: RELATIONSHIP_PROVIDER_VERSION,
    generation: input.generation,
    candidateMetadata: {
      categories: [policy.family === "FRAMEWORK" ? "framework" : "semantic"],
      reasons: [kind],
      verifiedBy: [kind],
      matchCount: 0
    }
  });
}

function uniquePaths(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

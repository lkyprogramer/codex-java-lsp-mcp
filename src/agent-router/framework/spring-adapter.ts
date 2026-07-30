// input: FrameworkAdapterContext bound to this request's candidate files/anchors.
// output: FrameworkCollectResult carrying every Spring evidence kind from plan Step 6-8
//         (SPRING_INJECTION, SPRING_CALL_PATH, SPRING_REQUEST_BODY, SPRING_RESPONSE_TYPE,
//         SPRING_PUBLISHES_EVENT, SPRING_CONSUMES_EVENT, SPRING_BEAN_PRODUCES) plus endpoint/
//         transactional metadata (never a candidate file by itself).
// pos: Task 27 Slice D, second commit. NOT YET registered into FRAMEWORK_ADAPTERS
//      (providers/framework-provider.ts still exports an empty array) - registration is a
//      separate, trivially-revertable commit once this is proven end-to-end through the runner.
import path from "node:path";
import type { CandidateFile } from "../../agent-types.js";
import { classifyPath } from "../../repo-layout.js";
import { breakdown, mergeCandidate } from "../candidate-helpers.js";
import type { EvidenceCompleteness, EvidenceSignal } from "../evidence.js";
import type { FrameworkMethodDeclaration, FrameworkTypeRef } from "../../java-index/framework-index-view.js";
import type { TypeResolutionStrategy } from "../../java-index/index-types.js";
import type { FrameworkAdapter, FrameworkAdapterContext, FrameworkCollectResult } from "./adapter.js";
import {
  hasAnnotation,
  hasAnySpringAnnotation,
  isStereotype,
  SPRING_AUTOWIRED_FQN,
  SPRING_BEAN_FQN,
  SPRING_EVENT_LISTENER_FQN,
  SPRING_REQUEST_BODY_FQN,
  SPRING_TRANSACTIONAL_FQN
} from "./spring-annotations.js";
import { composeEndpointFact, mappingOf, type SpringEndpointFact } from "./spring-endpoint.js";

export const SPRING_ADAPTER_ID = "spring";
export const SPRING_ADAPTER_VERSION = "2";

const BUILD_MARKER_PATHS = ["pom.xml", "build.gradle", "build.gradle.kts"];
const SPRING_DEPENDENCY_PATTERN = /org\.springframework|spring-boot/;

// Plan Step 9's initial weights table.
const SPRING_INJECTION_WEIGHT = 90;
const SPRING_CALL_PATH_WEIGHT = 100;
const SPRING_REQUEST_BODY_WEIGHT = 70;
const SPRING_RESPONSE_TYPE_WEIGHT = 70;
const SPRING_PUBLISHES_EVENT_WEIGHT = 85;
const SPRING_CONSUMES_EVENT_WEIGHT = 85;
const SPRING_BEAN_PRODUCES_WEIGHT = 75;

const CALLEES_LIMIT = 80;

export type SpringAdapterMetadata = {
  endpoints: SpringEndpointFact[];
  /** methodIds annotated @Transactional - plan Step 8: "metadata signal on method/type, not a candidate file by itself". */
  transactionalMethodIds: string[];
};

// Plan Step 6: a QUALIFIED/EXPLICIT_IMPORT/SAME_PACKAGE/ENCLOSING_TYPE/JAVA_LANG
// resolution is "resolved" - the flat base confidence applies. WILDCARD_IMPORT/
// REPO_UNIQUE_SIMPLE_NAME are the "wildcard/global fallback" strategies the plan
// discounts by their own resolution confidence x 0.95 instead. Reused for every
// rule below keyed off a resolved FrameworkTypeRef, not just injection - the
// plan gives explicit numbers only for injection, so every other resolved-type
// rule shares injection's @Autowired-field baseline (0.95) as "a resolved type
// reference, no stronger claim than that".
const FALLBACK_STRATEGY_CONFIDENCE: Partial<Record<TypeResolutionStrategy, number>> = {
  WILDCARD_IMPORT: 0.82,
  REPO_UNIQUE_SIMPLE_NAME: 0.75
};
const RESOLVED_TYPE_BASE_CONFIDENCE = 0.95;

function typeRefConfidence(type: FrameworkTypeRef, resolvedBaseConfidence: number): number {
  const fallback = type.strategy ? FALLBACK_STRATEGY_CONFIDENCE[type.strategy] : undefined;
  return fallback !== undefined ? fallback * 0.95 : resolvedBaseConfidence;
}

/**
 * detect(): per plan Step 3, activate on a build dependency OR a resolved
 * Spring annotation - never on naming alone (a class named "...Service" must
 * not be enough). The annotation check reads only this request's anchors,
 * not every candidate file, so an inactive/no-Spring repo's isActive() stays
 * cheap regardless of how many candidates earlier providers discovered.
 */
async function isActive(context: FrameworkAdapterContext): Promise<boolean> {
  const markers = await context.frameworkIndex.repositoryMarkers(BUILD_MARKER_PATHS);
  for (const content of markers.values()) {
    if (SPRING_DEPENDENCY_PATTERN.test(content)) return true;
  }
  for (const anchor of context.anchors) {
    const facts = await context.frameworkIndex.frameworkFactsFor(anchor.absolutePath, context.generation);
    if (facts.types.some(t => hasAnySpringAnnotation(t.annotations))) return true;
    if (facts.methods.some(m => hasAnySpringAnnotation(m.annotations))) return true;
    if (facts.fields.some(f => hasAnySpringAnnotation(f.annotations))) return true;
  }
  return false;
}

type SpringEvidenceKind =
  | "SPRING_INJECTION"
  | "SPRING_CALL_PATH"
  | "SPRING_REQUEST_BODY"
  | "SPRING_RESPONSE_TYPE"
  | "SPRING_PUBLISHES_EVENT"
  | "SPRING_CONSUMES_EVENT"
  | "SPRING_BEAN_PRODUCES";

/**
 * One rankable fact awaiting a target-id -> file resolution. `targetId` is
 * either a "type:<fqn>" (every rule but call-path) or a raw methodId
 * (call-path) - declarationsById resolves both through the same batched
 * call, so this list never needs to distinguish them until the final lookup.
 */
type PendingEvidence = {
  kind: SpringEvidenceKind;
  sourceFile: string;
  targetId: string;
  weight: number;
  confidence: number;
  detail: string;
};

function injectingConstructorOf(ownMethods: readonly FrameworkMethodDeclaration[]): FrameworkMethodDeclaration | undefined {
  const constructors = ownMethods.filter(m => m.constructor);
  const autowiredConstructors = constructors.filter(c => hasAnnotation(c.annotations, SPRING_AUTOWIRED_FQN));
  // Plan Step 6: exactly-one-@Autowired-constructor takes priority; a single
  // constructor is only implicit injection when nothing is explicitly
  // annotated (an @Autowired constructor among several overloads is the
  // disambiguation signal, not "there is one ctor").
  if (autowiredConstructors.length === 1) return autowiredConstructors[0];
  if (autowiredConstructors.length === 0 && constructors.length === 1) return constructors[0];
  return undefined;
}

async function collect(context: FrameworkAdapterContext): Promise<FrameworkCollectResult> {
  const startedAt = Date.now();
  const status = await context.frameworkIndex.frameworkStatus();
  const completeness: EvidenceCompleteness =
    status.coverage === "complete" ? "COMPLETE" : status.coverage === "degraded" ? "UNKNOWN" : "PARTIAL";

  const pending: PendingEvidence[] = [];
  const endpoints: SpringEndpointFact[] = [];
  const transactionalMethodIds: string[] = [];
  const diagnostics: string[] = [];
  let anyCalleesTruncated = false;

  for (const absolutePath of context.candidateFiles) {
    const facts = await context.frameworkIndex.frameworkFactsFor(absolutePath, context.generation);

    for (const type of facts.types) {
      const ownMethods = facts.methods.filter(m => m.ownerTypeId === type.typeId);
      const ownFields = facts.fields.filter(f => f.ownerTypeId === type.typeId);
      const classMapping = mappingOf(type.annotations);
      const stereotype = isStereotype(type.annotations);

      if (stereotype) {
        const injectingConstructor = injectingConstructorOf(ownMethods);
        for (const param of injectingConstructor?.parameters ?? []) {
          if (!param.type.resolvedFqn) continue; // ambiguous/unresolved - no exact signal
          pending.push({
            kind: "SPRING_INJECTION",
            sourceFile: absolutePath,
            targetId: `type:${param.type.resolvedFqn}`,
            weight: SPRING_INJECTION_WEIGHT,
            confidence: typeRefConfidence(param.type, 0.97),
            detail: `${type.simpleName} constructor parameter`
          });
        }
        for (const field of ownFields.filter(f => hasAnnotation(f.annotations, SPRING_AUTOWIRED_FQN))) {
          if (!field.type.resolvedFqn) continue;
          pending.push({
            kind: "SPRING_INJECTION",
            sourceFile: absolutePath,
            targetId: `type:${field.type.resolvedFqn}`,
            weight: SPRING_INJECTION_WEIGHT,
            confidence: typeRefConfidence(field.type, 0.95),
            detail: `${type.simpleName}.${field.name} (@Autowired field)`
          });
        }

        for (const method of ownMethods) {
          const { callees, truncated } = await context.frameworkIndex.resolvedCallees(method.methodId, CALLEES_LIMIT);
          if (truncated) anyCalleesTruncated = true;
          const callsEdges = callees.filter(c => c.kind === "CALLS");
          // Plan: "only because AST call resolves" - a method with more than
          // one resolved call has no single "the" call path to report, and a
          // possibly-truncated batch cannot be trusted to be "exactly one"
          // even when it looks that way.
          if (!truncated && callsEdges.length === 1) {
            pending.push({
              kind: "SPRING_CALL_PATH",
              sourceFile: absolutePath,
              targetId: callsEdges[0]!.targetId,
              weight: SPRING_CALL_PATH_WEIGHT,
              confidence: callsEdges[0]!.confidence,
              detail: `${type.simpleName}.${method.name}() call path`
            });
          }
          // ApplicationEventPublisher has no repo-visible receiver type in
          // FrameworkCallSite (Slice B does not project receiverDeclaredType)
          // - scoping to a stereotype's own call sites is this rule's
          // conservative substitute for confirming the receiver is actually
          // the injected publisher, matching the plan's own unchecked example.
          for (const callSite of method.callSites) {
            if (callSite.name !== "publishEvent" || callSite.arity !== 1) continue;
            const eventType = callSite.argumentTypeHints[0];
            if (!eventType?.resolvedFqn) continue;
            pending.push({
              kind: "SPRING_PUBLISHES_EVENT",
              sourceFile: absolutePath,
              targetId: `type:${eventType.resolvedFqn}`,
              weight: SPRING_PUBLISHES_EVENT_WEIGHT,
              confidence: typeRefConfidence(eventType, RESOLVED_TYPE_BASE_CONFIDENCE),
              detail: `${type.simpleName}.${method.name}() publishes event`
            });
          }
        }
      }

      for (const method of ownMethods) {
        const methodMapping = mappingOf(method.annotations);
        if (methodMapping) {
          endpoints.push(composeEndpointFact(method.methodId, classMapping, methodMapping));
          if (method.returnType?.resolvedFqn) {
            pending.push({
              kind: "SPRING_RESPONSE_TYPE",
              sourceFile: absolutePath,
              targetId: `type:${method.returnType.resolvedFqn}`,
              weight: SPRING_RESPONSE_TYPE_WEIGHT,
              confidence: typeRefConfidence(method.returnType, RESOLVED_TYPE_BASE_CONFIDENCE),
              detail: `${type.simpleName}.${method.name}() response type`
            });
          }
        }

        const requestBodyParam = method.parameters.find(p => hasAnnotation(p.annotations, SPRING_REQUEST_BODY_FQN));
        if (requestBodyParam?.type.resolvedFqn) {
          pending.push({
            kind: "SPRING_REQUEST_BODY",
            sourceFile: absolutePath,
            targetId: `type:${requestBodyParam.type.resolvedFqn}`,
            weight: SPRING_REQUEST_BODY_WEIGHT,
            confidence: typeRefConfidence(requestBodyParam.type, RESOLVED_TYPE_BASE_CONFIDENCE),
            detail: `${type.simpleName}.${method.name}() @RequestBody`
          });
        }

        if (hasAnnotation(method.annotations, SPRING_TRANSACTIONAL_FQN)) {
          transactionalMethodIds.push(method.methodId);
        }

        if (hasAnnotation(method.annotations, SPRING_BEAN_FQN) && method.returnType?.resolvedFqn) {
          pending.push({
            kind: "SPRING_BEAN_PRODUCES",
            sourceFile: absolutePath,
            targetId: `type:${method.returnType.resolvedFqn}`,
            weight: SPRING_BEAN_PRODUCES_WEIGHT,
            confidence: typeRefConfidence(method.returnType, RESOLVED_TYPE_BASE_CONFIDENCE),
            detail: `@Bean ${type.simpleName}.${method.name}()`
          });
        }

        if (hasAnnotation(method.annotations, SPRING_EVENT_LISTENER_FQN)) {
          const eventType = method.parameters[0]?.type;
          if (eventType?.resolvedFqn) {
            pending.push({
              kind: "SPRING_CONSUMES_EVENT",
              sourceFile: absolutePath,
              targetId: `type:${eventType.resolvedFqn}`,
              weight: SPRING_CONSUMES_EVENT_WEIGHT,
              confidence: typeRefConfidence(eventType, RESOLVED_TYPE_BASE_CONFIDENCE),
              detail: `${type.simpleName}.${method.name}() consumes event`
            });
          }
        }
      }
    }
  }

  // Batched, not per-item: a targetId names a type or a method, not
  // necessarily a repo file (ApplicationEventPublisher et al. are external)
  // - one declarationsById call resolves every distinct target at once, same
  // convention as findTypeDefinitions/resolvedCallees consumers elsewhere.
  const targetIds = [...new Set(pending.map(item => item.targetId))];
  const declarations = targetIds.length > 0
    ? await context.frameworkIndex.declarationsById(targetIds)
    : { types: [], methods: [], fields: [], missingIds: [], truncated: false };
  const relativePathById = new Map<string, string>();
  for (const type of declarations.types) relativePathById.set(type.typeId, type.relativePath);
  for (const method of declarations.methods) relativePathById.set(method.methodId, method.relativePath);

  const evidence: EvidenceSignal[] = [];
  const candidates = new Map<string, CandidateFile>();
  const anchorId = context.anchors[0]?.id ?? "A1";
  let signalSeq = 0;
  for (const item of pending) {
    const relativePath = relativePathById.get(item.targetId);
    if (!relativePath) continue; // external or otherwise non-repo target - no file to recommend
    const targetAbsolutePath = path.resolve(context.repoRoot, relativePath);
    signalSeq += 1;
    evidence.push({
      signalId: `${SPRING_ADAPTER_ID}:${signalSeq}`,
      candidateFile: targetAbsolutePath,
      anchorId,
      kind: item.kind,
      family: "FRAMEWORK",
      provenance: "FRAMEWORK_INFERRED",
      confidence: item.confidence,
      completeness,
      weight: item.weight,
      sourceFile: item.sourceFile,
      positions: [],
      providerId: SPRING_ADAPTER_ID,
      providerVersion: SPRING_ADAPTER_VERSION,
      generation: context.generation,
      detail: item.detail
    });
    mergeCandidate(candidates, springCandidate(context.repoRoot, targetAbsolutePath, item.weight * item.confidence, item.kind));
  }

  if (declarations.truncated) {
    diagnostics.push(`spring adapter: declarationsById truncated while resolving ${targetIds.length} evidence targets`);
  }
  if (anyCalleesTruncated) {
    diagnostics.push("spring adapter: resolvedCallees truncated for at least one Spring-managed method - SPRING_CALL_PATH skipped where truncation could hide a second target");
  }

  const metadata: SpringAdapterMetadata = { endpoints, transactionalMethodIds };

  return {
    outcome: {
      providerId: SPRING_ADAPTER_ID,
      providerVersion: SPRING_ADAPTER_VERSION,
      evidence,
      candidates: [...candidates.values()],
      completion: declarations.truncated ? "PARTIAL_LIMIT" : "COMPLETE",
      elapsedMs: Date.now() - startedAt
    },
    metadata,
    diagnostics
  };
}

function springCandidate(repoRoot: string, absolutePath: string, score: number, kind: SpringEvidenceKind): CandidateFile {
  const context = classifyPath(repoRoot, absolutePath);
  return {
    absolutePath,
    path: context.relativePath,
    module: context.module,
    layer: context.layer,
    sourceSet: context.sourceSet,
    score,
    matchCount: 0,
    positions: [],
    categories: ["framework"],
    reasons: [kind],
    confidence: "high",
    verifiedBy: [kind],
    scoreBreakdown: [breakdown(`evidence.${kind}`, "policy", score, `Spring ${kind}`)]
  };
}

export const springAdapter: FrameworkAdapter = {
  id: SPRING_ADAPTER_ID,
  version: SPRING_ADAPTER_VERSION,
  isActive,
  collect
};

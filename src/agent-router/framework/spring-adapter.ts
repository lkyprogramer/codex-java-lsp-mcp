// input: FrameworkAdapterContext bound to this request's candidate files/anchors.
// output: FrameworkCollectResult carrying SPRING_INJECTION evidence (constructor parameter /
//         @Autowired field injection into a stereotype-annotated component).
// pos: Task 27 Slice D, first commit - detection + injection only. Call-path/endpoint/event/bean
//      rules land in a second commit once this is proven end-to-end through the runner.
import path from "node:path";
import type { CandidateFile } from "../../agent-types.js";
import { classifyPath } from "../../repo-layout.js";
import { breakdown, mergeCandidate } from "../candidate-helpers.js";
import type { EvidenceCompleteness, EvidenceSignal } from "../evidence.js";
import type { FrameworkTypeRef } from "../../java-index/framework-index-view.js";
import type { TypeResolutionStrategy } from "../../java-index/index-types.js";
import type { FrameworkAdapter, FrameworkAdapterContext, FrameworkCollectResult } from "./adapter.js";
import { hasAnnotation, hasAnySpringAnnotation, isStereotype } from "./spring-annotations.js";

export const SPRING_ADAPTER_ID = "spring";
export const SPRING_ADAPTER_VERSION = "1";

const BUILD_MARKER_PATHS = ["pom.xml", "build.gradle", "build.gradle.kts"];
const SPRING_DEPENDENCY_PATTERN = /org\.springframework|spring-boot/;
const AUTOWIRED_FQN = "org.springframework.beans.factory.annotation.Autowired";

const SPRING_INJECTION_WEIGHT = 90;

// Plan Step 6: a QUALIFIED/EXPLICIT_IMPORT/SAME_PACKAGE/ENCLOSING_TYPE/JAVA_LANG
// resolution is "resolved" - the flat 0.97/0.95 base applies. WILDCARD_IMPORT/
// REPO_UNIQUE_SIMPLE_NAME are the "wildcard/global fallback" strategies the plan
// discounts by their own resolution confidence x 0.95 instead.
const FALLBACK_STRATEGY_CONFIDENCE: Partial<Record<TypeResolutionStrategy, number>> = {
  WILDCARD_IMPORT: 0.82,
  REPO_UNIQUE_SIMPLE_NAME: 0.75
};

function injectionConfidence(type: FrameworkTypeRef, resolvedBaseConfidence: number): number {
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

type PendingInjection = {
  sourceFile: string;
  sourceTypeSimpleName: string;
  targetFqn: string;
  detail: string;
  confidence: number;
};

async function collect(context: FrameworkAdapterContext): Promise<FrameworkCollectResult> {
  const startedAt = Date.now();
  const status = await context.frameworkIndex.frameworkStatus();
  const completeness: EvidenceCompleteness =
    status.coverage === "complete" ? "COMPLETE" : status.coverage === "degraded" ? "UNKNOWN" : "PARTIAL";

  const pending: PendingInjection[] = [];
  for (const absolutePath of context.candidateFiles) {
    const facts = await context.frameworkIndex.frameworkFactsFor(absolutePath, context.generation);
    for (const type of facts.types) {
      if (!isStereotype(type.annotations)) continue;
      const ownMethods = facts.methods.filter(m => m.ownerTypeId === type.typeId);
      const constructors = ownMethods.filter(m => m.constructor);
      const autowiredConstructors = constructors.filter(c => hasAnnotation(c.annotations, AUTOWIRED_FQN));
      // Plan Step 6: exactly-one-@Autowired-constructor takes priority; a
      // single constructor is only implicit injection when nothing is
      // explicitly annotated (an @Autowired constructor among several
      // overloads is the disambiguation signal, not "there is one ctor").
      const injectingConstructor = autowiredConstructors.length === 1
        ? autowiredConstructors[0]
        : (autowiredConstructors.length === 0 && constructors.length === 1 ? constructors[0] : undefined);

      for (const param of injectingConstructor?.parameters ?? []) {
        if (!param.type.resolvedFqn) continue; // ambiguous/unresolved - no exact signal
        pending.push({
          sourceFile: absolutePath,
          sourceTypeSimpleName: type.simpleName,
          targetFqn: param.type.resolvedFqn,
          detail: `${type.simpleName} constructor parameter`,
          confidence: injectionConfidence(param.type, 0.97)
        });
      }

      const autowiredFields = facts.fields.filter(
        f => f.ownerTypeId === type.typeId && hasAnnotation(f.annotations, AUTOWIRED_FQN)
      );
      for (const field of autowiredFields) {
        if (!field.type.resolvedFqn) continue;
        pending.push({
          sourceFile: absolutePath,
          sourceTypeSimpleName: type.simpleName,
          targetFqn: field.type.resolvedFqn,
          detail: `${type.simpleName}.${field.name} (@Autowired field)`,
          confidence: injectionConfidence(field.type, 0.95)
        });
      }
    }
  }

  // Batched, not per-injection: resolvedFqn names a type, not necessarily a
  // repo file (ApplicationEventPublisher et al. are external) - one
  // declarationsById call resolves every distinct target at once, same
  // convention as findTypeDefinitions/resolvedCallees consumers elsewhere.
  const targetTypeIds = [...new Set(pending.map(item => `type:${item.targetFqn}`))];
  const declarations = targetTypeIds.length > 0
    ? await context.frameworkIndex.declarationsById(targetTypeIds)
    : { types: [], methods: [], fields: [], missingIds: [], truncated: false };
  const relativePathByTypeId = new Map(declarations.types.map(t => [t.typeId, t.relativePath]));

  const evidence: EvidenceSignal[] = [];
  const candidates = new Map<string, CandidateFile>();
  const anchorId = context.anchors[0]?.id ?? "A1";
  let signalSeq = 0;
  for (const item of pending) {
    const relativePath = relativePathByTypeId.get(`type:${item.targetFqn}`);
    if (!relativePath) continue; // external or otherwise non-repo target - no file to recommend
    const targetAbsolutePath = path.resolve(context.repoRoot, relativePath);
    signalSeq += 1;
    evidence.push({
      signalId: `${SPRING_ADAPTER_ID}:${signalSeq}`,
      candidateFile: targetAbsolutePath,
      anchorId,
      kind: "SPRING_INJECTION",
      family: "FRAMEWORK",
      provenance: "FRAMEWORK_INFERRED",
      confidence: item.confidence,
      completeness,
      weight: SPRING_INJECTION_WEIGHT,
      sourceFile: item.sourceFile,
      positions: [],
      providerId: SPRING_ADAPTER_ID,
      providerVersion: SPRING_ADAPTER_VERSION,
      generation: context.generation,
      detail: item.detail
    });
    mergeCandidate(candidates, springInjectionCandidate(context.repoRoot, targetAbsolutePath, SPRING_INJECTION_WEIGHT * item.confidence));
  }

  return {
    outcome: {
      providerId: SPRING_ADAPTER_ID,
      providerVersion: SPRING_ADAPTER_VERSION,
      evidence,
      candidates: [...candidates.values()],
      completion: declarations.truncated ? "PARTIAL_LIMIT" : "COMPLETE",
      elapsedMs: Date.now() - startedAt
    },
    metadata: {},
    diagnostics: declarations.truncated
      ? [`spring adapter: declarationsById truncated while resolving ${targetTypeIds.length} injection targets`]
      : []
  };
}

function springInjectionCandidate(repoRoot: string, absolutePath: string, score: number): CandidateFile {
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
    reasons: ["SPRING_INJECTION"],
    confidence: "high",
    verifiedBy: ["SPRING_INJECTION"],
    scoreBreakdown: [breakdown("evidence.SPRING_INJECTION", "policy", score, "Spring dependency injection")]
  };
}

export const springAdapter: FrameworkAdapter = {
  id: SPRING_ADAPTER_ID,
  version: SPRING_ADAPTER_VERSION,
  isActive,
  collect
};

import path from "node:path";
import type { RoutingPolicy } from "../routing-policy.js";
import type { JavaSourceFacts, SourceIndex } from "../source-index.js";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import {
  candidateFromFacts,
  matchesAny,
  mergeCandidate,
  scoreBase,
  simpleTypeName,
  typeReferenceOrderBonus,
  unique
} from "./candidate-helpers.js";

export type TypeReferenceMetrics = {
  scannedPatterns: number;
  addedCandidates: number;
  skippedExisting: number;
  elapsedMs: number;
  cacheHits: number;
  cacheMisses: number;
  cacheMissElapsedMs: number;
  indexHits: number;
  indexMisses: number;
};

type CollectTypeReferenceInput = {
  candidates: Map<string, CandidateFile>;
  anchors: ResolvedAnchor[];
  options: ImpactOptions;
  metrics: TypeReferenceMetrics;
  sourceIndex: SourceIndex;
  routingPolicy: RoutingPolicy;
};

export function collectTypeReferenceCandidates(input: CollectTypeReferenceInput): void {
  const { candidates, anchors, options, metrics, sourceIndex, routingPolicy } = input;
  if (options.semanticPolicy === "required") {
    return;
  }
  for (const anchor of anchors) {
    if (!shouldUseTypeReference(anchor)) {
      continue;
    }
    const canReinforceExistingTypeReferences = routingPolicy.id !== "lishuedu-legacy";
    if (anchor.profile === "controller" && !canReinforceExistingTypeReferences) {
      continue;
    }
    const canUseReferenceOrderBonus = canReinforceExistingTypeReferences && anchor.profile === "controller";
    const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
    metrics.scannedPatterns += 1;
    for (const facts of sourceIndex.findTypeReferences(typeName).slice(0, 20)) {
      if (candidates.has(facts.absolutePath)) {
        metrics.skippedExisting += 1;
        continue;
      }
      const candidate = candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 60, "typeReference");
      mergeCandidate(candidates, candidate);
      metrics.addedCandidates += 1;
    }
    const anchorFacts = sourceIndex.factsFor(anchor.absolutePath);
    const methodFact = canReinforceExistingTypeReferences
      ? sourceIndex.methodAt(anchor.absolutePath, anchor.line)
      : undefined;
    const methodTypes = methodFact
      ? unique([...methodFact.relations.map(relation => relation.typeName), ...methodFact.referencedTypes])
      : [];
    const referencedTypes = unique([...methodTypes, ...anchorFacts.referencedTypes]);
    const referencedTypeOrder = new Map<string, number>();
    referencedTypes.forEach((type, index) => {
      const simple = simpleTypeName(type);
      if (!referencedTypeOrder.has(simple)) {
        referencedTypeOrder.set(simple, index);
      }
    });
    const existingTypeNames = candidateTypeNames(sourceIndex, candidates);
    const existingReferencedTypes = new Set(referencedTypes.map(simpleTypeName).filter(type => existingTypeNames.has(type)));
    if (canReinforceExistingTypeReferences) {
      for (const existing of [...candidates.values()]) {
        if (existing.absolutePath === anchor.absolutePath) {
          continue;
        }
        let existingFacts: JavaSourceFacts;
        try {
          existingFacts = sourceIndex.factsFor(existing.absolutePath);
        } catch {
          continue;
        }
        if (existingFacts.typeName && existingReferencedTypes.has(simpleTypeName(existingFacts.typeName))) {
          const orderBonus = canUseReferenceOrderBonus ? typeReferenceOrderBonus(referencedTypeOrder.get(simpleTypeName(existingFacts.typeName))) : 0;
          const candidate = candidateFromFacts(existingFacts, scoreBase(routingPolicy, "semantic", existingFacts, anchor, options) + 55 + orderBonus, "typeReference");
          mergeCandidate(candidates, candidate);
          if (shouldLookupReferencedImplementers(existingFacts, options)) {
            for (const implFacts of sourceIndex.findImplementers(existingFacts.typeName, true).slice(0, 8)) {
              if (implementationLookupInScope(implFacts, anchor, options)) {
                const implCandidate = candidateFromFacts(implFacts, scoreBase(routingPolicy, "semantic", implFacts, anchor, options) + 70, "typeGraph");
                implCandidate.reasons = ["typeGraph:implementation-lookup"];
                mergeCandidate(candidates, implCandidate);
              }
            }
          }
        }
      }
    }
    const missingTypes = referencedTypes.filter(type => !existingTypeNames.has(simpleTypeName(type)));
    metrics.skippedExisting += referencedTypes.length - missingTypes.length;
    if (missingTypes.length > 0) {
      metrics.scannedPatterns += 1;
    }
    for (const facts of sourceIndex.findTypeDefinitions(missingTypes).slice(0, 20)) {
      if (facts.absolutePath === anchor.absolutePath) {
        continue;
      }
      if (candidates.has(facts.absolutePath)) {
        metrics.skippedExisting += 1;
        continue;
      }
      const orderBonus = canUseReferenceOrderBonus ? typeReferenceOrderBonus(referencedTypeOrder.get(simpleTypeName(facts.typeName || ""))) : 0;
      const candidate = candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 55 + orderBonus, "typeReference");
      mergeCandidate(candidates, candidate);
      metrics.addedCandidates += 1;
      if (canReinforceExistingTypeReferences && facts.kind === "interface" && facts.typeName) {
        for (const implFacts of sourceIndex.findImplementers(facts.typeName, true).slice(0, 8)) {
          mergeCandidate(candidates, candidateFromFacts(implFacts, scoreBase(routingPolicy, "semantic", implFacts, anchor, options) + 70, "typeGraph"));
        }
      }
    }
  }
}

function candidateTypeNames(sourceIndex: SourceIndex, candidates: Map<string, CandidateFile>): Set<string> {
  const typeNames = new Set<string>();
  for (const candidate of candidates.values()) {
    if (!candidate.absolutePath.endsWith(".java")) {
      continue;
    }
    try {
      const typeName = sourceIndex.factsFor(candidate.absolutePath).typeName;
      if (typeName) {
        typeNames.add(typeName);
      }
    } catch {
      continue;
    }
  }
  return typeNames;
}

function shouldUseTypeReference(anchor: ResolvedAnchor): boolean {
  return new Set(["controller", "service", "repository", "dto", "port"]).has(anchor.profile);
}

function shouldLookupReferencedImplementers(facts: JavaSourceFacts, options: ImpactOptions): facts is JavaSourceFacts & { typeName: string } {
  return facts.kind === "interface"
    && typeof facts.typeName === "string"
    && /(?:Service|Gateway|Port)$/.test(facts.typeName)
    && (options.taskKeywords.length === 0 || matchesAny(facts.typeName, options.taskKeywords));
}

function implementationLookupInScope(facts: JavaSourceFacts, anchor: ResolvedAnchor, options: ImpactOptions): boolean {
  return !facts.module || facts.module === anchor.module || options.focusModules.includes(facts.module) || options.focusModules.includes(path.basename(facts.module));
}

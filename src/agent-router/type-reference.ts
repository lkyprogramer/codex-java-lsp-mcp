// input: Anchors, candidate map, and JavaIndex type/reference facts.
// output: Type-reference and implementation-lookup candidates without rg scans.
// pos: Async type-reference collector for AgentRouter (Task 22).
import path from "node:path";
import type { RoutingPolicy } from "../routing-policy.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { JavaSourceFacts } from "../java-index/router-facts.js";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import {
  candidateFromFacts,
  breakdown,
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
  javaIndex: RouterIndex;
  routingPolicy: RoutingPolicy;
  generation?: number;
};

export async function collectTypeReferenceCandidates(input: CollectTypeReferenceInput): Promise<void> {
  const { candidates, anchors, options, metrics, javaIndex, routingPolicy, generation } = input;
  if (options.semanticPolicy === "required") {
    return;
  }
  for (const anchor of anchors) {
    if (!shouldUseTypeReference(anchor)) {
      continue;
    }
    const canReinforceExistingTypeReferences = routingPolicy.id !== "lishuedu-legacy";
    // The legacy controller policy historically disabled broad static
    // reinforcement.  Keep that restraint, but still use an exact explicit
    // import whose already-recalled path proves it is a direct collaborator.
    const canQueryStaticIndex = canReinforceExistingTypeReferences || anchor.profile !== "controller";
    const canUseReferenceOrderBonus = canReinforceExistingTypeReferences && anchor.profile === "controller";
    const typeName = anchor.className || path.basename(anchor.absolutePath, ".java");
    const typeReferenceFacts = canQueryStaticIndex
      ? javaIndex.findTypeReferences(typeName, 20)
      : Promise.resolve<JavaSourceFacts[]>([]);
    let anchorFacts: JavaSourceFacts;
    try {
      anchorFacts = await javaIndex.factsFor(anchor.absolutePath, generation);
    } catch {
      // Ensure an in-flight static query is observed before moving to the next
      // anchor, so a failed fact read cannot leave a rejected promise behind.
      await typeReferenceFacts.catch(() => undefined);
      continue;
    }
    if (canQueryStaticIndex) {
      metrics.scannedPatterns += 1;
      for (const facts of await typeReferenceFacts) {
        const alreadyCandidate = candidates.has(facts.absolutePath);
        if (alreadyCandidate) {
          metrics.skippedExisting += 1;
        }
        const candidate = candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 60, "typeReference");
        mergeCandidate(candidates, candidate);
        if (!alreadyCandidate) {
          metrics.addedCandidates += 1;
        }
      }
    }
    const methodFact = canReinforceExistingTypeReferences
      ? await javaIndex.methodAt(anchor.absolutePath, anchor.line, generation)
      : undefined;
    const methodTypes = methodFact
      ? unique([...methodFact.relations.map(relation => relation.typeName), ...methodFact.referencedTypes])
      : [];
    // A method relation is the strongest signal. Task-named imports cover
    // static mapper calls and generic return types that tree-sitter cannot
    // always express as a direct method type.  They are still exact imports,
    // not a lexical repository scan.
    const referencedTypes = unique([
      ...methodTypes,
      ...anchorFacts.referencedTypes,
      ...anchorFacts.imports
        .filter(imported => matchesAny(simpleTypeName(imported), options.taskKeywords))
    ]);
    const referencedTypeOrder = new Map<string, number>();
    referencedTypes.forEach((type, index) => {
      const simple = simpleTypeName(type);
      if (!referencedTypeOrder.has(simple)) {
        referencedTypeOrder.set(simple, index);
      }
    });
    reinforceImportedCandidates({
      candidates,
      anchor,
      options,
      routingPolicy,
      importedTypes: referencedTypes,
      referencedTypeOrder,
      canUseReferenceOrderBonus
    });
    // Candidate names used to be resolved by foreground-parsing every rg
    // result.  That makes the V2 worker parse arbitrary lexical matches just
    // to discover whether they are a referenced type.  Querying definitions
    // is both exact and indexed; merge the returned fact even when rg already
    // found the same path so the evidence and implementation lookup survive.
    if (canQueryStaticIndex && referencedTypes.length > 0) {
      metrics.scannedPatterns += 1;
    }
    const definitions = canQueryStaticIndex
      ? await javaIndex.findTypeDefinitions(referencedTypes, 20)
      : [];
    for (const facts of definitions) {
      if (facts.absolutePath === anchor.absolutePath) {
        continue;
      }
      const alreadyCandidate = candidates.has(facts.absolutePath);
      if (alreadyCandidate) {
        metrics.skippedExisting += 1;
      }
      const orderBonus = canUseReferenceOrderBonus ? typeReferenceOrderBonus(referencedTypeOrder.get(simpleTypeName(facts.typeName || ""))) : 0;
      const candidate = candidateFromFacts(facts, scoreBase(routingPolicy, "semantic", facts, anchor, options) + 55 + orderBonus, "typeReference");
      mergeCandidate(candidates, candidate);
      if (!alreadyCandidate) {
        metrics.addedCandidates += 1;
      }
      if (canReinforceExistingTypeReferences && facts.kind === "interface" && facts.typeName) {
        const qualifiedTypeName = facts.packageName ? `${facts.packageName}.${facts.typeName}` : facts.typeName;
        for (const implFacts of await javaIndex.findImplementers(qualifiedTypeName, 8, anchor.absolutePath)) {
          const implementation = candidateFromFacts(implFacts, scoreBase(routingPolicy, "semantic", implFacts, anchor, options) + 70, "typeGraph");
          implementation.reasons = ["typeGraph:implementation-lookup"];
          mergeCandidate(candidates, implementation);
        }
      }
    }
  }
}

type ReinforceImportedCandidatesInput = {
  candidates: Map<string, CandidateFile>;
  anchor: ResolvedAnchor;
  options: ImpactOptions;
  routingPolicy: RoutingPolicy;
  importedTypes: readonly string[];
  referencedTypeOrder: ReadonlyMap<string, number>;
  canUseReferenceOrderBonus: boolean;
};

/**
 * A candidate can be proven as a direct type reference from the anchor's
 * explicit import and its already-known path.  This is intentionally path
 * matching rather than `factsFor(candidate)`: the latter turns every rg hit
 * into an on-demand parse before read-plan selection.
 */
function reinforceImportedCandidates(input: ReinforceImportedCandidatesInput): void {
  const importedPaths = new Map<string, string>();
  for (const importedType of input.importedTypes) {
    const simple = simpleTypeName(importedType);
    if (importedType.includes(".")) {
      importedPaths.set(simple, `${importedType.replace(/\./g, "/")}.java`);
    }
  }
  if (importedPaths.size === 0) {
    return;
  }
  for (const existing of [...input.candidates.values()]) {
    const candidatePath = (existing.path || existing.absolutePath).replace(/\\/g, "/");
    const matched = [...importedPaths.entries()].find(([, importedPath]) => candidatePath.endsWith(importedPath));
    if (!matched) {
      continue;
    }
    const [typeName] = matched;
    const orderBonus = input.canUseReferenceOrderBonus
      ? typeReferenceOrderBonus(input.referencedTypeOrder.get(typeName))
      : 0;
    const score = scoreBase(input.routingPolicy, "semantic", existing, input.anchor, input.options) + 55 + orderBonus;
    mergeCandidate(input.candidates, {
      ...existing,
      score,
      matchCount: 0,
      positions: [],
      categories: ["semantic"],
      reasons: ["typeReference"],
      confidence: "medium",
      verifiedBy: ["typeReference"],
      scoreBreakdown: [breakdown("semantic.typeReference", "semantic-seed", score, "anchor explicit import")]
    });
  }
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

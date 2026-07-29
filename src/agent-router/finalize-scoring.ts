// input: Ranked candidates, anchor facts, and JavaIndex structural signals.
// output: Final per-candidate score with breakdown items.
// pos: Finalize scoring for AgentRouter (Task 22: async JavaIndex).
import path from "node:path";
import type { RoutingPolicy } from "../routing-policy.js";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { JavaMethodFact, JavaSourceFacts } from "../java-index/router-facts.js";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import {
  annotationCollaborationDelta,
  kindPairingDelta,
  packageProximityDelta,
  symmetricTypeRelationDelta
} from "./ranking-signals.js";
import {
  addScoreDelta,
  breakdown,
  matchesAny,
  simpleTypeName,
  unique
} from "./candidate-helpers.js";
import { actionTailRaw, classStem, taskKeywordStems } from "./name-helpers.js";

type FinalizeScoreInput = {
  candidate: CandidateFile;
  anchor: ResolvedAnchor;
  options: ImpactOptions;
  suppressed: Record<string, number>;
  anchorFacts?: JavaSourceFacts;
  javaIndex: RouterIndex;
  routingPolicy: RoutingPolicy;
  generation?: number;
  methodCache?: Map<string, JavaMethodFact | undefined>;
  factsCache?: Map<string, JavaSourceFacts | undefined>;
};

export async function finalizeScore(input: FinalizeScoreInput): Promise<CandidateFile> {
  const { candidate, anchor, options, suppressed, anchorFacts, javaIndex, routingPolicy, generation } = input;
  const scoreBreakdown = [...(candidate.scoreBreakdown || [breakdown("unknown.initial", "policy", candidate.score, "initial candidate score")])];
  let score = candidate.score;
  const matchCountDelta = Math.min(40, candidate.matchCount * 2);
  score += addScoreDelta(scoreBreakdown, "finalize.match-count", matchCountDelta, "match count");
  const directDelta = Math.max(
    directCollaboratorDelta(candidate, anchor, options),
    anchor.profile === "service" ? directReferencedTypeDelta(candidate, anchorFacts) : 0
  );
  score += addScoreDelta(scoreBreakdown, "finalize.direct-collaborator", directDelta, "direct type-name collaborator");
  score += addScoreDelta(
    scoreBreakdown,
    "finalize.method-relation",
    await methodRelationDelta(candidate, anchor, javaIndex, generation, input.methodCache),
    "method relation"
  );
  const structural = await structuralDeltas(javaIndex, candidate, anchor, anchorFacts, generation, input.factsCache);
  score += addScoreDelta(scoreBreakdown, "finalize.type-relation", structural.typeRelation, "implements or extends anchor type");
  score += addScoreDelta(scoreBreakdown, "finalize.structural.annotation", structural.annotation, "stereotype collaboration");
  score += addScoreDelta(scoreBreakdown, "finalize.structural.package", structural.packageProximity, "package proximity");
  score += addScoreDelta(scoreBreakdown, "finalize.structural.type-symmetric", structural.typeSymmetric, "anchor is candidate subtype");
  score += addScoreDelta(scoreBreakdown, "finalize.structural.kind", structural.kind, "interface-impl pairing");
  if (candidate.sourceSet === "test" && options.testReadMode === "defer") {
    score += addScoreDelta(scoreBreakdown, "finalize.defer-test", -10, "defer test candidate");
    suppressed.deferredTests += 1;
  }
  if (candidate.module && candidate.module !== anchor.module && options.crossModulePolicy !== "all") {
    if (!options.focusModules.includes(candidate.module) && !(candidate.path && matchesAny(candidate.path, options.taskKeywords))) {
      score += addScoreDelta(scoreBreakdown, "finalize.cross-module", options.crossModulePolicy === "focused" ? -80 : -20, "cross module policy");
      suppressed.crossModuleConsumers += 1;
    }
  }
  score += addScoreDelta(scoreBreakdown, "finalize.confidence", routingPolicy.confidenceDeltas[candidate.confidence || "medium"], "confidence delta");
  const finalScore = Math.max(1, score);
  if (finalScore !== score) {
    addScoreDelta(scoreBreakdown, "finalize.clamp", finalScore - score, "minimum score clamp");
  }
  return { ...candidate, score: finalScore, scoreBreakdown };
}

/**
 * Exported for providers/relationship-provider.ts (Task 25 item 4): the
 * relationship-evidence provider reuses this unchanged rather than
 * reimplementing the verifiedBy-gated candidate-facts fetch and the four
 * structural checks it bundles.
 */
export async function structuralDeltas(
  javaIndex: RouterIndex,
  candidate: CandidateFile,
  anchor: ResolvedAnchor,
  anchorFacts: JavaSourceFacts | undefined,
  generation: number | undefined,
  factsCache: Map<string, JavaSourceFacts | undefined> | undefined
): Promise<{
  annotation: number;
  packageProximity: number;
  typeRelation: number;
  typeSymmetric: number;
  kind: number;
}> {
  const zero = { annotation: 0, packageProximity: 0, typeRelation: 0, typeSymmetric: 0, kind: 0 };
  if (!anchorFacts || candidate.absolutePath === anchor.absolutePath || !candidate.absolutePath.endsWith(".java")) {
    return zero;
  }
  // Do not make a foreground worker parse for a lexical-only rg candidate.
  // Static JavaIndex evidence is already available to candidates verified by
  // the type graph/reference collectors; the remaining candidates retain
  // their lexical ranking and are parsed only if selected for the read plan.
  if (!(candidate.verifiedBy || []).some(source => source === "typeGraph" || source === "typeReference")) {
    return zero;
  }
  try {
    const candidateFacts = await cachedFacts(javaIndex, candidate.absolutePath, generation, factsCache);
    if (!candidateFacts) return zero;
    const candidateParents = [...candidateFacts.implementsTypes, candidateFacts.extendsType || ""].map(simpleTypeName);
    return {
      annotation: annotationCollaborationDelta(anchorFacts.annotations, candidateFacts.annotations),
      packageProximity: packageProximityDelta(anchorFacts.packageName, candidateFacts.packageName),
      typeRelation: anchor.className && candidateParents.includes(anchor.className) ? 95 : 0,
      typeSymmetric: symmetricTypeRelationDelta(anchorFacts, candidateFacts),
      kind: kindPairingDelta(anchorFacts, candidateFacts, anchor.profile)
    };
  } catch {
    return zero;
  }
}

/** Exported for providers/relationship-provider.ts (Task 25 item 4) - see structuralDeltas' export comment. */
export function directCollaboratorDelta(candidate: CandidateFile, anchor: ResolvedAnchor, options: ImpactOptions): number {
  const candidatePath = candidate.path || candidate.absolutePath;
  if (!candidatePath.endsWith(".java")) {
    return 0;
  }
  const typeName = path.basename(candidatePath, ".java");
  if (!typeName || typeName === anchor.className) {
    return 0;
  }
  const sameAnchorModule = Boolean(candidate.module && candidate.module === anchor.module);
  let delta = 0;
  for (const stem of directAnchorStems(anchor)) {
    if (isDirectTypeName(typeName, stem)) {
      delta = Math.max(delta, 170);
    }
  }
  for (const { stem, wordCount } of taskKeywordStems(options.taskKeywords)) {
    if (isDirectTypeName(typeName, stem) && (wordCount > 1 || sameAnchorModule)) {
      delta = Math.max(delta, 170);
    }
    if (sameAnchorModule && stem.length >= 5 && typeName.startsWith(stem) && typeName.endsWith("Assembler")) {
      delta = Math.max(delta, 140);
    }
  }
  if (delta > 0 && anchor.profile === "port" && candidatePath.includes("/domain/")) {
    delta += 50;
  }
  return delta;
}

/** Exported for providers/relationship-provider.ts (Task 25 item 4) - see structuralDeltas' export comment. */
export function directReferencedTypeDelta(candidate: CandidateFile, anchorFacts: JavaSourceFacts | undefined): number {
  if (!anchorFacts || !(candidate.verifiedBy || []).includes("typeReference")) {
    return 0;
  }
  const candidatePath = candidate.path || candidate.absolutePath;
  const typeName = path.basename(candidatePath, ".java");
  if (!isPersistenceDirectReference(typeName, candidatePath)) {
    return 0;
  }
  const referencedTypes = new Set(anchorFacts.referencedTypes.map(simpleTypeName));
  return referencedTypes.has(typeName) ? 140 : 0;
}

/** Exported for providers/relationship-provider.ts (Task 25 item 4) - see structuralDeltas' export comment. */
export async function methodRelationDelta(
  candidate: CandidateFile,
  anchor: ResolvedAnchor,
  javaIndex: RouterIndex,
  generation: number | undefined,
  methodCache: Map<string, JavaMethodFact | undefined> | undefined
): Promise<number> {
  if (!(candidate.verifiedBy || []).includes("typeReference")) {
    return 0;
  }
  const typeName = path.basename(candidate.path || candidate.absolutePath, ".java");
  let method: JavaMethodFact | undefined;
  try {
    const cacheKey = `${anchor.absolutePath}:${anchor.line}`;
    if (methodCache?.has(cacheKey)) {
      method = methodCache.get(cacheKey);
    } else {
      method = await javaIndex.methodAt(anchor.absolutePath, anchor.line, generation);
      methodCache?.set(cacheKey, method);
    }
  } catch {
    return 0;
  }
  const relation = method?.relations.find(item => simpleTypeName(item.typeName) === typeName);
  if (!relation) {
    return 0;
  }
  return relation.kind === "parameter" || relation.kind === "return" ? 160 : 120;
}

async function cachedFacts(
  javaIndex: RouterIndex,
  absolutePath: string,
  generation: number | undefined,
  factsCache: Map<string, JavaSourceFacts | undefined> | undefined
): Promise<JavaSourceFacts | undefined> {
  if (factsCache?.has(absolutePath)) {
    return factsCache.get(absolutePath);
  }
  try {
    const facts = await javaIndex.factsFor(absolutePath, generation);
    factsCache?.set(absolutePath, facts);
    return facts;
  } catch {
    factsCache?.set(absolutePath, undefined);
    return undefined;
  }
}

function isPersistenceDirectReference(typeName: string, candidatePath: string): boolean {
  return /(?:Repository|Template|Entity)$/.test(typeName)
    || candidatePath.includes("/repository/")
    || candidatePath.includes("/entity/");
}

function directAnchorStems(anchor: ResolvedAnchor): string[] {
  const base = classStem(anchor.className || path.basename(anchor.absolutePath, ".java"));
  const action = actionTailRaw(anchor.methodName || anchor.symbolName);
  return unique([
    base,
    base.endsWith("Import") ? base.replace(/Import$/, "") : "",
    action ? `${base}${action}` : ""
  ]);
}

function isDirectTypeName(typeName: string, stem: string): boolean {
  const suffixes = [
    "Controller",
    "AppService",
    "Service",
    "Assembler",
    "Command",
    "Request",
    "Response",
    "RequestAssembler",
    "ResponseAssembler",
    "Result",
    "DTO",
    "View",
    "Executor",
    "Engine",
    "Repository",
    "RepositoryImpl",
    "Mapper",
    "Entity",
    "DO",
    "Gateway",
    "Port",
    "Client",
    "Config",
    "Properties",
    "Parser",
    "ExcelParser",
    "ParsedTemplate",
    "DiffBuilder"
  ];
  return suffixes.some(suffix => typeName === `${stem}${suffix}`) || typeName === `Final${stem}Result`;
}

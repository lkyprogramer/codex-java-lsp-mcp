// input: Candidate, anchor, and indexed Java facts.
// output: Verified relationship strengths for relationship-provider evidence.
// pos: Task 25 relationship fact extraction; deliberately contains no final
//      candidate score mutation or routing-policy-dependent behavior.
import path from "node:path";
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { JavaMethodFact, JavaSourceFacts } from "../java-index/router-facts.js";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import {
  annotationCollaborationDelta,
  kindPairingDelta,
  packageProximityDelta,
  symmetricTypeRelationDelta
} from "./ranking-signals.js";
import { simpleTypeName, unique } from "./candidate-helpers.js";
import { actionTailRaw, classStem, taskKeywordStems } from "./name-helpers.js";

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
  // Static evidence is available to candidates verified by type graph/reference
  // collectors; other candidates remain lexical until read-plan selection.
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

export async function methodRelationDelta(
  candidate: CandidateFile,
  anchor: ResolvedAnchor,
  javaIndex: RouterIndex,
  generation: number | undefined,
  methodCache: Map<string, JavaMethodFact | undefined> | undefined,
  factsCache: Map<string, JavaSourceFacts | undefined> | undefined
): Promise<number> {
  if (!(candidate.verifiedBy || []).includes("typeReference")) {
    return 0;
  }
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
  const candidateFacts = await cachedFacts(javaIndex, candidate.absolutePath, generation, factsCache);
  if (!candidateFacts?.typeId) {
    return 0;
  }
  const relation = method?.relations.find(item => item.typeId === candidateFacts.typeId);
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
    "Controller", "AppService", "Service", "Assembler", "Command", "Request", "Response",
    "RequestAssembler", "ResponseAssembler", "Result", "DTO", "View", "Executor", "Engine",
    "Repository", "RepositoryImpl", "Mapper", "Entity", "DO", "Gateway", "Port", "Client",
    "Config", "Properties", "Parser", "ExcelParser", "ParsedTemplate", "DiffBuilder"
  ];
  return suffixes.some(suffix => typeName === `${stem}${suffix}`) || typeName === `Final${stem}Result`;
}

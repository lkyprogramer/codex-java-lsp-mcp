// input: Candidate, anchor, and indexed Java facts.
// output: Verified relationship strengths for relationship-provider evidence.
// pos: Task 25 relationship fact extraction; deliberately contains no final
//      candidate score mutation or routing-policy-dependent behavior.
import type { RouterIndex } from "../java-index/router-java-index.js";
import type { JavaMethodFact, JavaSourceFacts } from "../java-index/router-facts.js";
import type { CandidateFile, ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import {
  annotationCollaborationDelta,
  kindPairingDelta,
  packageProximityDelta,
  symmetricTypeRelationDelta
} from "./ranking-signals.js";
import { simpleTypeName } from "./candidate-helpers.js";

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
  // Task 30's protected core is deliberately narrower than generic
  // method-body proximity: only a signature parameter/return declaration is
  // a direct collaborator. A local receiver may be incidental to one branch
  // and is covered separately by a resolved CALLS edge when one exists.
  return relation.kind === "parameter" || relation.kind === "return" ? 160 : 0;
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

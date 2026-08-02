// input: JavaIndex facts and finalized candidate score breakdowns.
// output: Pure cold-path ranking deltas and safe tail truncation decisions.
// pos: Structural ranking helpers for AgentRouter final scoring.
import type { CandidateFile } from "../agent-types.js";
import type { JavaSourceFacts } from "../java-index/router-facts.js";

const STEREOTYPE_NAMES = new Set([
  "Controller",
  "RestController",
  "Service",
  "AppService",
  "QueryAppService",
  "Repository",
  "Mapper",
  "Component",
  "Configuration",
  "Entity",
  "Table"
]);

const STEREOTYPE_COLLABORATION: Record<string, string[]> = {
  Controller: ["Service", "AppService", "QueryAppService"],
  RestController: ["Service", "AppService", "QueryAppService"],
  Service: ["Repository", "Mapper", "Component", "Service", "Configuration"],
  AppService: ["Repository", "Mapper", "Service"],
  QueryAppService: ["Repository", "Mapper", "Service"],
  Repository: ["Mapper", "Entity", "Table"],
  Mapper: ["Entity", "Table"],
  Component: ["Service", "Repository", "Component"]
};

const STRUCTURAL_SIGNAL_IDS = new Set([
  "finalize.structural.type-symmetric",
  "finalize.structural.kind",
  "finalize.type-relation",
  "finalize.direct-collaborator",
  // A method parameter or return type is an exact AST relationship to the
  // anchor. It must not be discarded merely because a dense static graph has
  // already filled the small read-plan budget.
  "finalize.method-relation"
]);

const MIN_STRUCTURAL_EVIDENCE_FOR_TAIL_TRUNCATION = 6;

export function stereotypeOf(annotations: string[]): string | undefined {
  for (const annotation of annotations) {
    const match = annotation.trim().match(/^@?(?:[A-Za-z0-9_]+\.)*([A-Za-z_][A-Za-z0-9_]*)/);
    const simple = match?.[1];
    if (simple && STEREOTYPE_NAMES.has(simple)) {
      return simple;
    }
  }
  return undefined;
}

export function annotationCollaborationDelta(anchorAnnotations: string[], candidateAnnotations: string[]): number {
  const anchorStereotype = stereotypeOf(anchorAnnotations);
  const candidateStereotype = stereotypeOf(candidateAnnotations);
  if (!anchorStereotype || !candidateStereotype) {
    return 0;
  }
  const forward = (STEREOTYPE_COLLABORATION[anchorStereotype] || []).includes(candidateStereotype);
  const backward = (STEREOTYPE_COLLABORATION[candidateStereotype] || []).includes(anchorStereotype);
  return forward || backward ? 50 : 0;
}

export function packageProximityDelta(anchorPackage: string | undefined, candidatePackage: string | undefined): number {
  if (!anchorPackage || !candidatePackage) {
    return 0;
  }
  if (anchorPackage === candidatePackage) {
    return 30;
  }
  const anchorSegments = anchorPackage.split(".");
  const candidateSegments = candidatePackage.split(".");
  const limit = Math.min(anchorSegments.length, candidateSegments.length);
  let common = 0;
  while (common < limit && anchorSegments[common] === candidateSegments[common]) {
    common += 1;
  }
  if (common === 0) {
    return 0;
  }
  const anchorGap = anchorSegments.length - common;
  const candidateGap = candidateSegments.length - common;
  if (common >= 3 && anchorGap <= 1 && candidateGap <= 1) {
    return 18;
  }
  return common >= 4 ? 8 : 0;
}

export function symmetricTypeRelationDelta(anchorFacts: JavaSourceFacts, candidateFacts: JavaSourceFacts): number {
  const candidateTypeName = candidateFacts.typeName;
  if (!candidateTypeName) {
    return 0;
  }
  const candidateName = simpleName(candidateTypeName);
  const anchorParents = [...anchorFacts.implementsTypes, anchorFacts.extendsType || ""]
    .map(simpleName)
    .filter(Boolean);
  return anchorParents.includes(candidateName) ? 95 : 0;
}

export function kindPairingDelta(anchorFacts: JavaSourceFacts, candidateFacts: JavaSourceFacts, profile: string): number {
  if (profile !== "port" || anchorFacts.kind !== "interface" || candidateFacts.kind !== "class") {
    return 0;
  }
  const anchorTypeName = anchorFacts.typeName;
  if (!anchorTypeName) {
    return 0;
  }
  const anchorName = simpleName(anchorTypeName);
  const candidateParents = [...candidateFacts.implementsTypes, candidateFacts.extendsType || ""].map(simpleName);
  return candidateParents.includes(anchorName) ? 20 : 0;
}

export function hasProtectedStructuralSignal(candidate: CandidateFile): boolean {
  if ((candidate.verifiedBy || []).some(source => source === "persisted-reference" || source === "persisted-implementation" || source === "persisted-typeHierarchy")) {
    return true;
  }
  // MapStruct's `uses = Type.class` is an explicit annotation class literal
  // whose target has already been resolved to a repository declaration. It
  // is generated-code structural evidence, not a name-search hit; keep it
  // visible even when the lexical tail is dense. It intentionally remains a
  // structural (not verified-quota) read-plan class in read-plan-budget.ts.
  if (candidate.reasons.includes("MAPSTRUCT_USES") && (candidate.verifiedBy || []).includes("MAPSTRUCT_USES")) {
    return true;
  }
  return (candidate.scoreBreakdown || []).some(item => item.delta > 0 && STRUCTURAL_SIGNAL_IDS.has(item.id));
}

/**
 * Retention and evidence density are deliberately different questions. An
 * explicit MapStruct `uses` edge deserves tail retention, but it is a
 * mapper-to-helper declaration rather than another independent direct path
 * from the task anchor. Counting it toward the density threshold makes the
 * threshold discontinuous: adding a valid helper can suddenly discard an
 * otherwise unchanged lexical tail.
 */
function countsTowardStructuralTailDensity(candidate: CandidateFile): boolean {
  if ((candidate.verifiedBy || []).some(source => source === "persisted-reference" || source === "persisted-implementation" || source === "persisted-typeHierarchy")) {
    return true;
  }
  return (candidate.scoreBreakdown || []).some(item => item.delta > 0 && STRUCTURAL_SIGNAL_IDS.has(item.id));
}

export function truncateCandidateTail(
  ranked: CandidateFile[],
  readPlanCovered: Set<CandidateFile>,
  limit = ranked.length
): CandidateFile[] {
  const isProtected = (file: CandidateFile): boolean =>
    readPlanCovered.has(file)
    || hasProtectedStructuralSignal(file)
    || hasExactDeferredTestReference(file);

  const protectedFiles: CandidateFile[] = [];
  const discardable: CandidateFile[] = [];
  for (const file of ranked) {
    (isProtected(file) ? protectedFiles : discardable).push(file);
  }

  if (ranked.length <= 10) {
    return limitKeepingProtected(sortByScore(ranked), protectedFiles, readPlanCovered, limit);
  }

  const structuralCount = ranked.filter(countsTowardStructuralTailDensity).length;
  if (structuralCount < MIN_STRUCTURAL_EVIDENCE_FOR_TAIL_TRUNCATION) {
    return limitKeepingProtected(sortByScore(ranked), protectedFiles, readPlanCovered, limit);
  }
  const dynamicBudget = Math.min(Math.floor(structuralCount * 0.5), 4);
  let cliffIdx = discardable.length;
  for (let i = 1; i < discardable.length; i += 1) {
    if (discardable[i].score < discardable[i - 1].score * 0.5) {
      cliffIdx = i;
      break;
    }
  }
  const keep = Math.min(dynamicBudget, cliffIdx);
  const floor = Math.max(readPlanCovered.size, 8);
  let kept = [...protectedFiles, ...discardable.slice(0, keep)];
  if (kept.length < floor) {
    kept = [...kept, ...discardable.slice(keep, keep + (floor - kept.length))];
  }

  return limitKeepingProtected(sortByScore(kept), protectedFiles, readPlanCovered, limit);
}

function limitKeepingProtected(
  sorted: CandidateFile[],
  protectedFiles: CandidateFile[],
  requiredFiles: ReadonlySet<CandidateFile>,
  limit: number
): CandidateFile[] {
  if (sorted.length <= limit) {
    return sorted;
  }
  const protectedSet = new Set(protectedFiles);
  const limited: CandidateFile[] = [];
  const selected = new Set<CandidateFile>();
  const addUntilLimit = (predicate: (file: CandidateFile) => boolean): void => {
    for (const file of sorted) {
      if (limited.length >= limit) return;
      if (predicate(file) && !selected.has(file)) {
        limited.push(file);
        selected.add(file);
      }
    }
  };
  // Read-plan-covered files include the anchor and are mandatory. Other exact
  // structural/framework evidence remains preferred, but a large protected
  // set must not turn candidateLimit into a soft suggestion.
  addUntilLimit(file => requiredFiles.has(file));
  addUntilLimit(file => protectedSet.has(file));
  addUntilLimit(() => true);
  return sortByScore(limited);
}

function hasExactDeferredTestReference(candidate: CandidateFile): boolean {
  // A deferred test stays out of the bounded foreground read plan, but an exact
  // JavaIndex type edge is still useful candidate evidence. Keep it visible
  // when trimming the noisy tail without broadening the read-plan budget.
  return candidate.sourceSet === "test" && (candidate.verifiedBy || []).includes("typeReference");
}

function simpleName(value: string): string {
  const withoutGenerics = value.replace(/<.*$/, "");
  return withoutGenerics.slice(withoutGenerics.lastIndexOf(".") + 1);
}

function sortByScore(files: CandidateFile[]): CandidateFile[] {
  return [...files].sort((left, right) =>
    right.score - left.score || (left.path || left.absolutePath).localeCompare(right.path || right.absolutePath)
  );
}

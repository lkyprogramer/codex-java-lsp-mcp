import type { CandidateFile } from "../agent-types.js";

export type EvidenceClass = "anchor" | "verified" | "structural" | "naming" | "support";

const VERIFIED_EVIDENCE = new Set([
  "reference",
  "typeHierarchy",
  "semantic-definition",
  "semantic-implementation",
  "persisted-reference",
  "persisted-implementation",
  "persisted-typeHierarchy"
]);

const STRUCTURAL_EVIDENCE = new Set(["typeGraph", "importGraph", "typeReference"]);

/**
 * Framework evidence has mixed strength. Only a pack's exact structural
 * match - a resolved CALLS edge (Spring) or a resolved namespace/statement-id
 * name match (MyBatis) - may spend the shared "verified" read-plan quota;
 * weaker relationships (DI injection, XML parameter/result type references)
 * stay structural so they cannot evict JDT-verified evidence as a group.
 */
const FRAMEWORK_VERIFIED_REASONS = new Set(["SPRING_CALL_PATH", "MYBATIS_NAMESPACE", "MYBATIS_STATEMENT_METHOD"]);

const SUPPORT_CATEGORIES = new Set(["config", "persistence", "nonJava"]);

const READ_PLAN_UTILITY_SCORE_IDS = new Set([
  "finalize.task-keyword",
  "finalize.direct-collaborator",
  "finalize.method-relation",
  "finalize.type-relation",
  "finalize.structural.kind"
]);

export function evidenceClassOf(file: CandidateFile): EvidenceClass {
  if (file.reasons.includes("target")) {
    return "anchor";
  }
  if (file.sourceSet === "test" || file.categories.some(category => SUPPORT_CATEGORIES.has(category))) {
    return "support";
  }
  const verifiedBy = file.verifiedBy || [];
  if (verifiedBy.some(item => VERIFIED_EVIDENCE.has(item))) {
    return "verified";
  }
  if (file.categories.includes("framework")) {
    return file.reasons.some(reason => FRAMEWORK_VERIFIED_REASONS.has(reason)) ? "verified" : "structural";
  }
  if (verifiedBy.includes("typeGraph") && file.reasons.includes("typeGraph:implementation-lookup")) {
    return "naming";
  }
  if (verifiedBy.some(item => STRUCTURAL_EVIDENCE.has(item))) {
    return "structural";
  }
  return "naming";
}

export function classQuotas(maxItems: number): Record<Exclude<EvidenceClass, "anchor">, number> {
  const structuralQuota = maxItems >= 6 ? 5 : Math.max(1, Math.floor(maxItems / 3));
  const namingQuota = maxItems >= 6 ? 1 : Math.max(1, Math.floor(maxItems / 3));
  return {
    verified: Math.max(1, Math.ceil(maxItems / 3)),
    structural: structuralQuota,
    naming: namingQuota,
    support: Math.max(1, Math.floor(maxItems / 6))
  };
}

export function selectWithEvidenceBudget(
  sorted: CandidateFile[],
  maxItems: number,
  protectedPaths: Set<string>
): CandidateFile[] {
  const ordered = readPlanOrder(sorted);
  const quotas = classQuotas(maxItems);
  const used: Record<EvidenceClass, number> = { anchor: 0, verified: 0, structural: 0, naming: 0, support: 0 };
  const selected: CandidateFile[] = [];
  const selectedPaths = new Set<string>();
  const take = (file: CandidateFile): void => {
    selected.push(file);
    selectedPaths.add(file.absolutePath);
    used[evidenceClassOf(file)] += 1;
  };
  for (const file of ordered) {
    if (selected.length >= maxItems) {
      break;
    }
    if ((evidenceClassOf(file) === "anchor" || protectedPaths.has(file.absolutePath)) && !selectedPaths.has(file.absolutePath)) {
      take(file);
    }
  }
  for (const file of ordered) {
    if (selected.length >= maxItems) {
      break;
    }
    if (selectedPaths.has(file.absolutePath)) {
      continue;
    }
    const evidenceClass = evidenceClassOf(file);
    if (evidenceClass === "anchor" || used[evidenceClass] < quotas[evidenceClass]) {
      take(file);
    }
  }
  for (const file of ordered) {
    if (selected.length >= maxItems) {
      break;
    }
    if (!selectedPaths.has(file.absolutePath)) {
      take(file);
    }
  }
  return selected;
}

function readPlanOrder(sorted: CandidateFile[]): CandidateFile[] {
  return sorted
    .map((file, index) => ({ file, index }))
    .sort((left, right) => {
      const leftClass = evidenceClassOf(left.file);
      const rightClass = evidenceClassOf(right.file);
      const sameEvidenceClass = leftClass === rightClass;
      if (sameEvidenceClass && leftClass === "naming") {
        const familyDelta = concreteFamilyDelta(left.file, right.file);
        if (familyDelta !== 0) {
          return familyDelta;
        }
      }
      if (sameEvidenceClass && left.file.score === right.file.score) {
        const utilityDelta = readPlanUtilityScore(right.file) - readPlanUtilityScore(left.file);
        if (utilityDelta !== 0) {
          return utilityDelta;
        }
      }
      return left.index - right.index;
    })
    .map(entry => entry.file);
}

function readPlanUtilityScore(file: CandidateFile): number {
  return (file.scoreBreakdown || [])
    .filter(item => READ_PLAN_UTILITY_SCORE_IDS.has(item.id))
    .reduce((sum, item) => sum + item.delta, 0);
}

function concreteFamilyDelta(left: CandidateFile, right: CandidateFile): number {
  const leftName = javaTypeName(left);
  const rightName = javaTypeName(right);
  const leftAbstractFamily = abstractFamilyName(leftName);
  const rightAbstractFamily = abstractFamilyName(rightName);
  if (leftAbstractFamily && isConcreteFamilyMember(rightName, leftAbstractFamily)) {
    return 1;
  }
  if (rightAbstractFamily && isConcreteFamilyMember(leftName, rightAbstractFamily)) {
    return -1;
  }
  return 0;
}

function javaTypeName(file: CandidateFile): string {
  const value = file.path || file.absolutePath;
  const base = value.slice(value.lastIndexOf("/") + 1);
  return base.endsWith(".java") ? base.slice(0, -5) : base;
}

function abstractFamilyName(typeName: string): string {
  if (typeName.startsWith("Abstract") && typeName.length > "Abstract".length) {
    return typeName.slice("Abstract".length);
  }
  if (typeName.startsWith("Base") && typeName.length > "Base".length) {
    return typeName.slice("Base".length);
  }
  return "";
}

function isConcreteFamilyMember(typeName: string, familyName: string): boolean {
  return typeName !== familyName
    && !abstractFamilyName(typeName)
    && typeName.endsWith(familyName);
}

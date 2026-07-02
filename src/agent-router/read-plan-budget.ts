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

const SUPPORT_CATEGORIES = new Set(["config", "persistence", "nonJava"]);

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
  if (verifiedBy.some(item => STRUCTURAL_EVIDENCE.has(item))) {
    return "structural";
  }
  return "naming";
}

export function classQuotas(maxItems: number): Record<Exclude<EvidenceClass, "anchor">, number> {
  return {
    verified: Math.max(1, Math.ceil(maxItems / 3)),
    structural: Math.max(1, Math.floor(maxItems / 3)),
    naming: Math.max(1, Math.floor(maxItems / 3)),
    support: Math.max(1, Math.floor(maxItems / 6))
  };
}

export function selectWithEvidenceBudget(
  sorted: CandidateFile[],
  maxItems: number,
  protectedPaths: Set<string>
): CandidateFile[] {
  const quotas = classQuotas(maxItems);
  const used: Record<EvidenceClass, number> = { anchor: 0, verified: 0, structural: 0, naming: 0, support: 0 };
  const selected: CandidateFile[] = [];
  const selectedPaths = new Set<string>();
  const take = (file: CandidateFile): void => {
    selected.push(file);
    selectedPaths.add(file.absolutePath);
    used[evidenceClassOf(file)] += 1;
  };
  for (const file of sorted) {
    if (selected.length >= maxItems) {
      break;
    }
    if (protectedPaths.has(file.absolutePath) && !selectedPaths.has(file.absolutePath)) {
      take(file);
    }
  }
  for (const file of sorted) {
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
  for (const file of sorted) {
    if (selected.length >= maxItems) {
      break;
    }
    if (!selectedPaths.has(file.absolutePath)) {
      take(file);
    }
  }
  return selected;
}

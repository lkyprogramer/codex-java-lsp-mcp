// input: CandidateFile planner evidence and ranking keys.
// output: Family/overlap features shared by selection utility and the V6 planner.
// pos: V5R Phase 2 extract from read-plan.ts. No ranking weights live here.
import type { CandidateFile } from "../../agent-types.js";

export function evidenceKeys(file: CandidateFile): string[] {
  return [...new Set([...file.reasons, ...(file.verifiedBy || [])])];
}

export function plannerEvidenceKeys(file: CandidateFile): string[] {
  if ((file.plannerEvidence?.length ?? 0) > 0) {
    return file.plannerEvidence!.map(item => `${item.family}\0${item.kind}\0${item.sourceTarget}\0${item.callOrigin ?? ""}`);
  }
  return evidenceKeys(file);
}

export function familyKeys(file: CandidateFile): Set<string> {
  if ((file.plannerEvidence?.length ?? 0) > 0) {
    return new Set(file.plannerEvidence!.map(item => item.family));
  }
  const keys = evidenceKeys(file).map(key => key.split(":", 1)[0]!);
  return new Set(keys.length > 0 ? keys : file.categories);
}

export function evidenceOverlap(left: CandidateFile, right: CandidateFile): number {
  const leftKeys = plannerEvidenceKeys(left);
  const rightKeys = new Set(plannerEvidenceKeys(right));
  if (leftKeys.length === 0) return 0;
  return leftKeys.filter(key => rightKeys.has(key)).length / leftKeys.length;
}

export function hasNovelEvidence(candidate: CandidateFile, selected: readonly CandidateFile[]): boolean {
  const selectedKeys = new Set(selected.flatMap(file => plannerEvidenceKeys(file)));
  return plannerEvidenceKeys(candidate).some(key => !selectedKeys.has(key));
}

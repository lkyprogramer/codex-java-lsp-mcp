// input: A candidate ReadUnit and the already-selected set.
// output: Deterministic marginal utility used by first-call selection and later frontier.
// pos: V5R Phase 2. One formula; no public wire field.
import type { CandidateFile } from "../../agent-types.js";
import { evidenceOverlap, familyKeys } from "./evidence-features.js";

export type UtilityCarrier = {
  readonly file: CandidateFile;
  readonly estimatedBytes: number;
};

export function selectionUtility(candidate: UtilityCarrier, selected: readonly UtilityCarrier[]): number {
  const candidateFamilies = familyKeys(candidate.file);
  const selectedFamilies = new Set(selected.flatMap(unit => [...familyKeys(unit.file)]));
  const uncoveredFamilies = [...candidateFamilies].filter(family => !selectedFamilies.has(family)).length * 12;
  const moduleDiversity = selected.some(unit => unit.file.module === candidate.file.module) ? 0 : 8;
  const layerDiversity = selected.some(unit => unit.file.layer === candidate.file.layer) ? 0 : 6;
  const overlap = selected.reduce((maximum, unit) => Math.max(maximum, evidenceOverlap(candidate.file, unit.file)), 0) * 35;
  const supportValue = candidate.file.sourceSet === "test"
    ? 2
    : candidate.file.categories.some(category => category === "config" || category === "persistence") ? 4 : 0;
  const bytePenalty = Math.log2(1 + Math.max(1, candidate.estimatedBytes)) * 3;
  return candidate.file.score + uncoveredFamilies + moduleDiversity + layerDiversity + supportValue - overlap - bytePenalty;
}

export function protectedSelectionUtility(unit: UtilityCarrier): number {
  return unit.file.score + familyKeys(unit.file).size * 10;
}

export function compareSelectionUtility(
  leftUtility: number,
  leftBytes: number,
  rightUtility: number,
  rightBytes: number,
  preferDensity: boolean
): number {
  const densityDelta = utilityPerByte(rightUtility, rightBytes) - utilityPerByte(leftUtility, leftBytes);
  const utilityDelta = rightUtility - leftUtility;
  return preferDensity
    ? densityDelta || utilityDelta || leftBytes - rightBytes
    : utilityDelta || densityDelta || leftBytes - rightBytes;
}

function utilityPerByte(utility: number, bytes: number): number {
  return utility / Math.max(256, bytes);
}

// input: Built ReadUnits and the selected legacy plan paths.
// output: Ordered selected units plus an identity report versus the V6 selector.
// pos: V5R Phase 2 adapter. Does not replace selectTokenAwarePlan; shadow proves identity.
import type { ReadUnit, ReadUnitIdentity, RetrievalParityReport } from "./retrieval-types.js";

export function selectedReadUnits(units: readonly ReadUnit[], selectedPaths: readonly string[]): ReadUnit[] {
  const order = new Map(selectedPaths.map((path, index) => [path, index]));
  return units
    .filter(unit => order.has(unit.absolutePath))
    .sort((left, right) => (order.get(left.absolutePath) ?? 0) - (order.get(right.absolutePath) ?? 0));
}

export function readUnitIdentity(unit: ReadUnit): ReadUnitIdentity {
  return {
    relativePath: unit.relativePath,
    fileId: unit.fileId,
    ranges: unit.mergedRanges.map(range => ({
      startLine: range.startLine,
      endLine: range.endLine,
      estimatedBytes: range.estimatedBytes
    })),
    estimatedBytes: unit.estimatedBytes
  };
}

export function compareReadUnitParity(
  selected: readonly ReadUnit[],
  legacy: readonly ReadUnit[]
): RetrievalParityReport {
  const selectedIdentity = selected.map(readUnitIdentity);
  const legacyIdentity = legacy.map(readUnitIdentity);
  return {
    match: JSON.stringify(selectedIdentity) === JSON.stringify(legacyIdentity),
    selected: selectedIdentity,
    legacy: legacyIdentity
  };
}

export type RetrievalParityTracker = {
  matches: number;
  mismatches: number;
  last?: RetrievalParityReport;
};

export const retrievalParityTracker: RetrievalParityTracker = {
  matches: 0,
  mismatches: 0
};

export function resetRetrievalParityTracker(): void {
  retrievalParityTracker.matches = 0;
  retrievalParityTracker.mismatches = 0;
  retrievalParityTracker.last = undefined;
}

export function observeRetrievalParity(
  selected: readonly ReadUnit[],
  legacy: readonly ReadUnit[]
): RetrievalParityReport {
  const report = compareReadUnitParity(selected, legacy);
  retrievalParityTracker.last = report;
  if (report.match) retrievalParityTracker.matches += 1;
  else retrievalParityTracker.mismatches += 1;
  return report;
}

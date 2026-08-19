// input: Selected ReadUnits and the retrieval budget derived from the impact mode.
// output: Hard-cap overflow gaps. Does not drop files to chase a span budget.
// pos: V5R Phase 2. Span/file/byte caps are checks on the legacy selector, not a new knife.
import type { ReadUnit, RetrievalBudget } from "./retrieval-types.js";

export function retrievalBudgetOverflowGaps(units: readonly ReadUnit[], budget: RetrievalBudget): string[] {
  const gaps: string[] = [];
  if (units.length > budget.maxFiles) {
    gaps.push(`ReadUnit plan exceeded maxFiles (${units.length} > ${budget.maxFiles}).`);
  }
  const totalBytes = units.reduce((sum, unit) => sum + unit.estimatedBytes, 0);
  if (totalBytes > budget.maxReadBytes) {
    gaps.push(`ReadUnit plan exceeded maxReadBytes (${totalBytes} > ${budget.maxReadBytes}).`);
  }
  const totalSpans = units.reduce((sum, unit) => sum + unit.mergedRanges.length, 0);
  if (totalSpans > budget.maxSpans) {
    gaps.push(`ReadUnit plan exceeded maxSpans (${totalSpans} > ${budget.maxSpans}).`);
  }
  for (const unit of units) {
    if (unit.mergedRanges.length > budget.maxSpansPerFile) {
      gaps.push(`ReadUnit ${unit.relativePath} exceeded maxSpansPerFile (${unit.mergedRanges.length} > ${budget.maxSpansPerFile}).`);
    }
  }
  const testUnits = units.filter(unit => unit.sourceSet === "test").length;
  if (testUnits > budget.maxTestUnits) {
    gaps.push(`ReadUnit plan exceeded maxTestUnits (${testUnits} > ${budget.maxTestUnits}).`);
  }
  return gaps;
}

export function planWithinRetrievalBudget(units: readonly ReadUnit[], budget: RetrievalBudget): boolean {
  return retrievalBudgetOverflowGaps(units, budget).length === 0;
}

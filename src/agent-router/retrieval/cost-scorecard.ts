// input: Paired old/new RetrievalCostVector samples, tagged tuning or holdout.
// output: Per-field deltas. Never a λ-weighted KEEP/REJECT scalar.
// pos: V5R Phase 3 scorecard. Tail is field-wise CVaR, not a synthetic J(π).
import { reconstructEstimatedTokens, type RetrievalCostVectorV1 } from "./cost-model.js";

export type EvaluationSplit = "tuning" | "holdout";

export type CostFieldName =
  | "wireBytes"
  | "plannedSourceBytes"
  | "toolCalls"
  | "sourceReadCalls"
  | "serviceMs"
  | "estimatedTokens";

export type FieldComparison = {
  field: CostFieldName;
  old: number;
  new: number;
  delta: number;
  nonWorse: boolean;
};

export type SplitScorecard = {
  split: EvaluationSplit;
  fields: FieldComparison[];
};

const LOWER_IS_BETTER: readonly CostFieldName[] = [
  "wireBytes",
  "plannedSourceBytes",
  "toolCalls",
  "sourceReadCalls",
  "serviceMs",
  "estimatedTokens"
];

export function costFieldValue(vector: RetrievalCostVectorV1, field: CostFieldName): number {
  if (field === "estimatedTokens") {
    return reconstructEstimatedTokens(vector.wireBytes, vector.plannedSourceBytes);
  }
  return vector[field];
}

export function compareCostVectors(
  oldVector: RetrievalCostVectorV1,
  newVector: RetrievalCostVectorV1,
  split: EvaluationSplit
): SplitScorecard {
  return {
    split,
    fields: LOWER_IS_BETTER.map(field => {
      const oldValue = costFieldValue(oldVector, field);
      const newValue = costFieldValue(newVector, field);
      return {
        field,
        old: oldValue,
        new: newValue,
        delta: newValue - oldValue,
        nonWorse: newValue <= oldValue
      };
    })
  };
}

export function tailCvar(samples: readonly number[], tail = 0.2): number {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((left, right) => right - left);
  const count = Math.max(1, Math.ceil(ordered.length * tail));
  const slice = ordered.slice(0, count);
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
}

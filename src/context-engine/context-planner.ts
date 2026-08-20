// input: EvidenceBundle candidates plus an exact token budget.
// output: Selected bundles. Greedy submodular knapsack; file count is not a binding cap.
// pos: JIN N4-02. P0 forced; ambiguity ≤2; stop when best marginal ≤0 or next item over budget.
import { isP0Bundle, type EvidenceBundle } from "./evidence-bundle.js";

export const DEFAULT_TOKEN_BUDGET = 2500;
export const MAX_DISTINCT_FILES_GUARD = 20;
export const MAX_AMBIGUITY_PER_OBLIGATION = 2;
export const MAX_BUNDLES_GUARD = 64;

export type PlanResult = {
  selected: EvidenceBundle[];
  rejectedOverBudget: EvidenceBundle[];
  covered: string[];
  tokenCost: number;
  distinctFiles: number;
};

export type PlanInput = {
  bundles: EvidenceBundle[];
  tokenBudget: number;
  maxDistinctFiles?: number;
  maxBundles?: number;
};

function primaryObligation(bundle: EvidenceBundle): string {
  return bundle.closes[0] ?? bundle.id;
}

function limitAmbiguity(bundles: EvidenceBundle[]): EvidenceBundle[] {
  const p0 = bundles.filter(isP0Bundle);
  const rest = bundles.filter(bundle => !isP0Bundle(bundle));
  const kept: EvidenceBundle[] = [];
  const counts = new Map<string, number>();
  for (const bundle of rest.sort((left, right) => left.hops - right.hops || right.confidence - left.confidence || left.id.localeCompare(right.id))) {
    const key = primaryObligation(bundle);
    const used = counts.get(key) ?? 0;
    if (used >= MAX_AMBIGUITY_PER_OBLIGATION) continue;
    counts.set(key, used + 1);
    kept.push(bundle);
  }
  return [...p0, ...kept];
}

function coveredBy(selected: EvidenceBundle[]): Set<string> {
  const closed = new Set<string>();
  for (const bundle of selected) for (const id of bundle.closes) closed.add(id);
  return closed;
}

function rolesOf(selected: EvidenceBundle[]): Set<string> {
  return new Set(selected.map(bundle => bundle.role));
}

function filesOf(selected: EvidenceBundle[]): Set<string> {
  return new Set(selected.map(bundle => bundle.path));
}

function marginalGain(bundle: EvidenceBundle, selected: EvidenceBundle[]): number {
  const closed = coveredBy(selected);
  const fresh = bundle.closes.filter(id => !closed.has(id)).length;
  const redundancy = selected.some(item => item.path === bundle.path && bundle.closes.every(id => item.closes.includes(id)))
    ? 1
    : 0;
  const diversity = rolesOf(selected).has(bundle.role) ? 0 : 0.15;
  const saturation = selected.some(item => item.path === bundle.path) ? 0.25 : 0;
  return fresh + diversity + bundle.confidence * 0.05 - redundancy - saturation;
}

function tokenCostOf(selected: EvidenceBundle[]): number {
  return selected.reduce((sum, bundle) => sum + bundle.tokenCost, 0);
}

export function planEvidenceBundles(input: PlanInput): PlanResult {
  const budget = Math.max(1, input.tokenBudget);
  const fileGuard = input.maxDistinctFiles ?? MAX_DISTINCT_FILES_GUARD;
  const bundleGuard = input.maxBundles ?? MAX_BUNDLES_GUARD;
  const candidates = limitAmbiguity(input.bundles)
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id));
  const selected: EvidenceBundle[] = [];
  const rejectedOverBudget: EvidenceBundle[] = [];
  const p0 = candidates.filter(isP0Bundle).sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
  for (const bundle of p0) {
    selected.push(bundle);
  }
  let remaining = candidates.filter(bundle => !isP0Bundle(bundle));
  while (remaining.length > 0 && selected.length < bundleGuard) {
    let best: EvidenceBundle | undefined;
    let bestRatio = -Infinity;
    for (const bundle of remaining) {
      const gain = marginalGain(bundle, selected);
      const ratio = gain / Math.max(1, bundle.tokenCost);
      if (gain <= 0) continue;
      if (ratio > bestRatio || (ratio === bestRatio && best && bundle.id.localeCompare(best.id) < 0)) {
        best = bundle;
        bestRatio = ratio;
      }
    }
    if (!best || bestRatio <= 0) break;
    const used = tokenCostOf(selected);
    if (used + best.tokenCost > budget) {
      rejectedOverBudget.push(best);
      break;
    }
    const files = filesOf(selected);
    if (!files.has(best.path) && files.size >= fileGuard) {
      remaining = remaining.filter(item => item.id !== best!.id);
      continue;
    }
    selected.push(best);
    remaining = remaining.filter(item => item.id !== best.id);
  }
  selected.sort((left, right) => left.hops - right.hops || left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
  return {
    selected,
    rejectedOverBudget,
    covered: [...coveredBy(selected)].sort(),
    tokenCost: tokenCostOf(selected),
    distinctFiles: filesOf(selected).size
  };
}

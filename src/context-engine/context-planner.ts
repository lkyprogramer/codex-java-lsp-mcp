// input: EvidenceBundle candidates plus an exact token budget.
// output: Selected bundles. P0 then hop-order among items that fit; file count is not a binding cap.
// pos: JIN N4-02. P0 forced; ambiguity ≤2; skip over-budget; no hop≤2 all-admit.
import { bundleTokenCost, isP0Bundle, mergeSpans, type EvidenceBundle } from "./evidence-bundle.js";
import { BYTES_DIV_4, estimateTokens } from "./token-estimator.js";

export const DEFAULT_TOKEN_BUDGET = 2000;
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
  return bundle.closes[bundle.closes.length - 1] ?? bundle.id;
}

function ambiguityKey(bundle: EvidenceBundle): string {
  const obligation = primaryObligation(bundle);
  const step = bundle.provingPath[bundle.provingPath.length - 1];
  return `${obligation}::${step?.fromId ?? bundle.path}`;
}

const AMBIGUOUS_PROOF = /IMPLEMENTS|DISPATCHES_TO|PERMITS|CALLED_BY/;

function isAmbiguousProof(bundle: EvidenceBundle): boolean {
  return bundle.proof.some(kind => AMBIGUOUS_PROOF.test(kind));
}

function limitAmbiguity(bundles: EvidenceBundle[]): EvidenceBundle[] {
  const p0 = bundles.filter(isP0Bundle);
  const rest = bundles.filter(bundle => !isP0Bundle(bundle));
  const kept: EvidenceBundle[] = [];
  const counts = new Map<string, number>();
  for (const bundle of rest.sort((left, right) => left.hops - right.hops || right.confidence - left.confidence || left.id.localeCompare(right.id))) {
    if (!isAmbiguousProof(bundle)) {
      kept.push(bundle);
      continue;
    }
    const key = ambiguityKey(bundle);
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

function pathNameTokens(path: string): Set<string> {
  const base = path.split("/").pop()?.replace(/\.java$/i, "") ?? "";
  const parts = base.split(/(?=[A-Z0-9])/).map(part => part.toLowerCase()).filter(part => part.length > 3);
  return new Set(parts);
}

function nameOverlap(bundle: EvidenceBundle, selected: EvidenceBundle[]): number {
  const tokens = pathNameTokens(bundle.path);
  if (tokens.size === 0) return 0;
  for (const item of selected) {
    if (item.path === bundle.path) continue;
    for (const token of pathNameTokens(item.path)) {
      if (tokens.has(token)) return 2.2;
    }
  }
  return 0;
}

function marginalGain(bundle: EvidenceBundle, selected: EvidenceBundle[]): number {
  const closed = coveredBy(selected);
  const fresh = bundle.closes.filter(id => !closed.has(id)).length;
  const samePath = selected.some(item => item.path === bundle.path);
  const redundancy = selected.some(item => item.path === bundle.path && bundle.closes.every(id => item.closes.includes(id)))
    ? 8
    : 0;
  const diversity = rolesOf(selected).has(bundle.role) ? 0 : 0.15;
  const saturation = samePath ? 0.35 : 0;
  const nearHop = samePath ? 0 : bundle.hops <= 0 ? 4 : bundle.hops === 1 ? 1.8 : bundle.hops === 2 ? 1.6 : bundle.hops === 3 ? 1.1 : 0.3;
  const newPath = samePath ? 0 : 0.55;
  return fresh + diversity + nearHop + newPath + nameOverlap(bundle, selected) + bundle.confidence * 0.05 - redundancy - saturation;
}

function tokenCostOf(selected: EvidenceBundle[]): number {
  return selected.reduce((sum, bundle) => sum + bundle.tokenCost, 0);
}

const IMPL_PROOF = /IMPLEMENTS|DISPATCHES_TO|MYBATIS|JPA_|REPOSITORY_|SPRING_|PUBLISHES_EVENT|CONSUMES_EVENT/;
const CALL_PROOF = /CALLS_|CALLED_BY|METHOD_REFERENCE/;
const MID_PROOF = /EXTENDS|PERMITS|IMPORTS|DECLARES|CONSTRUCTS/;
const PERSISTENCE_PROOF = /MYBATIS_|JPA_|REPOSITORY_MANAGES_ENTITY|SQL_TOUCHES_TABLE/;
const GENERIC_PERSISTENCE = /^(findById|save|insert|update|delete|count|exists)$|^(findBy|listBy|countBy|existsBy|deleteBy)[A-Z]/;
const MAX_LOW_PROOF_TOKENS = 150;
const MAX_HOP2_CALLS = 3;
const MAX_HOP2_PERSISTENCE = 3;

function provingMember(bundle: EvidenceBundle): string | undefined {
  for (const step of bundle.provingPath) {
    const parts = step.toId.split("#");
    if (parts.length >= 3 && parts[2]) return parts[2];
  }
  return undefined;
}

function isPersistenceProof(bundle: EvidenceBundle): boolean {
  return bundle.role === "PERSISTENCE" || bundle.proof.some(kind => PERSISTENCE_PROOF.test(kind));
}

function genericPersistenceCall(bundle: EvidenceBundle): boolean {
  if (isPersistenceProof(bundle)) return false;
  const name = provingMember(bundle);
  return Boolean(name && GENERIC_PERSISTENCE.test(name));
}

function proofRank(bundle: EvidenceBundle): number {
  if (bundle.proof.some(kind => IMPL_PROOF.test(kind))) return 0;
  if (bundle.proof.some(kind => CALL_PROOF.test(kind))) return 1;
  if (bundle.proof.includes("IMPORTS") && bundle.provingPath.some(step => step.kind === "IMPORTS" && !step.fromId.includes("#"))) {
    return 2;
  }
  if (bundle.proof.some(kind => MID_PROOF.test(kind))) return 3;
  return 4;
}

function persistenceLayout(path: string): number {
  return path.includes("/persistence/") || path.includes("/mapper/") || path.includes("/entity/") || path.includes("/repository/") ? 1 : 0;
}

function layoutPrefix(path: string): string {
  const src = path.indexOf("/src/");
  if (src >= 0) return path.slice(0, src);
  if (path === "src" || path.startsWith("src/")) return "src";
  return path.split("/").slice(0, 2).join("/");
}

function isTestPath(path: string): boolean {
  return path.includes("/src/test/") || path.includes("/test/java/");
}

function isSignatureImports(bundle: EvidenceBundle): boolean {
  return bundle.proof.includes("IMPORTS") && bundle.provingPath.some(step => step.kind === "IMPORTS" && !step.fromId.includes("#"));
}

function hop2KindRank(bundle: EvidenceBundle): number {
  if (bundle.proof.includes("CALLS_VIRTUAL") || isPersistenceProof(bundle)) return 0;
  if (bundle.proof.some(kind => kind.startsWith("CALLS_"))) return 1;
  if (bundle.proof.includes("IMPLEMENTS") || bundle.proof.includes("DISPATCHES_TO")) return 2;
  return 3;
}

export function planEvidenceBundles(input: PlanInput): PlanResult {
  const budget = Math.max(1, input.tokenBudget);
  const fileGuard = input.maxDistinctFiles ?? MAX_DISTINCT_FILES_GUARD;
  const bundleGuard = input.maxBundles ?? MAX_BUNDLES_GUARD;
  const anchorPrefix = layoutPrefix(input.bundles.find(bundle => bundle.hops === 0)?.path ?? "");
  const highProof = (bundle: EvidenceBundle) => (proofRank(bundle) <= 1 || (isSignatureImports(bundle) && bundle.tokenCost <= MAX_LOW_PROOF_TOKENS)) ? 0 : 1;
  const anchors = input.bundles.filter(isP0Bundle);
  const candidates = limitAmbiguity(input.bundles)
    .slice()
    .sort((left, right) => highProof(left) - highProof(right)
      || left.hops - right.hops
      || proofRank(left) - proofRank(right)
      || nameOverlap(right, anchors) - nameOverlap(left, anchors)
      || persistenceLayout(right.path) - persistenceLayout(left.path)
      || Number(layoutPrefix(left.path) === anchorPrefix) - Number(layoutPrefix(right.path) === anchorPrefix)
      || (left.hops >= 2 ? hop2KindRank(left) - hop2KindRank(right) : 0)
      || (left.hops >= 2 ? left.tokenCost - right.tokenCost : 0)
      || left.path.localeCompare(right.path)
      || left.id.localeCompare(right.id));
  const selected: EvidenceBundle[] = [];
  const rejectedOverBudget: EvidenceBundle[] = [];
  let hop2CallPacked = 0;
  let hop2PersistPacked = 0;
  for (const bundle of candidates.filter(isP0Bundle)) {
    selected.push(bundle);
  }
  for (const bundle of candidates.filter(item => !isP0Bundle(item))) {
    if (selected.length >= bundleGuard) break;
    if (bundle.hops > 3) continue;
    if (bundle.hops > 2 && !isPersistenceProof(bundle)) continue;
    if (isTestPath(bundle.path) || bundle.role === "TEST") continue;
    if (genericPersistenceCall(bundle)) continue;
    if (proofRank(bundle) >= 2 && bundle.tokenCost > MAX_LOW_PROOF_TOKENS && !isPersistenceProof(bundle)) continue;
    if (bundle.hops >= 2) {
      if (isPersistenceProof(bundle)) {
        if (hop2PersistPacked >= MAX_HOP2_PERSISTENCE) continue;
      } else if (bundle.proof.some(kind => kind.startsWith("CALLS_") || kind === "CALLED_BY")) {
        if (hop2CallPacked >= MAX_HOP2_CALLS) continue;
      }
    }
    if (marginalGain(bundle, selected) <= 0) continue;
    const used = tokenCostOf(selected);
    if (used + bundle.tokenCost > budget) {
      rejectedOverBudget.push(bundle);
      continue;
    }
    const files = filesOf(selected);
    if (!files.has(bundle.path) && files.size >= fileGuard) continue;
    selected.push(bundle);
    if (bundle.hops >= 2) {
      if (isPersistenceProof(bundle)) hop2PersistPacked += 1;
      else hop2CallPacked += 1;
    }
  }
  const merged = mergeSelectedByPath(selected);
  merged.sort((left, right) => left.hops - right.hops || left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
  return {
    selected: merged,
    rejectedOverBudget,
    covered: [...coveredBy(merged)].sort(),
    tokenCost: tokenCostOf(merged),
    distinctFiles: filesOf(merged).size
  };
}

function mergeSelectedByPath(selected: EvidenceBundle[]): EvidenceBundle[] {
  const byPath = new Map<string, EvidenceBundle>();
  for (const bundle of selected) {
    const hit = byPath.get(bundle.path);
    if (!hit) {
      byPath.set(bundle.path, { ...bundle, spans: bundle.spans.map(span => ({ ...span })), closes: [...bundle.closes], proof: [...bundle.proof] });
      continue;
    }
    hit.spans = mergeSpans([...hit.spans, ...bundle.spans]);
    hit.closes = [...new Set([...hit.closes, ...bundle.closes])];
    hit.proof = [...new Set([...hit.proof, ...bundle.proof])];
    hit.tokenCost = Math.max(1, bundleTokenCost(hit.spans, text => estimateTokens(text, BYTES_DIV_4)));
    hit.hops = Math.min(hit.hops, bundle.hops);
  }
  return [...byPath.values()];
}

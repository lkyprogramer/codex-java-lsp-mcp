// input: Planned bundles plus search metadata.
// output: §11.3 ContextContract. includeSource true/false share the same bundles.
// pos: JIN N4-03. No score/confidence leakage. CompactImpact mapping lives in the benchmark bridge.
import type { GraphSearchResult } from "./graph-search.js";
import type { EvidenceBundle } from "./evidence-bundle.js";
import type { PlanResult } from "./context-planner.js";
import { BYTES_DIV_4, estimateTokens, type Tokenizer } from "./token-estimator.js";
import { frontierCandidates, nextSteps } from "./context-candidates.js";
import {
  CONTEXT_CONTRACT_VERSION,
  PLANNER_VERSION,
  type ContextContract,
  type ContextItem,
  type SessionKey
} from "./context-contract.js";

export type SerializeInput = {
  plan: PlanResult;
  search: GraphSearchResult;
  includeSource: boolean;
  generation: number;
  serviceMs: number;
  tokenizer?: Tokenizer;
  resolvedAnchors?: ContextContract["resolvedAnchors"];
  session?: SessionKey;
};

function symbolOf(bundle: EvidenceBundle | undefined): string {
  const step = bundle?.provingPath[0];
  const id = step?.toId ?? step?.fromId ?? bundle?.path ?? "";
  const parts = id.split("#");
  return parts[2] || parts[1] || (bundle?.path.split("/").pop() ?? "unknown");
}

function contextItem(bundle: EvidenceBundle, includeSource: boolean): ContextItem {
  return {
    role: bundle.role,
    path: bundle.path,
    proof: bundle.proof.slice(0, 6),
    spans: bundle.spans.map(span => ({
      start: span.start,
      end: span.end,
      ...(includeSource && span.text !== undefined ? { text: span.text } : {})
    }))
  };
}

function leakKeys(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/score|confidence|rank|utility/i.test(key)) found.push(key);
    leakKeys(child, found);
  }
  return found;
}

export function serializeContext(input: SerializeInput): ContextContract {
  const tokenizer = input.tokenizer ?? BYTES_DIV_4;
  const selected = input.plan.selected.filter(bundle => bundle.spans.length > 0);
  const anchorBundle = selected.find(bundle => bundle.hops === 0) ?? selected[0];
  const known = new Map<string, string>();
  for (const item of input.search.unresolved) known.set(item.id, item.role);
  for (const bundle of input.search.bundles) {
    for (const id of bundle.closedObligations) {
      if (!known.has(id)) known.set(id, id);
    }
  }
  const unresolved = [...known.entries()]
    .filter(([id]) => !input.plan.covered.includes(id))
    .map(([id, role]) => ({ id, role }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const honestCoverage: "COMPLETE" | "PARTIAL" = unresolved.length === 0 && selected.length > 0 ? "COMPLETE" : "PARTIAL";
  const evidence = selected.map(bundle => contextItem(bundle, input.includeSource));
  const candidates = frontierCandidates(input.search.bundles);
  const contract: ContextContract = {
    version: CONTEXT_CONTRACT_VERSION,
    generation: input.generation,
    coverage: honestCoverage,
    resolvedIntent: input.search.resolvedIntent,
    resolvedAnchors: input.resolvedAnchors ?? (anchorBundle
      ? [{ path: anchorBundle.path, symbol: symbolOf(anchorBundle), layer: "graph" }]
      : []),
    anchor: {
      path: anchorBundle?.path ?? "",
      symbol: symbolOf(anchorBundle)
    },
    evidence,
    candidates,
    contexts: evidence,
    unresolved,
    next: nextSteps({
      unresolved,
      candidates,
      evidence,
      anchorPath: anchorBundle?.path ?? ""
    }),
    cost: {
      modelTokens: estimateTokens(JSON.stringify({
        evidence,
        candidates,
        unresolved
      }), tokenizer) + selected.reduce((sum, bundle) => sum + bundle.tokenCost, 0),
      serviceMs: Math.max(0, Math.round(input.serviceMs))
    },
    ...(input.session
      ? { session: { sessionId: input.session.sessionId, generation: input.session.generation, repoHash: input.session.repoHash, plannerVersion: input.session.plannerVersion || PLANNER_VERSION } }
      : {})
  };
  const leaked = leakKeys(contract);
  if (leaked.length > 0) {
    throw new Error(`context contract leaked score fields: ${leaked.join(",")}`);
  }
  return contract;
}

export function sourceParity(withSource: ContextContract, withoutSource: ContextContract): boolean {
  const leftItems = withSource.evidence ?? withSource.contexts;
  const rightItems = withoutSource.evidence ?? withoutSource.contexts;
  if (leftItems.length !== rightItems.length) return false;
  for (let index = 0; index < leftItems.length; index += 1) {
    const left = leftItems[index]!;
    const right = rightItems[index]!;
    if (left.path !== right.path || left.role !== right.role) return false;
    if (JSON.stringify(left.proof) !== JSON.stringify(right.proof)) return false;
    if (left.spans.length !== right.spans.length) return false;
    for (let span = 0; span < left.spans.length; span += 1) {
      if (left.spans[span]!.start !== right.spans[span]!.start) return false;
      if (left.spans[span]!.end !== right.spans[span]!.end) return false;
      if (right.spans[span]!.text !== undefined) return false;
    }
  }
  return true;
}

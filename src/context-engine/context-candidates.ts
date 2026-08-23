// input: Graph-search frontier bundles plus packed evidence paths.
// output: Path-level candidates[] and copy-pasteable next[] for the C1 contract.
// pos: JIN harvest C1. Does not rank, pack, or change graph search.
import type { EvidenceBundleCandidate } from "./graph-search.js";
import type { ContextCandidate, ContextNext } from "./context-contract.js";

export const CANDIDATE_FRONTIER_N = 24;
export const CANDIDATE_FRONTIER_N_MAX = 40;

export function symbolFromNodeId(id: string): string {
  const parts = String(id).split("#");
  const type = parts[1] || "";
  const method = parts[2] || "";
  if (type && method) return `${type}.${method}`;
  if (type) return type;
  const base = String(id).split("/").pop() ?? String(id);
  return base.replace(/\.java$/i, "") || String(id);
}

export function candidateRole(bundle: Pick<EvidenceBundleCandidate, "hops" | "provingPath">): string {
  if (bundle.hops === 0) return "ANCHOR";
  const kinds = (bundle.provingPath ?? []).map(step => step.kind);
  if (kinds.some(kind => kind.startsWith("MYBATIS") || kind === "JPA_RELATION" || kind === "REPOSITORY_MANAGES_ENTITY" || kind === "SQL_TOUCHES_TABLE")) {
    return "PERSISTENCE";
  }
  if (kinds.some(kind => kind.startsWith("SPRING") || kind === "PUBLISHES_EVENT" || kind === "CONSUMES_EVENT")) {
    return "FRAMEWORK";
  }
  if (kinds.some(kind => kind.startsWith("TEST") || kind === "MOCKS_TYPE" || kind === "USES_FIXTURE")) return "TEST";
  if (kinds.includes("IMPLEMENTS") || kinds.includes("DISPATCHES_TO") || kinds.includes("PERMITS")) return "IMPLEMENTATION";
  if (kinds.includes("CALLED_BY")) return "CALLER";
  if (kinds.some(kind => kind.startsWith("CALLS") || kind === "CONSTRUCTS" || kind === "METHOD_REFERENCE")) return "CALLEE";
  if (kinds.some(kind => kind === "EXTENDS" || kind === "DECLARES" || kind === "IMPORTS")) return "CONTRACT";
  return "DATAFLOW";
}

export function candidateReason(bundle: EvidenceBundleCandidate): string {
  const step = bundle.provingPath?.[0];
  if (!step) return bundle.hops === 0 ? "ANCHOR" : "DISCOVERED";
  return `${step.kind}←${symbolFromNodeId(step.fromId)}`;
}

export function frontierCandidates(
  bundles: EvidenceBundleCandidate[],
  limit = CANDIDATE_FRONTIER_N
): ContextCandidate[] {
  const byPath = new Map<string, EvidenceBundleCandidate>();
  for (const bundle of bundles ?? []) {
    if (typeof bundle?.path !== "string" || !bundle.path) continue;
    const existing = byPath.get(bundle.path);
    if (!existing || bundle.hops < existing.hops) byPath.set(bundle.path, bundle);
  }
  const cap = Math.min(CANDIDATE_FRONTIER_N_MAX, Math.max(0, limit));
  return [...byPath.values()]
    .sort((left, right) => left.hops - right.hops || left.path.localeCompare(right.path))
    .slice(0, cap)
    .map(bundle => ({
      path: bundle.path,
      role: candidateRole(bundle),
      hop: bundle.hops,
      reason: candidateReason(bundle)
    }));
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.endsWith(".java");
}

export function nextSteps(input: {
  unresolved: Array<{ id: string; role: string }>;
  candidates: ContextCandidate[];
  evidence: Array<{ path: string }>;
  anchorPath: string;
}): ContextNext[] {
  const packed = new Set((input.evidence ?? []).map(item => item.path));
  const unused = (input.candidates ?? []).filter(item => !packed.has(item.path));
  return (input.unresolved ?? []).slice(0, 8).map((item, index) => {
    const fromId = looksLikePath(item.id) ? item.id : undefined;
    const fallback = unused[index] ?? unused[0];
    const file = fromId ?? fallback?.path ?? input.anchorPath ?? "";
    const cand = (input.candidates ?? []).find(row => row.path === file);
    const direction = cand?.role === "CALLER" ? "callers" as const : cand?.role === "CALLEE" ? "callees" as const : undefined;
    const closure = cand?.role === "PERSISTENCE" ? "persistence" as const : cand?.role === "FRAMEWORK" ? "framework" as const : undefined;
    return {
      action: file && !packed.has(file) ? "navigate" : "expand",
      file,
      line: 1,
      ...(direction ? { direction } : {}),
      ...(closure ? { closure } : {}),
      reason: item.role
    };
  });
}

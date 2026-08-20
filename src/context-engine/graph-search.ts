// input: Knowledge graph, compiled intent, budgets, and an anchor file.
// output: Evidence-bundle candidates with proving paths, unresolved obligations, and metrics.
// pos: N3-02. One RPC path; no provider pipeline. Planner selection stays N4.
import type { EdgeKind } from "../java-knowledge/edge-kinds.js";
import type { GraphEdge } from "../java-knowledge/schema.js";
import type { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";
import type { CompiledIntent } from "./intent-compiler.js";
import type { Obligation } from "./obligations.js";
import { pathCost } from "./path-cost.js";

export type GraphSearchBudgets = {
  maxHops: number;
  maxExpansions: number;
  tokenBudget: number;
};

export type EvidenceBundleCandidate = {
  path: string;
  hops: number;
  estimatedTokens: number;
  provingPath: Array<{ kind: EdgeKind; fromId: string; toId: string }>;
  closedObligations: string[];
};

export type GraphSearchResult = {
  resolvedIntent: CompiledIntent["resolvedIntent"];
  coverage: "COMPLETE" | "PARTIAL";
  bundles: EvidenceBundleCandidate[];
  unresolved: Array<{ id: string; role: string }>;
  metrics: { expansions: number; hops: number; estimatedTokens: number };
};

const NON_BUNDLE_PATH_KINDS = new Set(["REPOSITORY", "MODULE", "SOURCE_ROOT", "PARAMETER", "LOCAL", "STATEMENT", "CONFIG_KEY"]);

function fileOf(graph: KnowledgeGraphStore, nodeId: string): string | undefined {
  const node = graph.nodesById.get(nodeId);
  if (!node || NON_BUNDLE_PATH_KINDS.has(node.kind)) return undefined;
  if (node.relativePath) return node.relativePath;
  if (node.kind === "FILE") return node.id;
  return undefined;
}

function moduleOf(graph: KnowledgeGraphStore, nodeId: string): string | undefined {
  const path = fileOf(graph, nodeId);
  if (!path) return undefined;
  const hit = path.match(/^([^/]+)\//);
  return hit?.[1];
}

function closes(obligation: Obligation, kind: EdgeKind): boolean {
  return obligation.edgeKinds.includes(kind);
}

const DEFAULT_BUDGETS: GraphSearchBudgets = { maxHops: 3, maxExpansions: 4096, tokenBudget: 12000 };

export function searchContextGraph(
  graph: KnowledgeGraphStore,
  startRelativePath: string,
  compiled: CompiledIntent,
  budgets: Partial<GraphSearchBudgets> = {},
  restrictToObligationKinds = false,
  startNodeIds?: readonly string[]
): GraphSearchResult {
  const maxHops = Math.min(8, Math.max(0, budgets.maxHops ?? DEFAULT_BUDGETS.maxHops));
  const maxExpansions = Math.min(2048, Math.max(1, budgets.maxExpansions ?? DEFAULT_BUDGETS.maxExpansions));
  const tokenBudget = Math.max(256, budgets.tokenBudget ?? DEFAULT_BUDGETS.tokenBudget);
  const pathNodes = [...graph.nodesById.entries()]
    .filter(([id, node]) => node.relativePath === startRelativePath || id === startRelativePath)
    .map(([id]) => id);
  const scoped = (startNodeIds ?? []).filter(id => graph.nodesById.has(id));
  const startNodes = scoped.length > 0 ? scoped : pathNodes;
  const bundles = new Map<string, EvidenceBundleCandidate>();
  const closed = new Set<string>();
  let expansions = 0;
  let deepest = 0;
  if (pathNodes.length > 0) {
    bundles.set(startRelativePath, {
      path: startRelativePath,
      hops: 0,
      estimatedTokens: 64,
      provingPath: [],
      closedObligations: compiled.obligations.filter(item => item.role === "anchor-method").map(item => item.id)
    });
    for (const id of compiled.obligations.filter(item => item.role === "anchor-method").map(item => item.id)) closed.add(id);
  }
  type Frame = { id: string; hop: number; cost: number; path: GraphEdge[]; closed: string[] };
  const queue: Frame[] = startNodes.map(id => ({ id, hop: 0, cost: 0, path: [], closed: [...closed] }));
  const seen = new Set(startNodes);
  while (queue.length > 0 && expansions < maxExpansions) {
    queue.sort((left, right) => left.cost - right.cost);
    const current = queue.shift()!;
    if (current.hop >= maxHops) continue;
    const allowed = new Set(compiled.obligations.flatMap(item => item.edgeKinds));
    const neighbors = [...graph.successors(current.id), ...graph.predecessors(current.id)];
    const edges = restrictToObligationKinds ? neighbors.filter(edge => allowed.has(edge.kind)) : neighbors;
    for (const edge of edges) {
      if (expansions >= maxExpansions) break;
      const nextId = edge.fromId === current.id ? edge.toId : edge.fromId;
      if (seen.has(nextId)) continue;
      const nextNode = graph.nodesById.get(nextId);
      if (nextNode && NON_BUNDLE_PATH_KINDS.has(nextNode.kind)) {
        seen.add(nextId);
        continue;
      }
      seen.add(nextId);
      expansions += 1;
      const hop = current.hop + 1;
      deepest = Math.max(deepest, hop);
      const newlyClosed = compiled.obligations.filter(item => closes(item, edge.kind)).map(item => item.id);
      for (const id of newlyClosed) closed.add(id);
      const nextClosed = [...new Set([...current.closed, ...newlyClosed])];
      const cost = current.cost + pathCost({
        kind: edge.kind,
        hop,
        crossModule: moduleOf(graph, current.id) !== moduleOf(graph, nextId),
        closesObligation: newlyClosed.length > 0,
        lexicalMatch: false
      });
      const nextPath = [...current.path, edge];
      const file = fileOf(graph, nextId);
      if (file && !bundles.has(file)) {
        const estimatedTokens = Math.min(400, 48 + nextPath.length * 24);
        bundles.set(file, {
          path: file,
          hops: hop,
          estimatedTokens,
          provingPath: nextPath.map(item => ({ kind: item.kind, fromId: item.fromId, toId: item.toId })),
          closedObligations: newlyClosed.length > 0 ? [...new Set(newlyClosed)] : nextClosed
        });
      }
      queue.push({ id: nextId, hop, cost, path: nextPath, closed: nextClosed });
    }
  }
  const ordered = [...bundles.values()].sort((left, right) => left.hops - right.hops || left.path.localeCompare(right.path));
  const tokens = ordered.reduce((sum, bundle) => sum + bundle.estimatedTokens, 0);
  const capped = ordered;
  const unresolved = compiled.obligations.filter(item => !closed.has(item.id)).map(item => ({ id: item.id, role: item.role }));
  return {
    resolvedIntent: compiled.resolvedIntent,
    coverage: unresolved.length === 0 ? "COMPLETE" : "PARTIAL",
    bundles: capped,
    unresolved,
    metrics: { expansions, hops: deepest, estimatedTokens: tokens }
  };
}

export function navigateGraph(
  graph: KnowledgeGraphStore,
  startRelativePath: string,
  options: { direction?: "callers" | "callees"; closure?: "persistence" | "framework"; maxHops?: number }
): GraphSearchResult {
  const compiled: CompiledIntent = options.direction === "callers"
    ? { requested: "UPSTREAM_IMPACT", resolvedIntent: "UPSTREAM_IMPACT", obligations: [{ id: "O1", role: "direct-callers", edgeKinds: ["CALLED_BY"] }] }
    : options.direction === "callees"
      ? { requested: "DOWNSTREAM_BEHAVIOR", resolvedIntent: "DOWNSTREAM_BEHAVIOR", obligations: [{ id: "O1", role: "callees", edgeKinds: ["CALLS_EXACT", "CALLS_VIRTUAL", "DISPATCHES_TO", "CONSTRUCTS"] }] }
      : options.closure === "persistence"
        ? { requested: "PERSISTENCE_FLOW", resolvedIntent: "PERSISTENCE_FLOW", obligations: [{ id: "O1", role: "entity", edgeKinds: ["MYBATIS_METHOD_BINDS_STATEMENT", "MYBATIS_STATEMENT_USES_ENTITY", "REPOSITORY_MANAGES_ENTITY", "JPA_RELATION"] }] }
        : { requested: "FRAMEWORK_WIRING", resolvedIntent: "FRAMEWORK_WIRING", obligations: [{ id: "O1", role: "inject", edgeKinds: ["SPRING_INJECTS", "PUBLISHES_EVENT", "CONSUMES_EVENT", "SPRING_BEAN_BINDS_TO"] }] };
  const result = searchContextGraph(graph, startRelativePath, compiled, { maxHops: Math.min(2, options.maxHops ?? 2), maxExpansions: 64, tokenBudget: 2048 }, true);
  return { ...result, bundles: result.bundles.map(bundle => ({ ...bundle, provingPath: bundle.provingPath.slice(0, 6) })) };
}

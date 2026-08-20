// input: Graph search result, JavaIndex-like path facts, token budget.
// output: Planned ContextContract. One worker-side planning step after QUERY_CONTEXT_GRAPH search.
// pos: JIN N4-02/03. Benchmark-only until N5 registers java_context.
import type { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";
import type { JavaIndexStore } from "../java-index/index-store.js";
import type { GraphSearchResult } from "./graph-search.js";
import { closeSearchResult, type ClosureFacts } from "./context-closure.js";
import { planEvidenceBundles, DEFAULT_TOKEN_BUDGET } from "./context-planner.js";
import { serializeContext } from "./context-serializer.js";
import { PLANNER_VERSION, StaleSessionError, contextSessions, type ContextContract, type SessionKey } from "./context-contract.js";
import type { SliceMethod } from "./statement-slicer.js";

export type PlanQueryInput = {
  graph: KnowledgeGraphStore;
  store?: JavaIndexStore;
  search: GraphSearchResult;
  tokenBudget?: number;
  includeSource?: boolean;
  generation?: number;
  serviceMs?: number;
  anchorLine?: number;
  session?: SessionKey;
};

function methodsFromStore(store: JavaIndexStore, path: string, graph: KnowledgeGraphStore, provingIds: Set<string>, anchorLine?: number): SliceMethod[] {
  const bundle = store.files([path])[0];
  if (!bundle) return [];
  const wanted = new Set<string>();
  for (const id of provingIds) {
    const node = graph.nodesById.get(id);
    if (node?.javaIndexId && node.relativePath === path) wanted.add(node.javaIndexId);
  }
  const matched = bundle.methods.filter(method => wanted.has(method.methodId));
  const anchored = anchorLine
    ? bundle.methods.filter(method => method.range.start.line <= anchorLine && (method.bodyRange?.end.line ?? method.range.end.line) >= anchorLine)
    : [];
  const chosen = matched.length > 0 ? matched : anchored.length > 0 ? anchored : bundle.methods;
  return chosen.map(method => ({
    name: method.name,
    startLine: method.range.start.line,
    endLine: Math.max(method.range.end.line, method.bodyRange?.end.line ?? method.range.end.line),
    bodyStartLine: method.bodyRange?.start.line,
    callSites: method.callSites.map(site => ({ line: site.range.start.line, name: site.name }))
  }));
}

export function factsForStore(graph: KnowledgeGraphStore, store: JavaIndexStore | undefined, path: string, provingIds: Set<string>, anchorLine?: number): ClosureFacts {
  if (!store) return { methods: [] };
  const resource = store.myBatisResource(path);
  const names: string[] = [];
  for (const id of provingIds) {
    const node = graph.nodesById.get(id);
    if (node?.simpleName) names.push(node.simpleName);
  }
  return {
    methods: methodsFromStore(store, path, graph, provingIds, anchorLine),
    xml: resource?.statements
      .filter(statement => statement.range)
      .map(statement => ({ start: statement.range!.start.line, end: statement.range!.end.line })),
    simpleNames: names
  };
}

export function planContextQuery(input: PlanQueryInput): ContextContract {
  const sessionKey = input.session
    ? { ...input.session, plannerVersion: input.session.plannerVersion || PLANNER_VERSION }
    : undefined;
  if (sessionKey) {
    const existing = contextSessions.lookup(sessionKey);
    if (existing === "STALE") throw new StaleSessionError("STALE_SESSION");
    if (existing) return existing;
  }
  const proving = (path: string) => {
    const candidate = input.search.bundles.find(item => item.path === path);
    const ids = new Set<string>();
    for (const step of candidate?.provingPath ?? []) {
      ids.add(step.fromId);
      ids.add(step.toId);
    }
    return ids;
  };
  const closed = closeSearchResult({
    search: input.search,
    factsForPath: path => factsForStore(input.graph, input.store, path, proving(path), path === input.search.bundles.find(item => item.hops === 0)?.path ? input.anchorLine : undefined),
    includeSource: input.includeSource === true,
    anchorLine: input.anchorLine
  });
  const plan = planEvidenceBundles({
    bundles: closed,
    tokenBudget: input.tokenBudget ?? DEFAULT_TOKEN_BUDGET
  });
  const contract = serializeContext({
    plan,
    search: input.search,
    includeSource: input.includeSource === true,
    generation: input.generation ?? 0,
    serviceMs: input.serviceMs ?? 0,
    session: input.session
  });
  if (input.session) {
    contextSessions.save({ ...input.session, plannerVersion: input.session.plannerVersion || PLANNER_VERSION }, contract);
  }
  return contract;
}

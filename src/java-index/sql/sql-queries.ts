import { compileIntent } from "../../context-engine/intent-compiler.js";
import { navigateGraph, searchContextGraph } from "../../context-engine/graph-search.js";
import { shouldLexicalFallback } from "../../context-engine/lexical-fallback.js";
import { shouldEscalateToJdt } from "../../context-engine/semantic-escalation.js";
import { PLANNER_VERSION } from "../../context-engine/context-contract.js";
import { anchorMethodStartIds, attachAnchorSignatureBundles, planContextQuery } from "../../context-engine/plan-query.js";
import { reachableFiles } from "../../java-knowledge/graph-walk.js";
import type { GraphReader } from "../../java-knowledge/graph-reader.js";
import type { FactsReader } from "../facts-reader.js";
import {
  ENTITY_SEARCH_DEFAULT_LIMIT,
  ENTITY_SEARCH_MAX_LIMIT,
  type EntityHit
} from "../entity-search.js";
import type { JavaIndexClientApi } from "../java-index-client-api.js";
import type { ContextGraphResult, GraphDigest, GraphReachable } from "../worker-protocol.js";

export type EntitySearchPort = {
  search(task: string, limit?: number): EntityHit[];
};

export type SqlQueryDeps = {
  store: FactsReader;
  graph: GraphReader;
  search: EntitySearchPort;
  indexedGeneration: number;
  toRelative(inputPath: string): string;
};

export type ContextGraphInput = Parameters<JavaIndexClientApi["queryContextGraph"]>[0];

function relativePathOf(deps: SqlQueryDeps, inputPath: string): string {
  const relative = deps.toRelative(inputPath);
  return relative.length > 0 ? relative : inputPath.replaceAll("\\", "/");
}

export function queryGraphDigest(deps: SqlQueryDeps): GraphDigest {
  const memory = process.memoryUsage();
  return {
    digest: deps.graph.digest(),
    generation: deps.graph.generation,
    nodes: deps.graph.nodesById.size,
    edges: deps.graph.edgesById.size,
    heapUsedBytes: memory.heapUsed,
    rssBytes: memory.rss
  };
}

export function queryGraphReachable(deps: SqlQueryDeps, fromRelativePath: string, maxHops: number): GraphReachable {
  const relativePath = relativePathOf(deps, fromRelativePath);
  const hops = Math.min(8, Math.max(0, Math.floor(maxHops)));
  return reachableFiles(deps.graph, relativePath, hops);
}

export function queryEntitySearch(
  deps: SqlQueryDeps,
  task: string,
  limit = ENTITY_SEARCH_DEFAULT_LIMIT
): EntityHit[] {
  const cap = Math.min(
    ENTITY_SEARCH_MAX_LIMIT,
    Math.max(1, Number.isFinite(limit) ? Number(limit) : ENTITY_SEARCH_DEFAULT_LIMIT)
  );
  return deps.search.search(task, cap);
}

export function queryContextGraph(deps: SqlQueryDeps, input: ContextGraphInput): ContextGraphResult {
  const graph = deps.graph;
  const relativePath = relativePathOf(deps, input.fromRelativePath);
  const compiled = compileIntent(input.intent, {
    taskText: input.taskText,
    profile: input.profile,
    relativePath
  });
  let result = input.mode === "navigate"
    ? navigateGraph(graph, relativePath, {
      direction: input.direction,
      closure: input.closure,
      maxHops: input.maxHops
    })
    : searchContextGraph(graph, relativePath, compiled, {
      maxHops: input.maxHops,
      maxExpansions: input.maxExpansions,
      tokenBudget: input.tokenBudget
    }, false, anchorMethodStartIds(graph, deps.store, relativePath, input.anchorLine));
  if (input.mode !== "navigate" && shouldLexicalFallback(result, input.taskText ?? "")) {
    const hits = deps.search.search(input.taskText ?? "", 5);
    for (const hit of hits) {
      if (result.bundles.some(bundle => bundle.path === hit.relativePath)) continue;
      result.bundles.push({
        path: hit.relativePath,
        hops: 1,
        estimatedTokens: 48,
        provingPath: [],
        closedObligations: []
      });
    }
  }
  if (input.mode !== "navigate") {
    result = attachAnchorSignatureBundles(result, graph, deps.store, relativePath, input.anchorLine);
  }
  shouldEscalateToJdt({ unresolvedRoles: result.unresolved.map(item => item.role), jdtlsBin: process.env.JDTLS_BIN });
  if (!input.plan) return result;
  const contract = planContextQuery({
    graph,
    store: deps.store,
    search: result,
    tokenBudget: input.tokenBudget,
    includeSource: input.includeSource === true,
    generation: deps.indexedGeneration,
    anchorLine: input.anchorLine,
    session: input.sessionId
      ? {
        sessionId: input.sessionId,
        generation: input.generation ?? deps.indexedGeneration,
        repoHash: input.repoHash ?? "",
        plannerVersion: PLANNER_VERSION
      }
      : undefined
  });
  return { ...result, contract };
}

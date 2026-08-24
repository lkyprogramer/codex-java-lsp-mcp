// input: QUERY_* worker requests plus the live store/status helpers.
// output: true when the command was a query and has been answered.
// pos: Command-domain split of java-index-worker.ts query handlers.
import type { JavaIndexRequest, JavaIndexResponse } from "./worker-protocol.js";
import type { JavaIndexStatus, JavaTypeLookupResult, SourceRootCoverage } from "./index-types.js";
import type { JavaIndexStore } from "./index-store.js";
import { ENTITY_SEARCH_DEFAULT_LIMIT, ENTITY_SEARCH_MAX_LIMIT, type EntitySearchIndex } from "./entity-search.js";
import type { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";
import { reachableFiles } from "../java-knowledge/graph-walk.js";
import { compileIntent } from "../context-engine/intent-compiler.js";
import { navigateGraph, searchContextGraph } from "../context-engine/graph-search.js";
import { lexicalFallbackHits, shouldLexicalFallback } from "../context-engine/lexical-fallback.js";
import { shouldEscalateToJdt } from "../context-engine/semantic-escalation.js";
import { anchorMethodStartIds, attachAnchorSignatureBundles, planContextQuery } from "../context-engine/plan-query.js";
import { PLANNER_VERSION } from "../context-engine/context-contract.js";

export type QueryHandlerDeps = {
  store?: JavaIndexStore;
  status: JavaIndexStatus;
  deriveSourceLayout(inputPath: string): { relativePath: string };
  queryReadRanges(requests: Array<{ file: string; positions: Array<{ line: number; column: number }> }>): Promise<unknown>;
  coverageStateFor(root: string, generation: number): SourceRootCoverage["state"];
  worstTypeLookupCoverage(generation: number): "COMPLETE" | "PARTIAL" | "DEGRADED";
  unresolvedTypeLookup(): JavaTypeLookupResult;
  readyEntitySearch(): EntitySearchIndex;
  readyKnowledgeGraph(): KnowledgeGraphStore;
  graphIsReady(): boolean;
  peekGraphSnapshot(): Promise<{ digest: string; generation: number; nodes: unknown[]; edges: unknown[] } | undefined>;
  ensureFactsHydrated(): Promise<void>;
  ensureGraphReady(): Promise<void>;
  childColdPeakRssBytes?: number;
  parentColdIncrementBytes?: number;
  respond(response: JavaIndexResponse): void;
};

const FACT_QUERY_TYPES = new Set([
  "QUERY_ANCHOR",
  "QUERY_TYPE",
  "QUERY_TYPES",
  "QUERY_FILES",
  "QUERY_READ_RANGES",
  "QUERY_IMPLEMENTERS",
  "QUERY_TYPE_REFERENCERS",
  "QUERY_CALLERS",
  "QUERY_CALLEES",
  "QUERY_CALLEES_BATCH",
  "QUERY_METHODS_WITH_PARAMETER_TYPES",
  "QUERY_CONTEXT_GRAPH",
  "QUERY_ENTITY_SEARCH",
  "QUERY_GRAPH_REACHABLE",
  "QUERY_REPOSITORY_FACT_MARKERS"
]);

export async function handleQueryCommand(request: JavaIndexRequest, deps: QueryHandlerDeps): Promise<boolean> {
  if (FACT_QUERY_TYPES.has(request.type)) await deps.ensureFactsHydrated();
  switch (request.type) {
    case "QUERY_ANCHOR": {
      let relativePath: string | undefined;
      try {
        relativePath = deps.deriveSourceLayout(request.file).relativePath;
      } catch {
        relativePath = undefined;
      }
      const anchor = relativePath ? deps.store?.anchor(relativePath, request.line, request.column) : undefined;
      const value = anchor
        ? { ...anchor, coverage: deps.coverageStateFor(anchor.file.sourceRoot, deps.status.indexedGeneration) }
        : undefined;
      deps.respond({ id: request.id, ok: true, value });
      return true;
    }
    case "QUERY_TYPE": {
      const scopeFile = request.scopeFile ? deps.deriveSourceLayout(request.scopeFile).relativePath : undefined;
      const result = deps.store ? deps.store.typeLookup(request.typeText, scopeFile) : deps.unresolvedTypeLookup();
      const value = result.state === "UNRESOLVED"
        ? { ...result, coverage: deps.worstTypeLookupCoverage(deps.status.indexedGeneration) }
        : result;
      deps.respond({ id: request.id, ok: true, value });
      return true;
    }
    case "QUERY_TYPES": {
      const value = request.queries.map(query => {
        const scopeFile = query.scopeFile ? deps.deriveSourceLayout(query.scopeFile).relativePath : undefined;
        const result = deps.store ? deps.store.typeLookup(query.typeText, scopeFile) : deps.unresolvedTypeLookup();
        return result.state === "UNRESOLVED"
          ? { ...result, coverage: deps.worstTypeLookupCoverage(deps.status.indexedGeneration) }
          : result;
      });
      deps.respond({ id: request.id, ok: true, value });
      return true;
    }
    case "QUERY_IMPLEMENTERS": {
      deps.respond({ id: request.id, ok: true, value: deps.store?.implementers(request.typeId, request.limit) ?? [] });
      return true;
    }
    case "QUERY_TYPE_REFERENCERS": {
      deps.respond({
        id: request.id,
        ok: true,
        value: deps.store?.typeReferencers(request.typeId, new Set(request.edgeKinds), request.limit) ?? []
      });
      return true;
    }
    case "QUERY_CALLERS": {
      deps.respond({ id: request.id, ok: true, value: deps.store?.callers(request.methodId, request.limit) ?? [] });
      return true;
    }
    case "QUERY_CALLEES": {
      deps.respond({ id: request.id, ok: true, value: deps.store?.callees(request.methodId, request.limit) ?? [] });
      return true;
    }
    case "QUERY_CALLEES_BATCH": {
      deps.respond({
        id: request.id,
        ok: true,
        value: request.methodIds.map(methodId => ({ methodId, callees: deps.store?.callees(methodId, request.limit) ?? [] }))
      });
      return true;
    }
    case "QUERY_METHODS_WITH_PARAMETER_TYPES": {
      deps.respond({
        id: request.id,
        ok: true,
        value: deps.store?.methodsWithParameterTypes(request.typeIds, request.limit) ?? []
      });
      return true;
    }
    case "QUERY_FILES": {
      const relativePaths = request.files
        .map(inputPath => {
          try {
            return deps.deriveSourceLayout(inputPath).relativePath;
          } catch {
            return undefined;
          }
        })
        .filter((relativePath): relativePath is string => relativePath !== undefined);
      deps.respond({ id: request.id, ok: true, value: deps.store?.files(relativePaths) ?? [] });
      return true;
    }
    case "QUERY_READ_RANGES": {
      deps.respond({ id: request.id, ok: true, value: await deps.queryReadRanges(request.requests) });
      return true;
    }
    case "QUERY_GRAPH_DIGEST": {
      let digest = "";
      let generation = 0;
      let nodes = 0;
      let edges = 0;
      if (deps.graphIsReady()) {
        const graph = deps.readyKnowledgeGraph();
        digest = graph.digest();
        generation = graph.generation;
        nodes = graph.nodesById.size;
        edges = graph.edgesById.size;
      } else {
        const packed = await deps.peekGraphSnapshot();
        if (packed) {
          digest = packed.digest;
          generation = packed.generation;
          nodes = packed.nodes.length;
          edges = packed.edges.length;
        }
      }
      const gcFn = (globalThis as typeof globalThis & { gc?: () => void }).gc;
      if (typeof gcFn === "function") gcFn();
      const memory = process.memoryUsage();
      deps.respond({
        id: request.id,
        ok: true,
        value: {
          digest,
          generation,
          nodes,
          edges,
          heapUsedBytes: memory.heapUsed,
          rssBytes: memory.rss,
          ...(deps.childColdPeakRssBytes !== undefined ? { childColdPeakRssBytes: deps.childColdPeakRssBytes } : {}),
          ...(deps.parentColdIncrementBytes !== undefined ? { parentColdIncrementBytes: deps.parentColdIncrementBytes } : {})
        }
      });
      return true;
    }
    case "QUERY_GRAPH_REACHABLE": {
      await deps.ensureGraphReady();
      const graph = deps.readyKnowledgeGraph();
      let relativePath = request.fromRelativePath;
      try {
        relativePath = deps.deriveSourceLayout(request.fromRelativePath).relativePath;
      } catch {
        relativePath = request.fromRelativePath.replaceAll("\\", "/");
      }
      const maxHops = Math.min(8, Math.max(0, Math.floor(request.maxHops)));
      deps.respond({ id: request.id, ok: true, value: reachableFiles(graph, relativePath, maxHops) });
      return true;
    }
    case "QUERY_CONTEXT_GRAPH": {
      await deps.ensureGraphReady();
      const graph = deps.readyKnowledgeGraph();
      let relativePath = request.fromRelativePath;
      try {
        relativePath = deps.deriveSourceLayout(request.fromRelativePath).relativePath;
      } catch {
        relativePath = request.fromRelativePath.replaceAll("\\", "/");
      }
      const compiled = compileIntent(request.intent, { taskText: request.taskText, profile: request.profile, relativePath });
      let result = request.mode === "navigate"
        ? navigateGraph(graph, relativePath, { direction: request.direction, closure: request.closure, maxHops: request.maxHops })
        : searchContextGraph(graph, relativePath, compiled, {
          maxHops: request.maxHops,
          maxExpansions: request.maxExpansions,
          tokenBudget: request.tokenBudget
        }, false, anchorMethodStartIds(graph, deps.store, relativePath, request.anchorLine));
      if (request.mode !== "navigate" && shouldLexicalFallback(result, request.taskText ?? "")) {
        const hits = lexicalFallbackHits(deps.readyEntitySearch(), request.taskText ?? "", 5);
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
      if (request.mode !== "navigate") {
        result = attachAnchorSignatureBundles(result, graph, deps.store, relativePath, request.anchorLine);
      }
      shouldEscalateToJdt({ unresolvedRoles: result.unresolved.map(item => item.role), jdtlsBin: process.env.JDTLS_BIN });
      if (request.plan) {
        const contract = planContextQuery({
          graph,
          store: deps.store,
          search: result,
          tokenBudget: request.tokenBudget,
          includeSource: request.includeSource === true,
          generation: deps.status.indexedGeneration,
          anchorLine: request.anchorLine,
          session: request.sessionId
            ? {
              sessionId: request.sessionId,
              generation: request.generation ?? deps.status.indexedGeneration,
              repoHash: request.repoHash ?? "",
              plannerVersion: PLANNER_VERSION
            }
            : undefined
        });
        deps.respond({ id: request.id, ok: true, value: { ...result, contract } });
        return true;
      }
      deps.respond({ id: request.id, ok: true, value: result });
      return true;
    }
    case "QUERY_ENTITY_SEARCH": {
      const limit = Math.min(
        ENTITY_SEARCH_MAX_LIMIT,
        Math.max(1, Number.isFinite(request.limit) ? Number(request.limit) : ENTITY_SEARCH_DEFAULT_LIMIT)
      );
      deps.respond({ id: request.id, ok: true, value: deps.readyEntitySearch().search(request.task, limit) });
      return true;
    }
    default:
      return false;
  }
}

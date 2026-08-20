// input: QUERY_* worker requests plus the live store/status helpers.
// output: true when the command was a query and has been answered.
// pos: Command-domain split of java-index-worker.ts query handlers.
import type { JavaIndexRequest, JavaIndexResponse } from "./worker-protocol.js";
import type { JavaIndexStatus, JavaTypeLookupResult, SourceRootCoverage } from "./index-types.js";
import type { JavaIndexStore } from "./index-store.js";
import { ENTITY_SEARCH_DEFAULT_LIMIT, ENTITY_SEARCH_MAX_LIMIT, type EntitySearchIndex } from "./entity-search.js";
import type { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";

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
  respond(response: JavaIndexResponse): void;
};

export async function handleQueryCommand(request: JavaIndexRequest, deps: QueryHandlerDeps): Promise<boolean> {
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
      const graph = deps.readyKnowledgeGraph();
      const memory = process.memoryUsage();
      deps.respond({
        id: request.id,
        ok: true,
        value: {
          digest: graph.digest(),
          generation: graph.generation,
          nodes: graph.nodesById.size,
          edges: graph.edgesById.size,
          heapUsedBytes: memory.heapUsed,
          rssBytes: memory.rss
        }
      });
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

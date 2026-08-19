// input: A prepare/expand LSP pair plus depth/limit bounds.
// output: Hierarchy roots/edges with COMPLETE or classified partial completion.
// pos: Extracted BFS traversal from JdtlsSession. Containment is applied before
//      an edge is stored or queued, so out-of-repo types never enter the walk.
import type { Completion } from "./runtime/completion.js";
import type { DeadlineBudget } from "./runtime/deadline-budget.js";
import { classifySemanticError, type JavaIntelligenceErrorCode } from "./runtime/intelligence-error.js";
import { normalizeRepoLocation } from "./semantic-location.js";
import type { LspLocation, LspPosition, LspRange } from "./jdtls-lsp-types.js";

export type HierarchyEdge = {
  depth: number;
  from: unknown;
  to: unknown;
  ranges?: LspRange[];
};

export type HierarchyResult = {
  roots: unknown[];
  edges: HierarchyEdge[];
  completion: Completion;
  truncated: boolean;
  requests: number;
  visited: number;
  errorCode?: JavaIntelligenceErrorCode;
};

export type HierarchyWalkInput = {
  file: string;
  line: number;
  column: number;
  prepareMethod: string;
  method: string;
  depth: number;
  limit: number;
  budget: DeadlineBudget;
  signal?: AbortSignal;
  expand: (item: unknown, related: unknown) => Array<{ next: unknown; edge: Omit<HierarchyEdge, "depth"> }>;
};

export type HierarchyWalkHost = {
  repoRoot: string;
  ensureSemanticStarted(budget: DeadlineBudget, signal: AbortSignal | undefined, stage: string): Promise<void>;
  withDocumentPosition<T>(
    file: string,
    line: number,
    column: number,
    action: (params: { textDocument: { uri: string }; position: { line: number; character: number } }) => Promise<T>
  ): Promise<T>;
  request<T>(method: string, params?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T>;
};

/** Hard ceiling on expansion requests regardless of the caller's limit. */
export const MAX_HIERARCHY_REQUESTS = 64;
export const HIERARCHY_PREPARE_CAP_MS = 1000;
export const HIERARCHY_STEP_CAP_MS = 1500;

export async function walkHierarchy(host: HierarchyWalkHost, input: HierarchyWalkInput): Promise<HierarchyResult> {
  const edges: HierarchyEdge[] = [];
  const visited = new Set<string>();
  const maxDepth = Math.max(1, input.depth);
  const maxRequests = Math.min(Math.max(1, input.limit), MAX_HIERARCHY_REQUESTS);
  let requests = 0;

  const empty = (completion: Completion, errorCode?: JavaIntelligenceErrorCode): HierarchyResult => ({
    roots: [], edges, completion, truncated: false, requests, visited: visited.size, errorCode
  });

  let roots: unknown[];
  try {
    await host.ensureSemanticStarted(input.budget, input.signal, `${input.prepareMethod} startup`);
    roots = await host.withDocumentPosition(input.file, input.line, input.column, params =>
      host.request<unknown[]>(
        input.prepareMethod,
        params,
        Math.max(1, input.budget.remainingMs(HIERARCHY_PREPARE_CAP_MS)),
        input.signal
      )
    ) || [];
  } catch (error) {
    // A prepare that never answered means there is nothing to traverse.
    const classified = classifySemanticError(error);
    return empty(completionForError(classified.code), classified.code);
  }

  const queue = roots.map(item => ({ item, depth: 1 }));
  let limited = false;
  while (queue.length > 0) {
    if (edges.length >= input.limit || requests >= maxRequests) {
      limited = true;
      break;
    }
    const current = queue.shift()!;
    if (current.depth > maxDepth) {
      continue;
    }
    const key = hierarchyItemKey(current.item);
    if (!key || visited.has(key)) {
      continue;
    }
    visited.add(key);
    requests += 1;
    let related: unknown;
    try {
      related = await host.request<unknown[]>(
        input.method,
        { item: current.item },
        Math.max(1, input.budget.remainingMs(HIERARCHY_STEP_CAP_MS)),
        input.signal
      );
    } catch (error) {
      // Preserve what was already collected; classification decides whether
      // this is an expected bound or a genuine JDT fault.
      const classified = classifySemanticError(error);
      return {
        roots,
        edges,
        completion: completionForError(classified.code),
        truncated: true,
        requests,
        visited: visited.size,
        errorCode: classified.code
      };
    }
    for (const { next, edge } of input.expand(current.item, related ?? [])) {
      if (edges.length >= input.limit) {
        limited = true;
        break;
      }
      // Containment is applied before insertion so an out-of-repo type can
      // never enter the edge set or the traversal queue.
      if (!next || !isRepoHierarchyItem(host.repoRoot, next)) {
        continue;
      }
      edges.push({ depth: current.depth, ...edge });
      const nextKey = hierarchyItemKey(next);
      if (nextKey && !visited.has(nextKey)) {
        queue.push({ item: next, depth: current.depth + 1 });
      }
    }
  }

  const truncated = limited || edges.length >= input.limit;
  return {
    roots,
    edges,
    completion: truncated ? "PARTIAL_LIMIT" : "COMPLETE",
    truncated,
    requests,
    visited: visited.size
  };
}

export function isRepoHierarchyItem(repoRoot: string, item: unknown): boolean {
  const location = hierarchyItemLocation(item);
  return Boolean(location && normalizeRepoLocation(repoRoot, location));
}

/** Stable identity for a hierarchy item, so a cycle is visited exactly once. */
export function hierarchyItemKey(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as Record<string, unknown>;
  const uri = typeof value.uri === "string" ? value.uri : "";
  const name = typeof value.name === "string" ? value.name : "";
  const range = isLspRange(value.selectionRange)
    ? value.selectionRange
    : isLspRange(value.range)
      ? value.range
      : undefined;
  if (!uri || !range) return undefined;
  return `${uri}:${range.start.line}:${range.start.character}:${name}`;
}

export function hierarchyItemLocation(item: unknown): LspLocation | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as { uri?: unknown; range?: unknown; selectionRange?: unknown };
  const range = isLspRange(record.selectionRange)
    ? record.selectionRange
    : isLspRange(record.range)
      ? record.range
      : undefined;
  return typeof record.uri === "string" && range ? { uri: record.uri, range } : undefined;
}

function isLspRange(value: unknown): value is LspRange {
  if (!value || typeof value !== "object") return false;
  const record = value as { start?: unknown; end?: unknown };
  return isLspPosition(record.start) && isLspPosition(record.end);
}

function isLspPosition(value: unknown): value is LspPosition {
  if (!value || typeof value !== "object") return false;
  const record = value as { line?: unknown; character?: unknown };
  return typeof record.line === "number" && typeof record.character === "number";
}

export function completionForError(code: JavaIntelligenceErrorCode): Completion {
  if (code === "DEADLINE_EXCEEDED") return "PARTIAL_TIMEOUT";
  if (code === "CANCELLED") return "CANCELLED";
  return "FAILED";
}

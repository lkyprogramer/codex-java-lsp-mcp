// input: A static discovery query and the on-disk JavaIndex V2 client.
// output: java-discovery/v1 results: explicit declaration names, 1-based
//         UTF-16 locators, and byte-for-byte source previews only when the
//         on-disk file still matches the indexed contentHash.
// pos: Discovery layer for the java_symbol static backend. Assembles index
//      results only; it never starts or queries JDT.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { classifyQuery } from "./query-intent.js";
import { resolveSearchScope, sourceRootRecordFromPath, type ResolvedSearchScope, type SourceRootRecord } from "./scope.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import {
  DISCOVERY_DEFAULT_LIMIT,
  ENTITY_SEARCH_MAX_LIMIT,
  type EntityHit,
  type EntitySearchMode,
  type ExactLookupOutcome
} from "../java-index/entity-search.js";

export const DISCOVERY_SCHEMA_VERSION = "java-discovery/v1" as const;

/**
 * M2 T08 M2-2: an exact discovery request can ask for a shape the static
 * index never stores (parameterized/generic type arguments). Failing with a
 * stable structured code keeps callers from reading a silent zero-hit result
 * as "symbol absent" and tells them the raw-name retry.
 */
export class DiscoveryUnsupportedError extends Error {
  readonly code = "DISCOVERY_UNSUPPORTED" as const;
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryUnsupportedError";
  }
}
/** R07: one limit contract for the tool, this API and the SQL clamp. */
export { DISCOVERY_DEFAULT_LIMIT, ENTITY_SEARCH_MAX_LIMIT as DISCOVERY_MAX_LIMIT } from "../java-index/entity-search.js";
export const DISCOVERY_QUERY_MAX_UNITS = 512;
export const DISCOVERY_MAX_TERMS = 6;
export const DISCOVERY_TERM_MAX_UNITS = 64;
export const DISCOVERY_PREVIEW_LINES = 12;

export type DiscoverySourceSet = "main" | "test";

export type StaticDiscoveryArgs = {
  query: string;
  terms?: readonly string[];
  searchMode?: EntitySearchMode;
  limit?: number;
  module?: string;
  sourceSet?: DiscoverySourceSet;
  repoRoot: string;
  repoHash?: string;
  budget?: { remainingMs?: () => number };
};

export type DiscoveryLocator = {
  id: string;
  name: string;
  relativePath: string;
  contentHash: string;
  module: string;
  sourceRoot: string;
  kind: "type" | "method";
  fqn: string;
  signature: string;
  selection: { line: number; column: number };
};

export type DiscoveryCandidate = {
  declaration: DiscoveryLocator;
  matchedBy: Array<"exact" | "identifier" | "comment" | "framework" | "dense">;
  evidenceRange?: { startLine: number; endLine: number };
  preview?: string;
  previewKind?: "source";
  binding: "source-declaration" | "ambiguous";
};

export type DiscoveryResult = {
  schemaVersion: typeof DISCOVERY_SCHEMA_VERSION;
  repoHash: string;
  generation: number;
  candidates: DiscoveryCandidate[];
  scopeState: "READY" | "PARTIAL";
  /** Budget/deadline stopped the scan: the candidate set may be incomplete. */
  truncated: boolean;
  /** More candidates matched than `limit`: this is a ranked top-K. */
  selectionLimited: boolean;
  /** Exact-intent outcome; a miss never falls back to a fuzzy search. */
  exact?: ExactLookupOutcome;
  stopReason?: "candidate_budget" | "deadline" | "index_partial" | "layout_unknown" | "scope_empty";
  /** Hits that had no stored declaration range or file hash; they are not
   *  actionable locators and are reported, not rendered. */
  droppedUnlocatable: number;
  /** The scope the query actually ran under (module AND sourceSet over the
   *  indexed layout roots); EMPTY says why nothing was searched. */
  scope: ResolvedSearchScope;
};

const LAYER_MATCH: Record<EntityHit["layer"], DiscoveryCandidate["matchedBy"][number]> = {
  FQN: "exact",
  SIMPLE_NAME: "exact",
  BM25_IDENTIFIER: "identifier",
  CHUNK: "identifier",
  DOCUMENT: "comment"
};

/**
 * R07 input contract. `query` is kept verbatim; `terms` SUPPLEMENT it (never
 * replace it). Intent comes from the raw query alone: only an explicit exact
 * request, or a raw query that is as a whole one exact selector (and has no
 * terms), takes the exact route. `limit` is 1..DISCOVERY_MAX_LIMIT; anything
 * else is rejected rather than silently clamped.
 */
function validateArgs(args: StaticDiscoveryArgs): { task: string; limit: number; intent: "exact" | "text" } {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("discovery query must be 1..512 code units");
  }
  if (query.length > DISCOVERY_QUERY_MAX_UNITS) {
    throw new Error(`discovery query exceeds ${DISCOVERY_QUERY_MAX_UNITS} code units`);
  }
  const terms: string[] = [];
  if (args.terms !== undefined) {
    if (!Array.isArray(args.terms) || args.terms.length > DISCOVERY_MAX_TERMS) {
      throw new Error(`discovery terms are limited to ${DISCOVERY_MAX_TERMS}`);
    }
    for (const term of args.terms) {
      if (typeof term !== "string" || term.trim().length === 0) {
        throw new Error("discovery terms must be non-empty strings");
      }
      if (term.length > DISCOVERY_TERM_MAX_UNITS) {
        throw new Error(`discovery terms are limited to ${DISCOVERY_TERM_MAX_UNITS} code units`);
      }
      terms.push(term.trim());
    }
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > ENTITY_SEARCH_MAX_LIMIT)) {
    throw new Error(`discovery limit must be an integer 1..${ENTITY_SEARCH_MAX_LIMIT}`);
  }
  const limit = args.limit ?? DISCOVERY_DEFAULT_LIMIT;
  const searchMode: EntitySearchMode = args.searchMode ?? "auto";
  // M2-2: generic type arguments ("Map<String, V>") are not declarations the
  // static index stores; an explicit exact request must say so instead of
  // returning zero hits that read as "symbol absent". Auto mode keeps the
  // text route: there the query is task intent, not an address.
  if (searchMode === "exact" && /</.test(query)) {
    const raw = query.replace(/<.*>/, "").trim();
    throw new DiscoveryUnsupportedError(
      `exact discovery cannot address parameterized shapes: the static index stores raw declarations, so "${query}" never matches. ` +
      (raw ? `Retry with the raw name "${raw}" ` : "") + "or use searchMode auto/text for task intent."
    );
  }
  if (searchMode === "exact" && terms.length > 0) {
    throw new DiscoveryUnsupportedError("terms supplement a text search; an exact selector takes no terms. Drop terms or use searchMode auto/text.");
  }
  const intent = terms.length > 0 ? "text" : classifyQuery(query, searchMode);
  const task = terms.length > 0 ? [query, ...terms].join(" ") : query;
  return { task, limit, intent };
}

/** Index coverage roots (the layout roots the builder indexed) as scope records. */
export function sourceRootRecords(coverage: ReadonlyArray<{ root: string }> | undefined): SourceRootRecord[] {
  return (coverage ?? [])
    .map(entry => sourceRootRecordFromPath(entry.root))
    .filter((record): record is SourceRootRecord => record !== undefined);
}

type Preview = {
  preview: string;
  previewKind: "source";
  evidenceRange: { startLine: number; endLine: number };
};

/** A preview is the exact source window read from disk, and only when the
 *  on-disk file still hashes to the indexed contentHash; otherwise the
 *  candidate simply claims no preview (never a summary). */
function previewAt(repoRoot: string, relativePath: string, line: number, contentHash: string | undefined): Preview | undefined {
  const absolute = path.join(repoRoot, relativePath);
  if (!existsSync(absolute)) return undefined;
  let content: string;
  try {
    content = readFileSync(absolute, "utf8");
  } catch {
    return undefined;
  }
  if (contentHash && createHash("sha256").update(content, "utf8").digest("hex") !== contentHash) {
    return undefined;
  }
  // Lines keep their terminators (CRLF/LF/CR) so the preview is the exact
  // source window; a trailing newline does not create a phantom line, which
  // would push evidenceRange.endLine past the physical line count.
  const lines = content.split(/(?<=\r\n|\n|\r)/);
  if (lines[lines.length - 1] === "") lines.pop();
  if (line < 1 || line > lines.length) return undefined;
  const end = Math.min(lines.length, line + DISCOVERY_PREVIEW_LINES - 1);
  return {
    preview: lines.slice(line - 1, end).join(""),
    previewKind: "source",
    evidenceRange: { startLine: line, endLine: end }
  };
}

export async function runStaticDiscovery(client: JavaIndexClientApi, args: StaticDiscoveryArgs): Promise<DiscoveryResult> {
  const { task, limit, intent } = validateArgs(args);
  // docs/03 §2: module/sourceSet resolve against the roots the index was
  // built from, as an AND, BEFORE the query; the resolved roots are pushed
  // down into every SQL route ahead of postings budget, ranking and cap.
  const status = await client.status();
  const resolved: ResolvedSearchScope = resolveSearchScope(sourceRootRecords(status.coverage), {
    module: args.module,
    sourceSet: args.sourceSet
  });
  if (resolved.state === "EMPTY") {
    return {
      schemaVersion: DISCOVERY_SCHEMA_VERSION,
      repoHash: args.repoHash ?? "",
      generation: status.indexedGeneration ?? 0,
      candidates: [],
      scopeState: "READY",
      truncated: false,
      selectionLimited: false,
      stopReason: "scope_empty",
      droppedUnlocatable: 0,
      scope: resolved
    };
  }
  const result = await client.querySearch(task, {
    limit,
    mode: intent,
    ...(resolved.state === "RESOLVED" || resolved.state === "PARTIAL" ? { scope: { sourceRoots: resolved.sourceRootIds } } : {}),
    budget: args.budget?.remainingMs ? { remainingMs: args.budget.remainingMs } : undefined
  });
  const ambiguousExact = intent === "exact" && (result.exact === "ambiguous" || result.hits.length > 1);
  const candidates: DiscoveryCandidate[] = [];
  let droppedUnlocatable = 0;
  for (const hit of result.hits) {
    if (!hit.line || !hit.column || !hit.contentHash) {
      droppedUnlocatable += 1;
      continue;
    }
    const declaration: DiscoveryLocator = {
      id: hit.entityId,
      // Explicit name from the index; adapters must not parse display labels.
      name: hit.simpleName,
      relativePath: hit.relativePath,
      contentHash: hit.contentHash,
      module: hit.module ?? "",
      sourceRoot: hit.sourceRoot ?? "",
      kind: hit.kind,
      fqn: hit.fqn,
      signature: hit.signature ?? (hit.kind === "method" ? `${hit.simpleName}(...)` : hit.fqn),
      selection: { line: hit.line, column: hit.column }
    };
    const preview = previewAt(args.repoRoot, hit.relativePath, hit.line, hit.contentHash);
    const candidate: DiscoveryCandidate = {
      declaration,
      matchedBy: [LAYER_MATCH[hit.layer]],
      binding: ambiguousExact ? "ambiguous" : "source-declaration"
    };
    if (preview) Object.assign(candidate, preview);
    candidates.push(candidate);
  }
  // Completeness comes from the index snapshot and the query budget, never
  // from the candidates list being non-empty.
  const indexPartial = status.state !== "READY";
  const partial = indexPartial || result.truncated || result.stopReason !== undefined || droppedUnlocatable > 0
    || resolved.state === "PARTIAL";
  const stopReason = indexPartial
    ? "index_partial"
    : result.stopReason === "postings"
      ? "candidate_budget"
      : result.stopReason === "deadline"
        ? "deadline"
        : resolved.state === "PARTIAL"
          ? "layout_unknown"
          : undefined;
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    repoHash: args.repoHash ?? "",
    generation: result.generation,
    candidates,
    scopeState: partial ? "PARTIAL" : "READY",
    truncated: result.truncated,
    selectionLimited: result.selectionLimited === true,
    ...(intent === "exact" ? { exact: result.exact ?? (result.hits.length === 0 ? "miss" : result.hits.length > 1 ? "ambiguous" : "match") } : {}),
    ...(stopReason ? { stopReason } : {}),
    droppedUnlocatable,
    scope: resolved
  };
}
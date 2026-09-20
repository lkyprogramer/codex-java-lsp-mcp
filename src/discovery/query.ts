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
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import type { EntityHit, EntitySearchMode, EntitySearchOptions } from "../java-index/entity-search.js";

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
export const DISCOVERY_DEFAULT_LIMIT = 8;
export const DISCOVERY_MAX_LIMIT = 20;
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
  truncated: boolean;
  stopReason?: "candidate_budget" | "deadline" | "index_partial";
  /** Hits that had no stored declaration range or file hash; they are not
   *  actionable locators and are reported, not rendered. */
  droppedUnlocatable: number;
};

const LAYER_MATCH: Record<EntityHit["layer"], DiscoveryCandidate["matchedBy"][number]> = {
  FQN: "exact",
  SIMPLE_NAME: "exact",
  BM25_IDENTIFIER: "identifier",
  CHUNK: "identifier",
  DOCUMENT: "comment"
};

function validateArgs(args: StaticDiscoveryArgs): { task: string; limit: number; searchMode: EntitySearchMode; scope?: EntitySearchOptions["scope"] } {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new Error("discovery query must be 1..512 code units");
  }
  if (query.length > DISCOVERY_QUERY_MAX_UNITS) {
    throw new Error(`discovery query exceeds ${DISCOVERY_QUERY_MAX_UNITS} code units`);
  }
  let task = query;
  if (args.terms && args.terms.length > 0) {
    if (args.terms.length > DISCOVERY_MAX_TERMS) {
      throw new Error(`discovery terms are limited to ${DISCOVERY_MAX_TERMS}`);
    }
    for (const term of args.terms) {
      if (typeof term !== "string" || term.trim().length === 0) {
        throw new Error("discovery terms must be non-empty strings");
      }
      if (term.length > DISCOVERY_TERM_MAX_UNITS) {
        throw new Error(`discovery terms are limited to ${DISCOVERY_TERM_MAX_UNITS} code units`);
      }
    }
    task = args.terms.join(" ");
  }
  const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? DISCOVERY_DEFAULT_LIMIT)), DISCOVERY_MAX_LIMIT);
  const searchMode: EntitySearchMode = args.searchMode ?? "auto";
  // M2-2: generic type arguments ("Map<String, V>") are not declarations the
  // static index stores; an explicit exact request must say so instead of
  // returning zero hits that read as "symbol absent". Auto mode keeps the
  // text route: there the query is task intent, not an address.
  if (searchMode === "exact" && /</.test(task)) {
    const raw = task.replace(/<.*>/, "").trim();
    throw new DiscoveryUnsupportedError(
      `exact discovery cannot address parameterized shapes: the static index stores raw declarations, so "${task}" never matches. ` +
      (raw ? `Retry with the raw name "${raw}" ` : "") + "or use searchMode auto/text for task intent."
    );
  }
  const sourceRoots: string[] = [];
  if (args.sourceSet) sourceRoots.push(args.sourceSet === "test" ? "src/test" : "src/main");
  // A module is honored when the repository is actually laid out as a
  // multi-module tree (<module>/src exists); in a single-module repo the
  // name cannot address a path and filtering on it would silently drop
  // everything, so it stays a no-op instead.
  if (args.module && existsSync(path.join(args.repoRoot, args.module, "src"))) {
    sourceRoots.push(args.module);
  }
  return { task, limit, searchMode, scope: sourceRoots.length > 0 ? { sourceRoots } : undefined };
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
  const { task, limit, searchMode, scope } = validateArgs(args);
  const [result, status] = await Promise.all([
    client.querySearch(task, {
      limit,
      mode: searchMode,
      scope,
      budget: args.budget?.remainingMs ? { remainingMs: args.budget.remainingMs } : undefined
    }),
    client.status()
  ]);
  const intent = classifyQuery(task, searchMode);
  const ambiguousExact = intent === "exact" && result.hits.length > 1;
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
  const partial = indexPartial || result.truncated || result.stopReason !== undefined || droppedUnlocatable > 0;
  const stopReason = indexPartial
    ? "index_partial"
    : result.stopReason === "postings"
      ? "candidate_budget"
      : result.stopReason === "deadline"
        ? "deadline"
        : undefined;
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    repoHash: args.repoHash ?? "",
    generation: result.generation,
    candidates,
    scopeState: partial ? "PARTIAL" : "READY",
    truncated: result.truncated,
    ...(stopReason ? { stopReason } : {}),
    droppedUnlocatable
  };
}
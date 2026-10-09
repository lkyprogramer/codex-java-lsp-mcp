// input: A static discovery query and the on-disk JavaIndex V2 client.
// output: java-discovery/v1 results: explicit declaration names, 1-based
//         UTF-16 locators that are re-verified against the on-disk content
//         hash (a changed file never yields a READY stale locator), and
//         bounded byte-for-byte previews of the evidence source that matched.
// pos: Discovery layer for the java_symbol static backend. Assembles index
//      results only; it never starts or queries JDT.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { classifyQuery } from "./query-intent.js";
import { redactPreviewLine } from "./search-document.js";
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
// R08 safety initial values (docs/03 §4), not profiled optima: bytes per
// preview, preview bytes per request, bytes read per file and per request.
export const DISCOVERY_PREVIEW_MAX_BYTES = 4096;
export const DISCOVERY_REQUEST_PREVIEW_MAX_BYTES = 16384;
export const DISCOVERY_FILE_READ_MAX_BYTES = 2 * 1024 * 1024;
export const DISCOVERY_REQUEST_READ_MAX_BYTES = 8 * 1024 * 1024;

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

/** Why a candidate carries no preview; the locator itself stays usable
 *  unless the result says otherwise (scopeState/droppedStale). */
export type DiscoveryPreviewOmitted =
  | "file_too_large"
  | "read_budget"
  | "deadline"
  | "preview_byte_cap"
  | "preview_budget"
  | "source_changed"
  | "range_invalid";

export type DiscoveryCandidate = {
  declaration: DiscoveryLocator;
  matchedBy: Array<"exact" | "identifier" | "comment" | "framework" | "dense">;
  /** The source the preview was read from: the declaration file, or the
   *  matched document's own source (e.g. a MyBatis XML statement). */
  evidenceRange?: { relativePath: string; contentHash: string; startLine: number; endLine: number };
  preview?: string;
  /** "redacted-preview" is not source text and must not be credited as such. */
  previewKind?: "source" | "redacted-preview";
  previewOmitted?: DiscoveryPreviewOmitted;
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
  stopReason?:
    | "candidate_budget"
    | "deadline"
    | "index_partial"
    | "layout_unknown"
    | "scope_empty"
    | "changed_during_request"
    | "source_changed"
    | "read_budget";
  /** Hits that had no stored declaration range or file hash; they are not
   *  actionable locators and are reported, not rendered. */
  droppedUnlocatable: number;
  /** Hits whose file no longer matches the indexed content hash (or is
   *  gone): their locators are stale and are dropped, and the result is
   *  PARTIAL. */
  droppedStale: number;
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

type SourceRead =
  | { state: "ok"; contentHash: string; lines: string[] }
  | { state: "missing" }
  | { state: "file_too_large" | "read_budget" | "deadline" };

/** Physical lines with their terminators (CRLF, LF or lone CR, each one
 *  terminator); a trailing terminator does not create a phantom line. */
export function splitSourceLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/(?<=\n|\r(?!\n))/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * One request's file reads: each unique path is read at most once (shared by
 * every candidate in that file), asynchronously, under per-file and
 * per-request byte caps and the request deadline. The hash is recomputed
 * from the bytes on every request - never inferred from mtime.
 */
export class RequestSourceReader {
  private readonly cache = new Map<string, Promise<SourceRead>>();
  private bytesRead = 0;
  private reads = 0;

  constructor(private readonly repoRoot: string, private readonly remainingMs?: () => number) {}

  /** Physical file reads and bytes read so far (profiling and tests). */
  work(): { filesRead: number; bytesRead: number } {
    return { filesRead: this.reads, bytesRead: this.bytesRead };
  }

  read(relativePath: string): Promise<SourceRead> {
    let pending = this.cache.get(relativePath);
    if (!pending) {
      pending = this.load(relativePath);
      this.cache.set(relativePath, pending);
    }
    return pending;
  }

  private async load(relativePath: string): Promise<SourceRead> {
    const root = path.resolve(this.repoRoot);
    const absolute = path.resolve(root, relativePath);
    const inside = path.relative(root, absolute);
    if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) return { state: "missing" };
    if (this.remainingMs && this.remainingMs() <= 0) return { state: "deadline" };
    let size: number;
    try {
      size = (await stat(absolute)).size;
    } catch {
      return { state: "missing" };
    }
    if (size > DISCOVERY_FILE_READ_MAX_BYTES) return { state: "file_too_large" };
    if (this.bytesRead + size > DISCOVERY_REQUEST_READ_MAX_BYTES) return { state: "read_budget" };
    let bytes: Buffer;
    this.reads += 1;
    try {
      bytes = await readFile(absolute);
    } catch {
      return { state: "missing" };
    }
    if (bytes.length > DISCOVERY_FILE_READ_MAX_BYTES) return { state: "file_too_large" };
    this.bytesRead += bytes.length;
    // Same hash definition as the indexer (sha256 of the UTF-8 decoded text).
    const content = bytes.toString("utf8");
    return {
      state: "ok",
      contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
      lines: splitSourceLines(content)
    };
  }
}

type PreviewWindow =
  | { preview: string; previewKind: "source" | "redacted-preview"; startLine: number; endLine: number; bytes: number }
  | { omitted: DiscoveryPreviewOmitted };

/**
 * Whole physical lines only, starting at `startLine`, at most
 * DISCOVERY_PREVIEW_LINES lines and `lastLine`, and at most `maxBytes` UTF-8
 * bytes; the range is recomputed from the lines actually kept, so a preview
 * always equals its evidenceRange and never cuts a character. A line that
 * would carry a recognised secret is redacted and the preview is then
 * labelled redacted-preview (not source evidence).
 */
function previewWindow(lines: readonly string[], startLine: number, lastLine: number, budgetBytes: number): PreviewWindow {
  if (startLine < 1 || startLine > lines.length || lastLine < startLine) return { omitted: "range_invalid" };
  const maxBytes = Math.min(DISCOVERY_PREVIEW_MAX_BYTES, budgetBytes);
  const end = Math.min(lines.length, lastLine, startLine + DISCOVERY_PREVIEW_LINES - 1);
  const kept: string[] = [];
  let bytes = 0;
  let redacted = false;
  for (let line = startLine; line <= end; line += 1) {
    const raw = lines[line - 1]!;
    const text = redactPreviewLine(raw);
    const size = Buffer.byteLength(text, "utf8");
    if (bytes + size > maxBytes) break;
    if (text !== raw) redacted = true;
    kept.push(text);
    bytes += size;
  }
  if (kept.length === 0) {
    const first = Buffer.byteLength(redactPreviewLine(lines[startLine - 1]!), "utf8");
    return { omitted: first > DISCOVERY_PREVIEW_MAX_BYTES ? "preview_byte_cap" : "preview_budget" };
  }
  return {
    preview: kept.join(""),
    previewKind: redacted ? "redacted-preview" : "source",
    startLine,
    endLine: startLine + kept.length - 1,
    bytes
  };
}

const DOCUMENT_MATCH: Record<string, DiscoveryCandidate["matchedBy"][number]> = {
  comment: "comment",
  "framework-key": "framework",
  signature: "identifier"
};

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
      droppedStale: 0,
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
  const reader = new RequestSourceReader(args.repoRoot, args.budget?.remainingMs);
  const candidates: DiscoveryCandidate[] = [];
  let droppedUnlocatable = 0;
  let droppedStale = 0;
  let staleEvidence = 0;
  const unverified = new Set<"deadline" | "read_budget">();
  let previewBudget = DISCOVERY_REQUEST_PREVIEW_MAX_BYTES;
  for (const hit of result.hits) {
    if (!hit.line || !hit.column || !hit.contentHash) {
      droppedUnlocatable += 1;
      continue;
    }
    // docs/03 §4: the locator is only actionable while its file still hashes
    // to the indexed contentHash. A changed or deleted file drops the
    // candidate (counted, result PARTIAL) instead of returning READY with a
    // stale line/column.
    const declarationRead = await reader.read(hit.relativePath);
    if (declarationRead.state === "missing" || (declarationRead.state === "ok" && declarationRead.contentHash !== hit.contentHash)) {
      droppedStale += 1;
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
    const candidate: DiscoveryCandidate = {
      declaration,
      matchedBy: [hit.layer === "DOCUMENT" && hit.evidence ? DOCUMENT_MATCH[hit.evidence.sourceKind] ?? "comment" : LAYER_MATCH[hit.layer]],
      binding: ambiguousExact ? "ambiguous" : "source-declaration"
    };
    if (declarationRead.state !== "ok") {
      // Not read (cap/deadline): a safe locator with the reason, unverified.
      candidate.previewOmitted = declarationRead.state;
      unverified.add(declarationRead.state === "deadline" ? "deadline" : "read_budget");
      candidates.push(candidate);
      continue;
    }
    // The preview shows what actually matched: a document hit's own source
    // (comment lines, framework key, MyBatis XML statement), else the
    // declaration head.
    const evidence = hit.evidence ?? { relativePath: hit.relativePath, contentHash: hit.contentHash, startLine: hit.line, endLine: Number.MAX_SAFE_INTEGER };
    const sourceRead = evidence.relativePath === hit.relativePath ? declarationRead : await reader.read(evidence.relativePath);
    if (sourceRead.state === "missing" || (sourceRead.state === "ok" && sourceRead.contentHash !== evidence.contentHash)) {
      candidate.previewOmitted = "source_changed";
      staleEvidence += 1;
    } else if (sourceRead.state !== "ok") {
      candidate.previewOmitted = sourceRead.state;
    } else {
      const window = previewWindow(sourceRead.lines, evidence.startLine, evidence.endLine, previewBudget);
      if ("omitted" in window) {
        candidate.previewOmitted = window.omitted;
      } else {
        previewBudget -= window.bytes;
        candidate.preview = window.preview;
        candidate.previewKind = window.previewKind;
        candidate.evidenceRange = {
          relativePath: evidence.relativePath,
          contentHash: evidence.contentHash,
          startLine: window.startLine,
          endLine: window.endLine
        };
      }
    }
    candidates.push(candidate);
  }
  // Completeness comes from the index snapshot, the query budget and the
  // source verification, never from the candidates list being non-empty.
  const indexPartial = status.state !== "READY";
  // The hits carry the generation of their own read snapshot; a status from
  // another generation must not be stitched onto them as READY (K20).
  const changedDuringRequest = typeof status.indexedGeneration === "number" && status.indexedGeneration !== result.generation;
  const sourceChanged = droppedStale > 0 || staleEvidence > 0;
  const partial = indexPartial || changedDuringRequest || result.truncated || result.stopReason !== undefined
    || droppedUnlocatable > 0 || sourceChanged || unverified.size > 0 || resolved.state === "PARTIAL";
  const stopReason: DiscoveryResult["stopReason"] = indexPartial
    ? "index_partial"
    : changedDuringRequest
      ? "changed_during_request"
      : result.stopReason === "postings"
        ? "candidate_budget"
        : result.stopReason === "deadline" || unverified.has("deadline")
          ? "deadline"
          : sourceChanged
            ? "source_changed"
            : unverified.has("read_budget")
              ? "read_budget"
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
    droppedStale,
    scope: resolved
  };
}

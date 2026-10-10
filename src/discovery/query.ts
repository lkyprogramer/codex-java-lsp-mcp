// input: A static discovery query and the on-disk JavaIndex V2 client.
// output: java-discovery/v1 results: explicit declaration names, 1-based
//         UTF-16 locators that are re-verified against the on-disk content
//         hash (a changed file never yields a READY stale locator), and
//         bounded byte-for-byte previews of the evidence source that matched.
// pos: Discovery layer for the java_symbol static backend. Assembles index
//      results only; it never starts or queries JDT.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { classifyQuery } from "./query-intent.js";
import { QueryTrace, type QueryStageTrace } from "./query-budget.js";
import { redactPreviewLine } from "./search-document.js";
import { resolveSearchScope, sourceRootRecordFromPath, type ModuleAliases, type ResolvedSearchScope, type SourceRootRecord } from "./scope.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import {
  DISCOVERY_DEFAULT_LIMIT,
  ENTITY_SEARCH_MAX_LIMIT,
  type DetailedEntitySearchResult,
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

/**
 * Preview modes. A preview is a discovery aid, not the evidence an agent reads
 * next, so the default is a short declaration head under a small per-request
 * cap: one discovery call cannot spend an agent's whole source budget (kit
 * tasks allow 160 lines / 16000 bytes in total). "window" is the R08 window;
 * "none" returns hash-verified locators only.
 */
export type DiscoveryPreviewMode = "none" | "head" | "window";
export const DISCOVERY_DEFAULT_PREVIEW_MODE: DiscoveryPreviewMode = "head";
export const DISCOVERY_HEAD_PREVIEW_LINES = 4;
export const DISCOVERY_HEAD_PREVIEW_MAX_BYTES = 1024;
export const DISCOVERY_HEAD_REQUEST_PREVIEW_MAX_BYTES = 2048;
const PREVIEW_PROFILES: Record<Exclude<DiscoveryPreviewMode, "none">, { lines: number; maxBytes: number; requestBytes: number }> = {
  head: { lines: DISCOVERY_HEAD_PREVIEW_LINES, maxBytes: DISCOVERY_HEAD_PREVIEW_MAX_BYTES, requestBytes: DISCOVERY_HEAD_REQUEST_PREVIEW_MAX_BYTES },
  window: { lines: DISCOVERY_PREVIEW_LINES, maxBytes: DISCOVERY_PREVIEW_MAX_BYTES, requestBytes: DISCOVERY_REQUEST_PREVIEW_MAX_BYTES }
};
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
  /** Default "head" (see DiscoveryPreviewMode). */
  preview?: DiscoveryPreviewMode;
  repoRoot: string;
  repoHash?: string;
  budget?: { remainingMs?: () => number };
  /** R09: return per-stage timings (status, SQL stages, preview). Off on the
   *  MCP wire; used by load measurement and tests. */
  trace?: boolean;
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
  /** Lines the whole declaration spans (annotations to closing brace) in the
   *  file at contentHash: what to read, beyond the short preview. */
  range?: { startLine: number; endLine: number };
};

/** Why a candidate carries no preview; the locator itself stays usable
 *  unless the result says otherwise (scopeState/droppedStale). */
export type DiscoveryPreviewOmitted =
  | "not_requested"
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
    | "read_budget"
    | "queue_full";
  /** Hits that had no stored declaration range or file hash; they are not
   *  actionable locators and are reported, not rendered. */
  droppedUnlocatable: number;
  /** Hits whose file no longer matches the indexed content hash (or is
   *  gone): their locators are stale and are dropped, and the result is
   *  PARTIAL. */
  droppedStale: number;
  /** The scope the query actually ran under (module AND sourceSet over the
   *  indexed layout roots); EMPTY says why nothing was searched; NOT_RESOLVED
   *  when the deadline had passed before the scope was resolved. */
  scope: ResolvedSearchScope | { state: "NOT_RESOLVED" };
  /** R09: per-stage timings, only when requested (`trace: true`). */
  trace?: QueryStageTrace[];
  /** Why a complete answer is empty, when the index can tell: no query word
   *  exists in the index vocabulary. Rephrase with code identifiers; there is
   *  never a fuzzy fallback (R07). */
  emptyReason?: DiscoveryEmptyReason;
};

export type DiscoveryEmptyReason = {
  kind: "no_vocabulary_overlap";
  queryTokens: number;
  knownTokens: 0;
  /** Unicode scripts of the query words, e.g. ["Han"] or ["Latin"]. */
  queryScripts: string[];
  hint: string;
};

const NO_VOCABULARY_HINT =
  "No word of this query occurs in the indexed code, comments or framework keys. " +
  "Rephrase with likely code identifiers (class, method or field names, usually English), e.g. translate the key nouns.";

function queryScripts(query: string): string[] {
  const scripts: string[] = [];
  if (/\p{Script=Han}/u.test(query)) scripts.push("Han");
  if (/[A-Za-z]/.test(query)) scripts.push("Latin");
  return scripts;
}

function emptyReasonOf(query: string, vocabulary: DetailedEntitySearchResult["vocabulary"]): DiscoveryEmptyReason | undefined {
  if (!vocabulary || vocabulary.queryTokens === 0 || vocabulary.knownTokens !== 0) return undefined;
  return { kind: "no_vocabulary_overlap", queryTokens: vocabulary.queryTokens, knownTokens: 0, queryScripts: queryScripts(query), hint: NO_VOCABULARY_HINT };
}

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
  if (args.preview !== undefined && !["none", "head", "window"].includes(args.preview)) {
    throw new Error("discovery preview must be none, head or window");
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

/** Maven artifactIds of the indexed module directories (read lazily, only
 *  when a module name matched no directory or layout name). Gradle project
 *  names are not read. */
function mavenArtifactAliases(repoRoot: string, records: readonly SourceRootRecord[]): ModuleAliases {
  const aliases = new Map<string, string[]>();
  for (const modulePath of new Set(records.map(record => record.modulePath))) {
    let pom: string;
    try {
      pom = readFileSync(path.join(repoRoot, modulePath, "pom.xml"), "utf8");
    } catch {
      continue;
    }
    const own = pom.replace(/<!--[\s\S]*?-->/g, "").replace(/<parent>[\s\S]*?<\/parent>/, "");
    const artifactId = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(own)?.[1];
    if (artifactId) aliases.set(artifactId, [...(aliases.get(artifactId) ?? []), modulePath]);
  }
  return aliases;
}

/** The requested scope exists on disk but is not in the index coverage (a
 *  module added since the last index publish): EMPTY there is not complete. */
function scopeOnDiskButUnindexed(repoRoot: string, module: string | undefined, sourceSet: DiscoverySourceSet | undefined): boolean {
  const base = module === undefined || module.trim() === "" || module.trim() === "." ? "." : module.trim();
  const root = path.resolve(repoRoot);
  const moduleDir = path.resolve(root, base);
  const inside = path.relative(root, moduleDir);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return false;
  return (sourceSet ? [sourceSet] : ["main", "test"]).some(set => existsSync(path.join(moduleDir, "src", set, "java")));
}

type SourceRead =
  | { state: "ok"; contentHash: string; lines: string[] }
  /** Over the per-file preview cap: hashed by streaming (freshness known),
   *  content not kept, so no preview. */
  | { state: "hashed_only"; contentHash: string }
  | { state: "missing" }
  | { state: "file_too_large" | "read_budget" | "deadline" };

/** sha256 of the UTF-8 decoded text (the indexer's definition), streamed. */
async function streamContentHash(absolute: string): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  for await (const chunk of createReadStream(absolute)) {
    bytes += (chunk as Buffer).length;
    hash.update(decoder.write(chunk as Buffer), "utf8");
  }
  hash.update(decoder.end(), "utf8");
  return { hash: hash.digest("hex"), bytes };
}

/** Physical lines with their terminators, numbered like the index parser
 *  (tree-sitter) and rg: a line ends at LF (a CRLF is one terminator, a lone
 *  CR is line content). A trailing terminator does not create a phantom line. */
export function splitSourceLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split(/(?<=\n)/);
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
    if (this.bytesRead + size > DISCOVERY_REQUEST_READ_MAX_BYTES) {
      return { state: size > DISCOVERY_FILE_READ_MAX_BYTES ? "file_too_large" : "read_budget" };
    }
    if (size > DISCOVERY_FILE_READ_MAX_BYTES) {
      // Large (often generated) file: verify freshness without holding it.
      this.reads += 1;
      try {
        const streamed = await streamContentHash(absolute);
        this.bytesRead += streamed.bytes;
        return { state: "hashed_only", contentHash: streamed.hash };
      } catch {
        return { state: "missing" };
      }
    }
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
function previewWindow(
  lines: readonly string[],
  startLine: number,
  lastLine: number,
  budgetBytes: number,
  profile: { lines: number; maxBytes: number }
): PreviewWindow {
  if (startLine < 1 || startLine > lines.length || lastLine < startLine) return { omitted: "range_invalid" };
  const maxBytes = Math.min(profile.maxBytes, budgetBytes);
  const end = Math.min(lines.length, lastLine, startLine + profile.lines - 1);
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
    return { omitted: first > profile.maxBytes ? "preview_byte_cap" : "preview_budget" };
  }
  return {
    preview: kept.join(""),
    previewKind: redacted ? "redacted-preview" : "source",
    startLine,
    endLine: startLine + kept.length - 1,
    bytes
  };
}

async function traced<T>(trace: QueryTrace | undefined, operation: string, fn: () => Promise<{ value: T; visited: number }>): Promise<T> {
  return trace ? trace.stageAsync(operation, fn) : (await fn()).value;
}

const DOCUMENT_MATCH: Record<string, DiscoveryCandidate["matchedBy"][number]> = {
  comment: "comment",
  "framework-key": "framework",
  signature: "identifier"
};

export async function runStaticDiscovery(client: JavaIndexClientApi, args: StaticDiscoveryArgs): Promise<DiscoveryResult> {
  const { task, limit, intent } = validateArgs(args);
  const remainingMs = args.budget?.remainingMs;
  const trace = args.trace ? new QueryTrace(remainingMs) : undefined;
  const expired = () => remainingMs !== undefined && remainingMs() <= 0;
  // R09: one absolute deadline for the whole request. Already expired on
  // entry -> PARTIAL/deadline without reading status or running any SQL.
  if (expired()) {
    return {
      schemaVersion: DISCOVERY_SCHEMA_VERSION,
      repoHash: args.repoHash ?? "",
      generation: 0,
      candidates: [],
      scopeState: "PARTIAL",
      truncated: true,
      selectionLimited: false,
      stopReason: "deadline",
      droppedUnlocatable: 0,
      droppedStale: 0,
      scope: { state: "NOT_RESOLVED" },
      ...(trace ? { trace: trace.stages } : {})
    };
  }
  // docs/03 §2: module/sourceSet resolve against the roots the index was
  // built from, as an AND, BEFORE the query; the resolved roots are pushed
  // down into every SQL route ahead of postings budget, ranking and cap.
  const status = await traced(trace, "status", async () => ({ value: await client.status(), visited: 1 }));
  const records = sourceRootRecords(status.coverage);
  const resolved: ResolvedSearchScope = resolveSearchScope(records, {
    module: args.module,
    sourceSet: args.sourceSet
  }, () => mavenArtifactAliases(args.repoRoot, records));
  if (resolved.state === "EMPTY") {
    // EMPTY is a complete answer only for a READY index whose coverage
    // already includes everything on disk for that scope.
    const incomplete = status.state !== "READY"
      || (resolved.reason !== "AMBIGUOUS_MODULE" && scopeOnDiskButUnindexed(args.repoRoot, args.module, args.sourceSet));
    return {
      schemaVersion: DISCOVERY_SCHEMA_VERSION,
      repoHash: args.repoHash ?? "",
      generation: status.indexedGeneration ?? 0,
      candidates: [],
      scopeState: incomplete ? "PARTIAL" : "READY",
      truncated: false,
      selectionLimited: false,
      stopReason: incomplete ? "index_partial" : "scope_empty",
      droppedUnlocatable: 0,
      droppedStale: 0,
      scope: resolved,
      ...(trace ? { trace: trace.stages } : {})
    };
  }
  // The query itself checks the same deadline on entry and at every stage.
  const result = await traced(trace, "query", async () => {
    const value = await client.querySearch(task, {
      limit,
      mode: intent,
      ...(resolved.state === "RESOLVED" || resolved.state === "PARTIAL" ? { scope: { sourceRoots: resolved.sourceRootIds } } : {}),
      budget: remainingMs ? { remainingMs } : undefined
    });
    return { value, visited: value.work?.postings ?? 0 };
  });
  if (trace && result.trace) {
    for (const stage of result.trace) trace.stages.push({ ...stage, operation: `sql:${stage.operation}` });
  }
  const endPreview = trace?.start("preview");
  const ambiguousExact = intent === "exact" && (result.exact === "ambiguous" || result.hits.length > 1);
  const reader = new RequestSourceReader(args.repoRoot, args.budget?.remainingMs);
  const candidates: DiscoveryCandidate[] = [];
  let droppedUnlocatable = 0;
  let droppedStale = 0;
  let staleEvidence = 0;
  const unverified = new Set<"deadline" | "read_budget">();
  const previewMode = args.preview ?? DISCOVERY_DEFAULT_PREVIEW_MODE;
  const previewProfile = previewMode === "none" ? undefined : PREVIEW_PROFILES[previewMode];
  let previewBudget = previewProfile?.requestBytes ?? 0;
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
    const declarationHash = declarationRead.state === "ok" || declarationRead.state === "hashed_only" ? declarationRead.contentHash : undefined;
    if (declarationRead.state === "missing" || (declarationHash !== undefined && declarationHash !== hit.contentHash)) {
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
      selection: { line: hit.line, column: hit.column },
      ...(hit.declarationStartLine !== undefined && hit.declarationEndLine !== undefined
        ? { range: { startLine: hit.declarationStartLine, endLine: hit.declarationEndLine } }
        : {})
    };
    const candidate: DiscoveryCandidate = {
      declaration,
      matchedBy: [hit.layer === "DOCUMENT" && hit.evidence ? DOCUMENT_MATCH[hit.evidence.sourceKind] ?? "comment" : LAYER_MATCH[hit.layer]],
      binding: ambiguousExact ? "ambiguous" : "source-declaration"
    };
    if (declarationRead.state === "hashed_only") {
      // Verified fresh, but too large to preview.
      candidate.previewOmitted = "file_too_large";
      candidates.push(candidate);
      continue;
    }
    if (!previewProfile && declarationRead.state === "ok") {
      // Hash-verified locator; the caller asked for no preview.
      candidate.previewOmitted = "not_requested";
      candidates.push(candidate);
      continue;
    }
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
    const evidence = hit.evidence ?? {
      relativePath: hit.relativePath,
      contentHash: hit.contentHash,
      startLine: hit.declarationStartLine ?? hit.line,
      endLine: Number.MAX_SAFE_INTEGER
    };
    const sourceRead = evidence.relativePath === hit.relativePath ? declarationRead : await reader.read(evidence.relativePath);
    const sourceHash = sourceRead.state === "ok" || sourceRead.state === "hashed_only" ? sourceRead.contentHash : undefined;
    if (sourceRead.state === "missing" || (sourceHash !== undefined && sourceHash !== evidence.contentHash)) {
      candidate.previewOmitted = "source_changed";
      staleEvidence += 1;
    } else if (sourceRead.state !== "ok") {
      candidate.previewOmitted = sourceRead.state === "hashed_only" ? "file_too_large" : sourceRead.state;
    } else {
      const window = previewWindow(sourceRead.lines, evidence.startLine, evidence.endLine, previewBudget, previewProfile!);
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
  endPreview?.(result.hits.length);
  // Completeness comes from the index snapshot, the query budget and the
  // source verification, never from the candidates list being non-empty.
  const indexPartial = status.state !== "READY";
  // The hits carry the generation of their own read snapshot; a status from
  // another generation must not be stitched onto them as READY (K20).
  const changedDuringRequest = typeof status.indexedGeneration === "number" && status.indexedGeneration !== result.generation;
  const sourceChanged = droppedStale > 0 || staleEvidence > 0;
  const partial = indexPartial || changedDuringRequest || result.truncated || result.stopReason !== undefined
    || droppedUnlocatable > 0 || sourceChanged || unverified.size > 0 || resolved.state === "PARTIAL";
  // A scan that never opened a snapshot (expired before it ran, or rejected
  // by a full queue) observed no generation to compare; once a snapshot was
  // read, a generation change still outranks a later deadline.
  const notStarted = result.stopReason === "queue_full" || (result.stopReason === "deadline" && result.generation === 0)
    ? result.stopReason
    : undefined;
  const stopReason: DiscoveryResult["stopReason"] = indexPartial
    ? "index_partial"
    : notStarted
      ? notStarted
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
    // An interrupted exact lookup has no outcome ("miss" would claim the
    // selector does not exist).
    ...(intent === "exact" && (result.exact !== undefined || result.stopReason === undefined)
      ? { exact: result.exact ?? (result.hits.length === 0 ? "miss" : result.hits.length > 1 ? "ambiguous" : "match") }
      : {}),
    ...(stopReason ? { stopReason } : {}),
    droppedUnlocatable,
    droppedStale,
    scope: resolved,
    ...(trace ? { trace: trace.stages } : {}),
    ...(candidates.length === 0 && !partial ? (reason => (reason ? { emptyReason: reason } : {}))(emptyReasonOf(args.query, result.vocabulary)) : {})
  };
}

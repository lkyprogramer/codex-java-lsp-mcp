import type { SQLOutputValue } from "node:sqlite";
import type { SourceRange } from "../runtime/source-range.js";
import { prepareCached, type IndexDatabase } from "./sql/driver.js";
import { decodeFacts } from "./sql/rows.js";
import { symId } from "./sql/sym.js";
import { METHOD_ID_PREFIX } from "./stable-id.js";

// §2.8 identity boundary. The shared facts database stores only
// workspace-independent declaration keys (v2 types/fields, v3 methods: normalized
// relative path + FQN, owner + erased signature, owner + field name). The
// external symbolId binds such a key to one workspace at the API edge; it
// carries no snapshot, generation, line or rowid, so it survives body edits,
// line shifts and full rebuilds, and dies only when the path/name/signature
// changes or the declaration is deleted. A local/anonymous declaration is
// keyed by position, so it only gets a SNAPSHOT-stable evidence handle.
export const SYMBOL_ID_FORMAT = "mac1";
const SYMBOL_PREFIX = `jsym:${SYMBOL_ID_FORMAT}:`;
const HANDLE_PREFIX = `jev:${SYMBOL_ID_FORMAT}:`;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{8,128}$/;
// Ids issued before mac1: raw stable ids and any other jsym/jev version.
const PRE_MAC1 = /^(type:|type-local:|method:|field:|file:|jsym:|jev:)/;

export type DeclarationKind = "type" | "method" | "field";
export type Stability = "STABLE" | "SNAPSHOT";
export type RejectReason = "PRE_MAC1_FORMAT" | "MALFORMED" | "WORKSPACE_MISMATCH" | "NOT_STABLE";

export type SymbolResolution =
  | { status: "FOUND"; declarationKey: string; kind: DeclarationKind; relativePath: string; selection: { line: number; column: number } }
  | { status: "NOT_FOUND"; declarationKey: string; hint: { kind: DeclarationKind; name: string; sameNameCandidates: number; relocate: string } }
  | { status: "REJECTED"; reason: RejectReason };

/**
 * One declaration as one snapshot captured it. The capture is named by the snapshot's
 * contentManifestId (the digest of the content it was built from): a capture attempt's own id
 * is job-scoped and not kept with the published snapshot.
 */
export type EvidenceHandle = {
  snapshotId: string;
  contentManifestId: string;
  declarationKey: string;
  relativePath: string;
  sourceHash: string;
  range: SourceRange;
};

/** A declaration's public identities: a symbolId when its key is stable, and an evidence handle of one snapshot. */
export type DeclarationIdentity = { stability: Stability; symbolId?: string; evidenceHandle?: string };

export type EvidenceCheck =
  | { status: "VALID"; handle: EvidenceHandle }
  | { status: "STALE"; reason: "SNAPSHOT_CHANGED" | "SOURCE_CHANGED" | "DECLARATION_GONE"; handle: EvidenceHandle }
  | { status: "REJECTED"; reason: "PRE_MAC1_FORMAT" | "MALFORMED" };

const TABLE: Record<DeclarationKind, "type" | "method" | "field"> = { type: "type", method: "method", field: "field" };

export function declarationKind(declarationKey: string): DeclarationKind | undefined {
  if (declarationKey.startsWith("type:v2:") || declarationKey.startsWith("type-local:")) return "type";
  // Pre-v3 signatures double-counted array dimensions or lost declarator
  // dimensions. Accepting those keys after normalization could rebind an ID.
  if (declarationKey.startsWith(METHOD_ID_PREFIX)) return "method";
  if (declarationKey.startsWith("field:")) return "field";
  return undefined;
}

/** A key is STABLE only when no segment of its owner chain is position-keyed. */
export function declarationStability(declarationKey: string): Stability {
  return declarationKey.includes("type-local:") ? "SNAPSHOT" : "STABLE";
}

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

function decode(text: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const value = Buffer.from(text, "base64url").toString("utf8");
  return encode(value) === text ? value : undefined;
}

function requireWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error(`invalid workspaceId: ${workspaceId}`);
}

export function formatSymbolId(workspaceId: string, declarationKey: string): string {
  requireWorkspaceId(workspaceId);
  if (!declarationKind(declarationKey)) throw new Error(`not a declaration key: ${declarationKey}`);
  if (declarationStability(declarationKey) !== "STABLE") throw new Error("position-keyed declarations get an evidence handle, not a symbolId");
  return `${SYMBOL_PREFIX}${workspaceId}:${encode(declarationKey)}`;
}

export function parseSymbolId(symbolId: string):
  | { ok: true; workspaceId: string; declarationKey: string }
  | { ok: false; reason: "PRE_MAC1_FORMAT" | "MALFORMED" | "NOT_STABLE" } {
  if (!symbolId.startsWith(SYMBOL_PREFIX)) return { ok: false, reason: PRE_MAC1.test(symbolId) ? "PRE_MAC1_FORMAT" : "MALFORMED" };
  const rest = symbolId.slice(SYMBOL_PREFIX.length);
  const sep = rest.indexOf(":");
  const workspaceId = sep < 0 ? "" : rest.slice(0, sep);
  const declarationKey = sep < 0 ? undefined : decode(rest.slice(sep + 1));
  if (!WORKSPACE_ID.test(workspaceId) || !declarationKey || !declarationKind(declarationKey)) return { ok: false, reason: "MALFORMED" };
  if (declarationStability(declarationKey) !== "STABLE") return { ok: false, reason: "NOT_STABLE" };
  return { ok: true, workspaceId, declarationKey };
}

function declarationRow(db: IndexDatabase, kind: DeclarationKind, declarationKey: string): { relativePath: string; facts: SQLOutputValue } | undefined {
  const sym = symId(db, declarationKey);
  if (sym === undefined) return undefined;
  return prepareCached(db, `SELECT f.path AS relativePath, d.facts AS facts FROM ${TABLE[kind]} d JOIN file f ON f.id=d.file_id WHERE d.sym=?`).get(sym) as
    | { relativePath: string; facts: SQLOutputValue }
    | undefined;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function memberName(kind: DeclarationKind, declarationKey: string): string {
  if (kind === "type") {
    const fqn = declarationKey.startsWith("type:v2:") ? safeDecode(declarationKey.slice(declarationKey.indexOf("#") + 1)) : declarationKey;
    return fqn.slice(fqn.lastIndexOf(".") + 1);
  }
  const member = declarationKey.slice(declarationKey.lastIndexOf("#") + 1);
  return kind === "method" ? member.slice(0, member.indexOf("(") < 0 ? undefined : member.indexOf("(")) : member;
}

/**
 * Resolves a symbolId against the view bound to `workspaceId`. A miss is
 * reported with a re-locate hint (same-name candidate count), never rebound.
 */
export function resolveSymbolId(db: IndexDatabase, workspaceId: string, symbolId: string): SymbolResolution {
  const parsed = parseSymbolId(symbolId);
  if (!parsed.ok) return { status: "REJECTED", reason: parsed.reason };
  if (parsed.workspaceId !== workspaceId) return { status: "REJECTED", reason: "WORKSPACE_MISMATCH" };
  const kind = declarationKind(parsed.declarationKey)!;
  const row = declarationRow(db, kind, parsed.declarationKey);
  if (row) {
    // The name is the locator (an LSP selection), as discovery reports it.
    const facts = decodeFacts<{ range?: SourceRange; nameRange?: SourceRange }>(row.facts);
    const at = facts?.nameRange?.start ?? facts?.range?.start;
    if (at) return { status: "FOUND", declarationKey: parsed.declarationKey, kind, relativePath: row.relativePath, selection: { line: at.line, column: at.column } };
  }
  const name = memberName(kind, parsed.declarationKey);
  return {
    status: "NOT_FOUND",
    declarationKey: parsed.declarationKey,
    hint: { kind, name, sameNameCandidates: sameNameCandidates(db, kind, name), relocate: "path, name or signature changed or the declaration was deleted; query by name to re-locate" }
  };
}

// Fields have no name index: a field miss scans the field table, and a count
// equal to the cap means "at least".
export const FIELD_CANDIDATE_CAP = 100;

/** Same-name declarations a name query can re-locate: types and methods through the indexed entity table. */
function sameNameCandidates(db: IndexDatabase, kind: DeclarationKind, name: string): number {
  const row = kind === "field"
    ? prepareCached(db, "SELECT count(*) AS n FROM (SELECT 1 FROM field WHERE name=? LIMIT ?)").get(name, FIELD_CANDIDATE_CAP)
    : prepareCached(db, "SELECT count(*) AS n FROM entity WHERE simple_name_lc=? AND simple_name=? AND kind=?").get(name.toLowerCase(), name, kind);
  return Number((row as { n: number }).n);
}

const position = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;

function canonicalHandle(handle: EvidenceHandle): EvidenceHandle {
  const { start, end } = handle.range;
  if (![start.line, start.column, end.line, end.column].every(position)) throw new Error("evidence range must be non-negative safe integers");
  for (const key of ["snapshotId", "contentManifestId", "declarationKey", "relativePath", "sourceHash"] as const) {
    if (typeof handle[key] !== "string") throw new Error(`evidence ${key} must be a string`);
  }
  return {
    snapshotId: handle.snapshotId,
    contentManifestId: handle.contentManifestId,
    declarationKey: handle.declarationKey,
    relativePath: handle.relativePath,
    sourceHash: handle.sourceHash,
    range: { start: { line: start.line, column: start.column }, end: { line: end.line, column: end.column } }
  };
}

export function formatEvidenceHandle(handle: EvidenceHandle): string {
  if (!handle.snapshotId || !handle.contentManifestId || !handle.sourceHash || !declarationKind(handle.declarationKey)) throw new Error("incomplete evidence handle");
  return `${HANDLE_PREFIX}${encode(JSON.stringify(canonicalHandle(handle)))}`;
}

export function parseEvidenceHandle(text: string): { ok: true; handle: EvidenceHandle } | { ok: false; reason: "PRE_MAC1_FORMAT" | "MALFORMED" } {
  if (!text.startsWith(HANDLE_PREFIX)) return { ok: false, reason: PRE_MAC1.test(text) ? "PRE_MAC1_FORMAT" : "MALFORMED" };
  const json = decode(text.slice(HANDLE_PREFIX.length));
  try {
    const handle = canonicalHandle(JSON.parse(json ?? "") as EvidenceHandle);
    return formatEvidenceHandle(handle) === text ? { ok: true, handle } : { ok: false, reason: "MALFORMED" };
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
}

/** Builds the handle for one declaration as captured by `snapshotId` (content `contentManifestId`). */
export function captureEvidenceHandle(db: IndexDatabase, input: { snapshotId: string; contentManifestId: string; declarationKey: string }): EvidenceHandle | undefined {
  const kind = declarationKind(input.declarationKey);
  const sym = kind ? symId(db, input.declarationKey) : undefined;
  if (!kind || sym === undefined) return undefined;
  const row = prepareCached(db, `SELECT f.path AS relativePath, f.content_hash AS sourceHash, d.facts AS facts FROM ${TABLE[kind]} d JOIN file f ON f.id=d.file_id WHERE d.sym=?`).get(sym) as
    | { relativePath: string; sourceHash: string; facts: SQLOutputValue }
    | undefined;
  if (!row) return undefined;
  const range = decodeFacts<{ range?: SourceRange }>(row.facts).range;
  if (!range) return undefined;
  return { snapshotId: input.snapshotId, contentManifestId: input.contentManifestId, declarationKey: input.declarationKey, relativePath: row.relativePath, sourceHash: row.sourceHash, range };
}

/** An evidence handle serves exact-version reads: any snapshot or source change makes it stale. */
export function checkEvidenceHandle(db: IndexDatabase, currentSnapshotId: string, text: string): EvidenceCheck {
  const parsed = parseEvidenceHandle(text);
  if (!parsed.ok) return { status: "REJECTED", reason: parsed.reason };
  const { handle } = parsed;
  if (handle.snapshotId !== currentSnapshotId) return { status: "STALE", reason: "SNAPSHOT_CHANGED", handle };
  const row = declarationRow(db, declarationKind(handle.declarationKey)!, handle.declarationKey);
  if (!row || row.relativePath !== handle.relativePath) return { status: "STALE", reason: "DECLARATION_GONE", handle };
  const hash = prepareCached(db, "SELECT content_hash AS hash FROM file WHERE path=?").get(handle.relativePath) as { hash: string } | undefined;
  if (hash?.hash !== handle.sourceHash) return { status: "STALE", reason: "SOURCE_CHANGED", handle };
  return { status: "VALID", handle };
}

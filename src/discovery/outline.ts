// input: one repository Java file plus an optional nearLine and limit.
// output: a bounded, source-ordered list of the file's declarations (types, constructors,
//         methods, fields) projected from existing index facts; never a whole-file read.
// pos: java_symbol operation=outline (post-ILV2 Q03, 05 §5.2). Pure projection of
//      queryFiles([file]): no snapshot schema change, no graph, no JDT. Internal entries carry
//      declarationKey; the tool layer swaps it for the public identity before the wire.
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { JavaFileBundle } from "../java-index/index-types.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import { JavaIntelligenceError } from "../runtime/intelligence-error.js";
import { containedIn, readVerifiedEvidenceFile } from "./evidence-source-reader.js";

export const OUTLINE_DEFAULT_LIMIT = 8;
export const OUTLINE_MAX_LIMIT = 20;
/** Whole JSON wire of one outline response, indexView and identities included (05 §5.2). */
export const OUTLINE_WIRE_MAX_BYTES = 4096;

export type OutlineEntryKind = "type" | "method" | "constructor" | "field";

export interface OutlineEntryInput {
  declarationKey: string;
  kind: OutlineEntryKind;
  name: string;
  signature: string;
  startLine: number;
  endLine: number;
  selection: { line: number; column: number };
}

export type OutlineEntry = OutlineEntryInput & { containsNearLine?: true };

export type OutlineInternalResult = {
  schemaVersion: "java-outline/v1";
  generation: number;
  relativePath: string;
  contentHash: string;
  entries: OutlineEntry[];
  omittedSymbols: number;
  scopeState: "READY" | "PARTIAL" | "NOT_READY";
  reasons: string[];
};

const compareKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sourceOrder = (a: OutlineEntryInput, b: OutlineEntryInput) =>
  a.startLine - b.startLine || a.selection.column - b.selection.column || compareKey(a.declarationKey, b.declarationKey);

export function requireOutlineLimit(limit: number | undefined): number {
  const value = limit ?? OUTLINE_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > OUTLINE_MAX_LIMIT) {
    throw new JavaIntelligenceError("INVALID_INPUT", `operation=outline takes limit 1..${OUTLINE_MAX_LIMIT} (default ${OUTLINE_DEFAULT_LIMIT}); larger is rejected, not clamped.`);
  }
  return value;
}

export function requireOutlineNearLine(nearLine: number | undefined): void {
  if (nearLine !== undefined && (!Number.isInteger(nearLine) || nearLine < 1)) {
    throw new JavaIntelligenceError("INVALID_INPUT", "operation=outline takes nearLine as a positive 1-based line.");
  }
}

/**
 * Selection, then output (05 §5.2). Without nearLine: the first `limit` in source order. With
 * nearLine: declarations containing it (innermost first), then the rest by distance, ties in
 * source order then declarationKey. The picked entries come back in source order. Same-name
 * overloads stay separate: identity is the declarationKey, never the name.
 */
export function selectOutlineEntries(
  entries: readonly OutlineEntryInput[],
  options: { limit: number; nearLine?: number }
): { entries: OutlineEntry[]; omittedSymbols: number } {
  const limit = requireOutlineLimit(options.limit);
  const nearLine = options.nearLine;
  requireOutlineNearLine(nearLine);
  const unique = new Map<string, OutlineEntryInput>();
  for (const entry of [...entries].sort(sourceOrder)) if (!unique.has(entry.declarationKey)) unique.set(entry.declarationKey, entry);
  const ordered = [...unique.values()];
  const contains = (entry: OutlineEntryInput) => nearLine !== undefined && entry.startLine <= nearLine && nearLine <= entry.endLine;
  let picked: OutlineEntryInput[];
  if (nearLine === undefined) {
    picked = ordered.slice(0, limit);
  } else {
    const distance = (entry: OutlineEntryInput) => nearLine < entry.startLine ? entry.startLine - nearLine : nearLine - entry.endLine;
    const containing = ordered.filter(contains)
      .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine) || sourceOrder(a, b));
    const rest = ordered.filter(entry => !contains(entry)).sort((a, b) => distance(a) - distance(b) || sourceOrder(a, b));
    picked = [...containing, ...rest].slice(0, limit);
  }
  return {
    entries: picked.sort(sourceOrder).map(entry => (contains(entry) ? { ...entry, containsNearLine: true as const } : { ...entry })),
    omittedSymbols: ordered.length - picked.length
  };
}

const typeText = (text: string, varargs: boolean) => varargs && !text.endsWith("...") ? `${text}...` : text;

/**
 * Projection of existing facts. A compact signature is rebuilt from structured facts (no source
 * text, so no initializer or body); fields carry no name range in the facts, so their selection is
 * the declaration start (recorded in decisions.md D6).
 */
export function outlineEntriesOf(bundle: JavaFileBundle): OutlineEntryInput[] {
  const lines = (range: { start: { line: number }; end: { line: number } }) => ({ startLine: range.start.line, endLine: range.end.line });
  const selection = (range: { start: { line: number; column: number } }) => ({ line: range.start.line, column: range.start.column });
  return [
    ...bundle.types.map((type): OutlineEntryInput => ({
      declarationKey: type.typeId, kind: "type", name: type.simpleName, signature: `${type.kind} ${type.simpleName}`,
      ...lines(type.range), selection: selection(type.nameRange ?? type.range)
    })),
    ...bundle.methods.map((method): OutlineEntryInput => ({
      declarationKey: method.methodId, kind: method.constructor ? "constructor" : "method", name: method.name,
      signature: `${method.name}(${method.parameters.map(parameter => typeText(parameter.type.text, parameter.varargs)).join(", ")})`,
      ...lines(method.range), selection: selection(method.nameRange ?? method.range)
    })),
    ...bundle.fields.map((field): OutlineEntryInput => ({
      declarationKey: field.fieldId, kind: "field", name: field.name, signature: `${field.type.text} ${field.name}`,
      ...lines(field.range), selection: selection(field.range)
    }))
  ];
}

export async function runOutline(
  client: JavaIndexClientApi,
  input: { repoRoot: string; file: string; limit?: number; nearLine?: number; budget?: DeadlineBudget; indexNotReady?: boolean }
): Promise<OutlineInternalResult> {
  const limit = requireOutlineLimit(input.limit);
  requireOutlineNearLine(input.nearLine);
  const out: OutlineInternalResult = { schemaVersion: "java-outline/v1", generation: 0, relativePath: "", contentHash: "", entries: [], omittedSymbols: 0, scopeState: "READY", reasons: [] };
  const partial = (reason: string) => {
    if (out.scopeState === "READY") out.scopeState = "PARTIAL";
    if (!out.reasons.includes(reason)) out.reasons.push(reason);
  };
  const expired = () => !!input.budget && input.budget.remainingMs() <= 0;
  const reasonOf = (error: unknown) => error instanceof Error && /^[A-Z_0-9]+$/.test(error.message) ? error.message : "SOURCE_UNAVAILABLE";
  if (expired()) { partial("DEADLINE_EXCEEDED"); return out; }
  let root: string;
  try { root = await realpath(input.repoRoot); } catch { partial("REPO_UNAVAILABLE"); return out; }
  const requested = path.resolve(root, input.file);
  if (!containedIn(root, requested)) { partial("SOURCE_OUTSIDE_REPO"); return out; }
  const relative = path.relative(root, requested).split(path.sep).join("/");
  out.relativePath = relative;
  if (input.indexNotReady) {
    out.scopeState = "NOT_READY";
    partial("INDEX_COVERAGE_INCOMPLETE");
    return out;
  }
  const options = input.budget ? { budget: input.budget } : undefined;
  // The index keys files by the client's own repo root, as symbol-target does.
  let bundle: JavaFileBundle | undefined;
  let status: Awaited<ReturnType<JavaIndexClientApi["status"]>>;
  try {
    bundle = (await client.queryFiles([path.join(input.repoRoot, relative)], options)).find(entry => entry.file.relativePath === relative);
    status = await client.status(options);
  } catch (error) {
    if (expired()) { partial("DEADLINE_EXCEEDED"); return out; }
    throw error;
  }
  if (!bundle) {
    // Not in the snapshot: either not indexed yet or not an indexed Java file. Never "no declarations".
    if (status.state !== "READY") out.scopeState = "NOT_READY";
    partial(status.state === "READY" ? "ANCHOR_UNRESOLVED" : "INDEX_COVERAGE_INCOMPLETE");
    return out;
  }
  // The published index generation, not the file row's: an unchanged file keeps the generation it
  // was last written in while every publication moves coverage to the current one.
  out.generation = status.indexedGeneration;
  out.contentHash = bundle.file.contentHash;
  const coverage = status.coverage?.filter(entry => entry.root === "" || relative === entry.root || relative.startsWith(`${entry.root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (status.state !== "READY" || !coverage || coverage.state !== "COMPLETE" || coverage.generation !== out.generation) partial("INDEX_COVERAGE_INCOMPLETE");
  // FAILED facts are empty by construction: an empty outline would read as "this file declares nothing".
  if (bundle.file.parseState === "FAILED") { partial("ANCHOR_PARSE_INCOMPLETE"); return out; }
  if (bundle.file.parseState !== "COMPLETE") partial("ANCHOR_PARSE_INCOMPLETE");
  // Lines are only meaningful against the bytes they were parsed from.
  try {
    await readVerifiedEvidenceFile({ root, relativePath: relative, expectedHash: bundle.file.contentHash, ...(input.budget ? { budget: input.budget } : {}) });
  } catch (error) {
    const reason = reasonOf(error);
    partial(reason === "SOURCE_STALE" ? "ANCHOR_STALE" : reason);
    return out;
  }
  if (expired()) { partial("DEADLINE_EXCEEDED"); return out; }
  const selected = selectOutlineEntries(outlineEntriesOf(bundle), { limit, ...(input.nearLine !== undefined ? { nearLine: input.nearLine } : {}) });
  out.entries = selected.entries;
  out.omittedSymbols = selected.omittedSymbols;
  return out;
}

/** Public outline entry: declarationKey replaced by the tool layer's identity mapping. */
export type PublicOutlineEntry = Omit<OutlineEntry, "declarationKey" | "signature"> & {
  signature?: string;
  signatureOmitted?: true;
  stability: string;
  symbolId?: string;
  evidenceHandle?: string;
};

export type OutlineDiagnostic = {
  elapsedMs: number;
  omissions: { limitEntries: number; wireEntries: number; wireSignatures: number };
};

/**
 * Fit the complete public response into the wire budget (05 §5.2): first drop signatures (never
 * truncated into fake source), then whole entries, both starting from the entry least related to
 * nearLine (farthest; without nearLine the last in source order). Identity is never removed from a
 * kept entry. Returns undefined when even the entry-less envelope does not fit.
 */
export function fitOutlineWire<T extends { entries: PublicOutlineEntry[]; omittedSymbols: number; reasons: string[]; scopeState: string; diagnostic?: OutlineDiagnostic }>(
  response: T,
  nearLine: number | undefined,
  maxBytes = OUTLINE_WIRE_MAX_BYTES
): T | undefined {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size(response) <= maxBytes) return response;
  const priority = (entry: PublicOutlineEntry) => entry.containsNearLine ? -1
    : nearLine === undefined ? entry.startLine
      : nearLine < entry.startLine ? entry.startLine - nearLine : nearLine - entry.endLine;
  // Least related first; ties: later in source order first.
  const shrinkOrder = response.entries.map((entry, index) => ({ entry, index }))
    .sort((a, b) => priority(b.entry) - priority(a.entry) || b.index - a.index).map(item => item.index);
  const entries = response.entries.map(entry => ({ ...entry }));
  const reasons = response.reasons.includes("SOURCE_BUDGET") ? [...response.reasons] : [...response.reasons, "SOURCE_BUDGET"];
  const diagnostic = response.diagnostic;
  const build = (kept: PublicOutlineEntry[], omitted: number): T => ({
    ...response, entries: kept, omittedSymbols: omitted, reasons, scopeState: response.scopeState === "READY" ? "PARTIAL" : response.scopeState,
    ...(diagnostic ? { diagnostic: { ...diagnostic, omissions: {
      limitEntries: diagnostic.omissions.limitEntries,
      wireEntries: omitted - response.omittedSymbols,
      wireSignatures: kept.filter(entry => entry.signatureOmitted === true).length
    } } } : {})
  }) as T;
  for (const index of shrinkOrder) {
    const entry = entries[index]!;
    if (entry.signature !== undefined) {
      const { signature: _signature, ...rest } = entry;
      entries[index] = { ...rest, signatureOmitted: true };
    }
    const candidate = build(entries, response.omittedSymbols);
    if (size(candidate) <= maxBytes) return candidate;
  }
  const dropped = new Set<number>();
  for (const index of shrinkOrder) {
    dropped.add(index);
    const candidate = build(entries.filter((_entry, position) => !dropped.has(position)), response.omittedSymbols + dropped.size);
    if (size(candidate) <= maxBytes) return candidate;
  }
  return undefined;
}

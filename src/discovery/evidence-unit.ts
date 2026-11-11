// input: a located Java type/method (file/line/column) and the held static index.
// output: bounded, hash-verified source fragments: the Java declaration itself (signature and
//         anchor windows) plus its indexed MyBatis XML links, under one 8 unit / 80 line /
//         16000 byte budget.
// pos: java_symbol operation=evidence, java-evidence-unit/v2 (post-ILV2 Q04, 05 §5.3). Q04 only
//      emits SOURCE_FACT: the bytes are real source, no call target is claimed bound.
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { EvidenceAnchor, EvidenceSource, JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import type { JavaFileBundle } from "../java-index/index-types.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import { anchorWindows } from "./anchor-windows.js";
import { redactPreviewLine } from "./search-document.js";
import { EVIDENCE_SOURCE_MAX_FILE_BYTES, containedIn as contained, readVerifiedEvidenceFile } from "./evidence-source-reader.js";

export const EVIDENCE_UNIT_LIMITS = { maxUnits: 8, maxLines: 80, maxBytes: 16000, maxFileBytes: EVIDENCE_SOURCE_MAX_FILE_BYTES } as const;
/** Lines kept for a type's declaration head when no "{" is found earlier. */
const TYPE_HEAD_MAX_LINES = 8;
/** Java fragments take at most half the budget, so the indexed XML links that v1 delivered keep room. */
const JAVA_SHARE = { lines: EVIDENCE_UNIT_LIMITS.maxLines / 2, bytes: EVIDENCE_UNIT_LIMITS.maxBytes / 2 } as const;

export type EvidenceProof = "SOURCE_FACT" | "STATIC_CANDIDATE" | "JDT_BOUND";
export type EvidenceRole = "anchor" | "signature" | "callsite" | "definition" | "resource";
export type EvidenceUnit = Omit<EvidenceSource, "relativePath"> & {
  path: string;
  text: string;
  role: EvidenceRole;
  proof: EvidenceProof;
  /** The selected range was delivered whole; not a statement about task or repository coverage. */
  complete: boolean;
  originalEndLine?: number;
};
export type EvidenceUnitResult = {
  schemaVersion: "java-evidence-unit/v2";
  supportedScope: "java-declaration-and-indexed-resource-links";
  generation: number;
  anchor?: EvidenceAnchor;
  scopeState: "READY" | "PARTIAL";
  units: EvidenceUnit[];
  omitted: Array<{ path?: string; startLine?: number; endLine?: number; reason: string }>;
  reasons: string[];
};

/**
 * Anchor windows inside one method body under a line budget (Q04). Windows come from the
 * existing anchorWindows(): this only narrows the radius until they fit, then drops the last
 * anchors. Anchors outside the method, or dropped, are reported, never silently lost.
 */
export function selectEvidenceWindows(input: {
  methodStart: number; methodEnd: number; anchorLines: readonly number[]; maxLines: number;
}): { ranges: Array<{ startLine: number; endLine: number }>; omittedAnchors: number[] } {
  const { methodStart, methodEnd, maxLines } = input;
  if (!Number.isInteger(maxLines) || maxLines < 0) throw new Error("invalid maxLines");
  const anchors = [...new Set(input.anchorLines)].sort((a, b) => a - b);
  const inside = anchors.filter(line => Number.isInteger(line) && line >= methodStart && line <= methodEnd);
  const outside = anchors.filter(line => !inside.includes(line));
  const total = (ranges: Array<{ startLine: number; endLine: number }>) => ranges.reduce((sum, range) => sum + range.endLine - range.startLine + 1, 0);
  for (let kept = inside.length; kept > 0; kept -= 1) {
    const chosen = inside.slice(0, kept);
    for (let radius = 16; radius >= 0; radius -= 1) {
      const ranges = anchorWindows(methodStart, methodEnd, chosen, radius);
      if (total(ranges) <= maxLines) return { ranges, omittedAnchors: [...outside, ...inside.slice(kept)].sort((a, b) => a - b) };
    }
  }
  return { ranges: [], omittedAnchors: anchors };
}

type Fragment = EvidenceSource & { role: EvidenceRole };

/** Source fragments of the anchor declaration itself, from the same bundle facts the anchor came from. */
function javaFragments(anchor: EvidenceAnchor, bundle: JavaFileBundle, lines: readonly string[], requestedLine: number,
  remaining: { lines: number; bytes: number }): { fragments: Fragment[]; bodyPartial: { startLine: number; endLine: number } | undefined } | undefined {
  const base = { relativePath: anchor.relativePath, contentHash: anchor.contentHash, relation: "java-declaration" as const };
  const bytesOf = (start: number, end: number) => lines.slice(start - 1, end).reduce((sum, line) => sum + Buffer.byteLength(line, "utf8"), 0);
  if (anchor.kind === "METHOD") {
    const method = bundle.methods.find(entry => entry.methodId === anchor.declarationId);
    if (!method) return undefined;
    const start = method.range.start.line;
    const end = Math.min(method.range.end.line, lines.length);
    const sourceKind = method.constructor ? "java-constructor" : "java-method";
    if (end - start + 1 <= remaining.lines && bytesOf(start, end) <= remaining.bytes) {
      return { fragments: [{ ...base, sourceKind, startLine: start, endLine: end, role: "anchor" }], bodyPartial: undefined };
    }
    // Too large for the budget: the declaration head, then windows around the requested line.
    const headEnd = Math.min(method.bodyRange?.start.line ?? end, end);
    const head: Fragment = { ...base, sourceKind, startLine: start, endLine: headEnd, role: "signature" };
    const windows = headEnd < end
      ? selectEvidenceWindows({ methodStart: headEnd + 1, methodEnd: end, anchorLines: [requestedLine], maxLines: Math.max(0, remaining.lines - (headEnd - start + 1)) }).ranges
      : [];
    return {
      fragments: [head, ...windows.map((range): Fragment => ({ ...base, sourceKind, ...range, role: "anchor" }))],
      bodyPartial: { startLine: start, endLine: end }
    };
  }
  const type = bundle.types.find(entry => entry.typeId === anchor.declarationId);
  if (!type) return undefined;
  const nameLine = (type.nameRange ?? type.range).start.line;
  // Long annotation blocks are skipped rather than letting them push the type name out of the head.
  const start = nameLine - type.range.start.line >= TYPE_HEAD_MAX_LINES ? nameLine : type.range.start.line;
  const limit = Math.min(type.range.end.line, lines.length, start + TYPE_HEAD_MAX_LINES - 1);
  let headEnd = Math.min(Math.max(nameLine, start), limit);
  for (let line = headEnd; line <= limit; line += 1) {
    if (lines[line - 1]?.includes("{")) { headEnd = line; break; }
  }
  return { fragments: [{ ...base, sourceKind: `java-${type.kind}`, startLine: start, endLine: headEnd, role: "signature" }], bodyPartial: undefined };
}

export async function runEvidenceUnit(
  client: JavaIndexClientApi,
  input: { repoRoot: string; file: string; line: number; column: number; budget?: DeadlineBudget }
): Promise<EvidenceUnitResult> {
  const out: EvidenceUnitResult = { schemaVersion: "java-evidence-unit/v2", supportedScope: "java-declaration-and-indexed-resource-links", generation: 0, scopeState: "READY", units: [], omitted: [], reasons: [] };
  const partial = (reason: string, source?: { relativePath: string; startLine: number; endLine: number }) => {
    out.scopeState = "PARTIAL";
    if (!out.reasons.includes(reason)) out.reasons.push(reason);
    out.omitted.push({ ...(source ? { path: source.relativePath, startLine: source.startLine, endLine: source.endLine } : {}), reason });
  };
  const expired = () => !!input.budget && input.budget.remainingMs() <= 0;
  const reasonOf = (error: unknown) => error instanceof Error && /^[A-Z_0-9]+$/.test(error.message) ? error.message : "SOURCE_UNAVAILABLE";
  const read = (root: string, relativePath: string, expectedHash: string) =>
    readVerifiedEvidenceFile({ root, relativePath, expectedHash, ...(input.budget ? { budget: input.budget } : {}) });
  if (expired()) { partial("DEADLINE_EXCEEDED"); return out; }
  let root: string;
  try { root = await realpath(input.repoRoot); } catch { partial("REPO_UNAVAILABLE"); return out; }
  const requestedPath = path.resolve(root, input.file);
  if (!contained(root, requestedPath)) { partial("SOURCE_OUTSIDE_REPO"); return out; }
  const relative = path.relative(root, requestedPath).split(path.sep).join("/");
  // The experimental SQL scan observes this same absolute caller deadline.
  const options = input.budget ? { budget: input.budget } : undefined;
  const sources = await client.queryEvidenceSources(relative, input.line, input.column, options);
  out.generation = sources.generation;
  out.anchor = sources.anchor;
  if (sources.partial) { out.scopeState = "PARTIAL"; out.reasons.push(...sources.reasons); }
  if (!sources.anchor) { partial("ANCHOR_UNRESOLVED"); return out; }
  const anchor = sources.anchor;
  let anchorText: string;
  try {
    anchorText = (await read(root, anchor.relativePath, anchor.contentHash)).text;
  } catch (error) { const reason = reasonOf(error); partial(reason === "SOURCE_STALE" ? "ANCHOR_STALE" : reason); return out; }
  let usedLines = 0;
  let usedBytes = 0;
  // Preserve original LF/CRLF bytes, including each selected whole line's terminator.
  const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const deliver = (source: Fragment, lines: readonly string[]) => {
    if (expired()) { partial("DEADLINE_EXCEEDED", source); return; }
    if (out.units.length >= EVIDENCE_UNIT_LIMITS.maxUnits) { partial("UNIT_CAP", source); return; }
    if (!Number.isInteger(source.startLine) || !Number.isInteger(source.endLine) || source.startLine < 1 || source.endLine < source.startLine || source.endLine > lines.length) {
      partial("SOURCE_RANGE_INVALID", source); return;
    }
    const selected = lines.slice(source.startLine - 1, source.endLine);
    if (selected.some(line => redactPreviewLine(line) !== line)) { partial("SOURCE_SENSITIVE", source); return; }
    const kept: string[] = [];
    for (const line of selected) {
      const bytes = Buffer.byteLength(line, "utf8");
      // Whole lines only: an over-long line is omitted, never cut into fake source.
      if (usedLines >= EVIDENCE_UNIT_LIMITS.maxLines || usedBytes + bytes > EVIDENCE_UNIT_LIMITS.maxBytes || expired()) break;
      kept.push(line); usedLines++; usedBytes += bytes;
    }
    const complete = kept.length === selected.length;
    if (!complete) partial(expired() ? "DEADLINE_EXCEEDED" : "SOURCE_BUDGET", source);
    if (kept.length) {
      const { relativePath: sourcePath, role, ...metadata } = source;
      out.units.push({ ...metadata, path: sourcePath, endLine: source.startLine + kept.length - 1, ...(!complete ? { originalEndLine: source.endLine } : {}),
        text: kept.join(""), role, proof: "SOURCE_FACT", complete });
    }
  };
  // Java declaration first: the anchor is the reason for the request and must not be starved by links.
  let bundle: JavaFileBundle | undefined;
  try {
    bundle = (await client.queryFiles([path.join(input.repoRoot, anchor.relativePath)], options)).find(entry => entry.file.relativePath === anchor.relativePath);
  } catch { bundle = undefined; if (expired()) { partial("DEADLINE_EXCEEDED"); } }
  const anchorLines = splitLines(anchorText);
  const java = bundle && bundle.file.contentHash === anchor.contentHash
    ? javaFragments(anchor, bundle, anchorLines, input.line, JAVA_SHARE)
    : undefined;
  if (!java) {
    // A deadline already reported is not an unresolved anchor.
    if (!expired()) partial("ANCHOR_UNRESOLVED", { relativePath: anchor.relativePath, startLine: anchor.line, endLine: anchor.line });
  } else {
    for (const fragment of java.fragments) deliver(fragment, anchorLines);
    if (java.bodyPartial) partial("BODY_PARTIAL", { relativePath: anchor.relativePath, ...java.bodyPartial });
  }
  for (const source of sources.sources) {
    if (expired()) { partial("DEADLINE_EXCEEDED", source); continue; }
    if (out.units.length >= EVIDENCE_UNIT_LIMITS.maxUnits) { partial("UNIT_CAP", source); continue; }
    try {
      const file = await read(root, source.relativePath, source.contentHash);
      deliver({ ...source, role: "resource" }, splitLines(file.text));
    } catch (error) { partial(reasonOf(error), source); }
  }
  // Recheck the anchor after asynchronous resource reads, then the published DB generation.
  try {
    await read(root, anchor.relativePath, anchor.contentHash);
  } catch (error) { out.units = []; const reason = reasonOf(error); partial(reason === "SOURCE_STALE" ? "ANCHOR_STALE" : reason); }
  if (expired()) { out.units = []; partial("DEADLINE_EXCEEDED"); return out; }
  const status = await client.status(options);
  const coverage = status.coverage?.filter(entry => entry.root === "" || anchor.relativePath === entry.root || anchor.relativePath.startsWith(`${entry.root}/`)).sort((a,b) => b.root.length-a.root.length)[0];
  if (status.state !== "READY" || !coverage || coverage.state !== "COMPLETE" || coverage.generation !== out.generation) partial("INDEX_COVERAGE_INCOMPLETE");
  if (status.indexedGeneration !== out.generation) { out.units = []; partial("GENERATION_CHANGED"); }
  return out;
}

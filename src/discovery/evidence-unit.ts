import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { EvidenceAnchor, EvidenceSource, JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";
import { redactPreviewLine } from "./search-document.js";

export const EVIDENCE_UNIT_LIMITS = { maxUnits: 8, maxLines: 80, maxBytes: 16000, maxFileBytes: 2 * 1024 * 1024 } as const;
export type EvidenceUnit = Omit<EvidenceSource, "relativePath"> & { path: string; text: string; complete: boolean; originalEndLine?: number };
export type EvidenceUnitResult = {
  schemaVersion: "java-evidence-unit/v1";
  supportedScope: "indexed-mybatis-xml-fqn-links";
  generation: number;
  anchor?: EvidenceAnchor;
  scopeState: "READY" | "PARTIAL";
  units: EvidenceUnit[];
  omitted: Array<{ path?: string; startLine?: number; endLine?: number; reason: string }>;
  reasons: string[];
};


function contained(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Read and hash the complete bounded file; never credit redacted/partial bytes as source. */
async function readSource(root: string, relative: string, budget?: DeadlineBudget): Promise<{ text: string; hash: string }> {
  if (path.isAbsolute(relative) || !contained(root, path.resolve(root, relative))) throw new Error("SOURCE_OUTSIDE_REPO");
  const resolved = await realpath(path.resolve(root, relative));
  if (!contained(root, resolved)) throw new Error("SOURCE_OUTSIDE_REPO");
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("SOURCE_NOT_FILE");
    if (before.size > EVIDENCE_UNIT_LIMITS.maxFileBytes) throw new Error("SOURCE_FILE_CAP");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      if (budget && budget.remainingMs() <= 0) throw new Error("DEADLINE_EXCEEDED");
      const chunk = Buffer.allocUnsafe(16384);
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > EVIDENCE_UNIT_LIMITS.maxFileBytes) throw new Error("SOURCE_FILE_CAP");
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    const current = await stat(resolved);
    if (after.ino !== current.ino || after.dev !== current.dev || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(path.resolve(root, relative)) !== resolved) throw new Error("SOURCE_CHANGED");
    const buffer = Buffer.concat(chunks);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    return { text, hash: createHash("sha256").update(buffer).digest("hex") };
  } finally { await handle.close(); }
}

export async function runEvidenceUnit(
  client: JavaIndexClientApi,
  input: { repoRoot: string; file: string; line: number; column: number; budget?: DeadlineBudget }
): Promise<EvidenceUnitResult> {
  const out: EvidenceUnitResult = { schemaVersion: "java-evidence-unit/v1", supportedScope: "indexed-mybatis-xml-fqn-links", generation: 0, scopeState: "READY", units: [], omitted: [], reasons: [] };
  const partial = (reason: string, source?: EvidenceSource) => {
    out.scopeState = "PARTIAL";
    if (!out.reasons.includes(reason)) out.reasons.push(reason);
    out.omitted.push({ ...(source ? { path: source.relativePath, startLine: source.startLine, endLine: source.endLine } : {}), reason });
  };
  const expired = () => !!input.budget && input.budget.remainingMs() <= 0;
  const reasonOf = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "SOURCE_UNAVAILABLE";
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
  try {
    const source = await readSource(root, sources.anchor.relativePath, input.budget);
    if (source.hash !== sources.anchor.contentHash) { partial("ANCHOR_STALE"); return out; }
  } catch (error) { partial(reasonOf(error)); return out; }
  let usedLines = 0;
  let usedBytes = 0;
  for (const source of sources.sources) {
    if (expired()) { partial("DEADLINE_EXCEEDED", source); continue; }
    if (out.units.length >= EVIDENCE_UNIT_LIMITS.maxUnits) { partial("UNIT_CAP", source); continue; }
    if (!Number.isInteger(source.startLine) || !Number.isInteger(source.endLine) || source.startLine < 1 || source.endLine < source.startLine) { partial("SOURCE_RANGE_INVALID", source); continue; }
    try {
      const file = await readSource(root, source.relativePath, input.budget);
      if (file.hash !== source.contentHash) { partial("SOURCE_STALE", source); continue; }
      // Preserve original LF/CRLF bytes, including each selected whole line's terminator.
      const lines = file.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (source.endLine > lines.length) { partial("SOURCE_RANGE_INVALID", source); continue; }
      const selected = lines.slice(source.startLine - 1, source.endLine);
      if (selected.some(line => redactPreviewLine(line) !== line)) { partial("SOURCE_SENSITIVE", source); continue; }
      const kept: string[] = [];
      for (const line of selected) {
        const bytes = Buffer.byteLength(line, "utf8");
        if (usedLines >= EVIDENCE_UNIT_LIMITS.maxLines || usedBytes + bytes > EVIDENCE_UNIT_LIMITS.maxBytes || expired()) break;
        kept.push(line); usedLines++; usedBytes += bytes;
      }
      const complete = kept.length === selected.length;
      if (!complete) partial(expired() ? "DEADLINE_EXCEEDED" : "SOURCE_BUDGET", source);
      if (kept.length) {
        const { relativePath: sourcePath, ...metadata } = source;
        out.units.push({ ...metadata, path: sourcePath, endLine: source.startLine + kept.length - 1, ...(!complete ? { originalEndLine: source.endLine } : {}), text: kept.join(""), complete });
      }
    } catch (error) { partial(reasonOf(error), source); }
  }
  // Recheck the anchor after asynchronous resource reads, then the published DB generation.
  try {
    const anchor = await readSource(root, sources.anchor.relativePath, input.budget);
    if (anchor.hash !== sources.anchor.contentHash) { out.units = []; partial("ANCHOR_STALE"); }
  } catch (error) { out.units = []; partial(reasonOf(error)); }
  if (expired()) { out.units = []; partial("DEADLINE_EXCEEDED"); return out; }
  const status = await client.status(options);
  const coverage = status.coverage?.filter(entry => entry.root === "" || sources.anchor!.relativePath === entry.root || sources.anchor!.relativePath.startsWith(`${entry.root}/`)).sort((a,b) => b.root.length-a.root.length)[0];
  if (status.state !== "READY" || !coverage || coverage.state !== "COMPLETE" || coverage.generation !== out.generation) partial("INDEX_COVERAGE_INCOMPLETE");
  if (status.indexedGeneration !== out.generation) { out.units = []; partial("GENERATION_CHANGED"); }
  return out;
}

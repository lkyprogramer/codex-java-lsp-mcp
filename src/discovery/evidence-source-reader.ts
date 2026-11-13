// input: a repository root (already realpath'd) and a repository-relative file.
// output: the complete bounded bytes of that file as UTF-8 text plus their sha256.
// pos: shared by java_symbol evidence and outline (post-ILV2 Q03/Q04). Never credits
//      redacted, partial or changed bytes as source; failures are UPPER_SNAKE reasons.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { DeadlineBudget } from "../runtime/deadline-budget.js";

export const EVIDENCE_SOURCE_MAX_FILE_BYTES = 2 * 1024 * 1024;

export function containedIn(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Read and hash the complete bounded file (05 §5.4); never credit redacted/partial bytes as source.
 * Bytes whose hash differs from expectedHash are refused as SOURCE_STALE: new text is never
 * returned under an old hash.
 */
export async function readVerifiedEvidenceFile(input: {
  root: string; relativePath: string; expectedHash: string; maxFileBytes?: number; budget?: DeadlineBudget;
}): Promise<{ bytes: Uint8Array; text: string; contentHash: string }> {
  const { root, relativePath: relative, budget } = input;
  const maxFileBytes = Math.min(input.maxFileBytes ?? EVIDENCE_SOURCE_MAX_FILE_BYTES, EVIDENCE_SOURCE_MAX_FILE_BYTES);
  if (path.isAbsolute(relative) || !containedIn(root, path.resolve(root, relative))) throw new Error("SOURCE_OUTSIDE_REPO");
  const resolved = await realpath(path.resolve(root, relative));
  if (!containedIn(root, resolved)) throw new Error("SOURCE_OUTSIDE_REPO");
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("SOURCE_NOT_FILE");
    if (before.size > maxFileBytes) throw new Error("SOURCE_FILE_CAP");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      if (budget && budget.remainingMs() <= 0) throw new Error("DEADLINE_EXCEEDED");
      const chunk = Buffer.allocUnsafe(16384);
      const read = await handle.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxFileBytes) throw new Error("SOURCE_FILE_CAP");
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const after = await handle.stat();
    const current = await stat(resolved);
    if (after.ino !== current.ino || after.dev !== current.dev || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await realpath(path.resolve(root, relative)) !== resolved) throw new Error("SOURCE_CHANGED");
    const buffer = Buffer.concat(chunks);
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    if (contentHash !== input.expectedHash) throw new Error("SOURCE_STALE");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); } catch { throw new Error("SOURCE_NOT_UTF8"); }
    return { bytes: new Uint8Array(buffer), text, contentHash };
  } finally { await handle.close(); }
}

import { createHash } from "node:crypto";
import path from "node:path";
import { open, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileStat } from "./index-types.js";
export type SourceCapture = { readonly repoRoot: string; readonly inputPath: string; readonly bytes: Buffer; readonly contentHash: string; readonly observed?: FileStat };
export async function sourcePathWithinRoot(repoRoot: string, absolutePath: string): Promise<string> {
 const root = await realpath(repoRoot);
 const resolved = await realpath(absolutePath);
 const relative = path.relative(root, resolved);
 if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Source resolves outside repo root: ${absolutePath}`);
 return resolved;
}
/** A bounded attempt, never retries until a workspace becomes quiet. */
export async function captureSource(repoRoot: string, absolutePath: string): Promise<SourceCapture> {
 const readable = await sourcePathWithinRoot(repoRoot, absolutePath);
 const fd = await open(readable, "r");
 try {
  const before = await fd.stat({ bigint: true }); const bytes = await fd.readFile(); const after = await fd.stat({ bigint: true });
  const observed = fileStatOf(before);
  const stable = Number(before.size) === bytes.length && JSON.stringify(observed) === JSON.stringify(fileStatOf(after));
  return {repoRoot: await realpath(repoRoot),inputPath:path.resolve(absolutePath),bytes,contentHash:createHash("sha256").update(bytes).digest("hex"),...(stable ? {observed} : {})};
 } finally {await fd.close();}
}

export function fileStatOf(info: BigIntStats): FileStat {
 return { size: Number(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs), ino: String(info.ino), dev: String(info.dev) };
}

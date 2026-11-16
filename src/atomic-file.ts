// input: a target path and its full new contents.
// output: the target replaced in one rename, never observed half-written.
// pos: the single home of tmp-then-rename writes (audit 2026-11-16 L3). Async and sync share one rule set:
//      a unique tmp in the target's directory created with `wx`, fsync of the tmp, rename, fsync of the directory.
//      fsync is ordering, not a power-loss claim. New tmp-then-rename code must reuse these two functions.
import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** A tmp name next to `file`: same directory (so rename is atomic) and unique per process and call. */
export function atomicTmpPath(file: string): string {
  return `${file}.tmp-${process.pid}-${randomUUID()}`;
}

export async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function syncDir(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function syncPathSync(target: string): void {
  const fd = openSync(target, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Write `file` atomically: tmp in the same directory, sync, rename, sync the directory.
 * The hooks are crash-injection points; a failure leaves the tmp behind as a crash would.
 */
export async function writeFileAtomic(file: string, data: string, mode = 0o644,
  hooks?: { afterTmp?: () => void | Promise<void>; afterRename?: () => void | Promise<void> }): Promise<void> {
  const tmp = atomicTmpPath(file);
  await writeFile(tmp, data, { mode, flag: "wx" });
  await syncFile(tmp);
  await hooks?.afterTmp?.();
  await rename(tmp, file);
  await hooks?.afterRename?.();
  await syncDir(path.dirname(file));
}

/**
 * Synchronous twin of writeFileAtomic with the same rules, for callers that cannot await
 * (lease and ownership metadata). On failure before the rename it removes its tmp and rethrows.
 */
export function writeFileAtomicSync(file: string, data: string, mode = 0o644): void {
  const tmp = atomicTmpPath(file);
  try {
    writeFileSync(tmp, data, { mode, flag: "wx" });
    syncPathSync(tmp);
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  syncPathSync(path.dirname(file));
}

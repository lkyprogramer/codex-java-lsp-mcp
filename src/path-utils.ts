// input: Local filesystem paths.
// output: Canonical path and containment helpers shared by MCP and hooks.
// pos: One path boundary implementation; do not duplicate startsWith checks.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  if (!existsSync(resolved)) {
    return resolved;
  }
  return realpathSync.native(resolved);
}

export function isWithin(root: string, candidate: string): boolean {
  const canonicalRoot = canonicalPath(root);
  const canonicalCandidate = canonicalPath(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Canonicalizes a path that may not exist yet by resolving the deepest existing
 * ancestor and re-appending the missing suffix. `canonicalPath` gives up on a
 * missing path, which lets `repo/link/Missing.java` look contained even when
 * `repo/link` is a symlink pointing outside the repo.
 *
 * A watcher can report a path that vanishes between the existence check and
 * the realpath call below (e.g. chokidar's ignore check racing its own
 * remove handling during the initial scan), so both realpath calls treat a
 * mid-flight ENOENT as "does not exist" instead of letting it crash the
 * process uncaught.
 */
export function canonicalPotentialPath(value: string): string {
  const resolved = path.resolve(value);
  if (existsSync(resolved)) {
    const settled = tryRealpathNative(resolved);
    if (settled !== undefined) return settled;
  }

  const suffix: string[] = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  const canonicalAncestor = existsSync(cursor) ? tryRealpathNative(cursor) ?? cursor : cursor;
  return path.join(canonicalAncestor, ...suffix);
}

function tryRealpathNative(resolved: string): string | undefined {
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function isPotentiallyWithin(root: string, candidate: string): boolean {
  const canonicalRoot = canonicalPotentialPath(root);
  const canonicalCandidate = canonicalPotentialPath(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative));
}

export function repoHash(repoRoot: string): string {
  return createHash("sha1").update(canonicalPath(repoRoot)).digest("hex").slice(0, 12);
}

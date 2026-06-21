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

export function repoHash(repoRoot: string): string {
  return createHash("sha1").update(canonicalPath(repoRoot)).digest("hex").slice(0, 12);
}

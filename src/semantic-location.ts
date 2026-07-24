// input: Raw LSP locations from JDT LS.
// output: Repo-relative locations, or nothing when the hit is outside the repo.
// pos: The single containment boundary for semantic results. JDT resolves into
//      ~/.m2 jars and JDK sources; those are never this repository's evidence.
import path from "node:path";
import { canonicalPotentialPath, isPotentiallyWithin } from "./path-utils.js";
import { fromFileUri } from "./repo-layout.js";
import type { LspLocation, LspLocationLink } from "./jdtls-session.js";
import type { SourceRange } from "./runtime/source-range.js";

export type RepoLocation = {
  absolutePath: string;
  relativePath: string;
  range: SourceRange;
};

export function normalizeRepoLocation(
  repoRoot: string,
  location: LspLocation | LspLocationLink
): RepoLocation | undefined {
  const uri = "targetUri" in location ? location.targetUri : location.uri;
  const rawRange = "targetSelectionRange" in location
    ? location.targetSelectionRange
    : location.range;
  if (!uri || !rawRange) {
    return undefined;
  }
  let rawPath: string | undefined;
  try {
    rawPath = fromFileUri(uri);
  } catch {
    return undefined;
  }
  if (!rawPath || !isPotentiallyWithin(repoRoot, rawPath)) {
    return undefined;
  }
  const root = canonicalPotentialPath(repoRoot);
  const file = canonicalPotentialPath(rawPath);
  const relativePath = path.relative(root, file);
  if (!relativePath || relativePath === ".") {
    return undefined;
  }
  return {
    // Containment is decided canonically, but the returned path is rebuilt from
    // the caller's repoRoot so it matches every other absolutePath in the
    // system. Returning the canonical form would key caches and edge records
    // under a different string whenever repoRoot sits behind a symlink.
    absolutePath: path.resolve(repoRoot, relativePath),
    relativePath,
    range: {
      start: {
        line: rawRange.start.line + 1,
        column: rawRange.start.character + 1
      },
      end: {
        line: rawRange.end.line + 1,
        column: rawRange.end.character + 1
      }
    }
  };
}

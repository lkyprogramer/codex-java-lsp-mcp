// input: unresolved exact FQNs plus discovered source roots.
// output: Existing conventional Java declaration paths to refresh on a cold index.
// pos: Extracted from RouterJavaIndex so cold-path completion is not inlined
//      in the router query facade.
import { existsSync } from "node:fs";
import path from "node:path";

export const MAX_COLD_DECLARATION_FQN_RETRIES = 16;
export const MAX_COLD_DECLARATION_PATH_CHECKS = 512;

export function conventionalDeclarationCandidates(
  repoRoot: string,
  sourceRoots: readonly string[],
  fqns: readonly string[]
): string[] {
  const candidates: string[] = [];
  let pathChecks = 0;
  for (const fqn of fqns.slice(0, MAX_COLD_DECLARATION_FQN_RETRIES)) {
    const topLevelFqn = fqn.split("$")[0] ?? "";
    const segments = topLevelFqn.split(".");
    if (segments.length === 0 || segments.some(segment => !/^[A-Za-z_$][\w$]*$/.test(segment))) {
      continue;
    }
    const suffix = `${segments.join(path.sep)}.java`;
    for (const sourceRoot of sourceRoots) {
      if (pathChecks >= MAX_COLD_DECLARATION_PATH_CHECKS) {
        return unique(candidates);
      }
      pathChecks += 1;
      const absolutePath = path.join(repoRoot, sourceRoot, suffix);
      if (existsSync(absolutePath)) candidates.push(absolutePath);
    }
  }
  return unique(candidates);
}

export function isExactFqn(value: string): boolean {
  const segments = (value.split("$")[0] ?? "").split(".");
  return segments.length > 1 && segments.every(segment => /^[A-Za-z_$][\w$]*$/.test(segment));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

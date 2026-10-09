// input: The source roots the index was built from (layout-probe roots as
//        published in index coverage) and a module/sourceSet request.
// output: A resolved search scope: exact source-root ids (module AND
//         sourceSet), an explicit EMPTY with its reason, or PARTIAL when the
//         layout is unknown.
// pos: docs/03 §2 scope contract for java_symbol static discovery. Roots come
//      from index/layout metadata, never from the agent; an unknown module is
//      never widened to the whole repository.

export type DiscoverySourceSetFilter = "main" | "test";

export type SourceRootRecord = {
  /** Stable id: the root's repo-relative path. */
  id: string;
  relativePath: string;
  /** Layout module name ("." for the repository root module). */
  module: string;
  /** Module directory relative to the repository ("." for the root). */
  modulePath: string;
  sourceSet: DiscoverySourceSetFilter;
  kind: "java" | "resource";
};

export type ResolvedSearchScope =
  | { state: "UNSCOPED" }
  | { state: "RESOLVED"; sourceRootIds: string[] }
  | { state: "EMPTY"; reason: "UNKNOWN_MODULE" | "AMBIGUOUS_MODULE" | "NO_SOURCE_ROOT" }
  | { state: "PARTIAL"; reason: "LAYOUT_UNKNOWN"; sourceRootIds: string[] };

export type SearchScopeRequest = { module?: string; sourceSet?: DiscoverySourceSetFilter };

/** Build-declared module names (e.g. Maven artifactId) -> module directories. */
export type ModuleAliases = ReadonlyMap<string, readonly string[]>;

const POSIX = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");

/**
 * A layout source root path (`<module dir>/src/<set>/java`, as layout-probe
 * publishes it) as a scope record. Roots whose shape does not say their
 * source set are not scopable by sourceSet and are skipped.
 */
export function sourceRootRecordFromPath(rootPath: string): SourceRootRecord | undefined {
  const relativePath = POSIX(rootPath);
  const parts = relativePath.split("/");
  const src = parts.lastIndexOf("src");
  const set = src >= 0 ? parts[src + 1] : undefined;
  if (set !== "main" && set !== "test") return undefined;
  const modulePath = src <= 0 ? "." : parts.slice(0, src).join("/");
  const module = modulePath === "." ? "." : modulePath.split("/").pop()!;
  const kind = parts[src + 2] === "resources" ? "resource" : "java";
  return { id: relativePath, relativePath, module, modulePath, sourceSet: set, kind };
}

/**
 * module and sourceSet combine as AND over real layout roots. A module name
 * matches the module directory, else a layout module name that names exactly
 * one module directory; "." / "" is the root module. Unknown module ->
 * EMPTY(UNKNOWN_MODULE), a name shared by several module directories ->
 * EMPTY(AMBIGUOUS_MODULE); a known module
 * without the requested source set -> EMPTY(NO_SOURCE_ROOT); no layout roots
 * at all -> PARTIAL(LAYOUT_UNKNOWN) with the conventional
 * `<module>/src/<set>` prefixes, flagged so callers never read it as exact.
 */
export function resolveSearchScope(
  roots: readonly SourceRootRecord[],
  request: SearchScopeRequest,
  aliases: ModuleAliases | (() => ModuleAliases) = new Map()
): ResolvedSearchScope {
  const module = request.module === undefined ? undefined : POSIX(request.module.trim()) || ".";
  const sourceSet = request.sourceSet;
  if (module === undefined && sourceSet === undefined) return { state: "UNSCOPED" };
  const javaRoots = roots.filter(root => root.kind === "java");
  if (javaRoots.length === 0) {
    const base = module === undefined || module === "." ? "" : `${module}/`;
    const prefix = sourceSet ? `${base}src/${sourceSet}` : (base ? base.slice(0, -1) : "src");
    return { state: "PARTIAL", reason: "LAYOUT_UNKNOWN", sourceRootIds: [prefix] };
  }
  let inModule = javaRoots;
  if (module !== undefined) {
    // An exact module directory wins; a bare layout name that names several
    // module directories (a/core, b/core) is ambiguous, never a union.
    // Then a build-declared module name (Maven artifactId) whose directory
    // differs from the name.
    const byPath = javaRoots.filter(root => root.modulePath === module);
    let byName = javaRoots.filter(root => root.module === module);
    if (byPath.length === 0 && byName.length === 0) {
      const aliasMap = typeof aliases === "function" ? aliases() : aliases;
      const dirs = new Set(aliasMap.get(module) ?? []);
      byName = javaRoots.filter(root => dirs.has(root.modulePath));
    }
    inModule = byPath.length > 0 ? byPath : byName;
    if (inModule.length === 0) return { state: "EMPTY", reason: "UNKNOWN_MODULE" };
    if (byPath.length === 0 && new Set(byName.map(root => root.modulePath)).size > 1) {
      return { state: "EMPTY", reason: "AMBIGUOUS_MODULE" };
    }
  }
  const selected = sourceSet === undefined ? inModule : inModule.filter(root => root.sourceSet === sourceSet);
  if (selected.length === 0) return { state: "EMPTY", reason: "NO_SOURCE_ROOT" };
  return { state: "RESOLVED", sourceRootIds: [...new Set(selected.map(root => root.id))].sort() };
}

// input: Java repository root plus coarse layout hint.
// output: Detected source/resource roots for router and watcher reuse.
// pos: Shared lightweight layout probe; falls back to current broad scan behavior.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

export type LayoutKind = "gradle-multi" | "maven-multi" | "single" | "flat-layers";

export type SourceRootInfo = {
  relativePath: string;
  module: string;
  sourceSet: "main" | "test";
};

export type LayoutContext = {
  layout: LayoutKind;
  layoutProfile: string;
  sourceRoots: SourceRootInfo[];
  resourceRoots: string[];
  broadRoots: string[];
  /**
   * Source/resource roots reached through a symlink: neither indexed nor tracked. The tracker's
   * census never follows links, so discovery must not either; publishes report them as a
   * coverage gap instead of claiming their content.
   */
  symlinkedRoots?: string[];
};

export function probeLayout(repoRoot: string, layoutProfile = "generic-java"): LayoutContext {
  const linked = new Set<string>();
  const contentRoot = (relativePath: string): boolean => {
    if (!isDirectory(path.join(repoRoot, relativePath))) return false;
    const symlinked = throughSymlink(repoRoot, relativePath);
    if (symlinked) linked.add(relativePath);
    return symlinked === false;
  };
  const sourceRoots = sourceRootInfos(repoRoot, contentRoot);
  const resourceRoots = resourceRootInfos(repoRoot, contentRoot);
  return {
    layout: detectLayout(repoRoot, sourceRoots),
    layoutProfile,
    sourceRoots,
    resourceRoots,
    broadRoots: broadRoots(repoRoot, sourceRoots),
    ...(linked.size ? { symlinkedRoots: [...linked].sort() } : {})
  };
}

type Prober = { worker: Worker; waiting: Map<number, { resolve: (layout: LayoutContext) => void; reject: (error: Error) => void }>; next: number };
let prober: Prober | undefined;

/**
 * probeLayout on one shared worker thread: the walk's synchronous stat/readdir never block the calling
 * event loop. The worker keeps the process alive only while a probe is outstanding; if it dies, the
 * waiting probes reject and the next call starts a new one.
 */
export function probeLayoutOffThread(repoRoot: string, layoutProfile = "generic-java"): Promise<LayoutContext> {
  const state = prober ??= startProber();
  const id = state.next++;
  return new Promise((resolve, reject) => {
    if (state.waiting.size === 0) state.worker.ref();
    state.waiting.set(id, { resolve, reject });
    state.worker.postMessage({ id, repoRoot, layoutProfile });
  });
}

function startProber(): Prober {
  const worker = new Worker(new URL("./layout-probe-worker.js", import.meta.url), { execArgv: ["--disable-warning=ExperimentalWarning"] });
  worker.unref();
  const state: Prober = { worker, waiting: new Map(), next: 1 };
  worker.on("message", (reply: { id: number; value?: LayoutContext; error?: string; code?: string }) => {
    const waiter = state.waiting.get(reply.id);
    state.waiting.delete(reply.id);
    if (state.waiting.size === 0) worker.unref();
    if (reply.error !== undefined) waiter?.reject(Object.assign(new Error(reply.error), reply.code ? { code: reply.code } : {}));
    else waiter?.resolve(reply.value!);
  });
  const fail = (error: Error) => {
    if (prober === state) prober = undefined;
    for (const waiter of state.waiting.values()) waiter.reject(error);
    state.waiting.clear();
  };
  worker.on("error", fail);
  worker.on("exit", code => fail(new Error(`layout probe worker exited ${code}`)));
  return state;
}

/** Whether any component of `relativePath` below the repo root is a symlink; undefined if it vanished. */
function throughSymlink(repoRoot: string, relativePath: string): boolean | undefined {
  let current = repoRoot;
  for (const part of relativePath.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (!isMissing(error)) throw error;
      return undefined;
    }
  }
  return false;
}

function sourceRootInfos(repoRoot: string, contentRoot: (relativePath: string) => boolean): SourceRootInfo[] {
  const roots = new Map<string, SourceRootInfo>();
  const addJavaRoots = (baseRelative: string, moduleName: string) => {
    for (const sourceSet of ["main", "test"] as const) {
      const relativePath = path.join(baseRelative, "src", sourceSet, "java");
      if (contentRoot(relativePath)) {
        roots.set(relativePath, { relativePath, module: moduleName, sourceSet });
      }
    }
  };

  for (const baseRelative of moduleBaseRelatives(repoRoot)) {
    addJavaRoots(baseRelative, baseRelative === "" ? "." : path.basename(baseRelative));
  }
  return [...roots.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function resourceRootInfos(repoRoot: string, contentRoot: (relativePath: string) => boolean): string[] {
  const roots = new Set<string>();
  const addResourceRoot = (baseRelative: string) => {
    const relativePath = path.join(baseRelative, "src", "main", "resources");
    if (contentRoot(relativePath)) {
      roots.add(relativePath);
    }
  };

  for (const baseRelative of moduleBaseRelatives(repoRoot)) {
    addResourceRoot(baseRelative);
  }
  if (contentRoot(path.join("docs", "sql"))) {
    roots.add(path.join("docs", "sql"));
  }
  return [...roots].sort();
}

function detectLayout(repoRoot: string, sourceRoots: SourceRootInfo[]): LayoutKind {
  if (pathExists(path.join(repoRoot, "settings.gradle")) || pathExists(path.join(repoRoot, "settings.gradle.kts"))) {
    return sourceRoots.some(root => root.relativePath.startsWith("modules/") || root.relativePath.startsWith("apps/")) ? "gradle-multi" : "single";
  }
  if (pathExists(path.join(repoRoot, "pom.xml"))) {
    return mavenModules(repoRoot).length > 0 || sourceRoots.some(root => root.module !== ".") ? "maven-multi" : "single";
  }
  return sourceRoots.length > 0 ? "single" : "flat-layers";
}

function broadRoots(repoRoot: string, sourceRoots: SourceRootInfo[]): string[] {
  const roots = ["modules", "apps"].filter(item => isDirectory(path.join(repoRoot, item)));
  if (roots.length > 0) {
    return roots;
  }
  const hasRootSource = sourceRoots.some(root => root.module === ".");
  const modules = new Set([
    ...mavenModules(repoRoot),
    ...sourceRoots
      .map(root => moduleBaseRelative(root.relativePath))
      .filter(module => module !== ".")
  ]);
  if (hasRootSource) {
    modules.add(".");
  }
  return compactBroadRoots([...modules]);
}

const LAYOUT_MARKER_NAMES = [
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "build.gradle",
  "build.gradle.kts",
  "gradle.properties"
];

const LAYOUT_MARKER_RELATIVE = ["gradle/libs.versions.toml"];

/**
 * A cheap size/mtime fingerprint over the root and every one-level-deep module
 * candidate's build markers. Recomputed from disk each call (not from cached
 * layout state) so a brand-new module directory is picked up as soon as it
 * exists, without waiting for a prior probe to have known about it.
 */
export function layoutBuildFingerprint(repoRoot: string): string {
  const parts: string[] = [];
  for (const root of markerRootCandidates(repoRoot)) {
    for (const name of LAYOUT_MARKER_NAMES) {
      parts.push(fileFingerprint(path.join(root, name)));
    }
  }
  for (const relative of LAYOUT_MARKER_RELATIVE) {
    parts.push(fileFingerprint(path.join(repoRoot, relative)));
  }
  return parts.join("|");
}

function markerRootCandidates(repoRoot: string): string[] {
  const roots = new Set(moduleBaseRelatives(repoRoot).map(relative => path.join(repoRoot, relative)));
  return [...roots].sort();
}

const MODULE_DISCOVERY_MAX_DEPTH = 4;
const MODULE_DISCOVERY_IGNORED = new Set([
  ".git", ".gradle", ".idea", ".mvn", ".cache", ".worktrees", "build", "dist", "node_modules", "out", "target"
]);

/**
 * A Maven reactor may have a grouping module such as `exam-service/` whose
 * actual Java modules live one level below it.  Discover module bases by a
 * bounded directory walk, stopping before source/build trees, so every
 * a module's `src/{main,test}/{java,resources}` root is visible to both the index and
 * the router without turning normal discovery into an unbounded repository
 * scan.
 */
function moduleBaseRelatives(repoRoot: string): string[] {
  const bases = new Set<string>([""]);
  const visit = (relative: string, depth: number): void => {
    if (depth >= MODULE_DISCOVERY_MAX_DEPTH) {
      return;
    }
    const absolute = path.join(repoRoot, relative);
    for (const child of listDirectories(absolute)) {
      if (MODULE_DISCOVERY_IGNORED.has(child) || child === "src") {
        continue;
      }
      const nested = relative ? path.join(relative, child) : child;
      bases.add(nested);
      visit(nested, depth + 1);
    }
  };
  visit("", 0);
  return [...bases].sort();
}

function moduleBaseRelative(sourceRoot: string): string {
  const parts = sourceRoot.split(path.sep);
  const srcSegmentIndex = parts.lastIndexOf("src");
  if (srcSegmentIndex <= 0) {
    return ".";
  }
  return parts.slice(0, srcSegmentIndex).join(path.sep);
}

function compactBroadRoots(roots: string[]): string[] {
  const sorted = [...new Set(roots.filter(Boolean))].sort((left, right) => left.length - right.length || left.localeCompare(right));
  const compact = sorted.filter(root => !sorted.some(parent => parent !== root && (parent === "." || root.startsWith(`${parent}${path.sep}`))));
  return compact.length > 0 ? compact.sort() : ["."];
}

function fileFingerprint(filePath: string): string {
  try {
    const stat = statSync(filePath);
    return `${filePath}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return `${filePath}:absent`;
  }
}

function mavenModules(repoRoot: string): string[] {
  try {
    const text = readFileSync(path.join(repoRoot, "pom.xml"), "utf8");
    return [...text.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].map(match => match[1]);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return [];
  }
}

function listDirectories(dir: string): string[] {
  if (!isDirectory(dir)) {
    return [];
  }
  return readdirSync(dir).filter(item => isDirectory(path.join(dir, item)));
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch (error) {
    if (!isMissing(error)) throw error;
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function pathExists(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return false;
  }
}

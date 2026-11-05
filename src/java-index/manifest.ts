import { sourcePathWithinRoot } from "./source-capture.js";
import { opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { LayoutContext } from "../layout-probe.js";

/** Directory names no discovery walk descends into (the tracker applies the same rule). */
export const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git", ".gradle", "build", "target", "out", "bin", "node_modules", "dist"
]);

export type DiscoveredResourceFile = {
  absolutePath: string;
  relativePath: string;
  sourceRoot: string;
};

export async function discoverMyBatisResourceFiles(repoRoot: string, layout: LayoutContext): Promise<DiscoveredResourceFile[]> {
  await realpath(repoRoot);
  const files: DiscoveredResourceFile[] = [];
  for (const resourceRoot of layout.resourceRoots) {
    for await (const file of walkIndexDirectory(repoRoot, resourceRoot, ".xml")) files.push(file);
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

export function resourceSourceRoot(relativePath: string, layout: LayoutContext): string | undefined {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  return [...layout.resourceRoots]
    .map(root => root.replace(/\\/g, "/"))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .find(root => normalizedPath === root || normalizedPath.startsWith(`${root}/`));
}

/** Membership of the resource XML census (discoverMyBatisResourceFiles), also used for explicit refresh paths. */
export function resourceMemberRoot(relativePath: string, layout: LayoutContext): string | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.endsWith(".xml")) return undefined;
  const root = resourceSourceRoot(normalized, layout);
  if (!root || normalized === root) return undefined;
  return normalized.slice(root.length + 1).split("/").slice(0, -1).some(part => IGNORED_DIRECTORY_NAMES.has(part)) ? undefined : root;
}

export type DiscoveredJavaFile = {
  absolutePath: string;
  relativePath: string;
  sourceRoot: string;
};

/** Membership of the full Java census, also used for explicit refresh paths. */
export function javaSourceRoot(relativePath: string, layout: Pick<LayoutContext, "sourceRoots">): string | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.endsWith(".java")) return undefined;
  const root = layout.sourceRoots.map(item => item.relativePath.replace(/\\/g, "/"))
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .find(item => normalized.startsWith(`${item}/`));
  if (!root) return undefined;
  return normalized.slice(root.length + 1).split("/").slice(0, -1).some(part => IGNORED_DIRECTORY_NAMES.has(part)) ? undefined : root;
}

export async function discoverJavaFiles(repoRoot: string, layout: LayoutContext): Promise<DiscoveredJavaFile[]> {
  await realpath(repoRoot);
  const files: DiscoveredJavaFile[] = [];
  for (const sourceRoot of layout.sourceRoots) {
    for await (const file of walkIndexDirectory(repoRoot, sourceRoot.relativePath, ".java")) files.push(file);
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

/** Inspect only as far as the first census member when computing root presence. */
export async function hasIndexableFiles(repoRoot: string, sourceRoot: string, extension: ".java" | ".xml"): Promise<boolean> {
  for await (const _ of walkIndexDirectory(repoRoot, sourceRoot, extension)) return true;
  return false;
}

async function* walkIndexDirectory(repoRoot: string, sourceRoot: string, extension: ".java" | ".xml",
  absoluteDir = path.join(repoRoot, sourceRoot)): AsyncGenerator<DiscoveredJavaFile> {
  let dir;
  try {
    const readable = await sourcePathWithinRoot(repoRoot, absoluteDir);
    dir = await opendir(readable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of dir) {
    const absolutePath = path.join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      yield* walkIndexDirectory(repoRoot, sourceRoot, extension, absolutePath);
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
      yield { absolutePath, relativePath, sourceRoot };
    }
  }
}

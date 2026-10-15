import { sourcePathWithinRoot } from "./source-capture.js";
import { opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { LayoutContext } from "../layout-probe.js";

const IGNORED_DIRECTORY_NAMES = new Set([
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
    await walkResourceDirectory(path.join(repoRoot, resourceRoot), repoRoot, resourceRoot, files);
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

async function walkResourceDirectory(
  absoluteDir: string,
  repoRoot: string,
  sourceRoot: string,
  files: DiscoveredResourceFile[]
): Promise<void> {
  let dir;
  try {
    const readable = await sourcePathWithinRoot(repoRoot, absoluteDir);
    dir = await opendir(readable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of dir) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      await walkResourceDirectory(path.join(absoluteDir, entry.name), repoRoot, sourceRoot, files);
    } else if (entry.isFile() && entry.name.endsWith(".xml")) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
      files.push({ absolutePath, relativePath, sourceRoot });
    }
  }
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
    await walkDirectory(path.join(repoRoot, sourceRoot.relativePath), repoRoot, sourceRoot.relativePath, files);
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
}

async function walkDirectory(
  absoluteDir: string,
  repoRoot: string,
  sourceRoot: string,
  files: DiscoveredJavaFile[]
): Promise<void> {
  let dir;
  try {
    const readable = await sourcePathWithinRoot(repoRoot, absoluteDir);
    dir = await opendir(readable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of dir) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      await walkDirectory(path.join(absoluteDir, entry.name), repoRoot, sourceRoot, files);
    } else if (entry.isFile() && entry.name.endsWith(".java")) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
      files.push({ absolutePath, relativePath, sourceRoot });
    }
  }
}

import { opendir } from "node:fs/promises";
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
    dir = await opendir(absoluteDir);
  } catch {
    return;
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

export async function discoverJavaFiles(repoRoot: string, layout: LayoutContext): Promise<DiscoveredJavaFile[]> {
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
    dir = await opendir(absoluteDir);
  } catch {
    return;
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

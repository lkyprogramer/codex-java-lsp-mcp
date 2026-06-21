// input: Repository paths and LSP file locations.
// output: Normalized repo metadata, DDD layer classification, and source previews.
// pos: Shared path helper for the lishuedu JDT LS MCP bridge.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalPath } from "./path-utils.js";

export type PathContext = {
  absolutePath: string;
  relativePath?: string;
  module?: string;
  projectPath?: string;
  layer?: string;
  sourceSet?: string;
};

export type SourcePreview = {
  startLine: number;
  endLine: number;
  text: string;
};

export function findRepoRoot(explicitRoot?: string): string {
  const start = explicitRoot ? path.resolve(explicitRoot) : process.cwd();
  const root = findBuildRoot(start);
  if (root) {
    return canonicalPath(root);
  }
  if (explicitRoot) {
    return canonicalPath(explicitRoot);
  }
  throw new Error("Unable to locate Java repo root. Pass repoRoot/projectId/file.");
}

function findBuildRoot(startDir: string): string | undefined {
  let current = existsSync(startDir) ? startDir : path.dirname(startDir);
  let mavenRoot: string | undefined;
  let gradleBuildRoot: string | undefined;
  while (true) {
    if (existsSync(path.join(current, "settings.gradle.kts")) || existsSync(path.join(current, "settings.gradle"))) {
      return current;
    }
    if (!gradleBuildRoot && (existsSync(path.join(current, "build.gradle.kts")) || existsSync(path.join(current, "build.gradle")))) {
      gradleBuildRoot = current;
    }
    if (existsSync(path.join(current, "pom.xml"))) {
      if (isMavenAggregator(current)) {
        mavenRoot = current;
      } else if (!mavenRoot) {
        mavenRoot = current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return mavenRoot || gradleBuildRoot;
    }
    current = parent;
  }
}

export function repoCacheRoot(repoRoot: string): string {
  const hash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 12);
  return path.join(homedir(), "Library", "Caches", "codex-java-lsp", hash);
}

export function toFileUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

export function fromFileUri(uri: string): string | undefined {
  if (!uri.startsWith("file://")) {
    return undefined;
  }
  return fileURLToPath(uri);
}

export function normalizeRepoFile(repoRoot: string, inputFile: string): string {
  const absolutePath = path.isAbsolute(inputFile)
    ? path.normalize(inputFile)
    : path.resolve(repoRoot, inputFile);
  const relativePath = path.relative(repoRoot, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`File is outside repo root: ${inputFile}`);
  }
  return absolutePath;
}

export function classifyPath(repoRoot: string, filePath: string): PathContext {
  const absolutePath = path.normalize(filePath);
  const relativePath = path.relative(repoRoot, absolutePath);
  const context: PathContext = { absolutePath };

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return context;
  }

  context.relativePath = relativePath;
  const parts = relativePath.split(path.sep);
  if (parts[0] === "modules" && parts[1]) {
    context.module = parts[1];
    context.projectPath = `:modules:${parts[1]}`;
  } else if (parts[0] === "apps" && parts[1]) {
    context.module = parts[1];
    context.projectPath = `:apps:${parts[1]}`;
  } else {
    const srcIndex = parts.findIndex(part => part === "src");
    if (srcIndex > 0) {
      context.module = parts.slice(0, srcIndex).join("/") || ".";
      context.projectPath = context.module;
    }
  }

  const sourceSetIndex = parts.findIndex((part, index) => parts[index - 1] === "src");
  if (sourceSetIndex >= 0) {
    context.sourceSet = parts[sourceSetIndex];
  }

  for (const layer of ["interfaces", "application", "domain", "infrastructure", "controller", "service", "repository", "mapper", "entity", "dto", "vo"]) {
    if (parts.includes(layer)) {
      context.layer = layer;
      break;
    }
  }

  return context;
}

function isMavenAggregator(dir: string): boolean {
  try {
    const text = readFileSync(path.join(dir, "pom.xml"), "utf8");
    return /<packaging>\s*pom\s*<\/packaging>/.test(text) || /<modules>/.test(text);
  } catch {
    return false;
  }
}

export async function sourcePreview(filePath: string, line: number, radius = 2): Promise<SourcePreview | undefined> {
  if (!existsSync(filePath)) {
    return undefined;
  }
  const content = await readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const targetLine = Math.max(1, line);
  const startLine = Math.max(1, targetLine - radius);
  const endLine = Math.min(lines.length, targetLine + radius);
  const text = lines
    .slice(startLine - 1, endLine)
    .map((value, index) => `${String(startLine + index).padStart(5, " ")} | ${value}`)
    .join("\n");
  return { startLine, endLine, text };
}

export function clampLimit(limit: number | undefined, defaultLimit = 80, maxLimit = 300): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return defaultLimit;
  }
  return Math.max(1, Math.min(maxLimit, Math.floor(limit)));
}

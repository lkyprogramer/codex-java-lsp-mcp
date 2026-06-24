// input: Java repository root plus coarse layout hint.
// output: Detected source/resource roots for router and watcher reuse.
// pos: Shared lightweight layout probe; falls back to current broad scan behavior.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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
};

export function probeLayout(repoRoot: string, layoutProfile = "generic-java"): LayoutContext {
  const sourceRoots = sourceRootInfos(repoRoot);
  const resourceRoots = resourceRootInfos(repoRoot);
  return {
    layout: detectLayout(repoRoot, sourceRoots),
    layoutProfile,
    sourceRoots,
    resourceRoots,
    broadRoots: broadRoots(repoRoot, sourceRoots)
  };
}

function sourceRootInfos(repoRoot: string): SourceRootInfo[] {
  const roots = new Map<string, SourceRootInfo>();
  const addJavaRoots = (baseRelative: string, moduleName: string) => {
    for (const sourceSet of ["main", "test"] as const) {
      const relativePath = path.join(baseRelative, "src", sourceSet, "java");
      if (isDirectory(path.join(repoRoot, relativePath))) {
        roots.set(relativePath, { relativePath, module: moduleName, sourceSet });
      }
    }
  };

  addJavaRoots("", ".");
  for (const child of listDirectories(repoRoot)) {
    addJavaRoots(child, child);
  }
  for (const topLevel of ["modules", "apps"]) {
    for (const child of listDirectories(path.join(repoRoot, topLevel))) {
      addJavaRoots(path.join(topLevel, child), child);
    }
  }
  return [...roots.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function resourceRootInfos(repoRoot: string): string[] {
  const roots = new Set<string>();
  const addResourceRoot = (baseRelative: string) => {
    const relativePath = path.join(baseRelative, "src", "main", "resources");
    if (isDirectory(path.join(repoRoot, relativePath))) {
      roots.add(relativePath);
    }
  };

  addResourceRoot("");
  for (const child of listDirectories(repoRoot)) {
    addResourceRoot(child);
  }
  for (const topLevel of ["modules", "apps"]) {
    for (const child of listDirectories(path.join(repoRoot, topLevel))) {
      addResourceRoot(path.join(topLevel, child));
    }
  }
  if (isDirectory(path.join(repoRoot, "docs", "sql"))) {
    roots.add(path.join("docs", "sql"));
  }
  return [...roots].sort();
}

function detectLayout(repoRoot: string, sourceRoots: SourceRootInfo[]): LayoutKind {
  if (existsSync(path.join(repoRoot, "settings.gradle")) || existsSync(path.join(repoRoot, "settings.gradle.kts"))) {
    return sourceRoots.some(root => root.relativePath.startsWith("modules/") || root.relativePath.startsWith("apps/")) ? "gradle-multi" : "single";
  }
  if (existsSync(path.join(repoRoot, "pom.xml"))) {
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
  const modules = [...new Set([...mavenModules(repoRoot), ...sourceRoots.map(root => root.module).filter(module => module !== ".")])];
  if (hasRootSource) {
    modules.push(".");
  }
  return modules.length > 0 ? modules.sort() : ["."];
}

function mavenModules(repoRoot: string): string[] {
  try {
    const text = readFileSync(path.join(repoRoot, "pom.xml"), "utf8");
    return [...text.matchAll(/<module>\s*([^<\s]+)\s*<\/module>/g)].map(match => match[1]);
  } catch {
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
  } catch {
    return false;
  }
}

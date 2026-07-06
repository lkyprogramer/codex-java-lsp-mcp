import { existsSync } from "node:fs";
import path from "node:path";
import type { LayoutContext } from "../layout-probe.js";
import type { ImpactOptions, ResolvedAnchor } from "../agent-types.js";
import { unique } from "./candidate-helpers.js";

export function rootsFor(repoRoot: string, anchor: ResolvedAnchor, sourceSet: "main" | "test", options: Pick<ImpactOptions, "crossModulePolicy" | "focusModules">, layoutContext?: LayoutContext): string[] {
  if (options.crossModulePolicy === "all") {
    return broadSearchRoots(repoRoot, layoutContext);
  }
  const modules = unique([anchor.module, ...options.focusModules].filter((value): value is string => Boolean(value)));
  const detectedRoots = layoutContext?.sourceRoots
    .filter(root => root.sourceSet === sourceSet && modules.includes(root.module))
    .map(root => root.relativePath)
    .filter(item => existsSync(path.resolve(repoRoot, item))) || [];
  if (detectedRoots.length > 0) {
    return unique(detectedRoots);
  }
  const roots = modules
    .flatMap(module => [`modules/${module}/src/${sourceSet}/java`, `apps/${module}/src/${sourceSet}/java`, `${module}/src/${sourceSet}/java`])
    .filter(item => existsSync(path.resolve(repoRoot, item)));
  return roots.length > 0 ? unique(roots) : broadSearchRoots(repoRoot, layoutContext);
}

export function broadSearchRoots(repoRoot: string, layoutContext?: LayoutContext): string[] {
  if (layoutContext?.broadRoots.length) {
    return layoutContext.broadRoots;
  }
  const roots = ["modules", "apps"].filter(item => existsSync(path.resolve(repoRoot, item)));
  return roots.length > 0 ? roots : ["."];
}

export function persistenceRoots(anchor: ResolvedAnchor, layoutContext?: LayoutContext): string[] {
  const detected = layoutContext
    ? [
        ...layoutContext.resourceRoots.filter(root => root === "docs/sql" || moduleFromRoot(root) === anchor.module),
        ...layoutContext.sourceRoots.filter(root => root.sourceSet === "main" && root.module === anchor.module).map(root => root.relativePath)
      ]
    : [];
  return unique([
    ...detected,
    anchor.module ? `modules/${anchor.module}/src/main/resources` : undefined,
    anchor.module ? `modules/${anchor.module}/src/main/java` : undefined,
    "docs/sql"
  ].filter((value): value is string => Boolean(value)));
}

function moduleFromRoot(root: string): string {
  const parts = root.split(path.sep);
  const srcIndex = parts.findIndex(part => part === "src");
  if (srcIndex <= 0) {
    return ".";
  }
  if ((parts[0] === "modules" || parts[0] === "apps") && parts[1]) {
    return parts[1];
  }
  return parts.slice(0, srcIndex).join("/") || ".";
}

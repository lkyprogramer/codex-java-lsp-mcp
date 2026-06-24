// input: java_status MCP request and optional start flag.
// output: Current JDT LS, watcher, source-index, and router cache status.
// pos: v5 status tool handler.
import { z } from "zod";
import { existsSync } from "node:fs";
import path from "node:path";
import { readRuntimeBuild } from "../build-info.js";
import { probeLayout } from "../layout-probe.js";
import type { ToolContext } from "./context.js";

export const statusSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  file: z.string().min(1).optional(),
  start: z.boolean().default(false)
};

export async function javaStatus(context: ToolContext, _args: z.infer<z.ZodObject<typeof statusSchema>>): Promise<Record<string, unknown>> {
  if (_args.start) {
    if (context.lsp && !context.lsp.enabled) {
      return {
        repoRoot: context.repoRoot,
        rootSource: context.rootSource,
        repoHash: context.repoHash,
        aliases: context.aliases || [],
        layoutProfile: context.layoutProfile,
        layout: probeLayout(context.repoRoot, context.layoutProfile),
        runtimeBuild: readRuntimeBuild(),
        rootWarnings: rootWarnings(context.repoRoot),
        lsp: context.lsp,
        started: false,
        note: context.lsp.enableHint || "Enable this project in projects.json before starting JDT LS."
      };
    }
    await context.session.ensureStarted();
  }
  return {
    ...context.session.status(),
    repoHash: context.repoHash,
    rootSource: context.rootSource,
    aliases: context.aliases || [],
    layoutProfile: context.layoutProfile,
    layout: probeLayout(context.repoRoot, context.layoutProfile),
    runtimeBuild: readRuntimeBuild(),
    rootWarnings: rootWarnings(context.repoRoot),
    lsp: context.lsp,
    repoRoot: context.repoRoot,
    sourceIndex: context.sourceIndex.status(),
    rgCache: context.router.rgCacheStatus(),
    note: "This MCP server is read-only and exposes the Java impact router."
  };
}

function rootWarnings(repoRoot: string): string[] {
  return hasBuildFile(repoRoot) ? [] : ["No pom.xml, build.gradle, or settings.gradle file was found at the resolved repo root."];
}

function hasBuildFile(repoRoot: string): boolean {
  return [
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts"
  ].some(file => existsSync(path.join(repoRoot, file)));
}

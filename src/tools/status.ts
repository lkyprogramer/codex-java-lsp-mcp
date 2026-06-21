// input: java_status MCP request and optional start flag.
// output: Current JDT LS, watcher, source-index, and router cache status.
// pos: v5 status tool handler.
import { z } from "zod";
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
        repoHash: context.repoHash,
        aliases: context.aliases || [],
        layoutProfile: context.layoutProfile,
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
    aliases: context.aliases || [],
    layoutProfile: context.layoutProfile,
    lsp: context.lsp,
    repoRoot: context.repoRoot,
    sourceIndex: context.sourceIndex.status(),
    rgCache: context.router.rgCacheStatus(),
    note: "This MCP server is read-only and exposes the Java impact router."
  };
}

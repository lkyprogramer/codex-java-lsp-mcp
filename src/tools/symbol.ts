// input: java_symbol query or source position.
// output: Workspace symbol hits or hover/definition/implementation context.
// pos: Public v5 symbol tool handler.
import { z } from "zod";
import { clampLimit, normalizeRepoFile } from "../repo-layout.js";
import type { ToolContext } from "./context.js";
import { describeLocation, normalizeHover, symbolKindName } from "./shared.js";

export const symbolSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(300).optional(),
  semanticTimeoutMs: z.number().int().positive().max(10000).default(3000)
};

export async function javaSymbol(context: ToolContext, args: z.infer<z.ZodObject<typeof symbolSchema>>): Promise<unknown> {
  if (args.query) {
    const limit = clampLimit(args.limit);
    const result = await context.session.workspaceSymbols(args.query, limit);
    return {
      mode: "query",
      query: args.query,
      limit,
      truncated: result.truncated,
      items: await Promise.all(result.items.map(async item => ({
        name: item.name,
        kind: symbolKindName(item.kind),
        containerName: item.containerName,
        location: item.location ? await describeLocation(context.repoRoot, item.location, false) : undefined
      })))
    };
  }
  if (!args.file || !args.line || !args.column) {
    throw new Error("java_symbol requires either query or file/line/column.");
  }
  const file = normalizeRepoFile(context.repoRoot, args.file);
  const result = await context.session.symbolContext(file, args.line, args.column, args.semanticTimeoutMs);
  return {
    mode: "position",
    file,
    line: args.line,
    column: args.column,
    hover: normalizeHover(result.hover),
    definitions: await Promise.all(result.definitions.map(location => describeLocation(context.repoRoot, location, false))),
    implementations: await Promise.all(result.implementations.map(location => describeLocation(context.repoRoot, location, false)))
  };
}

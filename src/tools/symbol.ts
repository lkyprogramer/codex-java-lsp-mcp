// input: java_symbol query or source position.
// output: Workspace symbol hits or hover/definition/implementation context.
// pos: Public v5 symbol tool handler.
import { z } from "zod";
import { clampLimit, normalizeRepoFile } from "../repo-layout.js";
import type { LspLocation, LspLocationLink } from "../jdtls-session.js";
import type { ToolContext } from "./context.js";
import { describeFile, describeLocation, detailSchema, isDiagnosticDetail, normalizeHover, symbolKindName, type ResponseDetail } from "./shared.js";

export const symbolSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(300).optional(),
  semanticTimeoutMs: z.number().int().positive().max(10000).default(3000),
  detail: detailSchema
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
      // A workspace symbol whose only location is outside the repo is dropped
      // entirely: without a location it is not actionable evidence.
      items: (await Promise.all(result.items.map(async item => {
        const location = item.location
          ? await describeLocation(context.repoRoot, item.location, { detail: args.detail })
          : undefined;
        if (item.location && !location) {
          return undefined;
        }
        return {
          name: item.name,
          kind: symbolKindName(item.kind),
          containerName: item.containerName,
          location
        };
      }))).filter(item => item !== undefined)
    };
  }
  if (!args.file || !args.line || !args.column) {
    throw new Error("java_symbol requires either query or file/line/column.");
  }
  const file = normalizeRepoFile(context.repoRoot, args.file);
  const result = await context.session.symbolContext(file, args.line, args.column, args.semanticTimeoutMs);
  return {
    mode: "position",
    file: isDiagnosticDetail(args.detail) ? file : describeFile(context.repoRoot, file).path,
    line: args.line,
    column: args.column,
    hover: normalizeHover(result.hover),
    definitions: await describeContainedLocations(context.repoRoot, result.definitions, args.detail),
    implementations: await describeContainedLocations(context.repoRoot, result.implementations, args.detail)
  };
}

async function describeContainedLocations(
  repoRoot: string,
  locations: Array<LspLocation | LspLocationLink>,
  detail: ResponseDetail | undefined
): Promise<Array<Record<string, unknown>>> {
  const described = await Promise.all(
    locations.map(location => describeLocation(repoRoot, location, { detail }))
  );
  return described.filter((item): item is Record<string, unknown> => item !== undefined);
}

// input: java_symbol query, source position, or reference lookup (operation=references).
// output: Workspace symbol hits, hover/definition/implementation context, or summary-only references.
// pos: Public symbol tool handler. Folds the retired java_references tool in as
//      operation="references" (Task 31 Step 7 - measured 235 saved tokens on tools/list,
//      cleared the plan's savedTokens>=200 merge gate).
import { z } from "zod";
import { clampLimit, normalizeRepoFile } from "../repo-layout.js";
import type { LspLocation, LspLocationLink } from "../jdtls-session.js";
import type { RequestContext } from "../runtime/request-context.js";
import type { ToolContext } from "./context.js";
import { compact, describeFile, describeLocation, detailSchema, isDiagnosticDetail, normalizeHover, symbolKindName, type ResponseDetail } from "./shared.js";

export const symbolSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  operation: z.enum(["query", "position", "references"]).optional(),
  query: z.string().min(1).optional(),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(300).optional(),
  semanticTimeoutMs: z.number().int().positive().max(10000).default(3000),
  includeDeclaration: z.boolean().default(false),
  positionsPerFile: z.number().int().positive().max(20).default(3),
  module: z.string().min(1).optional(),
  layer: z.string().min(1).optional(),
  sourceSet: z.string().min(1).optional(),
  detail: detailSchema
};

type SymbolArgs = z.infer<z.ZodObject<typeof symbolSchema>>;

export async function javaSymbol(
  context: ToolContext,
  args: SymbolArgs,
  request?: Pick<RequestContext, "budget">
): Promise<unknown> {
  const operation = args.operation ?? (args.query ? "query" : "position");
  if (operation === "references") {
    return javaSymbolReferences(context, args, request);
  }
  if (operation === "query") {
    if (!args.query) {
      throw new Error("java_symbol operation=query requires query.");
    }
    const limit = clampLimit(args.limit);
    const result = await context.session.workspaceSymbols(args.query, limit, request?.budget ?? args.semanticTimeoutMs);
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
    throw new Error("java_symbol requires either query, or file/line/column, or operation=references with file/line/column.");
  }
  const file = normalizeRepoFile(context.repoRoot, args.file);
  const result = await context.session.symbolContext(file, args.line, args.column, request?.budget ?? args.semanticTimeoutMs);
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

async function javaSymbolReferences(
  context: ToolContext,
  args: SymbolArgs,
  request?: Pick<RequestContext, "budget">
): Promise<unknown> {
  if (!args.file || !args.line || !args.column) {
    throw new Error("java_symbol operation=references requires file/line/column.");
  }
  const file = normalizeRepoFile(context.repoRoot, args.file);
  const limit = clampLimit(args.limit);
  const result = await context.session.references(
    file,
    args.line,
    args.column,
    args.includeDeclaration,
    request?.budget ?? args.semanticTimeoutMs
  );
  const described = await Promise.all(result.items.map(location => describeLocation(context.repoRoot, location, { detail: args.detail })));
  // describeLocation returns undefined for hits outside this repo (jars, JDK
  // sources); they are counted, not rendered.
  const contained = described.filter((item): item is Record<string, unknown> => item !== undefined);
  const matched = contained
    .filter(item => !args.module || item.module === args.module)
    .filter(item => !args.layer || item.layer === args.layer)
    .filter(item => !args.sourceSet || item.sourceSet === args.sourceSet);
  const filtered = matched.slice(0, limit);
  return {
    totalReferences: result.totalReferences,
    matchedReferences: matched.length,
    returnedReferences: filtered.length,
    externalReferencesSuppressed: described.length - contained.length,
    truncated: result.truncated || matched.length > filtered.length,
    groups: groupReferences(filtered, args.positionsPerFile)
  };
}

function groupReferences(items: Array<Record<string, unknown>>, positionsPerFile: number): Array<Record<string, unknown>> {
  const groups = new Map<string, Record<string, unknown> & { files: Map<string, Record<string, unknown> & { positions: unknown[]; referenceCount: number }> }>();
  for (const item of items) {
    const groupKey = `${item.module || "unknown"}/${item.layer || "unknown"}`;
    const fileKey = String(item.path || item.relativePath || item.absolutePath || item.uri);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        module: item.module,
        layer: item.layer,
        referenceCount: 0,
        files: new Map()
      };
      groups.set(groupKey, group);
    }
    group.referenceCount = Number(group.referenceCount || 0) + 1;
    let file = group.files.get(fileKey);
    if (!file) {
      file = {
        path: item.path || item.relativePath || item.absolutePath,
        sourceSet: item.sourceSet,
        referenceCount: 0,
        positions: []
      };
      group.files.set(fileKey, file);
    }
    file.referenceCount += 1;
    if (file.positions.length < positionsPerFile) {
      file.positions.push(compact({ line: item.line, column: item.column, range: item.range }));
    }
  }
  return [...groups.values()].map(group => ({
    module: group.module,
    layer: group.layer,
    referenceCount: group.referenceCount,
    files: [...group.files.values()]
  }));
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

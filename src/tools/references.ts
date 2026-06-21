// input: java_references source position and optional filters.
// output: Summary-only reference groups.
// pos: Public v5 references escape-hatch handler.
import { z } from "zod";
import { clampLimit, normalizeRepoFile } from "../repo-layout.js";
import type { ToolContext } from "./context.js";
import { describeLocation } from "./shared.js";

export const referencesSchema = {
  projectId: z.string().min(1).optional(),
  repoRoot: z.string().min(1).optional(),
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  includeDeclaration: z.boolean().default(false),
  limit: z.number().int().positive().max(300).optional(),
  positionsPerFile: z.number().int().positive().max(20).default(3),
  module: z.string().min(1).optional(),
  layer: z.string().min(1).optional(),
  sourceSet: z.string().min(1).optional()
};

export async function javaReferences(context: ToolContext, args: z.infer<z.ZodObject<typeof referencesSchema>>): Promise<unknown> {
  const file = normalizeRepoFile(context.repoRoot, args.file);
  const limit = clampLimit(args.limit);
  const result = await context.session.references(file, args.line, args.column, args.includeDeclaration);
  const described = await Promise.all(result.items.map(location => describeLocation(context.repoRoot, location, false)));
  const filtered = described
    .filter(item => !args.module || item.module === args.module)
    .filter(item => !args.layer || item.layer === args.layer)
    .filter(item => !args.sourceSet || item.sourceSet === args.sourceSet)
    .slice(0, limit);
  return {
    totalReferences: result.totalReferences,
    filteredReferences: filtered.length,
    returnedReferences: filtered.length,
    truncated: described.length > filtered.length,
    groups: groupReferences(filtered, args.positionsPerFile)
  };
}

function groupReferences(items: Array<Record<string, unknown>>, positionsPerFile: number): Array<Record<string, unknown>> {
  const groups = new Map<string, Record<string, unknown> & { files: Map<string, Record<string, unknown> & { positions: unknown[]; referenceCount: number }> }>();
  for (const item of items) {
    const groupKey = `${item.module || "unknown"}/${item.layer || "unknown"}`;
    const fileKey = String(item.relativePath || item.absolutePath || item.uri);
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
        path: item.relativePath || item.absolutePath,
        sourceSet: item.sourceSet,
        referenceCount: 0,
        positions: []
      };
      group.files.set(fileKey, file);
    }
    file.referenceCount += 1;
    if (file.positions.length < positionsPerFile) {
      file.positions.push({ line: item.line, column: item.column, range: item.range });
    }
  }
  return [...groups.values()].map(group => ({
    module: group.module,
    layer: group.layer,
    referenceCount: group.referenceCount,
    files: [...group.files.values()]
  }));
}

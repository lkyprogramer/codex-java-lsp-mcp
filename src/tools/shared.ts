// input: Raw LSP locations, hovers, ranges, and symbols.
// output: Compact JSON-safe descriptions for MCP tools.
// pos: Shared response formatting helpers for V6 tools.
import { z } from "zod";
import { classifyPath, sourcePreview } from "../repo-layout.js";
import { normalizeRepoLocation } from "../semantic-location.js";
import type { LspLocation, LspLocationLink, LspRange } from "../jdtls-session.js";

export const detailSchema = z.enum(["summary", "diagnostic"]).optional();
export type ResponseDetail = "summary" | "diagnostic";

type LocationFormatOptions = {
  readonly detail?: ResponseDetail;
  readonly includePreview?: boolean;
};

/**
 * Returns undefined for any location outside the repo. Callers must drop those
 * rather than render them: a raw uri or an absolute ~/.m2 path in tool output
 * is both a leak and useless to the agent.
 */
export async function describeLocation(
  repoRoot: string,
  location: LspLocation | LspLocationLink,
  options: LocationFormatOptions | boolean = false
): Promise<Record<string, unknown> | undefined> {
  const formatOptions = typeof options === "boolean" ? { includePreview: options } : options;
  const normalized = normalizeRepoLocation(repoRoot, location);
  if (!normalized) {
    return undefined;
  }
  const line = normalized.range.start.line;
  const column = normalized.range.start.column;
  const pathContext = classifyPath(repoRoot, normalized.absolutePath);
  const result: Record<string, unknown> = isDiagnosticDetail(formatOptions.detail)
    ? {
        // Diagnostic detail is opt-in and may carry the raw uri and absolute
        // path; containment guarantees both now point inside this repo.
        uri: "targetUri" in location ? location.targetUri : location.uri,
        ...pathContext,
        path: normalized.relativePath,
        line,
        column,
        range: normalized.range
      }
    : {
        path: normalized.relativePath,
        module: pathContext.module,
        projectPath: pathContext.projectPath,
        layer: pathContext.layer,
        sourceSet: pathContext.sourceSet,
        line,
        column
      };
  if (formatOptions.includePreview) {
    result.preview = await sourcePreview(normalized.absolutePath, line);
  }
  return compact(result);
}

export function describeFile(repoRoot: string, filePath: string, detail?: ResponseDetail): Record<string, unknown> {
  const pathContext = classifyPath(repoRoot, filePath);
  if (isDiagnosticDetail(detail)) {
    return compact(pathContext);
  }
  return compact({
    path: pathContext.relativePath || pathContext.absolutePath,
    module: pathContext.module,
    projectPath: pathContext.projectPath,
    layer: pathContext.layer,
    sourceSet: pathContext.sourceSet
  });
}

export function isDiagnosticDetail(detail?: ResponseDetail): boolean {
  return detail === "diagnostic";
}

export function normalizeHover(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const contents = (value as { contents?: unknown }).contents;
  if (typeof contents === "string") {
    return contents;
  }
  if (Array.isArray(contents)) {
    return contents.map(normalizeHoverContent).join("\n\n");
  }
  return normalizeHoverContent(contents);
}

export function symbolKindName(kind: number): string {
  return [
    "Unknown",
    "File",
    "Module",
    "Namespace",
    "Package",
    "Class",
    "Method",
    "Property",
    "Field",
    "Constructor",
    "Enum",
    "Interface",
    "Function",
    "Variable",
    "Constant",
    "String",
    "Number",
    "Boolean",
    "Array",
    "Object",
    "Key",
    "Null",
    "EnumMember",
    "Struct",
    "Event",
    "Operator",
    "TypeParameter"
  ][kind] || `Kind${kind}`;
}

export function oneBasedRange(range: LspRange): Record<string, unknown> {
  return {
    start: {
      line: range.start.line + 1,
      column: range.start.character + 1
    },
    end: {
      line: range.end.line + 1,
      column: range.end.character + 1
    }
  };
}

export function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function normalizeHoverContent(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if ("value" in value) {
    return (value as { value: unknown }).value;
  }
  return value;
}

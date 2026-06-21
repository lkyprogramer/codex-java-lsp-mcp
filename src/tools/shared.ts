// input: Raw LSP locations, hovers, ranges, and symbols.
// output: Compact JSON-safe descriptions for MCP tools.
// pos: Shared response formatting helpers for v5 tools.
import { fromFileUri, classifyPath, sourcePreview } from "../repo-layout.js";
import type { LspLocation, LspLocationLink, LspRange } from "../jdtls-session.js";

export async function describeLocation(repoRoot: string, location: LspLocation | LspLocationLink, includePreview = false): Promise<Record<string, unknown>> {
  const uri = "targetUri" in location ? location.targetUri : location.uri;
  const range = "targetSelectionRange" in location ? location.targetSelectionRange : location.range;
  const filePath = fromFileUri(uri);
  if (!filePath) {
    return { uri, range: oneBasedRange(range) };
  }
  const line = range.start.line + 1;
  const result: Record<string, unknown> = {
    uri,
    ...classifyPath(repoRoot, filePath),
    line,
    column: range.start.character + 1,
    range: oneBasedRange(range)
  };
  if (includePreview) {
    result.preview = await sourcePreview(filePath, line);
  }
  return compact(result);
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

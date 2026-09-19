import type { SourceRange } from "../runtime/source-range.js";

// v2: named declaration ids are scoped by the normalized repo-relative source
// path, not by the FQN alone. Two declarations sharing an FQN in different
// files (same module duplicate, or the same FQN in different source roots)
// are distinct identities; the FQN remains a multi-valued search attribute.
export const STABLE_ID_VERSION = 2;

export function normalizeStableRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`invalid repo-relative path: ${relativePath}`);
  }
  return normalized;
}

// Identity for a NAMED declaration (v2). The separator "#" and every special
// character are escaped via encodeURIComponent on both segments, so a path
// containing "#", "%", spaces, or non-ASCII text cannot forge the separator
// or collide with another path. Rejects absolute paths, traversal, empty
// segments, and control/separator characters that make a path non-relative.
export function scopedNamedTypeId(relativePath: string, fqn: string): string {
  const p = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!p || p.startsWith("/") || p.includes("\0") || p.includes(":") ||
      p.split("/").some(s => !s || s === "." || s === "..")) {
    throw new Error("invalid repo-relative path");
  }
  if (!fqn) throw new Error("named type requires FQN");
  return `type:v2:${encodeURIComponent(p)}#${encodeURIComponent(fqn)}`;
}

export function javaFileId(relativePath: string): string {
  return `file:${normalizeStableRelativePath(relativePath)}`;
}

export function javaTypeId(input: {
  fqn?: string;
  relativePath: string;
  range: SourceRange;
}): string {
  if (input.fqn) return scopedNamedTypeId(input.relativePath, input.fqn);
  // Anonymous/local declarations have no FQN; they stay position-keyed, scoped
  // to their file. Named top-level/nested declarations always carry an FQN.
  const path = normalizeStableRelativePath(input.relativePath);
  return `type-local:${path}:${input.range.start.line}:${input.range.start.column}`;
}

export function javaMethodId(ownerTypeId: string, erasedSignature: string): string {
  if (!ownerTypeId.startsWith("type:") && !ownerTypeId.startsWith("type-local:")) {
    throw new Error(`invalid owner type id: ${ownerTypeId}`);
  }
  return `method:${ownerTypeId}#${erasedSignature}`;
}

export function javaFieldId(ownerTypeId: string, fieldName: string): string {
  return `field:${ownerTypeId}#${fieldName}`;
}

// Parameters have no fact-store entry of their own (unlike fields/methods) -
// this id only anchors ANNOTATED_WITH edges from a parameter's annotations
// (e.g. @Autowired/@Qualifier/@Value for Spring injection detection) back to
// their owning method, positionally. Stable as long as the method's own id
// is: a parameter reorder changes signatureKey, which changes methodId too.
export function javaParameterId(methodId: string, index: number): string {
  return `${methodId}#p${index}`;
}

// v2 owner ids ("type:v2:<path>#<fqn>") embed one "#" inside the owner itself,
// so "owner#member" keys cannot be split on the first "#". Split on the owner
// boundary instead: v2 owners end at their second "#", v1/local owners at their
// first "#". Returns undefined for malformed keys.
export function splitOwnerMemberKey(key: string): { owner: string; member: string } | undefined {
  if (key.startsWith("type:v2:")) {
    const first = key.indexOf("#");
    if (first === -1) return undefined;
    const second = key.indexOf("#", first + 1);
    if (second === -1) return undefined;
    return { owner: key.slice(0, second), member: key.slice(second + 1) };
  }
  const sep = key.indexOf("#");
  if (sep === -1) return undefined;
  return { owner: key.slice(0, sep), member: key.slice(sep + 1) };
}

export function javaEdgeId(input: {
  kind: string;
  fromId: string;
  toId: string;
  range?: SourceRange;
}): string {
  const rangeKey = input.range
    ? `${input.range.start.line}:${input.range.start.column}-${input.range.end.line}:${input.range.end.column}`
    : "none";
  return `edge:${input.kind}:${input.fromId}:${input.toId}:${rangeKey}`;
}

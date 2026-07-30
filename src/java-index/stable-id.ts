import type { SourceRange } from "../runtime/source-range.js";

export const STABLE_ID_VERSION = 1;

export function normalizeStableRelativePath(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`invalid repo-relative path: ${relativePath}`);
  }
  return normalized;
}

export function javaFileId(relativePath: string): string {
  return `file:${normalizeStableRelativePath(relativePath)}`;
}

export function javaTypeId(input: {
  fqn?: string;
  relativePath: string;
  range: SourceRange;
}): string {
  if (input.fqn) return `type:${input.fqn}`;
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

// input: Repo-relative path, type name, member name, erased signature.
// output: Deterministic JIN entity ids of the form file#type#member#signatureHash.
// pos: N1 id constructor. No AST parse. Absolute worktree roots never enter the id.
import { createHash } from "node:crypto";
import { normalizeStableRelativePath } from "../java-index/stable-id.js";

export const KNOWLEDGE_ID_VERSION = 1 as const;

export function knowledgeFileId(relativePath: string): string {
  return normalizeStableRelativePath(relativePath);
}

export function knowledgeTypeId(relativePath: string, typeName: string): string {
  if (!typeName) throw new Error("knowledge type id requires a type name");
  return `${knowledgeFileId(relativePath)}#${typeName}`;
}

export function knowledgeExternalTypeId(typeName: string): string {
  if (!typeName) throw new Error("external type id requires a type name");
  return `ext:${typeName}`;
}

export function signatureHash(signatureKey: string): string {
  return createHash("sha256").update(signatureKey, "utf8").digest("hex").slice(0, 16);
}

export function knowledgeMemberId(typeId: string, member: string, signatureKey: string): string {
  if (!typeId.includes("#") && !typeId.startsWith("ext:")) {
    throw new Error(`member id owner is not a type id: ${typeId}`);
  }
  return `${typeId}#${member}#${signatureHash(signatureKey)}`;
}

export function knowledgeParameterId(memberId: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("parameter index must be a non-negative integer");
  return `${memberId}#p${index}`;
}

export function knowledgeModuleId(moduleName: string): string {
  return `module:${moduleName || "."}`;
}

export function knowledgeSourceRootId(sourceRoot: string): string {
  return `root:${normalizeStableRelativePath(sourceRoot)}`;
}

export const KNOWLEDGE_REPOSITORY_ID = "repo";

export function knowledgeEdgeId(input: { kind: string; fromId: string; toId: string; ordinal?: number }): string {
  const ordinal = input.ordinal ?? 0;
  return `e:${input.kind}:${input.fromId}->${input.toId}:${ordinal}`;
}

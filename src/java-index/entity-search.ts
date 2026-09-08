import type {
  JavaFieldFacts,
  JavaFileBundle,
  JavaMethodFacts,
  JavaTypeFacts
} from "./index-types.js";
import {
  chunkTokensForMethod,
  chunkTokensForType,
  identifierTokensForMethod,
  identifierTokensForType
} from "./entity-scoring.js";

export {
  bm25Score,
  extractFqnCandidates,
  fileStem,
  identifierLexemes,
  splitIdentifier,
  tokenize
} from "./entity-scoring.js";

export const ENTITY_SEARCH_DEFAULT_LIMIT = 3;
export const ENTITY_SEARCH_MAX_LIMIT = 10;

export type EntityKind = "type" | "method";
export type EntityLayer = "FQN" | "SIMPLE_NAME" | "BM25_IDENTIFIER" | "CHUNK";

export type EntityRecord = {
  entityId: string;
  kind: EntityKind;
  fqn: string;
  simpleName: string;
  relativePath: string;
  identifierTokens: string[];
  chunkTokens: string[];
};

export type EntityHit = {
  entityId: string;
  kind: EntityKind;
  fqn: string;
  simpleName: string;
  relativePath: string;
  layer: EntityLayer;
  score: number;
};

function typeRecord(type: JavaTypeFacts, relativePath: string, fields: readonly JavaFieldFacts[], methods: readonly JavaMethodFacts[]): EntityRecord {
  const fqn = type.fqn ?? type.simpleName;
  return {
    entityId: type.typeId,
    kind: "type",
    fqn,
    simpleName: type.simpleName,
    relativePath,
    identifierTokens: identifierTokensForType(type, relativePath),
    chunkTokens: chunkTokensForType(type, fields, methods)
  };
}

function methodRecord(method: JavaMethodFacts, owner: JavaTypeFacts | undefined, relativePath: string): EntityRecord {
  const ownerFqn = owner?.fqn ?? owner?.simpleName ?? "";
  const fqn = ownerFqn ? `${ownerFqn}#${method.name}` : method.name;
  return {
    entityId: method.methodId,
    kind: "method",
    fqn,
    simpleName: method.name,
    relativePath,
    identifierTokens: identifierTokensForMethod(method, owner, relativePath),
    chunkTokens: chunkTokensForMethod(method)
  };
}

export function recordsFromBundle(bundle: JavaFileBundle): EntityRecord[] {
  const relativePath = bundle.file.relativePath;
  const typeById = new Map(bundle.types.map(type => [type.typeId, type]));
  const fieldsByOwner = new Map<string, JavaFieldFacts[]>();
  for (const field of bundle.fields) {
    const bucket = fieldsByOwner.get(field.ownerTypeId) ?? [];
    bucket.push(field);
    fieldsByOwner.set(field.ownerTypeId, bucket);
  }
  const methodsByOwner = new Map<string, JavaMethodFacts[]>();
  for (const method of bundle.methods) {
    const bucket = methodsByOwner.get(method.ownerTypeId) ?? [];
    bucket.push(method);
    methodsByOwner.set(method.ownerTypeId, bucket);
  }
  const records: EntityRecord[] = [];
  for (const type of bundle.types) {
    records.push(typeRecord(
      type,
      relativePath,
      fieldsByOwner.get(type.typeId) ?? [],
      methodsByOwner.get(type.typeId) ?? []
    ));
  }
  for (const method of bundle.methods) {
    records.push(methodRecord(method, typeById.get(method.ownerTypeId), relativePath));
  }
  return records;
}

// input: Indexed Java type/method facts plus a task string.
// output: Ranked entity hits for the LocAgent-style four-layer entry index.
// pos: JIN N0.5 entity entry index. java_context no-anchor mode calls QUERY_ENTITY_SEARCH.
import type {
  JavaFieldFacts,
  JavaFileBundle,
  JavaMethodFacts,
  JavaTypeFacts
} from "./index-types.js";
import type { JavaIndexStore } from "./index-store.js";
import {
  bm25Score,
  chunkTokensForMethod,
  chunkTokensForType,
  extractFqnCandidates,
  identifierLexemes,
  identifierTokensForMethod,
  identifierTokensForType,
  tokenize
} from "./entity-scoring.js";

export {
  bm25Score,
  extractFqnCandidates,
  fileStem,
  identifierLexemes,
  splitIdentifier,
  tokenize
} from "./entity-scoring.js";

export const ENTITY_SEARCH_VERSION = 1 as const;
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

export type EntitySearchSnapshot = {
  version: typeof ENTITY_SEARCH_VERSION;
  entities: EntityRecord[];
};

function relativePathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice("file:".length) : fileId;
}

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

type Posting = { df: number; tf: Map<string, number> };

function buildPostings(entities: readonly EntityRecord[], field: "identifierTokens" | "chunkTokens"): {
  postings: Map<string, Posting>;
  avgdl: number;
  lengths: Map<string, number>;
} {
  const postings = new Map<string, Posting>();
  const lengths = new Map<string, number>();
  let totalLength = 0;
  for (const entity of entities) {
    const tokens = entity[field];
    lengths.set(entity.entityId, tokens.length);
    totalLength += tokens.length;
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const [token, count] of tf) {
      const posting = postings.get(token) ?? { df: 0, tf: new Map() };
      posting.df += 1;
      posting.tf.set(entity.entityId, count);
      postings.set(token, posting);
    }
  }
  return {
    postings,
    avgdl: entities.length === 0 ? 0 : totalLength / entities.length,
    lengths
  };
}

function rankByBm25(
  entities: readonly EntityRecord[],
  queryTokens: readonly string[],
  field: "identifierTokens" | "chunkTokens",
  layer: EntityLayer,
  limit: number
): EntityHit[] {
  const index = buildPostings(entities, field);
  const dfByToken = new Map([...index.postings].map(([token, posting]) => [token, posting.df]));
  const scored = entities.map(entity => {
    const tf = new Map<string, number>();
    for (const token of entity[field]) tf.set(token, (tf.get(token) ?? 0) + 1);
    return {
      entity,
      score: bm25Score(
        queryTokens,
        tf,
        index.lengths.get(entity.entityId) ?? 0,
        index.avgdl,
        dfByToken,
        entities.length
      )
    };
  }).filter(item => item.score > 0);
  scored.sort((left, right) => right.score - left.score || left.entity.entityId.localeCompare(right.entity.entityId));
  return scored.slice(0, limit).map(item => toHit(item.entity, layer, item.score));
}

function toHit(entity: EntityRecord, layer: EntityLayer, score: number): EntityHit {
  return {
    entityId: entity.entityId,
    kind: entity.kind,
    fqn: entity.fqn,
    simpleName: entity.simpleName,
    relativePath: entity.relativePath,
    layer,
    score
  };
}

export function searchEntities(entities: readonly EntityRecord[], task: string, limit = ENTITY_SEARCH_DEFAULT_LIMIT): EntityHit[] {
  const cap = Math.min(Math.max(1, limit), ENTITY_SEARCH_MAX_LIMIT);
  const queryTokens = tokenize(task);
  const fqnHits = extractFqnCandidates(task)
    .flatMap(candidate => entities.filter(entity => entity.fqn === candidate || entity.fqn.endsWith(`.${candidate}`)))
    .filter((entity, index, all) => all.findIndex(item => item.entityId === entity.entityId) === index);
  if (fqnHits.length > 0) {
    return fqnHits
      .slice()
      .sort((left, right) => left.entityId.localeCompare(right.entityId))
      .slice(0, cap)
      .map(entity => toHit(entity, "FQN", 1));
  }

  const nameLexemes = identifierLexemes(task);
  const simpleHits = entities.filter(entity => entity.kind === "type" && nameLexemes.includes(entity.simpleName.toLowerCase()));
  if (simpleHits.length > 0) {
    const df = new Map<string, number>();
    for (const entity of simpleHits) df.set(entity.simpleName.toLowerCase(), (df.get(entity.simpleName.toLowerCase()) ?? 0) + 1);
    simpleHits.sort((left, right) => {
      const lengthDelta = right.simpleName.length - left.simpleName.length;
      if (lengthDelta !== 0) return lengthDelta;
      const uniqueDelta = (df.get(left.simpleName.toLowerCase()) ?? 0) - (df.get(right.simpleName.toLowerCase()) ?? 0);
      if (uniqueDelta !== 0) return uniqueDelta;
      return left.entityId.localeCompare(right.entityId);
    });
    return simpleHits.slice(0, cap).map(entity => toHit(entity, "SIMPLE_NAME", 1));
  }

  const identifierHits = rankByBm25(entities, queryTokens, "identifierTokens", "BM25_IDENTIFIER", cap);
  if (identifierHits.length > 0) return identifierHits;
  return rankByBm25(entities, queryTokens, "chunkTokens", "CHUNK", cap);
}

export class EntitySearchIndex {
  private readonly entitiesById = new Map<string, EntityRecord>();
  private readonly entityIdsByPath = new Map<string, Set<string>>();

  replaceFile(bundle: JavaFileBundle): void {
    this.removeFiles([bundle.file.relativePath]);
    const records = recordsFromBundle(bundle);
    const ids = new Set<string>();
    for (const record of records) {
      this.entitiesById.set(record.entityId, record);
      ids.add(record.entityId);
    }
    this.entityIdsByPath.set(bundle.file.relativePath, ids);
  }

  removeFiles(relativePaths: readonly string[]): void {
    for (const relativePath of relativePaths) {
      for (const entityId of this.entityIdsByPath.get(relativePath) ?? []) {
        this.entitiesById.delete(entityId);
      }
      this.entityIdsByPath.delete(relativePath);
    }
  }

  rebuildFromStore(store: Pick<JavaIndexStore, "filesByPath" | "typesById" | "methodsById" | "fieldsById">): void {
    this.entitiesById.clear();
    this.entityIdsByPath.clear();
    const fieldsByOwner = new Map<string, JavaFieldFacts[]>();
    for (const field of store.fieldsById.values()) {
      const bucket = fieldsByOwner.get(field.ownerTypeId) ?? [];
      bucket.push(field);
      fieldsByOwner.set(field.ownerTypeId, bucket);
    }
    const methodsByOwner = new Map<string, JavaMethodFacts[]>();
    for (const method of store.methodsById.values()) {
      const bucket = methodsByOwner.get(method.ownerTypeId) ?? [];
      bucket.push(method);
      methodsByOwner.set(method.ownerTypeId, bucket);
    }
    for (const type of store.typesById.values()) {
      const relativePath = relativePathOfFileId(type.fileId);
      const record = typeRecord(
        type,
        store.filesByPath.get(relativePath)?.relativePath ?? relativePath,
        fieldsByOwner.get(type.typeId) ?? [],
        methodsByOwner.get(type.typeId) ?? []
      );
      this.entitiesById.set(record.entityId, record);
      const ids = this.entityIdsByPath.get(record.relativePath) ?? new Set();
      ids.add(record.entityId);
      this.entityIdsByPath.set(record.relativePath, ids);
    }
    for (const method of store.methodsById.values()) {
      const owner = store.typesById.get(method.ownerTypeId);
      const relativePath = owner ? relativePathOfFileId(owner.fileId) : "";
      const record = methodRecord(method, owner, store.filesByPath.get(relativePath)?.relativePath ?? relativePath);
      this.entitiesById.set(record.entityId, record);
      const ids = this.entityIdsByPath.get(record.relativePath) ?? new Set();
      ids.add(record.entityId);
      this.entityIdsByPath.set(record.relativePath, ids);
    }
  }

  search(task: string, limit = ENTITY_SEARCH_DEFAULT_LIMIT): EntityHit[] {
    return searchEntities([...this.entitiesById.values()], task, limit);
  }

  estimatedBytes(): number {
    let bytes = this.entitiesById.size * 48 + this.entityIdsByPath.size * 24;
    for (const entity of this.entitiesById.values()) {
      bytes += entity.entityId.length * 2
        + entity.fqn.length * 2
        + entity.simpleName.length * 2
        + entity.relativePath.length * 2;
      for (const token of entity.identifierTokens) bytes += token.length * 2;
      for (const token of entity.chunkTokens) bytes += token.length * 2;
    }
    return bytes;
  }

  toSnapshot(): EntitySearchSnapshot {
    return {
      version: ENTITY_SEARCH_VERSION,
      entities: [...this.entitiesById.values()].sort((left, right) => left.entityId.localeCompare(right.entityId))
    };
  }

  loadSnapshot(snapshot: EntitySearchSnapshot): void {
    this.entitiesById.clear();
    this.entityIdsByPath.clear();
    if (snapshot.version !== ENTITY_SEARCH_VERSION) return;
    for (const entity of snapshot.entities) {
      this.entitiesById.set(entity.entityId, entity);
      const ids = this.entityIdsByPath.get(entity.relativePath) ?? new Set();
      ids.add(entity.entityId);
      this.entityIdsByPath.set(entity.relativePath, ids);
    }
  }
}

// input: Indexed Java type/method facts plus a task string.
// output: Ranked entity hits for the LocAgent-style four-layer entry index.
// pos: JIN N0.5 benchmark-only QUERY_ENTITY_SEARCH. No public MCP schema change.
import type {
  JavaFieldFacts,
  JavaFileBundle,
  JavaMethodFacts,
  JavaTypeFacts
} from "./index-types.js";
import type { JavaIndexStore } from "./index-store.js";

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

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const ASCII_STOP = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "for", "with", "on", "by"]);

function relativePathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice("file:".length) : fileId;
}

function fileStem(relativePath: string): string {
  const base = relativePath.split("/").pop() ?? relativePath;
  return base.replace(/\.java$/i, "");
}

function unique(tokens: readonly string[]): string[] {
  return [...new Set(tokens.filter(Boolean))];
}

/** Split camelCase / PascalCase / snake_case / digits without touching CJK runs. */
export function splitIdentifier(token: string): string[] {
  if (!token) return [];
  if (/^\p{Script=Han}+$/u.test(token)) return [token];
  const withSplits = token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ");
  return withSplits
    .split(/\s+/)
    .map(part => part.toLowerCase())
    .filter(part => part.length > 0 && !ASCII_STOP.has(part));
}

/**
 * Lexical tokenize for queries and source-derived text.
 * CJK runs pass through as a whole token plus adjacent bigrams (no dictionary).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const source = text.normalize("NFKC");
  const matcher = /[A-Za-z][A-Za-z0-9_]*|[0-9]+|\p{Script=Han}+/gu;
  for (const match of source.matchAll(matcher)) {
    const lexeme = match[0]!;
    if (/^\p{Script=Han}+$/u.test(lexeme)) {
      tokens.push(lexeme);
      if (lexeme.length >= 2) {
        for (let index = 0; index < lexeme.length - 1; index += 1) {
          tokens.push(lexeme.slice(index, index + 2));
        }
      }
      continue;
    }
    const lowered = lexeme.toLowerCase();
    if (!ASCII_STOP.has(lowered)) tokens.push(lowered);
    tokens.push(...splitIdentifier(lexeme));
  }
  return unique(tokens);
}

export function extractFqnCandidates(text: string): string[] {
  const matches = text.match(/[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+(?:#[A-Za-z_][\w]*)?/g) ?? [];
  const hashed = text.match(/[A-Za-z_][\w]*#[A-Za-z_][\w]*/g) ?? [];
  return unique([...matches, ...hashed]);
}

/** Whole identifier lexemes before camelCase split — used by the simpleName dictionary. */
export function identifierLexemes(text: string): string[] {
  const source = text.normalize("NFKC");
  const matcher = /[A-Za-z][A-Za-z0-9_]*|\p{Script=Han}+/gu;
  return unique([...source.matchAll(matcher)]
    .map(match => match[0]!.toLowerCase())
    .filter(token => token.length > 1 && !ASCII_STOP.has(token)));
}

function identifierTokensForType(type: JavaTypeFacts, relativePath: string): string[] {
  return unique([
    ...tokenize(type.simpleName),
    ...tokenize(type.fqn ?? ""),
    ...tokenize(fileStem(relativePath)),
    type.simpleName.toLowerCase()
  ]);
}

function identifierTokensForMethod(method: JavaMethodFacts, owner: JavaTypeFacts | undefined, relativePath: string): string[] {
  const ownerName = owner?.simpleName ?? "";
  const ownerFqn = owner?.fqn ?? ownerName;
  return unique([
    ...tokenize(method.name),
    ...tokenize(ownerName),
    ...tokenize(`${ownerFqn}#${method.name}`),
    ...tokenize(fileStem(relativePath)),
    method.name.toLowerCase()
  ]);
}

function chunkTokensForType(type: JavaTypeFacts, fields: readonly JavaFieldFacts[], methods: readonly JavaMethodFacts[]): string[] {
  return unique([
    ...fields.flatMap(field => tokenize(field.name)),
    ...methods.flatMap(method => tokenize(method.name))
  ]);
}

function chunkTokensForMethod(method: JavaMethodFacts): string[] {
  return unique([
    ...method.parameters.flatMap(parameter => tokenize(parameter.name)),
    ...method.callSites.flatMap(site => tokenize(site.name)),
    ...method.localTypes.flatMap(type => tokenize(type.simpleName)),
    ...tokenize(method.returnType?.simpleName ?? "")
  ]);
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

function recordsFromBundle(bundle: JavaFileBundle): EntityRecord[] {
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

function idf(df: number, documentCount: number): number {
  return Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
}

export function bm25Score(
  queryTokens: readonly string[],
  documentTf: ReadonlyMap<string, number>,
  documentLength: number,
  avgdl: number,
  dfByToken: ReadonlyMap<string, number>,
  documentCount: number
): number {
  if (queryTokens.length === 0 || documentCount === 0 || avgdl <= 0) return 0;
  let score = 0;
  const seen = new Set<string>();
  for (const token of queryTokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    const tf = documentTf.get(token) ?? 0;
    if (tf === 0) continue;
    const df = dfByToken.get(token) ?? 0;
    const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (documentLength / avgdl));
    score += idf(df, documentCount) * (tf * (BM25_K1 + 1)) / denom;
  }
  return score;
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

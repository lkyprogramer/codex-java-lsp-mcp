import {
  bm25Score,
  extractFqnCandidates,
  identifierLexemes,
  tokenize,
  ENTITY_SEARCH_DEFAULT_LIMIT,
  ENTITY_SEARCH_MAX_LIMIT,
  type EntityHit,
  type EntityLayer,
  type EntityRecord
} from "../java-index/entity-search.js";

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

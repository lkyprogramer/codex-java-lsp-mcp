import {
  bm25Score,
  extractFqnCandidates,
  identifierLexemes,
  tokenize,
  ENTITY_SEARCH_DEFAULT_LIMIT,
  ENTITY_SEARCH_MAX_LIMIT,
  matchesExactSelector,
  parseExactSelector,
  type EntityHit,
  type EntityLayer,
  type EntityRecord,
  type EntitySearchMode,
  type DetailedEntitySearchResult,
  type EntitySearchOptions
} from "../java-index/entity-search.js";
import { classifyQuery } from "../discovery/query-intent.js";

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

export function searchEntities(
  entities: readonly EntityRecord[],
  task: string,
  limit = ENTITY_SEARCH_DEFAULT_LIMIT,
  mode: EntitySearchMode = "auto"
): EntityHit[] {
  const cap = Math.min(Math.max(1, limit), ENTITY_SEARCH_MAX_LIMIT);
  if (task.trim().length === 0) return [];
  // Mirrors SqlEntitySearch: the in-memory reference follows the same intent
  // routing so the SQL parity test stays a meaningful check (T04).
  const intent = classifyQuery(task, mode);
  const queryTokens = tokenize(task);
  if (intent === "exact") {
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
  }

  const identifierHits = rankByBm25(entities, queryTokens, "identifierTokens", "BM25_IDENTIFIER", cap);
  const chunkHits = rankByBm25(entities, queryTokens, "chunkTokens", "CHUNK", cap);
  if (intent === "text") return mergeByRank(identifierHits, chunkHits, cap);
  if (identifierHits.length > 0) return identifierHits;
  return chunkHits;
}

// R07 reference for the detailed (discovery) path: same routing as
// SqlEntitySearch.searchDetailed - an exact selector resolves through the
// whole selector only (parseExactSelector/matchesExactSelector) and a miss
// is a miss; text merges both BM25 routes; every route is read to cap+1 so
// `selectionLimited` says whether more candidates existed. Scope filters the
// pool before anything else. No physical work, so no budget truncation.
export function searchEntitiesDetailed(
  entities: readonly EntityRecord[],
  task: string,
  limit = ENTITY_SEARCH_DEFAULT_LIMIT,
  mode: EntitySearchMode = "auto",
  options: EntitySearchOptions = {}
): DetailedEntitySearchResult {
  const cap = Math.min(Math.max(1, limit), ENTITY_SEARCH_MAX_LIMIT);
  const roots = options.scope?.sourceRoots;
  const pool =
    roots && roots.length > 0
      ? entities.filter(record =>
          roots.some(root => record.relativePath === root || record.relativePath.startsWith(`${root.replace(/\/+$/, "")}/`))
        )
      : entities;
  const base = { truncated: false as const, work: { postings: 0 }, generation: 0 };
  if (task.trim().length === 0) return { ...base, hits: [], selectionLimited: false };
  const intent = mode === "auto" ? classifyQuery(task, mode) : mode;
  if (intent === "exact") {
    for (const alternative of parseExactSelector(task)) {
      const found = pool
        .filter(entity => matchesExactSelector(alternative, entity))
        .sort((left, right) => left.entityId.localeCompare(right.entityId));
      if (found.length === 0) continue;
      const layer: EntityLayer = alternative.kind === "type" && alternative.qualifier === undefined ? "SIMPLE_NAME" : "FQN";
      return {
        ...base,
        hits: found.slice(0, cap).map(entity => toHit(entity, layer, 1)),
        selectionLimited: found.length > cap,
        exact: found.length > 1 ? "ambiguous" : "match"
      };
    }
    return { ...base, hits: [], selectionLimited: false, exact: "miss" };
  }
  const queryTokens = tokenize(task);
  const identifierHits = rankByBm25(pool, queryTokens, "identifierTokens", "BM25_IDENTIFIER", cap + 1);
  const chunkHits = rankByBm25(pool, queryTokens, "chunkTokens", "CHUNK", cap + 1);
  const merged = mergeByRank(identifierHits, chunkHits, cap + 1);
  return { ...base, hits: merged.slice(0, cap), selectionLimited: merged.length > cap };
}

function mergeByRank(identifier: EntityHit[], chunk: EntityHit[], cap: number): EntityHit[] {
  const seen = new Set<string>();
  const merged: EntityHit[] = [];
  let rank = 0;
  while (merged.length < cap && rank < Math.max(identifier.length, chunk.length)) {
    for (const route of [identifier, chunk]) {
      const hit = route[rank];
      if (!hit || seen.has(hit.entityId)) continue;
      seen.add(hit.entityId);
      merged.push(hit);
      if (merged.length >= cap) break;
    }
    rank += 1;
  }
  return merged;
}

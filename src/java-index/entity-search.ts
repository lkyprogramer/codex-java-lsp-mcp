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

/** Legacy default of the internal lexical search (java_impact fallbacks). */
export const ENTITY_SEARCH_DEFAULT_LIMIT = 3;
/** R07: the one result cap shared by every discovery layer (tool, discovery
 *  API, SQL clamp). A request above it is rejected, never silently clamped. */
export const ENTITY_SEARCH_MAX_LIMIT = 20;
/** R07: java_symbol static discovery default. */
export const DISCOVERY_DEFAULT_LIMIT = 8;

export type EntitySearchMode = "auto" | "exact" | "text";

export type EntityKind = "type" | "method";
export type EntityLayer = "FQN" | "SIMPLE_NAME" | "BM25_IDENTIFIER" | "CHUNK" | "DOCUMENT";

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
  // T06: optional declaration locator filled by producers that can resolve it
  // (SQL client, in-memory oracle). 1-based UTF-16, ready for java_impact.
  line?: number;
  column?: number;
  contentHash?: string;
  module?: string;
  sourceRoot?: string;
  signature?: string;
};

// T07: query work budget is not the returned row count. It bounds physical
// posting rows visited by the retrieval routes; the returned rows are still
// capped separately by ENTITY_SEARCH_MAX_LIMIT.
export const DEFAULT_QUERY_MAX_POSTINGS = 20_000;

export type EntitySearchScope = {
  /** Relative source-root prefixes; undefined means the whole repository. */
  sourceRoots?: readonly string[];
};

export type EntitySearchStopReason = "deadline" | "postings";

/** R07: exact lookups never fall back to fuzzy routes; they say what happened. */
export type ExactLookupOutcome = "match" | "miss" | "ambiguous";

export type DetailedEntitySearchResult = {
  hits: EntityHit[];
  /** True when the candidate scan stopped before it could be exhaustive. */
  truncated: boolean;
  /** True when more candidates than `limit` matched (cap+1 detection): the
   *  hits are a ranked top-K, not the complete candidate set. */
  selectionLimited: boolean;
  /** Present for exact-intent lookups only. */
  exact?: ExactLookupOutcome;
  stopReason?: EntitySearchStopReason;
  /** Physical work counters for the budget that was applied (if any). */
  work: { postings: number };
  /** Index generation the scan observed; 0 when the db has no generation meta. */
  generation: number;
};

export type EntitySearchOptions = {
  limit?: number;
  mode?: EntitySearchMode;
  scope?: EntitySearchScope;
  budget?: {
    maxPostings?: number;
    remainingMs?: () => number;
  };
};

/** Scope is applied before the result cap: a scoped candidate can never be
 *  pushed out of the cap by an out-of-scope candidate. */
export function filterHitsByScope(hits: readonly EntityHit[], scope: EntitySearchScope | undefined): EntityHit[] {
  const roots = scope?.sourceRoots;
  if (!roots || roots.length === 0) return [...hits];
  return hits.filter(hit =>
    roots.some(root => {
      const prefix = root.endsWith("/") ? root : `${root}/`;
      return hit.relativePath === root || hit.relativePath.startsWith(prefix);
    })
  );
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

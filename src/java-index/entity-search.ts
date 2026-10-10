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
import type { QueryStageTrace } from "../discovery/query-budget.js";

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
  // R08: a DOCUMENT hit names the document that actually matched (comment,
  // framework key, MyBatis XML statement) as its evidence source, separate
  // from the target declaration locator above.
  evidence?: EntityHitEvidence;
};

export type EntityHitEvidence = {
  relativePath: string;
  contentHash: string;
  startLine: number;
  endLine: number;
  sourceKind: string;
};

// T07: query work budget is not the returned row count. It bounds physical
// posting rows visited by the retrieval routes; the returned rows are still
// capped separately by ENTITY_SEARCH_MAX_LIMIT.
export const DEFAULT_QUERY_MAX_POSTINGS = 20_000;

export type EntitySearchScope = {
  /** Relative source-root prefixes; undefined means the whole repository. */
  sourceRoots?: readonly string[];
};

/** "queue_full": the shared query worker's bounded queue rejected the scan. */
export type EntitySearchStopReason = "deadline" | "postings" | "queue_full";

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
  /** Physical work counters for the budget that was applied (if any):
   *  `postings` are the billed (in-scope) posting rows; `examined` also
   *  counts the rows a scope filtered out, which cost scan time but no budget.
   *  `examined` is an upper bound: a scoped scan counts whole pages, and the
   *  row that hit the budget is counted though not billed. */
  work: { postings: number; examined?: number };
  /** Index generation the scan observed; 0 when the db has no generation meta
   *  or no snapshot was read (a request whose deadline expired on entry). */
  generation: number;
  /** R09: per-stage begin/end/remaining/visited; empty when nothing ran. */
  trace?: QueryStageTrace[];
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

/**
 * R07: one exact selector, matched as a whole - never by one of its words.
 * `a.b.C` / `Outer$Inner` / `C` name a type (then, for a dotted selector, the
 * `Owner.method` reading), `Owner#method(...)` names a method. Qualifiers
 * must match whole FQN segments: `Outer.Inner` matches `demo.Outer.Inner`,
 * `demo.Missing` never matches `demo.Demo`. Parameter lists are not
 * signatures (overloads stay ambiguous). Not a selector -> no alternatives.
 */
export type ExactSelectorAlternative =
  | { kind: "type"; name: string; qualifier?: string }
  | { kind: "method"; name: string; owner?: string };

const SELECTOR_IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
const SELECTOR_SHAPE = new RegExp(`^(${SELECTOR_IDENT}(?:[.$]${SELECTOR_IDENT})*)(?:#(${SELECTOR_IDENT})(?:\\([^()]*\\))?)?$`);

export function parseExactSelector(raw: string): ExactSelectorAlternative[] {
  const match = SELECTOR_SHAPE.exec(raw.trim());
  if (!match) return [];
  // `$` is the binary nested-type separator; the index stores canonical dots.
  const path = match[1]!.replace(/\$/g, ".").split(".").filter(Boolean);
  if (path.length === 0) return [];
  if (match[2] !== undefined) return [{ kind: "method", name: match[2], owner: path.join(".") }];
  const name = path[path.length - 1]!;
  if (path.length === 1) return [{ kind: "type", name }, { kind: "method", name }];
  const prefix = path.slice(0, -1).join(".");
  return [{ kind: "type", name, qualifier: prefix }, { kind: "method", name, owner: prefix }];
}

// Stored nested FQNs are binary (`demo.Outer$Inner`); selectors may use
// either separator, so both sides compare in dotted form.
const dotted = (fqn: string) => fqn.replace(/\$/g, ".");
const qualifiedBy = (actual: string, expected: string) => {
  const name = dotted(actual);
  return name === expected || name.endsWith(`.${expected}`);
};

export function matchesExactSelector(alternative: ExactSelectorAlternative, entity: { kind: EntityKind; fqn: string; simpleName: string }): boolean {
  if (entity.kind !== alternative.kind || entity.simpleName !== alternative.name) return false;
  if (alternative.kind === "type") {
    return alternative.qualifier === undefined || qualifiedBy(entity.fqn, `${alternative.qualifier}.${alternative.name}`);
  }
  if (alternative.owner === undefined) return true;
  const hash = entity.fqn.lastIndexOf("#");
  return hash > 0 && qualifiedBy(entity.fqn.slice(0, hash), alternative.owner);
}

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

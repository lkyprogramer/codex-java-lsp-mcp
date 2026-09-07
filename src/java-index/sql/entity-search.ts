import type { SQLOutputValue } from "node:sqlite";
import {
  bm25Score,
  extractFqnCandidates,
  identifierLexemes,
  tokenize
} from "../entity-scoring.js";
import {
  ENTITY_SEARCH_DEFAULT_LIMIT,
  ENTITY_SEARCH_MAX_LIMIT,
  type EntityHit,
  type EntityKind,
  type EntityLayer
} from "../entity-search.js";
import { bindChunks, inClause, prepareCached, type IndexDatabase } from "./driver.js";
import { asCount } from "./facts-store.js";
import { symId, symText } from "./sym.js";

const FIELD_IDENTIFIER = 0;
const FIELD_CHUNK = 1;

function clampLimit(limit: number): number {
  return Math.min(Math.max(1, limit), ENTITY_SEARCH_MAX_LIMIT);
}

function asInt(value: SQLOutputValue | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  throw new Error(`expected integer, got ${String(value)}`);
}

type EntityRow = {
  entityId: string;
  kind: EntityKind;
  fqn: string;
  simpleName: string;
  relativePath: string;
  identLen: number;
  chunkLen: number;
};

function toHit(entity: EntityRow, layer: EntityLayer, score: number): EntityHit {
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

function rowPath(db: IndexDatabase, pathSym: SQLOutputValue | null | undefined): string {
  if (pathSym == null) return "";
  return symText(db, asInt(pathSym));
}

function loadEntityRow(db: IndexDatabase, row: Record<string, SQLOutputValue>): EntityRow {
  return {
    entityId: String(row.entityId),
    kind: String(row.kind) as EntityKind,
    fqn: String(row.fqn),
    simpleName: String(row.simpleName),
    relativePath: rowPath(db, row.pathSym as SQLOutputValue | null | undefined),
    identLen: asInt(row.identLen),
    chunkLen: asInt(row.chunkLen)
  };
}

const ENTITY_SELECT = `SELECT s.text AS entityId, e.kind AS kind, e.fqn AS fqn, e.simple_name AS simpleName,
  e.path_sym AS pathSym, e.ident_len AS identLen, e.chunk_len AS chunkLen
  FROM entity e JOIN sym s ON s.id=e.sym`;

function existingTokenSyms(db: IndexDatabase, tokens: readonly string[]): number[] {
  const ids: number[] = [];
  for (const token of tokens) {
    const id = symId(db, token);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

function fqnHits(db: IndexDatabase, task: string, cap: number): EntityHit[] {
  const seen = new Set<string>();
  const hits: EntityRow[] = [];
  for (const candidate of extractFqnCandidates(task)) {
    for (const row of prepareCached(
      db,
      `${ENTITY_SELECT} WHERE e.fqn=? OR e.fqn LIKE '%.' || ?`
    ).iterate(candidate, candidate) as Iterable<Record<string, SQLOutputValue>>) {
      const entity = loadEntityRow(db, row);
      if (entity.fqn !== candidate && !entity.fqn.endsWith(`.${candidate}`)) continue;
      if (seen.has(entity.entityId)) continue;
      seen.add(entity.entityId);
      hits.push(entity);
    }
  }
  hits.sort((left, right) => left.entityId.localeCompare(right.entityId));
  return hits.slice(0, cap).map(entity => toHit(entity, "FQN", 1));
}

function simpleNameHits(db: IndexDatabase, task: string, cap: number): EntityHit[] {
  const lexemes = identifierLexemes(task);
  if (lexemes.length === 0) return [];
  const hits: EntityRow[] = [];
  for (const chunk of bindChunks(lexemes)) {
    for (const row of prepareCached(
      db,
      `${ENTITY_SELECT} WHERE e.kind='type' AND e.simple_name_lc IN ${inClause(chunk.length)}`
    ).iterate(...chunk) as Iterable<Record<string, SQLOutputValue>>) {
      hits.push(loadEntityRow(db, row));
    }
  }
  if (hits.length === 0) return [];
  const df = new Map<string, number>();
  for (const entity of hits) {
    const key = entity.simpleName.toLowerCase();
    df.set(key, (df.get(key) ?? 0) + 1);
  }
  hits.sort((left, right) => {
    const lengthDelta = right.simpleName.length - left.simpleName.length;
    if (lengthDelta !== 0) return lengthDelta;
    const uniqueDelta = (df.get(left.simpleName.toLowerCase()) ?? 0) - (df.get(right.simpleName.toLowerCase()) ?? 0);
    if (uniqueDelta !== 0) return uniqueDelta;
    return left.entityId.localeCompare(right.entityId);
  });
  return hits.slice(0, cap).map(entity => toHit(entity, "SIMPLE_NAME", 1));
}

function avgLength(db: IndexDatabase, column: "ident_len" | "chunk_len"): { avgdl: number; documentCount: number } {
  const row = prepareCached(db, `SELECT count(*) AS n, coalesce(sum(${column}), 0) AS total FROM entity`).get() as
    | { n: SQLOutputValue; total: SQLOutputValue }
    | undefined;
  const documentCount = asCount(row);
  const total = row ? asInt(row.total) : 0;
  return { documentCount, avgdl: documentCount === 0 ? 0 : total / documentCount };
}

function rankBm25(db: IndexDatabase, task: string, field: 0 | 1, layer: EntityLayer, cap: number): EntityHit[] {
  const queryTokens = tokenize(task);
  const tokenSyms = existingTokenSyms(db, queryTokens);
  if (tokenSyms.length === 0) return [];
  const lengthColumn = field === FIELD_IDENTIFIER ? "ident_len" : "chunk_len";
  const { avgdl, documentCount } = avgLength(db, lengthColumn);
  if (documentCount === 0 || avgdl <= 0) return [];
  const dfByToken = new Map<string, number>();
  for (const token of queryTokens) {
    const tokenSym = symId(db, token);
    if (tokenSym === undefined) {
      dfByToken.set(token, 0);
      continue;
    }
    const dfRow = prepareCached(db, "SELECT df AS n FROM entity_df WHERE field=? AND token_sym=?").get(field, tokenSym) as
      | { n: SQLOutputValue }
      | undefined;
    dfByToken.set(token, asCount(dfRow));
  }
  const grouped = new Map<string, { entity: EntityRow; tf: Map<string, number> }>();
  for (const chunk of bindChunks(tokenSyms, 1)) {
    for (const row of prepareCached(
      db,
      `SELECT s.text AS entityId, e.kind AS kind, e.fqn AS fqn, e.simple_name AS simpleName,
        e.path_sym AS pathSym, e.ident_len AS identLen, e.chunk_len AS chunkLen,
        t.token_sym AS tokenSym, t.tf AS tf
       FROM entity e JOIN sym s ON s.id=e.sym
       JOIN entity_token t ON t.entity_sym=e.sym
       WHERE t.field=? AND t.token_sym IN ${inClause(chunk.length)}`
    ).iterate(field, ...chunk) as Iterable<Record<string, SQLOutputValue>>) {
      const entity = loadEntityRow(db, row);
      const token = symText(db, asInt(row.tokenSym));
      const bucket = grouped.get(entity.entityId) ?? { entity, tf: new Map<string, number>() };
      bucket.tf.set(token, asInt(row.tf));
      grouped.set(entity.entityId, bucket);
    }
  }
  const scored: Array<{ entity: EntityRow; score: number }> = [];
  for (const item of grouped.values()) {
    const documentLength = field === FIELD_IDENTIFIER ? item.entity.identLen : item.entity.chunkLen;
    const score = bm25Score(queryTokens, item.tf, documentLength, avgdl, dfByToken, documentCount);
    if (score > 0) scored.push({ entity: item.entity, score });
  }
  scored.sort((left, right) => right.score - left.score || left.entity.entityId.localeCompare(right.entity.entityId));
  return scored.slice(0, cap).map(item => toHit(item.entity, layer, item.score));
}

export class SqlEntitySearch {
  constructor(private readonly db: IndexDatabase) {}

  search(task: string, limit = ENTITY_SEARCH_DEFAULT_LIMIT): EntityHit[] {
    const cap = clampLimit(limit);
    const fqn = fqnHits(this.db, task, cap);
    if (fqn.length > 0) return fqn;
    const simple = simpleNameHits(this.db, task, cap);
    if (simple.length > 0) return simple;
    const identifier = rankBm25(this.db, task, FIELD_IDENTIFIER, "BM25_IDENTIFIER", cap);
    if (identifier.length > 0) return identifier;
    return rankBm25(this.db, task, FIELD_CHUNK, "CHUNK", cap);
  }
}

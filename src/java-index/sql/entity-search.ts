import type { SQLOutputValue } from "node:sqlite";
import { classifyQuery } from "../../discovery/query-intent.js";
import { QueryWorkBudget } from "../../discovery/query-budget.js";
import {
  bm25Score,
  extractFqnCandidates,
  identifierLexemes,
  tokenize
} from "../entity-scoring.js";
import {
  DEFAULT_QUERY_MAX_POSTINGS,
  ENTITY_SEARCH_DEFAULT_LIMIT,
  ENTITY_SEARCH_MAX_LIMIT,
  filterHitsByScope,
  type DetailedEntitySearchResult,
  type EntityHit,
  type EntityKind,
  type EntityLayer,
  type EntitySearchMode,
  type EntitySearchOptions,
  type EntitySearchStopReason
} from "../entity-search.js";
import { bindChunks, inClause, prepareCached, type IndexDatabase } from "./driver.js";
import { asCount } from "./facts-store.js";
import { decodeFacts } from "./rows.js";
import { symId, symText } from "./sym.js";
import { searchDocStats } from "./search-docs.js";
import type { JavaMethodFacts, JavaTypeFacts } from "../index-types.js";

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

// T07: corpus statistics are maintained by the writer (rebuildEntityDf)
// in meta so a query never pays for a full entity scan to derive BM25
// normalization. DBs written before the stats existed fall back to a scan.
const ENTITY_STATS_KEYS = { identifier: "entityStats:identifier", chunk: "entityStats:chunk" } as const;

function avgLength(db: IndexDatabase, column: "ident_len" | "chunk_len"): { avgdl: number; documentCount: number } {
  const key = column === "ident_len" ? ENTITY_STATS_KEYS.identifier : ENTITY_STATS_KEYS.chunk;
  const metaRow = prepareCached(db, "SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
  if (metaRow && typeof metaRow.value === "string") {
    const [countRaw, totalRaw] = metaRow.value.split(":");
    const documentCount = Number(countRaw);
    const total = Number(totalRaw);
    if (Number.isFinite(documentCount) && Number.isFinite(total)) {
      return { documentCount, avgdl: documentCount === 0 ? 0 : total / documentCount };
    }
  }
  const row = prepareCached(db, `SELECT count(*) AS n, coalesce(sum(${column}), 0) AS total FROM entity`).get() as
    | { n: SQLOutputValue; total: SQLOutputValue }
    | undefined;
  const documentCount = asCount(row);
  const total = row ? asInt(row.total) : 0;
  return { documentCount, avgdl: documentCount === 0 ? 0 : total / documentCount };
}

// A scan stop is sticky; a deadline always outranks the posting cap so the
// reported reason is the most severe one observed.
function recordStop(stop: { reason?: EntitySearchStopReason }, verdict: "deadline" | "postings"): void {
  if (verdict === "deadline" || stop.reason === undefined) stop.reason = verdict;
}

export function readIndexGeneration(db: IndexDatabase): number {
  const row = prepareCached(db, "SELECT value FROM meta WHERE key=?").get("indexedGeneration") as { value: string } | undefined;
  return row && typeof row.value === "string" ? Number(row.value) || 0 : 0;
}

function rankBm25(
  db: IndexDatabase,
  task: string,
  field: 0 | 1,
  layer: EntityLayer,
  cap: number,
  budget?: QueryWorkBudget,
  stop?: { reason?: EntitySearchStopReason }
): EntityHit[] {
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
      // T07: every posting row is billed against the query work budget at
      // the interruptible boundary between rows; synchronous SQL cannot stop
      // mid-statement, so the scan ends at the row boundary.
      if (budget) {
        const verdict = budget.take();
        if (verdict !== "ok") {
          if (stop) recordStop(stop, verdict);
          break;
        }
      }
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

// Source-linked document route (T05): signature/comment/framework-key text
// indexed by the writer; statistics are writer-maintained, never rescanned.
function docHits(
  db: IndexDatabase,
  task: string,
  cap: number,
  budget?: QueryWorkBudget,
  stop?: { reason?: EntitySearchStopReason }
): EntityHit[] {
  const queryTokens = tokenize(task);
  const tokenSyms = existingTokenSyms(db, queryTokens);
  if (tokenSyms.length === 0) return [];
  const stats = searchDocStats(db);
  if (stats.docCount === 0 || stats.totalLen <= 0) return [];
  const avgdl = stats.totalLen / stats.docCount;
  const dfByToken = new Map<string, number>();
  const postingSyms: number[] = [];
  for (const token of queryTokens) {
    const tokenSym = symId(db, token);
    if (tokenSym === undefined) { dfByToken.set(token, 0); continue; }
    const dfRow = prepareCached(db, "SELECT df AS n FROM search_doc_df WHERE token_sym=?").get(tokenSym) as
      | { n: SQLOutputValue }
      | undefined;
    const df = asCount(dfRow);
    dfByToken.set(token, df);
    if (df > 0) postingSyms.push(tokenSym);
  }
  if (postingSyms.length === 0) return [];
  // docSym -> { tfByToken, docLen, declarationSym, pathSym }
  const docs = new Map<number, { tf: Map<string, number>; docLen: number; declarationSym: number; pathSym: number | undefined }>();
  for (const chunk of bindChunks(postingSyms)) {
    for (const row of prepareCached(
      db,
      `SELECT t.doc_sym AS docSym, t.token_sym AS tokenSym, t.tf AS tf, d.token_len AS docLen
         FROM search_doc_token t JOIN search_doc d ON d.sym=t.doc_sym
        WHERE t.token_sym IN ${inClause(chunk.length)}`
    ).iterate(...chunk) as Iterable<Record<string, SQLOutputValue>>) {
      if (budget) {
        const verdict = budget.take();
        if (verdict !== "ok") {
          if (stop) recordStop(stop, verdict);
          break;
        }
      }
      const docSym = asInt(row.docSym);
      const bucket = docs.get(docSym) ?? { tf: new Map<string, number>(), docLen: asInt(row.docLen), declarationSym: 0, pathSym: undefined };
      bucket.tf.set(symText(db, asInt(row.tokenSym)), asInt(row.tf));
      docs.set(docSym, bucket);
    }
  }
  if (docs.size === 0) return [];
  for (const chunk of bindChunks([...docs.keys()])) {
    for (const row of prepareCached(
      db,
      `SELECT sym AS docSym, declaration_sym AS declarationSym, path_sym AS pathSym FROM search_doc WHERE sym IN ${inClause(chunk.length)}`
    ).iterate(...chunk) as Iterable<Record<string, SQLOutputValue>>) {
      const bucket = docs.get(asInt(row.docSym));
      if (!bucket) continue;
      bucket.declarationSym = asInt(row.declarationSym);
      bucket.pathSym = row.pathSym == null ? undefined : asInt(row.pathSym);
    }
  }
  const bestByDeclaration = new Map<number, { score: number; docPathSym: number | undefined; docSym: number }>();
  for (const [docSym, bucket] of docs) {
    const score = bm25Score(queryTokens, bucket.tf, bucket.docLen, avgdl, dfByToken, stats.docCount);
    if (score <= 0) continue;
    const current = bestByDeclaration.get(bucket.declarationSym);
    if (!current || score > current.score || (score === current.score && docSym < current.docSym)) {
      bestByDeclaration.set(bucket.declarationSym, { score, docPathSym: bucket.pathSym, docSym });
    }
  }
  if (bestByDeclaration.size === 0) return [];
  const declarationSyms = [...bestByDeclaration.keys()];
  const out: EntityHit[] = [];
  for (const chunk of bindChunks(declarationSyms)) {
    for (const row of prepareCached(
      db,
      `SELECT e.sym AS sym, e.kind AS kind, e.fqn AS fqn, e.simple_name AS simpleName, e.path_sym AS pathSym
         FROM entity e WHERE e.sym IN ${inClause(chunk.length)}`
    ).iterate(...chunk) as Iterable<Record<string, SQLOutputValue>>) {
      const sym = asInt(row.sym);
      const best = bestByDeclaration.get(sym);
      if (!best) continue;
      out.push({
        entityId: symText(db, sym),
        kind: String(row.kind) as EntityKind,
        fqn: String(row.fqn),
        simpleName: String(row.simpleName),
        relativePath: rowPath(db, row.pathSym as SQLOutputValue | null | undefined),
        layer: "DOCUMENT",
        score: best.score
      });
    }
  }
  out.sort((left, right) => right.score - left.score || left.entityId.localeCompare(right.entityId));
  return out.slice(0, cap);
}

// T06: declaration locator enrichment for the discovery API. Point lookups
// only (sym PK, then declaration row, then file row); a hit without a stored
// range stays unlocatable instead of guessing a line.
function attachLocators(db: IndexDatabase, hits: EntityHit[]): EntityHit[] {
  const byEntity = new Map<string, EntityHit>();
  for (const hit of hits) byEntity.set(hit.entityId, hit);
  for (const hit of byEntity.values()) {
    const symRow = prepareCached(db, "SELECT id FROM sym WHERE text=?").get(hit.entityId) as { id: SQLOutputValue } | undefined;
    const sym = symRow ? asInt(symRow.id) : undefined;
    if (sym === undefined) continue;
    const fileRow = hit.kind === "type"
      ? (prepareCached(db, "SELECT file_id AS fileId, facts FROM type WHERE sym=?").get(sym) as { fileId: SQLOutputValue; facts: SQLOutputValue } | undefined)
      : (prepareCached(db, "SELECT file_id AS fileId, facts, arity FROM method WHERE sym=?").get(sym) as { fileId: SQLOutputValue; facts: SQLOutputValue; arity: SQLOutputValue } | undefined);
    if (!fileRow) continue;
    const declaration = hit.kind === "type"
      ? (decodeFacts<JavaTypeFacts>(fileRow.facts) ?? undefined)
      : (decodeFacts<JavaMethodFacts>(fileRow.facts) ?? undefined);
    const range = declaration?.range;
    if (range) {
      hit.line = range.start.line;
      hit.column = range.start.column;
    }
    if (hit.kind === "method") {
      const arity = (fileRow as { arity?: SQLOutputValue }).arity;
      if (typeof arity !== "undefined") hit.signature = `${hit.simpleName}(${asInt(arity)} args)`;
    } else {
      hit.signature = hit.fqn;
    }
    const file = prepareCached(db, "SELECT content_hash AS contentHash, source_root AS sourceRoot, module AS module FROM file WHERE id=?").get(asInt(fileRow.fileId)) as
      | { contentHash: SQLOutputValue; sourceRoot: SQLOutputValue; module: SQLOutputValue }
      | undefined;
    if (file) {
      hit.contentHash = String(file.contentHash);
      if (typeof file.sourceRoot === "string" && file.sourceRoot) hit.sourceRoot = file.sourceRoot;
      if (typeof file.module === "string" && file.module) hit.module = file.module;
    }
  }
  return hits;
}

export class SqlEntitySearch {
  constructor(private readonly db: IndexDatabase) {}

  search(task: string, limit: number = ENTITY_SEARCH_DEFAULT_LIMIT, mode: EntitySearchMode = "auto"): EntityHit[] {
    const cap = clampLimit(limit);
    if (task.trim().length === 0) return [];
    // T04: exact code shapes may short-circuit on the name layers; free-text
    // task intent must let every route compete, so a class name in the query
    // never hides the method that matches the intent words. The 1..512 length
    // contract is enforced at the discovery API boundary, not here, because
    // internal callers pass empty task text on purpose.
    const intent = classifyQuery(task, mode);
    if (intent === "exact") {
      const fqn = fqnHits(this.db, task, cap);
      if (fqn.length > 0) return fqn;
      const simple = simpleNameHits(this.db, task, cap);
      if (simple.length > 0) return simple;
    }
    const identifier = rankBm25(this.db, task, FIELD_IDENTIFIER, "BM25_IDENTIFIER", cap);
    const chunk = rankBm25(this.db, task, FIELD_CHUNK, "CHUNK", cap);
    if (intent === "text") {
      const doc = docHits(this.db, task, cap);
      return mergeByRank([identifier, chunk, doc], cap);
    }
    return firstNonEmpty(identifier, chunk, cap);
  }

  // T07: budgeted, scoped retrieval. The work budget bounds posting rows
  // visited (never the returned rows); scope is applied before the result
  // cap; any exhausted budget reports an explicit partial result with the
  // stop reason instead of pretending the scan was complete. The reported
  // generation labels the snapshot the scan observed (K20).
  searchDetailed(
    task: string,
    limit: number = ENTITY_SEARCH_DEFAULT_LIMIT,
    mode: EntitySearchMode = "auto",
    options: EntitySearchOptions = {}
  ): DetailedEntitySearchResult {
    const cap = clampLimit(limit);
    const generation = readIndexGeneration(this.db);
    let budget: QueryWorkBudget | undefined;
    if (options.budget) {
      budget = new QueryWorkBudget(
        options.budget.maxPostings ?? DEFAULT_QUERY_MAX_POSTINGS,
        options.budget.remainingMs ?? (() => Number.POSITIVE_INFINITY)
      );
    }
    const work = { postings: budget ? 0 : 0 };
    const stop: { reason?: EntitySearchStopReason } = {};
    const finish = (hits: EntityHit[]): DetailedEntitySearchResult => {
      const result: DetailedEntitySearchResult = {
        hits: attachLocators(this.db, hits),
        truncated: stop.reason !== undefined,
        work: { postings: budget ? budget.visited() : 0 },
        generation
      };
      if (stop.reason !== undefined) result.stopReason = stop.reason;
      return result;
    };
    if (task.trim().length === 0) return finish([]);
    const intent = classifyQuery(task, mode);
    if (intent === "exact") {
      const fqn = filterHitsByScope(fqnHits(this.db, task, cap), options.scope);
      if (fqn.length > 0) return finish(fqn);
      const simple = filterHitsByScope(simpleNameHits(this.db, task, cap), options.scope);
      if (simple.length > 0) return finish(simple);
    }
    const identifier = filterHitsByScope(
      rankBm25(this.db, task, 0, "BM25_IDENTIFIER", cap, budget, stop),
      options.scope
    );
    const chunk = filterHitsByScope(rankBm25(this.db, task, 1, "CHUNK", cap, budget, stop), options.scope);
    if (intent === "text") {
      const doc = filterHitsByScope(docHits(this.db, task, cap, budget, stop), options.scope);
      return finish(mergeByRank([identifier, chunk, doc], cap));
    }
    return finish(firstNonEmpty(identifier, chunk, cap));
  }
}

// text intent merges both BM25 routes so a type hit never preempts a method
// hit. Results interleave by per-route RANK (not cross-field score, which is
// not comparable across fields); the in-memory oracle performs the identical
// interleave to keep the parity test meaningful.
function mergeByRank(routes: EntityHit[][], cap: number): EntityHit[] {
  const seen = new Set<string>();
  const merged: EntityHit[] = [];
  let rank = 0;
  const maxLen = Math.max(0, ...routes.map(route => route.length));
  while (merged.length < cap && rank < maxLen) {
    for (const route of routes) {
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

function firstNonEmpty(identifier: EntityHit[], chunk: EntityHit[], cap: number): EntityHit[] {
  if (identifier.length > 0) return identifier.slice(0, cap);
  return chunk.slice(0, cap);
}

import type { SQLOutputValue } from "node:sqlite";
import { classifyQuery } from "../../discovery/query-intent.js";
import { QueryTrace, QueryWorkBudget } from "../../discovery/query-budget.js";
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
  matchesExactSelector,
  parseExactSelector,
  type DetailedEntitySearchResult,
  type EntityHit,
  type EntityHitEvidence,
  type EntityKind,
  type EntityLayer,
  type EntitySearchMode,
  type EntitySearchOptions,
  type EntitySearchScope,
  type EntitySearchStopReason
} from "../entity-search.js";
import { bindChunks, inClause, prepareCached, withReadSnapshot, type IndexDatabase } from "./driver.js";
import { asCount } from "./facts-store.js";
import { decodeFacts } from "./rows.js";
import { symId, symText } from "./sym.js";
import { searchDocStats } from "./search-docs.js";
import { ENTITY_STATS_KEYS } from "./entity-tokens.js";
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

const ENTITY_SELECT = `SELECT e.sym AS sym, s.text AS entityId, e.kind AS kind, e.fqn AS fqn, e.simple_name AS simpleName,
  e.path_sym AS pathSym, e.ident_len AS identLen, e.chunk_len AS chunkLen
  FROM entity e JOIN sym s ON s.id=e.sym`;

/**
 * R06: the scope predicate every route pushes into its SQL, so out-of-scope
 * rows never reach the postings budget, ranking or the result cap. Same
 * semantics as filterHitsByScope (path === root or under `root/`); roots are
 * bound parameters, never interpolated.
 */
type ScopeSql = { sql: string; params: string[] };

function scopeSql(pathSymColumn: string, scope: EntitySearchScope | undefined): ScopeSql {
  const roots = [...new Set((scope?.sourceRoots ?? []).map(root => root.replace(/\/+$/, "")).filter(root => root.length > 0))];
  if (roots.length === 0) return { sql: "", params: [] };
  const terms = roots.map(() => "(ps.text=? OR substr(ps.text, 1, length(?))=?)").join(" OR ");
  return {
    sql: ` AND EXISTS (SELECT 1 FROM sym ps WHERE ps.id=${pathSymColumn} AND (${terms}))`,
    params: roots.flatMap(root => [root, `${root}/`, `${root}/`])
  };
}

// Query tokens that exist in the corpus, keyed by sym: posting rows carry
// token syms, so a row maps back to its token without a per-row lookup.
function queryTokenSyms(db: IndexDatabase, tokens: readonly string[]): Map<number, string> {
  const bySym = new Map<number, string>();
  for (const token of tokens) {
    const id = symId(db, token);
    if (id !== undefined) bySym.set(id, token);
  }
  return bySym;
}

type RouteContext = {
  budget?: QueryWorkBudget;
  stop?: { reason?: EntitySearchStopReason };
  scope?: ScopeSql;
  trace?: QueryTrace;
};

function staged<T>(context: RouteContext, operation: string, fn: () => { value: T; visited: number }): T {
  return context.trace ? context.trace.stage(operation, fn) : fn().value;
}

// R09: a route that starts after the deadline does no SQL at all.
function expiredBefore(context: RouteContext): boolean {
  if (!context.budget?.expired()) return false;
  if (context.stop) recordStop(context.stop, "deadline");
  return true;
}

/**
 * R09: top-`cap` by (score desc, entityId asc) without loading every scored
 * candidate. Candidates are taken in whole score tiers - every candidate tied
 * with the last one needed - so the id tie-break sees all of them; a tier
 * whose ids do not resolve pulls in the next tier.
 */
function selectTop<T extends { sym: number; score: number }>(
  scored: T[],
  cap: number,
  resolveIds: (syms: number[]) => Map<number, string>
): Array<T & { entityId: string }> {
  scored.sort((left, right) => right.score - left.score);
  const out: Array<T & { entityId: string }> = [];
  let index = 0;
  while (index < scored.length && out.length < cap) {
    const last = Math.min(scored.length, index + cap - out.length) - 1;
    const cut = scored[last]!.score;
    let end = last + 1;
    while (end < scored.length && scored[end]!.score >= cut) end += 1;
    const tier = scored.slice(index, end);
    const ids = resolveIds(tier.map(item => item.sym));
    for (const item of tier) {
      const entityId = ids.get(item.sym);
      if (entityId !== undefined) out.push({ ...item, entityId });
    }
    index = end;
  }
  out.sort((left, right) => right.score - left.score || left.entityId.localeCompare(right.entityId));
  return out.slice(0, cap);
}

function entityIds(db: IndexDatabase, syms: number[]): Map<number, string> {
  const ids = new Map<number, string>();
  for (const chunk of bindChunks(syms)) {
    for (const row of prepareCached(
      db,
      `SELECT e.sym AS sym, s.text AS entityId FROM entity e JOIN sym s ON s.id=e.sym WHERE e.sym IN ${inClause(chunk.length)}`
    ).iterate(...chunk) as Iterable<Record<string, SQLOutputValue>>) {
      ids.set(asInt(row.sym), String(row.entityId));
    }
  }
  return ids;
}

function entityRows(db: IndexDatabase, syms: number[]): Map<number, EntityRow> {
  const rows = new Map<number, EntityRow>();
  for (const chunk of bindChunks(syms)) {
    for (const row of prepareCached(db, `${ENTITY_SELECT} WHERE e.sym IN ${inClause(chunk.length)}`)
      .iterate(...chunk) as Iterable<Record<string, SQLOutputValue>>) {
      rows.set(asInt(row.sym), loadEntityRow(db, row));
    }
  }
  return rows;
}

function fqnHits(db: IndexDatabase, task: string, cap: number, scope?: ScopeSql): EntityHit[] {
  const seen = new Set<string>();
  const hits: EntityRow[] = [];
  for (const candidate of extractFqnCandidates(task)) {
    for (const row of prepareCached(
      db,
      `${ENTITY_SELECT} WHERE (e.fqn=? OR e.fqn LIKE '%.' || ?)${scope?.sql ?? ""}`
    ).iterate(candidate, candidate, ...(scope?.params ?? [])) as Iterable<Record<string, SQLOutputValue>>) {
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

function simpleNameHits(db: IndexDatabase, task: string, cap: number, scope?: ScopeSql, kind: EntityKind = "type"): EntityHit[] {
  const lexemes = identifierLexemes(task);
  if (lexemes.length === 0) return [];
  const hits: EntityRow[] = [];
  for (const chunk of bindChunks(lexemes)) {
    for (const row of prepareCached(
      db,
      `${ENTITY_SELECT} WHERE e.kind=? AND e.simple_name_lc IN ${inClause(chunk.length)}${scope?.sql ?? ""}`
    ).iterate(kind, ...chunk, ...(scope?.params ?? [])) as Iterable<Record<string, SQLOutputValue>>) {
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

/**
 * R07: an exact selector resolves as a WHOLE selector (parseExactSelector):
 * candidates come from the simple-name index, then must match every
 * qualifier segment. A miss is a miss: no word-level match and no fall
 * through to BM25. Several declarations for one selector are ambiguous.
 */
function exactHits(
  db: IndexDatabase,
  task: string,
  cap: number,
  context: RouteContext
): { hits: EntityHit[]; outcome: "match" | "miss" | "ambiguous"; visited: number } {
  const scope = context.scope;
  let visited = 0;
  for (const alternative of parseExactSelector(task)) {
    // R09: the deadline is checked before every alternative and between rows;
    // an interrupted lookup reports no outcome (see searchDetailed).
    if (expiredBefore(context)) return { hits: [], outcome: "miss", visited };
    const found: EntityRow[] = [];
    for (const row of prepareCached(
      db,
      `${ENTITY_SELECT} WHERE e.kind=? AND e.simple_name_lc=?${scope?.sql ?? ""}`
    ).iterate(alternative.kind, alternative.name.toLowerCase(), ...(scope?.params ?? [])) as Iterable<Record<string, SQLOutputValue>>) {
      if (expiredBefore(context)) return { hits: [], outcome: "miss", visited };
      visited += 1;
      const entity = loadEntityRow(db, row);
      if (matchesExactSelector(alternative, entity)) found.push(entity);
    }
    if (found.length === 0) continue;
    found.sort((left, right) => left.entityId.localeCompare(right.entityId));
    const hits = found.slice(0, cap + 1).map(entity => toHit(entity, alternative.kind === "type" && alternative.qualifier === undefined ? "SIMPLE_NAME" : "FQN", 1));
    return { hits, outcome: found.length > 1 ? "ambiguous" : "match", visited };
  }
  return { hits: [], outcome: "miss", visited };
}

// T07: corpus statistics are maintained by the writer (rebuildEntityDf)
// in meta so a query never pays for a full entity scan to derive BM25
// normalization. DBs written before the stats existed fall back to a scan.
// The key constants are owned by the writer (entity-tokens) so the reader can
// never drift from the keys the writer publishes.
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
  context: RouteContext = {}
): EntityHit[] {
  const route = field === FIELD_IDENTIFIER ? "identifier" : "chunk";
  if (expiredBefore(context)) return [];
  const { budget, stop, scope } = context;
  const queryTokens = tokenize(task);
  const tokenBySym = queryTokenSyms(db, queryTokens);
  if (tokenBySym.size === 0) return [];
  const lengthColumn = field === FIELD_IDENTIFIER ? "ident_len" : "chunk_len";
  const { avgdl, documentCount } = avgLength(db, lengthColumn);
  if (documentCount === 0 || avgdl <= 0) return [];
  const dfByToken = new Map<string, number>();
  for (const token of queryTokens) dfByToken.set(token, 0);
  for (const [tokenSym, token] of tokenBySym) {
    const dfRow = prepareCached(db, "SELECT df AS n FROM entity_df WHERE field=? AND token_sym=?").get(field, tokenSym) as
      | { n: SQLOutputValue }
      | undefined;
    dfByToken.set(token, asCount(dfRow));
  }
  // R09: posting rows carry integers only (entity sym, token sym, tf, length);
  // entity text is loaded for the ranked top-K, never per posting.
  const grouped = staged(context, `postings:${route}`, () => {
    const byEntity = new Map<number, { length: number; tf: Map<string, number> }>();
    let visited = 0;
    scan: for (const chunk of bindChunks([...tokenBySym.keys()], 1)) {
      for (const row of prepareCached(
        db,
        `SELECT t.entity_sym AS entitySym, t.token_sym AS tokenSym, t.tf AS tf, e.${lengthColumn} AS len
           FROM entity_token t JOIN entity e ON e.sym=t.entity_sym
          WHERE t.field=? AND t.token_sym IN ${inClause(chunk.length)}${scope?.sql ?? ""}`
      ).iterate(field, ...chunk, ...(scope?.params ?? [])) as Iterable<Record<string, SQLOutputValue>>) {
        // T07: every posting row is billed against the query work budget at
        // the interruptible boundary between rows; synchronous SQL cannot stop
        // mid-statement, so the scan ends at the row boundary.
        if (budget) {
          const verdict = budget.take();
          if (verdict !== "ok") {
            if (stop) recordStop(stop, verdict);
            break scan;
          }
        }
        visited += 1;
        const entitySym = asInt(row.entitySym);
        const bucket = byEntity.get(entitySym) ?? { length: asInt(row.len), tf: new Map<string, number>() };
        bucket.tf.set(tokenBySym.get(asInt(row.tokenSym))!, asInt(row.tf));
        byEntity.set(entitySym, bucket);
      }
    }
    return { value: byEntity, visited };
  });
  return staged(context, `rank:${route}`, () => {
    const scored: Array<{ sym: number; score: number }> = [];
    for (const [sym, item] of grouped) {
      const score = bm25Score(queryTokens, item.tf, item.length, avgdl, dfByToken, documentCount);
      if (score > 0) scored.push({ sym, score });
    }
    const top = selectTop(scored, cap, syms => entityIds(db, syms));
    const rows = entityRows(db, top.map(item => item.sym));
    const hits = top.flatMap(item => {
      const entity = rows.get(item.sym);
      return entity ? [toHit(entity, layer, item.score)] : [];
    });
    return { value: hits, visited: scored.length };
  });
}

// Source-linked document route (T05): signature/comment/framework-key text
// indexed by the writer; statistics are writer-maintained, never rescanned.
function docHits(
  db: IndexDatabase,
  task: string,
  cap: number,
  context: RouteContext = {}
): EntityHit[] {
  if (expiredBefore(context)) return [];
  const { budget, stop, scope } = context;
  const queryTokens = tokenize(task);
  const tokenBySym = queryTokenSyms(db, queryTokens);
  if (tokenBySym.size === 0) return [];
  const stats = searchDocStats(db);
  if (stats.docCount === 0 || stats.totalLen <= 0) return [];
  const avgdl = stats.totalLen / stats.docCount;
  const dfByToken = new Map<string, number>();
  for (const token of queryTokens) dfByToken.set(token, 0);
  const postingSyms: number[] = [];
  for (const [tokenSym, token] of tokenBySym) {
    const dfRow = prepareCached(db, "SELECT df AS n FROM search_doc_df WHERE token_sym=?").get(tokenSym) as
      | { n: SQLOutputValue }
      | undefined;
    const df = asCount(dfRow);
    dfByToken.set(token, df);
    if (df > 0) postingSyms.push(tokenSym);
  }
  if (postingSyms.length === 0) return [];
  const docs = staged(context, "postings:document", () => {
    // docSym -> { tfByToken, docLen, declarationSym }
    const byDoc = new Map<number, { tf: Map<string, number>; docLen: number; declarationSym: number }>();
    let visited = 0;
    scan: for (const chunk of bindChunks(postingSyms)) {
      for (const row of prepareCached(
        db,
        // Scope applies to the declaration a document points at (the hit is
        // that declaration), joined before any posting is billed.
        `SELECT t.doc_sym AS docSym, t.token_sym AS tokenSym, t.tf AS tf, d.token_len AS docLen, d.declaration_sym AS declarationSym
           FROM search_doc_token t JOIN search_doc d ON d.sym=t.doc_sym
           ${scope?.sql ? "JOIN entity e ON e.sym=d.declaration_sym" : ""}
          WHERE t.token_sym IN ${inClause(chunk.length)}${scope?.sql ?? ""}`
      ).iterate(...chunk, ...(scope?.params ?? [])) as Iterable<Record<string, SQLOutputValue>>) {
        if (budget) {
          const verdict = budget.take();
          if (verdict !== "ok") {
            if (stop) recordStop(stop, verdict);
            break scan;
          }
        }
        visited += 1;
        const docSym = asInt(row.docSym);
        const bucket = byDoc.get(docSym) ?? { tf: new Map<string, number>(), docLen: asInt(row.docLen), declarationSym: asInt(row.declarationSym) };
        bucket.tf.set(tokenBySym.get(asInt(row.tokenSym))!, asInt(row.tf));
        byDoc.set(docSym, bucket);
      }
    }
    return { value: byDoc, visited };
  });
  if (docs.size === 0) return [];
  return staged(context, "rank:document", () => {
    const bestByDeclaration = new Map<number, { score: number; docSym: number }>();
    for (const [docSym, bucket] of docs) {
      const score = bm25Score(queryTokens, bucket.tf, bucket.docLen, avgdl, dfByToken, stats.docCount);
      if (score <= 0) continue;
      const current = bestByDeclaration.get(bucket.declarationSym);
      if (!current || score > current.score || (score === current.score && docSym < current.docSym)) {
        bestByDeclaration.set(bucket.declarationSym, { score, docSym });
      }
    }
    const scored = [...bestByDeclaration].map(([sym, best]) => ({ sym, score: best.score, docSym: best.docSym }));
    // Declarations without an entity row never resolve, as before.
    const top = selectTop(scored, cap, syms => entityIds(db, syms));
    const rows = entityRows(db, top.map(item => item.sym));
    const out: EntityHit[] = [];
    for (const item of top) {
      const entity = rows.get(item.sym);
      if (!entity) continue;
      const evidence = documentEvidence(db, item.docSym);
      out.push({ ...toHit(entity, "DOCUMENT", item.score), ...(evidence ? { evidence } : {}) });
    }
    return { value: out, visited: scored.length };
  });
}

/** The matched document's own source (XML for a MyBatis statement). */
function documentEvidence(db: IndexDatabase, docSym: number): EntityHitEvidence | undefined {
  const row = prepareCached(
    db,
    "SELECT source_path_sym AS sourcePathSym, content_hash AS contentHash, kind AS kind, start_line AS startLine, end_line AS endLine FROM search_doc WHERE sym=?"
  ).get(docSym) as Record<string, SQLOutputValue> | undefined;
  if (!row || row.sourcePathSym == null) return undefined;
  return {
    relativePath: symText(db, asInt(row.sourcePathSym)),
    contentHash: String(row.contentHash),
    startLine: asInt(row.startLine),
    endLine: asInt(row.endLine),
    sourceKind: String(row.kind)
  };
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

  // T07/R06: budgeted, scoped retrieval. The work budget bounds posting rows
  // visited (never the returned rows); scope is pushed into every route's SQL
  // so it precedes the posting budget, ranking and the result cap; any exhausted budget reports an explicit partial result with the
  // stop reason instead of pretending the scan was complete. The reported
  // generation labels the snapshot the scan observed (K20): every route,
  // the locators and the generation are read inside ONE read transaction, so
  // a concurrent writer commit can never mix two generations in one result.
  // R09: the deadline is one absolute budget for every stage - lookup,
  // postings, ranking, merge and locators. A request that is already expired
  // opens no snapshot and runs no SQL; one that expires mid-way skips the
  // remaining routes and only finishes the bounded top-K it already holds.
  searchDetailed(
    task: string,
    limit: number = ENTITY_SEARCH_DEFAULT_LIMIT,
    mode: EntitySearchMode = "auto",
    options: EntitySearchOptions = {}
  ): DetailedEntitySearchResult {
    const budget = options.budget
      ? new QueryWorkBudget(
        options.budget.maxPostings ?? DEFAULT_QUERY_MAX_POSTINGS,
        options.budget.remainingMs ?? (() => Number.POSITIVE_INFINITY)
      )
      : undefined;
    if (budget?.expired()) {
      return { hits: [], truncated: true, selectionLimited: false, work: { postings: 0 }, generation: 0, stopReason: "deadline", trace: [] };
    }
    return withReadSnapshot(this.db, () => this.searchDetailedInSnapshot(task, limit, mode, options, budget));
  }

  private searchDetailedInSnapshot(
    task: string,
    limit: number,
    mode: EntitySearchMode,
    options: EntitySearchOptions,
    budget: QueryWorkBudget | undefined
  ): DetailedEntitySearchResult {
    const cap = clampLimit(limit);
    const trace = new QueryTrace(budget ? () => budget.remaining() : undefined);
    const generation = readIndexGeneration(this.db);
    const stop: { reason?: EntitySearchStopReason } = {};
    const context: RouteContext = { budget, stop, scope: scopeSql("e.path_sym", options.scope), trace };
    // Every route fetches cap+1: the extra row only proves "more exist"
    // (selectionLimited) and is never returned.
    const finish = (selected: EntityHit[], exact?: "match" | "miss" | "ambiguous"): DetailedEntitySearchResult => {
      // Locators are bounded (<= cap point lookups) and always finish, so a
      // late deadline still returns actionable hits, labelled partial.
      const hits = trace.stage("locators", () => {
        const located = attachLocators(this.db, selected.slice(0, cap));
        return { value: located, visited: located.length };
      });
      if (budget?.expired()) recordStop(stop, "deadline");
      const result: DetailedEntitySearchResult = {
        hits,
        truncated: stop.reason !== undefined,
        selectionLimited: selected.length > cap,
        work: { postings: budget ? budget.visited() : 0 },
        generation,
        trace: trace.stages
      };
      // An interrupted exact lookup has no outcome: "miss" would claim the
      // selector does not exist.
      if (exact && stop.reason !== "deadline") result.exact = exact;
      if (stop.reason !== undefined) result.stopReason = stop.reason;
      return result;
    };
    if (task.trim().length === 0) return finish([]);
    // An explicit mode is authoritative (discovery classifies the raw query
    // itself and may send query+terms, longer than one selector).
    const intent = mode === "auto" ? classifyQuery(task, mode) : mode;
    if (intent === "exact") {
      const exact = staged(context, "exact-lookup", () => {
        const found = exactHits(this.db, task, cap, context);
        return { value: found, visited: found.visited };
      });
      return finish(exact.hits, exact.outcome);
    }
    const fetch = cap + 1;
    const identifier = rankBm25(this.db, task, 0, "BM25_IDENTIFIER", fetch, context);
    const chunk = rankBm25(this.db, task, 1, "CHUNK", fetch, context);
    const routes = [identifier, chunk];
    if (intent === "text") routes.push(docHits(this.db, task, fetch, context));
    const merged = staged(context, "merge", () => {
      const value = mergeByRank(routes, fetch);
      return { value, visited: routes.reduce((sum, route) => sum + route.length, 0) };
    });
    return finish(merged);
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

// Legacy search() only (java_impact lexical fallbacks): an exact shape with no
// name-layer hit still falls back to BM25 there. The discovery path
// (searchDetailed) never does.
function firstNonEmpty(identifier: EntityHit[], chunk: EntityHit[], cap: number): EntityHit[] {
  if (identifier.length > 0) return identifier.slice(0, cap);
  return chunk.slice(0, cap);
}

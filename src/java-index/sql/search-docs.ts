// input: Search documents for one file (or a deletion) and the writer DB.
// output: search_doc/search_doc_token/search_doc_df kept in the same write
//         transaction as entity rows; docCount/totalLen maintained by the
//         writer in meta so queries never rescan the corpus.
// pos: T05 writer; deletion/rename undoes old documents and old df before the
//      new hash and generation are published.
import type { IndexDatabase } from "./driver.js";
import { prepareCached, withTransaction } from "./driver.js";

function runInWriteTx<T>(db: IndexDatabase, fn: () => T): T {
  if (db.isTransaction) return fn();
  return withTransaction(db, fn);
}
import type { MyBatisBindingFilter, SearchDocument } from "../../discovery/search-document.js";
import { documentTokens } from "../../discovery/search-document.js";
import { internSym, internSymNullable, symId } from "./sym.js";

export const SEARCH_DOC_STATS_KEY = "searchDocStats";
export const SEARCH_DOC_STATS_EMPTY = "0:0";

export function searchDocStats(db: IndexDatabase): { docCount: number; totalLen: number } {
  const row = prepareCached(db, "SELECT value FROM meta WHERE key=?").get(SEARCH_DOC_STATS_KEY) as { value: string } | undefined;
  if (row && typeof row.value === "string") {
    const [count, total] = row.value.split(":");
    const docCount = Number(count);
    const totalLen = Number(total);
    if (Number.isFinite(docCount) && Number.isFinite(totalLen)) {
      return { docCount, totalLen };
    }
  }
  // Legacy or degraded DB without writer-published stats: one-shot scan
  // fallback (same pattern as the entity-field avgLength reader) so the
  // document route degrades to a slower-but-correct read instead of silently
  // disappearing from results.
  const scan = prepareCached(db, "SELECT count(*) AS n, coalesce(sum(token_len), 0) AS t FROM search_doc").get() as
    | { n: number | bigint; t: number | bigint }
    | undefined;
  return { docCount: Number(scan?.n ?? 0), totalLen: Number(scan?.t ?? 0) };
}

/** Publishes writer-maintained docCount/totalLen (one call per change batch). */
export function commitSearchDocStats(db: IndexDatabase): void {
  const docCount = (prepareCached(db, "SELECT count(*) AS n FROM search_doc").get() as { n: number | bigint }).n;
  const totalLen = (prepareCached(db, "SELECT coalesce(sum(token_len), 0) AS n FROM search_doc").get() as { n: number | bigint }).n;
  prepareCached(
    db,
    `INSERT INTO meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(SEARCH_DOC_STATS_KEY, `${Number(docCount)}:${Number(totalLen)}`);
}

function deleteTokensForPath(db: IndexDatabase, pathSym: number): void {
  prepareCached(
    db,
    `DELETE FROM search_doc_token WHERE doc_id IN (SELECT id FROM search_doc WHERE path_sym=?)`
  ).run(pathSym);
  prepareCached(db, "DELETE FROM search_doc WHERE path_sym=?").run(pathSym);
}

function termFrequencies(db: IndexDatabase, doc: SearchDocument): { tokenLen: number; tf: Map<number, number> } {
  const tokens = documentTokens(doc.normalizedText);
  const tf = new Map<number, number>();
  for (const token of tokens) {
    const sym = internSym(db, token);
    tf.set(sym, (tf.get(sym) ?? 0) + 1);
  }
  return { tokenLen: tokens.length, tf };
}

function insertDocuments(db: IndexDatabase, ownerPath: string, documents: readonly SearchDocument[]): void {
  const ownerSym = internSymNullable(db, ownerPath);
  const insertDoc = prepareCached(
    db,
    `INSERT INTO search_doc(declaration_sym, path_sym, source_path_sym, kind, start_line, end_line, token_len)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertToken = prepareCached(db, "INSERT INTO search_doc_token(doc_id, token_sym, tf) VALUES (?, ?, ?)");
  for (const doc of documents) {
    const { tokenLen, tf } = termFrequencies(db, doc);
    // search_doc_identity rejects a duplicate document, as the old sym PK did.
    const docId = Number(insertDoc.run(
      internSym(db, doc.declarationId),
      ownerSym,
      internSym(db, doc.source.relativePath),
      doc.sourceKind,
      doc.source.startLine,
      doc.source.endLine,
      tokenLen
    ).lastInsertRowid);
    for (const [token, count] of tf) insertToken.run(docId, token, count);
  }
}

type StoredDocument = { id: number; declarationSym: number; pathSym: number | null; sourcePathSym: number; kind: string; startLine: number; endLine: number; tokenLen: number };
type WantedDocument = { declarationSym: number; pathSym: number | null; sourcePathSym: number; kind: string; startLine: number; endLine: number; tokenLen: number; tf: Map<number, number> };

const looseKey = (doc: { declarationSym: number; kind: string; sourcePathSym: number }) => `${doc.declarationSym}|${doc.kind}|${doc.sourcePathSym}`;
const identityKey = (doc: { declarationSym: number; kind: string; sourcePathSym: number; startLine: number; endLine: number }) => `${looseKey(doc)}|${doc.startLine}|${doc.endLine}`;

/**
 * Makes the documents selected by `column=key` exactly `wanted`, writing only
 * differences: a document keeps its row (and its postings) when its identity
 * is unchanged, or when its range moved and it is the only document of its
 * declaration, kind and source on both sides. An edit that leaves a
 * document's text alone therefore rewrites none of its postings.
 */
function syncDocuments(db: IndexDatabase, column: "path_sym" | "source_path_sym", key: number, wanted: readonly WantedDocument[]): void {
  const stored = (prepareCached(
    db,
    `SELECT id, declaration_sym AS declarationSym, path_sym AS pathSym, source_path_sym AS sourcePathSym, kind,
       start_line AS startLine, end_line AS endLine, token_len AS tokenLen FROM search_doc WHERE ${column}=?`
  ).all(key) as Array<Record<string, number | string | null>>).map(row => ({
    id: Number(row.id), declarationSym: Number(row.declarationSym), pathSym: row.pathSym == null ? null : Number(row.pathSym),
    sourcePathSym: Number(row.sourcePathSym), kind: String(row.kind), startLine: Number(row.startLine), endLine: Number(row.endLine), tokenLen: Number(row.tokenLen)
  } satisfies StoredDocument));
  const byIdentity = new Map(stored.map(doc => [identityKey(doc), doc]));
  const pairs: Array<[StoredDocument, WantedDocument]> = [];
  const unmatchedWanted: WantedDocument[] = [];
  for (const doc of wanted) {
    const hit = byIdentity.get(identityKey(doc));
    if (hit) {
      byIdentity.delete(identityKey(doc));
      pairs.push([hit, doc]);
    } else {
      unmatchedWanted.push(doc);
    }
  }
  const leftByLoose = new Map<string, StoredDocument[]>();
  for (const doc of byIdentity.values()) leftByLoose.set(looseKey(doc), [...(leftByLoose.get(looseKey(doc)) ?? []), doc]);
  const wantedByLoose = new Map<string, WantedDocument[]>();
  for (const doc of unmatchedWanted) wantedByLoose.set(looseKey(doc), [...(wantedByLoose.get(looseKey(doc)) ?? []), doc]);
  const inserts: WantedDocument[] = [];
  for (const [loose, docs] of wantedByLoose) {
    const left = leftByLoose.get(loose);
    if (docs.length === 1 && left?.length === 1) {
      pairs.push([left[0]!, docs[0]!]);
      leftByLoose.delete(loose);
    } else {
      inserts.push(...docs);
    }
  }
  const deleteTokens = prepareCached(db, "DELETE FROM search_doc_token WHERE doc_id=?");
  const deleteDoc = prepareCached(db, "DELETE FROM search_doc WHERE id=?");
  for (const docs of leftByLoose.values()) {
    for (const doc of docs) {
      deleteTokens.run(doc.id);
      deleteDoc.run(doc.id);
    }
  }
  const readTokens = prepareCached(db, "SELECT token_sym AS token, tf FROM search_doc_token WHERE doc_id=?");
  const insertToken = prepareCached(db, "INSERT INTO search_doc_token(doc_id, token_sym, tf) VALUES (?, ?, ?)");
  const updateToken = prepareCached(db, "UPDATE search_doc_token SET tf=? WHERE doc_id=? AND token_sym=?");
  const deleteToken = prepareCached(db, "DELETE FROM search_doc_token WHERE doc_id=? AND token_sym=?");
  const updateDoc = prepareCached(db, "UPDATE search_doc SET path_sym=?, start_line=?, end_line=?, token_len=? WHERE id=?");
  for (const [old, doc] of pairs) {
    if (old.pathSym !== doc.pathSym || old.startLine !== doc.startLine || old.endLine !== doc.endLine || old.tokenLen !== doc.tokenLen) {
      updateDoc.run(doc.pathSym, doc.startLine, doc.endLine, doc.tokenLen, old.id);
    }
    const previous = new Map((readTokens.all(old.id) as Array<{ token: number; tf: number }>).map(row => [Number(row.token), Number(row.tf)]));
    for (const [token, tf] of doc.tf) {
      const before = previous.get(token);
      if (before === undefined) insertToken.run(old.id, token, tf);
      else if (before !== tf) updateToken.run(tf, old.id, token);
      previous.delete(token);
    }
    for (const token of previous.keys()) deleteToken.run(old.id, token);
  }
  const insertDoc = prepareCached(
    db,
    `INSERT INTO search_doc(declaration_sym, path_sym, source_path_sym, kind, start_line, end_line, token_len)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const doc of inserts) {
    const docId = Number(insertDoc.run(doc.declarationSym, doc.pathSym, doc.sourcePathSym, doc.kind, doc.startLine, doc.endLine, doc.tokenLen).lastInsertRowid);
    for (const [token, tf] of doc.tf) insertToken.run(docId, token, tf);
  }
}

function wantedDocument(db: IndexDatabase, ownerPath: string, doc: SearchDocument): WantedDocument {
  const { tokenLen, tf } = termFrequencies(db, doc);
  return {
    declarationSym: internSym(db, doc.declarationId),
    pathSym: internSymNullable(db, ownerPath),
    sourcePathSym: internSym(db, doc.source.relativePath),
    kind: doc.sourceKind,
    startLine: doc.source.startLine,
    endLine: doc.source.endLine,
    tokenLen,
    tf
  };
}

/** Rebuilds search_doc_df from the current postings (writer-side only). */
export function rebuildSearchDocDf(db: IndexDatabase): void {
  runInWriteTx(db, () => {
    db.exec("DELETE FROM search_doc_df");
    db.exec(
      "INSERT INTO search_doc_df(token_sym, df) SELECT token_sym, count(*) FROM search_doc_token GROUP BY token_sym"
    );
  });
}

/** Only changed posting keys are refreshed; unchanged keys do not dirty DF pages. */
function withDocumentDelta(db: IndexDatabase, column: "path_sym" | "source_path_sym", key: number, write: () => void): void {
  const collect = () => {
    const docs=prepareCached(db,`SELECT id,token_len FROM search_doc WHERE ${column}=?`).all(key) as Array<{id:number;token_len:number}>;
    let total=0;const postings=new Map<number,number>();
    for (const doc of docs) {
      total+=doc.token_len;
      for(const row of prepareCached(db,"SELECT token_sym FROM search_doc_token WHERE doc_id=?").all(doc.id) as Array<{token_sym:number}>) postings.set(row.token_sym,(postings.get(row.token_sym)??0)+1);
    }
    return {count:docs.length,total,postings};
  };
  const stats=searchDocStats(db); const before=collect();write();const after=collect();
  for(const token of new Set([...before.postings.keys(),...after.postings.keys()])) {
    const old=before.postings.get(token)??0;
    const delta=(after.postings.get(token)??0)-old;
    if(delta===0) continue;
    const row=prepareCached(db,"SELECT df FROM search_doc_df WHERE token_sym=?").get(token) as {df:number}|undefined;
    const previous=row?.df??0;const df=previous+delta;
    if(!Number.isSafeInteger(df) || previous<old || df<0) throw new Error("inconsistent search document posting DF");
    if(df===0) prepareCached(db,"DELETE FROM search_doc_df WHERE token_sym=?").run(token);
    else prepareCached(db,"INSERT INTO search_doc_df(token_sym,df) VALUES (?,?) ON CONFLICT(token_sym) DO UPDATE SET df=excluded.df").run(token,df);
  }
  const value=`${stats.docCount+after.count-before.count}:${stats.totalLen+after.total-before.total}`;
  prepareCached(db,"INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value").run(SEARCH_DOC_STATS_KEY,value);
}

/**
 * Replaces every document owned by one Java file path (its own Java-sourced
 * documents and the XML-sourced documents that target its declarations). The
 * path key doubles as the undo handle: a rename or content change deletes the
 * old hash's documents before the new ones publish, so queries never see both.
 */
export function replaceSearchDocuments(db: IndexDatabase, relativePath: string, documents: readonly SearchDocument[], bulk = false): void {
  runInWriteTx(db, () => {
    const key=internSym(db,relativePath);
    if(bulk) {deleteTokensForPath(db,key);insertDocuments(db,relativePath,documents);return;}
    withDocumentDelta(db,"path_sym",key,()=>syncDocuments(db,"path_sym",key,documents.map(doc=>wantedDocument(db,relativePath,doc))));
  });
}

/**
 * R08: replaces every document whose evidence SOURCE is one (resource) file,
 * e.g. a mapper XML edited while the Java mapper is unchanged. Each document
 * keeps its owning Java file so a later Java rewrite still undoes it.
 */
export function replaceSearchDocumentsForSource(
  db: IndexDatabase,
  sourcePath: string,
  documents: ReadonlyArray<{ ownerPath: string; document: SearchDocument }>
): void {
  runInWriteTx(db, () => {
    for (const { document } of documents) {
      if (document.source.relativePath !== sourcePath) {
        throw new Error(`document ${document.documentId} is not sourced from ${sourcePath}`);
      }
    }
    const key=internSym(db,sourcePath);
    withDocumentDelta(db,"source_path_sym",key,()=>syncDocuments(db,"source_path_sym",key,documents.map(({ownerPath,document})=>wantedDocument(db,ownerPath,document))));
  });
}

/** Module directory of a repo-relative path: everything before `src/`. */
function moduleDirOf(relativePath: string): string {
  const parts = relativePath.split("/");
  const src = parts.indexOf("src");
  return src <= 0 ? "." : parts.slice(0, src).join("/");
}

/**
 * Module visibility for mapper XML (same rule as R05 for duplicate FQNs): when
 * the XML's own module declares its namespace type, it binds only there; with
 * no same-module declaration it binds to every declaration (a cross-module
 * mapper interface is legitimate). Memoized per namespace for one batch.
 */
export function myBatisBindingFilter(db: IndexDatabase): MyBatisBindingFilter {
  const declaringModules = new Map<string, Set<string>>();
  return (resource, bundle) => {
    let modules = declaringModules.get(resource.namespace);
    if (!modules) {
      const rows = prepareCached(
        db,
        "SELECT f.path AS path FROM type t JOIN file f ON f.id=t.file_id WHERE t.fqn=?"
      ).all(resource.namespace) as Array<{ path: string }>;
      modules = new Set(rows.map(row => moduleDirOf(row.path)));
      declaringModules.set(resource.namespace, modules);
    }
    const xmlModule = moduleDirOf(resource.relativePath);
    return !modules.has(xmlModule) || moduleDirOf(bundle.file.relativePath) === xmlModule;
  };
}

export function deleteSearchDocumentsForPath(db: IndexDatabase, relativePath: string): void {
  runInWriteTx(db, () => {
    const pathSym = symId(db, relativePath);
    if (pathSym === undefined) return;
    withDocumentDelta(db,"path_sym",pathSym,()=>deleteTokensForPath(db,pathSym));
  });
}
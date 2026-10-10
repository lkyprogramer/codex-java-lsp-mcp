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
import { internSym, internSymNullable } from "./sym.js";

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
    `DELETE FROM search_doc_token WHERE doc_sym IN (SELECT sym FROM search_doc WHERE path_sym=?)`
  ).run(pathSym);
  prepareCached(db, "DELETE FROM search_doc WHERE path_sym=?").run(pathSym);
}

function deleteTokensForSource(db: IndexDatabase, sourcePathSym: number): void {
  prepareCached(
    db,
    `DELETE FROM search_doc_token WHERE doc_sym IN (SELECT sym FROM search_doc WHERE source_path_sym=?)`
  ).run(sourcePathSym);
  prepareCached(db, "DELETE FROM search_doc WHERE source_path_sym=?").run(sourcePathSym);
}

function insertDocuments(db: IndexDatabase, ownerPath: string, documents: readonly SearchDocument[]): void {
  const ownerSym = internSymNullable(db, ownerPath);
  const insertDoc = prepareCached(
    db,
    `INSERT INTO search_doc(sym, declaration_sym, path_sym, source_path_sym, content_hash, kind, start_line, end_line, token_len)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertToken = prepareCached(db, "INSERT INTO search_doc_token(doc_sym, token_sym, tf) VALUES (?, ?, ?)");
  for (const doc of documents) {
    const docSym = internSym(db, doc.documentId);
    const tokens = documentTokens(doc.normalizedText);
    insertDoc.run(
      docSym,
      internSym(db, doc.declarationId),
      ownerSym,
      internSym(db, doc.source.relativePath),
      doc.source.contentHash,
      doc.sourceKind,
      doc.source.startLine,
      doc.source.endLine,
      tokens.length
    );
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const [token, count] of tf) insertToken.run(docSym, internSym(db, token), count);
  }
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

/**
 * Replaces every document owned by one Java file path (its own Java-sourced
 * documents and the XML-sourced documents that target its declarations). The
 * path key doubles as the undo handle: a rename or content change deletes the
 * old hash's documents before the new ones publish, so queries never see both.
 */
export function replaceSearchDocuments(db: IndexDatabase, relativePath: string, documents: readonly SearchDocument[]): void {
  runInWriteTx(db, () => {
    deleteTokensForPath(db, internSym(db, relativePath));
    insertDocuments(db, relativePath, documents);
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
    deleteTokensForSource(db, internSym(db, sourcePath));
    for (const { ownerPath, document } of documents) {
      if (document.source.relativePath !== sourcePath) {
        throw new Error(`document ${document.documentId} is not sourced from ${sourcePath}`);
      }
      insertDocuments(db, ownerPath, [document]);
    }
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
    const row = prepareCached(db, "SELECT id FROM sym WHERE text=?").get(relativePath) as { id: number | bigint } | undefined;
    if (!row) return;
    deleteTokensForPath(db, Number(row.id));
    commitSearchDocStats(db);
  });
}
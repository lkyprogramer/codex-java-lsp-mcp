import { STABLE_ID_VERSION } from "../stable-id.js";
import { JAVA_FACTS_REVISION } from "../build-fingerprint.js";
import { forgetPrepared, prepareCached, type IndexDatabase } from "./driver.js";

// v5: source-linked search documents (T05). v6 (R08): search documents carry
// their evidence source path separately from the owning Java file. Bumping
// this version drops and rebuilds derived DBs; sibling copies are only reused
// when their recorded schema+identity versions match exactly. v7 (R05 review):
// type_ref_name lets an incremental refresh find the files whose type
// references a declaration change can re-resolve (ambiguous refs have no edge).
// v8 added search_doc_text (ordered document text) for the dense experiment;
// v9 drops it with the experiment (no product reader). v10 (MAC-04): sym rows
// are found by a 16-byte hash and confirmed by text (no long TEXT UNIQUE
// index), and file/resource stat and the repo root left the facts database
// for the per-workspace stat store (workspace-stat.ts). v11 (MAC-04 review):
// search documents got a surrogate id so their per-edit identity is no longer
// interned into sym.
// v12: declaration signatures are captured with AST bytes; old facts must rebuild.
// v13 (MAC-05): graph ownership is a relation (kg_node_owner/kg_edge_owner), so
// a shared node or edge lives while any owner does; the meta owner maps,
// kg_edge.file_sym and kg_summary (no product reader, derivable from kg_edge)
// are gone; search_doc identity no longer names the source hash, which
// evidence reads from the source row.
export const SCHEMA_VERSION = 13;

export const INDEX_SCHEMA_SQL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sym(id INTEGER PRIMARY KEY, hash BLOB NOT NULL CHECK(length(hash)=16), text TEXT NOT NULL);
CREATE INDEX sym_hash ON sym(hash);
CREATE TABLE file(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL, size INTEGER,
  source_root TEXT, module TEXT, package TEXT, parse_state TEXT, generation INTEGER NOT NULL, facts BLOB NOT NULL);
CREATE INDEX file_content_hash ON file(content_hash);
CREATE INDEX file_source_root ON file(source_root);
CREATE TABLE type(sym INTEGER PRIMARY KEY REFERENCES sym(id), file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  fqn TEXT, simple_name TEXT NOT NULL, kind TEXT NOT NULL, owner_sym INTEGER, facts BLOB NOT NULL);
CREATE INDEX type_fqn ON type(fqn);
CREATE INDEX type_simple ON type(simple_name);
CREATE INDEX type_file ON type(file_id);
CREATE INDEX type_owner_simple ON type(owner_sym, simple_name);
CREATE TABLE field(sym INTEGER PRIMARY KEY REFERENCES sym(id), owner_sym INTEGER NOT NULL, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  name TEXT NOT NULL, facts BLOB NOT NULL);
CREATE INDEX field_owner ON field(owner_sym);
CREATE INDEX field_file ON field(file_id);
CREATE TABLE method(sym INTEGER PRIMARY KEY REFERENCES sym(id), owner_sym INTEGER NOT NULL, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  name TEXT NOT NULL, is_ctor INTEGER NOT NULL, arity INTEGER NOT NULL, facts BLOB NOT NULL);
CREATE INDEX method_owner_name ON method(owner_sym, name);
CREATE INDEX method_file ON method(file_id);
CREATE TABLE edge(id INTEGER PRIMARY KEY, kind_sym INTEGER NOT NULL, from_sym INTEGER NOT NULL, to_sym INTEGER NOT NULL,
  file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  sl INTEGER NOT NULL, sc INTEGER NOT NULL, el INTEGER NOT NULL, ec INTEGER NOT NULL,
  confidence REAL NOT NULL, res_kind_sym INTEGER NOT NULL, res_strategy_sym INTEGER, generation INTEGER NOT NULL,
  UNIQUE(kind_sym, from_sym, to_sym, sl, sc, el, ec));
CREATE INDEX edge_from_kind ON edge(from_sym, kind_sym);
CREATE INDEX edge_to_kind ON edge(to_sym, kind_sym);
CREATE INDEX edge_file ON edge(file_id);
-- Every identifier a file uses in a type position (type refs, imports, call
-- receivers, annotations), case-sensitive and interned: a superset of the names
-- whose declarations can change how this file resolves.
CREATE TABLE type_ref_name(name_sym INTEGER NOT NULL, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  PRIMARY KEY(name_sym, file_id)) WITHOUT ROWID;
CREATE INDEX type_ref_name_file ON type_ref_name(file_id);
-- Every resource XML the builder has looked at (mapper or not) with its
-- content hash; with a matching workspace stat row reconcile skips it.
CREATE TABLE resource_scan(path TEXT PRIMARY KEY, content_hash TEXT NOT NULL);
CREATE TABLE mybatis_resource(path TEXT PRIMARY KEY, namespace TEXT, content_hash TEXT, facts BLOB NOT NULL);
CREATE INDEX mybatis_ns ON mybatis_resource(namespace);
CREATE TABLE source_root_coverage(root TEXT PRIMARY KEY, state TEXT NOT NULL, generation INTEGER NOT NULL);
CREATE TABLE kg_node(sym INTEGER PRIMARY KEY REFERENCES sym(id), kind_sym INTEGER NOT NULL, path_sym INTEGER, simple_name TEXT,
  jid_sym INTEGER, generation INTEGER NOT NULL);
CREATE INDEX kg_node_path ON kg_node(path_sym);
CREATE INDEX kg_node_jid ON kg_node(jid_sym);
-- Graph ownership: the Java file whose build produced a row. A row shared by
-- several files (a CALLED_BY reverse, a module node, a bound mapper XML) has
-- one owner row per file and is deleted with its last owner. Only the
-- repository root has no owner and is never deleted.
CREATE TABLE kg_node_owner(node_sym INTEGER NOT NULL REFERENCES kg_node(sym) ON DELETE CASCADE, owner_sym INTEGER NOT NULL,
  PRIMARY KEY(node_sym, owner_sym)) WITHOUT ROWID;
CREATE INDEX kg_node_owner_by_owner ON kg_node_owner(owner_sym);
CREATE TABLE kg_edge(id INTEGER PRIMARY KEY, from_sym INTEGER NOT NULL, to_sym INTEGER NOT NULL, kind_sym INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  generation INTEGER NOT NULL);
CREATE UNIQUE INDEX kg_edge_identity ON kg_edge(from_sym, kind_sym, to_sym, ordinal);
CREATE INDEX kg_edge_to ON kg_edge(to_sym, kind_sym);
CREATE TABLE kg_edge_owner(edge_id INTEGER NOT NULL REFERENCES kg_edge(id) ON DELETE CASCADE, owner_sym INTEGER NOT NULL,
  PRIMARY KEY(edge_id, owner_sym)) WITHOUT ROWID;
CREATE INDEX kg_edge_owner_by_owner ON kg_edge_owner(owner_sym);
CREATE TABLE entity(sym INTEGER PRIMARY KEY REFERENCES sym(id), kind TEXT NOT NULL, fqn TEXT NOT NULL, simple_name TEXT NOT NULL, simple_name_lc TEXT NOT NULL,
  path_sym INTEGER, owner_sym INTEGER, ident_len INTEGER NOT NULL, chunk_len INTEGER NOT NULL);
CREATE INDEX entity_fqn ON entity(fqn);
CREATE INDEX entity_simple ON entity(simple_name_lc);
CREATE INDEX entity_owner ON entity(owner_sym);
CREATE TABLE entity_token(entity_sym INTEGER NOT NULL REFERENCES entity(sym) ON DELETE CASCADE, field INTEGER NOT NULL, token_sym INTEGER NOT NULL, tf INTEGER NOT NULL,
  PRIMARY KEY(entity_sym, field, token_sym)) WITHOUT ROWID;
CREATE INDEX entity_token_lookup ON entity_token(field, token_sym);
CREATE TABLE entity_df(field INTEGER NOT NULL, token_sym INTEGER NOT NULL, df INTEGER NOT NULL, PRIMARY KEY(field, token_sym)) WITHOUT ROWID;
-- Source-linked search documents (T05). Documents, postings and df are written
-- in the same file-update transaction as entity rows; queries read writer-
-- maintained stats and never rescan the corpus. path_sym is the owning Java
-- file (the target declaration's file, the undo handle of a Java rewrite);
-- source_path_sym/content_hash/start_line/end_line are the evidence source
-- (R08: a MyBatis statement's source is its XML file). id is a surrogate: the
-- document identity (target, kind, source range) changes with edits, so it is
-- enforced by search_doc_identity instead of being interned into sym, where
-- each edit would leak a dictionary row (MAC-04). The evidence hash is the
-- source row's (file or mybatis_resource) content_hash, written in the same
-- transaction; a copy here would rewrite every document of an edited file.
CREATE TABLE search_doc(id INTEGER PRIMARY KEY, declaration_sym INTEGER NOT NULL,
  path_sym INTEGER, source_path_sym INTEGER NOT NULL, kind TEXT NOT NULL,
  start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, token_len INTEGER NOT NULL);
CREATE UNIQUE INDEX search_doc_identity ON search_doc(declaration_sym, kind, source_path_sym, start_line, end_line);
CREATE INDEX search_doc_path ON search_doc(path_sym);
CREATE INDEX search_doc_source_path ON search_doc(source_path_sym);
CREATE TABLE search_doc_token(doc_id INTEGER NOT NULL REFERENCES search_doc(id) ON DELETE CASCADE,
  token_sym INTEGER NOT NULL, tf INTEGER NOT NULL,
  PRIMARY KEY(doc_id, token_sym)) WITHOUT ROWID;
CREATE INDEX search_doc_token_lookup ON search_doc_token(token_sym);
CREATE TABLE search_doc_df(token_sym INTEGER NOT NULL, df INTEGER NOT NULL, PRIMARY KEY(token_sym)) WITHOUT ROWID;
`;

function quoteIdent(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

function dropAllTables(db: IndexDatabase): void {
  db.exec("PRAGMA foreign_keys=OFF");
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all() as Array<{ name: string }>;
  for (const table of tables) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdent(table.name)}`);
  }
  db.exec("PRAGMA foreign_keys=ON");
}

export function ensureSchema(db: IndexDatabase): void {
  if (schemaVersionsMatch(db)) return;
  dropAllTables(db);
  forgetPrepared(db);
  db.exec(INDEX_SCHEMA_SQL);
  db.prepare("INSERT INTO meta(key, value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION));
  db.prepare("INSERT INTO meta(key, value) VALUES ('identityVersion', ?)").run(String(STABLE_ID_VERSION));
  db.prepare("INSERT INTO meta(key, value) VALUES ('factsRevision', ?)").run(String(JAVA_FACTS_REVISION));
  db.prepare("INSERT INTO meta(key, value) VALUES ('factsEncoding', 'deflate-raw')").run();
}

// True when this database was written by the current schema+identity pair
// and the current facts revision (resolution semantics: a revision bump means
// stored refs/edges were computed by other rules).
// Sibling-seed copies must pass this check before reuse; anything else is
// dropped and rebuilt rather than silently mixing old and new identities.
export function schemaVersionsMatch(db: IndexDatabase): boolean {
  const table = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='meta'"
  ).get();
  if (!table) return false;
  const schema = prepareCached(db, "SELECT value FROM meta WHERE key='schemaVersion'").get() as
    | { value: string }
    | undefined;
  if (!schema) return false;
  if (Number(schema.value) !== SCHEMA_VERSION) return false;
  const identity = prepareCached(db, "SELECT value FROM meta WHERE key='identityVersion'").get() as
    | { value: string }
    | undefined;
  if (!identity || Number(identity.value) !== STABLE_ID_VERSION) return false;
  const facts = prepareCached(db, "SELECT value FROM meta WHERE key='factsRevision'").get() as
    | { value: string }
    | undefined;
  return !!facts && Number(facts.value) === JAVA_FACTS_REVISION;
}

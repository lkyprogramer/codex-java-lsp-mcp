import { forgetPrepared, prepareCached, type IndexDatabase } from "./driver.js";

export const SCHEMA_VERSION = 2;

export const INDEX_SCHEMA_SQL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE file(id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, content_hash TEXT NOT NULL, size INTEGER, mtime_ms REAL,
  ctime_ms REAL, source_root TEXT, module TEXT, package TEXT, parse_state TEXT, generation INTEGER NOT NULL, facts BLOB NOT NULL);
CREATE INDEX file_content_hash ON file(content_hash);
CREATE INDEX file_source_root ON file(source_root);
CREATE TABLE type(id INTEGER PRIMARY KEY, type_id TEXT NOT NULL UNIQUE, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  fqn TEXT, simple_name TEXT NOT NULL, kind TEXT NOT NULL, owner_type_id TEXT, facts BLOB NOT NULL);
CREATE INDEX type_fqn ON type(fqn);
CREATE INDEX type_simple ON type(simple_name);
CREATE INDEX type_file ON type(file_id);
CREATE INDEX type_owner_simple ON type(owner_type_id, simple_name);
CREATE TABLE field(id INTEGER PRIMARY KEY, field_id TEXT NOT NULL UNIQUE, owner_type_id TEXT NOT NULL, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  name TEXT NOT NULL, facts BLOB NOT NULL);
CREATE INDEX field_owner ON field(owner_type_id);
CREATE INDEX field_file ON field(file_id);
CREATE TABLE method(id INTEGER PRIMARY KEY, method_id TEXT NOT NULL UNIQUE, owner_type_id TEXT NOT NULL, file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE,
  name TEXT NOT NULL, is_ctor INTEGER NOT NULL, arity INTEGER NOT NULL, facts BLOB NOT NULL);
CREATE INDEX method_owner_name ON method(owner_type_id, name);
CREATE INDEX method_file ON method(file_id);
CREATE TABLE edge(id INTEGER PRIMARY KEY, edge_id TEXT NOT NULL UNIQUE, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
  source_file_id INTEGER NOT NULL REFERENCES file(id) ON DELETE CASCADE, facts BLOB NOT NULL);
CREATE INDEX edge_from_kind ON edge(from_id, kind);
CREATE INDEX edge_to_kind ON edge(to_id, kind);
CREATE INDEX edge_file ON edge(source_file_id);
CREATE TABLE mybatis_resource(path TEXT PRIMARY KEY, namespace TEXT, content_hash TEXT, facts BLOB NOT NULL);
CREATE INDEX mybatis_ns ON mybatis_resource(namespace);
CREATE TABLE source_root_coverage(root TEXT PRIMARY KEY, state TEXT NOT NULL, generation INTEGER NOT NULL);
CREATE TABLE kg_node(id TEXT PRIMARY KEY, kind TEXT NOT NULL, relative_path TEXT, java_index_id TEXT, owner_file TEXT, facts BLOB NOT NULL);
CREATE INDEX kg_node_path ON kg_node(relative_path);
CREATE INDEX kg_node_jid ON kg_node(java_index_id);
CREATE INDEX kg_node_owner ON kg_node(owner_file);
CREATE TABLE kg_edge(id INTEGER PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL, owner_file TEXT, facts BLOB NOT NULL);
CREATE INDEX kg_edge_from ON kg_edge(from_id, kind);
CREATE INDEX kg_edge_to ON kg_edge(to_id, kind);
CREATE INDEX kg_edge_owner ON kg_edge(owner_file);
CREATE TABLE kg_summary(method_id TEXT PRIMARY KEY, facts BLOB NOT NULL);
CREATE TABLE entity(entity_id TEXT PRIMARY KEY, kind TEXT NOT NULL, fqn TEXT NOT NULL, simple_name_lc TEXT, relative_path TEXT, owner_file TEXT,
  ident_len INTEGER NOT NULL, chunk_len INTEGER NOT NULL, facts BLOB NOT NULL);
CREATE INDEX entity_fqn ON entity(fqn);
CREATE INDEX entity_simple ON entity(simple_name_lc);
CREATE INDEX entity_owner ON entity(owner_file);
CREATE TABLE entity_token(entity_id TEXT NOT NULL REFERENCES entity(entity_id) ON DELETE CASCADE, field TEXT NOT NULL, token TEXT NOT NULL, tf INTEGER NOT NULL,
  PRIMARY KEY(entity_id, field, token)) WITHOUT ROWID;
CREATE INDEX entity_token_lookup ON entity_token(field, token);
CREATE TABLE entity_df(field TEXT NOT NULL, token TEXT NOT NULL, df INTEGER NOT NULL, PRIMARY KEY(field, token)) WITHOUT ROWID;
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

function currentSchemaVersion(db: IndexDatabase): number | undefined {
  const table = db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='meta'"
  ).get();
  if (!table) return undefined;
  const row = prepareCached(db, "SELECT value FROM meta WHERE key='schemaVersion'").get() as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  const parsed = Number(row.value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function ensureSchema(db: IndexDatabase): void {
  if (currentSchemaVersion(db) === SCHEMA_VERSION) return;
  dropAllTables(db);
  forgetPrepared(db);
  db.exec(INDEX_SCHEMA_SQL);
  db.prepare("INSERT INTO meta(key, value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION));
  db.prepare("INSERT INTO meta(key, value) VALUES ('factsEncoding', 'deflate-raw')").run();
}

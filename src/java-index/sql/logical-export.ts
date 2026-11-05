import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import type { IndexDatabase } from "./driver.js";
import { decodeFacts } from "./rows.js";

// Logical truth of a facts database: what two snapshots must agree on when
// they index the same sources, whatever rowids, sym ids, deflate bytes or
// insertion order each one happened to produce. Sym and file references are
// exported as their text/path, facts BLOBs as canonical JSON. Excluded:
//   - the sym dictionary itself (an encoding; unreferenced entries are garbage),
//   - INTEGER PRIMARY KEY `id` surrogates (a reference to one, such as
//     search_doc_token.doc_id or kg_edge_owner.edge_id, is exported as the
//     referenced row's identity),
//   - `generation` columns and facts fields (a publication counter, not a fact),
//   - meta other than the format versions (progress, publication state and
//     stats derivable from the exported rows).
export const LOGICAL_EXPORT_VERSION = "ilv2-logical-export/v1";
const LOGICAL_META_KEYS = ["schemaVersion", "identityVersion", "factsRevision"] as const;
const SKIPPED_TABLES = new Set(["sym", "meta"]);
const MOD = 1n << 256n;

type Column = { name: string; type: string; pk: number };
type ColumnPlan = { name: string; select: string; join?: string; orphan?: string; facts?: boolean };
type TablePlan = { table: string; columns: string[]; sql: string; references: Array<{ column: string; table: string }>; unsafeIntegerSql?: string; facts: boolean[] };

export type LogicalTableDigest = { rows: number; digest: string };
export type LogicalDigest = { version: typeof LOGICAL_EXPORT_VERSION; digest: string; tables: Record<string, LogicalTableDigest> };
export type LogicalExport = { version: typeof LOGICAL_EXPORT_VERSION; tables: Record<string, { columns: string[]; rows: string[] }> };

function quote(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

function isSymColumn(name: string): boolean {
  return name === "sym" || name.endsWith("_sym");
}

// A surrogate-id reference is exported as the referenced row's logical
// identity (the columns of its unique key), resolved through text.
type IdReference = { name: string; table: string; identity: string; join: (ref: string) => string; missing: string };
const ID_REFERENCES: Record<string, IdReference> = {
  "search_doc_token.doc_id": {
    name: "doc",
    table: "search_doc",
    identity: "json_array(d_decl.text, d_ref.kind, d_src.text, d_ref.start_line, d_ref.end_line)",
    join: ref => `LEFT JOIN main.search_doc d_ref ON d_ref.id=${ref} LEFT JOIN main.sym d_decl ON d_decl.id=d_ref.declaration_sym LEFT JOIN main.sym d_src ON d_src.id=d_ref.source_path_sym`,
    missing: "d_ref.id IS NULL OR d_decl.id IS NULL OR d_src.id IS NULL"
  },
  "kg_edge_owner.edge_id": {
    name: "edge",
    table: "kg_edge",
    identity: "json_array(e_from.text, e_kind.text, e_to.text, e_ref.ordinal)",
    join: ref => `LEFT JOIN main.kg_edge e_ref ON e_ref.id=${ref} LEFT JOIN main.sym e_from ON e_from.id=e_ref.from_sym LEFT JOIN main.sym e_kind ON e_kind.id=e_ref.kind_sym LEFT JOIN main.sym e_to ON e_to.id=e_ref.to_sym`,
    missing: "e_ref.id IS NULL OR e_from.id IS NULL OR e_kind.id IS NULL OR e_to.id IS NULL"
  }
};

export function logicalTableNames(db: IndexDatabase): string[] {
  return (db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map(row => row.name)
    .filter(name => !SKIPPED_TABLES.has(name));
}

function planTable(db: IndexDatabase, table: string): TablePlan {
  const columns = db.prepare(`PRAGMA main.table_info(${quote(table)})`).all() as Column[];
  const plans: ColumnPlan[] = [];
  const scalars: string[] = [];
  const references: TablePlan["references"] = [];
  for (const column of columns) {
    if (column.name === "generation") continue;
    if (column.name === "id" && column.pk === 1 && column.type.toUpperCase() === "INTEGER") continue;
    const ref = `t.${quote(column.name)}`;
    if (isSymColumn(column.name)) {
      references.push({ column: column.name, table: "sym" });
      const alias = quote(`s_${column.name}`);
      plans.push({ name: column.name, select: `${alias}.text`, join: `LEFT JOIN main.sym ${alias} ON ${alias}.id=${ref}`, orphan: `(${ref} IS NOT NULL AND ${alias}.id IS NULL)` });
    } else if (ID_REFERENCES[`${table}.${column.name}`]) {
      const target = ID_REFERENCES[`${table}.${column.name}`]!;
      references.push({ column: column.name, table: target.table });
      plans.push({ name: target.name, select: target.identity, join: target.join(ref), orphan: `(${ref} IS NOT NULL AND (${target.missing}))` });
    } else if (column.name.endsWith("_id") && column.name !== "file_id") {
      // An unplanned surrogate reference would export a rowid, which differs between equal snapshots.
      throw new Error(`no logical plan for ${table}.${column.name}`);
    } else if (column.name === "file_id") {
      references.push({ column: column.name, table: "file" });
      plans.push({ name: "file", select: "f_ref.path", join: `LEFT JOIN main.file f_ref ON f_ref.id=${ref}`, orphan: `(${ref} IS NOT NULL AND f_ref.id IS NULL)` });
    } else {
      plans.push({ name: column.name, select: ref, facts: column.name === "facts" });
      if (column.name !== "facts") scalars.push(ref);
    }
  }
  const orphan = plans.flatMap(plan => plan.orphan ? [plan.orphan] : []).join(" OR ") || "0";
  const from = `FROM main.${quote(table)} t ${plans.flatMap(plan => plan.join ? [plan.join] : []).join(" ")}`;
  const sql = `SELECT ${[...plans.map((plan, index) => `${plan.select} AS c${index}`), `(${orphan}) AS orphan`].join(", ")} ${from}`;
  // node:sqlite rejects INTEGER outputs outside the safe Number range. The
  // validation query must keep that guard even though it no longer fetches rows.
  const unsafe = scalars.map(ref => `(typeof(${ref})='integer' AND (${ref} < -9007199254740991 OR ${ref} > 9007199254740991))`).join(" OR ");
  return { table, columns: plans.map(plan => plan.name), sql, references,
    unsafeIntegerSql: unsafe ? `SELECT 1 FROM main.${quote(table)} t WHERE (${unsafe})` : undefined,
    facts: plans.map(plan => plan.facts === true) };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (key === "generation" && typeof item === "number") continue;
      out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

function cell(value: SQLOutputValue, facts: boolean): unknown {
  if (facts) return canonical(decodeFacts<unknown>(value));
  if (value instanceof Uint8Array) return { hex: Buffer.from(value).toString("hex") };
  if (typeof value === "bigint") return value.toString();
  return value;
}

function* tableRows(db: IndexDatabase, plan: TablePlan): Generator<string> {
  for (const row of db.prepare(plan.sql).iterate() as Iterable<Record<string, SQLOutputValue>>) {
    if (row.orphan) throw new Error(`orphan reference in ${plan.table}: ${JSON.stringify(row, (_key, value) => typeof value === "bigint" ? value.toString() : value)}`);
    yield JSON.stringify(plan.columns.map((_name, index) => cell(row[`c${index}`]!, plan.facts[index]!)));
  }
}

function metaRows(db: IndexDatabase): string[] {
  const stmt = db.prepare("SELECT value FROM main.meta WHERE key=?");
  return LOGICAL_META_KEYS.map(key => JSON.stringify([key, (stmt.get(key) as { value?: string } | undefined)?.value ?? null]));
}

/** Seal checks without serializing and hashing every logical row. The offline
 * full/delta oracle still uses logicalDigest; neither operation replaces SQLite
 * integrity/foreign-key or the build census checks. */
export function validateLogicalData(db: IndexDatabase): void {
  for (const table of logicalTableNames(db)) validateLogicalTable(db, table);
}

/**
 * The seal verifier assigns every logical table exactly once across workers. `where`, a
 * predicate over alias `t`, limits the check to those rows (the pre-publish delta check).
 */
export function validateLogicalTable(db: IndexDatabase, table: string, where?: string): void {
  const plan = planTable(db, table);
  const scope = where ? ` AND (${where})` : "";
  if (plan.unsafeIntegerSql && db.prepare(`${plan.unsafeIntegerSql}${scope} LIMIT 1`).get()) throw new Error(`unsafe integer in ${table}`);
  // Check each referenced id once, rather than repeating its parent/sym joins
  // for every posting. Every parent table is checked in this same full pass.
  for (const reference of plan.references) {
    const column = quote(reference.column);
    const missing = db.prepare(`SELECT 1 FROM (SELECT DISTINCT t.${column} AS refId FROM main.${quote(table)} t
      WHERE t.${column} IS NOT NULL${scope}) refs
      WHERE NOT EXISTS (SELECT 1 FROM main.${quote(reference.table)} r WHERE r.id=refs.refId) LIMIT 1`).get();
    if (missing) throw new Error(`orphan reference in ${table}.${reference.column}`);
  }
  const facts = plan.columns.filter((_name, index) => plan.facts[index]);
  if (facts.length) {
    for (const row of db.prepare(`SELECT ${facts.map(name => `t.${quote(name)} AS ${quote(name)}`).join(", ")} FROM main.${quote(table)} t WHERE 1${scope}`).iterate()) {
      for (const name of facts) decodeFacts(row[name]!);
    }
  }
}

/** Sorted logical rows per table; for tests and small diffs (holds every row in memory). */
export function exportLogical(db: IndexDatabase): LogicalExport {
  const tables: LogicalExport["tables"] = { meta: { columns: ["key", "value"], rows: metaRows(db) } };
  for (const table of logicalTableNames(db)) {
    const plan = planTable(db, table);
    tables[table] = { columns: plan.columns, rows: [...tableRows(db, plan)].sort() };
  }
  return { version: LOGICAL_EXPORT_VERSION, tables };
}

/**
 * Order-independent digest in constant memory: each table is the multiset
 * sum (mod 2^256) of its row hashes, so rows may arrive in any order.
 */
export function logicalDigest(db: IndexDatabase): LogicalDigest {
  const tables: Record<string, LogicalTableDigest> = {};
  const add = (name: string, rows: Iterable<string>) => {
    let sum = 0n;
    let count = 0;
    for (const row of rows) {
      sum = (sum + BigInt(`0x${createHash("sha256").update(row, "utf8").digest("hex")}`)) % MOD;
      count += 1;
    }
    tables[name] = { rows: count, digest: sum.toString(16).padStart(64, "0") };
  };
  add("meta", metaRows(db));
  for (const table of logicalTableNames(db)) add(table, tableRows(db, planTable(db, table)));
  const digest = createHash("sha256").update(JSON.stringify([LOGICAL_EXPORT_VERSION, Object.entries(tables).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
  return { version: LOGICAL_EXPORT_VERSION, digest, tables };
}

/** Tables whose logical rows differ, with a bounded sample of rows on each side. */
export function diffLogical(left: LogicalExport, right: LogicalExport, sample = 5): Array<{ table: string; onlyLeft: string[]; onlyRight: string[] }> {
  const out: Array<{ table: string; onlyLeft: string[]; onlyRight: string[] }> = [];
  for (const table of [...new Set([...Object.keys(left.tables), ...Object.keys(right.tables)])].sort()) {
    // Multiset difference: a row present twice on one side and once on the other is reported.
    const counts = new Map<string, number>();
    for (const row of left.tables[table]?.rows ?? []) counts.set(row, (counts.get(row) ?? 0) + 1);
    for (const row of right.tables[table]?.rows ?? []) counts.set(row, (counts.get(row) ?? 0) - 1);
    const onlyLeft = [...counts].filter(([, n]) => n > 0).map(([row]) => row);
    const onlyRight = [...counts].filter(([, n]) => n < 0).map(([row]) => row);
    if (onlyLeft.length || onlyRight.length) out.push({ table, onlyLeft: onlyLeft.slice(0, sample), onlyRight: onlyRight.slice(0, sample) });
  }
  return out;
}

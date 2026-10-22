// input: one checkpoint, read-only verification batch, plan, manifest or delta-seal step.
// output: the step's result posted to the parent, or { error }.
// pos: contract §2.7 publish order, off the owner's event loop. A full integrity check of a real
//      repository's database runs for tens of seconds; on the owner thread it stalled every request,
//      builder result and scheduler timer for that long (MAC-11 G11 evidence). Steps run in order,
//      each on its own connection, so "checkpoint / close every writer" still precedes the checks.
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { compatibleDeltaBase } from "../../index-builder/execution-plan.js";
import { buildSnapshotManifest } from "../sql/snapshot-manifest.js";
import { logicalTableNames, validateLogicalTable } from "../sql/logical-export.js";
import { symId } from "../sql/sym.js";

export type VerificationTable = { name: string; logical: boolean; weight: number };
export type VerificationTask = { kind: "global" } | { kind: "common" } | { kind: "table"; table: string; logical: boolean };
export type VerificationPlan = { tables: VerificationTable[]; pageSize: number };

export type SealStep =
  | { step: "checkpoint"; source: string }
  | { step: "verification-plan"; source: string }
  | { step: "verify-parts"; source: string; tasks: VerificationTask[]; cursor: SharedArrayBuffer }
  | { step: "manifest"; source: string; sealed: { snapshotId: string; bytes: number; pageSize: number } }
  /** A delta candidate before publish: build census and the rows this build wrote, then its manifest (contract §2.7, plan B). */
  | { step: "seal-delta"; source: string; sealed: { snapshotId: string; bytes: number } };

function quote(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

function integrity(db: DatabaseSync, sql: string): void {
  const rows = db.prepare(sql).all();
  if (rows.length !== 1 || Object.values(rows[0]!)[0] !== "ok") throw new Error(`seal: integrity ${JSON.stringify(rows.slice(0, 3))}`);
}

/**
 * The rows a delta build on a cloned base wrote: a rewritten file row carries the build's
 * generation; its declarations, edges and type names hang off it, and the graph rows it owns
 * are found through the owner indexes. Mapper rows carry no generation and are few: all of
 * them, and the graph rows of the Java types their namespaces bind. Every other row (the sym dictionary, search and entity postings, graph rows only
 * another file owns) and SQLite's own page structure are the background verifier's.
 */
export function deltaScopes(db: DatabaseSync): Map<string, string | undefined> {
  const generation = Number((db.prepare("SELECT value FROM main.meta WHERE key='indexedGeneration'").get() as { value?: string } | undefined)?.value);
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("seal: missing meta indexedGeneration");
  const written = db.prepare("SELECT id, path FROM main.file WHERE generation=?").all(generation) as Array<{ id: number; path: string }>;
  // A mapper XML change resyncs the graph rows of its namespace's Java types without rewriting their file rows.
  const mapperBound = db.prepare(`SELECT DISTINCT f.path FROM main.type t JOIN main.file f ON f.id=t.file_id
    WHERE t.fqn IN (SELECT namespace FROM main.mybatis_resource WHERE namespace IS NOT NULL)`).all() as Array<{ path: string }>;
  const ownerPaths = new Set([...written, ...mapperBound].map(row => row.path));
  // Integers only, so the literal lists are safe to inline.
  const files = `(SELECT value FROM json_each('${JSON.stringify(written.map(row => row.id))}'))`;
  const owners = `(SELECT value FROM json_each('${JSON.stringify([...ownerPaths].flatMap(path => symId(db, path) ?? []))}'))`;
  return new Map<string, string | undefined>([["file", `t.id IN ${files}`], ["type", `t.file_id IN ${files}`], ["field", `t.file_id IN ${files}`],
    ["method", `t.file_id IN ${files}`], ["edge", `t.file_id IN ${files}`], ["type_ref_name", `t.file_id IN ${files}`],
    ["kg_node", `t.sym IN (SELECT node_sym FROM main.kg_node_owner WHERE owner_sym IN ${owners})`], ["kg_node_owner", `t.owner_sym IN ${owners}`],
    ["kg_edge", `t.id IN (SELECT edge_id FROM main.kg_edge_owner WHERE owner_sym IN ${owners})`], ["kg_edge_owner", `t.owner_sym IN ${owners}`],
    ["mybatis_resource", undefined]]);
}

function run(input: SealStep): unknown {
  const db = new DatabaseSync(input.source, { readOnly: input.step !== "checkpoint" });
  try {
    if (input.step === "checkpoint") {
      // A writer still open elsewhere keeps the WAL: TRUNCATE reports busy and DELETE mode fails.
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (checkpoint.busy !== 0) throw new Error("seal: a writer still holds the database");
      const mode = (db.prepare("PRAGMA journal_mode=DELETE").get() as { journal_mode: string }).journal_mode;
      if (mode !== "delete") throw new Error(`seal: journal_mode ${mode}`);
      return {};
    }
    if (input.step === "manifest") return buildSnapshotManifest(db, input.sealed);
    if (input.step === "seal-delta") {
      if (!compatibleDeltaBase(db)) throw new Error("seal: incomplete build (census, pipeline or schema)");
      const logical = new Set(logicalTableNames(db));
      for (const [table, where] of deltaScopes(db)) if (logical.has(table)) validateLogicalTable(db, table, where);
      const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
      return buildSnapshotManifest(db, { ...input.sealed, pageSize });
    }
    if (input.step === "verification-plan") {
      if (!compatibleDeltaBase(db)) throw new Error("seal: incomplete build (census, pipeline or schema)");
      const kinds = db.prepare("PRAGMA main.table_list").all() as Array<{ type: string }>;
      if (kinds.some(row => row.type === "virtual" || row.type === "shadow")) throw new Error("seal: integrity partition requires ordinary tables");
      // Coverage comes from the complete schema, never logical-export's filter.
      const names = ["sqlite_schema", ...(db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)];
      const logical = new Set(logicalTableNames(db));
      const tables = names.map(name => {
        const columns = db.prepare(`PRAGMA main.table_info(${quote(name)})`).all() as Array<{ name: string }>;
        const facts = columns.some(column => column.name === "facts");
        const size = db.prepare(`SELECT count(*) AS n${facts ? ', coalesce(sum(length(facts)), 0) AS bytes' : ''} FROM main.${quote(name)}`).get() as { n: number; bytes?: number };
        // Ordering only: row work and compressed payload size start heavy tables
        // first; the shared cursor keeps the bounded readers busy without a persistent pool.
        return { name, logical: logical.has(name), weight: size.n * 64 + (size.bytes ?? 0) * 4 };
      }).sort((a, b) => b.weight - a.weight);
      return { tables, pageSize: (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size } satisfies VerificationPlan;
    }
    const cursor = new Int32Array(input.cursor), checked: VerificationTask[] = [];
    for (let index = Atomics.add(cursor, 0, 1); index < input.tasks.length && Atomics.load(cursor, 1) === 0; index = Atomics.add(cursor, 0, 1)) {
      const task = input.tasks[index]!;
      if (task.kind === "global") {
        // Global page/freelist/cross-tree coverage, supplemented by EVERY table's
        // full index/UNIQUE/order checks. quick_check alone is insufficient.
        integrity(db, "PRAGMA main.quick_check");
      } else if (task.kind === "common") {
        const foreign = db.prepare("PRAGMA main.foreign_key_check").all();
        if (foreign.length) throw new Error(`seal: ${foreign.length} foreign key violations`);
        if (!compatibleDeltaBase(db)) throw new Error("seal: incomplete build (census, pipeline or schema)");
      } else {
        integrity(db, `PRAGMA main.integrity_check('${task.table.replaceAll("'", "''")}')`);
        if (task.logical) validateLogicalTable(db, task.table);
      }
      checked.push(task);
    }
    return checked;
  } finally { db.close(); }
}

if (parentPort && workerData) {
  try { parentPort.postMessage({ value: run(workerData as SealStep) }); }
  catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
}

// input: one seal step (checkpoint | verify | manifest) for a job's private index.sqlite, as workerData.
// output: the step's result posted to the parent, or { error }.
// pos: contract §2.7 publish order, off the owner's event loop. A full integrity check of a real
//      repository's database runs for tens of seconds; on the owner thread it stalled every request,
//      builder result and scheduler timer for that long (MAC-11 G11 evidence). Steps run in order,
//      each on its own connection, so "checkpoint / close every writer" still precedes the checks.
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { compatibleDeltaBase } from "../../index-builder/execution-plan.js";
import { buildSnapshotManifest } from "../sql/snapshot-manifest.js";

export type SealStep =
  | { step: "checkpoint"; source: string }
  | { step: "verify"; source: string }
  | { step: "manifest"; source: string; sealed: { snapshotId: string; bytes: number; pageSize: number; sha256: string } };

function run(input: SealStep): unknown {
  if (input.step === "manifest") {
    const reader = new DatabaseSync(input.source, { readOnly: true });
    try { return buildSnapshotManifest(reader, input.sealed); } finally { reader.close(); }
  }
  const db = new DatabaseSync(input.source);
  try {
    if (input.step === "checkpoint") {
      // A writer still open elsewhere keeps the WAL: TRUNCATE reports busy and DELETE mode fails.
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (checkpoint.busy !== 0) throw new Error("seal: a writer still holds the database");
      const mode = (db.prepare("PRAGMA journal_mode=DELETE").get() as { journal_mode: string }).journal_mode;
      if (mode !== "delete") throw new Error(`seal: journal_mode ${mode}`);
      return {};
    }
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") throw new Error(`seal: integrity ${JSON.stringify(integrity.slice(0, 3))}`);
    const foreign = db.prepare("PRAGMA foreign_key_check").all();
    if (foreign.length) throw new Error(`seal: ${foreign.length} foreign key violations`);
    // Census and derived pipeline complete: the same rule a delta uses to accept a base.
    if (!compatibleDeltaBase(db)) throw new Error("seal: incomplete build (census, pipeline or schema)");
    return { pageSize: (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size };
  } finally { db.close(); }
}

if (parentPort && workerData) {
  try { parentPort.postMessage({ value: run(workerData as SealStep) }); }
  catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
}

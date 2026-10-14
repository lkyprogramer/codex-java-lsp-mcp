// SQLite transactions atomically publish the two shared fixture reservations.
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { requireValue } from "./ilv2-mac-contracts.mjs";

function alive(pid) {
  if (!Number.isInteger(pid) || pid === 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}
export const fixtureQuotaFile = workRoot => path.join(workRoot, "control", "fixture-daemons", "quota.sqlite");

function transaction(file, operation) {
  const db = new DatabaseSync(file);
  let begun = false;
  try {
    db.exec("PRAGMA busy_timeout=50; CREATE TABLE IF NOT EXISTS fixture_slots (slot INTEGER PRIMARY KEY CHECK(slot IN (0,1)), token TEXT NOT NULL UNIQUE, pid INTEGER NOT NULL CHECK(pid>0), child_pid INTEGER, pgid INTEGER, CHECK((child_pid IS NULL AND pgid IS NULL) OR (child_pid>0 AND pgid>0)))");
    db.exec("BEGIN IMMEDIATE"); begun = true;
    const result = operation(db);
    db.exec("COMMIT"); begun = false;
    return result;
  } catch (error) {
    if (begun) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}
async function retryTransaction(file, operation, { timeoutMs, signal } = {}) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    signal?.throwIfAborted();
    try { return transaction(file, operation); }
    catch (error) { if (error.errcode !== 5) throw error; }
    await delay(50, undefined, { signal });
  }
  throw new Error("fixture quota transaction timed out");
}
export async function acquireFixtureSlot(workRoot, { signal, timeoutMs = 30000 } = {}) {
  requireValue(path.isAbsolute(workRoot) && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, "bounded shared quota required");
  const file = fixtureQuotaFile(workRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const started = performance.now();
  const token = randomUUID();
  let slot;
  while (performance.now() - started < timeoutMs) {
    signal?.throwIfAborted();
    slot = await retryTransaction(file, db => {
      const rows = db.prepare("SELECT * FROM fixture_slots").all();
      for (const row of rows) {
        // An unregistered launcher cannot start service before the parent commits.
        // A reused PID conservatively holds the slot; never kill it here.
        if (!alive(row.pid) && (row.child_pid === null || (!alive(row.child_pid) && !alive(-row.pgid)))) {
          db.prepare("DELETE FROM fixture_slots WHERE slot=? AND token=?").run(row.slot, row.token);
        }
      }
      const used = new Set(db.prepare("SELECT slot FROM fixture_slots").all().map(row => row.slot));
      const available = [0, 1].find(index => !used.has(index));
      if (available !== undefined) db.prepare("INSERT INTO fixture_slots(slot,token,pid) VALUES(?,?,?)").run(available, token, process.pid);
      return available;
    }, { timeoutMs: Math.max(1, timeoutMs - (performance.now() - started)), signal });
    if (slot !== undefined) break;
    await delay(50, undefined, { signal });
  }
  requireValue(slot !== undefined, "fixture quota wait timed out");
  let released = false;
  const owned = db => {
    const row = db.prepare("SELECT * FROM fixture_slots WHERE slot=?").get(slot);
    requireValue(row?.token === token, "fixture slot ownership changed");
    return row;
  };
  const lease = {
    slot,
    async registerChild(pid, pgid) {
      requireValue(Number.isInteger(pid) && pid > 0 && Number.isInteger(pgid) && pgid > 0, "invalid fixture process identity");
      await retryTransaction(file, db => {
        requireValue(owned(db).child_pid === null, "fixture child already registered");
        db.prepare("UPDATE fixture_slots SET child_pid=?,pgid=? WHERE slot=? AND token=?").run(pid, pgid, slot, token);
      }, { timeoutMs: 5000 });
    },
    async release() {
      if (released) return;
      await retryTransaction(file, db => {
        const row = owned(db);
        requireValue(row.child_pid === null || (!alive(row.child_pid) && !alive(-row.pgid)), "fixture still alive; quota not released");
        db.prepare("DELETE FROM fixture_slots WHERE slot=? AND token=?").run(slot, token);
      }, { timeoutMs: 5000 });
      released = true;
    }
  };
  if (signal?.aborted) { await lease.release(); signal.throwIfAborted(); }
  return lease;
}
export function inspectFixtureSlots(workRoot) {
  const db = new DatabaseSync(fixtureQuotaFile(workRoot), { readOnly: true });
  try { return db.prepare("SELECT * FROM fixture_slots ORDER BY slot").all(); }
  finally { db.close(); }
}

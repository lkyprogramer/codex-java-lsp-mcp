// SQLite transactions atomically publish the two shared fixture reservations.
import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
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
    // The trigger also makes pre-MAC-02B clients fail closed. They must not
    // reclaim a launchd job in its bootstrap/PID-publication window.
    db.exec("CREATE TABLE IF NOT EXISTS external_fixture_jobs (token TEXT PRIMARY KEY, domain TEXT NOT NULL, label TEXT NOT NULL, run_root TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS protect_external_fixture BEFORE DELETE ON fixture_slots WHEN EXISTS(SELECT 1 FROM external_fixture_jobs WHERE token=OLD.token) BEGIN SELECT RAISE(ABORT,'external_fixture_requires_closeout'); END");
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
async function acquireSlot(workRoot, { signal, timeoutMs = 30000, externalJob } = {}) {
  requireValue(path.isAbsolute(workRoot) && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, "bounded shared quota required");
  const file = fixtureQuotaFile(workRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const started = performance.now();
  const token = randomUUID();
  let slot;
  while (performance.now() - started < timeoutMs) {
    signal?.throwIfAborted();
    slot = await retryTransaction(file, db => {
      const rows = db.prepare("SELECT * FROM fixture_slots WHERE token NOT IN (SELECT token FROM external_fixture_jobs)").all();
      for (const row of rows) {
        // An unregistered launcher cannot start service before the parent commits.
        // A reused PID conservatively holds the slot; never kill it here.
        if (!alive(row.pid) && (row.child_pid === null || (!alive(row.child_pid) && !alive(-row.pgid)))) {
          db.prepare("DELETE FROM fixture_slots WHERE slot=? AND token=?").run(row.slot, row.token);
        }
      }
      const used = new Set(db.prepare("SELECT slot FROM fixture_slots").all().map(row => row.slot));
      const available = [0, 1].find(index => !used.has(index));
      if (available !== undefined) {
        db.prepare("INSERT INTO fixture_slots(slot,token,pid) VALUES(?,?,?)").run(available, token, process.pid);
        if (externalJob) db.prepare("INSERT INTO external_fixture_jobs VALUES(?,?,?,?)").run(token, externalJob.domain, externalJob.label, externalJob.runRoot);
      }
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
      requireValue(!externalJob, "external fixture requires bootout closeout");
      await retryTransaction(file, db => {
        const row = owned(db);
        requireValue(row.child_pid === null || (!alive(row.child_pid) && !alive(-row.pgid)), "fixture still alive; quota not released");
        db.prepare("DELETE FROM fixture_slots WHERE slot=? AND token=?").run(slot, token);
      }, { timeoutMs: 5000 });
      released = true;
    }
  };
  if (externalJob) {
    let bootstrapState = "NEW";
    const incarnations = [];
    const observed = new Set();
    lease.bootstrap = async plist => {
      requireValue(bootstrapState === "NEW" && path.dirname(plist) === externalJob.runRoot, "registered fixture plist required");
      const parsed = JSON.parse((await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist])).stdout);
      requireValue(parsed.Label === externalJob.label && parsed.WorkingDirectory === externalJob.runRoot, "fixture plist identity mismatch");
      bootstrapState = "RUNNING";
      try { return await executeLaunchctl(["bootstrap", externalJob.domain, plist]); }
      finally { bootstrapState = "FINISHED"; }
    };
    lease.observe = (pid, pgid, source = "owner-ready") => {
      requireValue(Number.isInteger(pid) && pid > 1 && Number.isInteger(pgid) && pgid > 0, "invalid external incarnation");
      requireValue(["owner-ready", "launchctl"].includes(source), "explicit external observation source required");
      requireValue(pgid === pid || (source === "launchctl" && pgid === 1), "launchd owner must lead its own process group");
      const key = `${pid}:${pgid}:${source}`;
      if (observed.has(key)) return;
      observed.add(key);
      // launchctl can publish the PID before launchd assigns its own group.
      // Keep that PID observation, without claiming launchd's shared group 1.
      incarnations.push({ pid, pgid, source, groupOwned: pgid === pid });
    };
    lease.close = async () => {
      if (released) return;
      requireValue(bootstrapState !== "RUNNING", "bootstrap must finish before external closeout");
      const service = `${externalJob.domain}/${externalJob.label}`;
      try { await executeLaunchctl(["bootout", service]); }
      catch (error) { requireValue(error.code === 3 || error.code === 113, "bootout failed"); }
      const deadline = performance.now() + 5000;
      let absent = false;
      let printObservation;
      do {
        try { const result = await executeLaunchctl(["print", service], Math.max(1, Math.ceil(deadline - performance.now()))); printObservation = { exitCode: 0, stdout: result.stdout, stderr: result.stderr }; }
        catch (error) {
          absent = error.code === 113 && error.stderr.includes(`Could not find service \"${externalJob.label}\"`);
          printObservation = { exitCode: error.code, stdout: error.stdout, stderr: error.stderr };
          break;
        }
        await delay(50);
      } while (performance.now() < deadline);
      if (!absent) throw Object.assign(new Error("launchd job still present or absence unproven"), {
        fixtureCloseout: { service, absent, printObservation, incarnations }
      });
      let processes;
      let processStates;
      do {
        processes = (await execute("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,command="], { timeout: Math.max(1, Math.ceil(deadline - performance.now())), killSignal: "SIGKILL" })).stdout.split("\n").filter(line => line.includes(externalJob.runRoot) && Number(line.trim().split(/\s+/)[0]) !== process.pid);
        processStates = incarnations.map(row => ({ ...row, pidAlive: alive(row.pid), groupAlive: row.groupOwned && alive(-row.pgid) }));
        if (processes.length === 0 && processStates.every(row => !row.pidAlive && !row.groupAlive)) break;
        await delay(50);
      } while (performance.now() < deadline);
      processStates = incarnations.map(row => ({ ...row, pidAlive: alive(row.pid), groupAlive: row.groupOwned && alive(-row.pgid) }));
      if (processes.length || processStates.some(row => row.pidAlive || row.groupAlive)) {
        throw Object.assign(new Error("external fixture processes remain"), {
          fixtureCloseout: { service, absent, incarnations, processStates, matchingProcesses: processes }
        });
      }
      await retryTransaction(file, db => {
        owned(db);
        requireValue(db.prepare("SELECT token FROM external_fixture_jobs WHERE token=?").get(token), "external marker missing");
        db.prepare("DELETE FROM external_fixture_jobs WHERE token=?").run(token);
        db.prepare("DELETE FROM fixture_slots WHERE token=?").run(token);
      }, { timeoutMs: 5000 });
      released = true;
      return { service, absent, incarnations, residualProcesses: [] };
    };
  }
  if (signal?.aborted && !externalJob) { await lease.release(); signal.throwIfAborted(); }
  return lease;
}
const execute = promisify(execFile);
const executeLaunchctl = (args, timeoutMs = 5000) => execute("/bin/launchctl", args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
export function acquireFixtureSlot(workRoot, options = {}) {
  requireValue(!Object.hasOwn(options, "externalJob"), "use registered launchd fixture adapter");
  return acquireSlot(workRoot, options);
}
export async function acquireLaunchdFixtureSlot(workRoot, { runRoot, label, signal, timeoutMs } = {}) {
  requireValue(path.isAbsolute(runRoot) && await realpath(runRoot) === runRoot && runRoot.startsWith(`${await realpath(workRoot)}/runs/`), "private registered launchd root required");
  const registered = process.env.ILV2_RUN_ROOT;
  requireValue(registered && (await readFile(path.join(registered, "run-root.txt"), "utf8")).trim() === registered && runRoot.startsWith(`${await realpath(registered)}/`), "launchd fixture must belong to preregistered run root");
  requireValue(/^com\.lky\.ilv2-mac02b\.[a-zA-Z0-9.-]+$/.test(label), "isolated launchd label required");
  return acquireSlot(workRoot, { signal, timeoutMs, externalJob: { domain: `gui/${process.getuid()}`, label, runRoot } });
}
export function inspectFixtureSlots(workRoot) {
  const db = new DatabaseSync(fixtureQuotaFile(workRoot), { readOnly: true });
  try { return db.prepare("SELECT * FROM fixture_slots ORDER BY slot").all(); }
  finally { db.close(); }
}

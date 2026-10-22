// input: a job's private index.sqlite whose writer handles are all closed.
// output: an immutable snapshot under mac1/snapshots/<snapshotId>/ (index.sqlite + manifest.json), or nothing.
// pos: MAC-07, contract §2.7 publish order up to the snapshot rename; binding is snapshot-store.ts.
//      SIGKILL recovery is tested; power-loss durability is not claimed (fsync calls are not a power test).
//      MAC-12 (plan B): a delta seal checks the build census and the rows the build wrote; the full
//      integrity check and file digest of a delta snapshot are the background verifier's, recorded in
//      verified/<snapshotId>.json. A full seal still verifies everything and records it at once.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { OWNER_STORE_DIR } from "../../repo-layout.js";
import { parseSnapshotManifest, type ContentEntry, type SnapshotManifest } from "../sql/snapshot-manifest.js";
import type { SealStep, VerificationPlan, VerificationTable, VerificationTask } from "./seal-worker.js";

export const DB_FILE = "index.sqlite";
export const MANIFEST_FILE = "manifest.json";
const SIDECARS = ["-wal", "-shm", "-journal"];

/** The mac1 cache tree (contract §2.7). */
export function mac1Layout(cacheRoot: string) {
  const root = path.join(cacheRoot, OWNER_STORE_DIR);
  return { root, owner: path.join(root, "owner"), snapshots: path.join(root, "snapshots"),
    workspaces: path.join(root, "workspaces"), jobs: path.join(root, "jobs"), verified: path.join(root, "verified") };
}
export type Mac1Layout = ReturnType<typeof mac1Layout>;

const ID = /^[A-Za-z0-9_-]{8,128}$/;
export function assertId(kind: string, id: string): void {
  if (!ID.test(id)) throw new Error(`invalid ${kind} ${JSON.stringify(id)}`);
}
export function newSnapshotId(): string {
  return `s-${Date.now().toString(36)}-${randomUUID().replaceAll("-", "")}`;
}

export async function syncFile(file: string): Promise<void> {
  const handle = await open(file, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function syncDir(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Write `file` atomically: tmp in the same directory, sync, rename, sync the directory. */
export async function writeFileAtomic(file: string, data: string, mode = 0o644,
  hooks?: { afterTmp?: () => void | Promise<void>; afterRename?: () => void | Promise<void> }): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, data, { mode, flag: "wx" });
  await syncFile(tmp);
  await hooks?.afterTmp?.();
  await rename(tmp, file);
  await hooks?.afterRename?.();
  await syncDir(path.dirname(file));
}

async function fileSha256(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, signal ? { signal } : {})) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// Publishing outlives the builder permit. Bound ALL seal steps in this owner,
// rather than multiplying the worker cap by the number of concurrent publishes.
export const SEAL_WORKER_LIMIT = 4;
let permits = 0, peakWorkers = 0;
const workers = new Set<Worker>();
const waiters: Array<() => void> = [];
export function sealWorkerUsage() { return { active: workers.size, queued: waiters.length, peak: peakWorkers }; }

function acquireSealWorker(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const grant = () => { signal?.removeEventListener("abort", abort); permits++; resolve(); };
    const abort = () => {
      const index = waiters.indexOf(grant);
      if (index >= 0) waiters.splice(index, 1);
      reject(signal!.reason);
    };
    if (permits < SEAL_WORKER_LIMIT) grant();
    else { waiters.push(grant); signal?.addEventListener("abort", abort, { once: true }); }
  });
}

function releaseSealWorker(): void {
  permits--;
  waiters.shift()?.();
}

/** Reply AND actual exit(0) are required; a reply never releases a live worker's permit. */
export async function runSealStep<T>(input: SealStep, signal?: AbortSignal): Promise<T> {
  await acquireSealWorker(signal);
  try {
    signal?.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const worker = new Worker(new URL("./seal-worker.js", import.meta.url), { workerData: input, execArgv: ["--disable-warning=ExperimentalWarning"] });
      workers.add(worker);
      peakWorkers = Math.max(peakWorkers, workers.size);
      let replies = 0, value: T, failure: unknown;
      const abort = () => {
        failure ??= signal!.reason;
        if (input.step === "verify-parts") {
          // Do not interrupt a zlib constructor between allocation and init:
          // Node22.16 can abort the whole owner during native cleanup. Finish
          // this table, stop claiming work, then close SQLite and exit normally.
          Atomics.store(new Int32Array(input.cursor), 1, 1);
        } else void worker.terminate().catch(error => { failure ??= error; });
      };
      signal?.addEventListener("abort", abort, { once: true });
      worker.on("message", (reply: { value?: T; error?: string }) => {
        replies++;
        if (!reply || typeof reply !== "object" || !("value" in reply) || "error" in reply) {
          failure ??= new Error(reply?.error ?? `seal ${input.step}: invalid worker reply`);
        } else value = reply.value as T;
      });
      worker.once("error", error => { failure ??= error; });
      worker.once("exit", code => {
        workers.delete(worker);
        signal?.removeEventListener("abort", abort);
        if (failure !== undefined) reject(failure);
        else if (code !== 0 || replies !== 1) reject(new Error(`seal ${input.step}: worker exited ${code}, replies ${replies}`));
        else resolve(value);
      });
    });
  } finally { releaseSealWorker(); }
}

/**
 * Bounded short-lived readers share a cursor; failure drains their actual exits before rejecting.
 * An abort of `signal` stops claiming tables (the running ones finish) and rejects with its reason.
 */
export async function runVerificationTasks(source: string, tasks: VerificationTask[], options: { workers?: number; signal?: AbortSignal } = {}): Promise<VerificationTask[]> {
  // next task and cooperative stop flag; all readers still exit before settle.
  const cursor = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
  const controller = new AbortController();
  const outer = options.signal;
  const forward = () => controller.abort(outer!.reason);
  if (outer?.aborted) forward(); else outer?.addEventListener("abort", forward, { once: true });
  const readers = Math.max(1, Math.min(options.workers ?? SEAL_WORKER_LIMIT, SEAL_WORKER_LIMIT, tasks.length));
  const results = await Promise.allSettled(Array.from({ length: readers }, () =>
    runSealStep<VerificationTask[]>({ step: "verify-parts", source, tasks, cursor }, controller.signal)
      .catch(error => { controller.abort(error); throw error; })));
  outer?.removeEventListener("abort", forward);
  if (outer?.aborted) throw outer.reason;
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results.flatMap(result => result.status === "fulfilled" ? result.value : []);
}

/** Exactly one successful acknowledgement per required check, with no missing/extra tables. */
export function assertVerificationComplete(tables: VerificationTable[], results: VerificationTask[]): void {
  const expected = new Map<string, boolean>([["global", false], ["common", false], ...tables.map(table => [`table:${table.name}`, table.logical] as [string, boolean])]);
  if (expected.size !== tables.length + 2) throw new Error("seal: duplicate verification table");
  for (const result of results) {
    const key = result.kind === "table" ? `table:${result.table}` : result.kind;
    if (!expected.has(key) || expected.get(key) !== (result.kind === "table" && result.logical)) throw new Error(`seal: unexpected verification result ${key}`);
    expected.delete(key);
  }
  if (expected.size) throw new Error(`seal: missing verification results ${[...expected.keys()].join(", ")}`);
}

export type SealFault = "sealed-checkpointed" | "verification-planned" | "sealed-verified" | "manifest-written" | "snapshot-renamed";
export type FaultHook = (step: string) => void | Promise<void>;

/** Wall ms of each seal step (the SQL/seal profile). */
export type SealTimings = { checkpointMs?: number; verifyMs?: number; hashMs?: number; manifestMs?: number; persistMs?: number; recordMs?: number };

/**
 * The complete check of one checkpointed, read-only database file: SQLite global and per-table
 * integrity, foreign keys, the build census and every logical row, then its digest.
 */
export async function verifyDatabaseFile(file: string, options: { workers?: number; signal?: AbortSignal; faultAt?: FaultHook; timings?: SealTimings } = {}): Promise<{ bytes: number; pageSize: number; sha256: string }> {
  const timings = options.timings ?? {};
  const at = performance.now();
  const plan = await runSealStep<VerificationPlan>({ step: "verification-plan", source: file }, options.signal);
  await options.faultAt?.("verification-planned");
  const tasks: VerificationTask[] = [{ kind: "global" }, ...plan.tables.map(table => ({ kind: "table" as const, table: table.name, logical: table.logical })), { kind: "common" }];
  assertVerificationComplete(plan.tables, await runVerificationTasks(file, tasks, { workers: options.workers, signal: options.signal }));
  timings.verifyMs = performance.now() - at;
  const hashed = performance.now();
  const sha256 = await fileSha256(file, options.signal);
  timings.hashMs = performance.now() - hashed;
  return { bytes: (await stat(file)).size, pageSize: plan.pageSize, sha256 };
}

/** full: verify everything before publish (an empty job's build). delta: the build census and the rows it wrote (a cloned base). */
export type SealMode = "full" | "delta";

/**
 * Seal `jobDir/index.sqlite` into `snapshots/<snapshotId>`. Throws, publishing nothing, unless the
 * file is a complete single-file database that passes the mode's checks. A full seal also writes
 * the snapshot's verification record.
 */
export async function sealJobDatabase(layout: Mac1Layout, jobDir: string, options: { snapshotId?: string; mode?: SealMode; faultAt?: FaultHook; timings?: SealTimings } = {}): Promise<SnapshotManifest> {
  const snapshotId = options.snapshotId ?? newSnapshotId();
  assertId("snapshotId", snapshotId);
  const mode = options.mode ?? "full";
  const source = path.join(jobDir, DB_FILE);
  const target = path.join(layout.snapshots, snapshotId);
  if (existsSync(target)) throw new Error(`snapshot ${snapshotId} exists`);
  // Checkpoint and close every writer before the read-only verification interval.
  const timings = options.timings ?? {};
  const timed = async <T>(name: keyof SealTimings, work: () => Promise<T>): Promise<T> => {
    const at = performance.now();
    try { return await work(); } finally { timings[name] = performance.now() - at; }
  };
  await timed("checkpointMs", () => runSealStep({ step: "checkpoint", source }));
  await options.faultAt?.("sealed-checkpointed");
  const noSidecars = () => {
    for (const suffix of SIDECARS) if (existsSync(`${source}${suffix}`)) throw new Error(`seal: ${DB_FILE}${suffix} remains`);
  };
  noSidecars();
  await chmod(source, 0o444);
  const before = await stat(source, { bigint: true });
  const bytes = Number(before.size);
  let manifest: SnapshotManifest, verified: { bytes: number; sha256: string } | undefined;
  if (mode === "full") {
    const file = await verifyDatabaseFile(source, { faultAt: options.faultAt, timings });
    verified = file;
    manifest = await timed("manifestMs", () => runSealStep<SnapshotManifest>({ step: "manifest", source, sealed: { snapshotId, bytes, pageSize: file.pageSize } }));
  } else {
    manifest = await timed("verifyMs", () => runSealStep<SnapshotManifest>({ step: "seal-delta", source, sealed: { snapshotId, bytes } }));
  }
  const persistStarted = performance.now();
  await options.faultAt?.("sealed-verified");
  // Cover the entire read interval, including hash and manifest, before rename.
  noSidecars();
  const after = await stat(source, { bigint: true });
  if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) {
    throw new Error("seal: database changed during verification");
  }
  if (verified && verified.bytes !== bytes) throw new Error("seal: database changed during verification");
  const staging = path.join(jobDir, "sealed");
  await mkdir(staging);
  await rename(source, path.join(staging, DB_FILE));
  await writeFile(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  for (const name of [DB_FILE, MANIFEST_FILE]) {
    await chmod(path.join(staging, name), 0o444);
    await syncFile(path.join(staging, name));
  }
  await syncDir(staging);
  await syncDir(jobDir);
  await options.faultAt?.("manifest-written");
  await rename(staging, target);
  // Read-only by ownership as well as by code (driver.isSealedSnapshotPath).
  await chmod(target, 0o555);
  await syncDir(layout.snapshots);
  await syncDir(jobDir);
  timings.persistMs = performance.now() - persistStarted;
  await options.faultAt?.("snapshot-renamed");
  // A crash before this leaves a sealed but unverified snapshot: the background verifier's.
  if (verified) await timed("recordMs", () => writeVerification(layout, { snapshotId, result: "VERIFIED", bytes: verified!.bytes, sha256: verified!.sha256 }));
  return manifest;
}

/** Strictly read a sealed snapshot's manifest; `verifyFile` also requires its VERIFIED record and re-hashes the database against it. */
export async function readSealedManifest(layout: Mac1Layout, snapshotId: string, options: { verifyFile?: boolean } = {}): Promise<SnapshotManifest> {
  assertId("snapshotId", snapshotId);
  const directory = path.join(layout.snapshots, snapshotId);
  const manifest = parseSnapshotManifest(JSON.parse(await readFile(path.join(directory, MANIFEST_FILE), "utf8")));
  if (manifest.snapshotId !== snapshotId) throw new Error(`snapshot ${snapshotId}: manifest names ${manifest.snapshotId}`);
  if ((await stat(directory)).mode & 0o222) throw new Error(`snapshot ${snapshotId}: directory is writable`);
  const file = path.join(directory, DB_FILE);
  for (const suffix of SIDECARS) if (existsSync(`${file}${suffix}`)) throw new Error(`snapshot ${snapshotId}: ${DB_FILE}${suffix} present`);
  const info = await stat(file);
  if (info.size !== manifest.file.bytes) throw new Error(`snapshot ${snapshotId}: ${info.size} bytes, manifest ${manifest.file.bytes}`);
  if (info.mode & 0o222) throw new Error(`snapshot ${snapshotId}: database is writable`);
  if (options.verifyFile) {
    const record = await readVerification(layout, snapshotId);
    if (record?.result !== "VERIFIED") throw new Error(`snapshot ${snapshotId}: not verified`);
    if (record.bytes !== info.size || await fileSha256(file) !== record.sha256) throw new Error(`snapshot ${snapshotId}: database digest mismatch`);
  }
  return manifest;
}

// ------------------------------------------------------------ verification records

export const VERIFICATION_FORMAT = "ilv2-snapshot-verification/v1";
/** The background verifier's verdict on one sealed snapshot (absent: not verified yet). */
export type VerificationRecord =
  | { formatVersion: typeof VERIFICATION_FORMAT; snapshotId: string; result: "VERIFIED"; bytes: number; sha256: string; at: number }
  | { formatVersion: typeof VERIFICATION_FORMAT; snapshotId: string; result: "FAILED"; error: string; at: number };
export type VerificationVerdict = { snapshotId: string } & ({ result: "VERIFIED"; bytes: number; sha256: string } | { result: "FAILED"; error: string });

const RECORD = /^([A-Za-z0-9_-]{8,128})\.json$/;
export function verificationFile(layout: Mac1Layout, snapshotId: string): string {
  assertId("snapshotId", snapshotId);
  return path.join(layout.verified, `${snapshotId}.json`);
}

export async function writeVerification(layout: Mac1Layout, verdict: VerificationVerdict): Promise<VerificationRecord> {
  const record = { formatVersion: VERIFICATION_FORMAT, ...verdict, at: Date.now() } as VerificationRecord;
  await mkdir(layout.verified, { recursive: true });
  await writeFileAtomic(verificationFile(layout, verdict.snapshotId), `${JSON.stringify(record)}\n`);
  return record;
}

/** Strict: a record of another shape is an error, never "verified". */
export function parseVerification(value: unknown, snapshotId: string): VerificationRecord {
  const fail = (why: string): never => { throw new Error(`invalid verification record ${snapshotId}: ${why}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("not an object");
  const r = value as Record<string, unknown>;
  if (r.formatVersion !== VERIFICATION_FORMAT) fail(`formatVersion ${String(r.formatVersion)}`);
  if (r.snapshotId !== snapshotId) fail("snapshotId");
  if (!Number.isSafeInteger(r.at)) fail("at");
  const keys = JSON.stringify(Object.keys(r).sort());
  if (r.result === "VERIFIED") {
    if (keys !== '["at","bytes","formatVersion","result","sha256","snapshotId"]') fail("unexpected fields");
    if (!Number.isSafeInteger(r.bytes) || (r.bytes as number) <= 0 || typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) fail("file");
  } else if (r.result === "FAILED") {
    if (keys !== '["at","error","formatVersion","result","snapshotId"]' || typeof r.error !== "string") fail("unexpected fields");
  } else fail(`result ${String(r.result)}`);
  return value as VerificationRecord;
}

export async function readVerification(layout: Mac1Layout, snapshotId: string): Promise<VerificationRecord | undefined> {
  let text: string;
  try { text = await readFile(verificationFile(layout, snapshotId), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return parseVerification(JSON.parse(text), snapshotId);
}

/** Record names in verified/ (their snapshot may be gone: the sweep's) and foreign entries. */
export async function verificationEntries(layout: Mac1Layout): Promise<{ records: string[]; foreign: string[] }> {
  const records: string[] = [], foreign: string[] = [];
  let names: string[];
  try { names = await readdir(layout.verified); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records, foreign }; throw error; }
  for (const name of names.sort()) {
    const match = RECORD.exec(name);
    if (match) records.push(match[1]!); else foreign.push(name);
  }
  return { records, foreign };
}

/** The only reader for a SEALED snapshot: read-only and SQLite immutable (no locks, no WAL/SHM). */
export function openSealedDatabase(layout: Mac1Layout, snapshotId: string): DatabaseSync {
  assertId("snapshotId", snapshotId);
  const file = path.join(layout.snapshots, snapshotId, DB_FILE);
  if (!existsSync(path.join(layout.snapshots, snapshotId, MANIFEST_FILE))) throw new Error(`snapshot ${snapshotId} is not sealed`);
  const url = pathToFileURL(file);
  url.searchParams.set("immutable", "1");
  url.searchParams.set("mode", "ro");
  return new DatabaseSync(url.href, { readOnly: true });
}

/** The content census a sealed snapshot was built from: what a tracker round compares its verified view to. */
export async function readSnapshotContent(layout: Mac1Layout, snapshotId: string): Promise<{ manifest: SnapshotManifest; entries: Map<string, ContentEntry> }> {
  const manifest = await readSealedManifest(layout, snapshotId);
  const db = openSealedDatabase(layout, snapshotId);
  try {
    const rows = db.prepare(`SELECT 'java' AS kind, path, content_hash AS hash FROM main.file
      UNION ALL SELECT 'resource', path, content_hash FROM main.resource_scan`).all() as ContentEntry[];
    return { manifest, entries: new Map(rows.map(row => [row.path, { kind: row.kind, path: row.path, hash: row.hash }])) };
  } finally { db.close(); }
}

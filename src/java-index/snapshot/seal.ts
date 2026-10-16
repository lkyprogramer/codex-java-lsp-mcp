// input: a job's private index.sqlite whose writer handles are all closed.
// output: an immutable snapshot under mac1/snapshots/<snapshotId>/ (index.sqlite + manifest.json), or nothing.
// pos: MAC-07, contract §2.7 publish order up to the snapshot rename; binding is snapshot-store.ts.
//      SIGKILL recovery is tested; power-loss durability is not claimed (fsync calls are not a power test).
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { compatibleDeltaBase } from "../../index-builder/execution-plan.js";
import { buildSnapshotManifest, parseSnapshotManifest, type ContentEntry, type SnapshotManifest } from "../sql/snapshot-manifest.js";

export const DB_FILE = "index.sqlite";
export const MANIFEST_FILE = "manifest.json";
const SIDECARS = ["-wal", "-shm", "-journal"];

/** The mac1 cache tree (contract §2.7). */
export function mac1Layout(cacheRoot: string) {
  const root = path.join(cacheRoot, "mac1");
  return { root, owner: path.join(root, "owner"), snapshots: path.join(root, "snapshots"),
    workspaces: path.join(root, "workspaces"), jobs: path.join(root, "jobs") };
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

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type SealFault = "sealed-checkpointed" | "sealed-verified" | "manifest-written" | "snapshot-renamed";
export type FaultHook = (step: string) => void | Promise<void>;

/**
 * Seal `jobDir/index.sqlite` into `snapshots/<snapshotId>`. Throws, publishing
 * nothing, unless the file is a complete, consistent, single-file database.
 */
export async function sealJobDatabase(layout: Mac1Layout, jobDir: string, options: { snapshotId?: string; faultAt?: FaultHook } = {}): Promise<SnapshotManifest> {
  const snapshotId = options.snapshotId ?? newSnapshotId();
  assertId("snapshotId", snapshotId);
  const source = path.join(jobDir, DB_FILE);
  const target = path.join(layout.snapshots, snapshotId);
  if (existsSync(target)) throw new Error(`snapshot ${snapshotId} exists`);
  let manifest: SnapshotManifest;
  const db = new DatabaseSync(source);
  let dbOpen = true;
  try {
    // A writer still open elsewhere keeps the WAL: TRUNCATE reports busy and DELETE mode fails.
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    if (checkpoint.busy !== 0) throw new Error("seal: a writer still holds the database");
    const mode = (db.prepare("PRAGMA journal_mode=DELETE").get() as { journal_mode: string }).journal_mode;
    if (mode !== "delete") throw new Error(`seal: journal_mode ${mode}`);
    await options.faultAt?.("sealed-checkpointed");
    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]!.integrity_check !== "ok") throw new Error(`seal: integrity ${JSON.stringify(integrity.slice(0, 3))}`);
    const foreign = db.prepare("PRAGMA foreign_key_check").all();
    if (foreign.length) throw new Error(`seal: ${foreign.length} foreign key violations`);
    // Census and derived pipeline complete: the same rule a delta uses to accept a base.
    if (!compatibleDeltaBase(db)) throw new Error("seal: incomplete build (census, pipeline or schema)");
    const pageSize = (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size;
    db.close();
    dbOpen = false;
    for (const suffix of SIDECARS) if (existsSync(`${source}${suffix}`)) throw new Error(`seal: ${DB_FILE}${suffix} remains`);
    const bytes = (await stat(source)).size;
    const sha256 = await fileSha256(source);
    const reader = new DatabaseSync(source, { readOnly: true });
    try { manifest = buildSnapshotManifest(reader, { snapshotId, bytes, pageSize, sha256 }); } finally { reader.close(); }
  } finally {
    if (dbOpen) db.close();
  }
  await options.faultAt?.("sealed-verified");
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
  await options.faultAt?.("snapshot-renamed");
  return manifest;
}

/** Strictly read a sealed snapshot's manifest; `verifyFile` also re-hashes the database. */
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
  if (options.verifyFile && await fileSha256(file) !== manifest.file.sha256) throw new Error(`snapshot ${snapshotId}: database digest mismatch`);
  return manifest;
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

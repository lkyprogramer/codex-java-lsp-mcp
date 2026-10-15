import { createHash } from "node:crypto";
import type { IndexDatabase } from "./driver.js";
import { LOGICAL_EXPORT_VERSION, logicalDigest, type LogicalTableDigest } from "./logical-export.js";

// The sealed manifest written next to a published snapshot's index.sqlite
// (contract §2.x). It names what the snapshot logically contains, independent
// of workspace: no root, stat or workspaceId. The publisher (MAC-05) fills
// snapshotId and the sealed file digest after the final checkpoint.
export const SNAPSHOT_MANIFEST_FORMAT = "ilv2-snapshot-manifest/mac1";

export type SnapshotManifest = {
  formatVersion: typeof SNAPSHOT_MANIFEST_FORMAT;
  snapshotId: string;
  schemaVersion: number;
  identityVersion: number;
  factsRevision: number;
  /** sha256 over sorted "kind\0path\0contentHash" lines of every indexed Java file and scanned resource. */
  contentManifestId: string;
  sources: { java: number; resources: number };
  logical: { version: typeof LOGICAL_EXPORT_VERSION; digest: string; tables: Record<string, LogicalTableDigest> };
  file: { bytes: number; pageSize: number; pages: number; sha256: string };
};

const HEX64 = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9_-]{8,128}$/;

function metaNumber(db: IndexDatabase, key: string): number {
  const value = Number((db.prepare("SELECT value FROM main.meta WHERE key=?").get(key) as { value?: string } | undefined)?.value);
  if (!Number.isSafeInteger(value)) throw new Error(`missing meta ${key}`);
  return value;
}

export function contentManifestId(db: IndexDatabase): { id: string; java: number; resources: number } {
  const hash = createHash("sha256");
  let java = 0;
  let resources = 0;
  for (const row of db.prepare(`SELECT 'java' AS kind, path, content_hash AS hash FROM main.file
      UNION ALL SELECT 'resource', path, content_hash FROM main.resource_scan ORDER BY kind, path`).iterate() as Iterable<{ kind: string; path: string; hash: string }>) {
    hash.update(`${row.kind}\0${row.path}\0${row.hash}\n`, "utf8");
    if (row.kind === "java") java += 1; else resources += 1;
  }
  return { id: hash.digest("hex"), java, resources };
}

export function buildSnapshotManifest(db: IndexDatabase, sealed: { snapshotId: string; bytes: number; pageSize: number; sha256: string }): SnapshotManifest {
  const content = contentManifestId(db);
  const logical = logicalDigest(db);
  const manifest: SnapshotManifest = {
    formatVersion: SNAPSHOT_MANIFEST_FORMAT,
    snapshotId: sealed.snapshotId,
    schemaVersion: metaNumber(db, "schemaVersion"),
    identityVersion: metaNumber(db, "identityVersion"),
    factsRevision: metaNumber(db, "factsRevision"),
    contentManifestId: content.id,
    sources: { java: content.java, resources: content.resources },
    logical,
    file: { bytes: sealed.bytes, pageSize: sealed.pageSize, pages: sealed.bytes / sealed.pageSize, sha256: sealed.sha256 }
  };
  return parseSnapshotManifest(JSON.parse(JSON.stringify(manifest)));
}

const KEYS = ["contentManifestId", "factsRevision", "file", "formatVersion", "identityVersion", "logical", "schemaVersion", "snapshotId", "sources"];

/** Strict reader: any other format or shape is rejected, never upgraded. */
export function parseSnapshotManifest(value: unknown): SnapshotManifest {
  const fail = (why: string): never => { throw new Error(`invalid snapshot manifest: ${why}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("not an object");
  const m = value as Record<string, unknown>;
  if (m.formatVersion !== SNAPSHOT_MANIFEST_FORMAT) fail(`formatVersion ${String(m.formatVersion)}`);
  if (JSON.stringify(Object.keys(m).sort()) !== JSON.stringify(KEYS)) fail("unexpected fields");
  if (typeof m.snapshotId !== "string" || !SNAPSHOT_ID.test(m.snapshotId)) fail("snapshotId");
  for (const key of ["schemaVersion", "identityVersion", "factsRevision"]) if (!Number.isSafeInteger(m[key]) || (m[key] as number) <= 0) fail(key);
  if (typeof m.contentManifestId !== "string" || !HEX64.test(m.contentManifestId)) fail("contentManifestId");
  const sources = m.sources as Record<string, unknown> | undefined;
  if (!sources || !Number.isSafeInteger(sources.java) || !Number.isSafeInteger(sources.resources)) fail("sources");
  const logical = m.logical as Record<string, unknown> | undefined;
  if (!logical || logical.version !== LOGICAL_EXPORT_VERSION || typeof logical.digest !== "string" || !HEX64.test(logical.digest) || !logical.tables || typeof logical.tables !== "object") fail("logical");
  for (const [table, row] of Object.entries(logical!.tables as Record<string, LogicalTableDigest>)) {
    if (!Number.isSafeInteger(row?.rows) || typeof row?.digest !== "string" || !HEX64.test(row.digest)) fail(`logical table ${table}`);
  }
  const file = m.file as Record<string, unknown> | undefined;
  if (!file || !Number.isSafeInteger(file.bytes) || !Number.isSafeInteger(file.pageSize) || !Number.isSafeInteger(file.pages)
    || (file.pages as number) * (file.pageSize as number) !== file.bytes || typeof file.sha256 !== "string" || !HEX64.test(file.sha256)) fail("file");
  return value as SnapshotManifest;
}

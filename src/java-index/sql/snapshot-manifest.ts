import { createHash } from "node:crypto";
import { computeExtractorVersion, JAVA_FACTS_REVISION } from "../build-fingerprint.js";
import { STABLE_ID_VERSION } from "../stable-id.js";
import type { IndexDatabase } from "./driver.js";
import { SCHEMA_VERSION } from "./schema.js";

// The sealed manifest written next to a published snapshot's index.sqlite
// (contract §2.x). It names what the snapshot logically contains, independent
// of workspace: no root, stat or workspaceId. The publisher (MAC-07 seal.ts)
// fills snapshotId and the file size after the final checkpoint.
// mac2 omitted the unused full logical export digest. mac3 also omits the file
// digest: a delta publish no longer reads the whole file (contract §2.7, plan B);
// the background verifier records it in verified/<snapshotId>.json instead.
export const SNAPSHOT_MANIFEST_FORMAT = "ilv2-snapshot-manifest/mac3";

export type SnapshotManifest = {
  formatVersion: typeof SNAPSHOT_MANIFEST_FORMAT;
  snapshotId: string;
  schemaVersion: number;
  identityVersion: number;
  factsRevision: number;
  /** sha256 over sorted "kind\0path\0contentHash" lines of every indexed Java file and scanned resource. */
  contentManifestId: string;
  /** Which facts this content produced: schema/identity/facts revisions, extractor and build/resolver inputs (§2.3.4). */
  buildKey: string;
  sources: { java: number; resources: number };
  file: { bytes: number; pageSize: number; pages: number };
};

const HEX64 = /^[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9_-]{8,128}$/;

function metaNumber(db: IndexDatabase, key: string): number {
  const value = Number((db.prepare("SELECT value FROM main.meta WHERE key=?").get(key) as { value?: string } | undefined)?.value);
  if (!Number.isSafeInteger(value)) throw new Error(`missing meta ${key}`);
  return value;
}

export type ContentEntry = { kind: "java" | "resource"; path: string; hash: string };

/** The same digest from a capture's census or a snapshot's rows: entries sorted by kind, then path. */
export function contentManifestIdOf(entries: Iterable<ContentEntry>): { id: string; java: number; resources: number } {
  const sorted = [...entries].sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const hash = createHash("sha256");
  let java = 0;
  let resources = 0;
  for (const row of sorted) {
    hash.update(`${row.kind}\0${row.path}\0${row.hash}\n`, "utf8");
    if (row.kind === "java") java += 1; else resources += 1;
  }
  return { id: hash.digest("hex"), java, resources };
}

export function contentManifestId(db: IndexDatabase): { id: string; java: number; resources: number } {
  return contentManifestIdOf(db.prepare(`SELECT 'java' AS kind, path, content_hash AS hash FROM main.file
      UNION ALL SELECT 'resource', path, content_hash FROM main.resource_scan`).all() as ContentEntry[]);
}

/** buildKey of the facts in `db`: the revisions it was written with plus its build/resolver input fingerprint. */
export function buildKeyOf(db: IndexDatabase): string {
  const fingerprint = (db.prepare("SELECT value FROM main.meta WHERE key='buildFingerprint'").get() as { value?: string } | undefined)?.value;
  if (!fingerprint) throw new Error("missing meta buildFingerprint");
  return buildKeyFor({ schemaVersion: metaNumber(db, "schemaVersion"), identityVersion: metaNumber(db, "identityVersion"),
    factsRevision: metaNumber(db, "factsRevision"), buildFingerprint: fingerprint });
}

/** The buildKey a build by this daemon writes for `buildFingerprint` (what a tracker round expects). */
export function currentBuildKey(buildFingerprint: string): string {
  return buildKeyFor({ schemaVersion: SCHEMA_VERSION, identityVersion: STABLE_ID_VERSION, factsRevision: JAVA_FACTS_REVISION, buildFingerprint });
}

/** The key a plan expects, from the same inputs; the extractor is this build of the daemon. */
export function buildKeyFor(input: { schemaVersion: number; identityVersion: number; factsRevision: number; buildFingerprint: string }): string {
  return createHash("sha256").update(JSON.stringify({ schemaVersion: input.schemaVersion, identityVersion: input.identityVersion,
    factsRevision: input.factsRevision, extractor: computeExtractorVersion(), buildFingerprint: input.buildFingerprint })).digest("hex");
}

export function buildSnapshotManifest(db: IndexDatabase, sealed: { snapshotId: string; bytes: number; pageSize: number }): SnapshotManifest {
  const content = contentManifestId(db);
  const manifest: SnapshotManifest = {
    formatVersion: SNAPSHOT_MANIFEST_FORMAT,
    snapshotId: sealed.snapshotId,
    schemaVersion: metaNumber(db, "schemaVersion"),
    identityVersion: metaNumber(db, "identityVersion"),
    factsRevision: metaNumber(db, "factsRevision"),
    contentManifestId: content.id,
    buildKey: buildKeyOf(db),
    sources: { java: content.java, resources: content.resources },
    file: { bytes: sealed.bytes, pageSize: sealed.pageSize, pages: sealed.bytes / sealed.pageSize }
  };
  return parseSnapshotManifest(JSON.parse(JSON.stringify(manifest)));
}

const KEYS = ["buildKey", "contentManifestId", "factsRevision", "file", "formatVersion", "identityVersion", "schemaVersion", "snapshotId", "sources"];

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
  if (typeof m.buildKey !== "string" || !HEX64.test(m.buildKey)) fail("buildKey");
  const sources = m.sources as Record<string, unknown> | undefined;
  if (!sources || !Number.isSafeInteger(sources.java) || !Number.isSafeInteger(sources.resources)) fail("sources");
  const file = m.file as Record<string, unknown> | undefined;
  if (!file || !Number.isSafeInteger(file.bytes) || !Number.isSafeInteger(file.pageSize) || !Number.isSafeInteger(file.pages)
    || (file.pages as number) * (file.pageSize as number) !== file.bytes || JSON.stringify(Object.keys(file).sort()) !== '["bytes","pageSize","pages"]') fail("file");
  return value as SnapshotManifest;
}

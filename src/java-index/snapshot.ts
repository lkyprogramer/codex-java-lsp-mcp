import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type {
  JavaFieldFacts,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  SourceRootCoverage,
  StaticEdge
} from "./index-types.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type JavaIndexSnapshotV2 = {
  schemaVersion: 2;
  extractorVersion: string;
  stableIdVersion: number;
  canonicalRepoRoot: string;
  buildFingerprint: string;
  manifestFingerprint: string;
  indexedGeneration: number;
  createdAt: string;
  coverage: SourceRootCoverage[];
  files: JavaFileFacts[];
  types: JavaTypeFacts[];
  fields: JavaFieldFacts[];
  methods: JavaMethodFacts[];
  edges: StaticEdge[];
};

/**
 * The identity a normal own-repo snapshot load must match exactly.
 * `manifestFingerprint` is deliberately excluded here: comparing it requires
 * an independent re-scan of the repo's current files (Step 6a's job, at a
 * higher layer than this module), not a static value known before loading.
 */
export type SnapshotIdentity = {
  extractorVersion: string;
  stableIdVersion: number;
  canonicalRepoRoot: string;
  buildFingerprint: string;
};

export type SnapshotWriteHooks = {
  /**
   * Runs after the temp file is fully written+synced but before the atomic
   * rename. Crash tests use it to inject a failure at that exact point.
   * Production callers (Step 6a's publish-if-current check) also use it: by
   * throwing here when the store's current facts no longer match the
   * manifest fingerprint the snapshot was serialized from, a concurrent
   * mutation that landed mid-write aborts the rename instead of publishing a
   * snapshot that is already stale the instant it lands.
   */
  beforeRename?: () => Promise<void>;
};

/**
 * Writes `value` as gzipped JSON via write-temp + fsync + rename + best-effort
 * directory fsync, so a crash or failure at any point before the rename
 * leaves the previous `target` (if any) untouched and fully readable. Returns
 * the compressed byte size actually written.
 */
export async function writeSnapshotAtomic(
  target: string,
  value: JavaIndexSnapshotV2,
  hooks: SnapshotWriteHooks = {}
): Promise<number> {
  const directory = path.dirname(target);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const json = Buffer.from(JSON.stringify(value));
  const compressed = await gzipAsync(json, { level: 6 });
  await mkdir(directory, { recursive: true });
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(compressed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks.beforeRename?.();
    await rename(tmp, target);
    await fsyncDirectoryBestEffort(directory);
    return compressed.length;
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Publishes a snapshot only if an independent re-scan still observes the
 * manifest it was serialized from. The callback deliberately belongs at the
 * atomic writer boundary: checking the in-memory store cannot detect a file
 * edit that arrived after the last refresh but before rename.
 */
export async function writeSnapshotIfManifestCurrent(
  target: string,
  value: JavaIndexSnapshotV2,
  currentManifestFingerprint: () => Promise<string>
): Promise<number> {
  return writeSnapshotAtomic(target, value, {
    beforeRename: async () => {
      if (await currentManifestFingerprint() !== value.manifestFingerprint) {
        throw new Error("manifest changed before snapshot publish");
      }
    }
  });
}

/** Directory fsync support varies by filesystem; this is a rebuildable cache, so a lack of support is not an error. */
async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
  } finally {
    await handle?.close();
  }
}

async function discard(target: string, reason: string): Promise<undefined> {
  console.error(`[codex-java-lsp] discarding Java index snapshot at ${target}: ${reason}`);
  await rm(target, { force: true }).catch(() => undefined);
  return undefined;
}

type ParsedSnapshot = { snapshot: Partial<JavaIndexSnapshotV2> } | { error: string };

// Shared by both loaders: reads, gunzips, JSON-parses, and checks
// schemaVersion. Never throws - a missing file is `undefined` (a miss, not
// an error); anything else unreadable is `{ error }`, leaving what happens
// next (delete it vs. leave someone else's cache alone) to the caller.
async function parseSnapshotFile(target: string): Promise<ParsedSnapshot | undefined> {
  let compressed: Buffer;
  try {
    compressed = await readFile(target);
  } catch {
    return undefined;
  }
  let json: Buffer;
  try {
    json = await gunzipAsync(compressed);
  } catch {
    return { error: "invalid gzip stream" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.toString("utf8"));
  } catch {
    return { error: "invalid JSON payload" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: "payload is not an object" };
  }
  const snapshot = parsed as Partial<JavaIndexSnapshotV2>;
  if (snapshot.schemaVersion !== 2) {
    return { error: `unsupported schemaVersion ${String(snapshot.schemaVersion)}` };
  }
  return { snapshot };
}

/**
 * Loads and validates a snapshot for a *normal own-repo* load: any corruption
 * (bad gzip, bad JSON, wrong schemaVersion) or identity mismatch (extractor,
 * stableId, canonicalRepoRoot, buildFingerprint) is treated as unusable,
 * logged once, and the file is deleted (this is a rebuildable cache, not a
 * durable store - no timestamped corrupt copies are retained). Never throws;
 * a miss is `undefined`, matching every other "index not ready" path in this
 * module. `manifestFingerprint` is intentionally not checked here (see
 * `SnapshotIdentity`'s own doc comment) - Step 6a compares it separately
 * after an independent manifest re-scan.
 *
 * This function's delete-on-mismatch behavior is specific to trusting one's
 * *own* cache directory; use `loadSiblingSnapshot` instead to validate a
 * snapshot found in a *different* worktree's cache before deciding whether
 * to seed from it (Task 21a), since an expected canonicalRepoRoot mismatch
 * there is normal, not corruption, and must never delete the sibling's own
 * valid snapshot.
 */
export async function loadSnapshot(
  target: string,
  expected: SnapshotIdentity
): Promise<JavaIndexSnapshotV2 | undefined> {
  const parsed = await parseSnapshotFile(target);
  if (!parsed) return undefined;
  if ("error" in parsed) return discard(target, parsed.error);
  const snapshot = parsed.snapshot;
  if (snapshot.extractorVersion !== expected.extractorVersion) {
    return discard(target, "extractorVersion mismatch");
  }
  if (snapshot.stableIdVersion !== expected.stableIdVersion) {
    return discard(target, "stableIdVersion mismatch");
  }
  if (snapshot.canonicalRepoRoot !== expected.canonicalRepoRoot) {
    return discard(target, "canonicalRepoRoot mismatch");
  }
  if (snapshot.buildFingerprint !== expected.buildFingerprint) {
    return discard(target, "buildFingerprint mismatch");
  }
  return snapshot as JavaIndexSnapshotV2;
}

/** The identity a sibling worktree's snapshot must match to be seed-eligible; `canonicalRepoRoot` is deliberately excluded - a sibling legitimately has a different one. */
export type SiblingSnapshotIdentity = Omit<SnapshotIdentity, "canonicalRepoRoot">;

/**
 * Reads and validates a snapshot found in a *different* worktree's cache
 * directory (Task 21a candidate evaluation). Unlike `loadSnapshot`, this
 * never deletes or otherwise mutates the file on any failure or mismatch -
 * it is someone else's (possibly still-active) cache, not this reader's to
 * manage - and a mismatch (including a corrupt file) is simply not a seed
 * candidate, reported the same way as a miss (`undefined`).
 */
export async function loadSiblingSnapshot(
  target: string,
  expected: SiblingSnapshotIdentity
): Promise<JavaIndexSnapshotV2 | undefined> {
  const parsed = await parseSnapshotFile(target);
  if (!parsed || "error" in parsed) return undefined;
  const snapshot = parsed.snapshot;
  if (snapshot.extractorVersion !== expected.extractorVersion) return undefined;
  if (snapshot.stableIdVersion !== expected.stableIdVersion) return undefined;
  if (snapshot.buildFingerprint !== expected.buildFingerprint) return undefined;
  return snapshot as JavaIndexSnapshotV2;
}

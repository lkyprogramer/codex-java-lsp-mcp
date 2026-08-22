import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type {
  JavaFieldFacts,
  JavaFileFacts,
  JavaMethodFacts,
  JavaTypeFacts,
  MyBatisResourceCoverage,
  SourceRootCoverage,
  StaticEdge
} from "./index-types.js";
import type { MyBatisMapperResourceFacts } from "./mybatis-types.js";
import type { EntitySearchSnapshot } from "./entity-search.js";
import {
  decodeSnapshotV4View,
  encodeSnapshotV4,
  isSnapshotV4,
  type SnapshotV4Facts,
  type SnapshotV4View
} from "./snapshot-v4.js";

/**
 * schemaVersion 3 (Task 28 Slice C) added myBatisResources/resourceCoverage;
 * there is no migration from schema 2 - a mismatch is deleted and rebuilt
 * (parseSnapshotFile below), so no schema-2 type is kept around.
 */
export type JavaIndexSnapshotV3 = {
  schemaVersion: 3;
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
  myBatisResources: MyBatisMapperResourceFacts[];
  resourceCoverage: MyBatisResourceCoverage[];
  /** Derived LocAgent entry index. Optional so schema-3 snapshots without it rebuild from facts. */
  entitySearch?: EntitySearchSnapshot;
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
 * Writes `value` as a v4 segmented snapshot via write-temp + fsync + rename +
 * best-effort directory fsync. A crash before rename leaves the previous
 * `target` untouched. Returns the byte size actually written.
 */
export async function writeSnapshotAtomic(
  target: string,
  value: JavaIndexSnapshotV3,
  hooks: SnapshotWriteHooks = {}
): Promise<number> {
  const directory = path.dirname(target);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const encoded = encodeSnapshotV4(toV4Facts(value));
  await mkdir(directory, { recursive: true });
  try {
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks.beforeRename?.();
    await rename(tmp, target);
    await fsyncDirectoryBestEffort(directory);
    return encoded.length;
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
  value: JavaIndexSnapshotV3,
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

type ParsedSnapshot = { view: SnapshotV4View } | { error: string };

async function parseSnapshotFile(target: string): Promise<ParsedSnapshot | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch {
    return undefined;
  }
  if (!isSnapshotV4(bytes)) {
    return { error: "unsupported on-disk snapshot (v3 gzip JSON is discarded, not migrated)" };
  }
  const view = decodeSnapshotV4View(bytes, target);
  if ("error" in view) return view;
  return { view };
}

function headerIdentity(view: SnapshotV4View) {
  return {
    extractorVersion: view.header.extractorVersion,
    stableIdVersion: view.header.stableIdVersion,
    canonicalRepoRoot: view.header.canonicalRepoRoot,
    buildFingerprint: view.header.buildFingerprint
  };
}

function toV4Facts(value: JavaIndexSnapshotV3): SnapshotV4Facts {
  return {
    extractorVersion: value.extractorVersion,
    stableIdVersion: value.stableIdVersion,
    canonicalRepoRoot: value.canonicalRepoRoot,
    buildFingerprint: value.buildFingerprint,
    manifestFingerprint: value.manifestFingerprint,
    indexedGeneration: value.indexedGeneration,
    createdAt: value.createdAt,
    coverage: value.coverage,
    resourceCoverage: value.resourceCoverage,
    files: value.files,
    types: value.types,
    fields: value.fields,
    methods: value.methods,
    edges: value.edges,
    myBatisResources: value.myBatisResources,
    entitySearch: value.entitySearch
  };
}

function factsToV3(value: SnapshotV4Facts): JavaIndexSnapshotV3 {
  return {
    schemaVersion: 3,
    extractorVersion: value.extractorVersion,
    stableIdVersion: value.stableIdVersion,
    canonicalRepoRoot: value.canonicalRepoRoot,
    buildFingerprint: value.buildFingerprint,
    manifestFingerprint: value.manifestFingerprint,
    indexedGeneration: value.indexedGeneration,
    createdAt: value.createdAt,
    coverage: value.coverage,
    resourceCoverage: value.resourceCoverage,
    files: value.files,
    types: value.types,
    fields: value.fields,
    methods: value.methods,
    edges: value.edges,
    myBatisResources: value.myBatisResources,
    ...(value.entitySearch ? { entitySearch: value.entitySearch } : {})
  };
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
): Promise<JavaIndexSnapshotV3 | undefined> {
  const parsed = await parseSnapshotFile(target);
  if (!parsed) return undefined;
  if ("error" in parsed) return discard(target, parsed.error);
  if (!identityMatches(headerIdentity(parsed.view), expected, true)) {
    return discard(target, "snapshot identity mismatch");
  }
  try {
    return factsToV3(parsed.view.toFacts());
  } catch (error) {
    return discard(target, error instanceof Error ? error.message : String(error));
  }
}

/** Files + coverage only. Rest segments reread from disk; the snapshot Buffer is not retained. */
export async function loadSnapshotView(
  target: string,
  expected: SnapshotIdentity
): Promise<SnapshotV4View | undefined> {
  const parsed = await parseSnapshotFile(target);
  if (!parsed) return undefined;
  if ("error" in parsed) return discard(target, parsed.error);
  if (!identityMatches(headerIdentity(parsed.view), expected, true)) {
    return discard(target, "snapshot identity mismatch");
  }
  return parsed.view;
}

function identityMatches(
  snapshot: Pick<JavaIndexSnapshotV3, "extractorVersion" | "stableIdVersion" | "canonicalRepoRoot" | "buildFingerprint">,
  expected: SnapshotIdentity,
  checkRepoRoot: boolean
): boolean {
  if (snapshot.extractorVersion !== expected.extractorVersion) return false;
  if (snapshot.stableIdVersion !== expected.stableIdVersion) return false;
  if (snapshot.buildFingerprint !== expected.buildFingerprint) return false;
  if (checkRepoRoot && snapshot.canonicalRepoRoot !== expected.canonicalRepoRoot) return false;
  return true;
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
): Promise<JavaIndexSnapshotV3 | undefined> {
  const parsed = await parseSnapshotFile(target);
  if (!parsed || "error" in parsed) return undefined;
  if (!identityMatches(headerIdentity(parsed.view), { ...expected, canonicalRepoRoot: parsed.view.header.canonicalRepoRoot }, false)) {
    return undefined;
  }
  try {
    return factsToV3(parsed.view.toFacts());
  } catch {
    return undefined;
  }
}

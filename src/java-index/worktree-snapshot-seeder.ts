// input: A target worktree's identity/repoRoot/layout plus a machine-wide cache base.
// output: A DEGRADED, not-yet-published JavaIndexStore seeded from a validated sibling snapshot.
// pos: Task 21a - lets a freshly opened linked worktree reuse an already-indexed
//      sibling's facts for content that has not changed, instead of a cold sweep.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { LayoutContext } from "../layout-probe.js";
import type { WorktreeIdentity } from "../worktree-identity.js";
import { JavaIndexStore } from "./index-store.js";
import { scanCurrentManifestStable, scanCurrentMyBatisManifestStable } from "./manifest.js";
import { loadSiblingSnapshot, type SiblingSnapshotIdentity } from "./snapshot.js";

const SNAPSHOT_FILE_NAME = "java-index-snapshot.json.gz";
const REPO_META_FILE_NAME = "repo-meta.json";

export type WorktreeSeedCandidate = {
  sourceRepoRoot: string;
  sourceRepoHash: string;
  sourceSnapshotPath: string;
  createdAt: string;
  indexedGeneration: number;
  buildFingerprint: string;
  manifestFingerprint: string;
  fingerprintMatched: boolean;
};

/** `findCandidate()` scan diagnostics (V3.2-19), independent of whether a candidate was picked. */
export type WorktreeScanTelemetry = {
  cacheDirsScanned: number;
  eligibleSnapshots: number;
  metaMissing: number;
  selfSkip: number;
  familyMismatch: number;
  identityMismatch: number;
  coverageIncomplete: number;
};

export type WorktreeSeedResult = {
  sourceRepoHash?: string;
  targetGeneration: number;
  reusedPaths: string[];
  dirtyPaths: string[];
  deletedSourcePaths: string[];
  relinkPaths: string[];
  droppedCrossFileEdges: number;
  /** Framework relationships are derived from facts at request time, never persisted as store edges. */
  droppedFrameworkEdges: number;
  manifestValidationMs: number;
  /** Time to load and decompress the winning candidate's snapshot file (V3.2-19). */
  candidateDecompressMs: number;
  /** Time for the pre-load target manifest scan that reuse eligibility is checked against (V3.2-19). */
  initialManifestScanMs: number;
  /** Time for the re-scan at the publication boundary that invalidates any reuse a late write raced (V3.2-19). */
  finalManifestScanMs: number;
  reusedFiles: number;
  /**
   * MyBatis resources reused from the sibling's snapshot / re-derived fresh
   * because they were missing, changed, or new since the sibling indexed
   * them (Task 28 Slice C). Framework evidence is derived from those facts at
   * request time, so `droppedFrameworkEdges` is always zero rather than a
   * hidden/omitted metric.
   */
  reusedResources: number;
  dirtyResources: number;
  coverage: "DEGRADED";
  negativeLookupAllowed: false;
};

/** Test-only timing seam for the final validation boundary. */
export type WorktreeSeedValidationHooks = {
  beforeFinalValidation?: () => void | Promise<void>;
};

function emptySeedResult(targetGeneration: number): WorktreeSeedResult {
  return {
    targetGeneration,
    reusedPaths: [],
    dirtyPaths: [],
    deletedSourcePaths: [],
    relinkPaths: [],
    droppedCrossFileEdges: 0,
    droppedFrameworkEdges: 0,
    manifestValidationMs: 0,
    candidateDecompressMs: 0,
    initialManifestScanMs: 0,
    finalManifestScanMs: 0,
    reusedFiles: 0,
    reusedResources: 0,
    dirtyResources: 0,
    coverage: "DEGRADED",
    negativeLookupAllowed: false
  };
}

type RepoCacheMetaFields = { repoRoot?: string; repoHash?: string; familyHash?: string };

// A minimal, best-effort read of the shared repo-meta.json shape
// (worktree-cache-cleanup.ts owns the full janitor schema); a missing or
// unparsable file just means "no candidate signal from this cache dir," the
// same treatment the janitor gives it, not an error.
function readRepoCacheMetaFields(cacheRoot: string): RepoCacheMetaFields | undefined {
  try {
    return JSON.parse(readFileSync(path.join(cacheRoot, REPO_META_FILE_NAME), "utf8")) as RepoCacheMetaFields;
  } catch {
    return undefined;
  }
}

export class WorktreeSnapshotSeeder {
  /**
   * Diagnostics from the most recent `findCandidate()` call (V3.2-19). A
   * fresh instance is constructed per seed attempt (`attemptSiblingSeed`),
   * so this last-call side channel never crosses call boundaries.
   */
  lastScanTelemetry: WorktreeScanTelemetry = {
    cacheDirsScanned: 0,
    eligibleSnapshots: 0,
    metaMissing: 0,
    selfSkip: 0,
    familyMismatch: 0,
    identityMismatch: 0,
    coverageIncomplete: 0
  };

  /**
   * Scans every cache directory under `cacheBase` for a sibling worktree's
   * snapshot: same family (shared Git common-dir) as `target`, a different
   * repo, and a snapshot that is extractor/stableId compatible, COMPLETE for
   * every root it covers, and free of any failed or recovered file (a
   * healthy-but-imperfect source must never be reused, since its own imperfect
   * facts would become the target's without the target ever having verified
   * them). `buildFingerprint` is recorded (`fingerprintMatched`) but does not
   * veto: per-file contentHash + sourceRoot checks in `seedValidatedFacts`
   * already cover content and layout drift. Deterministic tie-break:
   * fingerprint match first, then newest `createdAt`, then `sourceRepoHash`.
   */
  async findCandidate(
    target: WorktreeIdentity,
    identity: SiblingSnapshotIdentity,
    cacheBase: string
  ): Promise<WorktreeSeedCandidate | undefined> {
    if (!existsSync(cacheBase)) return undefined;
    const familyKey = target.familyHash ?? target.repoHash;
    const candidates: WorktreeSeedCandidate[] = [];
    let cacheDirsScanned = 0;
    let metaMissing = 0;
    let selfSkip = 0;
    let familyMismatch = 0;
    let identityMismatch = 0;
    let coverageIncomplete = 0;
    for (const entry of readdirSync(cacheBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      cacheDirsScanned += 1;
      const cacheRoot = path.join(cacheBase, entry.name);
      const meta = readRepoCacheMetaFields(cacheRoot);
      if (!meta?.repoRoot || !meta.repoHash) {
        metaMissing += 1;
        continue;
      }
      if (meta.repoHash === target.repoHash) {
        selfSkip += 1;
        continue;
      }
      if ((meta.familyHash ?? meta.repoHash) !== familyKey) {
        familyMismatch += 1;
        continue;
      }
      const sourceSnapshotPath = path.join(cacheRoot, SNAPSHOT_FILE_NAME);
      const loaded = await loadSiblingSnapshot(sourceSnapshotPath, identity);
      if (!loaded) {
        identityMismatch += 1;
        continue;
      }
      const snapshot = loaded.snapshot;
      if (snapshot.coverage.length === 0) {
        coverageIncomplete += 1;
        continue;
      }
      const allHealthyComplete = snapshot.coverage.every(
        root => root.state === "COMPLETE" && root.failedFiles === 0 && root.recoveredFiles === 0
      );
      if (!allHealthyComplete) {
        coverageIncomplete += 1;
        continue;
      }
      candidates.push({
        sourceRepoRoot: meta.repoRoot,
        sourceRepoHash: meta.repoHash,
        sourceSnapshotPath,
        createdAt: snapshot.createdAt,
        indexedGeneration: snapshot.indexedGeneration,
        buildFingerprint: snapshot.buildFingerprint,
        manifestFingerprint: snapshot.manifestFingerprint,
        fingerprintMatched: loaded.fingerprintMatched
      });
    }
    this.lastScanTelemetry = {
      cacheDirsScanned,
      eligibleSnapshots: candidates.length,
      metaMissing,
      selfSkip,
      familyMismatch,
      identityMismatch,
      coverageIncomplete
    };
    if (candidates.length === 0) {
      console.error(
        `[codex-java-lsp] worktree seed found no candidate family=${familyKey} scanned=${cacheDirsScanned} metaMissing=${metaMissing} selfSkip=${selfSkip} familyMismatch=${familyMismatch} identityMismatch=${identityMismatch} coverageIncomplete=${coverageIncomplete}`
      );
      return undefined;
    }
    candidates.sort((a, b) =>
      Number(b.fingerprintMatched) - Number(a.fingerprintMatched)
      || b.createdAt.localeCompare(a.createdAt)
      || a.sourceRepoHash.localeCompare(b.sourceRepoHash)
    );
    return candidates[0];
  }

  /**
   * Builds a fresh, not-yet-published `JavaIndexStore` from `candidate`'s
   * snapshot, keeping only facts for files whose *target-side* content
   * (read via `scanCurrentManifestStable`, so a file mutated mid-read is
   * never trusted) exactly matches what the source snapshot recorded -
   * same relativePath, contentHash, and sourceRoot. Every other source file
   * is dropped via `JavaIndexStore.removeFiles()`, whose return value (files
   * with a now-dangling edge into a dropped node) is exactly the RELINK_ONLY
   * set Step 4.5 describes - a repurposing of the same dangling-edge
   * detection Task 19 built for deletes, not a new algorithm.
   * `removeFiles` only deletes the *removed* files' own edges though, so
   * each RELINK_ONLY file's own stale edge (into the node that removal just
   * deleted) is separately dropped via `dropOwnedEdges` - a resolved edge
   * must never survive into the seeded store pointing at a type/method/field
   * id that no longer exists in it.
   *
   * The result is always DEGRADED/`negativeLookupAllowed: false`: only the
   * caller's own subsequent reconcile (parsing every dirty/new file and
   * revisiting every relink candidate) may promote coverage to COMPLETE.
   * Reused facts are stamped into `targetGeneration`, not the source
   * snapshot's own generation, which is discarded once validation is done.
   *
   * The runtime starts its coordinator before OPEN and flushes batches after
   * this method returns. This method adds the complementary local guard for
   * the narrower race inside the worker: it takes a second stable manifest
   * scan immediately before returning the store and removes any fact no
   * longer matching that final scan. Together those boundaries mean neither
   * a watcher-delivered change nor a write that lands during validation can
   * be published as a reusable current fact.
   */
  async seedValidatedFacts(
    candidate: WorktreeSeedCandidate,
    identity: SiblingSnapshotIdentity,
    targetRepoRoot: string,
    targetLayout: LayoutContext,
    targetGeneration: number,
    hooks: WorktreeSeedValidationHooks = {}
  ): Promise<{ result: WorktreeSeedResult; store: JavaIndexStore }> {
    const start = Date.now();
    const decompressStart = Date.now();
    const loaded = await loadSiblingSnapshot(candidate.sourceSnapshotPath, identity);
    const snapshot = loaded?.snapshot;
    const candidateDecompressMs = Date.now() - decompressStart;
    if (!snapshot) {
      // Disappeared, or changed shape, since findCandidate looked at it.
      return { result: { ...emptySeedResult(targetGeneration), candidateDecompressMs }, store: new JavaIndexStore() };
    }

    const initialManifestScanStart = Date.now();
    const [{ entries, unstablePaths }, resourceManifest] = await Promise.all([
      scanCurrentManifestStable(targetRepoRoot, targetLayout),
      scanCurrentMyBatisManifestStable(targetRepoRoot, targetLayout)
    ]);
    const initialManifestScanMs = Date.now() - initialManifestScanStart;
    const unstable = new Set(unstablePaths);
    const targetEntryByPath = new Map(entries.map(entry => [entry.relativePath, entry]));
    const resourceUnstable = new Set(resourceManifest.unstablePaths);
    const targetResourceEntryByPath = new Map(resourceManifest.entries.map(entry => [entry.relativePath, entry]));

    const store = new JavaIndexStore();
    store.loadSnapshotData({
      files: snapshot.files,
      types: snapshot.types,
      fields: snapshot.fields,
      methods: snapshot.methods,
      edges: snapshot.edges,
      myBatisResources: snapshot.myBatisResources
    });

    const reusedPaths: string[] = [];
    const nonReusedSourcePaths: string[] = [];
    for (const file of snapshot.files) {
      const targetEntry = targetEntryByPath.get(file.relativePath);
      const reusable = !unstable.has(file.relativePath)
        && targetEntry !== undefined
        && targetEntry.contentHash === file.contentHash
        && targetEntry.sourceRoot === file.sourceRoot;
      if (reusable) reusedPaths.push(file.relativePath);
      else nonReusedSourcePaths.push(file.relativePath);
    }

    // MyBatis resources have no persisted cross-resource edges (Slice D
    // name-matches Java and resource facts fresh at read time, not via a
    // stored graph), so reuse here is a plain content-hash filter - no
    // relink/dangling-edge bookkeeping like the Java loop above needs.
    const reusedResourcePaths: string[] = [];
    const nonReusedResourcePaths: string[] = [];
    for (const resource of snapshot.myBatisResources) {
      const targetEntry = targetResourceEntryByPath.get(resource.relativePath);
      const reusable = !resourceUnstable.has(resource.relativePath)
        && targetEntry !== undefined
        && targetEntry.contentHash === resource.contentHash;
      if (reusable) reusedResourcePaths.push(resource.relativePath);
      else nonReusedResourcePaths.push(resource.relativePath);
    }
    store.removeMyBatisResources(nonReusedResourcePaths);

    const edgesBeforeRemoval = store.edgesById.size;
    let relinkPaths = store.removeFiles(nonReusedSourcePaths);
    const droppedByRemoval = edgesBeforeRemoval - store.edgesById.size;
    // removeFiles only deletes the *removed* files' own edges; a surviving
    // (reused) dependent's edge into a node that removal just deleted is
    // reported in relinkPaths but left dangling by design (the caller
    // decides how to re-resolve it) - the seeder has no re-resolution step,
    // so it must drop those stale edges itself rather than publish them.
    let droppedCrossFileEdges = droppedByRemoval + store.dropOwnedEdges(relinkPaths);

    // A file may change after the first stable read but before this fresh
    // store is installed by the worker. Re-scan at that exact publication
    // boundary and evict any formerly reusable facts that no longer match.
    await hooks.beforeFinalValidation?.();
    const finalManifestScanStart = Date.now();
    const [finalManifest, finalResourceManifest] = await Promise.all([
      scanCurrentManifestStable(targetRepoRoot, targetLayout),
      scanCurrentMyBatisManifestStable(targetRepoRoot, targetLayout)
    ]);
    const finalManifestScanMs = Date.now() - finalManifestScanStart;
    const finalUnstable = new Set(finalManifest.unstablePaths);
    const finalEntriesByPath = new Map(finalManifest.entries.map(entry => [entry.relativePath, entry]));
    const snapshotFilesByPath = new Map(snapshot.files.map(file => [file.relativePath, file]));
    const invalidatedReusePaths = reusedPaths.filter(relativePath => {
      const snapshotFile = snapshotFilesByPath.get(relativePath);
      const finalEntry = finalEntriesByPath.get(relativePath);
      return finalUnstable.has(relativePath)
        || !snapshotFile
        || !finalEntry
        || finalEntry.contentHash !== snapshotFile.contentHash
        || finalEntry.sourceRoot !== snapshotFile.sourceRoot;
    });
    if (invalidatedReusePaths.length > 0) {
      const edgesBeforeFinalRemoval = store.edgesById.size;
      const finalRelinkPaths = store.removeFiles(invalidatedReusePaths);
      droppedCrossFileEdges += edgesBeforeFinalRemoval - store.edgesById.size;
      droppedCrossFileEdges += store.dropOwnedEdges(finalRelinkPaths);
      relinkPaths = [...new Set([...relinkPaths, ...finalRelinkPaths])];
      const invalidated = new Set(invalidatedReusePaths);
      for (let index = reusedPaths.length - 1; index >= 0; index -= 1) {
        if (invalidated.has(reusedPaths[index]!)) reusedPaths.splice(index, 1);
      }
    }
    store.stampGeneration(reusedPaths, targetGeneration);

    const finalResourceUnstable = new Set(finalResourceManifest.unstablePaths);
    const finalResourceEntriesByPath = new Map(finalResourceManifest.entries.map(entry => [entry.relativePath, entry]));
    const snapshotResourcesByPath = new Map(snapshot.myBatisResources.map(resource => [resource.relativePath, resource]));
    const invalidatedResourceReusePaths = reusedResourcePaths.filter(relativePath => {
      const snapshotResource = snapshotResourcesByPath.get(relativePath);
      const finalEntry = finalResourceEntriesByPath.get(relativePath);
      return finalResourceUnstable.has(relativePath)
        || !snapshotResource
        || !finalEntry
        || finalEntry.contentHash !== snapshotResource.contentHash;
    });
    if (invalidatedResourceReusePaths.length > 0) {
      store.removeMyBatisResources(invalidatedResourceReusePaths);
      const invalidated = new Set(invalidatedResourceReusePaths);
      for (let index = reusedResourcePaths.length - 1; index >= 0; index -= 1) {
        if (invalidated.has(reusedResourcePaths[index]!)) reusedResourcePaths.splice(index, 1);
      }
    }
    for (const relativePath of reusedResourcePaths) {
      const resource = store.myBatisResource(relativePath);
      if (resource) store.replaceMyBatisResource({ ...resource, generation: targetGeneration });
    }

    const reusedSet = new Set(reusedPaths);
    const dirtyPaths = finalManifest.discovered
      .map(file => file.relativePath)
      .filter(relativePath => !reusedSet.has(relativePath));
    const sourcePaths = new Set(snapshot.files.map(file => file.relativePath));
    const finalTargetPaths = new Set(finalManifest.discovered.map(file => file.relativePath));
    const deletedSourcePaths = [...sourcePaths].filter(relativePath => !finalTargetPaths.has(relativePath));

    const reusedResourceSet = new Set(reusedResourcePaths);
    const dirtyResources = finalResourceManifest.discovered
      .map(file => file.relativePath)
      .filter(relativePath => !reusedResourceSet.has(relativePath)).length;

    const result: WorktreeSeedResult = {
      sourceRepoHash: candidate.sourceRepoHash,
      targetGeneration,
      reusedPaths: reusedPaths.sort(),
      dirtyPaths: dirtyPaths.sort(),
      deletedSourcePaths: deletedSourcePaths.sort(),
      relinkPaths: relinkPaths.sort(),
      droppedCrossFileEdges,
      droppedFrameworkEdges: 0,
      manifestValidationMs: Date.now() - start,
      candidateDecompressMs,
      initialManifestScanMs,
      finalManifestScanMs,
      reusedFiles: reusedPaths.length,
      reusedResources: reusedResourcePaths.length,
      dirtyResources,
      coverage: "DEGRADED",
      negativeLookupAllowed: false
    };
    return { result, store };
  }
}

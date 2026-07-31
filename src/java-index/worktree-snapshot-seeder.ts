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
};

export type WorktreeSeedResult = {
  sourceRepoHash?: string;
  targetGeneration: number;
  reusedPaths: string[];
  dirtyPaths: string[];
  deletedSourcePaths: string[];
  relinkPaths: string[];
  droppedCrossFileEdges: number;
  manifestValidationMs: number;
  reusedFiles: number;
  /**
   * MyBatis resources reused from the sibling's snapshot / re-derived fresh
   * because they were missing, changed, or new since the sibling indexed
   * them (Task 28 Slice C). No `droppedFrameworkEdges` field: unlike Java's
   * static edges, a MyBatis Java<->XML relationship is never a persisted
   * store edge - the adapter (Task 28 Slice D) name-matches Java and
   * resource facts fresh at read time, the same as the Spring pack does for
   * its own framework relationships - so there is no edge for seeding to
   * drop, and a `resourceCoverage`-gated relink queue is unnecessary: a
   * dirty resource simply is not loaded into the store at all here, and the
   * caller's normal post-seed sweep (Task 28 Slice B's indexMyBatisResources)
   * re-derives it exactly like a cold open would.
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
    manifestValidationMs: 0,
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
   * Scans every cache directory under `cacheBase` for a sibling worktree's
   * snapshot: same family (shared Git common-dir) as `target`, a different
   * repo, and a snapshot that is schema/extractor/stableId/buildFingerprint
   * compatible, COMPLETE for every root it covers, and free of any failed or
   * recovered file (a healthy-but-imperfect source must never be reused,
   * since its own imperfect facts would become the target's without the
   * target ever having verified them). Deterministic tie-break: newest
   * `createdAt`, then `sourceRepoHash`.
   */
  async findCandidate(
    target: WorktreeIdentity,
    identity: SiblingSnapshotIdentity,
    cacheBase: string
  ): Promise<WorktreeSeedCandidate | undefined> {
    if (!existsSync(cacheBase)) return undefined;
    const familyKey = target.familyHash ?? target.repoHash;
    const candidates: WorktreeSeedCandidate[] = [];
    for (const entry of readdirSync(cacheBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cacheRoot = path.join(cacheBase, entry.name);
      const meta = readRepoCacheMetaFields(cacheRoot);
      if (!meta?.repoRoot || !meta.repoHash) continue;
      if (meta.repoHash === target.repoHash) continue; // never seed from the target itself
      if ((meta.familyHash ?? meta.repoHash) !== familyKey) continue;
      const sourceSnapshotPath = path.join(cacheRoot, SNAPSHOT_FILE_NAME);
      const snapshot = await loadSiblingSnapshot(sourceSnapshotPath, identity);
      if (!snapshot) continue;
      if (snapshot.coverage.length === 0) continue;
      const allHealthyComplete = snapshot.coverage.every(
        root => root.state === "COMPLETE" && root.failedFiles === 0 && root.recoveredFiles === 0
      );
      if (!allHealthyComplete) continue;
      candidates.push({
        sourceRepoRoot: meta.repoRoot,
        sourceRepoHash: meta.repoHash,
        sourceSnapshotPath,
        createdAt: snapshot.createdAt,
        indexedGeneration: snapshot.indexedGeneration,
        buildFingerprint: snapshot.buildFingerprint,
        manifestFingerprint: snapshot.manifestFingerprint
      });
    }
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.sourceRepoHash.localeCompare(b.sourceRepoHash));
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
    const snapshot = await loadSiblingSnapshot(candidate.sourceSnapshotPath, identity);
    if (!snapshot) {
      // Disappeared, or changed shape, since findCandidate looked at it.
      return { result: emptySeedResult(targetGeneration), store: new JavaIndexStore() };
    }

    const [{ entries, unstablePaths }, resourceManifest] = await Promise.all([
      scanCurrentManifestStable(targetRepoRoot, targetLayout),
      scanCurrentMyBatisManifestStable(targetRepoRoot, targetLayout)
    ]);
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
    const [finalManifest, finalResourceManifest] = await Promise.all([
      scanCurrentManifestStable(targetRepoRoot, targetLayout),
      scanCurrentMyBatisManifestStable(targetRepoRoot, targetLayout)
    ]);
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
      manifestValidationMs: Date.now() - start,
      reusedFiles: reusedPaths.length,
      reusedResources: reusedResourcePaths.length,
      dirtyResources,
      coverage: "DEGRADED",
      negativeLookupAllowed: false
    };
    return { result, store };
  }
}

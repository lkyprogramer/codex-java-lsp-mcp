import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import {
  defaultLeaseClockDeps,
  FileCrossProcessLeaseStore,
  NoopCrossProcessLeaseStore,
  type CrossProcessLeaseStore,
  type LeaseHandle
} from "../cross-process-lease.js";
import { probeLayout, type LayoutContext } from "../layout-probe.js";
import { classifyPath, normalizeRepoFile } from "../repo-layout.js";
import { positiveInteger, resourceDefaults } from "../resource-defaults.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { WorktreeIdentity } from "../worktree-identity.js";
import { createJavaParserBackend, type JavaParserBackend } from "./java-parser-backend.js";
import { extractFromParsedTree, type ExtractJavaInput } from "./ast-extractor.js";
import { computeBuildFingerprint, computeExtractorVersion } from "./build-fingerprint.js";
import { CoverageTracker } from "./coverage.js";
import { computeManifestFingerprint, discoverJavaFiles, scanCurrentManifest, type DiscoveredJavaFile } from "./manifest.js";
import { effectiveParseTreeSourceBudget, ParseTreeCache, refreshParseTree } from "./parse-tree-cache.js";
import { buildStaticEdges, resolveFileRefs } from "./edge-builder.js";
import { JavaIndexStore } from "./index-store.js";
import { JavaNameResolver, buildTypeRegistryView, type TypeRegistryView } from "./name-resolver.js";
import { loadSnapshot, writeSnapshotAtomic, type JavaIndexSnapshotV2, type SnapshotIdentity } from "./snapshot.js";
import { STABLE_ID_VERSION } from "./stable-id.js";
import type { JavaIndexStatus, JavaSourceSet, JavaTypeLookupResult, SourceRootCoverage } from "./index-types.js";
import type { JavaIndexRequest, JavaIndexResponse } from "./worker-protocol.js";

// A full sweep processes this many files before yielding to the message loop
// (Task 20 Step 4), so a foreground request queued mid-sweep is serviced
// promptly instead of waiting for the whole repo to finish.
const SWEEP_CHUNK_SIZE = 50;
// How long a background chunk waits for the machine-wide sweep slot before
// giving up on this sweep for now; a later reconcile() call starts a fresh one.
const SWEEP_LEASE_WAIT_MS = 10000;
const SNAPSHOT_FILE_NAME = "java-index-snapshot.json.gz";
// Debounced so a burst of foreground refreshes (a save, then a formatter
// re-save moments later) coalesces into one write instead of one per event.
const SNAPSHOT_FLUSH_DEBOUNCE_MS = 1000;
// CLOSE's best-effort flush budget: a slow disk must not block CLOSE
// indefinitely - a dirty snapshot left behind is rebuilt on the next open's
// manifest verification anyway, just without this session's positive facts.
const CLOSE_FLUSH_BUDGET_MS = 2000;
// A snapshot's manifest diff this large or larger (e.g. a partial snapshot
// from a debounced flush that landed mid-sweep before an unclean shutdown,
// or a large branch switch) is abandoned rather than parsed inline inside
// OPEN: an unbounded, unchunked, un-leased parse here would bypass the
// machine-wide sweep-lease governance every other bulk parse (Step 4a) goes
// through. Above this bound, OPEN leaves every root at its restored
// provisional BUILDING state and lets the caller's ordinary reconcile() -
// exactly today's no-snapshot path - run it as a normal leased, chunked sweep.
const SNAPSHOT_DIFF_INLINE_LIMIT = 200;
const LEGACY_V1_CACHE_FILE_NAMES = ["source-index.files.jsonl", "source-index.symbols.jsonl", "source-index.meta.json"];
const LEGACY_V1_CLEANUP_MARKER_NAME = "java-index-v2.initialized";

let status: JavaIndexStatus = {
  state: "NEW",
  indexedGeneration: 0,
  files: 0,
  types: 0,
  methods: 0,
  edges: 0,
  snapshotBytes: 0,
  pendingForeground: 0,
  pendingBackground: 0,
  coverage: []
};

let repoRoot = "";
let backend: JavaParserBackend | undefined;
let cache: ParseTreeCache | undefined;
let store: JavaIndexStore | undefined;
let layout: LayoutContext | undefined;
let leaseStore: CrossProcessLeaseStore = new NoopCrossProcessLeaseStore();
let worktreeIdentity: WorktreeIdentity | undefined;
const coverage = new CoverageTracker();
// A single unreadable/unparsable file must not fail the whole REFRESH batch
// (its previous cached state, if any, is left untouched), but a silently
// swallowed failure is worse than a surfaced one: the most recent failure is
// surfaced here, alongside per-file/per-root accounting in `coverage`.
let lastRefreshError: string | undefined;

type BackgroundSweep = {
  generation: number;
  remaining: DiscoveredJavaFile[];
  rootsSeen: Set<string>;
  leaseHandle?: LeaseHandle;
};
let backgroundSweep: BackgroundSweep | undefined;
// Settles once the currently-running (or most recently run) background loop
// (startBackgroundLoop) returns. CLOSE awaits this - never just nulling
// backgroundSweep - so
// worker.terminate() can never land while a native parse/edge-build is still
// in flight underneath it (which previously crashed the whole process with
// an uncaught Napi::Error, not merely the worker thread).
let backgroundLoopPromise: Promise<void> = Promise.resolve();
let closing = false;

let snapshotPath: string | undefined;
let snapshotDirty = false;
let snapshotFlushTimer: NodeJS.Timeout | undefined;
// CLOSE awaits this (bounded by CLOSE_FLUSH_BUDGET_MS via Promise.race) so it
// never responds while a write is still being serialized/compressed.
let snapshotFlushPromise: Promise<void> = Promise.resolve();

const foregroundQueue: JavaIndexRequest[] = [];
let drainingForeground = false;
let runningBackground = false;

function respond(response: JavaIndexResponse): void {
  parentPort?.postMessage(response);
}

function unresolvedTypeLookup(): JavaTypeLookupResult {
  return { state: "UNRESOLVED", coverage: "DEGRADED" };
}

function currentWorktreeIdentity(): WorktreeIdentity {
  return worktreeIdentity ?? { repoRoot, repoHash: repoRoot, isLinkedWorktree: false };
}

// §9.10 coverage, patched onto a single-root answer (anchor): a stale-generation
// COMPLETE entry must never be reported as trustworthy for a negative
// conclusion, even though its own recorded state is still "COMPLETE".
function coverageStateFor(root: string, generation: number): SourceRootCoverage["state"] {
  const entry = coverage.snapshot().find(candidate => candidate.root === root);
  if (!entry) return "UNKNOWN";
  if (entry.state === "COMPLETE" && entry.generation !== generation) return "DEGRADED";
  return entry.state;
}

// §9.10 coverage for a repo-wide answer (type lookup, which may span main and
// test roots at once): the worst tracked root wins, since a negative
// conclusion is only as trustworthy as its least-complete constituent root.
function worstTypeLookupCoverage(generation: number): "COMPLETE" | "PARTIAL" | "DEGRADED" {
  const rank = (state: "COMPLETE" | "PARTIAL" | "DEGRADED"): number =>
    state === "COMPLETE" ? 0 : state === "PARTIAL" ? 1 : 2;
  const entries = coverage.snapshot();
  let worst: "COMPLETE" | "PARTIAL" | "DEGRADED" = entries.length === 0 ? "DEGRADED" : "COMPLETE";
  for (const entry of entries) {
    const mapped: "COMPLETE" | "PARTIAL" | "DEGRADED" = entry.generation !== generation
      ? "DEGRADED"
      : entry.state === "COMPLETE"
        ? "COMPLETE"
        : entry.state === "BUILDING"
          ? "PARTIAL"
          : "DEGRADED";
    if (rank(mapped) > rank(worst)) worst = mapped;
  }
  return worst;
}

// Prefers the source root layout-probe.ts already discovered (the same list
// discoverJavaFiles/coverage tracking key off of) over re-synthesizing one
// from classifyPath's module+sourceSet alone. The two disagree for a
// "modules/X" or "apps/X" layout: layout-probe's relativePath includes that
// top-level prefix (e.g. "modules/foo/src/main/java"), while classifyPath's
// module does not (giving "foo/src/main/java" if synthesized directly). A
// single file's source root must always resolve to the exact same string a
// repo-wide discovery scan already assigned it, or coverage tracking and
// manifest verification would silently key off two different roots for the
// same physical directory. Falls back to the synthesized form only if no
// known source root matches (layout not yet probed, or a brand-new module
// not yet picked up by a reconcile()).
function resolveSourceRoot(relativePath: string, module: string, rawSourceSet: string | undefined): string {
  if (layout) {
    const match = layout.sourceRoots.find(root =>
      relativePath === root.relativePath || relativePath.startsWith(`${root.relativePath}/`)
    );
    if (match) return match.relativePath;
  }
  return rawSourceSet ? [module, "src", rawSourceSet, "java"].filter(Boolean).join("/") : "";
}

// Provisional: reuses the repo's existing Maven/Gradle module + sourceSet
// classifier (src/repo-layout.ts) rather than inventing a parallel one. A
// real source-set/module classifier tied to build-file parsing is a later
// task's concern; this is enough to populate JavaFileFacts today.
function deriveSourceLayout(
  inputPath: string
): { absolutePath: string; relativePath: string; sourceRoot: string; module: string; sourceSet: JavaSourceSet } {
  // normalizeRepoFile resolves a relative-or-absolute path against repoRoot
  // and throws if it escapes the repo; classifyPath's own path.relative
  // silently resolves a relative input against process.cwd() instead, which
  // would return an empty context.relativePath for any caller that passes a
  // repo-relative path (as opposed to absolute).
  const absolutePath = normalizeRepoFile(repoRoot, inputPath);
  const context = classifyPath(repoRoot, absolutePath);
  const relativePath = (context.relativePath ?? path.relative(repoRoot, absolutePath))
    .split(path.sep)
    .join("/");
  const module = context.module && context.module !== "." ? context.module : "";
  const sourceSet: JavaSourceSet = context.sourceSet === "main" || context.sourceSet === "test"
    ? context.sourceSet
    : "unknown";
  const sourceRoot = resolveSourceRoot(relativePath, module, context.sourceSet);
  return { absolutePath, relativePath, sourceRoot, module, sourceSet };
}

function summarizeFiles(): Pick<JavaIndexStatus, "files" | "types" | "methods" | "edges"> {
  if (!store) return { files: 0, types: 0, methods: 0, edges: 0 };
  return {
    files: store.filesByPath.size,
    types: store.typesById.size,
    methods: store.methodsById.size,
    edges: store.edgesById.size
  };
}

function currentStatus(overrides: Partial<JavaIndexStatus> = {}): JavaIndexStatus {
  return {
    ...status,
    ...summarizeFiles(),
    coverage: coverage.snapshot(),
    pendingForeground: foregroundQueue.length,
    pendingBackground: backgroundSweep?.remaining.length ?? 0,
    ...(lastRefreshError ? { lastError: lastRefreshError } : {}),
    ...overrides
  };
}

async function refreshFile(inputPath: string, generation: number): Promise<string> {
  if (!backend || !cache || !store) throw new Error("refreshFile called before OPEN");
  const { absolutePath, relativePath, sourceRoot, module, sourceSet } = deriveSourceLayout(inputPath);
  const [content, stats] = await Promise.all([
    readFile(absolutePath, "utf8"),
    stat(absolutePath)
  ]);
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  const { tree } = refreshParseTree(cache, backend, relativePath, content);
  const input: ExtractJavaInput = {
    repoRoot,
    absolutePath,
    relativePath,
    sourceRoot,
    module,
    sourceSet,
    content,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    contentHash,
    generation
  };
  store.replaceFile({ ...extractFromParsedTree(input, tree), edges: [] });
  return relativePath;
}

// Repo-wide registry rebuilt from whatever has been indexed so far. O(repo
// size) per call - acceptable for foreground batches; a background sweep
// chunk pays this cost once per touched file, same as REFRESH always has.
function rebuildRegistry(): TypeRegistryView {
  if (!store) return buildTypeRegistryView([], []);
  return buildTypeRegistryView([...store.typesById.values()], [...store.methodsById.values()]);
}

// Resolves one file's refs against the registry as it stands (including any
// other files touched earlier in the same batch) and rebuilds its static
// edges. Does not re-resolve *other*, already-indexed files whose prior
// REPO_UNIQUE_SIMPLE_NAME fallback a new type might now make ambiguous - that
// reverse-dependency re-resolution remains deferred per Task 17's Step 6.
function resolveAndBuildEdges(relativePath: string): void {
  if (!store) return;
  const raw = store.files([relativePath])[0];
  if (!raw) return;
  const registryBeforeResolve = rebuildRegistry();
  const resolver = new JavaNameResolver(registryBeforeResolve);
  const resolved = resolveFileRefs(raw, resolver, registryBeforeResolve);
  // Store the resolved (still edge-less) facts before rebuilding the
  // registry again: buildStaticEdges' super-chain/receiver lookups need
  // *this* file's own supertype refs to carry their resolution, which only
  // the post-resolve registry reflects. These two replaceFile calls are the
  // only mutation of this file's facts and never straddle an await, so a
  // query landing between a background sweep's chunks (or interleaved with a
  // foreground refresh in flight) can only ever see this file fully resolved
  // with edges, or not yet touched at all - never resolved-but-edge-less.
  store.replaceFile({ ...resolved, edges: [] });
  const edges = buildStaticEdges(resolved, rebuildRegistry(), resolver);
  store.replaceFile({ ...resolved, edges });
}

/** Returns true when this file's outcome must block its root from advancing straight to COMPLETE this round. */
function recordFileCoverage(relativePath: string, failure?: unknown): boolean {
  const file = store?.file(relativePath);
  if (!file) return false;
  if (failure !== undefined) {
    coverage.failed(file.sourceRoot, relativePath, failure);
    return true;
  }
  if (file.parseState === "FAILED") {
    coverage.failed(file.sourceRoot, relativePath, `parse failed (${file.parseErrorCount} error(s))`);
    return true;
  }
  if (file.parseState === "RECOVERED") {
    coverage.recovered(file.sourceRoot, relativePath, file.parseErrorCount);
    return true;
  }
  coverage.indexed(file.sourceRoot);
  return false;
}

// Deletes SourceIndex V1's on-disk cache files once, the first time this repo
// is ever opened as a V2 index - guarded by a marker file so every later OPEN
// is a single cheap stat() instead of repeating the deletion. The current
// Java index snapshot lives under a different file name in the same
// directory and is never touched here.
async function cleanupLegacyCacheOnce(cacheDir: string): Promise<void> {
  const markerPath = path.join(cacheDir, LEGACY_V1_CLEANUP_MARKER_NAME);
  try {
    await stat(markerPath);
    return;
  } catch {
    // Marker absent: this is the first V2 open of this cache directory.
  }
  for (const name of LEGACY_V1_CACHE_FILE_NAMES) {
    await rm(path.join(cacheDir, name), { force: true }).catch(() => undefined);
  }
  await mkdir(cacheDir, { recursive: true }).catch(() => undefined);
  await writeFile(markerPath, new Date().toISOString()).catch(() => undefined);
}

function manifestEntriesFromStore(): { relativePath: string; contentHash: string; sourceRoot: string }[] {
  if (!store) return [];
  return [...store.filesByPath.values()].map(file => ({
    relativePath: file.relativePath,
    contentHash: file.contentHash,
    sourceRoot: file.sourceRoot
  }));
}

// Debounced (Step 5): a burst of foreground refreshes coalesces into one
// write, `SNAPSHOT_FLUSH_DEBOUNCE_MS` after the last one settles.
function scheduleSnapshotFlush(): void {
  snapshotDirty = true;
  if (!snapshotPath) return;
  if (snapshotFlushTimer) clearTimeout(snapshotFlushTimer);
  snapshotFlushTimer = setTimeout(() => {
    void flushSnapshotNow();
  }, SNAPSHOT_FLUSH_DEBOUNCE_MS);
  snapshotFlushTimer.unref?.();
}

// Forces an immediate (non-debounced) write when dirty; a no-op otherwise,
// since the on-disk snapshot already reflects the current facts. Tracked via
// `snapshotFlushPromise` so CLOSE can bound how long it waits for this.
async function flushSnapshotNow(): Promise<void> {
  if (snapshotFlushTimer) {
    clearTimeout(snapshotFlushTimer);
    snapshotFlushTimer = undefined;
  }
  if (!snapshotDirty || !snapshotPath || !store || !layout) return Promise.resolve();
  snapshotDirty = false;
  const target = snapshotPath;
  const currentLayout = layout;
  const generationAtSerialize = status.indexedGeneration;
  snapshotFlushPromise = (async () => {
    const buildFingerprint = await computeBuildFingerprint(repoRoot, currentLayout).catch(() => undefined);
    if (buildFingerprint === undefined || !store) return;
    const data = store.toSnapshotData();
    const manifestFingerprint = computeManifestFingerprint(
      data.files.map(file => ({ relativePath: file.relativePath, contentHash: file.contentHash, sourceRoot: file.sourceRoot }))
    );
    const value: JavaIndexSnapshotV2 = {
      schemaVersion: 2,
      extractorVersion: computeExtractorVersion(),
      stableIdVersion: STABLE_ID_VERSION,
      canonicalRepoRoot: repoRoot,
      buildFingerprint,
      manifestFingerprint,
      indexedGeneration: generationAtSerialize,
      createdAt: new Date().toISOString(),
      coverage: coverage.snapshot(),
      ...data
    };
    try {
      const bytes = await writeSnapshotAtomic(target, value, {
        // Cheap in-memory re-check (no disk re-scan): catches a REFRESH or
        // sweep chunk that mutated the store while this write was being
        // serialized/compressed, aborting the rename rather than publishing a
        // snapshot that is already stale the instant it lands.
        beforeRename: async () => {
          if (computeManifestFingerprint(manifestEntriesFromStore()) !== manifestFingerprint) {
            throw new Error("store changed before publish");
          }
        }
      });
      status = { ...status, snapshotBytes: bytes };
    } catch {
      snapshotDirty = true;
    }
  })();
  return snapshotFlushPromise;
}

// Returns the set of source roots that had an issue this round (an
// unreadable/unparsable file, or a FAILED/RECOVERED parse) - the caller's
// only reliable signal, since a file that throws before ever reaching the
// store never touches `coverage`'s own failed/recovered counters.
async function handleRefresh(request: Extract<JavaIndexRequest, { type: "REFRESH" }>): Promise<Set<string>> {
  // A background sweep still in flight from an earlier generation must not
  // mark roots COMPLETE at its own stale generation once this refresh moves
  // the repo's generation forward - same piggyback reasoning as
  // beginBackgroundSweep's dedup branch: unswept files pick up the new
  // content when the sweep gets to them, and already-swept files were just
  // re-indexed by this very refresh.
  if (backgroundSweep && request.generation > backgroundSweep.generation) {
    backgroundSweep.generation = request.generation;
  }
  const touched = new Set<string>();
  const rootHadIssue = new Set<string>();
  for (const inputPath of request.changed) {
    try {
      touched.add(await refreshFile(inputPath, request.generation));
    } catch (error) {
      lastRefreshError = `failed to refresh ${inputPath}: ${error instanceof Error ? error.message : String(error)}`;
      try {
        rootHadIssue.add(deriveSourceLayout(inputPath).sourceRoot);
      } catch {
        // Unclassifiable path (outside repoRoot); nothing to attribute the failure to.
      }
    }
  }
  const deletedPaths: string[] = [];
  for (const inputPath of request.deleted) {
    try {
      const { relativePath } = deriveSourceLayout(inputPath);
      cache?.delete(relativePath);
      deletedPaths.push(relativePath);
    } catch (error) {
      lastRefreshError = `failed to delete ${inputPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (deletedPaths.length > 0 && store) {
    // The store's own reverse index already knows which surviving files have
    // an edge into a node this delete removes; this is a strict equivalent of
    // a dangling-edge scan, not an approximation, since every edge target (a
    // type: or method: id) is owned by exactly one file.
    for (const dependent of store.removeFiles(deletedPaths)) touched.add(dependent);
  }
  for (const relativePath of touched) {
    let hadIssue: boolean;
    try {
      resolveAndBuildEdges(relativePath);
      hadIssue = recordFileCoverage(relativePath);
    } catch (error) {
      lastRefreshError = `failed to resolve ${relativePath}: ${error instanceof Error ? error.message : String(error)}`;
      hadIssue = recordFileCoverage(relativePath, error);
    }
    const file = store?.file(relativePath);
    if (file && hadIssue) rootHadIssue.add(file.sourceRoot);
  }
  // Step 3: a healthy incremental batch (no failures/recovered parses this
  // round anywhere in the repo) advances *every* already-COMPLETE root to the
  // new generation, not only the touched ones - the generation is repo-wide,
  // and nothing changed in an untouched root, so it is exactly as complete as
  // it was. Only roots that had an issue this round are held back.
  for (const entry of coverage.snapshot()) {
    if (rootHadIssue.has(entry.root)) continue;
    if (entry.state === "COMPLETE") coverage.complete(entry.root, request.generation);
  }
  scheduleSnapshotFlush();
  return rootHadIssue;
}

/**
 * Step 6a: verifies a just-restored snapshot's facts against the repo's
 * *current* files on disk (an independent re-scan, not a re-parse) and
 * returns the generation OPEN should report. Facts were already installed
 * provisionally (`coverage.restoreProvisional`, forced to BUILDING) before
 * this runs, so a concurrent foreground query sees either fully-verified
 * COMPLETE coverage or honestly-provisional BUILDING coverage - never a
 * silent, unverified COMPLETE.
 *
 * - Identical manifest: every root the snapshot or the current disk scan
 *   knows about is promoted straight to COMPLETE at the snapshot's own
 *   generation, with no AST parse at all.
 * - Different manifest: the generation advances exactly once: added/changed
 *   files are re-parsed via the same `handleRefresh` a foreground REFRESH
 *   uses (bounded to the diff, not a full sweep), deleted files are removed,
 *   and only after that pass do roots with no issue this round advance to
 *   COMPLETE - `handleRefresh`'s own "advance already-COMPLETE roots" loop
 *   does not help here, since every restored root started this round at
 *   BUILDING, not COMPLETE.
 */
async function verifyOwnSnapshot(snapshotData: JavaIndexSnapshotV2): Promise<number> {
  if (!layout || !store) return snapshotData.indexedGeneration;
  const { discovered, entries } = await scanCurrentManifest(repoRoot, layout);
  const currentFingerprint = computeManifestFingerprint(entries);

  const allRoots = new Set(snapshotData.coverage.map(entry => entry.root));
  const discoveredCountByRoot = new Map<string, number>();
  for (const file of discovered) {
    allRoots.add(file.sourceRoot);
    discoveredCountByRoot.set(file.sourceRoot, (discoveredCountByRoot.get(file.sourceRoot) ?? 0) + 1);
  }
  // A root discovered only just now (added since the snapshot was taken) has
  // no coverage entry yet; without one, indexed()/failed()/recovered() below
  // would silently no-op for its files.
  for (const root of allRoots) {
    if (!coverage.snapshot().some(entry => entry.root === root)) {
      coverage.begin(root, snapshotData.indexedGeneration, discoveredCountByRoot.get(root) ?? 0);
    }
  }

  if (currentFingerprint === snapshotData.manifestFingerprint) {
    for (const root of allRoots) coverage.complete(root, snapshotData.indexedGeneration);
    return snapshotData.indexedGeneration;
  }

  const newGeneration = snapshotData.indexedGeneration + 1;
  const snapshotHashByPath = new Map(snapshotData.files.map(file => [file.relativePath, file.contentHash]));
  const currentPaths = new Set(discovered.map(file => file.relativePath));
  const changedAbsolutePaths: string[] = [];
  for (let index = 0; index < discovered.length; index += 1) {
    const file = discovered[index]!;
    const entry = entries[index]!;
    if (snapshotHashByPath.get(file.relativePath) !== entry.contentHash) {
      changedAbsolutePaths.push(file.absolutePath);
    }
  }
  const deletedRelativePaths = snapshotData.files
    .map(file => file.relativePath)
    .filter(relativePath => !currentPaths.has(relativePath));

  if (changedAbsolutePaths.length + deletedRelativePaths.length >= SNAPSHOT_DIFF_INLINE_LIMIT) {
    // Too large to parse inline without the sweep lease's governance: leave
    // every root at its restored provisional BUILDING state (already set
    // above) and report the snapshot's own generation unchanged, so the
    // caller's ordinary "not fully restored" check triggers a normal
    // reconcile() - the same leased, chunked sweep a fresh (no-snapshot)
    // open would run.
    return snapshotData.indexedGeneration;
  }

  const rootHadIssue = await handleRefresh({
    id: -1,
    type: "REFRESH",
    generation: newGeneration,
    changed: changedAbsolutePaths,
    deleted: deletedRelativePaths
  });

  for (const root of allRoots) {
    if (rootHadIssue.has(root)) continue;
    const entry = coverage.snapshot().find(candidate => candidate.root === root);
    if (entry && entry.state !== "COMPLETE" && entry.failedFiles === 0 && entry.recoveredFiles === 0) {
      coverage.complete(root, newGeneration);
    }
  }
  return newGeneration;
}

async function beginBackgroundSweep(generation: number): Promise<void> {
  if (backgroundSweep) {
    // A sweep is already in flight: piggyback on it rather than starting a
    // second discovery, which would orphan (leak) the first sweep's lease
    // handle when its object gets replaced out from under the background loop.
    if (generation > backgroundSweep.generation) backgroundSweep.generation = generation;
    return;
  }
  if (closing) return;
  // Re-probed on every new sweep, not cached from OPEN: a BUILD_CHANGE is
  // precisely the kind of event that can change source roots, and a
  // reconcile() triggered by one must discover against the current layout.
  layout = probeLayout(repoRoot);
  const discovered = await discoverJavaFiles(repoRoot, layout);
  const byRoot = new Map<string, number>();
  for (const file of discovered) {
    byRoot.set(file.sourceRoot, (byRoot.get(file.sourceRoot) ?? 0) + 1);
  }
  for (const [root, count] of byRoot) coverage.begin(root, generation, count);
  backgroundSweep = { generation, remaining: discovered.slice(), rootsSeen: new Set(byRoot.keys()) };
  startBackgroundLoop();
}

async function processBackgroundChunk(sweep: BackgroundSweep): Promise<void> {
  if (!sweep.leaseHandle) {
    try {
      sweep.leaseHandle = await leaseStore.acquireSweep(
        currentWorktreeIdentity(),
        DeadlineBudget.fromTimeout(SWEEP_LEASE_WAIT_MS)
      );
    } catch {
      // Could not claim the machine-wide sweep slot within budget: give up on
      // this sweep for now. A later reconcile() call starts a fresh one.
      backgroundSweep = undefined;
      return;
    }
  }
  if (cache) {
    const configured = positiveIntegerOrUndefined(process.env.JAVA_LSP_PARSE_TREE_SOURCE_BYTES);
    const activeRuntimes = await leaseStore.activeRuntimeCount();
    cache.setMaxSourceBytes(effectiveParseTreeSourceBudget(configured, activeRuntimes));
  }
  // Peek, do not remove yet: `remaining` (and therefore `pendingBackground`)
  // must still count this chunk's files as outstanding for as long as they
  // are actually being parsed/resolved, or a status check racing the chunk
  // would see pendingBackground drop to 0 before the work is done.
  const chunk = sweep.remaining.slice(0, SWEEP_CHUNK_SIZE);
  const touched = new Set<string>();
  for (const file of chunk) {
    try {
      touched.add(await refreshFile(file.absolutePath, sweep.generation));
    } catch (error) {
      coverage.failed(file.sourceRoot, file.relativePath, error);
    }
  }
  for (const relativePath of touched) {
    try {
      resolveAndBuildEdges(relativePath);
      recordFileCoverage(relativePath);
    } catch (error) {
      recordFileCoverage(relativePath, error);
    }
  }
  sweep.remaining.splice(0, chunk.length);
  await sweep.leaseHandle.heartbeat();
  if (sweep.remaining.length === 0) {
    for (const root of sweep.rootsSeen) coverage.complete(root, sweep.generation);
    await sweep.leaseHandle.release();
    // Step 5: a full sweep's completion forces an immediate (non-debounced)
    // flush, since it is exactly the moment the persisted snapshot goes from
    // stale to fully caught-up.
    snapshotDirty = true;
    await flushSnapshotNow();
  }
}

function yieldToMessageLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function positiveIntegerOrUndefined(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

// Runs independently of drainForeground(): a background chunk's sweep-lease
// wait must never block a foreground request from being serviced, so this is
// its own loop rather than a lower-priority branch of the same one. Both
// loops only ever perform synchronous, per-file store mutations with no
// await in between (see resolveAndBuildEdges), so no interleaving between
// them can produce a torn or partially-applied file.
//
// Starting it always replaces `backgroundLoopPromise` with the promise of the
// run that is actually active (never a stale or a spuriously-resolved one),
// so CLOSE can await exactly "whatever background work is in flight right
// now" instead of just clearing `backgroundSweep` out from under it.
function startBackgroundLoop(): void {
  if (runningBackground) return;
  runningBackground = true;
  backgroundLoopPromise = (async () => {
    try {
      while (backgroundSweep && !closing) {
        const sweep = backgroundSweep;
        await processBackgroundChunk(sweep);
        if (backgroundSweep === sweep && backgroundSweep.remaining.length === 0) {
          backgroundSweep = undefined;
        } else if (backgroundSweep === sweep) {
          await yieldToMessageLoop();
        }
      }
    } finally {
      runningBackground = false;
    }
  })();
}

async function handle(request: JavaIndexRequest): Promise<void> {
  try {
    switch (request.type) {
      case "OPEN": {
        repoRoot = request.repoRoot;
        backend = await createJavaParserBackend();
        cache = new ParseTreeCache();
        store = new JavaIndexStore();
        worktreeIdentity = request.worktree;
        if (request.leaseRoot) {
          const store_ = new FileCrossProcessLeaseStore(request.leaseRoot, defaultLeaseClockDeps());
          try {
            await store_.open({
              jdtSlots: positiveInteger(process.env.JAVA_LSP_MAX_ACTIVE_REPOS, resourceDefaults().maxActiveRepos),
              sweepSlots: positiveInteger(process.env.JAVA_LSP_MAX_BACKGROUND_SWEEPS, 1)
            });
            leaseStore = store_;
          } catch {
            // A degraded lease store must not fail OPEN; background sweeps
            // simply skip lease acquisition rounds until it recovers.
            leaseStore = new NoopCrossProcessLeaseStore();
          }
        } else {
          leaseStore = new NoopCrossProcessLeaseStore();
        }
        lastRefreshError = undefined;
        layout = probeLayout(repoRoot);
        snapshotPath = path.join(request.cacheDir, SNAPSHOT_FILE_NAME);
        snapshotDirty = false;
        await cleanupLegacyCacheOnce(request.cacheDir);

        let openedGeneration = request.generation;
        const buildFingerprint = await computeBuildFingerprint(repoRoot, layout).catch(() => undefined);
        if (buildFingerprint !== undefined) {
          const identity: SnapshotIdentity = {
            extractorVersion: computeExtractorVersion(),
            stableIdVersion: STABLE_ID_VERSION,
            canonicalRepoRoot: repoRoot,
            buildFingerprint
          };
          const loaded = await loadSnapshot(snapshotPath, identity);
          if (loaded) {
            store.loadSnapshotData(loaded);
            for (const entry of loaded.coverage) coverage.restoreProvisional(entry);
            openedGeneration = await verifyOwnSnapshot(loaded);
          }
        }
        status = { ...status, state: "READY", indexedGeneration: openedGeneration };
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "STATUS": {
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "CLOSE": {
        // Never just null backgroundSweep here: processBackgroundChunk holds
        // its own reference to the sweep object and keeps parsing/mutating
        // the store regardless, and the client calls worker.terminate() right
        // after this responds - tearing down native parser state mid-parse
        // previously aborted the whole process, not just this worker thread.
        closing = true;
        await backgroundLoopPromise;
        if (backgroundSweep?.leaseHandle) {
          await backgroundSweep.leaseHandle.release().catch(() => undefined);
        }
        backgroundSweep = undefined;
        if (snapshotFlushTimer) {
          clearTimeout(snapshotFlushTimer);
          snapshotFlushTimer = undefined;
        }
        // Always await snapshotFlushPromise, not just when snapshotDirty is
        // still true: a debounce timer can have already fired moments ago,
        // clearing snapshotDirty synchronously while the write it kicked off
        // is still being serialized/compressed - skipping the wait on
        // snapshotDirty alone would let worker.terminate() land mid-write.
        await Promise.race([
          (async () => {
            await snapshotFlushPromise;
            if (snapshotDirty) await flushSnapshotNow();
          })(),
          new Promise(resolve => setTimeout(resolve, CLOSE_FLUSH_BUDGET_MS))
        ]).catch(() => undefined);
        status = { ...status, state: "CLOSED" };
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "REFRESH": {
        await handleRefresh(request);
        status = { ...status, indexedGeneration: request.generation };
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "RECONCILE": {
        await beginBackgroundSweep(request.generation);
        status = { ...status, indexedGeneration: request.generation };
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "FLUSH": {
        snapshotDirty = true;
        await flushSnapshotNow();
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "QUERY_ANCHOR": {
        // A single bad path must not fail (and DEGRADE) the whole client -
        // same reasoning as QUERY_FILES' per-path try/catch, just for one
        // path instead of a list: an anchor for a file outside the repo or
        // otherwise unresolvable simply has no anchor, not a fatal error.
        let relativePath: string | undefined;
        try {
          relativePath = deriveSourceLayout(request.file).relativePath;
        } catch {
          relativePath = undefined;
        }
        const anchor = relativePath ? store?.anchor(relativePath, request.line, request.column) : undefined;
        const value = anchor
          ? { ...anchor, coverage: coverageStateFor(anchor.file.sourceRoot, status.indexedGeneration) }
          : undefined;
        respond({ id: request.id, ok: true, value });
        return;
      }
      case "QUERY_TYPE": {
        const scopeFile = request.scopeFile ? deriveSourceLayout(request.scopeFile).relativePath : undefined;
        const result = store ? store.typeLookup(request.typeText, scopeFile) : unresolvedTypeLookup();
        const value = result.state === "UNRESOLVED"
          ? { ...result, coverage: worstTypeLookupCoverage(status.indexedGeneration) }
          : result;
        respond({ id: request.id, ok: true, value });
        return;
      }
      case "QUERY_IMPLEMENTERS": {
        respond({ id: request.id, ok: true, value: store?.implementers(request.typeId, request.limit) ?? [] });
        return;
      }
      case "QUERY_TYPE_REFERENCERS": {
        respond({
          id: request.id,
          ok: true,
          value: store?.typeReferencers(request.typeId, new Set(request.edgeKinds), request.limit) ?? []
        });
        return;
      }
      case "QUERY_CALLERS": {
        respond({ id: request.id, ok: true, value: store?.callers(request.methodId, request.limit) ?? [] });
        return;
      }
      case "QUERY_CALLEES": {
        respond({ id: request.id, ok: true, value: store?.callees(request.methodId, request.limit) ?? [] });
        return;
      }
      case "QUERY_FILES": {
        const relativePaths = request.files
          .map(inputPath => {
            try {
              return deriveSourceLayout(inputPath).relativePath;
            } catch {
              // Outside repoRoot or otherwise unresolvable: no facts for it,
              // same as a path that was never refreshed.
              return undefined;
            }
          })
          .filter((relativePath): relativePath is string => relativePath !== undefined);
        respond({ id: request.id, ok: true, value: store?.files(relativePaths) ?? [] });
        return;
      }
      default: {
        const exhaustive: never = request;
        throw new Error(`unhandled command: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    respond({
      id: request.id,
      ok: false,
      error: {
        code: "WORKER_UNHANDLED",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    });
  }
}

async function drainForeground(): Promise<void> {
  if (drainingForeground) return;
  drainingForeground = true;
  try {
    while (foregroundQueue.length > 0) {
      const next = foregroundQueue.shift();
      if (next) await handle(next);
    }
  } finally {
    drainingForeground = false;
  }
}

parentPort?.on("message", (request: JavaIndexRequest) => {
  foregroundQueue.push(request);
  void drainForeground();
});

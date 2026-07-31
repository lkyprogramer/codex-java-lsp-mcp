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
import {
  computeCurrentManifestFingerprint,
  computeManifestFingerprint,
  discoverJavaFiles,
  discoverMyBatisResourceFiles,
  scanSnapshotManifestDiff,
  type DiscoveredJavaFile
} from "./manifest.js";
import { extractMyBatisMapperFacts } from "./mybatis-xml-extractor.js";
import { effectiveParseTreeSourceBudget, ParseTreeCache, refreshParseTree } from "./parse-tree-cache.js";
import { buildStaticEdges, resolveFileRefs } from "./edge-builder.js";
import { JavaIndexStore } from "./index-store.js";
import { JavaNameResolver, buildTypeRegistryView, type TypeRegistryView } from "./name-resolver.js";
import {
  loadSnapshot,
  writeSnapshotIfManifestCurrent,
  type JavaIndexSnapshotV2,
  type SnapshotIdentity
} from "./snapshot.js";
import { STABLE_ID_VERSION } from "./stable-id.js";
import { WorktreeSnapshotSeeder } from "./worktree-snapshot-seeder.js";
import type { JavaIndexStatus, JavaSourceSet, JavaTypeLookupResult, SourceRootCoverage, WorktreeSeedStatus } from "./index-types.js";
import type { JavaIndexRequest, JavaIndexResponse } from "./worker-protocol.js";

// A full sweep processes this many files before yielding to the message loop
// (Task 20 Step 4), so a foreground request queued mid-sweep is serviced
// promptly instead of waiting for the whole repo to finish.
const SWEEP_CHUNK_SIZE = 50;
// How long a background chunk waits for the machine-wide sweep slot before
// giving up on this sweep for now; a later reconcile() call starts a fresh one.
const SWEEP_LEASE_WAIT_MS = 10000;
const SNAPSHOT_FILE_NAME = "java-index-snapshot.json.gz";
// Bounds a sweep's MyBatis resource re-scan the same way MAX_FRAMEWORK_TRAVERSAL_FILES
// bounds a framework adapter's candidate set - a repo with an unusually large
// src/main/resources tree (most of it not MyBatis mappers) must not turn every
// sweep into an unbounded directory walk plus a full-file read per XML file.
// Not yet measured against a real repo's cold-open cost (Task 27's isActive()
// gate covers a different code path) - a follow-up concern for whoever
// benchmarks Task 28, same as Task 27's own P95 gate.
const MAX_MYBATIS_RESOURCE_FILES = 500;
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
let worktreeSeedStatus: WorktreeSeedStatus | undefined;
// Installed only after a sibling snapshot has been validated against the
// target.  The next reconcile discovers the tree again (to include a file
// created after validation) but parses only paths absent from this set; the
// final batch re-link still revisits every discovered fact without AST work.
let seededReconcilePlan: { reusedPaths: Set<string> } | undefined;
const coverage = new CoverageTracker();
// A single unreadable/unparsable file must not fail the whole REFRESH batch
// (its previous cached state, if any, is left untouched), but a silently
// swallowed failure is worse than a surfaced one: the most recent failure is
// surfaced here, alongside per-file/per-root accounting in `coverage`.
let lastRefreshError: string | undefined;

type BackgroundSweep = {
  generation: number;
  remaining: DiscoveredJavaFile[];
  /** Every discovered file is batch re-linked once all declarations exist. */
  allDiscovered: DiscoveredJavaFile[];
  rootsSeen: Set<string>;
  parsedFiles: number;
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
// A completed sweep is not fully quiescent until its durable snapshot is
// published. Expose that work through pendingBackground so callers that wait
// for a steady index never start a latency sample behind gzip/atomic rename.
let snapshotFlushInProgress = false;

// OPEN restores own-snapshot facts immediately but leaves their coverage at
// BUILDING until the independent manifest check completes.  Keeping that
// scan off the OPEN request path is what makes a real snapshot startup cheap;
// the flag also lets RepoRuntimeManager avoid immediately replacing the
// restored store with a redundant full reconcile.
let ownSnapshotVerificationPending = false;
let ownSnapshotVerificationStale = false;
let ownSnapshotVerificationPromise: Promise<void> = Promise.resolve();
let queuedReconcileAfterSnapshotVerification: number | undefined;

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
  const pendingSweep = backgroundSweep?.remaining.length ?? 0;
  return {
    ...status,
    ...summarizeFiles(),
    coverage: coverage.snapshot(),
    pendingForeground: foregroundQueue.length,
    pendingBackground: pendingSweep
      + (ownSnapshotVerificationPending ? 1 : 0)
      + (snapshotFlushInProgress ? 1 : 0),
    ...(ownSnapshotVerificationPending ? { snapshotVerificationPending: true } : {}),
    ...(lastRefreshError ? { lastError: lastRefreshError } : {}),
    ...(worktreeSeedStatus ? { worktreeSeed: worktreeSeedStatus } : {}),
    ...overrides
  };
}

type RefreshedFile = {
  relativePath: string;
  dependents: string[];
};

async function refreshFile(inputPath: string, generation: number): Promise<RefreshedFile> {
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
    ctimeMs: stats.ctimeMs,
    contentHash,
    generation
  };
  const dependents = store.replaceFile({ ...extractFromParsedTree(input, tree), edges: [] });
  return { relativePath, dependents };
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

/**
 * A full sweep parses in bounded chunks, so an early chunk can see an
 * explicit import or same-package declaration whose defining file has not
 * reached the store yet.  Re-link all already-parsed facts once at sweep
 * completion against the complete registry.  This is deliberately a batch
 * operation: rebuilding a registry for every file here would turn a large
 * sweep into O(N^2) work, while no AST is reparsed in either pass.
 */
function resolveAllAndBuildEdges(relativePaths: readonly string[]): Map<string, unknown> {
  if (!store) return new Map();
  const errors = new Map<string, unknown>();
  const registry = rebuildRegistry();
  const resolver = new JavaNameResolver(registry);
  const resolvedByPath = new Map<string, ReturnType<typeof resolveFileRefs>>();
  for (const relativePath of relativePaths) {
    const raw = store.files([relativePath])[0];
    if (!raw) continue;
    try {
      const resolved = resolveFileRefs(raw, resolver, registry);
      resolvedByPath.set(relativePath, resolved);
      store.replaceFile({ ...resolved, edges: [] });
    } catch (error) {
      errors.set(relativePath, error);
    }
  }
  const finalRegistry = rebuildRegistry();
  const finalResolver = new JavaNameResolver(finalRegistry);
  for (const [relativePath, resolved] of resolvedByPath) {
    try {
      const edges = buildStaticEdges(resolved, finalRegistry, finalResolver);
      store.replaceFile({ ...resolved, edges });
    } catch (error) {
      errors.set(relativePath, error);
    }
  }
  return errors;
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

// Deletes legacy V1 on-disk cache files once, the first time this repo
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
  snapshotFlushInProgress = true;
  const target = snapshotPath;
  const currentLayout = layout;
  const generationAtSerialize = status.indexedGeneration;
  snapshotFlushPromise = (async () => {
    try {
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
        const bytes = await writeSnapshotIfManifestCurrent(
          target,
          value,
          () => computeCurrentManifestFingerprint(repoRoot, currentLayout)
        );
        status = { ...status, snapshotBytes: bytes };
      } catch {
        snapshotDirty = true;
      }
    } finally {
      snapshotFlushInProgress = false;
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
      const refreshed = await refreshFile(inputPath, request.generation);
      touched.add(refreshed.relativePath);
      for (const dependent of refreshed.dependents) touched.add(dependent);
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
 * Foreground upsert/delete for a batch of MyBatis resource paths (Task 28
 * Slice B). Unlike REFRESH's changed/deleted split, RESOURCE_CHANGE does not
 * distinguish add/change/delete at the coordinator layer, so each path is
 * resolved here via a stat - and every branch is written to be idempotent
 * under a race between the watcher event and this handler observing the
 * file (a delete-then-recreate, or an editor's non-atomic write): an ENOENT
 * on a path this store never indexed is a no-op, and re-extracting a path
 * whose content hash has not changed is skipped rather than re-inserted, so
 * a wrong guess about add-vs-change self-corrects on the next event instead
 * of leaving a stale namespace/statement entry behind.
 */
async function handleRefreshResources(request: Extract<JavaIndexRequest, { type: "REFRESH_RESOURCES" }>): Promise<void> {
  if (!store) return;
  for (const inputPath of request.paths) {
    let relativePath: string;
    try {
      relativePath = path.relative(repoRoot, inputPath).split(path.sep).join("/");
    } catch {
      continue;
    }
    try {
      const content = await readFile(inputPath, "utf8");
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      if (store.myBatisResource(relativePath)?.contentHash === contentHash) continue;
      const facts = extractMyBatisMapperFacts({ relativePath, content, contentHash, generation: request.generation });
      if (facts) store.replaceMyBatisResource(facts);
      else store.removeMyBatisResources([relativePath]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        store.removeMyBatisResources([relativePath]);
        continue;
      }
      lastRefreshError = `failed to refresh mybatis resource ${inputPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  scheduleSnapshotFlush();
}

/**
 * Step 6a: verifies a just-restored snapshot's facts against the repo's
 * *current* files on disk (an independent metadata re-scan, not a re-parse) and
 * returns the generation OPEN should report. Facts were already installed
 * provisionally (`coverage.restoreProvisional`, forced to BUILDING) before
 * this runs, so a concurrent foreground query sees either fully-verified
 * COMPLETE coverage or honestly-provisional BUILDING coverage - never a
 * silent, unverified COMPLETE.
 *
 * - Metadata-identical manifest: every root the snapshot or the current disk
 *   scan knows about is promoted straight to COMPLETE at the snapshot's own
 *   generation, with no source-content read or AST parse at all.  New
 *   snapshots persist size, mtime, and ctime; older snapshots have no ctime
 *   and deliberately take the conservative diff path once.
 * - Metadata-different manifest: only the added/changed metadata paths are
 *   re-parsed via the same `handleRefresh` a foreground REFRESH uses
 *   (bounded to the diff, not a full sweep), while deleted files are removed.
 *   Only after that pass do roots with no issue this round advance to
 *   COMPLETE - `handleRefresh`'s own "advance already-COMPLETE roots" loop
 *   does not help here, since every restored root started this round at
 *   BUILDING, not COMPLETE.
 */
async function verifyOwnSnapshot(
  snapshotData: JavaIndexSnapshotV2,
  canApply: () => boolean = () => true
): Promise<number | undefined> {
  if (!layout || !store) return snapshotData.indexedGeneration;
  const manifestDiff = await scanSnapshotManifestDiff(repoRoot, layout, snapshotData.files);
  if (!canApply()) return undefined;
  const { discovered, changed, deletedRelativePaths, metadataMatches } = manifestDiff;

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

  if (metadataMatches) {
    if (!canApply()) return undefined;
    for (const root of allRoots) coverage.complete(root, snapshotData.indexedGeneration);
    return snapshotData.indexedGeneration;
  }

  const newGeneration = snapshotData.indexedGeneration + 1;
  const changedAbsolutePaths = changed.map(file => file.absolutePath);

  if (changedAbsolutePaths.length + deletedRelativePaths.length >= SNAPSHOT_DIFF_INLINE_LIMIT) {
    // Too large to parse inline without the sweep lease's governance: leave
    // every root at its restored provisional BUILDING state (already set
    // above) and report the snapshot's own generation unchanged, so the
    // caller's ordinary "not fully restored" check triggers a normal
    // reconcile() - the same leased, chunked sweep a fresh (no-snapshot)
    // open would run.
    return snapshotData.indexedGeneration;
  }

  if (!canApply()) return undefined;
  const rootHadIssue = await handleRefresh({
    id: -1,
    type: "REFRESH",
    generation: newGeneration,
    changed: changedAbsolutePaths,
    deleted: deletedRelativePaths
  });
  if (!canApply()) return undefined;

  for (const root of allRoots) {
    if (rootHadIssue.has(root)) continue;
    const entry = coverage.snapshot().find(candidate => candidate.root === root);
    if (entry && entry.state !== "COMPLETE" && entry.failedFiles === 0 && entry.recoveredFiles === 0) {
      coverage.complete(root, newGeneration);
    }
  }
  return newGeneration;
}

function ownSnapshotCoverageFullyRestored(generation: number): boolean {
  const entries = coverage.snapshot();
  return entries.length > 0 && entries.every(entry =>
    entry.state === "COMPLETE"
    && entry.generation === generation
    && entry.failedFiles === 0
    && entry.recoveredFiles === 0
  );
}

function queueSnapshotVerificationReconcile(generation: number): void {
  queuedReconcileAfterSnapshotVerification = Math.max(
    queuedReconcileAfterSnapshotVerification ?? generation,
    generation
  );
}

function invalidateOwnSnapshotVerification(generation: number): void {
  if (!ownSnapshotVerificationPending) return;
  ownSnapshotVerificationStale = true;
  queueSnapshotVerificationReconcile(generation);
}

function startOwnSnapshotHydration(
  identity: SnapshotIdentity,
  requestedGeneration: number,
  buildFingerprint: string,
  siblingCacheBase: string | undefined
): void {
  ownSnapshotVerificationPending = true;
  ownSnapshotVerificationStale = false;
  ownSnapshotVerificationPromise = (async () => {
    try {
      const loaded = snapshotPath ? await loadSnapshot(snapshotPath, identity) : undefined;
      if (!loaded) {
        // Preserve Task 21a's immediate sibling-seed path when no own cache
        // exists. A corrupt own snapshot is simply a cache miss here; its
        // sibling attempt remains fail-soft, exactly as before.
        if (!ownSnapshotVerificationStale && siblingCacheBase) {
          worktreeSeedStatus = await attemptSiblingSeed(siblingCacheBase, buildFingerprint, requestedGeneration);
        }
        if (!closing) queueSnapshotVerificationReconcile(status.indexedGeneration);
        return;
      }
      if (closing || ownSnapshotVerificationStale) {
        if (!closing) queueSnapshotVerificationReconcile(status.indexedGeneration);
        return;
      }
      store = new JavaIndexStore();
      store.loadSnapshotData(loaded);
      for (const entry of loaded.coverage) coverage.restoreProvisional(entry);
      const expectedGeneration = Math.max(requestedGeneration, loaded.indexedGeneration);
      status = { ...status, indexedGeneration: expectedGeneration };
      const canApply = (): boolean =>
        !closing
        && !ownSnapshotVerificationStale
        && status.indexedGeneration === expectedGeneration;
      const verifiedGeneration = await verifyOwnSnapshot(loaded, canApply);
      if (verifiedGeneration !== undefined && canApply()) {
        status = { ...status, indexedGeneration: verifiedGeneration };
        if (!ownSnapshotCoverageFullyRestored(verifiedGeneration)) {
          queueSnapshotVerificationReconcile(verifiedGeneration);
        }
      } else if (!closing) {
        queueSnapshotVerificationReconcile(status.indexedGeneration);
      }
    } catch (error) {
      lastRefreshError = `failed to verify restored snapshot: ${error instanceof Error ? error.message : String(error)}`;
      if (!closing) queueSnapshotVerificationReconcile(status.indexedGeneration);
    } finally {
      // Keep OPEN observably pending until a queued fallback sweep has been
      // installed.  Clearing this first creates a status window with neither
      // a verification nor a sweep, so an ordinary caller can mistake an
      // empty store for an idle, usable index after a rejected snapshot.
      try {
        let reconcileGeneration = queuedReconcileAfterSnapshotVerification;
        queuedReconcileAfterSnapshotVerification = undefined;
        while (reconcileGeneration !== undefined && !closing) {
          await beginBackgroundSweep(reconcileGeneration);
          status = { ...status, indexedGeneration: Math.max(status.indexedGeneration, reconcileGeneration) };
          // RECONCILE requests can arrive while discovery above yields. Fold
          // their latest generation into the just-installed sweep before
          // exposing the worker as no longer pending.
          reconcileGeneration = queuedReconcileAfterSnapshotVerification;
          queuedReconcileAfterSnapshotVerification = undefined;
        }
      } finally {
        ownSnapshotVerificationPending = false;
        ownSnapshotVerificationStale = false;
      }
    }
  })();
}

/**
 * Task 21a: with no valid own snapshot, try to seed from a sibling
 * worktree's validated, COMPLETE snapshot instead of starting from a fully
 * empty store. Any failure anywhere in this attempt (a malformed sibling
 * snapshot - a different trust domain than the own-snapshot round-trip
 * Task 21's `loadSnapshot` guards, since it is another process's cache,
 * possibly mid-write - a filesystem race, or anything else) must never fail
 * OPEN: it is treated exactly like "no candidate found," falling through to
 * the ordinary empty-store-plus-cold-sweep path.
 *
 * The seeded store is always installed with DEGRADED coverage at the
 * caller's own generation (never the source's), so `canAnswerNegative()` is
 * false for every root and `repo-runtime-manager.createEntry`'s
 * "already fully restored" check is false too - the mandatory follow-up
 * reconcile() (today's ordinary full sweep) is what actually promotes
 * coverage to COMPLETE, correcting any file that was seeded stale as a side
 * effect of re-parsing only dirty/new paths. Content-identical reused files
 * remain DEGRADED until that reconcile finishes; its final full-store relink
 * repairs cross-file edges without paying a second AST parse for those files.
 *
 * Checked, not assumed: a REFRESH landing in that same window (before the
 * follow-up sweep completes) does call scheduleSnapshotFlush(), so a
 * debounced write could in principle publish a snapshot before the seeded
 * roots are ever verified. This is harmless, not merely unlikely:
 * beginBackgroundSweep's coverage.begin() unconditionally resets every
 * discovered root from this function's DEGRADED to BUILDING the moment the
 * follow-up RECONCILE is handled (which happens before the coordinator - and
 * therefore any REFRESH - starts), and processBackgroundChunk only ever
 * promotes rootsSeen to COMPLETE once, when the *entire* sweep's `remaining`
 * queue drains to zero. So a flush mid-sweep can only ever write coverage
 * that is BUILDING (never COMPLETE, never DEGRADED), which grants no
 * negative-answer trust and is simply re-verified from scratch - like any
 * other not-yet-complete snapshot - the next time this repo is opened.
 */
async function attemptSiblingSeed(
  siblingCacheBase: string,
  buildFingerprint: string,
  generation: number
): Promise<WorktreeSeedStatus> {
  if (!layout || !store) return emptyWorktreeSeedStatus("NOT_ATTEMPTED");
  try {
    const seedIdentity = { extractorVersion: computeExtractorVersion(), stableIdVersion: STABLE_ID_VERSION, buildFingerprint };
    const seeder = new WorktreeSnapshotSeeder();
    const candidate = await seeder.findCandidate(currentWorktreeIdentity(), seedIdentity, siblingCacheBase);
    if (!candidate) {
      return { ...emptyWorktreeSeedStatus("NO_VALID_SOURCE"), attempted: true };
    }
    const seeded = await seeder.seedValidatedFacts(candidate, seedIdentity, repoRoot, layout, generation);
    store = seeded.store;
    seededReconcilePlan = { reusedPaths: new Set(seeded.result.reusedPaths) };
    const discovered = await discoverJavaFiles(repoRoot, layout);
    const roots = new Set(discovered.map(file => file.sourceRoot));
    for (const root of roots) coverage.invalidate(root, generation);
    return {
      attempted: true,
      sourceRepoHash: seeded.result.sourceRepoHash,
      reusedFiles: seeded.result.reusedFiles,
      dirtyFiles: seeded.result.dirtyPaths.length,
      relinkFiles: seeded.result.relinkPaths.length,
      droppedCrossFileEdges: seeded.result.droppedCrossFileEdges,
      manifestValidationMs: seeded.result.manifestValidationMs,
      deltaParsedFiles: 0,
      completion: "SEEDED_DEGRADED"
    };
  } catch {
    store = new JavaIndexStore();
    seededReconcilePlan = undefined;
    return { ...emptyWorktreeSeedStatus("FAILED"), attempted: true };
  }
}

function emptyWorktreeSeedStatus(completion: WorktreeSeedStatus["completion"]): WorktreeSeedStatus {
  return {
    attempted: false,
    reusedFiles: 0,
    dirtyFiles: 0,
    relinkFiles: 0,
    droppedCrossFileEdges: 0,
    manifestValidationMs: 0,
    deltaParsedFiles: 0,
    completion
  };
}

/**
 * Discovers and (re-)extracts every MyBatis mapper XML under the repo's
 * resource roots, unconditionally on every sweep - the same "reconcile
 * re-derives everything discovered, nothing is assumed clean" contract
 * discoverJavaFiles' own sweep already has, not an incremental diff. Bounded
 * by MAX_MYBATIS_RESOURCE_FILES; a file beyond the cap is treated the same
 * as one that does not exist (evicted if it was previously indexed from a
 * sweep before the repo grew past the cap) - deterministic since discovery
 * is sorted by relativePath, not flapping between sweeps. A single file's
 * read/parse failure is recorded to lastRefreshError and skipped - it never
 * blocks the rest of the scan and never touches Java root coverage, which
 * this function does not read or write at all.
 *
 * `target` is captured once by the caller rather than read from the module
 * `store` variable on every iteration - OPEN/attemptSiblingSeed can reassign
 * `store` while this function is mid-await (a fresh OPEN, a sibling reseed),
 * and a stale read partway through would evict paths from the *new* store
 * using a `seenPaths` set computed against the *old* one. Writing to an
 * orphaned old store for the rest of this call is the safe failure mode;
 * corrupting the live one is not.
 *
 * Awaited by its only caller (beginBackgroundSweep), which blocks RECONCILE's
 * response on this - unlike Java's own sweep, which only blocks RECONCILE on
 * the (cheap) directory walk and backgrounds the actual per-file parsing via
 * startBackgroundLoop. A fire-and-forget version was considered and rejected:
 * CLOSE only awaits `backgroundLoopPromise`, so an un-awaited scan would have
 * nothing holding the worker open against a mid-scan store teardown. This is
 * a real, currently unmeasured latency cost on every reconcile()/RECONCILE
 * call (not just the first), bounded only by the file cap above - the same
 * class of "flag it, let the three-repo gate measure it" item Task 27's
 * isActive() cost was.
 */
async function indexMyBatisResources(target: JavaIndexStore, layout: LayoutContext, generation: number): Promise<void> {
  let discovered;
  try {
    discovered = await discoverMyBatisResourceFiles(repoRoot, layout);
  } catch (error) {
    lastRefreshError = `failed to discover MyBatis resources: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  const bounded = discovered.slice(0, MAX_MYBATIS_RESOURCE_FILES);
  const seenPaths = new Set<string>();
  for (const file of bounded) {
    if (closing) return;
    seenPaths.add(file.relativePath);
    try {
      const content = await readFile(file.absolutePath, "utf8");
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      const facts = extractMyBatisMapperFacts({ relativePath: file.relativePath, content, contentHash, generation });
      if (facts) target.replaceMyBatisResource(facts);
      else target.removeMyBatisResources([file.relativePath]);
    } catch (error) {
      lastRefreshError = `failed to index mybatis resource ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (closing) return;
  for (const relativePath of [...target.myBatisResourcesByPath.keys()]) {
    if (!seenPaths.has(relativePath)) target.removeMyBatisResources([relativePath]);
  }
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
  const reusedPaths = worktreeSeedStatus?.completion === "SEEDED_DEGRADED"
    ? seededReconcilePlan?.reusedPaths
    : undefined;
  backgroundSweep = {
    generation,
    remaining: reusedPaths
      ? discovered.filter(file => !reusedPaths.has(file.relativePath))
      : discovered.slice(),
    allDiscovered: discovered,
    rootsSeen: new Set(byRoot.keys()),
    parsedFiles: 0
  };
  startBackgroundLoop();
  // Only after `backgroundSweep` is installed and the Java chunk loop is
  // running: this function's own `if (backgroundSweep)` piggyback guard at
  // the top must already be closed before an awaited resource scan begins,
  // otherwise a second RECONCILE landing mid-scan would see backgroundSweep
  // still undefined, skip the guard, and start a second concurrent resource
  // scan (and a second Java sweep) racing this one.
  if (store) await indexMyBatisResources(store, layout, generation);
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
      const refreshed = await refreshFile(file.absolutePath, sweep.generation);
      touched.add(refreshed.relativePath);
      for (const dependent of refreshed.dependents) touched.add(dependent);
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
  sweep.parsedFiles += chunk.length;
  await sweep.leaseHandle.heartbeat();
  if (sweep.remaining.length === 0) {
    const relinkErrors = resolveAllAndBuildEdges(sweep.allDiscovered.map(file => file.relativePath));
    for (const [relativePath, error] of relinkErrors) {
      recordFileCoverage(relativePath, error);
    }
    for (const root of sweep.rootsSeen) coverage.complete(root, sweep.generation);
    if (worktreeSeedStatus?.completion === "SEEDED_DEGRADED") {
      worktreeSeedStatus = {
        ...worktreeSeedStatus,
        deltaParsedFiles: sweep.parsedFiles,
        completion: "RECONCILED_COMPLETE"
      };
    }
    seededReconcilePlan = undefined;
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
        let ownSnapshotIdentity: SnapshotIdentity | undefined;
        const buildFingerprint = await computeBuildFingerprint(repoRoot, layout).catch(() => undefined);
        if (buildFingerprint !== undefined) {
          const identity: SnapshotIdentity = {
            extractorVersion: computeExtractorVersion(),
            stableIdVersion: STABLE_ID_VERSION,
            canonicalRepoRoot: repoRoot,
            buildFingerprint
          };
          const ownSnapshotExists = await stat(snapshotPath).then(() => true).catch(() => false);
          if (ownSnapshotExists) {
            ownSnapshotIdentity = identity;
          } else if (request.siblingCacheBase) {
            worktreeSeedStatus = await attemptSiblingSeed(request.siblingCacheBase, buildFingerprint, request.generation);
          }
        }
        status = { ...status, state: "READY", indexedGeneration: openedGeneration };
        if (ownSnapshotIdentity && buildFingerprint !== undefined) {
          startOwnSnapshotHydration(ownSnapshotIdentity, openedGeneration, buildFingerprint, request.siblingCacheBase);
        }
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
        await ownSnapshotVerificationPromise;
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
        invalidateOwnSnapshotVerification(request.generation);
        await handleRefresh(request);
        status = { ...status, indexedGeneration: request.generation };
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "REFRESH_RESOURCES": {
        // Deliberately does not call invalidateOwnSnapshotVerification: the
        // persisted own-snapshot (schema 2) carries no resource facts at
        // all, so a mapper XML change cannot make its Java-facts
        // verification stale.
        await handleRefreshResources(request);
        status = { ...status, indexedGeneration: Math.max(status.indexedGeneration, request.generation) };
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "RECONCILE": {
        if (ownSnapshotVerificationPending) {
          invalidateOwnSnapshotVerification(request.generation);
          status = { ...status, indexedGeneration: Math.max(status.indexedGeneration, request.generation) };
          respond({ id: request.id, ok: true, value: currentStatus() });
          return;
        }
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
      case "QUERY_TYPES": {
        const value = request.queries.map(query => {
          const scopeFile = query.scopeFile ? deriveSourceLayout(query.scopeFile).relativePath : undefined;
          const result = store ? store.typeLookup(query.typeText, scopeFile) : unresolvedTypeLookup();
          return result.state === "UNRESOLVED"
            ? { ...result, coverage: worstTypeLookupCoverage(status.indexedGeneration) }
            : result;
        });
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
      case "QUERY_CALLEES_BATCH": {
        respond({
          id: request.id,
          ok: true,
          value: request.methodIds.map(methodId => ({ methodId, callees: store?.callees(methodId, request.limit) ?? [] }))
        });
        return;
      }
      case "QUERY_METHODS_WITH_PARAMETER_TYPES": {
        respond({
          id: request.id,
          ok: true,
          value: store?.methodsWithParameterTypes(request.typeIds, request.limit) ?? []
        });
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
      case "QUERY_MYBATIS_RESOURCE": {
        respond({ id: request.id, ok: true, value: store?.myBatisResource(request.relativePath) });
        return;
      }
      case "QUERY_REPOSITORY_FACT_MARKERS": {
        respond({
          id: request.id,
          ok: true,
          value: store?.repositoryFactMarkers(request.importPrefixes, request.annotationPrefixes)
            ?? { importPrefixFound: false, annotationPrefixFound: false }
        });
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

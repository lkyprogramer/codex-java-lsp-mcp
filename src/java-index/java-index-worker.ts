import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";
import {
  defaultLeaseClockDeps,
  FileCrossProcessLeaseStore,
  NoopCrossProcessLeaseStore,
  type CrossProcessLeaseStore,
  type LeaseHandle
} from "../cross-process-lease.js";
import { probeLayout, type LayoutContext } from "../layout-probe.js";
import { positiveInteger, resourceDefaults } from "../resource-defaults.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";
import type { WorktreeIdentity } from "../worktree-identity.js";
import { createJavaParserBackend, type JavaParserBackend } from "./java-parser-backend.js";
import { deriveJavaSourceLayout, parseJavaSourceFile, resolvedPathWithinRepo as resolveReadableRepoPath } from "./java-index-file-parse.js";
import { computeBuildFingerprint, computeExtractorVersion } from "./build-fingerprint.js";
import { CoverageTracker } from "./coverage.js";
import {
  computeCurrentSnapshotManifestFingerprint,
  computeManifestFingerprint,
  discoverJavaFiles,
  discoverMyBatisResourceFiles,
  prioritizeJavaFilesForBackgroundSweep,
  readFileStable,
  resourceSourceRoot,
  scanSnapshotManifestDiff,
  snapshotManifestEntries,
  type DiscoveredJavaFile
} from "./manifest.js";
import { extractMyBatisMapperFacts } from "./mybatis-xml-extractor.js";
import type { MyBatisMapperResourceFacts } from "./mybatis-types.js";
import { effectiveParseTreeSourceBudget, ParseTreeCache } from "./parse-tree-cache.js";
import { buildStaticEdges, resolveFileRefs } from "./edge-builder.js";
import { JavaIndexStore } from "./index-store.js";
import { JavaNameResolver, buildTypeRegistryView, type TypeRegistryView } from "./name-resolver.js";
import {
  loadSnapshotView,
  writeSnapshotIfManifestCurrent,
  type JavaIndexSnapshotV3,
  type SnapshotIdentity
} from "./snapshot.js";
import type { SnapshotV4View } from "./snapshot-v4.js";
import type { ColdBuildResult } from "./cold-build.js";
import { STABLE_ID_VERSION } from "./stable-id.js";
import { EntitySearchIndex } from "./entity-search.js";
import { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";
import { KnowledgeGraphBuilder } from "../java-knowledge/graph-builder.js";
import { loadGraphSnapshot, packGraphSnapshot, unpackGraphSnapshot, writeGraphSnapshotAtomic } from "../java-knowledge/graph-snapshot.js";
import { WorktreeSnapshotSeeder } from "./worktree-snapshot-seeder.js";
import type {
  IndexedReadRange,
  IndexedReadRangeResult,
  JavaCallSiteFact,
  JavaFileBundle,
  JavaIndexStatus,
  JavaMethodFacts,
  JavaTypeLookupResult,
  MyBatisResourceCoverage,
  SourcePosition,
  SourceRange,
  SourceRootCoverage,
  WorktreeSeedStatus
} from "./index-types.js";
import {
  JAVA_INDEX_CLOSE_FLUSH_BUDGET_MS,
  type JavaIndexRequest,
  type JavaIndexResponse
} from "./worker-protocol.js";
import { handleQueryCommand } from "./java-index-worker-query.js";
import { handleMybatisCommand } from "./java-index-worker-mybatis.js";

// A full sweep processes this many files before yielding to the message loop
// (Task 20 Step 4), so a foreground request queued mid-sweep is serviced
// promptly instead of waiting for the whole repo to finish.
const SWEEP_CHUNK_SIZE = 50;
// How long a background chunk waits for the machine-wide sweep slot before
// giving up on this sweep for now; a later reconcile() call starts a fresh one.
const SWEEP_LEASE_WAIT_MS = 10000;
const BUILD_LEASE_WAIT_MS = 180_000;
const SNAPSHOT_FILE_NAME = "java-index-snapshot.json.gz";
const GRAPH_SNAPSHOT_FILE_NAME = "java-knowledge-graph.json.gz";
const COLD_BUILD_CHILD = fileURLToPath(new URL("./cold-build-child.js", import.meta.url));
// Debounced so a burst of foreground refreshes (a save, then a formatter
// re-save moments later) coalesces into one write instead of one per event.
const SNAPSHOT_FLUSH_DEBOUNCE_MS = 1000;
// A snapshot's manifest diff this large or larger (e.g. a partial snapshot
// from a debounced flush that landed mid-sweep before an unclean shutdown,
// or a large branch switch) is abandoned rather than parsed inline inside
// OPEN: an unbounded, unchunked, un-leased parse here would bypass the
// machine-wide sweep-lease governance every other bulk parse (Step 4a) goes
// through. Above this bound, OPEN leaves every root at its restored
// provisional BUILDING state and lets the caller's ordinary reconcile() -
// exactly today's no-snapshot path - run it as a normal leased, chunked sweep.
const SNAPSHOT_DIFF_INLINE_LIMIT = 200;

let status: JavaIndexStatus = {
  state: "NEW",
  indexedGeneration: 0,
  files: 0,
  types: 0,
  methods: 0,
  edges: 0,
  snapshotBytes: 0,
  snapshot: { state: "EMPTY" },
  pendingForeground: 0,
  pendingBackground: 0,
  coverage: [],
  resourceCoverage: []
};

let repoRoot = "";
// The repository root cannot change during one worker lifetime. Resolve it
// once at OPEN so physical containment checks for a batched read plan never
// add a repeated root filesystem lookup to every candidate.
let resolvedRepoRoot = "";
let backend: JavaParserBackend | undefined;
let cache: ParseTreeCache | undefined;
let store: JavaIndexStore | undefined;
let entitySearch = new EntitySearchIndex();
let entitySearchSyncedRevision = -1;
let knowledgeGraph = new KnowledgeGraphStore();
let knowledgeBuilder = new KnowledgeGraphBuilder(knowledgeGraph);
let graphSyncedRevision = -1;
let indexFactsRevision = 0;
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
let resourceCoverage: MyBatisResourceCoverage[] = [];
// A single unreadable/unparsable file must not fail the whole REFRESH batch
// (its previous cached state, if any, is left untouched), but a silently
// swallowed failure is worse than a surfaced one: the most recent failure is
// surfaced here, alongside per-file/per-root accounting in `coverage`.
let lastRefreshError: string | undefined;

type BackgroundSweep = {
  generation: number;
  remaining: DiscoveredJavaFile[];
  /** At most one root, set only by the primary A1 ACTIVE_ANCHOR request. */
  activePriorityRoot?: string;
  /** 0 is ordinary ordering; 1 is the one accepted active-anchor priority epoch. */
  priorityEpoch: number;
  /** The epoch already applied to `remaining`; -1 forces the initial stable order. */
  appliedPriorityEpoch: number;
  /** Every discovered file is batch re-linked once all declarations exist. */
  allDiscovered: DiscoveredJavaFile[];
  rootsSeen: Set<string>;
  parsedFiles: number;
  leaseHandle?: LeaseHandle;
};
let backgroundSweep: BackgroundSweep | undefined;
// Settles once the currently-running (or most recently run) background loop
// (startBackgroundLoop) returns. CLOSE awaits this - never just nulling
// backgroundSweep - so the normal CLOSE ACK path joins native parse/edge-build
// work instead of terminating beneath it (which previously crashed the whole
// process with an uncaught Napi::Error). The client return grace only unrefs a
// slow worker; it does not terminate this drain before the eventual ACK.
let backgroundLoopPromise: Promise<void> = Promise.resolve();
let closing = false;

let snapshotPath: string | undefined;
let pendingSnapshotView: SnapshotV4View | undefined;
let snapshotFactsHydrated = true;
let hibernated = false;
let hibernateIdentity: SnapshotIdentity | undefined;
let hibernatedStatusCounts: { files: number; types: number; methods: number; edges: number } | undefined;
let lastColdBuildMetrics: { rssPeakBytes: number; parentIncrementBytes: number } | undefined;
let coldBuildAttempted = false;
// Monotonic in-memory publication revisions. A writer owns the revision it
// captured, so its late success/failure cannot overwrite the observable state
// of a newer mutation that arrived while the atomic write was in flight.
let snapshotDirtyRevision = 0;
let snapshotDurableRevision = 0;
let lastDurableSnapshotIdentity:
  | { durableGeneration: number; durableManifestFingerprint: string }
  | undefined;
let snapshotFlushTimer: NodeJS.Timeout | undefined;
// CLOSE joins this before deciding whether the remaining soft budget permits
// one additional dirty retry.
let snapshotFlushPromise: Promise<void> = Promise.resolve();
// Every writer joins this tail. Without a single flight, a slower stale
// debounce write can rename after a newer full-sweep write and roll the
// durable cache backwards even though both manifests still match.
let snapshotFlushTail: Promise<void> = Promise.resolve();
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

type ForegroundQueueEntry = {
  request: JavaIndexRequest;
  enqueuedAtMs: number;
  queueDepthAtEnqueue: number;
};
const foregroundQueue: ForegroundQueueEntry[] = [];
let drainingForeground = false;
let runningBackground = false;
let activeForegroundTiming:
  | {
      requestId: number;
      queueDepthAtEnqueue: number;
      queueMs: number;
      processingStartedAtMs: number;
      enabled: boolean;
    }
  | undefined;

function respond(response: JavaIndexResponse): void {
  const timing = activeForegroundTiming;
  if (timing?.enabled && timing.requestId === response.id) {
    parentPort?.postMessage({
      ...response,
      timing: {
        queueDepthAtEnqueue: timing.queueDepthAtEnqueue,
        queueMs: timing.queueMs,
        processingMs: Math.max(0, performance.now() - timing.processingStartedAtMs)
      }
    });
    return;
  }
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

function deriveSourceLayout(inputPath: string) {
  return deriveJavaSourceLayout(repoRoot, inputPath, layout);
}

const EXTREME_METHOD_LINES = 300;
const EXTREME_METHOD_WINDOW_LINES = 40;
const READ_RANGE_MERGE_GAP_LINES = 3;
const METHODLESS_TYPE_MAX_LINES = 80;
// Cap is 2: a parse-style fan-out of adjacent helpers otherwise merges into
// one file-sized window and the planner drops the file under the byte cap.
const SIBLING_CALLEE_MAX = 2;
const SIBLING_CALLEE_NEAR_LINES = 80;
type UnlocatedReadRange = Omit<IndexedReadRange, "range">;

/**
 * One worker-side round trip computes the AST/XML windows and their exact
 * UTF-8 byte cost. The router never opens candidate files just to price a
 * bounded read plan.
 */
async function queryReadRanges(
  requests: Array<{ file: string; positions: SourcePosition[] }>
): Promise<IndexedReadRangeResult[]> {
  return Promise.all(requests.map(async request => {
    try {
      const source = deriveSourceLayout(request.file);
      const readablePath = await resolvedPathWithinRepo(source.absolutePath);
      if (!readablePath) return { file: request.file, ranges: [] };
      // Java refresh already retains bounded source bytes beside the parsed
      // tree; reuse them when present. XML/fallback files have no parse-tree
      // cache entry, so this remains one asynchronous worker read per batch
      // request rather than an MCP-thread read.
      const content = cache?.get(source.relativePath)?.source ?? await readFile(readablePath, "utf8");
      const positions = request.positions.length > 0 ? request.positions : [{ line: 1, column: 1 }];
      const bundle = source.absolutePath.endsWith(".java") ? store?.files([source.relativePath])[0] : undefined;
      const resource = bundle ? undefined : store?.myBatisResource(source.relativePath);
      const java = bundle ? javaReadRanges(bundle, positions) : { ranges: [], extremeMethod: false };
      const xmlRanges = !bundle && resource ? xmlReadRanges(resource, positions) : [];
      const unmerged = java.ranges.length > 0 || xmlRanges.length > 0
        ? [...java.ranges, ...xmlRanges]
        : positions.map(position => fallbackReadRange(position));
      const starts = lineStartOffsets(content);
      const ranges = mergeWorkerReadRanges(unmerged).map(range => ({
        ...range,
        range: sourceRangeForLines(content, starts, range.startLine, range.endLine),
        estimatedBytes: utf8BytesForLines(content, starts, range.startLine, range.endLine)
      }));
      return { file: request.file, ranges, ...(java.extremeMethod ? { extremeMethod: true } : {}) };
    } catch {
      // An unreadable or no-longer-existing candidate is not allowed to fail
      // the whole planner batch. The omitted file becomes an explicit gap in
      // the router; no MCP-thread fallback read is attempted here.
      return { file: request.file, ranges: [] };
    }
  }));
}

/**
 * normalizeRepoFile deliberately uses lexical containment, which is right for
 * normal router paths but cannot answer where an in-repository symlink leads.
 * QUERY_READ_RANGES opens a file, so it makes that physical-path check here,
 * in the worker that performs the read.  Reading the resolved path also closes
 * the check-then-use window for a symlink retargeted after this validation.
 */
function resolvedPathWithinRepo(absolutePath: string): Promise<string | undefined> {
  return resolveReadableRepoPath(absolutePath, resolvedRepoRoot);
}

function javaReadRanges(bundle: JavaFileBundle, positions: SourcePosition[]): { ranges: UnlocatedReadRange[]; extremeMethod: boolean } {
  const ranges: UnlocatedReadRange[] = [];
  const headerTypes = new Set<string>();
  const emittedMethods = new Set<string>();
  let extremeMethod = false;

  const emitMethod = (method: JavaMethodFacts): void => {
    if (emittedMethods.has(method.methodId)) return;
    emittedMethods.add(method.methodId);
    const endLine = methodRangeEnd(method.range, method.bodyRange);
    if (endLine - method.range.start.line + 1 > EXTREME_METHOD_LINES) {
      extremeMethod = true;
      ranges.push({
        startLine: method.range.start.line,
        endLine: Math.min(endLine, method.range.start.line + EXTREME_METHOD_WINDOW_LINES - 1),
        kind: "method",
        estimatedBytes: 0
      });
      ranges.push({
        startLine: Math.max(method.range.start.line + EXTREME_METHOD_WINDOW_LINES, endLine - EXTREME_METHOD_WINDOW_LINES + 1),
        endLine,
        kind: "method",
        estimatedBytes: 0
      });
    } else {
      ranges.push({ startLine: method.range.start.line, endLine, kind: "method", estimatedBytes: 0 });
    }
    const owner = bundle.types.find(type => type.typeId === method.ownerTypeId);
    if (owner && !headerTypes.has(owner.typeId)) {
      ranges.push(typeHeaderRange(owner.range));
      headerTypes.add(owner.typeId);
    }
  };

  for (const position of positions) {
    const method = bundle.methods
      .filter(item => rangeContainsLine(item.range, position.line))
      .sort((left, right) => right.range.start.line - left.range.start.line)[0];
    if (method) {
      emitMethod(method);
      for (const sibling of sameOwnerCallees(bundle, method)) emitMethod(sibling);
      continue;
    }
    const owner = bundle.types
      .filter(type => rangeContainsLine(type.range, position.line))
      .sort((left, right) => right.range.start.line - left.range.start.line)[0];
    if (owner) {
      ranges.push(typeReadRange(bundle, owner));
      headerTypes.add(owner.typeId);
    } else {
      ranges.push(fallbackReadRange(position));
    }
  }
  return { ranges, extremeMethod };
}

function sameOwnerCallees(bundle: JavaFileBundle, method: JavaMethodFacts): JavaMethodFacts[] {
  const selectedEnd = methodRangeEnd(method.range, method.bodyRange);
  const siblings = bundle.methods.filter(item =>
    item.methodId !== method.methodId
    && item.ownerTypeId === method.ownerTypeId
    && !item.constructor
    && item.range.start.line > method.range.start.line
    && item.range.start.line - selectedEnd <= SIBLING_CALLEE_NEAR_LINES
  );
  const callees: JavaMethodFacts[] = [];
  for (const site of method.callSites) {
    if (!isUnqualifiedOrThisCall(site)) continue;
    const matches = siblings.filter(item => item.name === site.name && item.parameters.length === site.arity);
    if (matches.length !== 1) continue;
    const callee = matches[0]!;
    if (!callees.some(item => item.methodId === callee.methodId)) callees.push(callee);
    if (callees.length >= SIBLING_CALLEE_MAX) break;
  }
  return callees;
}

function isUnqualifiedOrThisCall(site: JavaCallSiteFact): boolean {
  if (site.kind !== "METHOD_INVOCATION") return false;
  const receiver = site.receiverText?.trim();
  return !receiver || receiver === "this";
}

function xmlReadRanges(
  resource: NonNullable<ReturnType<JavaIndexStore["myBatisResource"]>>,
  positions: SourcePosition[]
): UnlocatedReadRange[] {
  const ranges: UnlocatedReadRange[] = [];
  for (const position of positions) {
    const statement = resource.statements.find(item => item.range && rangeContainsLine(item.range, position.line));
    if (statement?.range) {
      ranges.push({
        startLine: statement.range.start.line,
        endLine: statement.range.end.line,
        kind: "xml-statement",
        estimatedBytes: 0
      });
      continue;
    }
    const resultMap = resource.resultMaps.find(item => item.range && rangeContainsLine(item.range, position.line));
    if (resultMap?.range) {
      ranges.push({
        startLine: resultMap.range.start.line,
        endLine: resultMap.range.end.line,
        kind: "xml-resultMap",
        estimatedBytes: 0
      });
      continue;
    }
    ranges.push(fallbackReadRange(position));
  }
  return ranges;
}

function methodRangeEnd(range: SourceRange, bodyRange: SourceRange | undefined): number {
  return Math.max(range.end.line, bodyRange?.end.line ?? 0);
}

function typeReadRange(bundle: JavaFileBundle, owner: JavaFileBundle["types"][number]): UnlocatedReadRange {
  const instanceMethods = bundle.methods.filter(method => method.ownerTypeId === owner.typeId && !method.constructor);
  if (instanceMethods.length === 0) {
    return {
      startLine: owner.range.start.line,
      endLine: Math.min(Math.max(owner.range.end.line, owner.range.start.line), owner.range.start.line + METHODLESS_TYPE_MAX_LINES - 1),
      kind: "type",
      estimatedBytes: 0
    };
  }
  return typeHeaderRange(owner.range);
}

function rangeContainsLine(range: SourceRange, line: number): boolean {
  return range.start.line <= line && line <= range.end.line;
}

function typeHeaderRange(range: SourceRange): UnlocatedReadRange {
  return {
    startLine: range.start.line,
    endLine: Math.min(range.end.line, range.start.line + 12),
    kind: "type",
    estimatedBytes: 0
  };
}

function fallbackReadRange(position: SourcePosition): UnlocatedReadRange {
  return {
    startLine: Math.max(1, position.line - 10),
    endLine: Math.max(1, position.line + 22),
    kind: "fallback",
    estimatedBytes: 0
  };
}

function mergeWorkerReadRanges(ranges: UnlocatedReadRange[]): UnlocatedReadRange[] {
  const merged: UnlocatedReadRange[] = [];
  for (const current of [...ranges].sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)) {
    const previous = merged.at(-1);
    if (previous && current.startLine <= previous.endLine + READ_RANGE_MERGE_GAP_LINES + 1) {
      previous.endLine = Math.max(previous.endLine, current.endLine);
      previous.kind = previous.kind === "method" || current.kind !== "method" ? previous.kind : current.kind;
      previous.kinds = [...new Set([...(previous.kinds ?? [previous.kind]), ...(current.kinds ?? [current.kind])])];
    } else {
      merged.push({ ...current, kinds: [...new Set(current.kinds ?? [current.kind])] });
    }
  }
  return merged;
}

/** One O(content.length) scan per file, reused across every merged range in that file. */
function lineStartOffsets(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function utf8BytesForLines(content: string, starts: readonly number[], startLine: number, endLine: number): number {
  const start = starts[Math.min(Math.max(startLine - 1, 0), starts.length - 1)]!;
  const end = endLine < starts.length ? starts[endLine]! : content.length;
  return Buffer.byteLength(content.slice(start, Math.max(start, end)), "utf8");
}

function sourceRangeForLines(
  content: string,
  starts: readonly number[],
  startLine: number,
  endLine: number
): SourceRange {
  const startOffset = starts[Math.min(Math.max(startLine - 1, 0), starts.length - 1)]!;
  const endOffset = endLine < starts.length ? starts[endLine]! : content.length;
  return {
    start: sourcePositionAtOffset(starts, startOffset),
    end: sourcePositionAtOffset(starts, Math.max(startOffset, endOffset))
  };
}

/** JS string offsets are UTF-16 code units, matching the repository coordinate contract. */
function sourcePositionAtOffset(starts: readonly number[], offset: number): SourcePosition {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low]! + 1 };
}

function summarizeFiles(): Pick<JavaIndexStatus, "files" | "types" | "methods" | "edges"> {
  if (hibernated && hibernatedStatusCounts) return hibernatedStatusCounts;
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
    resourceCoverage,
    pendingForeground: foregroundQueue.length,
    pendingBackground: pendingSweep
      + (ownSnapshotVerificationPending ? 1 : 0)
      + (snapshotFlushInProgress ? 1 : 0),
    ...(ownSnapshotVerificationPending ? { snapshotVerificationPending: true } : {}),
    ...(lastRefreshError ? { lastError: lastRefreshError } : {}),
    ...(worktreeSeedStatus ? { worktreeSeed: worktreeSeedStatus } : {}),
    ...(hibernated ? { hibernated: true } : {}),
    ...overrides
  };
}

type RefreshedFile = {
  relativePath: string;
  dependents: string[];
};

async function refreshFile(inputPath: string, generation: number): Promise<RefreshedFile> {
  if (!backend || !cache || !store) throw new Error("refreshFile called before OPEN");
  const bundle = await parseJavaSourceFile({
    repoRoot,
    resolvedRepoRoot,
    inputPath,
    generation,
    backend,
    cache,
    layout
  });
  const dependents = store.replaceFile(bundle);
  markIndexFactsChanged();
  return { relativePath: bundle.file.relativePath, dependents };
}

async function applyBackgroundChunkParses(
  chunk: DiscoveredJavaFile[],
  generation: number
): Promise<{ touched: Set<string> }> {
  const touched = new Set<string>();
  if (chunk.length === 0) return { touched };
  for (const file of chunk) {
    try {
      const refreshed = await refreshFile(file.absolutePath, generation);
      touched.add(refreshed.relativePath);
      for (const dependent of refreshed.dependents) touched.add(dependent);
    } catch (error) {
      coverage.failed(file.sourceRoot, file.relativePath, error);
    }
  }
  return { touched };
}

// Repo-wide registry rebuilt from whatever has been indexed so far. O(repo
// size) per call - acceptable for foreground batches; a background sweep
// chunk pays this cost once per touched file, same as REFRESH always has.
function rebuildRegistry(): TypeRegistryView {
  if (!store) return buildTypeRegistryView([], []);
  const index = store;
  return buildTypeRegistryView([...index.typesById.values()], [], ownerTypeId => index.methodsOfOwner(ownerTypeId));
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
  const withEdges = { ...resolved, edges };
  store.replaceFile(withEdges);
  syncKnowledgeGraphBundle(withEdges);
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
      const withEdges = { ...resolved, edges };
      store.replaceFile(withEdges);
      syncKnowledgeGraphBundle(withEdges);
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

// Debounced (Step 5): a burst of foreground refreshes coalesces into one
// write, `SNAPSHOT_FLUSH_DEBOUNCE_MS` after the last one settles.
function markSnapshotDirty(): void {
  snapshotDirtyRevision += 1;
  status = {
    ...status,
    snapshot: { state: "PENDING", ...lastDurableSnapshotIdentity }
  };
}

function scheduleSnapshotFlush(): void {
  markSnapshotDirty();
  if (!snapshotPath) return;
  if (snapshotFlushTimer) clearTimeout(snapshotFlushTimer);
  snapshotFlushTimer = setTimeout(() => {
    void flushSnapshotNow();
  }, SNAPSHOT_FLUSH_DEBOUNCE_MS);
  snapshotFlushTimer.unref?.();
}

// Forces an immediate (non-debounced) write when dirty; a no-op otherwise,
// since the on-disk snapshot already reflects the current facts. Tracked via
// `snapshotFlushPromise` so CLOSE can join a writer that already started.
function flushSnapshotNow(): Promise<void> {
  if (snapshotFlushTimer) {
    clearTimeout(snapshotFlushTimer);
    snapshotFlushTimer = undefined;
  }
  const queued = snapshotFlushTail.then(async () => {
    if (snapshotDirtyRevision <= snapshotDurableRevision || !snapshotPath || !store || !layout) return;
    await ensureFactsHydrated();
    snapshotFlushInProgress = true;
    const target = snapshotPath;
    const currentLayout = layout;
    const attemptRevision = snapshotDirtyRevision;
    let revisionAtSerialize = attemptRevision;
    try {
      const buildFingerprint = await computeBuildFingerprint(repoRoot, currentLayout).catch(() => undefined);
      if (buildFingerprint === undefined || !store) {
        throw new Error("snapshot build fingerprint unavailable");
      }
      // No await is allowed between these captures: worker mutations also run
      // on this event loop, so generation, facts, and coverage now describe
      // one coherent publication revision.
      revisionAtSerialize = snapshotDirtyRevision;
      const generationAtSerialize = status.indexedGeneration;
      const data = store.toSnapshotData();
      const coverageAtSerialize = coverage.snapshot();
      const resourceCoverageAtSerialize = resourceCoverage.map(entry => ({ ...entry }));
      const resourceEntries = data.myBatisResources.map(resource => {
        const sourceRoot = resourceSourceRoot(resource.relativePath, currentLayout);
        if (!sourceRoot) {
          throw new Error(`indexed MyBatis resource is outside a resource root: ${resource.relativePath}`);
        }
        return { relativePath: resource.relativePath, contentHash: resource.contentHash, sourceRoot };
      });
      const manifestFingerprint = computeManifestFingerprint(snapshotManifestEntries(
        data.files.map(file => ({ relativePath: file.relativePath, contentHash: file.contentHash, sourceRoot: file.sourceRoot })),
        resourceEntries
      ));
      const value: JavaIndexSnapshotV3 = {
        schemaVersion: 3,
        extractorVersion: computeExtractorVersion(),
        stableIdVersion: STABLE_ID_VERSION,
        canonicalRepoRoot: repoRoot,
        buildFingerprint,
        manifestFingerprint,
        indexedGeneration: generationAtSerialize,
        createdAt: new Date().toISOString(),
        coverage: coverageAtSerialize,
        resourceCoverage: resourceCoverageAtSerialize,
        ...data,
        entitySearch: readyEntitySearch().toSnapshot()
      };
      const bytes = await writeSnapshotIfManifestCurrent(
        target,
        value,
        () => computeCurrentSnapshotManifestFingerprint(repoRoot, currentLayout)
      );
      if (snapshotPath) {
        const graphPath = path.join(path.dirname(snapshotPath), GRAPH_SNAPSHOT_FILE_NAME);
        await writeGraphSnapshotAtomic(graphPath, packGraphSnapshot(readyKnowledgeGraph()));
      }
      lastDurableSnapshotIdentity = {
        durableGeneration: generationAtSerialize,
        durableManifestFingerprint: manifestFingerprint
      };
      hibernateIdentity = {
        extractorVersion: computeExtractorVersion(),
        stableIdVersion: STABLE_ID_VERSION,
        canonicalRepoRoot: repoRoot,
        buildFingerprint
      };
      snapshotDurableRevision = revisionAtSerialize;
      // A concurrently-running MyBatis resource reconcile can still be
      // catching resourceCoverage up to this generation (the Java chunk
      // loop's own finalChunk flush does not wait for it - see the
      // piggyback catch-up loop in beginBackgroundSweep), so a write that
      // races ahead of it must not claim DURABLE for a generation
      // resourceCoverage has not reached yet, even though these bytes are
      // already on disk.
      const resourceCoverageCurrent = resourceCoverageAtSerialize.every(
        entry => entry.generation === generationAtSerialize
      );
      status = {
        ...status,
        snapshotBytes: bytes,
        snapshot: snapshotDirtyRevision > revisionAtSerialize || !resourceCoverageCurrent
          ? { state: "PENDING", ...lastDurableSnapshotIdentity }
          : { state: "DURABLE", ...lastDurableSnapshotIdentity }
      };
    } catch (error) {
      status = {
        ...status,
        snapshot: snapshotDirtyRevision > revisionAtSerialize
          ? { state: "PENDING", ...lastDurableSnapshotIdentity }
          : {
              state: "FAILED",
              ...lastDurableSnapshotIdentity,
              failure: error instanceof Error && error.message === "manifest changed before snapshot publish"
                ? "MANIFEST_CHANGED"
                : "WRITE_FAILED"
            }
      };
    } finally {
      snapshotFlushInProgress = false;
    }
  });
  snapshotFlushPromise = queued;
  snapshotFlushTail = queued.catch(() => undefined);
  return queued;
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
  if (request.priority === "ACTIVE_ANCHOR" && request.changed.length === 1 && request.deleted.length === 0) {
    recordActiveAnchorSweepRoot(request.changed[0]!);
  }
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
    knowledgeBuilder.removeFiles(deletedPaths);
    entitySearch.removeFiles(deletedPaths);
    markIndexFactsChanged();
    markGraphAndSearchSynced();
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

function recordActiveAnchorSweepRoot(inputPath: string): void {
  if (!backgroundSweep || backgroundSweep.activePriorityRoot) return;
  try {
    const root = deriveSourceLayout(inputPath).sourceRoot;
    if (root) {
      backgroundSweep.activePriorityRoot = root;
      backgroundSweep.priorityEpoch = 1;
    }
  } catch {
    // An outside-repo or otherwise unclassifiable anchor cannot belong to
    // this sweep and must not create a synthetic priority band.
  }
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
function updateResourceCoverageAfterRefresh(
  relativePath: string,
  before: MyBatisMapperResourceFacts | undefined,
  after: MyBatisMapperResourceFacts | undefined,
  generation: number,
  failed: boolean
): void {
  if (!layout) return;
  const root = resourceSourceRoot(relativePath, layout);
  const entry = root ? resourceCoverage.find(candidate => candidate.root === root) : undefined;
  if (!entry) return;
  entry.generation = generation;
  const previousComplete = before?.parseState === "COMPLETE" ? 1 : 0;
  const previousFailed = before?.parseState === "FAILED" ? 1 : 0;
  const nextComplete = after?.parseState === "COMPLETE" ? 1 : 0;
  const nextFailed = after?.parseState === "FAILED" ? 1 : 0;
  if (before || after) {
    entry.discoveredFiles = Math.max(0, entry.discoveredFiles + (after ? 1 : 0) - (before ? 1 : 0));
    entry.indexedFiles = Math.max(0, entry.indexedFiles + nextComplete - previousComplete);
    entry.failedFiles = Math.max(0, entry.failedFiles + nextFailed - previousFailed);
  }
  if (failed) {
    entry.state = "DEGRADED";
    return;
  }
  entry.state = entry.failedFiles > 0 ? "DEGRADED" : "COMPLETE";
}

async function handleRefreshResources(request: Extract<JavaIndexRequest, { type: "REFRESH_RESOURCES" }>): Promise<void> {
  if (!store) return;
  for (const inputPath of request.paths) {
    let relativePath: string;
    try {
      relativePath = path.relative(repoRoot, inputPath).split(path.sep).join("/");
    } catch {
      continue;
    }
    const before = store.myBatisResource(relativePath);
    try {
      const content = await readFile(inputPath, "utf8");
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      if (before?.contentHash === contentHash) {
        updateResourceCoverageAfterRefresh(relativePath, before, before, request.generation, false);
        continue;
      }
      const facts = extractMyBatisMapperFacts({ relativePath, content, contentHash, generation: request.generation });
      if (facts) store.replaceMyBatisResource(facts);
      else store.removeMyBatisResources([relativePath]);
      updateResourceCoverageAfterRefresh(relativePath, before, facts, request.generation, false);
      resyncKnowledgeGraphForMyBatisNamespace(facts?.namespace ?? before?.namespace);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        store.removeMyBatisResources([relativePath]);
        updateResourceCoverageAfterRefresh(relativePath, before, undefined, request.generation, false);
        resyncKnowledgeGraphForMyBatisNamespace(before?.namespace);
        continue;
      }
      store.removeMyBatisResources([relativePath]);
      updateResourceCoverageAfterRefresh(relativePath, before, undefined, request.generation, true);
      lastRefreshError = `failed to refresh mybatis resource ${inputPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  scheduleSnapshotFlush();
}

/**
 * Step 6a: verifies a just-restored snapshot's facts against the repo's
 * *current* files on disk (an independent metadata re-scan, not a re-parse) and
 * returns the coordinator generation OPEN should report. Facts were already installed
 * provisionally (`coverage.restoreProvisional`, forced to BUILDING) before
 * this runs, so a concurrent foreground query sees either fully-verified
 * COMPLETE coverage or honestly-provisional BUILDING coverage - never a
 * silent, unverified COMPLETE.
 *
 * - Metadata-identical manifest: every root the snapshot or the current disk
 *   scan knows about is promoted straight to COMPLETE at the current OPEN
 *   generation, with no source-content read or AST parse at all. New
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
  snapshotData: JavaIndexSnapshotV3,
  targetGeneration: number,
  canApply: () => boolean = () => true
): Promise<number | undefined> {
  if (!layout || !store) return targetGeneration;
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
      coverage.begin(root, targetGeneration, discoveredCountByRoot.get(root) ?? 0);
    }
  }

  if (metadataMatches) {
    if (!canApply()) return undefined;
    for (const root of allRoots) coverage.complete(root, targetGeneration);
    return targetGeneration;
  }

  const changedAbsolutePaths = changed.map(file => file.absolutePath);

  if (changedAbsolutePaths.length + deletedRelativePaths.length >= SNAPSHOT_DIFF_INLINE_LIMIT) {
    // Too large to parse inline without the sweep lease's governance: leave
    // every root at its restored provisional BUILDING state (already set
    // above) and retain the current OPEN generation, so the
    // caller's ordinary "not fully restored" check triggers a normal
    // reconcile() - the same leased, chunked sweep a fresh (no-snapshot)
    // open would run.
    return targetGeneration;
  }

  if (!canApply()) return undefined;
  const rootHadIssue = await handleRefresh({
    id: -1,
    type: "REFRESH",
    generation: targetGeneration,
    changed: changedAbsolutePaths,
    deleted: deletedRelativePaths
  });
  if (!canApply()) return undefined;

  for (const root of allRoots) {
    if (rootHadIssue.has(root)) continue;
    const entry = coverage.snapshot().find(candidate => candidate.root === root);
    if (entry && entry.state !== "COMPLETE" && entry.failedFiles === 0 && entry.recoveredFiles === 0) {
      coverage.complete(root, targetGeneration);
    }
  }
  return targetGeneration;
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

function metaSnapshot(view: SnapshotV4View): JavaIndexSnapshotV3 {
  return {
    schemaVersion: 3,
    extractorVersion: view.header.extractorVersion,
    stableIdVersion: view.header.stableIdVersion,
    canonicalRepoRoot: view.header.canonicalRepoRoot,
    buildFingerprint: view.header.buildFingerprint,
    manifestFingerprint: view.header.manifestFingerprint,
    indexedGeneration: view.header.indexedGeneration,
    createdAt: view.header.createdAt,
    coverage: view.header.coverage,
    resourceCoverage: view.header.resourceCoverage,
    files: view.files,
    types: [],
    fields: [],
    methods: [],
    edges: [],
    myBatisResources: []
  };
}

async function ensureAwake(): Promise<void> {
  if (!hibernated) return;
  if (snapshotPath && hibernateIdentity && store) {
    const loadedView = await loadSnapshotView(snapshotPath, hibernateIdentity);
    if (loadedView) {
      store.loadSnapshotData({
        files: loadedView.files,
        types: [],
        fields: [],
        methods: [],
        edges: [],
        myBatisResources: []
      });
      pendingSnapshotView = loadedView;
      snapshotFactsHydrated = false;
    }
  }
  hibernated = false;
  hibernatedStatusCounts = undefined;
}

async function ensureFactsHydrated(): Promise<void> {
  await ensureAwake();
  if (snapshotFactsHydrated || !store || !pendingSnapshotView) {
    snapshotFactsHydrated = true;
    return;
  }
  const rest = pendingSnapshotView.readRest();
  store.ingestSnapshotFacts({
    types: rest.types,
    fields: rest.fields,
    methods: rest.methods,
    edges: rest.edges,
    myBatisResources: rest.myBatisResources
  });
  if (rest.entitySearch?.version === 1) {
    entitySearch.loadSnapshot(rest.entitySearch);
    entitySearchSyncedRevision = indexFactsRevision;
  }
  pendingSnapshotView = undefined;
  snapshotFactsHydrated = true;
}

async function ensureGraphReady(): Promise<void> {
  await ensureAwake();
  if (graphSyncedRevision === indexFactsRevision) return;
  if (snapshotPath) {
    const packedGraph = await loadGraphSnapshot(path.join(path.dirname(snapshotPath), GRAPH_SNAPSHOT_FILE_NAME));
    if (packedGraph) {
      unpackGraphSnapshot(packedGraph, knowledgeGraph);
      graphSyncedRevision = indexFactsRevision;
      return;
    }
  }
  if (store) syncKnowledgeGraphFromStore();
}

async function hibernateIndex(): Promise<void> {
  if (hibernated || closing) return;
  if (snapshotDirtyRevision > snapshotDurableRevision) {
    await ensureFactsHydrated();
    await flushSnapshotNow();
  }
  cache?.clear();
  if (!snapshotPath || (snapshotDurableRevision === 0 && !lastDurableSnapshotIdentity)) {
    const gcOnly = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (typeof gcOnly === "function") gcOnly();
    return;
  }
  if (!hibernateIdentity && layout) {
    const buildFingerprint = await computeBuildFingerprint(repoRoot, layout).catch(() => undefined);
    if (buildFingerprint) {
      hibernateIdentity = {
        extractorVersion: computeExtractorVersion(),
        stableIdVersion: STABLE_ID_VERSION,
        canonicalRepoRoot: repoRoot,
        buildFingerprint
      };
    }
  }
  hibernatedStatusCounts = summarizeFiles();
  store = new JavaIndexStore();
  entitySearch = new EntitySearchIndex();
  knowledgeGraph = new KnowledgeGraphStore();
  knowledgeBuilder = new KnowledgeGraphBuilder(knowledgeGraph);
  pendingSnapshotView = undefined;
  snapshotFactsHydrated = false;
  graphSyncedRevision = -1;
  entitySearchSyncedRevision = -1;
  indexFactsRevision = 0;
  hibernated = true;
  const gcFn = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (typeof gcFn === "function") gcFn();
}

async function spawnColdBuildChild(cacheDir: string, generation: number): Promise<ColdBuildResult | undefined> {
  let buildLease: LeaseHandle | undefined;
  try {
    buildLease = await leaseStore.acquireBuild(
      currentWorktreeIdentity(),
      DeadlineBudget.fromTimeout(BUILD_LEASE_WAIT_MS)
    );
  } catch {
    return undefined;
  }
  try {
    return await spawnColdBuildChildProcess(cacheDir, generation);
  } finally {
    await buildLease.release().catch(() => undefined);
  }
}

function spawnColdBuildChildProcess(cacheDir: string, generation: number): Promise<ColdBuildResult | undefined> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [
      COLD_BUILD_CHILD,
      "--repo-root",
      repoRoot,
      "--cache-dir",
      cacheDir,
      "--generation",
      String(generation)
    ], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", chunk => {
      stdout += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(undefined);
    }, 180_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? ""));
      } catch {
        resolve(undefined);
      }
    });
  });
}

function startOwnSnapshotHydration(
  identity: SnapshotIdentity,
  requestedGeneration: number,
  buildFingerprint: string,
  siblingCacheBase: string | undefined
): void {
  hibernateIdentity = identity;
  ownSnapshotVerificationPending = true;
  ownSnapshotVerificationStale = false;
  ownSnapshotVerificationPromise = (async () => {
    try {
      const loadedView = snapshotPath ? await loadSnapshotView(snapshotPath, identity) : undefined;
      const loaded = loadedView ? metaSnapshot(loadedView) : undefined;
      if (!loadedView || !loaded) {
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
      const durableRevisionAtHydration = snapshotDurableRevision;
      store = new JavaIndexStore();
      entitySearch = new EntitySearchIndex();
      knowledgeGraph = new KnowledgeGraphStore();
      knowledgeBuilder = new KnowledgeGraphBuilder(knowledgeGraph);
      indexFactsRevision = 0;
      graphSyncedRevision = -1;
      entitySearchSyncedRevision = -1;
      // XML facts stay out of the provisional store until a stable target-side
      // read confirms their content hash. `indexMyBatisResources` can then
      // reuse exact snapshot facts without re-parsing them, while changed XML
      // is extracted fresh and is never visible through the interim store.
      store.loadSnapshotData({
        files: loadedView.files,
        types: [],
        fields: [],
        methods: [],
        edges: [],
        myBatisResources: []
      });
      pendingSnapshotView = loadedView;
      snapshotFactsHydrated = false;
      const graphPath = snapshotPath ? path.join(path.dirname(snapshotPath), GRAPH_SNAPSHOT_FILE_NAME) : undefined;
      const packedGraph = graphPath ? await loadGraphSnapshot(graphPath) : undefined;
      if (packedGraph) {
        unpackGraphSnapshot(packedGraph, knowledgeGraph);
        graphSyncedRevision = indexFactsRevision;
      } else {
        graphSyncedRevision = -1;
      }
      entitySearchSyncedRevision = -1;
      // Snapshot generations belong to the process that wrote the snapshot.
      // A new RepoChangeCoordinator starts its own monotonic domain, so every
      // verified fact must be adopted into the OPEN generation instead of
      // asynchronously pulling the worker ahead of the coordinator clock.
      store.stampGeneration(loaded.files.map(file => file.relativePath), requestedGeneration);
      for (const entry of loaded.coverage) {
        coverage.restoreProvisional({ ...entry, generation: requestedGeneration });
      }
      const expectedGeneration = requestedGeneration;
      status = { ...status, indexedGeneration: expectedGeneration };
      const canApply = (): boolean =>
        !closing
        && !ownSnapshotVerificationStale
        && status.indexedGeneration === expectedGeneration;
      const resourceReindex = layout
        ? indexMyBatisResources(store, layout, expectedGeneration)
        : Promise.resolve();
      const verifiedGeneration = await verifyOwnSnapshot(loaded, expectedGeneration, canApply);
      await resourceReindex;
      if (verifiedGeneration !== undefined && canApply()) {
        const hydratedManifestFingerprint = layout
          ? await computeCurrentSnapshotManifestFingerprint(repoRoot, layout)
          : loaded.manifestFingerprint;
        const hydratedManifestChanged = hydratedManifestFingerprint !== loaded.manifestFingerprint;
        const restoredFully = ownSnapshotCoverageFullyRestored(verifiedGeneration);
        const restoredBytes = snapshotPath
          ? await stat(snapshotPath).then(entry => entry.size).catch(() => undefined)
          : undefined;
        if (!canApply()) {
          queueSnapshotVerificationReconcile(status.indexedGeneration);
          return;
        }
        status = { ...status, indexedGeneration: verifiedGeneration };
        // The physical snapshot keeps its original generation identity. If
        // this process adopted the facts into a different coordinator clock,
        // expose the old durable identity as PENDING and rewrite explicitly;
        // never relabel the old bytes as if they already contained the new
        // generation.
        if (
          restoredBytes !== undefined
          && snapshotDurableRevision === durableRevisionAtHydration
        ) {
          lastDurableSnapshotIdentity = {
            durableGeneration: loaded.indexedGeneration,
            durableManifestFingerprint: loaded.manifestFingerprint
          };
          status = {
            ...status,
            snapshotBytes: restoredBytes,
            snapshot: restoredFully
              && snapshotDirtyRevision === snapshotDurableRevision
              && loaded.indexedGeneration === verifiedGeneration
              && !hydratedManifestChanged
              ? { state: "DURABLE", ...lastDurableSnapshotIdentity }
              : { state: "PENDING", ...lastDurableSnapshotIdentity }
          };
        }
        if (
          restoredFully
          && (loaded.indexedGeneration !== verifiedGeneration || hydratedManifestChanged)
          && snapshotDirtyRevision === snapshotDurableRevision
        ) {
          scheduleSnapshotFlush();
        }
        if (!restoredFully) {
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
    const scanTelemetry = seeder.lastScanTelemetry;
    if (!candidate) {
      return {
        ...emptyWorktreeSeedStatus("NO_VALID_SOURCE"),
        attempted: true,
        cacheDirsScanned: scanTelemetry.cacheDirsScanned,
        eligibleSnapshots: scanTelemetry.eligibleSnapshots
      };
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
      droppedFrameworkEdges: seeded.result.droppedFrameworkEdges,
      manifestValidationMs: seeded.result.manifestValidationMs,
      deltaParsedFiles: 0,
      reusedResources: seeded.result.reusedResources,
      dirtyResources: seeded.result.dirtyResources,
      cacheDirsScanned: scanTelemetry.cacheDirsScanned,
      eligibleSnapshots: scanTelemetry.eligibleSnapshots,
      candidateDecompressMs: seeded.result.candidateDecompressMs,
      initialManifestScanMs: seeded.result.initialManifestScanMs,
      finalManifestScanMs: seeded.result.finalManifestScanMs,
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
    droppedFrameworkEdges: 0,
    manifestValidationMs: 0,
    deltaParsedFiles: 0,
    reusedResources: 0,
    dirtyResources: 0,
    cacheDirsScanned: 0,
    eligibleSnapshots: 0,
    candidateDecompressMs: 0,
    initialManifestScanMs: 0,
    finalManifestScanMs: 0,
    completion
  };
}

/**
 * Reconciles every XML resource under every discovered resource root. Snapshot
 * facts can be supplied as `reusable`: they are installed only after an exact,
 * stable target-side content read confirms their hash, so an own snapshot never
 * exposes XML facts that changed while the worker was closed.
 */
async function indexMyBatisResources(
  target: JavaIndexStore,
  layout: LayoutContext,
  generation: number,
  reusable: ReadonlyMap<string, MyBatisMapperResourceFacts> = new Map()
): Promise<void> {
  let discovered;
  try {
    discovered = await discoverMyBatisResourceFiles(repoRoot, layout);
  } catch (error) {
    lastRefreshError = `failed to discover MyBatis resources: ${error instanceof Error ? error.message : String(error)}`;
    resourceCoverage = layout.resourceRoots.map(root => ({
      root,
      generation,
      state: "DEGRADED",
      discoveredFiles: 0,
      indexedFiles: 0,
      failedFiles: 1
    }));
    return;
  }
  const coverageByRoot = new Map<string, MyBatisResourceCoverage>(
    layout.resourceRoots.map(root => [root, {
      root,
      generation,
      state: "BUILDING" as const,
      discoveredFiles: 0,
      indexedFiles: 0,
      failedFiles: 0
    }])
  );
  resourceCoverage = [...coverageByRoot.values()];
  const seenPaths = new Set<string>();
  for (const file of discovered) {
    if (closing) return;
    seenPaths.add(file.relativePath);
    const rootCoverage = coverageByRoot.get(file.sourceRoot);
    try {
      const read = await readFileStable(file.absolutePath);
      if (!read?.stable) {
        target.removeMyBatisResources([file.relativePath]);
        if (rootCoverage) rootCoverage.failedFiles += 1;
        continue;
      }
      const contentHash = createHash("sha256").update(read.content, "utf8").digest("hex");
      const reusableFacts = reusable.get(file.relativePath);
      const currentFacts = target.myBatisResource(file.relativePath);
      const facts = reusableFacts?.contentHash === contentHash
        ? { ...reusableFacts, generation }
        : currentFacts?.contentHash === contentHash
          ? currentFacts
          : extractMyBatisMapperFacts({ relativePath: file.relativePath, content: read.content, contentHash, generation });
      if (facts) {
        target.replaceMyBatisResource(facts);
        if (rootCoverage) rootCoverage.discoveredFiles += 1;
        if (facts.parseState === "COMPLETE") {
          if (rootCoverage) rootCoverage.indexedFiles += 1;
        } else if (rootCoverage) {
          rootCoverage.failedFiles += 1;
        }
      } else {
        target.removeMyBatisResources([file.relativePath]);
      }
    } catch (error) {
      target.removeMyBatisResources([file.relativePath]);
      if (rootCoverage) rootCoverage.failedFiles += 1;
      lastRefreshError = `failed to index mybatis resource ${file.relativePath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (closing) return;
  for (const relativePath of [...target.myBatisResourcesByPath.keys()]) {
    if (!seenPaths.has(relativePath)) target.removeMyBatisResources([relativePath]);
  }
  resourceCoverage = [...coverageByRoot.values()].map(entry => ({
    ...entry,
    state: entry.failedFiles > 0 ? "DEGRADED" : "COMPLETE"
  }));
  for (const namespace of target.myBatisResourcesByNamespace.keys()) {
    resyncKnowledgeGraphForMyBatisNamespace(namespace);
  }
}

async function beginBackgroundSweep(generation: number): Promise<void> {
  const coverageEntries = coverage.snapshot();
  if (
    store
    && store.filesByPath.size > 0
    && coverageEntries.length > 0
    && coverageEntries.every(entry => entry.state === "COMPLETE" && entry.generation === generation)
  ) {
    return;
  }
  if (
    store
    && store.filesByPath.size === 0
    && snapshotPath
    && !closing
    && !coldBuildAttempted
    && (
      process.env.JAVA_LSP_ISOLATED_VALIDATION === "1"
        ? process.env.JAVA_LSP_COLD_BUILD_CHILD === "1"
        : process.env.JAVA_LSP_COLD_BUILD_CHILD !== "0"
    )
  ) {
    coldBuildAttempted = true;
    const parentBefore = process.memoryUsage().rss;
    const childResult = await spawnColdBuildChild(path.dirname(snapshotPath), generation);
    lastColdBuildMetrics = childResult
      ? { rssPeakBytes: childResult.rssPeakBytes, parentIncrementBytes: Math.max(0, process.memoryUsage().rss - parentBefore) }
      : undefined;
    if (childResult?.ok) {
      layout = layout ?? probeLayout(repoRoot);
      const buildFingerprint = await computeBuildFingerprint(repoRoot, layout).catch(() => undefined);
      if (buildFingerprint) {
        const identity: SnapshotIdentity = {
          extractorVersion: computeExtractorVersion(),
          stableIdVersion: STABLE_ID_VERSION,
          canonicalRepoRoot: repoRoot,
          buildFingerprint
        };
        startOwnSnapshotHydration(identity, generation, buildFingerprint, undefined);
        await ownSnapshotVerificationPromise;
        return;
      }
    }
  }
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
    priorityEpoch: 0,
    appliedPriorityEpoch: -1,
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
  if (store) {
    let resourceGeneration = generation;
    await indexMyBatisResources(store, layout, resourceGeneration);
    // A piggybacked reconcile (the guard above) can advance the generation
    // this sweep will eventually stamp Java coverage at while this call was
    // in flight, leaving resourceCoverage behind. Catch up against
    // status.indexedGeneration, not backgroundSweep.generation: the Java
    // chunk loop's own finalChunk completion can null out `backgroundSweep`
    // concurrently with this await, at which point backgroundSweep.generation
    // is no longer readable at all and a bump that landed in that window
    // would be lost forever. status.indexedGeneration is bumped in lockstep
    // by every RECONCILE handler right after beginBackgroundSweep resolves
    // and is never cleared, so it stays a valid catch-up target even after
    // backgroundSweep is gone - and it is exactly the field
    // isJavaIndexCompleteAt compares resourceCoverage's generation against,
    // so catching up to it (instead of to an internal sweep-object field
    // that happens to usually correlate) closes the gap by construction.
    // Never start a second concurrent resource scan - instead of starting a
    // fresh one from the top, which would re-open the same race this
    // function's own piggyback guard exists to close.
    let caughtUp = false;
    while (!closing && status.indexedGeneration > resourceGeneration) {
      resourceGeneration = status.indexedGeneration;
      await indexMyBatisResources(store, layout, resourceGeneration);
      caughtUp = true;
    }
    // Only when the catch-up loop actually ran: the Java chunk loop's own
    // finalChunk flush does not wait for this resource scan and can
    // durable-stamp a snapshot before resourceCoverage caught up to the
    // piggybacked generation; flushSnapshotNow's own completeness check then
    // leaves that write PENDING forever, since nothing else re-dirties it.
    // Debounced (scheduleSnapshotFlush), not an immediate forced write: this
    // is the rare piggyback path, and an eager write here would add an extra,
    // unexpected write attempt on every ordinary sweep too.
    if (caughtUp) {
      scheduleSnapshotFlush();
    }
  }
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
  // must still count this chunk's files as outstanding through its heartbeat.
  // The final chunk stays counted through terminal re-link, coverage, lease,
  // and snapshot-flush work too, so STATUS cannot report false quiescence.
  // Reorder only after the prior chunk is entirely done, at startup or when
  // the single primary anchor accepts its one priority epoch. The current
  // chunk is copied below and never modified, so no foreground request can
  // preempt an in-flight parse batch or repeatedly sort the full queue.
  if (sweep.appliedPriorityEpoch !== sweep.priorityEpoch) {
    sweep.remaining = prioritizeJavaFilesForBackgroundSweep(
      sweep.remaining,
      layout ?? { sourceRoots: [] },
      sweep.activePriorityRoot ? [sweep.activePriorityRoot] : []
    );
    sweep.appliedPriorityEpoch = sweep.priorityEpoch;
  }
  const chunk = sweep.remaining.slice(0, SWEEP_CHUNK_SIZE);
  const finalChunk = chunk.length === sweep.remaining.length;
  const { touched } = await applyBackgroundChunkParses(chunk, sweep.generation);
  for (const relativePath of touched) {
    try {
      resolveAndBuildEdges(relativePath);
      recordFileCoverage(relativePath);
    } catch (error) {
      recordFileCoverage(relativePath, error);
    }
  }
  sweep.parsedFiles += chunk.length;
  await sweep.leaseHandle.heartbeat();
  if (finalChunk) {
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
    // resourceCoverage can lag this sweep's own settled generation no matter
    // which of several unsynchronized paths produced it - a watcher-driven
    // batch reconcile (repo-runtime-manager's applyBatchToJavaIndex) and a
    // request-driven one (reconcileIfDirty, triggered independently by any
    // foreground request against a dirty runtime) both call
    // JavaIndexClient.reconcile() with no shared singleflight between them,
    // and beginBackgroundSweep's own piggyback-catchup loop can only close a
    // gap that lands while ITS OWN call is still on the stack - a bump that
    // lands after it already returned (this sweep can run for tens of
    // seconds in the background loop below, long after beginBackgroundSweep
    // itself resolved) is invisible to it. This is the one place that always
    // knows the sweep's final, authoritative settled generation - rescan
    // here, before the flush below serializes resourceCoverage's state, so a
    // gap from any of those paths is closed regardless of its origin.
    if (!closing && store && layout && !resourceCoverage.every(entry => entry.generation === sweep.generation)) {
      await indexMyBatisResources(store, layout, sweep.generation);
    }
    // Step 5: a full sweep's completion forces an immediate (non-debounced)
    // flush, since it is exactly the moment the persisted snapshot goes from
    // stale to fully caught-up.
    markSnapshotDirty();
    await flushSnapshotNow();
  }
  sweep.remaining.splice(0, chunk.length);
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

function queryHandlerDeps() {
  return {
    store,
    status,
    deriveSourceLayout,
    queryReadRanges,
    coverageStateFor,
    worstTypeLookupCoverage,
    unresolvedTypeLookup,
    readyEntitySearch,
    readyKnowledgeGraph,
    ensureFactsHydrated,
    ensureGraphReady,
    childColdPeakRssBytes: lastColdBuildMetrics?.rssPeakBytes,
    parentColdIncrementBytes: lastColdBuildMetrics?.parentIncrementBytes,
    respond
  };
}

function markIndexFactsChanged(): void {
  indexFactsRevision += 1;
}

function markGraphAndSearchSynced(): void {
  graphSyncedRevision = indexFactsRevision;
  entitySearchSyncedRevision = indexFactsRevision;
}

function resyncKnowledgeGraphForMyBatisNamespace(namespace: string | undefined): void {
  if (!store || !namespace) return;
  const type = store.typeByFqn(namespace);
  if (!type) return;
  const relativePath = type.fileId.startsWith("file:") ? type.fileId.slice("file:".length) : type.fileId;
  const bundle = store.files([relativePath])[0];
  if (!bundle) return;
  markIndexFactsChanged();
  syncKnowledgeGraphBundle(bundle);
}

function syncKnowledgeGraphFromStore(): void {
  if (!store) return;
  knowledgeBuilder.rebuildFromStore(store, status.indexedGeneration);
  entitySearch.rebuildFromStore(store);
  markGraphAndSearchSynced();
}

function syncKnowledgeGraphBundle(bundle: JavaFileBundle): void {
  if (!store) return;
  knowledgeBuilder.replaceFile(bundle, store, status.indexedGeneration);
  entitySearch.replaceFile(bundle);
  markGraphAndSearchSynced();
}

function readyKnowledgeGraph(): KnowledgeGraphStore {
  if (store && graphSyncedRevision !== indexFactsRevision) syncKnowledgeGraphFromStore();
  return knowledgeGraph;
}

function readyEntitySearch(): EntitySearchIndex {
  if (store && entitySearchSyncedRevision !== indexFactsRevision) {
    entitySearch.rebuildFromStore(store);
    entitySearchSyncedRevision = indexFactsRevision;
  }
  return entitySearch;
}

async function handle(request: JavaIndexRequest): Promise<void> {
  try {
    if (
      request.type !== "HIBERNATE"
      && request.type !== "CLOSE"
      && request.type !== "OPEN"
      && request.type !== "FLUSH"
    ) {
      await ensureAwake();
    }
    if (await handleQueryCommand(request, queryHandlerDeps())) return;
    if (request.type === "QUERY_REPOSITORY_FACT_MARKERS") await ensureFactsHydrated();
    if (await handleMybatisCommand(request, { store, respond })) return;
    switch (request.type) {
      case "OPEN": {
        repoRoot = request.repoRoot;
        resolvedRepoRoot = await realpath(repoRoot).catch(() => path.resolve(repoRoot));
        backend = await createJavaParserBackend();
        cache = new ParseTreeCache();
        store = new JavaIndexStore();
        entitySearch = new EntitySearchIndex();
        knowledgeGraph = new KnowledgeGraphStore();
        knowledgeBuilder = new KnowledgeGraphBuilder(knowledgeGraph);
        indexFactsRevision = 0;
        graphSyncedRevision = -1;
        entitySearchSyncedRevision = -1;
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
        snapshotDirtyRevision = 0;
        snapshotDurableRevision = 0;
        lastDurableSnapshotIdentity = undefined;
        pendingSnapshotView = undefined;
        snapshotFactsHydrated = true;
        hibernated = false;
        hibernateIdentity = undefined;
        hibernatedStatusCounts = undefined;
        lastColdBuildMetrics = undefined;
        coldBuildAttempted = false;

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
        status = {
          ...status,
          state: "READY",
          indexedGeneration: openedGeneration,
          snapshotBytes: 0,
          snapshot: { state: "EMPTY" }
        };
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
        // Always await snapshotFlushPromise, not just the dirty revision: a
        // debounce timer can have already fired moments ago and claimed that
        // revision while the write is still being serialized/compressed.
        const closeFlushDeadline = Date.now() + JAVA_INDEX_CLOSE_FLUSH_BUDGET_MS;
        // The worker's 2s budget is a soft drain limit: it must not ACK merely
        // because an already-started atomic writer crossed that boundary. It
        // only decides whether CLOSE may start one additional dirty retry.
        // The client's shared 2.5s grace only bounds caller-visible close by
        // unrefing the worker; final termination still waits for this ACK.
        await snapshotFlushPromise.catch(() => undefined);
        if (
          snapshotDirtyRevision > snapshotDurableRevision
          && Date.now() < closeFlushDeadline
        ) {
          await flushSnapshotNow().catch(() => undefined);
        }
        status = { ...status, state: "CLOSED" };
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "REFRESH": {
        if (request.generation < status.indexedGeneration) {
          respond({ id: request.id, ok: true, value: currentStatus() });
          return;
        }
        await ensureFactsHydrated();
        invalidateOwnSnapshotVerification(request.generation);
        await handleRefresh(request);
        status = { ...status, indexedGeneration: Math.max(status.indexedGeneration, request.generation) };
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "REFRESH_RESOURCES": {
        // Deliberately does not call invalidateOwnSnapshotVerification: the
        // persisted own-snapshot (schema 2) carries no resource facts at
        // all, so a mapper XML change cannot make its Java-facts
        // verification stale.
        if (request.generation < status.indexedGeneration) {
          respond({ id: request.id, ok: true, value: currentStatus() });
          return;
        }
        await handleRefreshResources(request);
        status = { ...status, indexedGeneration: Math.max(status.indexedGeneration, request.generation) };
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "RECONCILE": {
        if (request.generation < status.indexedGeneration) {
          respond({ id: request.id, ok: true, value: currentStatus() });
          return;
        }
        if (ownSnapshotVerificationPending) {
          invalidateOwnSnapshotVerification(request.generation);
          status = { ...status, indexedGeneration: Math.max(status.indexedGeneration, request.generation) };
          respond({ id: request.id, ok: true, value: currentStatus() });
          return;
        }
        await beginBackgroundSweep(request.generation);
        status = { ...status, indexedGeneration: Math.max(status.indexedGeneration, request.generation) };
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "FLUSH": {
        if (hibernated && snapshotDirtyRevision <= snapshotDurableRevision) {
          respond({ id: request.id, ok: true, value: currentStatus() });
          return;
        }
        await ensureFactsHydrated();
        markSnapshotDirty();
        await flushSnapshotNow();
        respond({ id: request.id, ok: true, value: currentStatus() });
        return;
      }
      case "HIBERNATE": {
        await hibernateIndex();
        respond({
          id: request.id,
          ok: true,
          value: currentStatus({ heapUsedBytes: process.memoryUsage().heapUsed })
        });
        return;
      }
      default: {
        throw new Error(`unhandled command: ${JSON.stringify(request)}`);
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
      if (next) {
        const processingStartedAtMs = performance.now();
        activeForegroundTiming = {
          requestId: next.request.id,
          queueDepthAtEnqueue: next.queueDepthAtEnqueue,
          queueMs: Math.max(0, processingStartedAtMs - next.enqueuedAtMs),
          processingStartedAtMs,
          enabled: next.request.telemetry === true
        };
        try {
          await handle(next.request);
        } finally {
          activeForegroundTiming = undefined;
        }
      }
    }
  } finally {
    drainingForeground = false;
  }
}

parentPort?.on("message", (request: JavaIndexRequest) => {
  // Stop scheduling later background chunks as soon as CLOSE arrives, even
  // if an older foreground request is still draining ahead of it. The active
  // chunk/writer keeps its own reference and is joined at the safe boundary.
  if (request.type === "CLOSE") closing = true;
  foregroundQueue.push({
    request,
    enqueuedAtMs: performance.now(),
    queueDepthAtEnqueue: foregroundQueue.length + (drainingForeground ? 1 : 0)
  });
  void drainForeground();
});

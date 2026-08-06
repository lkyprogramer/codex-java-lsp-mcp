// input: COMPLETE JDT-backed semantic edges (definition/implementation/reference/
//        type-hierarchy) resolved to stable JavaIndex symbol IDs, plus repo change
//        batches and build-fingerprint transitions.
// output: A durable, generation-aware index of repo-contained edges, keyed by
//         source symbol ID, surviving process restarts via an atomic gzip snapshot.
// pos: Task 33 Step 8. Deliberately separate from the JavaIndex static snapshot
//      (different lifecycle: these edges come from live JDT requests, not the AST
//      extractor). Task 33's read-path cutover retired the legacy file-path-keyed
//      src/edge-store.ts once this store's read side was validated end-to-end;
//      this is now the sole persisted-semantic-edge store.
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { isPotentiallyWithin } from "./path-utils.js";
import { repoCacheRoot } from "./repo-layout.js";
import type { SourceRange } from "./runtime/source-range.js";
import type { Completion } from "./runtime/completion.js";
import type { RepoChangeBatch } from "./repo-generation.js";

export type PersistedSemanticEdgeRelation =
  | "JDT_DEFINITION"
  | "JDT_IMPLEMENTATION"
  | "JDT_REFERENCE"
  | "JDT_TYPE_HIERARCHY";

export type PersistedSemanticEdge = {
  edgeId: string;
  sourceSymbolId: string;
  targetSymbolId: string;
  sourceFile: string;
  targetFile: string;
  relation: PersistedSemanticEdgeRelation;
  sourceRange?: SourceRange;
  targetRanges: SourceRange[];
  provenance: "PERSISTED_JDT";
  confidence: 1;
  completion: "COMPLETE";
  dependencies: Array<{ file: string; fingerprint: string }>;
  buildFingerprint: string;
  validatedGeneration: number;
  createdAt: string;
};

export type SemanticEdgeStoreStatus = {
  entries: number;
  snapshotBytes: number;
  generation: number;
  buildFingerprint: string;
  hits: number;
  misses: number;
  invalidations: number;
  promoted: number;
  completeWrites: number;
  rejectedWrites: number;
  lastError?: string;
};

export interface SemanticEdgeStoreV2 {
  findFrom(sourceSymbolId: string, generation: number): readonly PersistedSemanticEdge[];
  putComplete(edges: readonly PersistedSemanticEdge[], generation: number): Promise<void>;
  applyChanges(batch: RepoChangeBatch): void;
  clearForBuildChange(generation: number): void;
  flush(): Promise<void>;
  status(): SemanticEdgeStoreStatus;
}

/** Resolves a source location to the stable JavaIndex symbol ID at that position, if any. */
export type SymbolAnchorResolver = (file: string, line: number, column: number) => Promise<{ symbolId: string } | undefined>;

export type RawSemanticEdgeCandidate = {
  sourceFile: string;
  sourceLine: number;
  sourceColumn: number;
  targetFile: string;
  targetLine: number;
  targetColumn: number;
  targetRanges?: SourceRange[];
  relation: PersistedSemanticEdgeRelation;
  completion: Completion;
  buildFingerprint: string;
  generation: number;
};

/**
 * The mapping step Step 8 calls for before `putComplete`: a non-COMPLETE
 * outcome, an unresolvable symbol on either side, or an out-of-repo location
 * is never turned into a persistable edge - it is used for the current
 * request only. `putComplete` itself re-checks containment as a second line
 * of defence.
 */
export async function mapSemanticEdgeForPersistence(
  candidate: RawSemanticEdgeCandidate,
  repoRoot: string,
  resolveAnchor: SymbolAnchorResolver
): Promise<PersistedSemanticEdge | undefined> {
  if (candidate.completion !== "COMPLETE") {
    return undefined;
  }
  if (!isPotentiallyWithin(repoRoot, candidate.sourceFile) || !isPotentiallyWithin(repoRoot, candidate.targetFile)) {
    return undefined;
  }
  const [source, target] = await Promise.all([
    resolveAnchor(candidate.sourceFile, candidate.sourceLine, candidate.sourceColumn),
    resolveAnchor(candidate.targetFile, candidate.targetLine, candidate.targetColumn)
  ]);
  if (!source || !target) {
    return undefined;
  }
  return {
    edgeId: `${source.symbolId} ${candidate.relation} ${target.symbolId}`,
    sourceSymbolId: source.symbolId,
    targetSymbolId: target.symbolId,
    sourceFile: candidate.sourceFile,
    targetFile: candidate.targetFile,
    relation: candidate.relation,
    targetRanges: candidate.targetRanges ?? [],
    provenance: "PERSISTED_JDT",
    confidence: 1,
    completion: "COMPLETE",
    dependencies: uniqueDependencies([candidate.sourceFile, candidate.targetFile]),
    buildFingerprint: candidate.buildFingerprint,
    validatedGeneration: candidate.generation,
    createdAt: new Date().toISOString()
  };
}

function uniqueDependencies(files: string[]): Array<{ file: string; fingerprint: string }> {
  const seen = new Set<string>();
  const dependencies: Array<{ file: string; fingerprint: string }> = [];
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    dependencies.push({ file, fingerprint: fingerprintFor(file) });
  }
  return dependencies;
}

function fingerprintFor(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

type SnapshotPayloadV1 = {
  schemaVersion: 1;
  generation: number;
  buildFingerprint: string;
  edges: PersistedSemanticEdge[];
};

export type SemanticEdgeStoreWriteHooks = {
  /** Runs after the temp file is written+synced but before the atomic rename. Test-only crash injection, mirroring java-index/snapshot.ts's beforeRename hook. */
  beforeRename?: () => Promise<void>;
  /** Test-only override for the debounced auto-flush delay; production always uses FLUSH_DEBOUNCE_MS. */
  flushDebounceMs?: number;
};

const FLUSH_DEBOUNCE_MS = 1000;

export class FileSemanticEdgeStoreV2 implements SemanticEdgeStoreV2 {
  private readonly snapshotPath: string;
  private readonly edgesBySource = new Map<string, PersistedSemanticEdge[]>();
  private generation = 1;
  private buildFingerprint = "";
  private hits = 0;
  private misses = 0;
  private invalidations = 0;
  private promoted = 0;
  private completeWrites = 0;
  private rejectedWrites = 0;
  private lastError?: string;
  private lastSnapshotBytes = 0;
  private dirty = false;
  private loaded: Promise<void> | undefined;
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repoRoot: string,
    private readonly hooks: SemanticEdgeStoreWriteHooks = {}
  ) {
    this.snapshotPath = path.join(repoCacheRoot(repoRoot), "semantic-edges-v2.json.gz");
  }

  /** Memoized: safe to call from a test, from putComplete()'s own guard, or both - only the first call actually reads the snapshot. */
  async load(): Promise<void> {
    if (!this.loaded) this.loaded = this.doLoad();
    return this.loaded;
  }

  private async doLoad(): Promise<void> {
    let compressed: Buffer;
    try {
      compressed = await readFile(this.snapshotPath);
    } catch {
      return;
    }
    try {
      const json = await gunzipAsync(compressed);
      const parsed = JSON.parse(json.toString("utf8")) as Partial<SnapshotPayloadV1>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.edges)) {
        throw new Error(`unsupported semantic-edges-v2 schemaVersion ${String(parsed.schemaVersion)}`);
      }
      this.generation = parsed.generation ?? 1;
      this.buildFingerprint = parsed.buildFingerprint ?? "";
      this.edgesBySource.clear();
      for (const edge of parsed.edges) {
        const list = this.edgesBySource.get(edge.sourceSymbolId) ?? [];
        list.push(edge);
        this.edgesBySource.set(edge.sourceSymbolId, list);
      }
      this.lastSnapshotBytes = compressed.length;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      await rm(this.snapshotPath, { force: true }).catch(() => undefined);
    }
  }

  findFrom(sourceSymbolId: string, generation: number): readonly PersistedSemanticEdge[] {
    const candidates = this.edgesBySource.get(sourceSymbolId);
    if (!candidates || candidates.length === 0) {
      this.misses += 1;
      return [];
    }
    const valid: PersistedSemanticEdge[] = [];
    const survivors: PersistedSemanticEdge[] = [];
    for (const edge of candidates) {
      if (edge.validatedGeneration >= generation) {
        valid.push(edge);
        survivors.push(edge);
        continue;
      }
      // Lazily revalidate: an edge is only promoted to the requested
      // generation after its dependency fingerprints are rechecked, never
      // just because the generation counter advanced.
      const stillFresh = edge.dependencies.every(dependency => fingerprintFor(dependency.file) === dependency.fingerprint);
      if (!stillFresh) {
        this.invalidations += 1;
        this.dirty = true;
        continue;
      }
      // Promotion is a read-time cache optimization, not new information: if
      // the process restarts before the next flush, the identical fingerprint
      // recheck just runs again on the next findFrom. Marking the store dirty
      // here would force a full re-gzip of every edge on a hot read path for
      // no correctness benefit.
      const promotedEdge: PersistedSemanticEdge = { ...edge, validatedGeneration: generation };
      this.promoted += 1;
      valid.push(promotedEdge);
      survivors.push(promotedEdge);
    }
    if (survivors.length !== candidates.length || survivors.some((edge, index) => edge !== candidates[index])) {
      if (survivors.length > 0) this.edgesBySource.set(sourceSymbolId, survivors);
      else this.edgesBySource.delete(sourceSymbolId);
    }
    if (valid.length > 0) this.hits += 1;
    else this.misses += 1;
    return valid;
  }

  async putComplete(edges: readonly PersistedSemanticEdge[], generation: number): Promise<void> {
    // Load must complete before the first write - otherwise a fresh
    // in-memory-only edge set would clobber the persisted snapshot (which
    // may hold prior sessions' edges) on the next flush. Memoized, so this
    // is a no-op after the first call regardless of who triggers it.
    await this.load();
    for (const edge of edges) {
      if (edge.completion !== "COMPLETE") {
        this.rejectedWrites += 1;
        continue;
      }
      if (!isPotentiallyWithin(this.repoRoot, edge.sourceFile) || !isPotentiallyWithin(this.repoRoot, edge.targetFile)) {
        this.rejectedWrites += 1;
        continue;
      }
      const stamped: PersistedSemanticEdge = { ...edge, validatedGeneration: generation };
      const list = this.edgesBySource.get(edge.sourceSymbolId) ?? [];
      const filtered = list.filter(existing => existing.edgeId !== stamped.edgeId);
      filtered.push(stamped);
      this.edgesBySource.set(edge.sourceSymbolId, filtered);
      this.completeWrites += 1;
      this.dirty = true;
      this.buildFingerprint = edge.buildFingerprint;
    }
    if (edges.length > 0) {
      this.generation = Math.max(this.generation, generation);
    }
    if (this.dirty) this.scheduleFlush();
  }

  applyChanges(batch: RepoChangeBatch): void {
    this.generation = Math.max(this.generation, batch.generation);
    const changedFiles = new Set(batch.changes.map(change => change.absolutePath));
    if (changedFiles.size === 0) return;
    let removed = 0;
    for (const [sourceSymbolId, edges] of this.edgesBySource.entries()) {
      const survivors = edges.filter(edge => !edge.dependencies.some(dependency => changedFiles.has(dependency.file)));
      if (survivors.length !== edges.length) {
        removed += edges.length - survivors.length;
        if (survivors.length > 0) this.edgesBySource.set(sourceSymbolId, survivors);
        else this.edgesBySource.delete(sourceSymbolId);
      }
    }
    if (removed > 0) {
      this.invalidations += removed;
      this.dirty = true;
      this.scheduleFlush();
    }
  }

  clearForBuildChange(generation: number): void {
    if (this.edgesBySource.size > 0) {
      this.invalidations += [...this.edgesBySource.values()].reduce((sum, list) => sum + list.length, 0);
      this.edgesBySource.clear();
      this.dirty = true;
      this.scheduleFlush();
    }
    this.generation = generation;
    this.buildFingerprint = "";
  }

  /**
   * Coalesces a burst of writes into one gzip: `flush()` re-serializes every
   * live edge (O(total entries), not O(new entries)), so calling it on every
   * putComplete() would turn a long-running session's writes into O(n^2)
   * work. Never awaited from a request path - putComplete()/applyChanges()/
   * clearForBuildChange() only schedule it. Mirrors
   * java-index-worker.ts's SNAPSHOT_FLUSH_DEBOUNCE_MS pattern. unref'd: a
   * pending flush must never hold the process open, and losing the last
   * few seconds of writes on an ungraceful exit is fine for a cache that
   * just re-asks JDT next time.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(error => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }, this.hooks.flushDebounceMs ?? FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty) return;
    const payload: SnapshotPayloadV1 = {
      schemaVersion: 1,
      generation: this.generation,
      buildFingerprint: this.buildFingerprint,
      edges: [...this.edgesBySource.values()].flat()
    };
    const directory = path.dirname(this.snapshotPath);
    const tmp = `${this.snapshotPath}.tmp-${process.pid}-${Date.now()}`;
    const json = Buffer.from(JSON.stringify(payload));
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
      await this.hooks.beforeRename?.();
      await rename(tmp, this.snapshotPath);
      this.lastSnapshotBytes = compressed.length;
      this.dirty = false;
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  status(): SemanticEdgeStoreStatus {
    const entries = [...this.edgesBySource.values()].reduce((sum, list) => sum + list.length, 0);
    return {
      entries,
      snapshotBytes: this.lastSnapshotBytes,
      generation: this.generation,
      buildFingerprint: this.buildFingerprint,
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
      promoted: this.promoted,
      completeWrites: this.completeWrites,
      rejectedWrites: this.rejectedWrites,
      lastError: this.lastError
    };
  }
}

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

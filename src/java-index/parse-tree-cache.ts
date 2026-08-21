import type { JavaInputEdit, JavaParserBackend, JavaPoint, JavaSyntaxTree } from "./java-parser-backend.js";

export type ParseTreeCacheOptions = {
  maxEntries: number;
  maxSourceBytes: number;
  maxSingleFileBytes: number;
  maxIncrementalChangeRatio: number;
};

export const DEFAULT_PARSE_TREE_CACHE_OPTIONS: ParseTreeCacheOptions = {
  maxEntries: 128,
  maxSourceBytes: 64 * 1024 * 1024,
  maxSingleFileBytes: 2 * 1024 * 1024,
  maxIncrementalChangeRatio: 0.25
};

export type CachedParseTree = {
  file: string;
  source: string;
  sourceBytes: number;
  tree: JavaSyntaxTree;
  lastUsedAt: number;
};

export type ParseTreeCacheMetrics = {
  incrementalParseHits: number;
  fullParseCount: number;
  evictions: number;
};

// Computes the smallest JavaInputEdit describing the difference between two
// full-file contents, via a common-prefix/common-suffix scan. Indices and
// point columns are UTF-16 code units - this backend's coordinate system
// (see java-parser-backend.ts) - not UTF-8 bytes, despite Tree-sitter's
// "byte"-style field naming. Returns undefined for unchanged text, either
// side exceeding maxSingleFileBytes, or a changed region exceeding
// maxIncrementalChangeRatio of the old source's length.
export function computeSingleEdit(
  oldSource: string,
  newSource: string,
  options: Pick<ParseTreeCacheOptions, "maxSingleFileBytes" | "maxIncrementalChangeRatio">
): JavaInputEdit | undefined {
  if (oldSource === newSource) return undefined;

  if (
    Buffer.byteLength(oldSource, "utf8") > options.maxSingleFileBytes
    || Buffer.byteLength(newSource, "utf8") > options.maxSingleFileBytes
  ) {
    return undefined;
  }

  const maxPrefix = Math.min(oldSource.length, newSource.length);
  let prefixLength = 0;
  while (prefixLength < maxPrefix && oldSource.charCodeAt(prefixLength) === newSource.charCodeAt(prefixLength)) {
    prefixLength += 1;
  }

  const maxSuffix = maxPrefix - prefixLength;
  let suffixLength = 0;
  while (
    suffixLength < maxSuffix
    && oldSource.charCodeAt(oldSource.length - 1 - suffixLength)
      === newSource.charCodeAt(newSource.length - 1 - suffixLength)
  ) {
    suffixLength += 1;
  }

  const oldChangedLength = oldSource.length - prefixLength - suffixLength;
  const newChangedLength = newSource.length - prefixLength - suffixLength;
  const changeRatio = Math.max(oldChangedLength, newChangedLength) / Math.max(1, oldSource.length);
  if (changeRatio > options.maxIncrementalChangeRatio) return undefined;

  const startIndex = prefixLength;
  const oldEndIndex = oldSource.length - suffixLength;
  const newEndIndex = newSource.length - suffixLength;

  return {
    startIndex,
    oldEndIndex,
    newEndIndex,
    startPosition: pointAt(oldSource, startIndex),
    oldEndPosition: pointAt(oldSource, oldEndIndex),
    newEndPosition: pointAt(newSource, newEndIndex)
  };
}

function pointAt(text: string, index: number): JavaPoint {
  let row = 0;
  let lastNewlineIndex = -1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 0x0a) {
      row += 1;
      lastNewlineIndex = i;
    }
  }
  return { row, column: index - lastNewlineIndex - 1 };
}

// Task 20 Step 4a's dynamic background-sweep budget: a machine running several
// concurrent MCP runtimes must shrink each one's parse-tree LRU so their sum
// stays reasonable, while a lone runtime keeps the full default. An explicit
// override always wins, since the operator has more information than any
// runtime-count heuristic.
export function effectiveParseTreeSourceBudget(
  configuredBytes: number | undefined,
  activeMachineRuntimes: number
): number {
  if (configuredBytes) return configuredBytes;
  if (activeMachineRuntimes >= 3) return 24 * 1024 * 1024;
  if (activeMachineRuntimes >= 2) return 32 * 1024 * 1024;
  return 64 * 1024 * 1024;
}

export class ParseTreeCache {
  readonly metrics: ParseTreeCacheMetrics = { incrementalParseHits: 0, fullParseCount: 0, evictions: 0 };
  private readonly entries = new Map<string, CachedParseTree>();
  private totalSourceBytes = 0;

  constructor(readonly options: ParseTreeCacheOptions = DEFAULT_PARSE_TREE_CACHE_OPTIONS) {}

  /** Applied before starting a background sweep chunk, not on every parser callback (Step 4a). */
  setMaxSourceBytes(bytes: number): void {
    this.options.maxSourceBytes = bytes;
    this.evictIfNeeded();
  }

  get(file: string): CachedParseTree | undefined {
    const entry = this.entries.get(file);
    if (!entry) return undefined;
    // Re-insertion moves this entry to the Map's most-recently-used position;
    // iteration order is insertion order, so the first key is always the
    // least-recently-used one.
    entry.lastUsedAt = Date.now();
    this.entries.delete(file);
    this.entries.set(file, entry);
    return entry;
  }

  replace(file: string, source: string, tree: JavaSyntaxTree): void {
    const sourceBytes = Buffer.byteLength(source, "utf8");
    const existing = this.entries.get(file);
    if (existing) {
      this.totalSourceBytes -= existing.sourceBytes;
      this.entries.delete(file);
      if (existing.tree !== tree) existing.tree.delete();
    }
    if (sourceBytes <= this.options.maxSingleFileBytes) {
      this.entries.set(file, { file, source, sourceBytes, tree, lastUsedAt: Date.now() });
      this.totalSourceBytes += sourceBytes;
    }
    this.evictIfNeeded();
  }

  delete(file: string): void {
    const existing = this.entries.get(file);
    if (!existing) return;
    this.entries.delete(file);
    this.totalSourceBytes -= existing.sourceBytes;
    existing.tree.delete();
  }

  size(): number {
    return this.entries.size;
  }

  /** Drops every cached tree. Hibernate / CLOSE; not an LRU eviction. */
  clear(): void {
    for (const entry of this.entries.values()) entry.tree.delete();
    this.entries.clear();
    this.totalSourceBytes = 0;
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.options.maxEntries || this.totalSourceBytes > this.options.maxSourceBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      this.totalSourceBytes -= oldest.sourceBytes;
      oldest.tree.delete();
      this.metrics.evictions += 1;
    }
  }
}

export type RefreshedParseTree = {
  tree: JavaSyntaxTree;
  incremental: boolean;
};

// The shared refresh algorithm: reuse an incremental edit against the cached
// tree when eligible, otherwise fall back to a full parse; either way, the
// cache always ends up holding the new tree/source for `file`.
export function refreshParseTree(
  cache: ParseTreeCache,
  backend: JavaParserBackend,
  file: string,
  content: string
): RefreshedParseTree {
  const cached = cache.get(file);
  const edit = cached ? computeSingleEdit(cached.source, content, cache.options) : undefined;

  let tree: JavaSyntaxTree;
  let incremental = false;
  if (cached && edit) {
    cached.tree.edit(edit);
    tree = backend.parse(content, cached.tree);
    incremental = true;
    cache.metrics.incrementalParseHits += 1;
  } else {
    tree = backend.parse(content);
    cache.metrics.fullParseCount += 1;
  }

  cache.replace(file, content, tree);
  return { tree, incremental };
}

// input: A repo root with no usable v4 snapshot.
// output: Writes java-index v4 + knowledge-graph snapshots, then exits.
// pos: M3 P3 cold-build child. Parent never holds native parse-tree watermark.
import { realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { probeLayout } from "../layout-probe.js";
import { KnowledgeGraphBuilder } from "../java-knowledge/graph-builder.js";
import { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";
import { packGraphSnapshot, writeGraphSnapshotAtomic } from "../java-knowledge/graph-snapshot.js";
import { computeBuildFingerprint, computeExtractorVersion } from "./build-fingerprint.js";
import { CoverageTracker } from "./coverage.js";
import { buildStaticEdges, resolveFileRefs } from "./edge-builder.js";
import { EntitySearchIndex } from "./entity-search.js";
import { parseJavaSourceFile } from "./java-index-file-parse.js";
import { JavaIndexStore } from "./index-store.js";
import { createJavaParserBackend } from "./java-parser-backend.js";
import {
  computeCurrentSnapshotManifestFingerprint,
  discoverJavaFiles
} from "./manifest.js";
import { JavaNameResolver, buildTypeRegistryView } from "./name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "./parse-tree-cache.js";
import {
  loadSnapshot,
  writeSnapshotAtomic,
  writeSnapshotIfManifestCurrent,
  type JavaIndexSnapshotV3
} from "./snapshot.js";
import { STABLE_ID_VERSION } from "./stable-id.js";
import type { JavaTypeFacts } from "./index-types.js";

export const SNAPSHOT_FILE_NAME = "java-index-snapshot.json.gz";
export const GRAPH_SNAPSHOT_FILE_NAME = "java-knowledge-graph.json.gz";
export const PARSE_SNAPSHOT_FILE_NAME = "cold-parse-snapshot.json.gz";
export type ColdBuildPhase = "parse" | "resolve" | "all";

export type ColdBuildPhasesMs = {
  discover: number;
  parse: number;
  resolve: number;
  snapshotPrepare: number;
  snapshotEncode: number;
  graphEncode: number;
  total: number;
};

export type ColdBuildResult = {
  ok: true;
  files: number;
  discovered: number;
  parseFailed: number;
  lastParseError?: string;
  snapshotBytes: number;
  rssPeakBytes: number;
  heapUsedBytes: number;
  phasesMs: ColdBuildPhasesMs;
};

export async function runColdIndexBuild(
  repoRoot: string,
  cacheDir: string,
  generation: number,
  buildPhase: ColdBuildPhase = "all"
): Promise<ColdBuildResult> {
  const rss = { peak: process.memoryUsage().rss };
  const sample = setInterval(() => {
    rss.peak = Math.max(rss.peak, process.memoryUsage().rss);
  }, 100);
  sample.unref?.();
  const started = performance.now();
  const mark = (from: number) => performance.now() - from;
  try {
    const resolvedRepoRoot = await realpath(repoRoot).catch(() => path.resolve(repoRoot));
    const layout = probeLayout(resolvedRepoRoot);
    const store = new JavaIndexStore();
    const coverage = new CoverageTracker();
    const graph = new KnowledgeGraphStore();
    const graphBuilder = new KnowledgeGraphBuilder(graph);
    const pathsByRoot = new Map<string, string[]>();
    let discoveredCount = 0;
    let parseFailed = 0;
    let lastParseError: string | undefined;
    let discoverMs = 0;
    let parseMs = 0;

    if (buildPhase !== "resolve") {
      const backend = await createJavaParserBackend();
      const cache = new ParseTreeCache({
        ...DEFAULT_PARSE_TREE_CACHE_OPTIONS,
        maxEntries: 1,
        maxSourceBytes: 1
      });
      let phase = performance.now();
      const discovered = await discoverJavaFiles(resolvedRepoRoot, layout);
      discoverMs = mark(phase);
      discoveredCount = discovered.length;
      const byRoot = new Map<string, number>();
      for (const file of discovered) byRoot.set(file.sourceRoot, (byRoot.get(file.sourceRoot) ?? 0) + 1);
      for (const [root, count] of byRoot) coverage.begin(root, generation, count);
      phase = performance.now();
      for (const file of discovered) {
        try {
          const bundle = await parseJavaSourceFile({
            repoRoot: resolvedRepoRoot,
            resolvedRepoRoot,
            inputPath: file.absolutePath,
            generation,
            backend,
            cache,
            layout
          });
          store.replaceFile(bundle);
          const bucket = pathsByRoot.get(bundle.file.sourceRoot);
          if (bucket) bucket.push(bundle.file.relativePath);
          else pathsByRoot.set(bundle.file.sourceRoot, [bundle.file.relativePath]);
          coverage.indexed(file.sourceRoot);
        } catch (error) {
          parseFailed += 1;
          if (!lastParseError) lastParseError = error instanceof Error ? error.stack ?? error.message : String(error);
          coverage.failed(file.sourceRoot, file.relativePath, error);
        }
      }
      parseMs = mark(phase);
    } else {
      const buildFingerprint = await computeBuildFingerprint(resolvedRepoRoot, layout);
      if (!buildFingerprint) throw new Error("snapshot build fingerprint unavailable");
      const loaded = await loadSnapshot(path.join(cacheDir, PARSE_SNAPSHOT_FILE_NAME), {
        extractorVersion: computeExtractorVersion(),
        stableIdVersion: STABLE_ID_VERSION,
        canonicalRepoRoot: repoRoot,
        buildFingerprint
      });
      if (!loaded) throw new Error("cold parse snapshot missing or identity mismatch");
      store.loadSnapshotData(loaded);
      for (const entry of loaded.coverage) coverage.restoreProvisional(entry);
      discoveredCount = loaded.files.length;
      parseFailed = loaded.coverage.reduce((sum, entry) => sum + entry.failedFiles, 0);
      for (const file of loaded.files) {
        const bucket = pathsByRoot.get(file.sourceRoot);
        if (bucket) bucket.push(file.relativePath);
        else pathsByRoot.set(file.sourceRoot, [file.relativePath]);
      }
    }

    if (buildPhase === "parse") {
      return finish(cacheDir, {
        rss,
        started,
        mark,
        repoRoot,
        resolvedRepoRoot,
        layout,
        store,
        coverage,
        generation,
        discoveredCount,
        parseFailed,
        lastParseError,
        discoverMs,
        parseMs,
        resolveMs: 0,
        snapshotTarget: path.join(cacheDir, PARSE_SNAPSHOT_FILE_NAME),
        publishIfCurrent: false,
        graph: undefined
      });
    }

    let phase = performance.now();
    resolveAll(store, pathsByRoot, graphBuilder, generation);
    maybeGc();
    const resolveMs = mark(phase);
    for (const entry of coverage.snapshot()) coverage.complete(entry.root, generation);
    const result = await finish(cacheDir, {
      rss,
      started,
      mark,
      repoRoot,
      resolvedRepoRoot,
      layout,
      store,
      coverage,
      generation,
      discoveredCount,
      parseFailed,
      lastParseError,
      discoverMs,
      parseMs,
      resolveMs,
      snapshotTarget: path.join(cacheDir, SNAPSHOT_FILE_NAME),
      publishIfCurrent: true,
      graph
    });
    if (buildPhase === "resolve") {
      await rm(path.join(cacheDir, PARSE_SNAPSHOT_FILE_NAME), { force: true }).catch(() => undefined);
    }
    return result;
  } finally {
    clearInterval(sample);
  }
}

async function finish(
  cacheDir: string,
  args: {
    rss: { peak: number };
    started: number;
    mark: (from: number) => number;
    repoRoot: string;
    resolvedRepoRoot: string;
    layout: ReturnType<typeof probeLayout>;
    store: JavaIndexStore;
    coverage: CoverageTracker;
    generation: number;
    discoveredCount: number;
    parseFailed: number;
    lastParseError?: string;
    discoverMs: number;
    parseMs: number;
    resolveMs: number;
    snapshotTarget: string;
    publishIfCurrent: boolean;
    graph: KnowledgeGraphStore | undefined;
  }
): Promise<ColdBuildResult> {
  let phase = performance.now();
  const buildFingerprint = await computeBuildFingerprint(args.resolvedRepoRoot, args.layout);
  if (!buildFingerprint) throw new Error("snapshot build fingerprint unavailable");
  const data = args.store.toSnapshotData();
  const entitySearch = new EntitySearchIndex();
  entitySearch.rebuildFromStore(args.store);
  const value: JavaIndexSnapshotV3 = {
    schemaVersion: 3,
    extractorVersion: computeExtractorVersion(),
    stableIdVersion: STABLE_ID_VERSION,
    canonicalRepoRoot: args.repoRoot,
    buildFingerprint,
    manifestFingerprint: await computeCurrentSnapshotManifestFingerprint(args.resolvedRepoRoot, args.layout),
    indexedGeneration: args.generation,
    createdAt: new Date().toISOString(),
    coverage: args.coverage.snapshot(),
    resourceCoverage: [],
    ...data,
    entitySearch: entitySearch.toSnapshot()
  };
  const fileCount = data.files.length;
  args.store.loadSnapshotData({
    files: [],
    types: [],
    fields: [],
    methods: [],
    edges: [],
    myBatisResources: []
  });
  maybeGc();
  const snapshotPrepareMs = args.mark(phase);
  phase = performance.now();
  const snapshotBytes = args.publishIfCurrent
    ? await writeSnapshotIfManifestCurrent(
      args.snapshotTarget,
      value,
      () => computeCurrentSnapshotManifestFingerprint(args.resolvedRepoRoot, args.layout)
    )
    : await writeSnapshotAtomic(args.snapshotTarget, value);
  const snapshotEncodeMs = args.mark(phase);
  phase = performance.now();
  if (args.graph) {
    await writeGraphSnapshotAtomic(path.join(cacheDir, GRAPH_SNAPSHOT_FILE_NAME), packGraphSnapshot(args.graph));
  }
  const graphEncodeMs = args.graph ? args.mark(phase) : 0;
  const phasesMs = {
    discover: args.discoverMs,
    parse: args.parseMs,
    resolve: args.resolveMs,
    snapshotPrepare: snapshotPrepareMs,
    snapshotEncode: snapshotEncodeMs,
    graphEncode: graphEncodeMs,
    total: args.mark(args.started)
  };
  await writeFile(path.join(cacheDir, "cold-build-metrics.json"), `${JSON.stringify({
    rssPeakBytes: args.rss.peak,
    heapUsedBytes: process.memoryUsage().heapUsed,
    files: fileCount,
    phasesMs
  })}\n`);
  return {
    ok: true,
    files: fileCount,
    discovered: args.discoveredCount,
    parseFailed: args.parseFailed,
    ...(args.lastParseError ? { lastParseError: args.lastParseError } : {}),
    snapshotBytes,
    rssPeakBytes: args.rss.peak,
    heapUsedBytes: process.memoryUsage().heapUsed,
    phasesMs
  };
}

function maybeGc(): void {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  gc?.();
}

function resolveAll(
  store: JavaIndexStore,
  pathsByRoot: ReadonlyMap<string, readonly string[]>,
  graphBuilder: KnowledgeGraphBuilder,
  generation: number
): void {
  const registry = buildTypeRegistryView([...store.typesById.values()], [], owner => store.methodsOfOwner(owner));
  const resolver = new JavaNameResolver(registry);
  const byId = registry.byId as Map<string, JavaTypeFacts>;
  for (const paths of pathsByRoot.values()) {
    for (const relativePath of paths) {
      const raw = store.files([relativePath])[0];
      if (!raw) continue;
      const resolved = resolveFileRefs(raw, resolver, registry);
      store.replaceFile({ ...resolved, edges: [] });
      for (const type of resolved.types) byId.set(type.typeId, type);
    }
    maybeGc();
  }
  for (const paths of pathsByRoot.values()) {
    for (const relativePath of paths) {
      const resolved = store.files([relativePath])[0];
      if (!resolved) continue;
      const edges = buildStaticEdges(resolved, registry, resolver);
      const withEdges = { ...resolved, edges };
      store.replaceFile(withEdges);
      graphBuilder.replaceFile(withEdges, store, generation);
    }
    maybeGc();
  }
}

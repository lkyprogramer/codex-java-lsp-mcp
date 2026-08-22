// input: A repo root with no usable v4 snapshot.
// output: Writes java-index v4 + knowledge-graph snapshots, then exits.
// pos: M3 P3 cold-build child. Parent never holds native parse-tree watermark.
import { realpath, writeFile } from "node:fs/promises";
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
import { writeSnapshotIfManifestCurrent, type JavaIndexSnapshotV3 } from "./snapshot.js";
import { STABLE_ID_VERSION } from "./stable-id.js";

export const SNAPSHOT_FILE_NAME = "java-index-snapshot.json.gz";
export const GRAPH_SNAPSHOT_FILE_NAME = "java-knowledge-graph.json.gz";

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

export async function runColdIndexBuild(repoRoot: string, cacheDir: string, generation: number): Promise<ColdBuildResult> {
  let rssPeak = process.memoryUsage().rss;
  const sample = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 100);
  sample.unref?.();
  const started = performance.now();
  const mark = (from: number) => performance.now() - from;
  try {
    const resolvedRepoRoot = await realpath(repoRoot).catch(() => path.resolve(repoRoot));
    const layout = probeLayout(resolvedRepoRoot);
    const backend = await createJavaParserBackend();
    const cache = new ParseTreeCache({
      ...DEFAULT_PARSE_TREE_CACHE_OPTIONS,
      maxEntries: 1,
      maxSourceBytes: 1
    });
    const store = new JavaIndexStore();
    const coverage = new CoverageTracker();
    const graph = new KnowledgeGraphStore();
    const graphBuilder = new KnowledgeGraphBuilder(graph);
    let phase = performance.now();
    const discovered = await discoverJavaFiles(resolvedRepoRoot, layout);
    const discoverMs = mark(phase);
    const byRoot = new Map<string, number>();
    for (const file of discovered) byRoot.set(file.sourceRoot, (byRoot.get(file.sourceRoot) ?? 0) + 1);
    for (const [root, count] of byRoot) coverage.begin(root, generation, count);
    const relativePaths: string[] = [];
    let parseFailed = 0;
    let lastParseError: string | undefined;
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
        relativePaths.push(bundle.file.relativePath);
        coverage.indexed(file.sourceRoot);
      } catch (error) {
        parseFailed += 1;
        if (!lastParseError) lastParseError = error instanceof Error ? error.stack ?? error.message : String(error);
        coverage.failed(file.sourceRoot, file.relativePath, error);
      }
    }
    const parseMs = mark(phase);
    phase = performance.now();
    resolveAll(store, relativePaths, graphBuilder, generation);
    const resolveMs = mark(phase);
    for (const root of byRoot.keys()) coverage.complete(root, generation);
    phase = performance.now();
    const buildFingerprint = await computeBuildFingerprint(resolvedRepoRoot, layout);
    if (!buildFingerprint) throw new Error("snapshot build fingerprint unavailable");
    const data = store.toSnapshotData();
    const entitySearch = new EntitySearchIndex();
    entitySearch.rebuildFromStore(store);
    const value: JavaIndexSnapshotV3 = {
      schemaVersion: 3,
      extractorVersion: computeExtractorVersion(),
      stableIdVersion: STABLE_ID_VERSION,
      canonicalRepoRoot: repoRoot,
      buildFingerprint,
      manifestFingerprint: await computeCurrentSnapshotManifestFingerprint(resolvedRepoRoot, layout),
      indexedGeneration: generation,
      createdAt: new Date().toISOString(),
      coverage: coverage.snapshot(),
      resourceCoverage: [],
      ...data,
      entitySearch: entitySearch.toSnapshot()
    };
    const snapshotPrepareMs = mark(phase);
    const snapshotPath = path.join(cacheDir, SNAPSHOT_FILE_NAME);
    phase = performance.now();
    const snapshotBytes = await writeSnapshotIfManifestCurrent(
      snapshotPath,
      value,
      () => computeCurrentSnapshotManifestFingerprint(resolvedRepoRoot, layout)
    );
    const snapshotEncodeMs = mark(phase);
    phase = performance.now();
    await writeGraphSnapshotAtomic(path.join(cacheDir, GRAPH_SNAPSHOT_FILE_NAME), packGraphSnapshot(graph));
    const graphEncodeMs = mark(phase);
    const phasesMs = {
      discover: discoverMs,
      parse: parseMs,
      resolve: resolveMs,
      snapshotPrepare: snapshotPrepareMs,
      snapshotEncode: snapshotEncodeMs,
      graphEncode: graphEncodeMs,
      total: mark(started)
    };
    await writeFile(path.join(cacheDir, "cold-build-metrics.json"), `${JSON.stringify({
      rssPeakBytes: rssPeak,
      heapUsedBytes: process.memoryUsage().heapUsed,
      files: data.files.length,
      phasesMs
    })}\n`);
    return {
      ok: true,
      files: data.files.length,
      discovered: discovered.length,
      parseFailed,
      ...(lastParseError ? { lastParseError } : {}),
      snapshotBytes,
      rssPeakBytes: rssPeak,
      heapUsedBytes: process.memoryUsage().heapUsed,
      phasesMs
    };
  } finally {
    clearInterval(sample);
  }
}

function resolveAll(
  store: JavaIndexStore,
  relativePaths: readonly string[],
  graphBuilder: KnowledgeGraphBuilder,
  generation: number
): void {
  const registry = buildTypeRegistryView([...store.typesById.values()], [], owner => store.methodsOfOwner(owner));
  const resolver = new JavaNameResolver(registry);
  const resolvedByPath = new Map<string, ReturnType<typeof resolveFileRefs>>();
  for (const relativePath of relativePaths) {
    const raw = store.files([relativePath])[0];
    if (!raw) continue;
    const resolved = resolveFileRefs(raw, resolver, registry);
    resolvedByPath.set(relativePath, resolved);
    store.replaceFile({ ...resolved, edges: [] });
  }
  const finalRegistry = buildTypeRegistryView([...store.typesById.values()], [], owner => store.methodsOfOwner(owner));
  const finalResolver = new JavaNameResolver(finalRegistry);
  for (const [relativePath, resolved] of resolvedByPath) {
    const edges = buildStaticEdges(resolved, finalRegistry, finalResolver);
    const withEdges = { ...resolved, edges };
    store.replaceFile(withEdges);
    graphBuilder.replaceFile(withEdges, store, generation);
  }
}

import { captureSource, type SourceCapture } from "../java-index/source-capture.js";
import { captureCensus, finishCaptureCensus, type CaptureCensusEntry } from "./capture-census.js";
import { realpath } from "node:fs/promises";
import { cpus } from "node:os";
import path from "node:path";
import { probeLayout } from "../layout-probe.js";
import { buildStaticEdges, resolveFileRefs } from "../java-index/edge-builder.js";
import { recordsFromBundle } from "../java-index/entity-search.js";
import type { JavaFileBundle } from "../java-index/index-types.js";
import { parseJavaSourceFile } from "../java-index/java-index-file-parse.js";
import { createJavaParserBackend } from "../java-index/java-parser-backend.js";
import { discoverJavaFiles, discoverMyBatisResourceFiles } from "../java-index/manifest.js";
import { extractMyBatisMapperFacts } from "../java-index/mybatis-xml-extractor.js";
import type { MyBatisMapperResourceFacts } from "../java-index/mybatis-types.js";
import { JavaNameResolver } from "../java-index/name-resolver.js";
import { KnowledgeGraphBuilder } from "../java-knowledge/graph-builder.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../java-index/builder/parse-cache.js";
import { prepareCached, withTransaction, type IndexDatabase } from "../java-index/sql/driver.js";
import { rebuildEntityDf, writeEntityRecord } from "../java-index/sql/entity-tokens.js";
import {
  commitSearchDocStats,
  myBatisBindingFilter,
  rebuildSearchDocDf,
  replaceSearchDocuments
} from "../java-index/sql/search-docs.js";
import { buildSearchDocuments } from "../discovery/search-document.js";
import { SqlFactsStore } from "../java-index/sql/facts-store.js";
import { SqlKnowledgeGraph } from "../java-index/sql/knowledge-graph.js";
import { buildSqlRegistryView } from "../java-index/sql/registry-view.js";
import { readBundle, readMyBatisResource, recordResourceScan, replaceBundleEdges, updateBundleFacts, writeBundle, writeMyBatisResource } from "../java-index/sql/rows.js";
import { attachWorkspaceStat, clearStats, observedStats, recordStats, type StatRow } from "../java-index/sql/workspace-stat.js";
import {
  clearIndexData,
  publishIndexCoverage,
  readBuildProgress,
  readMeta,
  refreshIndexCounts,
  writeBuildProgress,
  writeMeta,
  type BuildProgress,
  type IndexCounts
} from "./progress.js";

export const COLD_BUILD_BATCH_SIZE = 200;

export type SqlColdBuildOptions = {
  repoRoot: string;
  db: IndexDatabase;
  generation?: number;
  parallelism?: number;
  batchSize?: number;
  onProgress?: (progress: BuildProgress) => void;
  shouldAbort?: (progress: BuildProgress) => boolean;
};

export type SqlColdBuildResult = IndexCounts & {
  ok: true;
  census: CaptureCensusEntry[];
  parseFailed: number;
  parseFailures: Array<{ relativePath: string; message: string }>;
};

export function builderParallelism(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const fromEnv = Number(process.env.JAVA_LSP_BUILDER_PARALLELISM);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return Math.max(1, Math.min(4, cpus().length - 1));
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, workerId: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workers }, async (_, workerId) => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, workerId);
    }
  }));
  return results;
}

function existingPaths(db: IndexDatabase): Set<string> {
  return new Set((db.prepare("SELECT path FROM file").all() as Array<{ path: string }>).map(row => row.path));
}

function commitProgress(db: IndexDatabase, progress: BuildProgress): IndexCounts {
  writeBuildProgress(db, progress);
  return refreshIndexCounts(db);
}

function afterCommit(progress: BuildProgress, options: SqlColdBuildOptions): void {
  options.onProgress?.(progress);
  if (options.shouldAbort?.(progress)) throw new Error("injected abort");
}

export async function runSqlColdBuild(options: SqlColdBuildOptions): Promise<SqlColdBuildResult> {
  const generation = options.generation ?? 1;
  const batchSize = options.batchSize && options.batchSize > 0 ? Math.floor(options.batchSize) : COLD_BUILD_BATCH_SIZE;
  const parallelism = builderParallelism(options.parallelism);
  const db = options.db;
  db.exec("PRAGMA cache_size=-16384");
  const resolvedRepoRoot = await realpath(options.repoRoot);
  const layout = probeLayout(resolvedRepoRoot);
  attachWorkspaceStat(db);

  const beforeCapture = captureCensus(db);
  if (readMeta(db, "buildState") !== "BUILDING") {
    withTransaction(db, () => {
      clearIndexData(db);
      clearStats(db);
    });
  }
  writeMeta(db, "buildState", "BUILDING");
  db.prepare("UPDATE source_root_coverage SET state='BUILDING'").run();

  const discovered = await discoverJavaFiles(resolvedRepoRoot, layout);
  const total = discovered.length;
  // An interrupted build may resume after the worktree changed. Invalidate
  // stale declarations before reusing the durable cursor; all resolution then
  // reruns against the current declaration set.
  const known = db.prepare("SELECT path, content_hash AS hash, source_root AS root, parse_state AS state FROM file").all() as Array<{ path: string; hash: string; root: string; state: string }>;
  const manifest = new Map(discovered.map(file => [file.relativePath, file]));
  const stale: string[] = [];
  const captures = new Map<string, SourceCapture>();
  for (const row of known) {
    const file = manifest.get(row.path);
    const captured = file ? await captureSource(resolvedRepoRoot, file.absolutePath).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }) : undefined;
    if (captured) captures.set(file!.relativePath, captured);
    if (!file || !captured || file.sourceRoot !== row.root || row.state === "FAILED" ||
      captured.contentHash !== row.hash) stale.push(row.path);
    else captures.delete(row.path);
  }
  if (stale.length > 0 || known.length !== total && readBuildProgress(db)?.phase === "resolve") {
    withTransaction(db, () => {
      for (const relativePath of stale) db.prepare("DELETE FROM file WHERE path=?").run(relativePath);
      writeBuildProgress(db, { phase: "declare", done: 0, total });
    });
  }
  let progress = readBuildProgress(db) ?? { phase: "declare" as const, done: 0, total };
  progress = { ...progress, total };
  let parseFailed = 0;
  const parseFailures: Array<{ relativePath: string; message: string }> = [];

  if (progress.phase === "declare") {
    const skip = existingPaths(db);
    const remaining = discovered.filter(file => !skip.has(file.relativePath));
    const backend = await createJavaParserBackend();
    const caches = Array.from({ length: parallelism }, () => new ParseTreeCache({
      ...DEFAULT_PARSE_TREE_CACHE_OPTIONS,
      maxEntries: 8
    }));
    for (let offset = 0; offset < remaining.length; offset += batchSize) {
      const chunk = remaining.slice(offset, offset + batchSize);
      const parsed = await mapPool(chunk, parallelism, async (file, workerId) => {
        const cache = caches[workerId]!;
        try {
          const bundle = await parseJavaSourceFile({
            capture: captures.get(file.relativePath),
            repoRoot: resolvedRepoRoot,
            resolvedRepoRoot,
            inputPath: file.absolutePath,
            generation,
            backend,
            cache,
            layout
          });
          captures.delete(file.relativePath);
          cache.delete(bundle.file.relativePath);
          if (bundle.file.parseState === "FAILED") {
            parseFailures.push({ relativePath: file.relativePath, message: `Java parse failed (${bundle.file.parseErrorCount} errors)` });
          }
          return bundle;
        } catch (err) {
          if (isFatalIndexIoError(err)) throw err;
          parseFailures.push({
            relativePath: file.relativePath,
            message: err instanceof Error ? err.message : String(err)
          });
          return undefined;
        }
      });
      const bundles = parsed.filter((bundle): bundle is JavaFileBundle => bundle !== undefined);
      parseFailed += parsed.length - bundles.length + bundles.filter(bundle => bundle.file.parseState === "FAILED").length;
      const next = withTransaction(db, () => {
        for (const bundle of bundles) writeBundle(db, bundle);
        recordStats(db, "java", observedStats(bundles));
        return commitProgress(db, { phase: "declare", done: existingPaths(db).size, total });
      });
      afterCommit({ phase: "declare", done: next.files, total }, options);
    }
  }

  const xmlFiles = await discoverMyBatisResourceFiles(resolvedRepoRoot, layout);
  const resources: MyBatisMapperResourceFacts[] = [];
  const scans: StatRow[] = [];
  const resourceHashes: Array<{path:string;contentHash:string}> = [];
  for (const file of xmlFiles) {
    const capture = await captureSource(resolvedRepoRoot, file.absolutePath);
    const bytes = capture.bytes;
    const content = bytes.toString("utf8");
    const contentHash = capture.contentHash;
    resourceHashes.push({path:file.relativePath,contentHash});
    if(capture.observed) scans.push({ path: file.relativePath, contentHash, ...capture.observed });
    const resource = extractMyBatisMapperFacts({
      relativePath: file.relativePath,
      content,
      contentHash,
      generation
    });
    if (resource) resources.push(resource);
  }
  const declared = progress.phase === "declare";
  progress = withTransaction(db, () => {
    // This is a full cold-build census, including resume from resolve. Replace
    // its resource set so removed XML and mapper-to-nonmapper edits cannot
    // leave old evidence behind when the graph/documents rebuild below.
    db.exec("DELETE FROM mybatis_resource; DELETE FROM resource_scan;");
    clearStats(db, "resource");
    for (const resource of resources) writeMyBatisResource(db, resource);
    for (const scan of resourceHashes) recordResourceScan(db, scan.path, scan.contentHash);
    recordStats(db, "resource", scans);
    const next: BuildProgress = declared ? { phase: "resolve", done: 0, total } : progress;
    commitProgress(db, next);
    return next;
  });
  if (declared) afterCommit(progress, options);

  const store = new SqlFactsStore(db);
  const view = buildSqlRegistryView(store);
  const resolver = new JavaNameResolver(view);
  for (let offset = 0; offset < discovered.length; offset += batchSize) {
    const chunk = discovered.slice(offset, offset + batchSize);
    withTransaction(db, () => {
      for (const file of chunk) {
        const raw = readBundle(db, file.relativePath);
        if (!raw) continue;
        const resolved = resolveFileRefs(raw, resolver, view);
        updateBundleFacts(db, { ...resolved, edges: [] });
        store.clearRequestCache();
      }
      commitProgress(db, { phase: "resolve", done: progress.done, total });
    });
  }

  const edgeStore = new SqlFactsStore(db);
  const edgeView = buildSqlRegistryView(edgeStore);
  const edgeResolver = new JavaNameResolver(edgeView);
  for (let offset = progress.done; offset < discovered.length; offset += batchSize) {
    const chunk = discovered.slice(offset, offset + batchSize);
    progress = withTransaction(db, () => {
      for (const file of chunk) {
        const resolved = readBundle(db, file.relativePath);
        if (!resolved) continue;
        replaceBundleEdges(db, file.relativePath, buildStaticEdges(resolved, edgeView, edgeResolver));
      }
      const next: BuildProgress = { phase: "resolve", done: offset + chunk.length, total };
      commitProgress(db, next);
      return next;
    });
    afterCommit(progress, options);
  }

  writeKnowledgeAndEntities(db, generation, resolvedRepoRoot);

  const roots = layout.sourceRoots.map(root => root.relativePath);
  const counts = withTransaction(db, () => {
    return publishIndexCoverage(db, generation, roots, discovered);
  });

  return { ok: true, parseFailed, parseFailures, census: finishCaptureCensus(db, beforeCapture, parseFailures.map(f => f.relativePath)), ...counts };
}

function isFatalIndexIoError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = String((err as { code: unknown }).code);
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EISDIR") return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /invalid repo-relative|not within the repo/.test(message);
}

function writeKnowledgeAndEntities(db: IndexDatabase, generation: number, repoRoot: string): void {
  const sql = new SqlFactsStore(db);
  const graph = new SqlKnowledgeGraph(db);
  const builder = new KnowledgeGraphBuilder(graph);
  graph.clear();
  graph.generation = generation;
  withTransaction(db, () => {
    db.exec("DELETE FROM entity_token; DELETE FROM entity_df; DELETE FROM entity;");
    db.exec("DELETE FROM search_doc_token; DELETE FROM search_doc; DELETE FROM search_doc_df;");
    db.prepare("DELETE FROM meta WHERE key=?").run("searchDocStats");
  });
  const resources = listMyBatisResources(db);
  const bindsMyBatis = myBatisBindingFilter(db);
  // Paths are read up front: a cursor left open across the per-file write
  // transactions would turn each BEGIN IMMEDIATE into an upgrade of a stale
  // read snapshot, which fails at once (no busy wait) after any other commit.
  const paths = (prepareCached(db, "SELECT path FROM file ORDER BY rowid").all() as Array<{ path: string }>).map(row => row.path);
  for (const relativePath of paths) {
    const bundle = readBundle(db, relativePath);
    if (!bundle) continue;
    withTransaction(db, () => {
      builder.replaceFile(bundle, sql, generation);
      for (const record of recordsFromBundle(bundle)) writeEntityRecord(db, record);
      // Documents, entities and the file row move in one transaction so a
      // query can never rank text from a newer hash against facts of an older
      // one.
      replaceSearchDocuments(db, bundle.file.relativePath, buildSearchDocuments({ bundle, myBatisResources: resources, bindsMyBatis }));
    });
    sql.clearRequestCache();
  }
  rebuildEntityDf(db);
  rebuildSearchDocDf(db);
  commitSearchDocStats(db);
  graph.flushMeta();
}

function listMyBatisResources(db: IndexDatabase): MyBatisMapperResourceFacts[] {
  const out: MyBatisMapperResourceFacts[] = [];
  for (const row of db.prepare("SELECT path FROM mybatis_resource").iterate() as Iterable<{ path: string }>) {
    const resource = readMyBatisResource(db, row.path);
    if (resource) out.push(resource);
  }
  return out;
}

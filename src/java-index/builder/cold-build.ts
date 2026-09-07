import { createHash } from "node:crypto";
import { realpath, readFile } from "node:fs/promises";
import { cpus } from "node:os";
import path from "node:path";
import { probeLayout } from "../../layout-probe.js";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import { recordsFromBundle } from "../entity-search.js";
import type { JavaFileBundle } from "../index-types.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { discoverJavaFiles, discoverMyBatisResourceFiles } from "../manifest.js";
import { extractMyBatisMapperFacts } from "../mybatis-xml-extractor.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";
import { JavaNameResolver } from "../name-resolver.js";
import { KnowledgeGraphBuilder } from "../../java-knowledge/graph-builder.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "./parse-cache.js";
import { prepareCached, withTransaction, type IndexDatabase } from "../sql/driver.js";
import { rebuildEntityDf, writeEntityRecord } from "../sql/entity-tokens.js";
import { SqlFactsStore } from "../sql/facts-store.js";
import { SqlKnowledgeGraph } from "../sql/knowledge-graph.js";
import { buildSqlRegistryView } from "../sql/registry-view.js";
import { readBundle, replaceBundleEdges, updateBundleFacts, writeBundle, writeMyBatisResource } from "../sql/rows.js";
import {
  clearIndexData,
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
  const resolvedRepoRoot = await realpath(options.repoRoot).catch(() => path.resolve(options.repoRoot));
  const layout = probeLayout(resolvedRepoRoot);

  if (readMeta(db, "buildState") === "READY") {
    withTransaction(db, () => clearIndexData(db));
  }
  writeMeta(db, "buildState", "BUILDING");
  writeMeta(db, "repoRoot", resolvedRepoRoot);

  const discovered = await discoverJavaFiles(resolvedRepoRoot, layout);
  const total = discovered.length;
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
            repoRoot: resolvedRepoRoot,
            resolvedRepoRoot,
            inputPath: file.absolutePath,
            generation,
            backend,
            cache,
            layout
          });
          cache.delete(bundle.file.relativePath);
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
      parseFailed += parsed.length - bundles.length;
      const next = withTransaction(db, () => {
        for (const bundle of bundles) writeBundle(db, bundle);
        return commitProgress(db, { phase: "declare", done: existingPaths(db).size, total });
      });
      afterCommit({ phase: "declare", done: next.files, total }, options);
    }

    const xmlFiles = await discoverMyBatisResourceFiles(resolvedRepoRoot, layout);
    const resources: MyBatisMapperResourceFacts[] = [];
    for (const file of xmlFiles) {
      const content = await readFile(file.absolutePath, "utf8");
      const resource = extractMyBatisMapperFacts({
        relativePath: file.relativePath,
        content,
        contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
        generation
      });
      if (resource) resources.push(resource);
    }
    progress = withTransaction(db, () => {
      for (const resource of resources) writeMyBatisResource(db, resource);
      const next: BuildProgress = { phase: "resolve", done: 0, total };
      commitProgress(db, next);
      return next;
    });
    afterCommit(progress, options);
  }

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

  writeKnowledgeAndEntities(db, generation);

  const roots = layout.sourceRoots.map(root => root.relativePath);
  const counts = withTransaction(db, () => {
    const stmt = db.prepare(
      `INSERT INTO source_root_coverage(root, state, generation) VALUES (?, 'COMPLETE', ?)
       ON CONFLICT(root) DO UPDATE SET state=excluded.state, generation=excluded.generation`
    );
    for (const root of roots) stmt.run(root, generation);
    writeMeta(db, "buildState", "READY");
    writeMeta(db, "indexedGeneration", String(generation));
    return refreshIndexCounts(db);
  });

  return { ok: true, parseFailed, parseFailures, ...counts };
}

function isFatalIndexIoError(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = String((err as { code: unknown }).code);
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EISDIR") return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /invalid repo-relative|not within the repo/.test(message);
}

function writeKnowledgeAndEntities(db: IndexDatabase, generation: number): void {
  const sql = new SqlFactsStore(db);
  const graph = new SqlKnowledgeGraph(db);
  const builder = new KnowledgeGraphBuilder(graph);
  graph.clear();
  graph.generation = generation;
  withTransaction(db, () => {
    db.exec("DELETE FROM entity_token; DELETE FROM entity_df; DELETE FROM entity;");
  });
  for (const file of sql.iterFiles()) {
    const bundle = readBundle(db, file.relativePath);
    if (!bundle) continue;
    withTransaction(db, () => {
      builder.replaceFile(bundle, sql, generation);
      for (const record of recordsFromBundle(bundle)) writeEntityRecord(db, record);
    });
    sql.clearRequestCache();
  }
  rebuildEntityDf(db);
  graph.flushMeta();
}

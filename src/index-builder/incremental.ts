import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { probeLayout, type LayoutContext } from "../layout-probe.js";
import { KnowledgeGraphBuilder } from "../java-knowledge/graph-builder.js";
import { buildStaticEdges, resolveFileRefs } from "../java-index/edge-builder.js";
import { recordsFromBundle } from "../java-index/entity-search.js";
import type { JavaFileBundle } from "../java-index/index-types.js";
import { parseJavaSourceFile } from "../java-index/java-index-file-parse.js";
import { createJavaParserBackend } from "../java-index/java-parser-backend.js";
import { discoverJavaFiles } from "../java-index/manifest.js";
import { extractMyBatisMapperFacts } from "../java-index/mybatis-xml-extractor.js";
import { JavaNameResolver } from "../java-index/name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../java-index/builder/parse-cache.js";
import { bindChunks, inClause, prepareCached, withTransaction, type IndexDatabase } from "../java-index/sql/driver.js";
import { rebuildEntityDf, writeEntityRecord } from "../java-index/sql/entity-tokens.js";
import { SqlFactsStore } from "../java-index/sql/facts-store.js";
import { SqlKnowledgeGraph } from "../java-index/sql/knowledge-graph.js";
import { buildSqlRegistryView } from "../java-index/sql/registry-view.js";
import { readBundle, readMyBatisResource, replaceBundleEdges, updateBundleFacts, writeBundle, writeMyBatisResource } from "../java-index/sql/rows.js";
import { internSym, symId } from "../java-index/sql/sym.js";
import { readIndexCounts, readMeta, refreshIndexCounts, writeBuildProgress, writeMeta } from "./progress.js";

export type BuilderJobKind = "refresh" | "resources" | "reconcile" | "exit";
export type BuilderJob = { id?: number; kind: BuilderJobKind; generation?: number; changed?: string[]; deleted?: string[] };
export type BuilderJobResult = { id: number; ok: boolean; indexedGeneration: number; files: number; error?: string };

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

function asRepoRel(repoRoot: string, abs: string): string {
  const rel = path.relative(repoRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path outside repo: ${abs}`);
  return rel.split(path.sep).join("/");
}

async function resolveInput(repoRoot: string, input: string): Promise<{ abs: string; rel: string; exists: boolean }> {
  const joined = path.resolve(path.isAbsolute(input) ? input : path.join(repoRoot, input));
  try {
    const abs = await realpath(joined);
    return { abs, rel: asRepoRel(repoRoot, abs), exists: true };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("path outside repo:")) throw err;
    let cursor = path.dirname(joined);
    const tail = [path.basename(joined)];
    while (cursor !== path.dirname(cursor)) {
      try {
        const relBase = asRepoRel(repoRoot, await realpath(cursor));
        return { abs: joined, rel: [relBase, ...tail.slice().reverse()].join("/"), exists: false };
      } catch {
        tail.push(path.basename(cursor));
        cursor = path.dirname(cursor);
      }
    }
    if (errCode(err) === "ENOENT") return { abs: joined, rel: asRepoRel(repoRoot, joined), exists: false };
    throw err;
  }
}

function indexedGenerationOf(db: IndexDatabase): number {
  return Number(readMeta(db, "indexedGeneration") ?? "0") || 0;
}

function statusResult(db: IndexDatabase, id: number, ok: boolean, error?: string): BuilderJobResult {
  const counts = readIndexCounts(db) ?? refreshIndexCounts(db);
  return { id, ok, indexedGeneration: indexedGenerationOf(db), files: counts.files, ...(error ? { error } : {}) };
}

function ownedIds(db: IndexDatabase, relativePath: string): string[] {
  const rows = prepareCached(
    db,
    `SELECT s.text AS id FROM type t JOIN sym s ON s.id=t.sym JOIN file f ON f.id=t.file_id WHERE f.path=?
     UNION ALL SELECT s.text FROM method m JOIN sym s ON s.id=m.sym JOIN file f ON f.id=m.file_id WHERE f.path=?
     UNION ALL SELECT s.text FROM field d JOIN sym s ON s.id=d.sym JOIN file f ON f.id=d.file_id WHERE f.path=?`
  ).all(relativePath, relativePath, relativePath) as Array<{ id: string }>;
  return rows.map(row => row.id);
}

function dependentPaths(db: IndexDatabase, ids: readonly string[], exclude: ReadonlySet<string>): string[] {
  const syms = ids.map(id => symId(db, id)).filter((sym): sym is number => sym !== undefined);
  if (syms.length === 0) return [];
  const paths = new Set<string>();
  for (const chunk of bindChunks(syms)) {
    const rows = prepareCached(
      db,
      `SELECT DISTINCT f.path AS path FROM edge e JOIN file f ON f.id=e.file_id WHERE e.to_sym IN ${inClause(chunk.length)}`
    ).all(...chunk) as Array<{ path: string }>;
    for (const row of rows) {
      if (!exclude.has(row.path)) paths.add(row.path);
    }
  }
  return [...paths];
}

function resolveTouched(db: IndexDatabase, relativePaths: readonly string[]): void {
  const store = new SqlFactsStore(db);
  for (const relativePath of relativePaths) {
    const view = buildSqlRegistryView(store);
    const resolver = new JavaNameResolver(view);
    const raw = readBundle(db, relativePath);
    if (!raw) continue;
    const resolved = resolveFileRefs(raw, resolver, view);
    updateBundleFacts(db, { ...resolved, edges: [] });
    store.clearRequestCache();
    replaceBundleEdges(db, relativePath, buildStaticEdges(resolved, buildSqlRegistryView(store), resolver));
    store.clearRequestCache();
  }
}

function rewriteGraphAndEntities(
  db: IndexDatabase,
  generation: number,
  deleted: readonly string[],
  rewritten: readonly string[]
): void {
  const store = new SqlFactsStore(db);
  const graph = new SqlKnowledgeGraph(db);
  const builder = new KnowledgeGraphBuilder(graph);
  if (deleted.length > 0) graph.removeFiles(deleted);
  for (const relativePath of rewritten) {
    const bundle = readBundle(db, relativePath);
    if (!bundle) continue;
    builder.replaceFile(bundle, store, generation);
    store.clearRequestCache();
  }
  graph.flushMeta();
  const deleteEntity = prepareCached(db, "DELETE FROM entity WHERE path_sym=?");
  for (const relativePath of [...deleted, ...rewritten]) deleteEntity.run(internSym(db, relativePath));
  for (const relativePath of rewritten) {
    const bundle = readBundle(db, relativePath);
    if (!bundle) continue;
    for (const record of recordsFromBundle(bundle)) writeEntityRecord(db, record);
  }
  rebuildEntityDf(db);
}

function finishIndex(db: IndexDatabase, generation: number, roots: readonly string[]): void {
  writeMeta(db, "indexedGeneration", String(generation));
  writeMeta(db, "buildState", "READY");
  const stmt = prepareCached(
    db,
    `INSERT INTO source_root_coverage(root, state, generation) VALUES (?, 'COMPLETE', ?)
     ON CONFLICT(root) DO UPDATE SET state=excluded.state, generation=excluded.generation`
  );
  for (const root of roots) stmt.run(root, generation);
  prepareCached(db, "UPDATE source_root_coverage SET generation=? WHERE state='COMPLETE'").run(generation);
  refreshIndexCounts(db);
}

async function parseChanged(
  db: IndexDatabase,
  repoRoot: string,
  layout: LayoutContext,
  generation: number,
  absolutePaths: readonly string[]
): Promise<{ bundles: JavaFileBundle[]; missing: string[] }> {
  const backend = await createJavaParserBackend();
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  const bundles: JavaFileBundle[] = [];
  const missing: string[] = [];
  const total = Math.max(1, absolutePaths.length);
  for (const [index, inputPath] of absolutePaths.entries()) {
    writeBuildProgress(db, { phase: "declare", done: index, total });
    try {
      const bundle = await parseJavaSourceFile({
        repoRoot, resolvedRepoRoot: repoRoot, inputPath, generation, backend, cache, layout
      });
      cache.delete(bundle.file.relativePath);
      bundles.push(bundle);
    } catch (err) {
      if (errCode(err) === "ENOENT") missing.push(asRepoRel(repoRoot, inputPath));
      else throw err;
    }
  }
  writeBuildProgress(db, { phase: "declare", done: absolutePaths.length, total });
  return { bundles, missing };
}

function applyParsedRefresh(
  db: IndexDatabase,
  generation: number,
  roots: readonly string[],
  deleted: readonly string[],
  bundles: readonly JavaFileBundle[]
): void {
  const changed = bundles.map(bundle => bundle.file.relativePath);
  const exclude = new Set([...deleted, ...changed]);
  const oldIds = [...deleted, ...changed].flatMap(relativePath => ownedIds(db, relativePath));
  const dependents = new Set(dependentPaths(db, oldIds, exclude));
  withTransaction(db, () => {
    for (const relativePath of deleted) prepareCached(db, "DELETE FROM file WHERE path=?").run(relativePath);
    for (const bundle of bundles) writeBundle(db, bundle);
    for (const relativePath of dependentPaths(db, [...oldIds, ...changed.flatMap(item => ownedIds(db, item))], exclude)) {
      dependents.add(relativePath);
    }
    const rewritten = [...changed, ...dependents].sort();
    resolveTouched(db, rewritten);
    rewriteGraphAndEntities(db, generation, deleted, rewritten);
    finishIndex(db, generation, roots);
  });
}

async function applyRefresh(
  db: IndexDatabase,
  repoRoot: string,
  generation: number,
  changedInputs: readonly string[],
  deletedInputs: readonly string[]
): Promise<void> {
  const layout = probeLayout(repoRoot);
  const roots = layout.sourceRoots.map(root => root.relativePath);
  const deleted: string[] = [];
  for (const input of deletedInputs) deleted.push((await resolveInput(repoRoot, input)).rel);
  const existing: string[] = [];
  for (const input of changedInputs) {
    const resolved = await resolveInput(repoRoot, input);
    if (resolved.exists) existing.push(resolved.abs);
    else deleted.push(resolved.rel);
  }
  const uniqueDeleted = [...new Set(deleted)];
  if (existing.length === 0 && uniqueDeleted.length === 0) {
    withTransaction(db, () => finishIndex(db, generation, roots));
    return;
  }
  writeBuildProgress(db, { phase: "declare", done: 0, total: Math.max(1, existing.length) });
  const parsed = await parseChanged(db, repoRoot, layout, generation, existing);
  writeBuildProgress(db, { phase: "resolve", done: 0, total: Math.max(1, parsed.bundles.length) });
  applyParsedRefresh(db, generation, roots, [...uniqueDeleted, ...parsed.missing], parsed.bundles);
}

function resyncNamespace(db: IndexDatabase, generation: number, namespace: string | undefined): void {
  if (!namespace) return;
  const store = new SqlFactsStore(db);
  const type = store.typeByFqn(namespace);
  if (!type) return;
  const relativePath = type.fileId.startsWith("file:") ? type.fileId.slice("file:".length) : type.fileId;
  const bundle = readBundle(db, relativePath);
  if (!bundle) return;
  const graph = new SqlKnowledgeGraph(db);
  new KnowledgeGraphBuilder(graph).replaceFile(bundle, store, generation);
  graph.flushMeta();
}

async function applyResources(
  db: IndexDatabase,
  repoRoot: string,
  generation: number,
  changedInputs: readonly string[],
  deletedInputs: readonly string[]
): Promise<void> {
  const layout = probeLayout(repoRoot);
  writeBuildProgress(db, { phase: "declare", done: 0, total: Math.max(1, changedInputs.length + deletedInputs.length) });
  const namespaces = new Set<string>();
  const deletePaths: string[] = [];
  for (const input of deletedInputs) deletePaths.push((await resolveInput(repoRoot, input)).rel);
  const writes: Array<{ relativePath: string; facts: ReturnType<typeof extractMyBatisMapperFacts> }> = [];
  for (const relativePath of deletePaths) {
    const before = readMyBatisResource(db, relativePath);
    if (before?.namespace) namespaces.add(before.namespace);
  }
  for (const input of changedInputs) {
    const resolved = await resolveInput(repoRoot, input);
    const relativePath = resolved.rel;
    const before = readMyBatisResource(db, relativePath);
    try {
      const content = await readFile(resolved.abs, "utf8");
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      if (before?.contentHash === contentHash) continue;
      writes.push({ relativePath, facts: extractMyBatisMapperFacts({ relativePath, content, contentHash, generation }) });
      if (before?.namespace) namespaces.add(before.namespace);
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
      deletePaths.push(relativePath);
      if (before?.namespace) namespaces.add(before.namespace);
    }
  }
  withTransaction(db, () => {
    for (const relativePath of deletePaths) prepareCached(db, "DELETE FROM mybatis_resource WHERE path=?").run(relativePath);
    for (const write of writes) {
      if (write.facts) {
        writeMyBatisResource(db, write.facts);
        if (write.facts.namespace) namespaces.add(write.facts.namespace);
      } else {
        prepareCached(db, "DELETE FROM mybatis_resource WHERE path=?").run(write.relativePath);
      }
    }
    for (const namespace of namespaces) resyncNamespace(db, generation, namespace);
    finishIndex(db, generation, layout.sourceRoots.map(root => root.relativePath));
  });
}

type IndexedFileRow = {
  path: string;
  mtime: number | null;
  size: number | null;
  contentHash: string | null;
};

type MtimeStamp = {
  path: string;
  mtimeMs: number;
  ctimeMs: number;
};

async function contentHashOf(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath, "utf8");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function stampFileTimes(db: IndexDatabase, stamps: readonly MtimeStamp[]): void {
  if (stamps.length === 0) return;
  const stmt = prepareCached(db, "UPDATE file SET mtime_ms=?, ctime_ms=? WHERE path=?");
  for (const stamp of stamps) stmt.run(stamp.mtimeMs, stamp.ctimeMs, stamp.path);
}

async function applyReconcile(db: IndexDatabase, repoRoot: string, generation: number): Promise<void> {
  const layout = probeLayout(repoRoot);
  const roots = layout.sourceRoots.map(root => root.relativePath);
  writeBuildProgress(db, { phase: "declare", done: 0, total: 1 });
  const discovered = await discoverJavaFiles(repoRoot, layout);
  const indexed = new Map(
    (prepareCached(
      db,
      "SELECT path, mtime_ms AS mtime, size AS size, content_hash AS contentHash FROM file"
    ).all() as IndexedFileRow[]).map(row => [row.path, row])
  );
  const changed: string[] = [];
  const mtimeStamps: MtimeStamp[] = [];
  const seen = new Set<string>();
  for (const file of discovered) {
    seen.add(file.relativePath);
    const previous = indexed.get(file.relativePath);
    if (!previous) {
      changed.push(file.absolutePath);
      continue;
    }
    const info = await stat(file.absolutePath);
    const size = Number(previous.size);
    const mtime = Number(previous.mtime);
    const sizeMatch = Number.isFinite(size) && size === info.size;
    const mtimeMatch = Number.isFinite(mtime) && Math.abs(mtime - info.mtimeMs) <= 0.5;
    if (sizeMatch && mtimeMatch) continue;
    // git worktree add rewrites mtimes; identical size+hash must not reparse.
    if (sizeMatch && previous.contentHash && await contentHashOf(file.absolutePath) === previous.contentHash) {
      mtimeStamps.push({ path: file.relativePath, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
      continue;
    }
    changed.push(file.absolutePath);
  }
  const deleted = [...indexed.keys()].filter(relativePath => !seen.has(relativePath));
  if (changed.length === 0 && deleted.length === 0) {
    withTransaction(db, () => {
      stampFileTimes(db, mtimeStamps);
      finishIndex(db, generation, roots);
    });
    return;
  }
  if (mtimeStamps.length > 0) {
    withTransaction(db, () => stampFileTimes(db, mtimeStamps));
  }
  await applyRefresh(db, repoRoot, generation, changed, deleted);
}

export async function applyBuilderJob(options: {
  repoRoot: string;
  db: IndexDatabase;
  job: BuilderJob;
}): Promise<BuilderJobResult> {
  const id = typeof options.job.id === "number" ? options.job.id : -1;
  if (options.job.kind === "exit") return statusResult(options.db, id, true);
  const repoRoot = await realpath(options.repoRoot).catch(() => path.resolve(options.repoRoot));
  const current = indexedGenerationOf(options.db);
  const generation = options.job.generation ?? current + 1;
  if (generation < current) return statusResult(options.db, id, true);
  try {
    if (options.job.kind === "refresh") {
      await applyRefresh(options.db, repoRoot, generation, options.job.changed ?? [], options.job.deleted ?? []);
    } else if (options.job.kind === "resources") {
      await applyResources(options.db, repoRoot, generation, options.job.changed ?? [], options.job.deleted ?? []);
    } else if (options.job.kind === "reconcile") {
      await applyReconcile(options.db, repoRoot, generation);
    } else {
      return statusResult(options.db, id, false, `unknown kind ${String((options.job as BuilderJob).kind)}`);
    }
    return statusResult(options.db, id, true);
  } catch (err) {
    return statusResult(options.db, id, false, err instanceof Error ? err.message : String(err));
  }
}

export async function runBuilderServe(
  repoRoot: string,
  db: IndexDatabase,
  lines: AsyncIterable<string>,
  out: { write(chunk: string): unknown }
): Promise<void> {
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let job: BuilderJob;
    try {
      job = JSON.parse(trimmed) as BuilderJob;
    } catch (err) {
      out.write(`${JSON.stringify(statusResult(db, -1, false, err instanceof Error ? err.message : String(err)))}\n`);
      continue;
    }
    if (job.kind === "exit") return;
    out.write(`${JSON.stringify(await applyBuilderJob({ repoRoot, db, job }))}\n`);
  }
}

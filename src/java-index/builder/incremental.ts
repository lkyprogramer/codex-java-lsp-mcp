import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { probeLayout, type LayoutContext } from "../../layout-probe.js";
import { KnowledgeGraphBuilder } from "../../java-knowledge/graph-builder.js";
import type { KnowledgeGraphStore } from "../../java-knowledge/graph-store.js";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import { recordsFromBundle } from "../entity-search.js";
import type { JavaFileBundle } from "../index-types.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { discoverJavaFiles } from "../manifest.js";
import { extractMyBatisMapperFacts } from "../mybatis-xml-extractor.js";
import { JavaNameResolver } from "../name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../parse-tree-cache.js";
import { prepareCached, withTransaction, type IndexDatabase } from "../sql/driver.js";
import { rebuildEntityDf, writeEntityRecord } from "../sql/entity-tokens.js";
import { SqlFactsStore } from "../sql/facts-store.js";
import { SqlKnowledgeGraph } from "../sql/knowledge-graph.js";
import { buildSqlRegistryView } from "../sql/registry-view.js";
import { readBundle, readMyBatisResource, replaceBundleEdges, updateBundleFacts, writeBundle, writeMyBatisResource } from "../sql/rows.js";
import { internSym, symId } from "../sql/sym.js";
import { readIndexCounts, readMeta, refreshIndexCounts, writeMeta } from "./progress.js";

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
  const placeholders = syms.map(() => "?").join(",");
  const rows = prepareCached(
    db,
    `SELECT DISTINCT f.path AS path FROM edge e JOIN file f ON f.id=e.file_id WHERE e.to_sym IN (${placeholders})`
  ).all(...syms) as Array<{ path: string }>;
  return rows.map(row => row.path).filter(item => !exclude.has(item));
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
  const builder = new KnowledgeGraphBuilder(graph as unknown as KnowledgeGraphStore);
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
  repoRoot: string,
  layout: LayoutContext,
  generation: number,
  absolutePaths: readonly string[]
): Promise<{ bundles: JavaFileBundle[]; missing: string[] }> {
  const backend = await createJavaParserBackend();
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  const bundles: JavaFileBundle[] = [];
  const missing: string[] = [];
  for (const inputPath of absolutePaths) {
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
  const parsed = await parseChanged(repoRoot, layout, generation, existing);
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
  new KnowledgeGraphBuilder(graph as unknown as KnowledgeGraphStore).replaceFile(bundle, store, generation);
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

async function applyReconcile(db: IndexDatabase, repoRoot: string, generation: number): Promise<void> {
  const layout = probeLayout(repoRoot);
  const roots = layout.sourceRoots.map(root => root.relativePath);
  const discovered = await discoverJavaFiles(repoRoot, layout);
  const indexed = new Map(
    (prepareCached(db, "SELECT path, mtime_ms AS mtime, size AS size FROM file").all() as Array<{
      path: string; mtime: number | null; size: number | null;
    }>).map(row => [row.path, row])
  );
  const changed: string[] = [];
  const seen = new Set<string>();
  for (const file of discovered) {
    seen.add(file.relativePath);
    const previous = indexed.get(file.relativePath);
    if (!previous) { changed.push(file.absolutePath); continue; }
    const info = await stat(file.absolutePath);
    const size = Number(previous.size);
    const mtime = Number(previous.mtime);
    if (size !== info.size || !Number.isFinite(mtime) || Math.abs(mtime - info.mtimeMs) > 0.5) {
      changed.push(file.absolutePath);
    }
  }
  const deleted = [...indexed.keys()].filter(relativePath => !seen.has(relativePath));
  if (changed.length === 0 && deleted.length === 0) {
    withTransaction(db, () => finishIndex(db, generation, roots));
    return;
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

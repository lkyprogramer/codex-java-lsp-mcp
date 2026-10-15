import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { probeLayout, type LayoutContext } from "../layout-probe.js";
import { KnowledgeGraphBuilder } from "../java-knowledge/graph-builder.js";
import { buildStaticEdges, resolveFileRefs } from "../java-index/edge-builder.js";
import { recordsFromBundle } from "../java-index/entity-search.js";
import type { JavaFileBundle } from "../java-index/index-types.js";
import { parseJavaSourceFile } from "../java-index/java-index-file-parse.js";
import { createJavaParserBackend } from "../java-index/java-parser-backend.js";
import { discoverJavaFiles, discoverMyBatisResourceFiles } from "../java-index/manifest.js";
import { extractMyBatisMapperFacts } from "../java-index/mybatis-xml-extractor.js";
import type { MyBatisMapperResourceFacts } from "../java-index/mybatis-types.js";
import { JavaNameResolver } from "../java-index/name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../java-index/builder/parse-cache.js";
import { bindChunks, inClause, prepareCached, withTransaction, type IndexDatabase } from "../java-index/sql/driver.js";
import { rebuildEntityDf, writeEntityRecord } from "../java-index/sql/entity-tokens.js";
import {
  commitSearchDocStats,
  deleteSearchDocumentsForPath,
  rebuildSearchDocDf,
  myBatisBindingFilter,
  replaceSearchDocuments,
  replaceSearchDocumentsForSource
} from "../java-index/sql/search-docs.js";
import { buildMyBatisSearchDocuments, buildSearchDocuments, type SearchDocument } from "../discovery/search-document.js";
import { SqlFactsStore } from "../java-index/sql/facts-store.js";
import { SqlKnowledgeGraph } from "../java-index/sql/knowledge-graph.js";
import { buildSqlRegistryView } from "../java-index/sql/registry-view.js";
import { deleteResourceScan, readBundle, readMyBatisResource, recordResourceScan, replaceBundleEdges, updateBundleFacts, writeBundle, writeMyBatisResource } from "../java-index/sql/rows.js";
import { internSym, symId } from "../java-index/sql/sym.js";
import { attachWorkspaceStat, deleteStats, fileStatOf, observedStats, readStats, recordStats, statUnchanged, type StatRow } from "../java-index/sql/workspace-stat.js";
import { readIndexCounts, readMeta, refreshIndexCounts, publishIndexCoverage, writeBuildProgress, writeMeta } from "./progress.js";

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

/** (fqn, path) of every named type a file declares, with its simple name. */
function declaredTypes(db: IndexDatabase, relativePath: string): Map<string, string> {
  const rows = prepareCached(
    db,
    "SELECT t.fqn AS fqn, t.simple_name AS simpleName FROM type t JOIN file f ON f.id=t.file_id WHERE f.path=? AND t.fqn IS NOT NULL"
  ).all(relativePath) as Array<{ fqn: string; simpleName: string }>;
  return new Map(rows.map(row => [`${row.fqn}|${relativePath}`, row.simpleName]));
}

/**
 * R05 review: a reference left AMBIGUOUS (several visible declarations) has
 * no edge, and a reference bound to A has no edge to a newly added B, so
 * edge-based dependents miss them. When the set of (fqn, path) declarations
 * changes - added, removed or moved types - every file that uses one of the
 * changed simple names in a type position is re-resolved as well.
 */
function nameDependentPaths(
  db: IndexDatabase,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  exclude: ReadonlySet<string>,
  dispatchParentNames: readonly string[] = []
): string[] {
  const names = new Set(dispatchParentNames.map(name => name.toLowerCase()));
  for (const [key, simpleName] of before) if (!after.has(key)) names.add(simpleName.toLowerCase());
  for (const [key, simpleName] of after) if (!before.has(key)) names.add(simpleName.toLowerCase());
  const nameSyms = [...names].map(name => symId(db, name)).filter((sym): sym is number => sym !== undefined);
  if (nameSyms.length === 0) return [];
  const paths = new Set<string>();
  for (const chunk of bindChunks(nameSyms)) {
    const rows = prepareCached(
      db,
      `SELECT DISTINCT f.path AS path FROM type_ref_name r JOIN file f ON f.id=r.file_id WHERE r.name_sym IN ${inClause(chunk.length)}`
    ).all(...chunk) as Array<{ path: string }>;
    for (const row of rows) if (!exclude.has(row.path)) paths.add(row.path);
  }
  return [...paths];
}

/** Self-calls have incoming method edges but no explicit parent type-name posting. */
function dispatchDependentPaths(db: IndexDatabase, parentNames: ReadonlySet<string>, exclude: ReadonlySet<string>): string[] {
  const ids = new Set<string>();
  for (const chunk of bindChunks([...parentNames])) {
    const names = inClause(chunk.length);
    const rows = prepareCached(db,
      `SELECT s.text AS id FROM type t JOIN sym s ON s.id=t.sym WHERE t.simple_name IN ${names}
       UNION SELECT s.text AS id FROM method m JOIN type t ON t.sym=m.owner_sym
       JOIN sym s ON s.id=m.sym WHERE t.simple_name IN ${names}`
    ).all(...chunk, ...chunk) as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  }
  return dependentPaths(db, [...ids], exclude);
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
  }
  // Call resolution walks other files' inheritance facts. Finish all facts
  // before building edges, as cold build does, so file order cannot hide a
  // method inherited through a type that has not yet been resolved.
  const view = buildSqlRegistryView(store);
  const resolver = new JavaNameResolver(view);
  for (const relativePath of relativePaths) {
    const resolved = readBundle(db, relativePath);
    if (!resolved) continue;
    replaceBundleEdges(db, relativePath, buildStaticEdges(resolved, view, resolver));
    store.clearRequestCache();
  }
}

function rewriteGraphAndEntities(
  db: IndexDatabase,
  repoRoot: string,
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
  for (const relativePath of [...deleted, ...rewritten]) {
    deleteEntity.run(internSym(db, relativePath));
    deleteSearchDocumentsForPath(db, relativePath);
  }
  const resources = listMyBatisResources(db);
  const bindsMyBatis = myBatisBindingFilter(db);
  for (const relativePath of rewritten) {
    const bundle = readBundle(db, relativePath);
    if (!bundle) continue;
    for (const record of recordsFromBundle(bundle)) writeEntityRecord(db, record);
    // Same-transaction document update keeps text and facts on one hash.
    const content = readFileSyncSafe(path.join(repoRoot, relativePath));
    replaceSearchDocuments(db, bundle.file.relativePath, buildSearchDocuments({ bundle, content, myBatisResources: resources, bindsMyBatis }));
  }
  rebuildEntityDf(db);
  rebuildSearchDocDf(db);
  commitSearchDocStats(db);
}

function readFileSyncSafe(absolutePath: string): string | undefined {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return undefined;
  }
}

function listMyBatisResources(db: IndexDatabase): MyBatisMapperResourceFacts[] {
  const out: MyBatisMapperResourceFacts[] = [];
  for (const row of db.prepare("SELECT path FROM mybatis_resource").iterate() as Iterable<{ path: string }>) {
    const resource = readMyBatisResource(db, row.path);
    if (resource) out.push(resource);
  }
  return out;
}

function finishIndex(db: IndexDatabase, generation: number, roots: readonly string[]): void {
  publishIndexCoverage(db, generation, roots);
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
  repoRoot: string,
  generation: number,
  roots: readonly string[],
  deleted: readonly string[],
  bundles: readonly JavaFileBundle[],
  discovered?: readonly { sourceRoot: string }[]
): void {
  const changed = bundles.map(bundle => bundle.file.relativePath);
  const exclude = new Set([...deleted, ...changed]);
  const oldIds = [...deleted, ...changed].flatMap(relativePath => ownedIds(db, relativePath));
  const dependents = new Set(dependentPaths(db, oldIds, exclude));
  const declaredBefore = new Map([...deleted, ...changed].flatMap(relativePath => [...declaredTypes(db, relativePath)]));
  // A caller references Parent, not the Child whose override changed. Reuse
  // the indexed type-name postings for direct parents used by bounded dispatch.
  // Capture the old parents before replacing/deleting the subtype so removal
  // and reparenting refresh both sides without scanning all caller facts.
  const dispatchParentNames = new Set<string>();
  for (const bundle of [
    ...[...deleted, ...changed].map(relativePath => readBundle(db, relativePath)),
    ...bundles
  ]) {
    if (!bundle) continue;
    for (const type of bundle.types) {
      for (const ref of [...type.extends, ...type.implements]) {
        if (ref.simpleName) dispatchParentNames.add(ref.simpleName);
      }
    }
  }
  for (const relativePath of dispatchDependentPaths(db, dispatchParentNames, exclude)) dependents.add(relativePath);
  const recovering = discovered !== undefined && (readMeta(db, "buildState") !== "READY" || readMeta(db, "coverageRevision") !== "1");
  withTransaction(db, () => {
    if (recovering) {
      const graph = new SqlKnowledgeGraph(db);
      graph.clear();
      graph.generation = generation;
      graph.flushMeta();
      db.exec("DELETE FROM entity_token; DELETE FROM entity; DELETE FROM entity_df; DELETE FROM search_doc_token; DELETE FROM search_doc; DELETE FROM search_doc_df;");
    }
    for (const relativePath of deleted) prepareCached(db, "DELETE FROM file WHERE path=?").run(relativePath);
    for (const bundle of bundles) writeBundle(db, bundle);
    deleteStats(db, deleted);
    recordStats(db, "java", observedStats(bundles));
    for (const relativePath of dependentPaths(db, [...oldIds, ...changed.flatMap(item => ownedIds(db, item))], exclude)) {
      dependents.add(relativePath);
    }
    for (const relativePath of dispatchDependentPaths(db, dispatchParentNames, exclude)) dependents.add(relativePath);
    const declaredAfter = new Map(changed.flatMap(relativePath => [...declaredTypes(db, relativePath)]));
    for (const relativePath of nameDependentPaths(db, declaredBefore, declaredAfter, exclude, [...dispatchParentNames])) dependents.add(relativePath);
    const rewritten = [...changed, ...dependents].sort();
    resolveTouched(db, rewritten);
    rewriteGraphAndEntities(db, repoRoot, generation, deleted, rewritten);
    rebindChangedNamespaces(db, declaredBefore, declaredAfter);
    publishIndexCoverage(db, generation, roots, discovered);
  });
}

/**
 * A declaration of a mapper namespace appeared, vanished or moved: the XML
 * binding visibility (myBatisBindingFilter) may change for owners that were
 * not rewritten, so every XML of that namespace rebinds from scratch.
 */
function rebindChangedNamespaces(db: IndexDatabase, before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): void {
  const fqns = new Set<string>();
  for (const key of before.keys()) if (!after.has(key)) fqns.add(key.slice(0, key.lastIndexOf("|")));
  for (const key of after.keys()) if (!before.has(key)) fqns.add(key.slice(0, key.lastIndexOf("|")));
  let touched = false;
  for (const fqn of fqns) {
    for (const row of prepareCached(db, "SELECT path FROM mybatis_resource WHERE namespace=?").all(fqn) as Array<{ path: string }>) {
      replaceResourceDocuments(db, row.path, readMyBatisResource(db, row.path));
      touched = true;
    }
  }
  if (touched) {
    rebuildSearchDocDf(db);
    commitSearchDocStats(db);
  }
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
  applyParsedRefresh(db, repoRoot, generation, roots, [...uniqueDeleted, ...parsed.missing], parsed.bundles);
}

function resyncNamespace(db: IndexDatabase, generation: number, namespace: string | undefined): void {
  if (!namespace) return;
  const store = new SqlFactsStore(db);
  // Every declaration of the namespace FQN is refreshed: resyncing more
  // files is safe, picking one of several would leave the others stale.
  const types = store.typesByFqn(namespace);
  if (types.length === 0) return;
  const graph = new SqlKnowledgeGraph(db);
  const builder = new KnowledgeGraphBuilder(graph);
  for (const type of types) {
    const relativePath = type.fileId.startsWith("file:") ? type.fileId.slice("file:".length) : type.fileId;
    const bundle = readBundle(db, relativePath);
    if (bundle) builder.replaceFile(bundle, store, generation);
  }
  graph.flushMeta();
}

/**
 * R08: an XML-only change replaces the documents SOURCED from that XML even
 * though no Java file changed: the old namespace's statements disappear, the
 * new ones bind to every Java declaration of the (new) namespace, each with
 * the XML path/hash/range as source.
 */
function replaceResourceDocuments(db: IndexDatabase, relativePath: string, resource: MyBatisMapperResourceFacts | undefined): void {
  const documents: Array<{ ownerPath: string; document: SearchDocument }> = [];
  if (resource?.namespace) {
    const store = new SqlFactsStore(db);
    const owners = new Set(store.typesByFqn(resource.namespace).map(type =>
      type.fileId.startsWith("file:") ? type.fileId.slice("file:".length) : type.fileId));
    for (const ownerPath of [...owners].sort()) {
      const bundle = readBundle(db, ownerPath);
      if (!bundle) continue;
      for (const document of buildMyBatisSearchDocuments({ bundle, myBatisResources: [resource], bindsMyBatis: myBatisBindingFilter(db) })) {
        documents.push({ ownerPath, document });
      }
    }
  }
  replaceSearchDocumentsForSource(db, relativePath, documents);
}

async function applyResources(
  db: IndexDatabase,
  repoRoot: string,
  generation: number,
  changedInputs: readonly string[],
  deletedInputs: readonly string[],
  options: { publish?: boolean } = {}
): Promise<void> {
  const layout = probeLayout(repoRoot);
  writeBuildProgress(db, { phase: "declare", done: 0, total: Math.max(1, changedInputs.length + deletedInputs.length) });
  const namespaces = new Set<string>();
  const deletePaths: string[] = [];
  for (const input of deletedInputs) deletePaths.push((await resolveInput(repoRoot, input)).rel);
  const writes: Array<{ relativePath: string; facts: ReturnType<typeof extractMyBatisMapperFacts> }> = [];
  const scans: StatRow[] = [];
  for (const relativePath of deletePaths) {
    const before = readMyBatisResource(db, relativePath);
    if (before?.namespace) namespaces.add(before.namespace);
  }
  for (const input of changedInputs) {
    const resolved = await resolveInput(repoRoot, input);
    const relativePath = resolved.rel;
    const before = readMyBatisResource(db, relativePath);
    try {
      const info = await stat(resolved.abs);
      const content = await readFile(resolved.abs, "utf8");
      const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
      scans.push({ path: relativePath, contentHash, ...fileStatOf(info) });
      if (before?.contentHash === contentHash) continue;
      const facts = extractMyBatisMapperFacts({ relativePath, content, contentHash, generation });
      // A non-mapper XML that was never indexed stays a no-op (reconcile
      // offers every resource XML; it must not rewrite df for each of them).
      if (!facts && !before) continue;
      writes.push({ relativePath, facts });
      if (before?.namespace) namespaces.add(before.namespace);
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
      deletePaths.push(relativePath);
      if (before?.namespace) namespaces.add(before.namespace);
    }
  }
  withTransaction(db, () => {
    for (const scan of scans) recordResourceScan(db, scan.path, scan.contentHash);
    recordStats(db, "resource", scans);
    for (const relativePath of deletePaths) deleteResourceScan(db, relativePath);
    deleteStats(db, deletePaths);
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
    for (const relativePath of deletePaths) replaceResourceDocuments(db, relativePath, undefined);
    for (const write of writes) replaceResourceDocuments(db, write.relativePath, write.facts);
    if (deletePaths.length > 0 || writes.length > 0) {
      rebuildSearchDocDf(db);
      commitSearchDocStats(db);
    }
    if (options.publish !== false) finishIndex(db, generation, layout.sourceRoots.map(root => root.relativePath));
  });
}

type IndexedFileRow = {
  path: string;
  size: number | null;
  contentHash: string;
  parseState: string | null;
};

async function contentHashOf(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath, "utf8");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * R08/K21: reconcile also covers resource XML. A worktree whose XML differs
 * from the copied sibling DB while every Java hash matches must still replace
 * the XML-sourced evidence before READY. Like Java: equal size+mtime skips,
 * otherwise the content hash decides (an mtime-only change is restamped, not
 * reparsed). Non-mapper XML is remembered in resource_scan, so it is not
 * reparsed on every reconcile.
 */
export async function changedResources(
  db: IndexDatabase,
  repoRoot: string,
  layout: LayoutContext
): Promise<{ changed: string[]; deleted: string[]; stamps: StatRow[] }> {
  const scanned = new Map(
    (prepareCached(db, "SELECT path, content_hash AS contentHash FROM resource_scan").all() as Array<{ path: string; contentHash: string }>)
      .map(row => [row.path, row.contentHash])
  );
  const stats = readStats(db, "resource");
  const known = new Set([
    ...scanned.keys(),
    ...(prepareCached(db, "SELECT path FROM mybatis_resource").all() as Array<{ path: string }>).map(row => row.path)
  ]);
  const changed: string[] = [];
  const stamps: StatRow[] = [];
  const seen = new Set<string>();
  for (const file of await discoverMyBatisResourceFiles(repoRoot, layout)) {
    seen.add(file.relativePath);
    const previous = scanned.get(file.relativePath);
    const info = await stat(file.absolutePath);
    const stamp = stats.get(file.relativePath);
    if (previous && stamp?.contentHash === previous && statUnchanged(stamp, info)) continue;
    const hash = await contentHashOf(file.absolutePath);
    if (previous && hash === previous) {
      stamps.push({ path: file.relativePath, contentHash: hash, ...fileStatOf(info) });
      continue;
    }
    changed.push(file.absolutePath);
  }
  const deleted = [...known].filter(relativePath => !seen.has(relativePath));
  return { changed, deleted, stamps };
}

async function applyReconcile(db: IndexDatabase, repoRoot: string, generation: number): Promise<void> {
  const layout = probeLayout(repoRoot);
  const roots = layout.sourceRoots.map(root => root.relativePath);
  writeBuildProgress(db, { phase: "declare", done: 0, total: 1 });
  // XML first, unpublished: the Java pass below is what publishes this
  // generation, so no reader sees generation N with the old XML evidence.
  const resources = await changedResources(db, repoRoot, layout);
  if (resources.stamps.length > 0) withTransaction(db, () => recordStats(db, "resource", resources.stamps));
  if (resources.changed.length > 0 || resources.deleted.length > 0) {
    await applyResources(db, repoRoot, generation, resources.changed, resources.deleted, { publish: false });
  }
  await applyJavaReconcile(db, repoRoot, generation, layout, roots);
}

async function applyJavaReconcile(
  db: IndexDatabase,
  repoRoot: string,
  generation: number,
  layout: LayoutContext,
  roots: readonly string[]
): Promise<void> {
  const discovered = await discoverJavaFiles(repoRoot, layout);
  const indexed = new Map(
    (prepareCached(
      db,
      "SELECT path, size, content_hash AS contentHash, parse_state AS parseState FROM file"
    ).all() as IndexedFileRow[]).map(row => [row.path, row])
  );
  const stats = readStats(db, "java");
  const changed: string[] = [];
  const recovering = readMeta(db, "buildState") !== "READY" || readMeta(db, "coverageRevision") !== "1";
  const stamps: StatRow[] = [];
  const seen = new Set<string>();
  for (const file of discovered) {
    seen.add(file.relativePath);
    const previous = indexed.get(file.relativePath);
    if (recovering || !previous || previous.parseState === "FAILED") {
      changed.push(file.absolutePath);
      continue;
    }
    const info = await stat(file.absolutePath);
    const stamp = stats.get(file.relativePath);
    // The stamp only stands in for hashing when it vouches for the hash the facts hold.
    if (stamp?.contentHash === previous.contentHash && statUnchanged(stamp, info)) continue;
    // git worktree add rewrites mtimes; an identical hash is restamped, not reparsed.
    if (Number(previous.size) === info.size && await contentHashOf(file.absolutePath) === previous.contentHash) {
      stamps.push({ path: file.relativePath, contentHash: previous.contentHash, ...fileStatOf(info) });
      continue;
    }
    changed.push(file.absolutePath);
  }
  const deleted = [...indexed.keys()].filter(relativePath => !seen.has(relativePath));
  if (changed.length === 0 && deleted.length === 0) {
    withTransaction(db, () => {
      recordStats(db, "java", stamps);
      if (recovering) {
        const graph = new SqlKnowledgeGraph(db);
        graph.clear();
        graph.generation = generation;
        graph.flushMeta();
        db.exec("DELETE FROM entity_token; DELETE FROM entity; DELETE FROM entity_df; DELETE FROM search_doc_token; DELETE FROM search_doc; DELETE FROM search_doc_df;");
        commitSearchDocStats(db);
      }
      publishIndexCoverage(db, generation, roots, discovered);
    });
    return;
  }
  if (stamps.length > 0) withTransaction(db, () => recordStats(db, "java", stamps));
  const parsed = await parseChanged(db, repoRoot, layout, generation, changed);
  applyParsedRefresh(db, repoRoot, generation, roots, [...deleted, ...parsed.missing], parsed.bundles, discovered);
}

export async function applyBuilderJob(options: {
  repoRoot: string;
  db: IndexDatabase;
  job: BuilderJob;
}): Promise<BuilderJobResult> {
  const id = typeof options.job.id === "number" ? options.job.id : -1;
  if (options.job.kind === "exit") return statusResult(options.db, id, true);
  const repoRoot = await realpath(options.repoRoot).catch(() => path.resolve(options.repoRoot));
  attachWorkspaceStat(options.db);
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
    withTransaction(options.db, () => {
      writeMeta(options.db, "buildState", "DEGRADED");
      options.db.prepare("UPDATE source_root_coverage SET state='DEGRADED'").run();
    });
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

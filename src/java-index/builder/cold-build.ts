import { createHash } from "node:crypto";
import { realpath, readFile } from "node:fs/promises";
import { cpus } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { probeLayout } from "../../layout-probe.js";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import { recordsFromBundle } from "../entity-search.js";
import type { JavaIndexStore } from "../index-store.js";
import type { JavaAnnotationFact, JavaFileBundle, JavaMethodFacts, JavaTypeFacts, JavaTypeKind, JavaTypeRef } from "../index-types.js";
import { javaFileId } from "../stable-id.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { discoverJavaFiles, discoverMyBatisResourceFiles } from "../manifest.js";
import { extractMyBatisMapperFacts } from "../mybatis-xml-extractor.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";
import { JavaNameResolver } from "../name-resolver.js";
import { KnowledgeGraphBuilder } from "../../java-knowledge/graph-builder.js";
import type { KnowledgeGraphStore } from "../../java-knowledge/graph-store.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../parse-tree-cache.js";
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
        } catch {
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

  return { ok: true, parseFailed, ...counts };
}

type SlimType = Pick<JavaTypeFacts, "typeId" | "fqn" | "simpleName" | "fileId">;

const EMPTY_RANGE = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } };
const STUB_PARAM = {
  name: "",
  type: { text: "", simpleName: "", typeArguments: [] as JavaTypeRef[], arrayDepth: 0, resolution: { state: "UNRESOLVED" as const } },
  varargs: false,
  annotations: [] as JavaAnnotationFact[],
  range: EMPTY_RANGE
};
const STUB_PARAMS = Array.from({ length: 24 }, (_, arity) => Array.from({ length: arity }, () => STUB_PARAM));

function inflateFactsJson(value: unknown): string {
  if (!(value instanceof Uint8Array)) throw new Error("expected facts blob");
  return inflateRawSync(value).toString("utf8");
}

function jsonTopLevelString(json: string, key: string): string {
  const token = `"${key}":`;
  const start = json.indexOf(token);
  if (start < 0) return "";
  let index = start + token.length;
  while (json[index] === " " || json[index] === "\n") index += 1;
  if (json[index] !== "\"") return "";
  index += 1;
  let out = "";
  while (index < json.length) {
    const ch = json[index]!;
    if (ch === "\"") return out;
    if (ch === "\\") {
      out += json[index + 1] ?? "";
      index += 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

function jsonTopLevelStringArray(json: string, key: string): string[] {
  const token = `"${key}":`;
  const start = json.indexOf(token);
  if (start < 0) return [];
  let index = start + token.length;
  while (json[index] === " " || json[index] === "\n") index += 1;
  if (json[index] !== "[") return [];
  const from = index;
  let depth = 0;
  for (; index < json.length; index += 1) {
    const ch = json[index]!;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(json.slice(from, index + 1)) as unknown;
          return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

function loadMethodStub(db: IndexDatabase, methodId: string): JavaMethodFacts | undefined {
  const row = prepareCached(
    db,
    "SELECT method_id AS methodId, owner_type_id AS ownerTypeId, name, is_ctor AS isCtor, arity, facts FROM method WHERE method_id=?"
  ).get(methodId) as {
    methodId?: unknown;
    ownerTypeId?: unknown;
    name?: unknown;
    isCtor?: unknown;
    arity?: unknown;
    facts?: unknown;
  } | undefined;
  if (typeof row?.methodId !== "string" || typeof row.ownerTypeId !== "string" || typeof row.name !== "string") {
    return undefined;
  }
  const json = inflateFactsJson(row.facts);
  const arity = Number(row.arity) || 0;
  return {
    methodId: row.methodId,
    ownerTypeId: row.ownerTypeId,
    name: row.name,
    constructor: Number(row.isCtor) === 1,
    signatureKey: jsonTopLevelString(json, "signatureKey"),
    range: EMPTY_RANGE,
    modifiers: jsonTopLevelStringArray(json, "modifiers"),
    annotations: [],
    typeParameters: [],
    parameters: STUB_PARAMS[arity] ?? Array.from({ length: arity }, () => STUB_PARAM),
    throws: [],
    callSites: [],
    localTypes: []
  };
}

function loadTypeStub(db: IndexDatabase, typeId: string): JavaTypeFacts | undefined {
  const row = prepareCached(
    db,
    `SELECT t.type_id AS typeId, t.fqn AS fqn, t.simple_name AS simpleName, t.kind AS kind, f.path AS path, t.facts AS facts
     FROM type t JOIN file f ON f.id=t.file_id WHERE t.type_id=?`
  ).get(typeId) as {
    typeId?: unknown;
    fqn?: unknown;
    simpleName?: unknown;
    kind?: unknown;
    path?: unknown;
    facts?: unknown;
  } | undefined;
  if (typeof row?.typeId !== "string" || typeof row.simpleName !== "string" || typeof row.kind !== "string" || typeof row.path !== "string") {
    return undefined;
  }
  return {
    typeId: row.typeId,
    ...(typeof row.fqn === "string" ? { fqn: row.fqn } : {}),
    simpleName: row.simpleName,
    kind: row.kind as JavaTypeKind,
    fileId: javaFileId(row.path),
    range: EMPTY_RANGE,
    modifiers: jsonTopLevelStringArray(inflateFactsJson(row.facts), "modifiers"),
    annotations: [],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: [],
    confidence: 0
  };
}

function sqlStoreAsIndex(db: IndexDatabase, sql: SqlFactsStore, types: readonly SlimType[]): JavaIndexStore {
  return {
    typesById: {
      get: (id: string) => loadTypeStub(db, id),
      has: (id: string) => prepareCached(db, "SELECT 1 AS n FROM type WHERE type_id=?").get(id) !== undefined,
      values: () => types
    },
    fieldsById: {
      get: (id: string) => sql.fieldsById.get(id),
      values: () => sql.iterFields()
    },
    methodsById: {
      get: (id: string) => loadMethodStub(db, id),
      values: () => sql.iterMethods()
    },
    filesByPath: {
      get: (path: string) => sql.filesByPath.get(path),
      values: () => sql.iterFiles()
    },
    edgesById: {
      values: () => sql.iterEdges()
    },
    typeByFqn: (fqn: string) => {
      const typeId = sql.typeIdByFqn.get(fqn);
      return typeId ? loadTypeStub(db, typeId) : undefined;
    },
    myBatisResourceForNamespace: (ns: string) => sql.myBatisResourceForNamespace(ns),
    implementers: (typeId: string, limit?: number) => sql.implementers(typeId, limit)
  } as unknown as JavaIndexStore;
}

function writeKnowledgeAndEntities(db: IndexDatabase, generation: number): void {
  const sql = new SqlFactsStore(db);
  const graph = new SqlKnowledgeGraph(db);
  const types: SlimType[] = [];
  for (const type of sql.iterTypes()) {
    types.push({ typeId: type.typeId, fqn: type.fqn, simpleName: type.simpleName, fileId: type.fileId });
  }
  const index = sqlStoreAsIndex(db, sql, types);
  const builder = new KnowledgeGraphBuilder(graph as unknown as KnowledgeGraphStore);
  graph.clear();
  graph.generation = generation;
  withTransaction(db, () => {
    db.exec("DELETE FROM entity_token; DELETE FROM entity_df; DELETE FROM entity;");
  });
  for (const file of sql.iterFiles()) {
    const bundle = readBundle(db, file.relativePath);
    if (!bundle) continue;
    withTransaction(db, () => {
      builder.replaceFile(bundle, index, generation);
      for (const record of recordsFromBundle(bundle)) writeEntityRecord(db, record);
    });
    sql.clearRequestCache();
  }
  rebuildEntityDf(db);
  graph.flushMeta();
}

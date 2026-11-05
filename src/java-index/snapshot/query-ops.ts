// input: one sealed snapshot database and one named read operation with plain-JSON arguments.
// output: the operation's result, computed only from that snapshot (and, for read
//         ranges, live bytes that are checked against the snapshot's content hash).
// pos: MAC-08A query surface shared by the query worker process and in-process
//      tests. Callers pass workspace-relative paths; no workspace root, layout or
//      cache path reaches the facts database.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { readIndexCounts, readMeta, readSourceRootCounts } from "../../index-builder/progress.js";
import type { DetailedEntitySearchResult, EntityHit, EntitySearchMode, EntitySearchScope } from "../entity-search.js";
import type { EvidenceSourcesResult } from "../java-index-client-api.js";
import { resolvedPathWithinRepo } from "../java-index-file-parse.js";
import type {
  AnchorFacts,
  ContextGraphResult,
  GraphDigest,
  GraphReachable,
  IndexedReadRangeResult,
  IndexedReference,
  JavaFileBundle,
  JavaTypeFacts,
  JavaTypeLookupResult,
  MyBatisResourceByNamespaceBatch,
  SourceRootCoverage,
  StaticEdgeKind
} from "../index-types.js";
import type { MyBatisMapperResourceFacts } from "../mybatis-types.js";
import type { ContentEntry } from "../sql/snapshot-manifest.js";
import { close as closeDb, openImmutableIndexDb, prepareCached, type IndexDatabase } from "../sql/driver.js";
import { SqlEntitySearch } from "../sql/entity-search.js";
import { queryEvidenceSources } from "../sql/evidence-sources.js";
import { SqlFactsStore } from "../sql/facts-store.js";
import { SqlKnowledgeGraph } from "../sql/knowledge-graph.js";
import {
  queryContextGraph,
  queryEntitySearch,
  queryGraphDigest,
  queryGraphReachable,
  type ContextGraphInput,
  type SqlQueryDeps
} from "../sql/sql-queries.js";
import { readRangesFor } from "../sql/sql-read-ranges.js";
import { captureEvidenceHandle, declarationStability, formatEvidenceHandle, formatSymbolId, resolveSymbolId, type DeclarationIdentity, type SymbolResolution } from "../symbol-identity.js";

export type SnapshotIndexStatus = {
  indexedGeneration: number;
  buildState?: string;
  files: number;
  types: number;
  methods: number;
  edges: number;
  coverage: SourceRootCoverage[];
};

/** Workspace-relative read-range request; `file` is echoed back as the caller sent it. */
export type ReadRangeRequest = { file: string; relativePath: string; positions: Array<{ line: number; column: number }> };

export type QueryOps = {
  status: { args: Record<string, never>; result: SnapshotIndexStatus };
  anchor: { args: { relativePath: string; line: number; column: number }; result: AnchorFacts | undefined };
  type: { args: { typeText: string; scope?: string }; result: JavaTypeLookupResult };
  types: { args: { queries: Array<{ typeText: string; scope?: string }> }; result: JavaTypeLookupResult[] };
  implementers: { args: { typeId: string; limit: number }; result: JavaTypeFacts[] };
  typeReferencers: { args: { typeId: string; edgeKinds: StaticEdgeKind[]; limit: number }; result: IndexedReference[] };
  callers: { args: { methodId: string; limit: number }; result: IndexedReference[] };
  callees: { args: { methodId: string; limit: number }; result: IndexedReference[] };
  calleesBatch: { args: { methodIds: string[]; limit: number }; result: Array<{ methodId: string; callees: IndexedReference[] }> };
  methodsWithParameterTypes: { args: { typeIds: string[]; limit: number }; result: string[] };
  files: { args: { relativePaths: string[] }; result: JavaFileBundle[] };
  readRanges: { args: { repoRoot: string; requests: ReadRangeRequest[] }; result: IndexedReadRangeResult[] };
  myBatisResource: { args: { relativePath: string }; result: MyBatisMapperResourceFacts | undefined };
  myBatisResourcesByNamespace: { args: { namespaces: string[] }; result: MyBatisResourceByNamespaceBatch };
  graphDigest: { args: Record<string, never>; result: GraphDigest };
  graphReachable: { args: { relativePath: string; maxHops: number }; result: GraphReachable };
  contextGraph: { args: { input: ContextGraphInput }; result: ContextGraphResult };
  entitySearch: { args: { task: string; limit: number }; result: EntityHit[] };
  search: { args: { task: string; limit: number; mode: EntitySearchMode; scope?: EntitySearchScope; maxPostings?: number }; result: DetailedEntitySearchResult };
  repositoryFactMarkers: { args: { importPrefixes: string[]; annotationPrefixes: string[] }; result: { importPrefixFound: boolean; annotationPrefixFound: boolean } };
  evidenceSources: { args: { relativePath: string; line: number; column: number }; result: EvidenceSourcesResult };
  resolveSymbol: { args: { workspaceId: string; symbolId: string }; result: SymbolResolution };
  resolveSymbols: { args: { workspaceId: string; symbolIds: string[] }; result: SymbolResolution[] };
  /** Public identities of declaration keys: a symbolId when the key is stable, and an evidence handle of this snapshot. */
  declarationIdentities: { args: { workspaceId: string; snapshotId: string; contentManifestId: string; declarationKeys: string[] }; result: DeclarationIdentity[] };
  symbolIdAt: { args: { workspaceId: string; relativePath: string; line: number; column: number }; result: string | undefined };
  /** The snapshot's captured content (path, kind, hash): the tracker's verification base. */
  contentEntries: { args: Record<string, never>; result: ContentEntry[] };
};
export type QueryOpName = keyof QueryOps;
export type QueryRequest<K extends QueryOpName = QueryOpName> = { op: K; args: QueryOps[K]["args"] };

export const QUERY_OP_NAMES: readonly QueryOpName[] = [
  "status", "anchor", "type", "types", "implementers", "typeReferencers", "callers", "callees", "calleesBatch",
  "methodsWithParameterTypes", "files", "readRanges", "myBatisResource", "myBatisResourcesByNamespace", "graphDigest",
  "graphReachable", "contextGraph", "entitySearch", "search", "repositoryFactMarkers", "evidenceSources", "resolveSymbol", "resolveSymbols", "declarationIdentities", "symbolIdAt", "contentEntries"
];

/** One open sealed snapshot. Its facts never change, so per-connection caches are safe. */
export class SnapshotConnection {
  readonly db: IndexDatabase;
  readonly store: SqlFactsStore;
  readonly graph: SqlKnowledgeGraph;
  readonly search: SqlEntitySearch;
  private cachedStatus?: SnapshotIndexStatus;

  constructor(readonly dbPath: string) {
    this.db = openImmutableIndexDb(dbPath);
    this.store = new SqlFactsStore(this.db, { factsAreImmutable: true });
    this.graph = new SqlKnowledgeGraph(this.db);
    this.search = new SqlEntitySearch(this.db);
  }

  close(): void {
    closeDb(this.db);
  }

  status(): SnapshotIndexStatus {
    if (this.cachedStatus) return this.cachedStatus;
    const counts = readIndexCounts(this.db) ?? { files: 0, types: 0, methods: 0, edges: 0 };
    const buildState = readMeta(this.db, "buildState");
    this.cachedStatus = {
      indexedGeneration: Number(readMeta(this.db, "indexedGeneration") ?? "0") || 0,
      ...(buildState ? { buildState } : {}),
      files: counts.files,
      types: counts.types,
      methods: counts.methods,
      edges: counts.edges,
      coverage: coverageRows(this.db)
    };
    return this.cachedStatus;
  }

  deps(): SqlQueryDeps {
    return {
      store: this.store,
      graph: this.graph,
      search: this.search,
      indexedGeneration: this.status().indexedGeneration,
      // Callers already pass workspace-relative paths.
      repoRoot: "",
      toRelative: relative => relative.replaceAll("\\", "/")
    };
  }
}

function coverageRows(db: IndexDatabase): SourceRootCoverage[] {
  const rows = prepareCached(db, "SELECT root AS root, state AS state, generation AS generation FROM source_root_coverage").all() as Array<{
    root: string;
    state: string;
    generation: number | bigint;
  }>;
  const counts = readSourceRootCounts(db);
  return rows.map(row => ({
    root: row.root,
    generation: Number(row.generation),
    state: row.state as SourceRootCoverage["state"],
    discoveredFiles: counts[row.root]?.discoveredFiles ?? 0,
    indexedFiles: counts[row.root]?.indexedFiles ?? 0,
    failedFiles: counts[row.root]?.failedFiles ?? 0,
    recoveredFiles: counts[row.root]?.recoveredFiles ?? 0,
    extractorVersion: counts[row.root]?.extractorVersion ?? ""
  }));
}

function coverageStateFor(status: SnapshotIndexStatus, root: string): SourceRootCoverage["state"] {
  const entry = status.coverage.find(candidate => candidate.root === root);
  if (!entry) return "UNKNOWN";
  if (entry.state === "COMPLETE" && entry.generation !== status.indexedGeneration) return "DEGRADED";
  return entry.state;
}

function worstTypeLookupCoverage(status: SnapshotIndexStatus): "COMPLETE" | "PARTIAL" | "DEGRADED" {
  const rank = (state: "COMPLETE" | "PARTIAL" | "DEGRADED"): number => state === "COMPLETE" ? 0 : state === "PARTIAL" ? 1 : 2;
  let worst: "COMPLETE" | "PARTIAL" | "DEGRADED" = status.coverage.length === 0 ? "DEGRADED" : "COMPLETE";
  for (const entry of status.coverage) {
    const mapped: "COMPLETE" | "PARTIAL" | "DEGRADED" = entry.generation !== status.indexedGeneration
      ? "DEGRADED"
      : entry.state === "COMPLETE" ? "COMPLETE" : entry.state === "BUILDING" ? "PARTIAL" : "DEGRADED";
    if (rank(mapped) > rank(worst)) worst = mapped;
  }
  return worst;
}

function withUnresolvedCoverage(result: JavaTypeLookupResult, status: SnapshotIndexStatus): JavaTypeLookupResult {
  return result.state === "UNRESOLVED" ? { ...result, coverage: worstTypeLookupCoverage(status) } : result;
}

/** sha256 of the exact bytes, as capture computes contentHash. */
export function contentHashOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Live source for a preview, accepted only when its bytes are the snapshot's captured bytes. */
async function verifiedSource(repoRoot: string, relativePath: string, expectedHash: string | undefined): Promise<
  { state: "ok"; content: string } | { state: "missing" | "changed" }
> {
  if (!expectedHash) return { state: "missing" };
  const root = await realpath(repoRoot).catch(() => path.resolve(repoRoot));
  const readable = await resolvedPathWithinRepo(path.resolve(repoRoot, relativePath), root).catch(() => undefined);
  // The snapshot captured this file: a live copy that is gone or unreadable no longer matches it.
  if (!readable) return { state: "changed" };
  let bytes: Buffer;
  try { bytes = await readFile(readable); } catch { return { state: "changed" }; }
  return contentHashOf(bytes) === expectedHash ? { state: "ok", content: bytes.toString("utf8") } : { state: "changed" };
}

/** Runs one operation against one sealed snapshot. `remainingMs` bounds the budgeted scans. */
export async function runQueryOp<K extends QueryOpName>(
  conn: SnapshotConnection,
  request: QueryRequest<K>,
  remainingMs?: () => number
): Promise<QueryOps[K]["result"]> {
  const args = request.args as never;
  return await (OPS[request.op] as (conn: SnapshotConnection, args: never, remainingMs?: () => number) => unknown)(conn, args, remainingMs) as QueryOps[K]["result"];
}

type Impl = { [K in QueryOpName]: (conn: SnapshotConnection, args: QueryOps[K]["args"], remainingMs?: () => number) => QueryOps[K]["result"] | Promise<QueryOps[K]["result"]> };

const OPS: Impl = {
  status: conn => conn.status(),
  anchor: (conn, { relativePath, line, column }) => {
    const anchor = conn.store.anchor(relativePath, line, column);
    return anchor ? { ...anchor, coverage: coverageStateFor(conn.status(), anchor.file.sourceRoot) } : undefined;
  },
  type: (conn, { typeText, scope }) => withUnresolvedCoverage(conn.store.typeLookup(typeText, scope), conn.status()),
  types: (conn, { queries }) => queries.map(query => withUnresolvedCoverage(conn.store.typeLookup(query.typeText, query.scope), conn.status())),
  implementers: (conn, { typeId, limit }) => conn.store.implementers(typeId, limit),
  typeReferencers: (conn, { typeId, edgeKinds, limit }) => conn.store.typeReferencers(typeId, new Set(edgeKinds), limit),
  callers: (conn, { methodId, limit }) => conn.store.callers(methodId, limit),
  callees: (conn, { methodId, limit }) => conn.store.callees(methodId, limit),
  calleesBatch: (conn, { methodIds, limit }) => methodIds.map(methodId => ({ methodId, callees: conn.store.callees(methodId, limit) })),
  methodsWithParameterTypes: (conn, { typeIds, limit }) => typeIds.length === 0 ? [] : conn.store.methodsWithParameterTypes(typeIds, limit),
  files: (conn, { relativePaths }) => conn.store.files(relativePaths),
  readRanges: async (conn, { repoRoot, requests }) => Promise.all(requests.map(async request => {
    const bundle = request.relativePath.endsWith(".java") ? conn.store.files([request.relativePath])[0] : undefined;
    const resource = bundle ? undefined : conn.store.myBatisResource(request.relativePath);
    const source = await verifiedSource(repoRoot, request.relativePath, bundle?.file.contentHash ?? resource?.contentHash);
    // §2.3.6: a live file whose bytes differ from the held snapshot gets no ranges, only an explicit gap.
    if (source.state !== "ok") return { file: request.file, ranges: [], ...(source.state === "changed" ? { sourceChanged: true } : {}) };
    return { ...readRangesFor(bundle, resource, source.content, request.positions), file: request.file };
  })),
  myBatisResource: (conn, { relativePath }) => conn.store.myBatisResource(relativePath),
  myBatisResourcesByNamespace: (conn, { namespaces }) => namespaces.map(namespace => {
    const resource = conn.store.myBatisResourceForNamespace(namespace);
    return resource ? { namespace, resource } : { namespace };
  }),
  graphDigest: conn => queryGraphDigest(conn.deps()),
  graphReachable: (conn, { relativePath, maxHops }) => queryGraphReachable(conn.deps(), relativePath, maxHops),
  contextGraph: (conn, { input }, remainingMs) => {
    conn.graph.prefetch();
    return queryContextGraph(conn.deps(), input, remainingMs);
  },
  entitySearch: (conn, { task, limit }, remainingMs) => queryEntitySearch(conn.deps(), task, limit, remainingMs),
  search: (conn, { task, limit, mode, scope, maxPostings }, remainingMs) =>
    conn.search.searchDetailed(task, limit, mode, { scope, budget: { maxPostings, remainingMs } }),
  repositoryFactMarkers: (conn, { importPrefixes, annotationPrefixes }) => conn.store.repositoryFactMarkers(importPrefixes, annotationPrefixes),
  evidenceSources: (conn, { relativePath, line, column }, remainingMs) => queryEvidenceSources(conn.db, relativePath, line, column, remainingMs),
  resolveSymbol: (conn, { workspaceId, symbolId }) => resolveSymbolId(conn.db, workspaceId, symbolId),
  resolveSymbols: (conn, { workspaceId, symbolIds }) => symbolIds.map(symbolId => resolveSymbolId(conn.db, workspaceId, symbolId)),
  declarationIdentities: (conn, { workspaceId, snapshotId, contentManifestId, declarationKeys }) => declarationKeys.map(declarationKey => {
    const stability = declarationStability(declarationKey);
    let symbolId: string | undefined;
    if (stability === "STABLE") try { symbolId = formatSymbolId(workspaceId, declarationKey); } catch { symbolId = undefined; }
    let evidenceHandle: string | undefined;
    const handle = captureEvidenceHandle(conn.db, { snapshotId, contentManifestId, declarationKey });
    if (handle) try { evidenceHandle = formatEvidenceHandle(handle); } catch { evidenceHandle = undefined; }
    return { stability, ...(symbolId ? { symbolId } : {}), ...(evidenceHandle ? { evidenceHandle } : {}) };
  }),
  symbolIdAt: (conn, { workspaceId, relativePath, line, column }) => {
    const anchor = conn.store.anchor(relativePath, line, column);
    if (!anchor || anchor.symbolKind === "FILE") return undefined;
    try { return formatSymbolId(workspaceId, anchor.symbolId); } catch { return undefined; }
  },
  contentEntries: conn => conn.db.prepare(`SELECT 'java' AS kind, path, content_hash AS hash FROM main.file
      UNION ALL SELECT 'resource', path, content_hash FROM main.resource_scan`).all() as ContentEntry[]
};

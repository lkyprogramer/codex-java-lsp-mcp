import { computeExtractorVersion } from "../java-index/build-fingerprint.js";
import type { SourceRootCoverage } from "../java-index/index-types.js";
import { prepareCached, type IndexDatabase } from "../java-index/sql/driver.js";

export type BuildPhase = "declare" | "resolve";

export type BuildProgress = {
  phase: BuildPhase;
  done: number;
  total: number;
};

export type IndexCounts = {
  files: number;
  types: number;
  methods: number;
  edges: number;
};

function asText(row: { value?: unknown } | undefined): string | undefined {
  return typeof row?.value === "string" ? row.value : undefined;
}

export function readMeta(db: IndexDatabase, key: string): string | undefined {
  return asText(prepareCached(db, "SELECT value FROM meta WHERE key=?").get(key) as { value?: unknown } | undefined);
}

export function writeMeta(db: IndexDatabase, key: string, value: string): void {
  prepareCached(
    db,
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, value);
}

export function readBuildProgress(db: IndexDatabase): BuildProgress | undefined {
  const raw = readMeta(db, "buildProgress");
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as BuildProgress;
  if (parsed.phase !== "declare" && parsed.phase !== "resolve") return undefined;
  if (!Number.isInteger(parsed.done) || !Number.isInteger(parsed.total)) return undefined;
  return parsed;
}

export function writeBuildProgress(db: IndexDatabase, progress: BuildProgress): void {
  writeMeta(db, "buildProgress", JSON.stringify(progress));
}

function countStar(db: IndexDatabase, table: "file" | "type" | "method" | "edge"): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number | bigint } | undefined;
  const n = row?.n;
  return typeof n === "number" ? n : typeof n === "bigint" ? Number(n) : 0;
}

export function refreshIndexCounts(db: IndexDatabase): IndexCounts {
  const counts: IndexCounts = {
    files: countStar(db, "file"),
    types: countStar(db, "type"),
    methods: countStar(db, "method"),
    edges: countStar(db, "edge")
  };
  writeMeta(db, "counts", JSON.stringify(counts));
  return counts;
}

export function readIndexCounts(db: IndexDatabase): IndexCounts | undefined {
  const raw = readMeta(db, "counts");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<IndexCounts>;
    if (![parsed.files, parsed.types, parsed.methods, parsed.edges].every(value => typeof value === "number")) {
      return undefined;
    }
    return {
      files: parsed.files!,
      types: parsed.types!,
      methods: parsed.methods!,
      edges: parsed.edges!
    };
  } catch {
    return undefined;
  }
}

export function clearIndexData(db: IndexDatabase): void {
  db.exec(`
    DELETE FROM entity_token;
    DELETE FROM entity;
    DELETE FROM entity_df;
    DELETE FROM search_doc_token;
    DELETE FROM search_doc;
    DELETE FROM search_doc_df;
    DELETE FROM kg_summary;
    DELETE FROM kg_edge;
    DELETE FROM kg_node;
    DELETE FROM mybatis_resource;
    DELETE FROM resource_scan;
    DELETE FROM source_root_coverage;
    DELETE FROM file;
    DELETE FROM meta WHERE key NOT IN ('schemaVersion', 'identityVersion', 'factsRevision', 'factsEncoding');
  `);
}

/** A full source traversal, not a partial watcher update, establishes coverage. */
export function publishIndexCoverage(
  db: IndexDatabase,
  generation: number,
  roots: readonly string[],
  discovered?: readonly { sourceRoot: string }[]
): IndexCounts {
  const previous = readSourceRootCounts(db);
  const baselineComplete = readMeta(db, "buildState") === "READY" && readMeta(db, "coverageRevision") === "1";
  const rows = db.prepare(`SELECT source_root AS root, count(*) AS indexedFiles,
    sum(parse_state='FAILED') AS failedFiles, sum(parse_state='RECOVERED') AS recoveredFiles
    FROM file GROUP BY source_root`).all() as Array<{ root: string; indexedFiles: number; failedFiles: number; recoveredFiles: number }>;
  const indexed = new Map(rows.map(row => [row.root, row]));
  const counts: Record<string, Omit<SourceRootCoverage, "root" | "state" | "generation">> = {};
  const upsert = prepareCached(db, `INSERT INTO source_root_coverage(root, state, generation) VALUES (?, ?, ?)
    ON CONFLICT(root) DO UPDATE SET state=excluded.state, generation=excluded.generation`);
  let complete = discovered !== undefined || baselineComplete;
  // A changed layout has unvisited roots, even when the previous layout was complete.
  const oldRoots = new Set((db.prepare("SELECT root FROM source_root_coverage").all() as Array<{ root: string }>).map(row => row.root));
  db.exec("DELETE FROM source_root_coverage");
  for (const root of roots) {
    const row = indexed.get(root);
    const indexedFiles = Number(row?.indexedFiles ?? 0);
    const failedFiles = Number(row?.failedFiles ?? 0);
    const discoveredFiles = discovered !== undefined
      ? discovered.filter(file => file.sourceRoot === root).length
      : baselineComplete && oldRoots.has(root) ? indexedFiles : previous[root]?.discoveredFiles ?? 0;
    const covered = (discovered !== undefined || baselineComplete && oldRoots.has(root)) && discoveredFiles === indexedFiles && failedFiles === 0 && Number(row?.recoveredFiles ?? 0) === 0;
    if (!covered) complete = false;
    const state = covered ? "COMPLETE" : discovered === undefined && readMeta(db, "buildState") === "BUILDING" ? "BUILDING" : "DEGRADED";
    upsert.run(root, state, generation);
    counts[root] = { discoveredFiles, indexedFiles, failedFiles, recoveredFiles: Number(row?.recoveredFiles ?? 0), extractorVersion: computeExtractorVersion() };
  }
  writeMeta(db, "sourceRootCounts", JSON.stringify(counts));
  writeMeta(db, "indexedGeneration", String(generation));
  writeMeta(db, "buildState", complete ? "READY" : readMeta(db, "buildState") === "BUILDING" && discovered === undefined ? "BUILDING" : "DEGRADED");
  if (discovered !== undefined) writeMeta(db, "coverageRevision", "1");
  return refreshIndexCounts(db);
}

export function readSourceRootCounts(db: IndexDatabase): Record<string, Omit<SourceRootCoverage, "root" | "state" | "generation">> {
  return JSON.parse(readMeta(db, "sourceRootCounts") ?? "{}");
}

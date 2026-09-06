import { prepareCached, type IndexDatabase } from "../sql/driver.js";

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

export function clearIndexData(db: IndexDatabase): void {
  db.exec(`
    DELETE FROM entity_token;
    DELETE FROM entity;
    DELETE FROM entity_df;
    DELETE FROM kg_summary;
    DELETE FROM kg_edge;
    DELETE FROM kg_node;
    DELETE FROM mybatis_resource;
    DELETE FROM source_root_coverage;
    DELETE FROM file;
    DELETE FROM meta WHERE key != 'schemaVersion';
  `);
}

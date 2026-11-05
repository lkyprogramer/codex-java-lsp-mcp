import { withTransaction, type IndexDatabase } from "../java-index/sql/driver.js";
import { schemaVersionsMatch } from "../java-index/sql/schema.js";
import { readMeta, readSourceRootCounts } from "./progress.js";

export type PipelineStage = { files: number; elapsedMs: number; javaFiles?: number; xmlFiles?: number; rows?: number; measurement?: string; closure?: Record<string, number>; edgeFiles?: number; graphFiles?: number; documentFiles?: number };
export type PipelineMetrics = { mode: "full" | "delta"; reason: string; capture: PipelineStage; parse: PipelineStage; resolve: PipelineStage; graphSearch: PipelineStage; sql: PipelineStage;
  /** The builder process read its database once before the job (warmFile). */
  warm?: PipelineStage; onStage?: (name:string)=>Promise<void> };
export function pipelineMetrics(mode: "full" | "delta", reason: string): PipelineMetrics {
  return {mode,reason,capture:{files:0,elapsedMs:0},parse:{files:0,elapsedMs:0},resolve:{files:0,elapsedMs:0},graphSearch:{files:0,elapsedMs:0},sql:{files:0,elapsedMs:0}};
}
/** An unfinished writer is not a compatible published base. Degraded coverage
 * may be reused: its recorded gaps are reparsed without redoing valid files. */
export function compatibleDeltaBase(db: IndexDatabase): boolean {
  if(Object.values(readSourceRootCounts(db)).some(root=>root.discoveredFiles!==root.indexedFiles)) return false;
  return readMeta(db,"pipelineComplete") !== "0" && schemaVersionsMatch(db) && readMeta(db,"coverageRevision") === "1" && readMeta(db,"buildState") !== "BUILDING";
}

/** Transaction wall time includes SQL-driven resolve/graph computation. It is
 * intentionally reported as overlapping, not added to those phase durations. */
export function sqlStage<T>(db: IndexDatabase, metrics: PipelineMetrics | undefined, work: () => T): T {
  if(db.isTransaction) return work();
  const started=performance.now();
  const before=Number((db.prepare("SELECT total_changes() AS n").get() as {n:number}).n);
  const result=withTransaction(db,work);
  if(metrics) {
    metrics.sql.elapsedMs+=performance.now()-started;
    metrics.sql.rows=(metrics.sql.rows ?? 0)+Number((db.prepare("SELECT total_changes() AS n").get() as {n:number}).n)-before;
    metrics.sql.measurement="transaction-wall-inclusive; overlaps resolve/graph";
  }
  return result;
}

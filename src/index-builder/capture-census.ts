import type { IndexDatabase } from "../java-index/sql/driver.js";

/** Per-job observations, not a persistent freshness or atomic-tree attestation. */
export type CaptureCensusEntry = {
  relativePath: string;
  kind: "java" | "xml";
  state: "indexed" | "failed" | "deleted";
  contentHash?: string;
};
export function captureCensus(db: IndexDatabase): CaptureCensusEntry[] {
  const java = db.prepare("SELECT path, content_hash AS hash, parse_state AS state FROM file").all() as Array<{path:string;hash:string;state:string}>;
  const xml = db.prepare("SELECT path, content_hash AS hash FROM resource_scan").all() as Array<{path:string;hash:string}>;
  return [
    ...java.map(row => ({relativePath:row.path,kind:"java" as const,state:row.state === "FAILED" ? "failed" as const : "indexed" as const,contentHash:row.hash})),
    ...xml.map(row => ({relativePath:row.path,kind:"xml" as const,state:"indexed" as const,contentHash:row.hash}))
  ].sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
}
export function finishCaptureCensus(db: IndexDatabase, before: readonly CaptureCensusEntry[], failures: readonly string[] = []): CaptureCensusEntry[] {
 const current = captureCensus(db); const seen = new Set(current.map(row=>row.relativePath));
 for (const relativePath of failures) if(!seen.has(relativePath)) {current.push({relativePath,kind:"java",state:"failed"});seen.add(relativePath);}
 for(const row of before) if(!seen.has(row.relativePath)) current.push({relativePath:row.relativePath,kind:row.kind,state:"deleted"});
 return current.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
}

// input: Request-scoped generation and Java symbol lookups.
// output: Async JavaIndex facts for AgentRouter and tools.
// pos: Temporary V2 adapter surface that JavaIndexClient satisfies.
import type {
  AnchorFacts,
  IndexedReference,
  JavaFileBundle,
  JavaIndexStatus,
  JavaTypeFacts,
  JavaTypeLookupResult,
  StaticEdgeKind
} from "./index-types.js";

export type JavaIndexOpenSource = "own-snapshot" | "sibling-seed" | "cold";

export interface JavaIndexView {
  ensureFresh(files: string[], generation: number): Promise<void>;
  queryAnchor(file: string, line: number, column: number): Promise<AnchorFacts | undefined>;
  queryType(typeText: string, scopeFile?: string): Promise<JavaTypeLookupResult>;
  queryTypes(queries: Array<{ typeText: string; scopeFile?: string }>): Promise<JavaTypeLookupResult[]>;
  queryImplementers(typeId: string, limit: number): Promise<JavaTypeFacts[]>;
  queryTypeReferencers(
    typeId: string,
    kinds: StaticEdgeKind[],
    limit: number
  ): Promise<IndexedReference[]>;
  queryCallers(methodId: string, limit: number): Promise<IndexedReference[]>;
  queryCallees(methodId: string, limit: number): Promise<IndexedReference[]>;
  queryFiles(files: string[]): Promise<JavaFileBundle[]>;
  status(): Promise<JavaIndexStatus>;
}

export function openSourceFromStatus(status: JavaIndexStatus): JavaIndexOpenSource {
  return status.files > 0 ? "own-snapshot" : "cold";
}

export function summarizeCoverage(
  status: JavaIndexStatus
): "complete" | "partial" | "degraded" {
  // Status may be supplied by an older in-process test/runtime seam during a
  // rolling update. No resource roots is equivalent to an empty coverage set;
  // do not turn an otherwise valid Java summary into a TypeError.
  const resourceCoverage = status.resourceCoverage ?? [];
  if (status.state === "DEGRADED" || status.lastError) {
    return "degraded";
  }
  if (status.coverage.length === 0) {
    return status.files > 0 ? "partial" : "degraded";
  }
  const allComplete = status.coverage.every(
    entry => entry.state === "COMPLETE" && entry.failedFiles === 0
  ) && resourceCoverage.every(
    entry => entry.state === "COMPLETE" && entry.failedFiles === 0
  );
  if (allComplete && status.pendingForeground === 0 && status.pendingBackground === 0) {
    return "complete";
  }
  if (
    status.coverage.some(entry => entry.state === "DEGRADED" || entry.failedFiles > 0)
    || resourceCoverage.some(entry => entry.state === "DEGRADED" || entry.failedFiles > 0)
  ) {
    return "degraded";
  }
  return "partial";
}

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPotentiallyWithin } from "./path-utils.js";
import { repoCacheRoot } from "./repo-layout.js";
import { readJsonLines } from "./util/jsonl.js";

export type SemanticEdgeKind = "reference" | "implementation" | "typeHierarchy";

export type SemanticEdge = {
  from: string;
  to: string;
  kind: SemanticEdgeKind;
  line: number;
  column: number;
  fromMtimeMs: number;
  confirmedAt: string;
};

export type SemanticEdgeInput = Pick<SemanticEdge, "to" | "kind" | "line" | "column">;

type EdgeRecord = SemanticEdge & { batchId: string };

export type EdgeStoreStatus = {
  anchors: number;
  edges: number;
  hits: number;
  misses: number;
  invalidated: number;
  rejectedOutsideRepo: number;
};

export class EdgeStore {
  private readonly edgesByFrom = new Map<string, EdgeRecord[]>();
  private readonly edgesPath: string;
  private readonly repoRoot: string;
  private totalRecords = 0;
  private hits = 0;
  private misses = 0;
  private invalidated = 0;
  private rejectedOutsideRepo = 0;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
    this.edgesPath = path.join(repoCacheRoot(repoRoot), "semantic-edges.jsonl");
    this.load();
  }

  status(): EdgeStoreStatus {
    let edges = 0;
    for (const records of this.edgesByFrom.values()) {
      edges += records.length;
    }
    return {
      anchors: this.edgesByFrom.size,
      edges,
      hits: this.hits,
      misses: this.misses,
      invalidated: this.invalidated,
      rejectedOutsideRepo: this.rejectedOutsideRepo
    };
  }

  recordEdges(fromFile: string, edges: SemanticEdgeInput[]): void {
    if (edges.length === 0) {
      return;
    }
    // Last line of defence: an outside-repo target must never be persisted,
    // or it would survive as evidence long after the request that produced it.
    if (!isPotentiallyWithin(this.repoRoot, fromFile)) {
      this.rejectedOutsideRepo += 1;
      return;
    }
    const contained: SemanticEdgeInput[] = [];
    for (const edge of edges) {
      if (isPotentiallyWithin(this.repoRoot, edge.to)) {
        contained.push(edge);
      } else {
        this.rejectedOutsideRepo += 1;
      }
    }
    if (contained.length === 0) {
      return;
    }
    const stat = statSync(fromFile);
    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const confirmedAt = new Date().toISOString();
    const uniqueEdges = uniqueSemanticEdgeInputs(contained);
    if (uniqueEdges.length === 0) {
      return;
    }
    const records = uniqueEdges.map(edge => ({
      ...edge,
      from: fromFile,
      fromMtimeMs: stat.mtimeMs,
      confirmedAt,
      batchId
    }));
    this.edgesByFrom.set(fromFile, records);
    mkdirSync(path.dirname(this.edgesPath), { recursive: true });
    appendFileSync(this.edgesPath, records.map(record => `${JSON.stringify(record)}\n`).join(""));
    this.totalRecords += records.length;
    const live = this.status().edges;
    if (this.totalRecords > live * 2 && this.totalRecords > 200) {
      this.compact();
    }
  }

  /** Coarse eviction: drop all cached edges on any repo change (Iteration B). */
  invalidateAll(): void {
    if (this.edgesByFrom.size === 0) return;
    this.invalidated += this.edgesByFrom.size;
    this.edgesByFrom.clear();
  }

  edgesFor(fromFile: string): SemanticEdge[] {
    const records = this.edgesByFrom.get(fromFile);
    if (!records || records.length === 0) {
      this.misses += 1;
      return [];
    }
    try {
      if (statSync(fromFile).mtimeMs !== records[0].fromMtimeMs) {
        this.edgesByFrom.delete(fromFile);
        this.invalidated += 1;
        this.misses += 1;
        return [];
      }
    } catch {
      this.edgesByFrom.delete(fromFile);
      this.invalidated += 1;
      this.misses += 1;
      return [];
    }
    const alive = records.filter(record => existsSync(record.to));
    this.hits += 1;
    return alive;
  }

  private load(): void {
    if (!existsSync(this.edgesPath)) {
      return;
    }
    try {
      const batchByFrom = new Map<string, string>();
      for (const record of readJsonLines<EdgeRecord>(this.edgesPath)) {
        if (typeof record.from !== "string" || typeof record.to !== "string" || typeof record.fromMtimeMs !== "number") {
          continue;
        }
        this.totalRecords += 1;
        if (batchByFrom.get(record.from) !== record.batchId) {
          batchByFrom.set(record.from, record.batchId);
          this.edgesByFrom.set(record.from, []);
        }
        this.edgesByFrom.get(record.from)?.push(record);
      }
    } catch {
      rmSync(this.edgesPath, { force: true });
      this.edgesByFrom.clear();
      this.totalRecords = 0;
    }
  }

  private compact(): void {
    const tmp = `${this.edgesPath}.tmp`;
    const lines: string[] = [];
    this.totalRecords = 0;
    for (const records of this.edgesByFrom.values()) {
      for (const record of records) {
        lines.push(JSON.stringify(record));
        this.totalRecords += 1;
      }
    }
    writeFileSync(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "");
    renameSync(tmp, this.edgesPath);
  }
}

function uniqueSemanticEdgeInputs(edges: SemanticEdgeInput[]): SemanticEdgeInput[] {
  const uniqueEdges: SemanticEdgeInput[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    const key = `${edge.kind}\0${edge.to}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueEdges.push(edge);
  }
  return uniqueEdges;
}

import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { REVERSE_EDGE_KIND, type EdgeKind } from "../../java-knowledge/edge-kinds.js";
import { knowledgeEdgeId } from "../../java-knowledge/entity-id.js";
import type { MethodSummary } from "../../java-knowledge/method-summary.js";
import type { GraphEdge, GraphNode } from "../../java-knowledge/schema.js";
import { prepareCached, withTransaction, type IndexDatabase } from "./driver.js";
import { asCount } from "./facts-store.js";
import { decodeFacts, encodeFacts } from "./rows.js";

function itemHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function xorBuffers(target: Buffer, item: Buffer): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index] = (target[index] ?? 0) ^ (item[index] ?? 0);
  }
}

function readMeta(db: IndexDatabase, key: string): string | undefined {
  const row = prepareCached(db, "SELECT value FROM meta WHERE key=?").get(key) as { value?: unknown } | undefined;
  return typeof row?.value === "string" ? row.value : undefined;
}

function writeMeta(db: IndexDatabase, key: string, value: string): void {
  prepareCached(
    db,
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(key, value);
}

function xorFromMeta(db: IndexDatabase, key: string): Buffer {
  const raw = readMeta(db, key);
  if (!raw || raw.length !== 64) return Buffer.alloc(32);
  const buf = Buffer.from(raw, "hex");
  return buf.length === 32 ? buf : Buffer.alloc(32);
}

function edgeFacts(row: Record<string, SQLOutputValue>): GraphEdge {
  const edge = decodeFacts<GraphEdge>(row.facts);
  return {
    edgeId: edge.edgeId,
    kind: edge.kind,
    fromId: edge.fromId,
    toId: edge.toId,
    generation: edge.generation,
    ...(edge.sourceFile ? { sourceFile: edge.sourceFile } : {})
  };
}

function nodeFacts(row: Record<string, SQLOutputValue>): GraphNode {
  const node = decodeFacts<GraphNode>(row.facts);
  return {
    id: node.id,
    kind: node.kind,
    generation: node.generation,
    ...(node.relativePath ? { relativePath: node.relativePath } : {}),
    ...(node.simpleName ? { simpleName: node.simpleName } : {}),
    ...(node.javaIndexId ? { javaIndexId: node.javaIndexId } : {})
  };
}

class SqlSummaryMap {
  constructor(private readonly db: IndexDatabase) {}

  get(methodId: string): MethodSummary | undefined {
    const row = prepareCached(this.db, "SELECT facts FROM kg_summary WHERE method_id=?").get(methodId);
    return row ? decodeFacts<MethodSummary>(row.facts) : undefined;
  }

  set(methodId: string, summary: MethodSummary): this {
    prepareCached(
      this.db,
      "INSERT INTO kg_summary(method_id, facts) VALUES (?, ?) ON CONFLICT(method_id) DO UPDATE SET facts=excluded.facts"
    ).run(methodId, encodeFacts(summary));
    return this;
  }

  delete(methodId: string): boolean {
    const result = prepareCached(this.db, "DELETE FROM kg_summary WHERE method_id=?").run(methodId);
    return result.changes > 0;
  }

  clear(): void {
    this.db.exec("DELETE FROM kg_summary");
  }
}

export class SqlKnowledgeGraph {
  generation = 0;
  readonly summariesByMethodId: SqlSummaryMap;
  readonly nodesById: {
    get(id: string): GraphNode | undefined;
    has(id: string): boolean;
    readonly size: number;
    entries(): IterableIterator<[string, GraphNode]>;
  };
  readonly edgesById: { readonly size: number };

  private readonly nodeXor: Buffer;
  private readonly edgeXor: Buffer;
  private readonly knownEdgeIds = new Set<string>();

  constructor(private readonly db: IndexDatabase) {
    this.nodeXor = xorFromMeta(db, "graphNodeXor");
    this.edgeXor = xorFromMeta(db, "graphEdgeXor");
    this.generation = Number(readMeta(db, "kgGeneration") ?? "0") || 0;
    this.summariesByMethodId = new SqlSummaryMap(db);
    this.nodesById = {
      get: id => this.nodeById(id),
      has: id => this.nodeById(id) !== undefined,
      get size() {
        return asCount(prepareCached(db, "SELECT count(*) AS n FROM kg_node").get());
      },
      entries: () => this.nodeEntries()
    };
    const self = this;
    this.edgesById = {
      get size() {
        return asCount(prepareCached(self.db, "SELECT count(*) AS n FROM kg_edge").get());
      }
    };
    for (const row of prepareCached(db, "SELECT facts FROM kg_edge").iterate()) {
      const edgeId = decodeFacts<GraphEdge>(row.facts).edgeId;
      if (typeof edgeId === "string") this.knownEdgeIds.add(edgeId);
    }
  }

  flushMeta(): void {
    this.persistXor();
    this.persistGeneration();
  }

  private writeTx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    return withTransaction(this.db, () => {
      const value = fn();
      this.flushMeta();
      return value;
    });
  }

  digest(): string {
    return createHash("sha256")
      .update(this.nodeXor)
      .update(`:${this.nodesById.size}:`)
      .update(this.edgeXor)
      .update(`:${this.edgesById.size}`)
      .digest("hex");
  }

  upsertNode(node: GraphNode, ownerFile?: string): void {
    this.writeTx(() => {
      const existing = prepareCached(this.db, "SELECT kind FROM kg_node WHERE id=?").get(node.id) as
        | { kind: string }
        | undefined;
      if (!existing) {
        xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
      } else if (existing.kind !== node.kind) {
        xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${existing.kind}`));
        xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
      }
      prepareCached(
        this.db,
        `INSERT INTO kg_node(id, kind, relative_path, java_index_id, owner_file, facts)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind,
           relative_path=excluded.relative_path,
           java_index_id=excluded.java_index_id,
           owner_file=COALESCE(kg_node.owner_file, excluded.owner_file),
           facts=excluded.facts`
      ).run(
        node.id,
        node.kind,
        node.relativePath ?? null,
        node.javaIndexId ?? null,
        ownerFile ?? null,
        encodeFacts(node)
      );
    });
  }

  addEdge(edge: GraphEdge, ownerFile?: string): GraphEdge {
    return this.writeTx(() => {
      if (this.knownEdgeIds.has(edge.edgeId)) {
        if (ownerFile) {
          prepareCached(
            this.db,
            "UPDATE kg_edge SET owner_file=COALESCE(owner_file, ?) WHERE from_id=? AND to_id=? AND kind=?"
          ).run(ownerFile, edge.fromId, edge.toId, edge.kind);
        }
        return edge;
      }
      prepareCached(
        this.db,
        "INSERT INTO kg_edge(from_id, to_id, kind, owner_file, facts) VALUES (?, ?, ?, ?, ?)"
      ).run(edge.fromId, edge.toId, edge.kind, ownerFile ?? null, encodeFacts(edge));
      this.knownEdgeIds.add(edge.edgeId);
      xorBuffers(this.edgeXor, itemHash(`e:${edge.edgeId}`));
      const reverseKind = REVERSE_EDGE_KIND[edge.kind];
      if (reverseKind) {
        this.addEdge({
          edgeId: knowledgeEdgeId({ kind: reverseKind, fromId: edge.toId, toId: edge.fromId, ordinal: 0 }),
          kind: reverseKind,
          fromId: edge.toId,
          toId: edge.fromId,
          sourceFile: edge.sourceFile,
          generation: edge.generation
        }, ownerFile);
      }
      return edge;
    });
  }

  removeFiles(relativePaths: readonly string[]): void {
    if (relativePaths.length === 0) return;
    this.writeTx(() => {
      const placeholders = relativePaths.map(() => "?").join(",");
      const edges = this.db.prepare(
        `SELECT facts FROM kg_edge WHERE owner_file IN (${placeholders})`
      ).all(...relativePaths) as Array<{ facts: SQLOutputValue }>;
      for (const row of edges) {
        const edgeId = edgeFacts(row).edgeId;
        xorBuffers(this.edgeXor, itemHash(`e:${edgeId}`));
        this.knownEdgeIds.delete(edgeId);
      }
      const nodes = this.db.prepare(
        `SELECT id, kind FROM kg_node WHERE owner_file IN (${placeholders})`
      ).all(...relativePaths) as Array<{ id: string; kind: string }>;
      for (const node of nodes) {
        xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
        prepareCached(this.db, "DELETE FROM kg_summary WHERE method_id=?").run(node.id);
      }
      this.db.prepare(`DELETE FROM kg_edge WHERE owner_file IN (${placeholders})`).run(...relativePaths);
      this.db.prepare(`DELETE FROM kg_node WHERE owner_file IN (${placeholders})`).run(...relativePaths);
    });
  }

  successors(nodeId: string, kind?: EdgeKind): GraphEdge[] {
    const rows = kind === undefined
      ? prepareCached(this.db, "SELECT facts FROM kg_edge WHERE from_id=? ORDER BY id").all(nodeId)
      : prepareCached(this.db, "SELECT facts FROM kg_edge WHERE from_id=? AND kind=? ORDER BY id").all(nodeId, kind);
    return rows.map(edgeFacts);
  }

  predecessors(nodeId: string, kind?: EdgeKind): GraphEdge[] {
    const rows = kind === undefined
      ? prepareCached(this.db, "SELECT facts FROM kg_edge WHERE to_id=? ORDER BY id").all(nodeId)
      : prepareCached(this.db, "SELECT facts FROM kg_edge WHERE to_id=? AND kind=? ORDER BY id").all(nodeId, kind);
    return rows.map(edgeFacts);
  }

  nodesByPath(path: string): GraphNode[] {
    return prepareCached(this.db, "SELECT facts FROM kg_node WHERE relative_path=? ORDER BY id")
      .all(path)
      .map(row => nodeFacts(row));
  }

  nodeIdForJavaIndexId(jid: string): string | undefined {
    const row = prepareCached(this.db, "SELECT id FROM kg_node WHERE java_index_id=?").get(jid) as { id?: string } | undefined;
    return typeof row?.id === "string" ? row.id : undefined;
  }

  clear(): void {
    this.writeTx(() => {
      this.db.exec("DELETE FROM kg_summary; DELETE FROM kg_edge; DELETE FROM kg_node;");
      this.nodeXor.fill(0);
      this.edgeXor.fill(0);
      this.generation = 0;
      this.knownEdgeIds.clear();
    });
  }

  private nodeById(id: string): GraphNode | undefined {
    const row = prepareCached(this.db, "SELECT facts FROM kg_node WHERE id=?").get(id);
    return row ? nodeFacts(row) : undefined;
  }

  private *nodeEntries(): IterableIterator<[string, GraphNode]> {
    const rows = prepareCached(this.db, "SELECT id, facts FROM kg_node ORDER BY id").all();
    for (const row of rows) {
      yield [row.id as string, nodeFacts(row)];
    }
  }

  private persistXor(): void {
    writeMeta(this.db, "graphNodeXor", this.nodeXor.toString("hex"));
    writeMeta(this.db, "graphEdgeXor", this.edgeXor.toString("hex"));
  }

  private persistGeneration(): void {
    writeMeta(this.db, "kgGeneration", String(this.generation));
  }
}

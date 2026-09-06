import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { REVERSE_EDGE_KIND, type EdgeKind } from "../../java-knowledge/edge-kinds.js";
import { knowledgeEdgeId } from "../../java-knowledge/entity-id.js";
import type { MethodSummary } from "../../java-knowledge/method-summary.js";
import type { GraphEdge, GraphNode } from "../../java-knowledge/schema.js";
import { prepareCached, withTransaction, type IndexDatabase } from "./driver.js";
import { asCount, decodeFacts } from "./facts-store.js";

function itemHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function xorBuffers(target: Buffer, item: Buffer): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index] = (target[index] ?? 0) ^ (item[index] ?? 0);
  }
}

function encodeFacts(value: unknown): string {
  return JSON.stringify(value);
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

function runInWriteTx<T>(db: IndexDatabase, fn: () => T): T {
  if (db.isTransaction) return fn();
  return withTransaction(db, fn);
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
    const row = prepareCached(this.db, "SELECT json(facts) AS facts FROM kg_summary WHERE method_id=?").get(methodId);
    return row ? decodeFacts<MethodSummary>(row.facts) : undefined;
  }

  set(methodId: string, summary: MethodSummary): this {
    prepareCached(
      this.db,
      "INSERT INTO kg_summary(method_id, facts) VALUES (?, jsonb(?)) ON CONFLICT(method_id) DO UPDATE SET facts=excluded.facts"
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
    runInWriteTx(this.db, () => {
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
         VALUES (?, ?, ?, ?, ?, jsonb(?))
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
      this.persistXor();
      this.persistGeneration();
    });
  }

  addEdge(edge: GraphEdge, ownerFile?: string): GraphEdge {
    return runInWriteTx(this.db, () => {
      const existing = prepareCached(this.db, "SELECT json(facts) AS facts FROM kg_edge WHERE json_extract(facts, '$.edgeId')=?").get(edge.edgeId);
      if (existing) {
        if (ownerFile) {
          prepareCached(
            this.db,
            "UPDATE kg_edge SET owner_file=COALESCE(owner_file, ?) WHERE json_extract(facts, '$.edgeId')=?"
          ).run(ownerFile, edge.edgeId);
        }
        return edgeFacts(existing);
      }
      prepareCached(
        this.db,
        "INSERT INTO kg_edge(from_id, to_id, kind, owner_file, facts) VALUES (?, ?, ?, ?, jsonb(?))"
      ).run(edge.fromId, edge.toId, edge.kind, ownerFile ?? null, encodeFacts(edge));
      xorBuffers(this.edgeXor, itemHash(`e:${edge.edgeId}`));
      this.persistXor();
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
    runInWriteTx(this.db, () => {
      const placeholders = relativePaths.map(() => "?").join(",");
      const edges = this.db.prepare(
        `SELECT json(facts) AS facts FROM kg_edge WHERE owner_file IN (${placeholders})`
      ).all(...relativePaths) as Array<{ facts: SQLOutputValue }>;
      for (const row of edges) {
        xorBuffers(this.edgeXor, itemHash(`e:${edgeFacts(row).edgeId}`));
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
      this.persistXor();
    });
  }

  successors(nodeId: string, kind?: EdgeKind): GraphEdge[] {
    const rows = kind === undefined
      ? prepareCached(this.db, "SELECT json(facts) AS facts FROM kg_edge WHERE from_id=? ORDER BY id").all(nodeId)
      : prepareCached(this.db, "SELECT json(facts) AS facts FROM kg_edge WHERE from_id=? AND kind=? ORDER BY id").all(nodeId, kind);
    return rows.map(edgeFacts);
  }

  predecessors(nodeId: string, kind?: EdgeKind): GraphEdge[] {
    const rows = kind === undefined
      ? prepareCached(this.db, "SELECT json(facts) AS facts FROM kg_edge WHERE to_id=? ORDER BY id").all(nodeId)
      : prepareCached(this.db, "SELECT json(facts) AS facts FROM kg_edge WHERE to_id=? AND kind=? ORDER BY id").all(nodeId, kind);
    return rows.map(edgeFacts);
  }

  nodesByPath(path: string): GraphNode[] {
    return prepareCached(this.db, "SELECT json(facts) AS facts FROM kg_node WHERE relative_path=? ORDER BY id")
      .all(path)
      .map(row => nodeFacts(row));
  }

  nodeIdForJavaIndexId(jid: string): string | undefined {
    const row = prepareCached(this.db, "SELECT id FROM kg_node WHERE java_index_id=?").get(jid) as { id?: string } | undefined;
    return typeof row?.id === "string" ? row.id : undefined;
  }

  clear(): void {
    runInWriteTx(this.db, () => {
      this.db.exec("DELETE FROM kg_summary; DELETE FROM kg_edge; DELETE FROM kg_node;");
      this.nodeXor.fill(0);
      this.edgeXor.fill(0);
      this.generation = 0;
      this.persistXor();
      this.persistGeneration();
    });
  }

  private nodeById(id: string): GraphNode | undefined {
    const row = prepareCached(this.db, "SELECT json(facts) AS facts FROM kg_node WHERE id=?").get(id);
    return row ? nodeFacts(row) : undefined;
  }

  private *nodeEntries(): IterableIterator<[string, GraphNode]> {
    const rows = prepareCached(this.db, "SELECT id, json(facts) AS facts FROM kg_node ORDER BY id").all();
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

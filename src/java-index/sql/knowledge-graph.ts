import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { REVERSE_EDGE_KIND, type EdgeKind } from "../../java-knowledge/edge-kinds.js";
import { knowledgeEdgeId } from "../../java-knowledge/entity-id.js";
import { graphEdgeOrdinal, type GraphFragment } from "../../java-knowledge/graph-fragment.js";
import type { KnowledgeGraphStore } from "../../java-knowledge/graph-reader.js";
import type { GraphEdge, GraphNode, NodeKind } from "../../java-knowledge/schema.js";
import { prepareCached, withTransaction, type IndexDatabase } from "./driver.js";
import { asCount } from "./facts-store.js";
import { internSym, internSymNullable, symId, symText } from "./sym.js";

const KG_NODE_SELECT = `SELECT n.generation AS generation, ns.text AS id, ks.text AS kind, ps.text AS relativePath,
  n.simple_name AS simpleName, js.text AS javaIndexId
  FROM kg_node n
  JOIN sym ns ON ns.id=n.sym
  JOIN sym ks ON ks.id=n.kind_sym
  LEFT JOIN sym ps ON ps.id=n.path_sym
  LEFT JOIN sym js ON js.id=n.jid_sym`;

const KG_EDGE_SELECT = `SELECT e.ordinal AS ordinal, e.generation AS generation,
  fs.text AS fromId, ts.text AS toId, ks.text AS kind
  FROM kg_edge e
  JOIN sym fs ON fs.id=e.from_sym
  JOIN sym ts ON ts.id=e.to_sym
  JOIN sym ks ON ks.id=e.kind_sym`;

function itemHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function xorBuffers(target: Buffer, item: Buffer): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index] = (target[index] ?? 0) ^ (item[index] ?? 0);
  }
}

function asInt(value: SQLOutputValue | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  throw new Error(`expected integer, got ${String(value)}`);
}

function readMeta(db: IndexDatabase, key: string): string | undefined {
  const row = prepareCached(db, "SELECT value FROM meta WHERE key=?").get(key) as { value?: unknown } | undefined;
  return typeof row?.value === "string" ? row.value : undefined;
}

function writeMeta(db: IndexDatabase, key: string, value: string): void {
  prepareCached(
    db,
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value"
  ).run(key, value);
}

function xorFromMeta(db: IndexDatabase, key: string): Buffer {
  const raw = readMeta(db, key);
  if (!raw || raw.length !== 64) return Buffer.alloc(32);
  const buf = Buffer.from(raw, "hex");
  return buf.length === 32 ? buf : Buffer.alloc(32);
}

function optionalText(value: SQLOutputValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function graphNodeFromRow(row: Record<string, SQLOutputValue>): GraphNode {
  const relativePath = optionalText(row.relativePath);
  const simpleName = optionalText(row.simpleName);
  const javaIndexId = optionalText(row.javaIndexId);
  return {
    id: String(row.id),
    kind: String(row.kind) as NodeKind,
    generation: asInt(row.generation),
    ...(relativePath ? { relativePath } : {}),
    ...(simpleName ? { simpleName } : {}),
    ...(javaIndexId ? { javaIndexId } : {})
  };
}

function graphEdgeFromRow(row: Record<string, SQLOutputValue>): GraphEdge {
  const kind = String(row.kind) as EdgeKind;
  const fromId = String(row.fromId);
  const toId = String(row.toId);
  return {
    edgeId: knowledgeEdgeId({ kind, fromId, toId, ordinal: asInt(row.ordinal) }),
    kind,
    fromId,
    toId,
    generation: asInt(row.generation)
  };
}

/**
 * Knowledge graph rows with relational ownership (schema v13): a node or edge
 * lives while at least one owner row names it. Owners are the Java files
 * whose build emitted the row; the repository root is the only ownerless row.
 * The digest is an XOR over row identities, maintained on insert/delete.
 */
export class SqlKnowledgeGraph implements KnowledgeGraphStore {
  generation = 0;
  readonly nodesById: {
    get(id: string): GraphNode | undefined;
    has(id: string): boolean;
    readonly size: number;
    entries(): IterableIterator<[string, GraphNode]>;
  };
  readonly edgesById: { readonly size: number };

  private readonly nodeXor: Buffer;
  private readonly edgeXor: Buffer;
  private outByNode: Map<string, GraphEdge[]> | undefined;
  private inByNode: Map<string, GraphEdge[]> | undefined;
  private nodeMap: Map<string, GraphNode> | undefined;

  constructor(private readonly db: IndexDatabase) {
    this.nodeXor = xorFromMeta(db, "graphNodeXor");
    this.edgeXor = xorFromMeta(db, "graphEdgeXor");
    this.generation = Number(readMeta(db, "kgGeneration") ?? "0") || 0;
    this.nodesById = {
      get: id => this.nodeById(id),
      has: id => this.nodeById(id) !== undefined,
      get size() {
        return asCount(prepareCached(db, "SELECT count(*) AS n FROM kg_node").get());
      },
      entries: () => this.nodeEntries()
    };
    this.edgesById = {
      get size() {
        return asCount(prepareCached(db, "SELECT count(*) AS n FROM kg_edge").get());
      }
    };
  }

  flushMeta(): void {
    writeMeta(this.db, "graphNodeXor", this.nodeXor.toString("hex"));
    writeMeta(this.db, "graphEdgeXor", this.edgeXor.toString("hex"));
    writeMeta(this.db, "kgGeneration", String(this.generation));
  }

  private invalidateAdj(): void {
    this.outByNode = undefined;
    this.inByNode = undefined;
    this.nodeMap = undefined;
  }

  private writeTx<T>(fn: () => T): T {
    this.invalidateAdj();
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

  /** Adds or updates one node; with an owner it also gains that owner (never loses one). */
  upsertNode(node: GraphNode, ownerFile?: string): void {
    this.writeTx(() => {
      const nodeSym = this.writeNode(node);
      if (ownerFile) this.ownNode(nodeSym, internSym(this.db, ownerFile));
    });
  }

  /** Adds one edge and its materialized reverse; an owner owns both, whether or not they already existed. */
  addEdge(edge: GraphEdge, ownerFile?: string): GraphEdge {
    this.writeTx(() => {
      const ownerSym = ownerFile ? internSym(this.db, ownerFile) : undefined;
      const ordinal = graphEdgeOrdinal(edge);
      this.attachEdge(edge.kind, edge.fromId, edge.toId, ordinal, edge.generation, ownerSym);
      const reverse = REVERSE_EDGE_KIND[edge.kind];
      if (reverse) this.attachEdge(reverse, edge.toId, edge.fromId, 0, edge.generation, ownerSym);
    });
    return edge;
  }

  replaceOwner(fragment: GraphFragment): void {
    this.writeTx(() => {
      const ownerSym = internSym(this.db, fragment.owner);
      const staleNodes = new Set(
        (prepareCached(this.db, "SELECT node_sym AS id FROM kg_node_owner WHERE owner_sym=?").all(ownerSym) as Array<{ id: SQLOutputValue }>)
          .map(row => asInt(row.id))
      );
      const staleEdges = new Set(
        (prepareCached(this.db, "SELECT edge_id AS id FROM kg_edge_owner WHERE owner_sym=?").all(ownerSym) as Array<{ id: SQLOutputValue }>)
          .map(row => asInt(row.id))
      );
      for (const node of fragment.nodes.values()) {
        const nodeSym = this.writeNode(node);
        if (!staleNodes.delete(nodeSym)) this.ownNode(nodeSym, ownerSym);
      }
      for (const edge of fragment.edges.values()) {
        const id = this.attachEdge(edge.kind, edge.fromId, edge.toId, edge.ordinal, edge.generation, undefined);
        if (!staleEdges.delete(id)) this.ownEdge(id, ownerSym);
      }
      this.releaseEdges(ownerSym, staleEdges);
      this.releaseNodes(ownerSym, staleNodes);
    });
  }

  removeFiles(relativePaths: readonly string[]): void {
    if (relativePaths.length === 0) return;
    this.writeTx(() => {
      for (const relativePath of new Set(relativePaths)) {
        const ownerSym = symId(this.db, relativePath);
        if (ownerSym === undefined) continue;
        const edges = (prepareCached(this.db, "SELECT edge_id AS id FROM kg_edge_owner WHERE owner_sym=?").all(ownerSym) as Array<{ id: SQLOutputValue }>)
          .map(row => asInt(row.id));
        const nodes = (prepareCached(this.db, "SELECT node_sym AS id FROM kg_node_owner WHERE owner_sym=?").all(ownerSym) as Array<{ id: SQLOutputValue }>)
          .map(row => asInt(row.id));
        this.releaseEdges(ownerSym, edges);
        this.releaseNodes(ownerSym, nodes);
      }
    });
  }

  prefetch(): void {
    this.ensureAdj();
  }

  successors(nodeId: string, kind?: EdgeKind): GraphEdge[] {
    if (!this.outByNode) return this.edgesFrom("from_sym", nodeId, kind);
    const edges = this.outByNode.get(nodeId) ?? [];
    return kind === undefined ? [...edges] : edges.filter(edge => edge.kind === kind);
  }

  predecessors(nodeId: string, kind?: EdgeKind): GraphEdge[] {
    if (!this.inByNode) return this.edgesFrom("to_sym", nodeId, kind);
    const edges = this.inByNode.get(nodeId) ?? [];
    return kind === undefined ? [...edges] : edges.filter(edge => edge.kind === kind);
  }

  nodesByPath(path: string): GraphNode[] {
    const pathSym = symId(this.db, path);
    if (pathSym === undefined) return [];
    return prepareCached(this.db, `${KG_NODE_SELECT} WHERE n.path_sym=? ORDER BY ns.text`)
      .all(pathSym)
      .map(row => graphNodeFromRow(row));
  }

  nodeIdForJavaIndexId(jid: string): string | undefined {
    const jidSym = symId(this.db, jid);
    if (jidSym === undefined) return undefined;
    const row = prepareCached(this.db, `${KG_NODE_SELECT} WHERE n.jid_sym=?`).get(jidSym);
    return row ? String(row.id) : undefined;
  }

  clear(): void {
    this.writeTx(() => {
      this.db.exec("DELETE FROM kg_edge_owner; DELETE FROM kg_node_owner; DELETE FROM kg_edge; DELETE FROM kg_node;");
      this.nodeXor.fill(0);
      this.edgeXor.fill(0);
      this.generation = 0;
    });
  }

  // Attributes are rewritten only when they differ: generation alone is not a
  // change, so a rebuilt but identical node costs a read, not a page write.
  private writeNode(node: GraphNode): number {
    const nodeSym = internSym(this.db, node.id);
    const kindSym = internSym(this.db, node.kind);
    const pathSym = internSymNullable(this.db, node.relativePath);
    const simpleName = node.simpleName ?? null;
    const jidSym = internSymNullable(this.db, node.javaIndexId);
    const existing = prepareCached(this.db, "SELECT kind_sym AS kindSym FROM kg_node WHERE sym=?").get(nodeSym) as
      | { kindSym: SQLOutputValue }
      | undefined;
    if (!existing) {
      xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
      prepareCached(
        this.db,
        "INSERT INTO kg_node(sym, kind_sym, path_sym, simple_name, jid_sym, generation) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(nodeSym, kindSym, pathSym, simpleName, jidSym, node.generation);
      return nodeSym;
    }
    const oldKind = asInt(existing.kindSym);
    if (oldKind !== kindSym) {
      xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${symText(this.db, oldKind)}`));
      xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
    }
    prepareCached(
      this.db,
      `UPDATE kg_node SET kind_sym=?, path_sym=?, simple_name=?, jid_sym=?, generation=?
       WHERE sym=? AND (kind_sym IS NOT ? OR path_sym IS NOT ? OR simple_name IS NOT ? OR jid_sym IS NOT ?)`
    ).run(kindSym, pathSym, simpleName, jidSym, node.generation, nodeSym, kindSym, pathSym, simpleName, jidSym);
    return nodeSym;
  }

  private ownNode(nodeSym: number, ownerSym: number): void {
    prepareCached(this.db, "INSERT OR IGNORE INTO kg_node_owner(node_sym, owner_sym) VALUES (?, ?)").run(nodeSym, ownerSym);
  }

  private ownEdge(edgeId: number, ownerSym: number): void {
    prepareCached(this.db, "INSERT OR IGNORE INTO kg_edge_owner(edge_id, owner_sym) VALUES (?, ?)").run(edgeId, ownerSym);
  }

  /** Finds or inserts the edge row (one per identity) and returns its id. */
  private attachEdge(kind: EdgeKind, fromId: string, toId: string, ordinal: number, generation: number, ownerSym: number | undefined): number {
    const fromSym = internSym(this.db, fromId);
    const kindSym = internSym(this.db, kind);
    const toSym = internSym(this.db, toId);
    const row = prepareCached(
      this.db,
      "SELECT id FROM kg_edge WHERE from_sym=? AND kind_sym=? AND to_sym=? AND ordinal=?"
    ).get(fromSym, kindSym, toSym, ordinal) as { id: SQLOutputValue } | undefined;
    let id: number;
    if (row) {
      id = asInt(row.id);
    } else {
      id = Number(prepareCached(
        this.db,
        "INSERT INTO kg_edge(from_sym, to_sym, kind_sym, ordinal, generation) VALUES (?, ?, ?, ?, ?)"
      ).run(fromSym, toSym, kindSym, ordinal, generation).lastInsertRowid);
      xorBuffers(this.edgeXor, itemHash(`e:${knowledgeEdgeId({ kind, fromId, toId, ordinal })}`));
    }
    if (ownerSym !== undefined) this.ownEdge(id, ownerSym);
    return id;
  }

  private releaseEdges(ownerSym: number, edgeIds: Iterable<number>): void {
    const release = prepareCached(this.db, "DELETE FROM kg_edge_owner WHERE edge_id=? AND owner_sym=?");
    const owned = prepareCached(this.db, "SELECT 1 AS ok FROM kg_edge_owner WHERE edge_id=? LIMIT 1");
    for (const id of edgeIds) {
      release.run(id, ownerSym);
      if (owned.get(id)) continue;
      const row = prepareCached(this.db, `${KG_EDGE_SELECT} WHERE e.id=?`).get(id);
      if (!row) continue;
      xorBuffers(this.edgeXor, itemHash(`e:${graphEdgeFromRow(row).edgeId}`));
      prepareCached(this.db, "DELETE FROM kg_edge WHERE id=?").run(id);
    }
  }

  private releaseNodes(ownerSym: number, nodeSyms: Iterable<number>): void {
    const release = prepareCached(this.db, "DELETE FROM kg_node_owner WHERE node_sym=? AND owner_sym=?");
    const owned = prepareCached(this.db, "SELECT 1 AS ok FROM kg_node_owner WHERE node_sym=? LIMIT 1");
    for (const nodeSym of nodeSyms) {
      release.run(nodeSym, ownerSym);
      if (owned.get(nodeSym)) continue;
      const row = prepareCached(this.db, `${KG_NODE_SELECT} WHERE n.sym=?`).get(nodeSym);
      if (!row) continue;
      const node = graphNodeFromRow(row);
      xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
      prepareCached(this.db, "DELETE FROM kg_node WHERE sym=?").run(nodeSym);
    }
  }

  private ensureAdj(): void {
    if (this.outByNode) return;
    const nodes = new Map<string, GraphNode>();
    for (const row of prepareCached(this.db, KG_NODE_SELECT).iterate()) {
      const node = graphNodeFromRow(row);
      nodes.set(node.id, node);
    }
    const out = new Map<string, GraphEdge[]>();
    const inn = new Map<string, GraphEdge[]>();
    for (const row of prepareCached(this.db, `${KG_EDGE_SELECT} ORDER BY e.id`).iterate()) {
      const edge = graphEdgeFromRow(row);
      const outs = out.get(edge.fromId);
      if (outs) outs.push(edge);
      else out.set(edge.fromId, [edge]);
      const ins = inn.get(edge.toId);
      if (ins) ins.push(edge);
      else inn.set(edge.toId, [edge]);
    }
    this.nodeMap = nodes;
    this.outByNode = out;
    this.inByNode = inn;
  }

  private edgesFrom(side: "from_sym" | "to_sym", nodeId: string, kind?: EdgeKind): GraphEdge[] {
    const nodeSym = symId(this.db, nodeId);
    if (nodeSym === undefined) return [];
    if (kind === undefined) {
      return prepareCached(this.db, `${KG_EDGE_SELECT} WHERE e.${side}=? ORDER BY e.id`)
        .all(nodeSym)
        .map(graphEdgeFromRow);
    }
    const kindSym = symId(this.db, kind);
    if (kindSym === undefined) return [];
    return prepareCached(this.db, `${KG_EDGE_SELECT} WHERE e.${side}=? AND e.kind_sym=? ORDER BY e.id`)
      .all(nodeSym, kindSym)
      .map(graphEdgeFromRow);
  }

  private nodeById(id: string): GraphNode | undefined {
    if (this.nodeMap) return this.nodeMap.get(id);
    const sym = symId(this.db, id);
    const row = sym === undefined ? undefined : prepareCached(this.db, `${KG_NODE_SELECT} WHERE n.sym=?`).get(sym);
    return row ? graphNodeFromRow(row) : undefined;
  }

  private *nodeEntries(): IterableIterator<[string, GraphNode]> {
    for (const row of prepareCached(this.db, `${KG_NODE_SELECT} ORDER BY ns.text`).iterate()) {
      const node = graphNodeFromRow(row);
      yield [node.id, node];
    }
  }
}

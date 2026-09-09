import { createHash } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import { REVERSE_EDGE_KIND, type EdgeKind } from "../../java-knowledge/edge-kinds.js";
import { knowledgeEdgeId } from "../../java-knowledge/entity-id.js";
import type { MethodSummary } from "../../java-knowledge/method-summary.js";
import type { GraphEdge, GraphNode, NodeKind } from "../../java-knowledge/schema.js";
import { bindChunks, inClause, prepareCached, withTransaction, type IndexDatabase } from "./driver.js";
import { asCount } from "./facts-store.js";
import { decodeFacts, encodeFacts } from "./rows.js";
import { internSym, internSymNullable, symId, symText } from "./sym.js";

const KG_NODE_SELECT = `SELECT n.generation AS generation, ns.text AS id, ks.text AS kind, ps.text AS relativePath,
  n.simple_name AS simpleName, js.text AS javaIndexId, os.text AS ownerFile
  FROM kg_node n
  JOIN sym ns ON ns.id=n.sym
  JOIN sym ks ON ks.id=n.kind_sym
  LEFT JOIN sym ps ON ps.id=n.path_sym
  LEFT JOIN sym js ON js.id=n.jid_sym
  LEFT JOIN sym os ON os.id=n.owner_sym`;

const KG_EDGE_SELECT = `SELECT e.id AS rowId, e.ordinal AS ordinal, e.generation AS generation,
  fs.text AS fromId, ts.text AS toId, ks.text AS kind, fl.text AS sourceFile, os.text AS ownerFile
  FROM kg_edge e
  JOIN sym fs ON fs.id=e.from_sym
  JOIN sym ts ON ts.id=e.to_sym
  JOIN sym ks ON ks.id=e.kind_sym
  LEFT JOIN sym fl ON fl.id=e.file_sym
  LEFT JOIN sym os ON os.id=e.owner_sym`;

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
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
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

function graphEdgeOrdinal(edge: GraphEdge): number {
  const prefix = `e:${edge.kind}:${edge.fromId}->${edge.toId}:`;
  if (edge.edgeId.startsWith(prefix)) {
    const parsed = Number(edge.edgeId.slice(prefix.length));
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

function graphEdgeFromRow(row: Record<string, SQLOutputValue>): GraphEdge {
  const kind = String(row.kind) as EdgeKind;
  const fromId = String(row.fromId);
  const toId = String(row.toId);
  const ordinal = asInt(row.ordinal);
  const sourceFile = optionalText(row.sourceFile);
  return {
    edgeId: knowledgeEdgeId({ kind, fromId, toId, ordinal }),
    kind,
    fromId,
    toId,
    generation: asInt(row.generation),
    ...(sourceFile ? { sourceFile } : {})
  };
}

function existingSyms(db: IndexDatabase, texts: Iterable<string>): number[] {
  const ids: number[] = [];
  for (const text of texts) {
    const id = symId(db, text);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

class SqlSummaryMap {
  constructor(private readonly db: IndexDatabase) {}

  get(methodId: string): MethodSummary | undefined {
    const methodSym = symId(this.db, methodId);
    if (methodSym === undefined) return undefined;
    const row = prepareCached(this.db, "SELECT facts FROM kg_summary WHERE method_sym=?").get(methodSym);
    return row ? decodeFacts<MethodSummary>(row.facts) : undefined;
  }

  set(methodId: string, summary: MethodSummary): this {
    prepareCached(
      this.db,
      "INSERT INTO kg_summary(method_sym, facts) VALUES (?, ?) ON CONFLICT(method_sym) DO UPDATE SET facts=excluded.facts"
    ).run(internSym(this.db, methodId), encodeFacts(summary));
    return this;
  }

  delete(methodId: string): boolean {
    const methodSym = internSym(this.db, methodId);
    const result = prepareCached(this.db, "DELETE FROM kg_summary WHERE method_sym=?").run(methodSym);
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
  private readonly extraEdgeOwners = new Map<string, Set<string>>();
  private readonly extraNodeOwners = new Map<string, Set<string>>();
  private outByNode: Map<string, GraphEdge[]> | undefined;
  private inByNode: Map<string, GraphEdge[]> | undefined;
  private nodeMap: Map<string, GraphNode> | undefined;

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
    this.loadExtraOwners();
  }

  flushMeta(): void {
    this.persistXor();
    this.persistGeneration();
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

  upsertNode(node: GraphNode, ownerFile?: string): void {
    this.writeTx(() => {
      const existing = prepareCached(this.db, `${KG_NODE_SELECT} WHERE ns.text=?`).get(node.id) as
        | Record<string, SQLOutputValue>
        | undefined;
      if (!existing) {
        xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
      } else if (String(existing.kind) !== node.kind) {
        xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${String(existing.kind)}`));
        xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
      }
      prepareCached(
        this.db,
        `INSERT INTO kg_node(sym, kind_sym, path_sym, simple_name, jid_sym, owner_sym, generation)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sym) DO UPDATE SET
           kind_sym=excluded.kind_sym,
           path_sym=excluded.path_sym,
           simple_name=excluded.simple_name,
           jid_sym=excluded.jid_sym,
           owner_sym=COALESCE(kg_node.owner_sym, excluded.owner_sym),
           generation=excluded.generation`
      ).run(
        internSym(this.db, node.id),
        internSym(this.db, node.kind),
        internSymNullable(this.db, node.relativePath),
        node.simpleName ?? null,
        internSymNullable(this.db, node.javaIndexId),
        internSymNullable(this.db, ownerFile),
        node.generation
      );
      if (ownerFile) this.addExtraOwner(this.extraNodeOwners, node.id, ownerFile, existing !== undefined);
    });
  }

  addEdge(edge: GraphEdge, ownerFile?: string): GraphEdge {
    return this.writeTx(() => {
      if (this.findStoredEdge(edge)) {
        if (ownerFile) {
          this.addExtraOwner(this.extraEdgeOwners, edge.edgeId, ownerFile, true);
          const ownerSym = internSym(this.db, ownerFile);
          const fromSym = internSym(this.db, edge.fromId);
          const toSym = internSym(this.db, edge.toId);
          const kindSym = internSym(this.db, edge.kind);
          const ordinal = graphEdgeOrdinal(edge);
          prepareCached(
            this.db,
            `UPDATE kg_edge SET owner_sym=COALESCE(owner_sym, ?)
             WHERE from_sym=? AND to_sym=? AND kind_sym=? AND ordinal=?`
          ).run(ownerSym, fromSym, toSym, kindSym, ordinal);
        }
        return edge;
      }
      prepareCached(
        this.db,
        `INSERT INTO kg_edge(from_sym, to_sym, kind_sym, ordinal, file_sym, owner_sym, generation)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        internSym(this.db, edge.fromId),
        internSym(this.db, edge.toId),
        internSym(this.db, edge.kind),
        graphEdgeOrdinal(edge),
        internSymNullable(this.db, edge.sourceFile),
        internSymNullable(this.db, ownerFile),
        edge.generation
      );
      xorBuffers(this.edgeXor, itemHash(`e:${edge.edgeId}`));
      if (ownerFile) this.extraEdgeOwners.delete(edge.edgeId);
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
      const removed = new Set(relativePaths);
      this.dropOwnedEdges(removed);
      this.dropOwnedNodes(removed);
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
      this.db.exec("DELETE FROM kg_summary; DELETE FROM kg_edge; DELETE FROM kg_node;");
      this.nodeXor.fill(0);
      this.edgeXor.fill(0);
      this.generation = 0;
      this.extraEdgeOwners.clear();
      this.extraNodeOwners.clear();
    });
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
    const row = prepareCached(this.db, `${KG_NODE_SELECT} WHERE ns.text=?`).get(id);
    return row ? graphNodeFromRow(row) : undefined;
  }

  private *nodeEntries(): IterableIterator<[string, GraphNode]> {
    for (const row of prepareCached(this.db, `${KG_NODE_SELECT} ORDER BY ns.text`).iterate()) {
      const node = graphNodeFromRow(row);
      yield [node.id, node];
    }
  }

  private persistXor(): void {
    writeMeta(this.db, "graphNodeXor", this.nodeXor.toString("hex"));
    writeMeta(this.db, "graphEdgeXor", this.edgeXor.toString("hex"));
    writeMeta(this.db, "graphExtraEdgeOwners", serializeOwnerMap(this.extraEdgeOwners));
    writeMeta(this.db, "graphExtraNodeOwners", serializeOwnerMap(this.extraNodeOwners));
  }

  private persistGeneration(): void {
    writeMeta(this.db, "kgGeneration", String(this.generation));
  }

  private loadExtraOwners(): void {
    loadOwnerMap(readMeta(this.db, "graphExtraEdgeOwners"), this.extraEdgeOwners);
    loadOwnerMap(readMeta(this.db, "graphExtraNodeOwners"), this.extraNodeOwners);
  }

  private findStoredEdge(edge: GraphEdge): boolean {
    const fromSym = internSym(this.db, edge.fromId);
    const toSym = internSym(this.db, edge.toId);
    const kindSym = internSym(this.db, edge.kind);
    const row = prepareCached(
      this.db,
      "SELECT 1 AS ok FROM kg_edge WHERE from_sym=? AND to_sym=? AND kind_sym=? AND ordinal=?"
    ).get(fromSym, toSym, kindSym, graphEdgeOrdinal(edge));
    return row !== undefined;
  }

  private addExtraOwner(
    map: Map<string, Set<string>>,
    id: string,
    ownerFile: string,
    existed: boolean
  ): void {
    if (!existed) return;
    const extra = map.get(id) ?? new Set<string>();
    extra.add(ownerFile);
    if (extra.size > 0) map.set(id, extra);
  }

  private dropOwnedEdges(removed: ReadonlySet<string>): void {
    const ownerSyms = existingSyms(this.db, removed);
    if (ownerSyms.length === 0) {
      this.pruneExtraOwners(this.extraEdgeOwners, removed);
      return;
    }
    const primary: Array<Record<string, SQLOutputValue>> = [];
    for (const chunk of bindChunks(ownerSyms)) {
      primary.push(
        ...prepareCached(this.db, `${KG_EDGE_SELECT} WHERE e.owner_sym IN ${inClause(chunk.length)}`).all(...chunk)
      );
    }
    for (const row of primary) {
      const edge = graphEdgeFromRow(row);
      const ownerFile = optionalText(row.ownerFile) ?? "";
      const extra = this.extraEdgeOwners.get(edge.edgeId);
      extra?.delete(ownerFile);
      for (const path of removed) extra?.delete(path);
      if (extra && extra.size > 0) {
        const next = [...extra][0]!;
        extra.delete(next);
        if (extra.size === 0) this.extraEdgeOwners.delete(edge.edgeId);
        prepareCached(this.db, "UPDATE kg_edge SET owner_sym=? WHERE id=?").run(internSym(this.db, next), asInt(row.rowId));
        continue;
      }
      this.extraEdgeOwners.delete(edge.edgeId);
      xorBuffers(this.edgeXor, itemHash(`e:${edge.edgeId}`));
      prepareCached(this.db, "DELETE FROM kg_edge WHERE id=?").run(asInt(row.rowId));
    }
    this.pruneExtraOwners(this.extraEdgeOwners, removed);
  }

  private dropOwnedNodes(removed: ReadonlySet<string>): void {
    const ownerSyms = existingSyms(this.db, removed);
    if (ownerSyms.length === 0) {
      this.pruneExtraOwners(this.extraNodeOwners, removed);
      return;
    }
    const primary: Array<Record<string, SQLOutputValue>> = [];
    for (const chunk of bindChunks(ownerSyms)) {
      primary.push(
        ...prepareCached(this.db, `${KG_NODE_SELECT} WHERE n.owner_sym IN ${inClause(chunk.length)}`).all(...chunk)
      );
    }
    for (const row of primary) {
      const node = graphNodeFromRow(row);
      const ownerFile = optionalText(row.ownerFile) ?? "";
      const extra = this.extraNodeOwners.get(node.id);
      extra?.delete(ownerFile);
      for (const path of removed) extra?.delete(path);
      if (extra && extra.size > 0) {
        const next = [...extra][0]!;
        extra.delete(next);
        if (extra.size === 0) this.extraNodeOwners.delete(node.id);
        prepareCached(this.db, "UPDATE kg_node SET owner_sym=? WHERE sym=?").run(
          internSym(this.db, next),
          internSym(this.db, node.id)
        );
        continue;
      }
      this.extraNodeOwners.delete(node.id);
      xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
      const methodSym = internSym(this.db, node.id);
      prepareCached(this.db, "DELETE FROM kg_summary WHERE method_sym=?").run(methodSym);
      prepareCached(this.db, "DELETE FROM kg_node WHERE sym=?").run(methodSym);
    }
    this.pruneExtraOwners(this.extraNodeOwners, removed);
  }

  private pruneExtraOwners(map: Map<string, Set<string>>, removed: ReadonlySet<string>): void {
    for (const [id, extra] of [...map]) {
      let changed = false;
      for (const path of removed) {
        if (extra.delete(path)) changed = true;
      }
      if (!changed) continue;
      if (extra.size === 0) map.delete(id);
    }
  }
}

function serializeOwnerMap(map: Map<string, Set<string>>): string {
  const value: Record<string, string[]> = {};
  for (const [id, owners] of map) {
    if (owners.size > 0) value[id] = [...owners];
  }
  return JSON.stringify(value);
}

function loadOwnerMap(raw: string | undefined, target: Map<string, Set<string>>): void {
  target.clear();
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return;
    for (const [id, owners] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(owners)) continue;
      const set = new Set(owners.filter((item): item is string => typeof item === "string"));
      if (set.size > 0) target.set(id, set);
    }
  } catch {
    // ignore corrupt meta; cold build will clear
  }
}

// input: Graph nodes/edges plus owning source file.
// output: Columnar in-memory graph with reverse adjacency and an incremental digest.
// pos: N1 store, M6-2 columns. Incremental replaceFile drops that file's contribution
// before rebuild. Shared hierarchy rows are refcounted so one file's removal cannot
// drop MODULE/SOURCE_ROOT rows still required by a sibling file.
import { createHash } from "node:crypto";
import { StringTable } from "../java-index/columnar/string-table.js";
import { REVERSE_EDGE_KIND, type EdgeKind } from "./edge-kinds.js";
import { knowledgeEdgeId } from "./entity-id.js";
import { GraphEdgeColumns, GraphNodeColumns, GraphRecordMap } from "./graph-columns.js";
import type { MethodSummary } from "./method-summary.js";
import type { GraphEdge, GraphNode } from "./schema.js";

function addToSetMap(map: Map<string, Set<number>>, key: string, value: number): void {
  const bucket = map.get(key);
  if (bucket) bucket.add(value);
  else map.set(key, new Set([value]));
}

function pushAdj(map: Map<string, number[]>, nodeId: string, edgeRow: number): void {
  const bucket = map.get(nodeId);
  if (bucket) bucket.push(edgeRow);
  else map.set(nodeId, [edgeRow]);
}

function removeFromNumList(map: Map<string, number[]>, key: string, value: number): void {
  const bucket = map.get(key);
  if (!bucket) return;
  const index = bucket.indexOf(value);
  if (index < 0) return;
  bucket.splice(index, 1);
  if (bucket.length === 0) map.delete(key);
}

function itemHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function xorBuffers(target: Buffer, item: Buffer): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index] = (target[index] ?? 0) ^ (item[index] ?? 0);
  }
}

export class KnowledgeGraphStore {
  readonly strings = new StringTable();
  private readonly nodes = new GraphNodeColumns(this.strings);
  private readonly edges = new GraphEdgeColumns(this.strings);
  readonly nodesById = new GraphRecordMap<GraphNode>({
    size: () => this.nodes.size,
    get: id => {
      const row = this.nodes.rowOf(id);
      return row === undefined ? undefined : this.nodes.materialize(row);
    },
    has: id => this.nodes.has(id),
    ids: () => this.nodes.ids(),
    entries: () => this.nodes.entries()
  });
  readonly edgesById = new GraphRecordMap<GraphEdge>({
    size: () => this.edges.size,
    get: id => {
      const row = this.edges.rowOf(id);
      return row === undefined ? undefined : this.edges.materialize(row);
    },
    has: id => this.edges.has(id),
    ids: () => this.edges.ids(),
    entries: () => this.edges.entries()
  });
  readonly summariesByMethodId = new Map<string, MethodSummary>();
  generation = 0;

  estimatedBytes(): number {
    return this.nodes.size * 192 + this.edges.size * 96 + this.summariesByMethodId.size * 64;
  }

  private readonly outEdgeRowsByNode = new Map<string, number[]>();
  private readonly inEdgeRowsByNode = new Map<string, number[]>();
  private readonly nodeRowsByFile = new Map<string, Set<number>>();
  private readonly edgeRowsByFile = new Map<string, Set<number>>();
  private readonly nodeXor = Buffer.alloc(32);
  private readonly edgeXor = Buffer.alloc(32);
  private digestCache: string | undefined;

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.strings.clear();
    this.outEdgeRowsByNode.clear();
    this.inEdgeRowsByNode.clear();
    this.nodeRowsByFile.clear();
    this.edgeRowsByFile.clear();
    this.summariesByMethodId.clear();
    this.nodeXor.fill(0);
    this.edgeXor.fill(0);
    this.digestCache = undefined;
  }

  digest(): string {
    if (this.digestCache) return this.digestCache;
    this.digestCache = createHash("sha256")
      .update(this.nodeXor)
      .update(`:${this.nodes.size}:`)
      .update(this.edgeXor)
      .update(`:${this.edges.size}`)
      .digest("hex");
    return this.digestCache;
  }

  upsertNode(node: GraphNode, ownerFile?: string): void {
    const existingRow = this.nodes.rowOf(node.id);
    if (existingRow === undefined) {
      xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
      this.digestCache = undefined;
    } else {
      const existingKind = this.nodes.kindAt(existingRow);
      if (existingKind !== node.kind) {
        xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${existingKind}`));
        xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
        this.digestCache = undefined;
      }
    }
    const row = this.nodes.upsert(node);
    if (ownerFile) {
      this.nodes.addOwner(row, ownerFile);
      addToSetMap(this.nodeRowsByFile, ownerFile, row);
    }
  }

  addEdge(edge: GraphEdge, ownerFile?: string): GraphEdge {
    const added = this.edges.add(edge);
    if (!added.created) {
      if (ownerFile) {
        this.edges.addOwner(added.row, ownerFile);
        addToSetMap(this.edgeRowsByFile, ownerFile, added.row);
      }
      return this.edges.materialize(added.row);
    }
    pushAdj(this.outEdgeRowsByNode, this.strings.interned(edge.fromId), added.row);
    pushAdj(this.inEdgeRowsByNode, this.strings.interned(edge.toId), added.row);
    xorBuffers(this.edgeXor, itemHash(`e:${edge.edgeId}`));
    this.digestCache = undefined;
    if (ownerFile) {
      this.edges.addOwner(added.row, ownerFile);
      addToSetMap(this.edgeRowsByFile, ownerFile, added.row);
    }
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
    return this.edges.materialize(added.row);
  }

  removeFiles(relativePaths: readonly string[]): void {
    for (const relativePath of relativePaths) {
      for (const edgeRow of [...(this.edgeRowsByFile.get(relativePath) ?? [])]) {
        if (!this.edges.removeOwner(edgeRow, relativePath)) {
          this.removeEdgeRow(edgeRow);
        }
      }
      this.edgeRowsByFile.delete(relativePath);
      for (const nodeRow of [...(this.nodeRowsByFile.get(relativePath) ?? [])]) {
        if (!this.nodes.removeOwner(nodeRow, relativePath)) {
          this.summariesByMethodId.delete(this.nodes.idAt(nodeRow));
          this.removeNodeRow(nodeRow);
        }
      }
      this.nodeRowsByFile.delete(relativePath);
    }
  }

  successors(nodeId: string, kind?: EdgeKind): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const edgeRow of this.outEdgeRowsByNode.get(nodeId) ?? []) {
      if (kind !== undefined && this.edges.kindAt(edgeRow) !== kind) continue;
      edges.push(this.edges.materialize(edgeRow));
    }
    return edges;
  }

  predecessors(nodeId: string, kind?: EdgeKind): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const edgeRow of this.inEdgeRowsByNode.get(nodeId) ?? []) {
      if (kind !== undefined && this.edges.kindAt(edgeRow) !== kind) continue;
      edges.push(this.edges.materialize(edgeRow));
    }
    return edges;
  }

  nodesByPath(path: string): GraphNode[] {
    const nodes: GraphNode[] = [];
    for (const node of this.nodesById.values()) {
      if (node.relativePath === path) nodes.push(node);
    }
    return nodes;
  }

  nodeIdForJavaIndexId(jid: string): string | undefined {
    for (const node of this.nodesById.values()) {
      if (node.javaIndexId === jid) return node.id;
    }
    return undefined;
  }

  private removeNodeRow(row: number): void {
    const node = this.nodes.remove(this.nodes.idAt(row));
    if (!node) return;
    xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
    this.digestCache = undefined;
    this.outEdgeRowsByNode.delete(node.id);
    this.inEdgeRowsByNode.delete(node.id);
  }

  private removeEdgeRow(row: number): void {
    const fromId = this.edges.fromIdAt(row);
    const toId = this.edges.toIdAt(row);
    const edge = this.edges.remove(this.edges.idAt(row));
    if (!edge) return;
    xorBuffers(this.edgeXor, itemHash(`e:${edge.edgeId}`));
    this.digestCache = undefined;
    removeFromNumList(this.outEdgeRowsByNode, fromId, row);
    removeFromNumList(this.inEdgeRowsByNode, toId, row);
  }
}

// input: Graph nodes/edges plus owning source file.
// output: In-memory graph with reverse adjacency and an incremental digest.
// pos: N1 store. Incremental replaceFile drops that file's contribution before rebuild.
// Shared hierarchy nodes/edges are refcounted so one file's removal cannot
// drop MODULE/SOURCE_ROOT rows still required by a sibling file.
import { createHash } from "node:crypto";
import { REVERSE_EDGE_KIND, type EdgeKind } from "./edge-kinds.js";
import { knowledgeEdgeId } from "./entity-id.js";
import type { GraphEdge, GraphNode } from "./schema.js";

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket) bucket.add(value);
  else map.set(key, new Set([value]));
}

function removeFromSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const bucket = map.get(key);
  if (!bucket) return;
  bucket.delete(value);
  if (bucket.size === 0) map.delete(key);
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
  readonly nodesById = new Map<string, GraphNode>();
  readonly edgesById = new Map<string, GraphEdge>();
  readonly outEdgeIdsByNode = new Map<string, Set<string>>();
  readonly inEdgeIdsByNode = new Map<string, Set<string>>();
  readonly nodeIdsByFile = new Map<string, Set<string>>();
  readonly edgeIdsByFile = new Map<string, Set<string>>();
  generation = 0;

  private readonly ownersByNodeId = new Map<string, Set<string>>();
  private readonly ownersByEdgeId = new Map<string, Set<string>>();
  private readonly nodeXor = Buffer.alloc(32);
  private readonly edgeXor = Buffer.alloc(32);
  private digestCache: string | undefined;

  clear(): void {
    this.nodesById.clear();
    this.edgesById.clear();
    this.outEdgeIdsByNode.clear();
    this.inEdgeIdsByNode.clear();
    this.nodeIdsByFile.clear();
    this.edgeIdsByFile.clear();
    this.ownersByNodeId.clear();
    this.ownersByEdgeId.clear();
    this.nodeXor.fill(0);
    this.edgeXor.fill(0);
    this.digestCache = undefined;
  }

  digest(): string {
    if (this.digestCache) return this.digestCache;
    this.digestCache = createHash("sha256")
      .update(this.nodeXor)
      .update(`:${this.nodesById.size}:`)
      .update(this.edgeXor)
      .update(`:${this.edgesById.size}`)
      .digest("hex");
    return this.digestCache;
  }

  upsertNode(node: GraphNode, ownerFile?: string): void {
    const existing = this.nodesById.get(node.id);
    if (!existing) {
      xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
      this.digestCache = undefined;
    } else if (existing.kind !== node.kind) {
      xorBuffers(this.nodeXor, itemHash(`n:${existing.id}:${existing.kind}`));
      xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
      this.digestCache = undefined;
    }
    this.nodesById.set(node.id, node);
    if (ownerFile) {
      addToSetMap(this.nodeIdsByFile, ownerFile, node.id);
      addToSetMap(this.ownersByNodeId, node.id, ownerFile);
    }
  }

  addEdge(edge: GraphEdge, ownerFile?: string): GraphEdge {
    const existing = this.edgesById.get(edge.edgeId);
    if (existing) {
      if (ownerFile) {
        addToSetMap(this.edgeIdsByFile, ownerFile, existing.edgeId);
        addToSetMap(this.ownersByEdgeId, existing.edgeId, ownerFile);
      }
      return existing;
    }
    this.edgesById.set(edge.edgeId, edge);
    addToSetMap(this.outEdgeIdsByNode, edge.fromId, edge.edgeId);
    addToSetMap(this.inEdgeIdsByNode, edge.toId, edge.edgeId);
    xorBuffers(this.edgeXor, itemHash(`e:${edge.edgeId}`));
    this.digestCache = undefined;
    if (ownerFile) {
      addToSetMap(this.edgeIdsByFile, ownerFile, edge.edgeId);
      addToSetMap(this.ownersByEdgeId, edge.edgeId, ownerFile);
    }
    const reverseKind = REVERSE_EDGE_KIND[edge.kind];
    if (reverseKind) {
      const reverse: GraphEdge = {
        edgeId: knowledgeEdgeId({ kind: reverseKind, fromId: edge.toId, toId: edge.fromId, ordinal: 0 }),
        kind: reverseKind,
        fromId: edge.toId,
        toId: edge.fromId,
        sourceFile: edge.sourceFile,
        generation: edge.generation
      };
      this.addEdge(reverse, ownerFile);
    }
    return edge;
  }

  removeFiles(relativePaths: readonly string[]): void {
    for (const relativePath of relativePaths) {
      for (const edgeId of [...(this.edgeIdsByFile.get(relativePath) ?? [])]) {
        const owners = this.ownersByEdgeId.get(edgeId);
        owners?.delete(relativePath);
        if (!owners || owners.size === 0) {
          this.removeEdge(edgeId);
          this.ownersByEdgeId.delete(edgeId);
        }
      }
      this.edgeIdsByFile.delete(relativePath);
      for (const nodeId of [...(this.nodeIdsByFile.get(relativePath) ?? [])]) {
        const owners = this.ownersByNodeId.get(nodeId);
        owners?.delete(relativePath);
        if (!owners || owners.size === 0) {
          this.removeNode(nodeId);
          this.ownersByNodeId.delete(nodeId);
        }
      }
      this.nodeIdsByFile.delete(relativePath);
    }
  }

  private removeNode(nodeId: string): void {
    const node = this.nodesById.get(nodeId);
    if (!node) return;
    xorBuffers(this.nodeXor, itemHash(`n:${node.id}:${node.kind}`));
    this.digestCache = undefined;
    this.nodesById.delete(nodeId);
  }

  private removeEdge(edgeId: string): void {
    const edge = this.edgesById.get(edgeId);
    if (!edge) return;
    xorBuffers(this.edgeXor, itemHash(`e:${edge.edgeId}`));
    this.digestCache = undefined;
    this.edgesById.delete(edgeId);
    removeFromSetMap(this.outEdgeIdsByNode, edge.fromId, edgeId);
    removeFromSetMap(this.inEdgeIdsByNode, edge.toId, edgeId);
  }

  successors(nodeId: string, kind?: EdgeKind): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const id of this.outEdgeIdsByNode.get(nodeId) ?? []) {
      const item = this.edgesById.get(id);
      if (item && (kind === undefined || item.kind === kind)) edges.push(item);
    }
    return edges;
  }

  predecessors(nodeId: string, kind?: EdgeKind): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const id of this.inEdgeIdsByNode.get(nodeId) ?? []) {
      const item = this.edgesById.get(id);
      if (item && (kind === undefined || item.kind === kind)) edges.push(item);
    }
    return edges;
  }
}

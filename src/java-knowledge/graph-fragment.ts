// input: the nodes and edges one Java file's graph build emits.
// output: that file's complete owned row set, reverse edges included.
// pos: MAC-05. The store applies a fragment as a set difference against the
//      rows the file already owns, so an edit that changes no graph fact
//      writes no graph row, and file order cannot decide ownership.
import { REVERSE_EDGE_KIND, type EdgeKind } from "./edge-kinds.js";
import { knowledgeEdgeId } from "./entity-id.js";
import type { GraphEdge, GraphNode } from "./schema.js";

export type GraphSink = {
  upsertNode(node: GraphNode, ownerFile?: string): void;
  addEdge(edge: GraphEdge, ownerFile?: string): GraphEdge;
};

export type FragmentEdge = { edgeId: string; kind: EdgeKind; fromId: string; toId: string; ordinal: number; generation: number };

/** The ordinal an edge id carries (`e:KIND:from->to:N`); ids of another shape are ordinal 0. */
export function graphEdgeOrdinal(edge: Pick<GraphEdge, "edgeId" | "kind" | "fromId" | "toId">): number {
  const prefix = `e:${edge.kind}:${edge.fromId}->${edge.toId}:`;
  if (edge.edgeId.startsWith(prefix)) {
    const parsed = Number(edge.edgeId.slice(prefix.length));
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

export class GraphFragment implements GraphSink {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, FragmentEdge>();

  constructor(readonly owner: string) {}

  upsertNode(node: GraphNode, ownerFile?: string): void {
    this.ownedBy(ownerFile);
    this.nodes.set(node.id, node);
  }

  addEdge(edge: GraphEdge, ownerFile?: string): GraphEdge {
    this.ownedBy(ownerFile);
    this.put(edge.kind, edge.fromId, edge.toId, graphEdgeOrdinal(edge), edge.generation);
    const reverse = REVERSE_EDGE_KIND[edge.kind];
    if (reverse) this.put(reverse, edge.toId, edge.fromId, 0, edge.generation);
    return edge;
  }

  private put(kind: EdgeKind, fromId: string, toId: string, ordinal: number, generation: number): void {
    const edgeId = knowledgeEdgeId({ kind, fromId, toId, ordinal });
    if (!this.edges.has(edgeId)) this.edges.set(edgeId, { edgeId, kind, fromId, toId, ordinal, generation });
  }

  // Every row a file's build emits is owned by that file; a row attributed to
  // another path would survive that file's removal.
  private ownedBy(ownerFile: string | undefined): void {
    if (ownerFile !== undefined && ownerFile !== this.owner) {
      throw new Error(`graph row owned by ${ownerFile} emitted by the build of ${this.owner}`);
    }
  }
}

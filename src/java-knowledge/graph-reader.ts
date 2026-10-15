import type { EdgeKind } from "./edge-kinds.js";
import type { GraphFragment, GraphSink } from "./graph-fragment.js";
import type { GraphEdge, GraphNode } from "./schema.js";

export type GraphNodeLookup = {
  get(id: string): GraphNode | undefined;
  has(id: string): boolean;
  readonly size: number;
  entries(): Iterable<[string, GraphNode]>;
};

export type GraphReader = {
  readonly nodesById: GraphNodeLookup;
  readonly edgesById: { readonly size: number };
  successors(id: string, kind?: EdgeKind): GraphEdge[];
  predecessors(id: string, kind?: EdgeKind): GraphEdge[];
  generation: number;
  digest(): string;
  nodesByPath(path: string): GraphNode[];
  nodeIdForJavaIndexId(jid: string): string | undefined;
};

export type KnowledgeGraphStore = GraphReader & GraphSink & {
  /** Makes the owner's rows exactly the fragment's: adds what is missing, releases the rest. */
  replaceOwner(fragment: GraphFragment): void;
  removeFiles(relativePaths: readonly string[]): void;
  clear(): void;
};

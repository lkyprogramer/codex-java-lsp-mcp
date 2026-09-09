import type { EdgeKind } from "./edge-kinds.js";
import type { MethodSummary } from "./method-summary.js";
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
  readonly summariesByMethodId: { get(id: string): MethodSummary | undefined };
  generation: number;
  digest(): string;
  nodesByPath(path: string): GraphNode[];
  nodeIdForJavaIndexId(jid: string): string | undefined;
};

export type KnowledgeGraphStore = Omit<GraphReader, "summariesByMethodId"> & {
  upsertNode(node: GraphNode, ownerFile?: string): void;
  addEdge(edge: GraphEdge, ownerFile?: string): GraphEdge;
  removeFiles(relativePaths: readonly string[]): void;
  clear(): void;
  summariesByMethodId: {
    get(id: string): MethodSummary | undefined;
    set(id: string, summary: MethodSummary): unknown;
  };
};

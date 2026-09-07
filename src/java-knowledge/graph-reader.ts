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

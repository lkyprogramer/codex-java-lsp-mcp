// input: JIN §7.1 node inventory plus edge kinds.
// output: Graph node/edge records. Statement kind is reserved; N1 does not materialize ordinary statements.
// pos: N1 knowledge-graph schema. Compact snapshot packing lives in graph-snapshot.ts.
import type { EdgeKind } from "./edge-kinds.js";

export const NODE_KINDS = [
  "REPOSITORY",
  "MODULE",
  "SOURCE_ROOT",
  "FILE",
  "TYPE",
  "METHOD",
  "CONSTRUCTOR",
  "FIELD",
  "PARAMETER",
  "LOCAL",
  "STATEMENT",
  "JAVA_RESOURCE",
  "MYBATIS_NAMESPACE",
  "MYBATIS_STATEMENT",
  "JPA_ENTITY",
  "CONFIG_KEY",
  "TEST_CASE"
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const KNOWLEDGE_GRAPH_SCHEMA_VERSION = 1 as const;

export type GraphNode = {
  id: string;
  kind: NodeKind;
  relativePath?: string;
  simpleName?: string;
  javaIndexId?: string;
  generation: number;
};

export type GraphEdge = {
  edgeId: string;
  kind: EdgeKind;
  fromId: string;
  toId: string;
  sourceFile?: string;
  generation: number;
};

export function isNodeKind(value: string): value is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(value);
}

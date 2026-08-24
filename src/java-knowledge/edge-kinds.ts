// input: JIN §7.2 edge-kind inventory.
// output: Frozen kind unions and reverse-index pairing.
// pos: N1 schema. Call/dataflow/framework kinds exist for completeness; N1 store only writes structural kinds.

export const STRUCTURAL_EDGE_KINDS = [
  "CONTAINS",
  "DECLARES",
  "EXTENDS",
  "IMPLEMENTS",
  "PERMITS",
  "IMPORTS",
  "ANNOTATED_WITH",
  "MODULE_DEPENDS_ON"
] as const;

export const CALL_EDGE_KINDS = [
  "CALLS_EXACT",
  "CALLS_VIRTUAL",
  "DISPATCHES_TO",
  "CONSTRUCTS",
  "METHOD_REFERENCE",
  "CALLED_BY"
] as const;

export const DATAFLOW_EDGE_KINDS = [
  "READS_FIELD",
  "WRITES_FIELD",
  "DEFINES_LOCAL",
  "USES_LOCAL",
  "ARGUMENT_FLOWS_TO",
  "PARAMETER_FLOWS_TO_RETURN",
  "CALL_RESULT_ASSIGNED_TO",
  "CALL_RESULT_RETURNED_BY",
  "THROWS_TO"
] as const;

export const FRAMEWORK_EDGE_KINDS = [
  "SPRING_INJECTS",
  "SPRING_BEAN_BINDS_TO",
  "PUBLISHES_EVENT",
  "CONSUMES_EVENT",
  "MAPSTRUCT_SOURCE_TO_TARGET",
  "MAPSTRUCT_USES",
  "MYBATIS_METHOD_BINDS_STATEMENT",
  "MYBATIS_STATEMENT_USES_ENTITY",
  "REPOSITORY_MANAGES_ENTITY",
  "JPA_RELATION",
  "SQL_TOUCHES_TABLE"
] as const;

export const TEST_EDGE_KINDS = [
  "TESTS_TYPE",
  "TESTS_METHOD",
  "MOCKS_TYPE",
  "USES_FIXTURE"
] as const;

export const ALL_EDGE_KINDS = [
  ...STRUCTURAL_EDGE_KINDS,
  ...CALL_EDGE_KINDS,
  ...DATAFLOW_EDGE_KINDS,
  ...FRAMEWORK_EDGE_KINDS,
  ...TEST_EDGE_KINDS
] as const;

export type StructuralEdgeKind = (typeof STRUCTURAL_EDGE_KINDS)[number];
export type CallEdgeKind = (typeof CALL_EDGE_KINDS)[number];
export type DataflowEdgeKind = (typeof DATAFLOW_EDGE_KINDS)[number];
export type FrameworkEdgeKind = (typeof FRAMEWORK_EDGE_KINDS)[number];
export type TestEdgeKind = (typeof TEST_EDGE_KINDS)[number];
export type EdgeKind = (typeof ALL_EDGE_KINDS)[number];

/** Named reverse edges that are materialized as first-class rows, not request-time scans. */
export const REVERSE_EDGE_KIND: Partial<Record<EdgeKind, EdgeKind>> = {
  CALLS_EXACT: "CALLED_BY",
  CALLS_VIRTUAL: "CALLED_BY",
  DISPATCHES_TO: "CALLED_BY",
  CONSTRUCTS: "CALLED_BY",
  METHOD_REFERENCE: "CALLED_BY"
};

export function isEdgeKind(value: string): value is EdgeKind {
  return (ALL_EDGE_KINDS as readonly string[]).includes(value);
}

export function isStructuralEdgeKind(value: string): value is StructuralEdgeKind {
  return (STRUCTURAL_EDGE_KINDS as readonly string[]).includes(value);
}

export function isCallEdgeKind(value: string): value is CallEdgeKind {
  return (CALL_EDGE_KINDS as readonly string[]).includes(value);
}

export function isFrameworkEdgeKind(value: string): value is FrameworkEdgeKind {
  return (FRAMEWORK_EDGE_KINDS as readonly string[]).includes(value);
}

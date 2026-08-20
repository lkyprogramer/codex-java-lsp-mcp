// input: A compiled intent.
// output: Generic coverage obligations that name graph edge kinds and node roles only.
// pos: N3-01. No scene vocabulary. Templates follow JIN §8.3.
import type { EdgeKind } from "../java-knowledge/edge-kinds.js";
import type { Intent } from "./intent-types.js";

export type Obligation = {
  id: string;
  role: string;
  edgeKinds: EdgeKind[];
};

const CALLS: EdgeKind[] = ["CALLS_EXACT", "CALLS_VIRTUAL", "DISPATCHES_TO", "CONSTRUCTS", "METHOD_REFERENCE", "CALLED_BY"];
const STRUCTURAL: EdgeKind[] = ["CONTAINS", "DECLARES", "EXTENDS", "IMPLEMENTS", "PERMITS"];
const PERSISTENCE: EdgeKind[] = [
  "MYBATIS_METHOD_BINDS_STATEMENT",
  "MYBATIS_STATEMENT_USES_ENTITY",
  "REPOSITORY_MANAGES_ENTITY",
  "JPA_RELATION",
  "SQL_TOUCHES_TABLE"
];
const FRAMEWORK: EdgeKind[] = [
  "SPRING_INJECTS",
  "SPRING_BEAN_BINDS_TO",
  "PUBLISHES_EVENT",
  "CONSUMES_EVENT",
  "MAPSTRUCT_SOURCE_TO_TARGET",
  "MAPSTRUCT_USES"
];
const TESTS: EdgeKind[] = ["TESTS_TYPE", "TESTS_METHOD", "MOCKS_TYPE", "USES_FIXTURE"];

export const OBLIGATIONS_BY_INTENT: Record<Intent, Obligation[]> = {
  IMPLEMENTATION_CHANGE: [
    { id: "O1", role: "anchor-method", edgeKinds: ["DECLARES", "CONTAINS"] },
    { id: "O2", role: "direct-callees", edgeKinds: ["CALLS_EXACT", "CALLS_VIRTUAL", "DISPATCHES_TO"] },
    { id: "O3", role: "type-closure", edgeKinds: ["EXTENDS", "IMPLEMENTS", "PERMITS"] },
    { id: "O4", role: "persistence-touch", edgeKinds: PERSISTENCE },
    { id: "O5", role: "contract-types", edgeKinds: ["DECLARES", "IMPORTS"] },
    { id: "O6", role: "framework-dispatch", edgeKinds: FRAMEWORK },
    { id: "O7", role: "verification-test", edgeKinds: TESTS }
  ],
  DOWNSTREAM_BEHAVIOR: [
    { id: "O1", role: "callees", edgeKinds: ["CALLS_EXACT", "CALLS_VIRTUAL", "DISPATCHES_TO", "CONSTRUCTS"] },
    { id: "O2", role: "persistence-sink", edgeKinds: PERSISTENCE },
    { id: "O3", role: "event-consumers", edgeKinds: ["PUBLISHES_EVENT", "CONSUMES_EVENT"] },
    { id: "O4", role: "implementers", edgeKinds: ["IMPLEMENTS", "DISPATCHES_TO"] }
  ],
  UPSTREAM_IMPACT: [
    { id: "O1", role: "direct-callers", edgeKinds: ["CALLED_BY"] },
    { id: "O2", role: "entrypoints", edgeKinds: ["CALLED_BY", "SPRING_BEAN_BINDS_TO"] },
    { id: "O3", role: "event-producers", edgeKinds: ["PUBLISHES_EVENT", "CONSUMES_EVENT"] },
    { id: "O4", role: "module-boundary", edgeKinds: ["MODULE_DEPENDS_ON", "IMPORTS"] },
    { id: "O5", role: "affected-tests", edgeKinds: TESTS }
  ],
  CONTRACT_CHANGE: [
    { id: "O1", role: "type-contract", edgeKinds: ["DECLARES", "EXTENDS", "IMPLEMENTS"] },
    { id: "O2", role: "implementers", edgeKinds: ["IMPLEMENTS", "PERMITS"] },
    { id: "O3", role: "callers", edgeKinds: ["CALLED_BY"] },
    { id: "O4", role: "dto-fields", edgeKinds: ["DECLARES", "CONTAINS"] }
  ],
  PERSISTENCE_FLOW: [
    { id: "O1", role: "repository-method", edgeKinds: ["DECLARES", "REPOSITORY_MANAGES_ENTITY"] },
    { id: "O2", role: "mapper-xml", edgeKinds: ["MYBATIS_METHOD_BINDS_STATEMENT"] },
    { id: "O3", role: "entity", edgeKinds: ["MYBATIS_STATEMENT_USES_ENTITY", "REPOSITORY_MANAGES_ENTITY", "JPA_RELATION"] },
    { id: "O4", role: "table", edgeKinds: ["SQL_TOUCHES_TABLE"] }
  ],
  DATAFLOW_TRACE: [
    { id: "O1", role: "calls", edgeKinds: CALLS },
    { id: "O2", role: "persistence", edgeKinds: PERSISTENCE },
    { id: "O3", role: "fields", edgeKinds: ["DECLARES"] }
  ],
  FRAMEWORK_WIRING: [
    { id: "O1", role: "inject", edgeKinds: FRAMEWORK },
    { id: "O2", role: "type-closure", edgeKinds: STRUCTURAL },
    { id: "O3", role: "calls", edgeKinds: CALLS }
  ],
  TEST_PLANNING: [
    { id: "O1", role: "tests", edgeKinds: TESTS },
    { id: "O2", role: "anchor-method", edgeKinds: ["DECLARES", "CALLED_BY"] },
    { id: "O3", role: "callees", edgeKinds: CALLS }
  ],
  DIAGNOSTIC_ONLY: [
    { id: "O1", role: "anchor-method", edgeKinds: ["DECLARES", "CONTAINS"] },
    { id: "O2", role: "nearby-calls", edgeKinds: CALLS }
  ]
};

export function obligationsFor(intent: Intent): Obligation[] {
  return OBLIGATIONS_BY_INTENT[intent];
}

import assert from "node:assert/strict";
import test from "node:test";
import { ALL_EDGE_KINDS, REVERSE_EDGE_KIND, STRUCTURAL_EDGE_KINDS } from "./edge-kinds.js";

const SPEC_SECTION_72 = [
  "CONTAINS", "DECLARES", "EXTENDS", "IMPLEMENTS", "PERMITS", "IMPORTS", "ANNOTATED_WITH", "MODULE_DEPENDS_ON",
  "CALLS_EXACT", "CALLS_VIRTUAL", "DISPATCHES_TO", "CONSTRUCTS", "METHOD_REFERENCE", "CALLED_BY",
  "READS_FIELD", "WRITES_FIELD", "DEFINES_LOCAL", "USES_LOCAL", "ARGUMENT_FLOWS_TO",
  "PARAMETER_FLOWS_TO_RETURN", "CALL_RESULT_ASSIGNED_TO", "CALL_RESULT_RETURNED_BY", "THROWS_TO",
  "SPRING_INJECTS", "SPRING_BEAN_BINDS_TO", "PUBLISHES_EVENT", "CONSUMES_EVENT",
  "MAPSTRUCT_SOURCE_TO_TARGET", "MAPSTRUCT_USES",
  "MYBATIS_METHOD_BINDS_STATEMENT", "MYBATIS_STATEMENT_USES_ENTITY", "REPOSITORY_MANAGES_ENTITY",
  "JPA_RELATION", "SQL_TOUCHES_TABLE",
  "TESTS_TYPE", "TESTS_METHOD", "MOCKS_TYPE", "USES_FIXTURE"
] as const;

test("edge kind enum matches §7.2 exactly", () => {
  assert.deepEqual([...ALL_EDGE_KINDS].sort(), [...SPEC_SECTION_72].sort());
  assert.equal(new Set(ALL_EDGE_KINDS).size, ALL_EDGE_KINDS.length);
});

test("N1 structural kinds are a closed subset", () => {
  for (const kind of STRUCTURAL_EDGE_KINDS) {
    assert.equal(SPEC_SECTION_72.includes(kind), true);
  }
  assert.equal((STRUCTURAL_EDGE_KINDS as readonly string[]).includes("CALLS_EXACT"), false);
});

test("CALLED_BY is the materialized reverse of call kinds", () => {
  assert.equal(REVERSE_EDGE_KIND.CALLS_EXACT, "CALLED_BY");
  assert.equal(REVERSE_EDGE_KIND.CALLS_VIRTUAL, "CALLED_BY");
  assert.equal(REVERSE_EDGE_KIND.CONTAINS, undefined);
});

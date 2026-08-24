import assert from "node:assert/strict";
import test from "node:test";
import { NODE_KINDS } from "./schema.js";

test("node kinds match §7.1 including reserved STATEMENT", () => {
  assert.deepEqual([...NODE_KINDS], [
    "REPOSITORY", "MODULE", "SOURCE_ROOT", "FILE", "TYPE", "METHOD", "CONSTRUCTOR",
    "FIELD", "PARAMETER", "LOCAL", "STATEMENT", "JAVA_RESOURCE", "MYBATIS_NAMESPACE",
    "MYBATIS_STATEMENT", "JPA_ENTITY", "CONFIG_KEY", "TEST_CASE"
  ]);
});

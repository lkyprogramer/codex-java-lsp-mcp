import assert from "node:assert/strict";
import test from "node:test";
import type { JavaSourceFacts } from "../java-index/router-facts.js";
import { candidateFromFacts, positionFromFacts, selectPreferredImplementers } from "./candidate-helpers.js";

function facts(methods: JavaSourceFacts["methods"]): JavaSourceFacts {
  return {
    absolutePath: "/repo/src/main/java/demo/Impl.java",
    path: "src/main/java/demo/Impl.java",
    implementsTypes: [],
    referencedTypes: [],
    imports: [],
    wildcardImports: [],
    annotations: [],
    methods,
    factSource: "javaIndex"
  };
}

test("positionFromFacts keeps (1,1) when hydrate did not supply methods", () => {
  assert.deepEqual(positionFromFacts(facts([])), { line: 1, column: 1 });
});

test("positionFromFacts uses the hit-reason method instead of a type header", () => {
  assert.deepEqual(
    positionFromFacts(facts([
      { name: "other", line: 20, endLine: 24, referencedTypes: [], relations: [] },
      { name: "findById", line: 77, endLine: 90, referencedTypes: [], relations: [] }
    ]), { methodName: "findById" }),
    { line: 77, column: 1 }
  );
});

test("positionFromFacts uses a sole hydrated method when no name hint exists", () => {
  assert.deepEqual(
    positionFromFacts(facts([
      { name: "only", line: 136, endLine: 140, referencedTypes: [], relations: [] }
    ])),
    { line: 136, column: 1 }
  );
});

test("candidateFromFacts threads the preferred method position", () => {
  const candidate = candidateFromFacts(
    facts([{ name: "save", line: 238, endLine: 250, referencedTypes: [], relations: [] }]),
    80,
    "typeGraph",
    { methodName: "save" }
  );
  assert.deepEqual(candidate.positions, [{ line: 238, column: 1 }]);
});

test("positionFromFacts uses the unique method that names the collaborator type", () => {
  assert.deepEqual(
    positionFromFacts(facts([
      { name: "toConfirmResponse", line: 34, endLine: 38, referencedTypes: ["BenefitEntitlement"], relations: [] },
      { name: "toBenefitItemResponse", line: 50, endLine: 54, referencedTypes: ["ParentStudentBenefitItemView", "ParentStudentBenefitItemResponse"], relations: [] }
    ]), { typeName: "ParentStudentBenefitItemResponse" }),
    { line: 50, column: 1 }
  );
});

test("positionFromFacts uses the unique caller-site callee when methodName misses", () => {
  assert.deepEqual(
    positionFromFacts(facts([
      { name: "page", line: 69, endLine: 80, referencedTypes: [], relations: [] },
      { name: "deleteCheckPeople", line: 172, endLine: 189, referencedTypes: [], relations: [] }
    ]), { methodName: "delete", calleeNames: ["deleteCheckPeople", "success"] }),
    { line: 172, column: 1 }
  );
});

test("positionFromFacts keeps (1,1) when several caller-site callees exist on the implementer", () => {
  assert.deepEqual(
    positionFromFacts(facts([
      { name: "page", line: 69, endLine: 80, referencedTypes: [], relations: [] },
      { name: "deleteCheckPeople", line: 172, endLine: 189, referencedTypes: [], relations: [] }
    ]), { methodName: "delete", calleeNames: ["page", "deleteCheckPeople"] }),
    { line: 1, column: 1 }
  );
});

test("positionFromFacts keeps (1,1) when several methods name the same type", () => {
  assert.deepEqual(
    positionFromFacts(facts([
      { name: "first", line: 10, endLine: 12, referencedTypes: ["Order"], relations: [] },
      { name: "second", line: 20, endLine: 22, referencedTypes: ["demo.Order"], relations: [] }
    ]), { typeName: "Order" }),
    { line: 1, column: 1 }
  );
});

test("positionFromFacts uses the Boot application type start instead of unique main", () => {
  assert.deepEqual(
    positionFromFacts({
      ...facts([{ name: "main", line: 31, endLine: 33, referencedTypes: [], relations: [] }]),
      annotations: ["SpringBootApplication"],
      typeStartLine: 21
    }),
    { line: 21, column: 1 }
  );
});

test("selectPreferredImplementers keeps a unique implementer and only @Primary when several exist", () => {
  const only = facts([{ name: "claim", line: 40, endLine: 50, referencedTypes: [], relations: [] }]);
  const primary = {
    ...facts([{ name: "currentUser", line: 42, endLine: 50, referencedTypes: [], relations: [] }]),
    annotations: ["Service", "Primary"]
  };
  const other = {
    ...facts([{ name: "currentUser", line: 20, endLine: 28, referencedTypes: [], relations: [] }]),
    absolutePath: "/repo/src/main/java/demo/OtherImpl.java",
    annotations: ["Service"]
  };
  const testImpl = {
    ...other,
    absolutePath: "/repo/src/test/java/demo/FakeImpl.java",
    sourceSet: "test" as const
  };
  const third = { ...other, absolutePath: "/repo/src/main/java/demo/Third.java" };
  assert.deepEqual(selectPreferredImplementers([only]), [only]);
  assert.deepEqual(selectPreferredImplementers([primary, other]), [primary]);
  assert.deepEqual(selectPreferredImplementers([other, third]), [other, third]);
  assert.deepEqual(selectPreferredImplementers([only, testImpl]), [only]);
});

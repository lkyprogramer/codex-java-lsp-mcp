import assert from "node:assert/strict";
import test from "node:test";
import {
  knowledgeEdgeId,
  knowledgeFileId,
  knowledgeMemberId,
  knowledgeParameterId,
  knowledgeTypeId,
  signatureHash
} from "./entity-id.js";

test("entity ids are repo-relative and independent of path separators", () => {
  const left = knowledgeFileId("src/main/java/demo/A.java");
  const right = knowledgeFileId("src\\main\\java\\demo\\A.java");
  assert.equal(left, right);
  assert.equal(left.includes("/Users/"), false);
  assert.equal(left, "src/main/java/demo/A.java");
});

test("type and member ids follow file#type#member#signatureHash", () => {
  const typeId = knowledgeTypeId("src/main/java/demo/A.java", "demo.A");
  assert.equal(typeId, "src/main/java/demo/A.java#demo.A");
  const memberId = knowledgeMemberId(typeId, "save", "save(java.lang.String)");
  assert.equal(memberId.startsWith(`${typeId}#save#`), true);
  assert.equal(memberId.split("#").length, 4);
  assert.equal(signatureHash("save(java.lang.String)"), signatureHash("save(java.lang.String)"));
  assert.notEqual(signatureHash("save(java.lang.String)"), signatureHash("save(int)"));
});

test("same inputs produce the same ids", () => {
  const first = knowledgeMemberId(knowledgeTypeId("a/B.java", "B"), "m", "m()");
  const second = knowledgeMemberId(knowledgeTypeId("a/B.java", "B"), "m", "m()");
  assert.equal(first, second);
  assert.equal(knowledgeParameterId(first, 0), knowledgeParameterId(first, 0));
  assert.notEqual(knowledgeParameterId(first, 0), knowledgeParameterId(first, 1));
});

test("edge ids stay root-independent", () => {
  const id = knowledgeEdgeId({
    kind: "CONTAINS",
    fromId: "src/A.java",
    toId: "src/A.java#A"
  });
  assert.equal(id.includes("/Users/"), false);
});

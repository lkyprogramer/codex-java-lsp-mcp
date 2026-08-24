import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { conventionalDeclarationCandidates, isExactFqn } from "./router-java-index-cold.js";

test("conventionalDeclarationCandidates only returns files that exist under source roots", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cold-decl-"));
  mkdirSync(path.join(root, "src/main/java/demo"), { recursive: true });
  writeFileSync(path.join(root, "src/main/java/demo/Order.java"), "package demo;\nclass Order {}\n");
  const hits = conventionalDeclarationCandidates(root, ["src/main/java"], ["demo.Order", "demo.Missing"]);
  assert.deepEqual(hits, [path.join(root, "src/main/java/demo/Order.java")]);
  assert.equal(isExactFqn("demo.Order"), true);
  assert.equal(isExactFqn("Order"), false);
});

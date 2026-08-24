import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LayoutManager } from "./layout-manager.js";

function singleModuleRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "layout-mgr-"));
  mkdirSync(path.join(root, "src", "main", "java", "demo"), { recursive: true });
  writeFileSync(path.join(root, "pom.xml"), "<project></project>\n");
  return root;
}

test("refresh() reports unchanged when no build marker moved", () => {
  const root = singleModuleRepo();
  const manager = new LayoutManager(root);
  assert.equal(manager.current().layout, "single");
  const result = manager.refresh();
  assert.equal(result.changed, false);
  assert.equal(result.layout, manager.current(), "unchanged refresh returns the same cached layout object");
});

test("refresh() detects a new module directory and its build marker", () => {
  const root = singleModuleRepo();
  const manager = new LayoutManager(root);
  assert.equal(manager.refresh().changed, false);

  const moduleDir = path.join(root, "moduleA");
  mkdirSync(path.join(moduleDir, "src", "main", "java", "demo"), { recursive: true });
  writeFileSync(path.join(moduleDir, "pom.xml"), "<project></project>\n");

  const result = manager.refresh();
  assert.equal(result.changed, true);
  assert.ok(
    result.layout.sourceRoots.some(root => root.module === "moduleA"),
    "the new module's source root is now visible"
  );
  assert.equal(manager.current(), result.layout, "current() reflects the refreshed layout");

  // A second refresh with nothing new settles back to unchanged.
  assert.equal(manager.refresh().changed, false);
});

test("refresh() detects an edit to an existing build marker", () => {
  const root = singleModuleRepo();
  const manager = new LayoutManager(root);
  assert.equal(manager.refresh().changed, false);

  writeFileSync(path.join(root, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
  const result = manager.refresh();
  assert.equal(result.changed, true);
});

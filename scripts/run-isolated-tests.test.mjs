import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createIsolatedTestEnvironment } from "./run-isolated-tests.mjs";

test("repository test runner replaces caller runtime paths with one disposable root", () => {
  const callerEnvironment = {
    JAVA_LSP_CACHE_BASE: "/must-not-touch/live-cache",
    JAVA_LSP_OWNERSHIP_BASE: "/must-not-touch/live-ownership",
    JAVA_LSP_PROJECTS_JSON: "/must-not-touch/live-projects.json",
    JDTLS_DATA_DIR: "/must-not-touch/live-jdt-workspace",
    JDTLS_LOG_DIR: "/must-not-touch/live-jdt-logs",
    XDG_CONFIG_HOME: "/must-not-touch/live-xdg",
    CODEX_HOME: "/must-not-touch/live-codex"
  };
  const isolated = createIsolatedTestEnvironment(callerEnvironment);
  try {
    for (const name of [
      "JAVA_LSP_CACHE_BASE",
      "JAVA_LSP_OWNERSHIP_BASE",
      "JAVA_LSP_PROJECTS_JSON",
      "XDG_CONFIG_HOME",
      "CODEX_HOME",
      "HOME"
    ]) {
      assert.notEqual(isolated.environment[name], callerEnvironment[name]);
      assert.equal(isolated.environment[name]?.startsWith(isolated.root), true, `${name} must stay below the test root`);
    }
    assert.equal(readFileSync(isolated.environment.JAVA_LSP_PROJECTS_JSON, "utf8"), '{"aliases":[]}\n');
    assert.equal(existsSync(path.join(isolated.root, "cache")), true);
    assert.equal("JDTLS_DATA_DIR" in isolated.environment, false);
    assert.equal("JDTLS_LOG_DIR" in isolated.environment, false);
    assert.equal(callerEnvironment.JAVA_LSP_CACHE_BASE, "/must-not-touch/live-cache");
  } finally {
    const root = isolated.root;
    isolated.cleanup();
    isolated.cleanup();
    assert.equal(existsSync(root), false, "the exact mkdtemp root must be removed after the test run");
  }
});

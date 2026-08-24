import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { repoCacheBase } from "./repo-layout.js";

test("repoCacheBase honors JAVA_LSP_CACHE_ROOT for an isolated process", () => {
  const previousRoot = process.env.JAVA_LSP_CACHE_ROOT;
  const previousBase = process.env.JAVA_LSP_CACHE_BASE;
  try {
    delete process.env.JAVA_LSP_CACHE_BASE;
    process.env.JAVA_LSP_CACHE_ROOT = "/tmp/codex-java-lsp-isolated-cache";
    assert.equal(repoCacheBase(), path.resolve("/tmp/codex-java-lsp-isolated-cache"));
  } finally {
    if (previousRoot === undefined) delete process.env.JAVA_LSP_CACHE_ROOT;
    else process.env.JAVA_LSP_CACHE_ROOT = previousRoot;
    if (previousBase === undefined) delete process.env.JAVA_LSP_CACHE_BASE;
    else process.env.JAVA_LSP_CACHE_BASE = previousBase;
  }
});

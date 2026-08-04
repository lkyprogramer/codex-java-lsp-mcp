import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { repoCacheBase } from "./repo-layout.js";

test("repoCacheBase honors JAVA_LSP_CACHE_ROOT for an isolated process", () => {
  const previous = process.env.JAVA_LSP_CACHE_ROOT;
  try {
    process.env.JAVA_LSP_CACHE_ROOT = "/tmp/codex-java-lsp-isolated-cache";
    assert.equal(repoCacheBase(), path.resolve("/tmp/codex-java-lsp-isolated-cache"));
  } finally {
    if (previous === undefined) delete process.env.JAVA_LSP_CACHE_ROOT;
    else process.env.JAVA_LSP_CACHE_ROOT = previous;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseSmokeArguments } from "./smoke-http.js";

test("HTTP smoke accepts exactly one explicit repository selector", () => {
  const byProject = parseSmokeArguments([
    "--url", "http://127.0.0.1:38456/mcp",
    "--project-id", "fixture",
    "--start"
  ]);
  assert.equal(byProject.projectId, "fixture");
  assert.equal(byProject.repoRoot, undefined);
  assert.equal(byProject.start, true);

  const byRoot = parseSmokeArguments([
    "--url", "http://127.0.0.1:38456/mcp",
    "--repo-root", "/tmp/fixture"
  ]);
  assert.equal(byRoot.repoRoot, "/tmp/fixture");
  assert.throws(() => parseSmokeArguments([
    "--url", "http://127.0.0.1:38456/mcp",
    "--repo-root", "/tmp/fixture",
    "--project-id", "fixture"
  ]), /mutually exclusive/);
});

test("HTTP smoke requires --url and does not read JAVA_LSP_HTTP_URL", () => {
  const previous = process.env.JAVA_LSP_HTTP_URL;
  process.env.JAVA_LSP_HTTP_URL = "http://127.0.0.1:1/mcp";
  try {
    assert.throws(() => parseSmokeArguments([]), /--url is required/);
  } finally {
    if (previous === undefined) delete process.env.JAVA_LSP_HTTP_URL;
    else process.env.JAVA_LSP_HTTP_URL = previous;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { assertStdioOwnershipHandoff, effectiveStdioOwnershipBase } from "./verify-stdio-ownership-handoff.mjs";

const home = "/Users/example";

test("stdio ownership handoff uses the legacy default and accepts the daemon namespace", () => {
  const config = { transport: { type: "stdio", command: "/runtime/run.sh", env: {} } };
  const expected = "/Users/example/Library/Caches/codex-java-lsp/.ownership";
  assert.equal(effectiveStdioOwnershipBase(config, home), expected);
  assert.doesNotThrow(() => assertStdioOwnershipHandoff(config, expected, home));
});

test("stdio ownership handoff rejects custom cache or ownership divergence", () => {
  const config = { transport: { type: "stdio", env: { JAVA_LSP_CACHE_BASE: "~/custom-cache" } } };
  assert.throws(
    () => assertStdioOwnershipHandoff(config, "/Users/example/Library/Caches/codex-java-lsp/.ownership", home),
    /ownership base differs/
  );
  assert.equal(effectiveStdioOwnershipBase({ transport: { type: "stdio", env: {
    JAVA_LSP_OWNERSHIP_BASE: "/tmp/isolated-ownership"
  } } }, home), "/tmp/isolated-ownership");
});

test("existing HTTP registration has no old stdio ownership namespace", () => {
  assert.equal(effectiveStdioOwnershipBase({ transport: { type: "streamable_http" } }, home), undefined);
});

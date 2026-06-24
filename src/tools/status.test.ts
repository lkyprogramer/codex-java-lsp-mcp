import assert from "node:assert/strict";
import test from "node:test";
import { javaStatus } from "./status.js";
import type { ToolContext } from "./context.js";

test("java_status exposes runtime build and root source metadata", async () => {
  const context = {
    repoRoot: "/tmp/demo",
    repoHash: "demo",
    aliases: ["demo"],
    layoutProfile: "generic-java",
    rootSource: "explicit",
    lsp: {
      enabled: true,
      matchedBy: "direct-root",
      effectiveRepoRoot: "/tmp/demo"
    },
    session: {
      status() {
        return { started: false };
      }
    },
    sourceIndex: {
      status() {
        return { entries: 0 };
      }
    },
    router: {
      rgCacheStatus() {
        return { entries: 0 };
      }
    }
  } as unknown as ToolContext;

  const result = await javaStatus(context, { start: false });

  assert.equal(result.rootSource, "explicit");
  assert.equal((result.layout as Record<string, unknown>).layoutProfile, "generic-java");
  assert.equal(typeof (result.runtimeBuild as Record<string, unknown>).generatedAt, "string");
  assert.equal(typeof (result.runtimeBuild as Record<string, unknown>).defaultsFingerprint, "string");
});

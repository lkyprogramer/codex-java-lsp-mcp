import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { javaSymbol } from "./symbol.js";
import type { ToolContext } from "./context.js";
import { publicModule } from "../repo-layout.js";
import { DeadlineBudget } from "../runtime/deadline-budget.js";

const repoRoot = "/tmp/scope-demo";
const at = (relativePath: string) => ({
  uri: pathToFileURL(path.join(repoRoot, relativePath)).toString(),
  range: { start: { line: 4, character: 8 }, end: { line: 4, character: 12 } }
});
const base = { semanticTimeoutMs: 3000, includeDeclaration: false, positionsPerFile: 3 } as const;
const record = (value: unknown) => value as Record<string, unknown>;

function contextWith(references: ReturnType<typeof at>[], calls: string[] = []): ToolContext {
  return {
    repoRoot,
    session: {
      status() { return { state: "READY" }; },
      async workspaceSymbols() { calls.push("workspaceSymbols"); return { truncated: false, items: [] }; },
      async references() {
        calls.push("references");
        return { items: references, totalReferences: references.length, truncated: false };
      }
    }
  } as unknown as ToolContext;
}

test("the root module is \".\" in public locations, matching the scope a caller passes back", () => {
  assert.equal(publicModule(undefined, "src/main/java/demo/A.java"), ".");
  assert.equal(publicModule("", "src/test/java/demo/A.java"), ".");
  assert.equal(publicModule(undefined, "src\\main\\java\\demo\\A.java"), ".");
  assert.equal(publicModule("a/core", "a/core/src/main/java/demo/A.java"), "a/core");
  assert.equal(publicModule("billing", "modules/billing/src/main/java/A.java"), "billing");
  assert.equal(publicModule(undefined, "lib/A.java"), undefined, "no recognised layout stays unknown");
  assert.equal(publicModule(undefined, "srcx/A.java"), undefined);
  assert.equal(publicModule(undefined, undefined), undefined);
});

test("references scoped to module \".\" keep root-module hits and drop nested-module ones", async () => {
  const context = contextWith([at("src/main/java/demo/A.java"), at("src/test/java/demo/ATest.java"), at("a/core/src/main/java/demo/B.java")]);
  const request = { budget: DeadlineBudget.fromTimeout(5000) } as never;
  const args = { ...base, operation: "references", file: "src/main/java/demo/A.java", line: 5, column: 9 } as const;

  const root = record(await javaSymbol(context, { ...args, module: "." }, request));
  assert.deepEqual([root.totalReferences, root.matchedReferences], [3, 2]);
  const rootTest = record(await javaSymbol(context, { ...args, module: ".", sourceSet: "test" }, request));
  assert.equal(rootTest.matchedReferences, 1, "module and sourceSet intersect");
  const nested = record(await javaSymbol(context, { ...args, module: "a/core" }, request));
  assert.equal(nested.matchedReferences, 1);
  const unknown = record(await javaSymbol(context, { ...args, module: "nope" }, request));
  assert.equal(unknown.matchedReferences, 0, "an unknown module is never widened");
  const groups = record(await javaSymbol(context, args, request)).groups as Array<Record<string, unknown>>;
  assert.deepEqual(groups.map(group => group.module).sort(), [".", "a/core"]);
});

test("query rejects scope a backend would silently ignore", async () => {
  const calls: string[] = [];
  const context = contextWith([], calls);
  const request = { budget: DeadlineBudget.fromTimeout(5000) } as never;
  for (const scope of [{ module: "." }, { sourceSet: "main" as const }, { layer: "service" }]) {
    await assert.rejects(javaSymbol(context, { ...base, operation: "query", backend: "jdt", query: "Pay", ...scope }, request),
      { code: "INVALID_INPUT" }, JSON.stringify(scope));
  }
  await assert.rejects(javaSymbol(context, { ...base, operation: "query", query: "Pay", layer: "service" }, request),
    { code: "INVALID_INPUT", message: /layer filters operation=references/ });
  assert.deepEqual(calls, [], "a rejected request does no backend work");
  const unscoped = record(await javaSymbol(context, { ...base, operation: "query", backend: "jdt", query: "Pay" }, request));
  assert.equal(unscoped.mode, "query");
});

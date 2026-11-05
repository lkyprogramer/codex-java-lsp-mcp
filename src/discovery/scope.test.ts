// input: resolveSearchScope over layout source roots, and runStaticDiscovery
//        with a capturing fake index client (no parser/worker needed).
// output: R06 regression lock: module AND sourceSet over real roots, unknown
//         module never widened, explicit EMPTY/PARTIAL reasons, scope passed
//         to the index as exact root ids.
import assert from "node:assert/strict";
import test from "node:test";
import { resolveSearchScope, sourceRootRecordFromPath, type SourceRootRecord } from "./scope.js";
import { runStaticDiscovery } from "./query.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";
import type { EntitySearchOptions } from "../java-index/entity-search.js";

const ROOT_PATHS = [
  "src/main/java",
  "src/test/java",
  "m/src/main/java",
  "m/src/test/java",
  "modules/a/src/main/java",
  "x/core/src/main/java",
  "y/core/src/main/java"
];
const ROOTS: SourceRootRecord[] = ROOT_PATHS.map(root => sourceRootRecordFromPath(root)!);

const ids = (request: Parameters<typeof resolveSearchScope>[1]) => {
  const scope = resolveSearchScope(ROOTS, request);
  return scope.state === "RESOLVED" ? scope.sourceRootIds : scope;
};

test("R06: module and sourceSet are an AND over layout roots", () => {
  assert.deepEqual(ids({ module: "m", sourceSet: "test" }), ["m/src/test/java"]);
  assert.deepEqual(ids({ module: "m" }), ["m/src/main/java", "m/src/test/java"]);
  assert.deepEqual(ids({ sourceSet: "test" }), ["m/src/test/java", "src/test/java"]);
  assert.deepEqual(ids({ module: "." }), ["src/main/java", "src/test/java"], "root module");
  assert.deepEqual(ids({ module: "" }), ["src/main/java", "src/test/java"]);
  assert.deepEqual(ids({ module: "a" }), ["modules/a/src/main/java"], "layout module name");
  assert.deepEqual(ids({ module: "modules/a" }), ["modules/a/src/main/java"], "module directory");
  assert.deepEqual(ids({ module: "x/core" }), ["x/core/src/main/java"]);
  assert.deepEqual(resolveSearchScope(ROOTS, {}), { state: "UNSCOPED" });
});

test("R06: unknown, ambiguous and source-set-less modules are explicit EMPTY, never widened", () => {
  assert.deepEqual(resolveSearchScope(ROOTS, { module: "missing" }), { state: "EMPTY", reason: "UNKNOWN_MODULE" });
  assert.deepEqual(resolveSearchScope(ROOTS, { module: "core" }), { state: "EMPTY", reason: "AMBIGUOUS_MODULE" });
  assert.deepEqual(resolveSearchScope(ROOTS, { module: "a", sourceSet: "test" }), { state: "EMPTY", reason: "NO_SOURCE_ROOT" });
  // no layout roots at all: conventional prefix, flagged PARTIAL
  assert.deepEqual(resolveSearchScope([], { module: "m", sourceSet: "test" }), { state: "PARTIAL", reason: "LAYOUT_UNKNOWN", sourceRootIds: ["m/src/test"] });
  assert.equal(sourceRootRecordFromPath("custom/java"), undefined, "a root without src/<set> is not scopable by source set");
});

function capturingClient(coverage: Array<{ root: string }> | undefined, calls: Array<{ task: string; options?: EntitySearchOptions }>): JavaIndexClientApi {
  const status = { state: "READY" as const, indexedGeneration: 7, files: 1, types: 1, methods: 1, edges: 0, snapshotBytes: 0, pendingForeground: 0, pendingBackground: 0, coverage, resourceCoverage: [] };
  return {
    status: async () => status,
    querySearch: async (task: string, options?: EntitySearchOptions) => {
      calls.push({ task, options });
      return { hits: [], truncated: false, work: { postings: 0 }, generation: 7 };
    }
  } as unknown as JavaIndexClientApi;
}

const coverage = ROOT_PATHS.map(root => ({ root, generation: 7, state: "COMPLETE" }));

test("R06: discovery sends the resolved root ids and reports the scope", async () => {
  const calls: Array<{ task: string; options?: EntitySearchOptions }> = [];
  const result = await runStaticDiscovery(capturingClient(coverage, calls), { query: "OrderService", module: "m", sourceSet: "test", repoRoot: "/nonexistent" });
  assert.deepEqual(calls[0]!.options?.scope, { sourceRoots: ["m/src/test/java"] });
  assert.deepEqual(result.scope, { state: "RESOLVED", sourceRootIds: ["m/src/test/java"] });
  assert.equal(result.scopeState, "READY");
  const unscoped = await runStaticDiscovery(capturingClient(coverage, calls), { query: "OrderService", repoRoot: "/nonexistent" });
  assert.equal(calls[1]!.options?.scope, undefined);
  assert.deepEqual(unscoped.scope, { state: "UNSCOPED" });
});

test("R06: an unknown module answers with its reason and never queries the whole repository", async () => {
  const calls: Array<{ task: string; options?: EntitySearchOptions }> = [];
  const result = await runStaticDiscovery(capturingClient(coverage, calls), { query: "OrderService", module: "missing", repoRoot: "/nonexistent" });
  assert.equal(calls.length, 0);
  assert.deepEqual(result.scope, { state: "EMPTY", reason: "UNKNOWN_MODULE" });
  assert.equal(result.stopReason, "scope_empty");
  assert.deepEqual(result.candidates, []);
});

test("R06: without layout roots the conventional scope is used but the result is PARTIAL", async () => {
  const calls: Array<{ task: string; options?: EntitySearchOptions }> = [];
  const result = await runStaticDiscovery(capturingClient(undefined, calls), { query: "OrderService", module: "m", sourceSet: "test", repoRoot: "/nonexistent" });
  assert.deepEqual(calls[0]!.options?.scope, { sourceRoots: ["m/src/test"] });
  assert.equal(result.scopeState, "PARTIAL");
  assert.equal(result.stopReason, "layout_unknown");
});

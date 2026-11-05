// input: runStaticDiscovery with a fake client publishing index coverage
//        roots, over a real temp repo layout.
// output: R06 review regression lock: an EMPTY scope is complete only for a
//         READY index that covers everything on disk for that scope; Maven
//         artifactIds name modules whose directory differs; the static query
//         limit text derives from the shared constant.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DISCOVERY_DEFAULT_LIMIT, DISCOVERY_MAX_LIMIT, runStaticDiscovery } from "./query.js";
import { STATIC_QUERY_LIMIT_DESCRIPTION } from "../tools/symbol.js";
import type { EntitySearchOptions } from "../java-index/entity-search.js";
import type { JavaIndexClientApi } from "../java-index/java-index-client-api.js";

function client(roots: string[], state: "READY" | "BUILDING", calls: EntitySearchOptions[]): JavaIndexClientApi {
  return {
    status: async () => ({ state, indexedGeneration: 1, coverage: roots.map(root => ({ root, state: "COMPLETE", generation: 1 })) }),
    querySearch: async (_task: string, options: EntitySearchOptions) => {
      calls.push(options);
      return { hits: [], truncated: false, selectionLimited: false, work: { postings: 0 }, generation: 1 };
    }
  } as unknown as JavaIndexClientApi;
}

async function layout(dirs: string[], files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "query-scope-"));
  for (const dir of dirs) await mkdir(path.join(root, dir), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, "utf8");
  }
  return root;
}

test("R06 review: an unknown module is a complete EMPTY only when nothing on disk is unindexed", async () => {
  const root = await layout(["svc/src/main/java", "newmod/src/main/java"]);
  try {
    const calls: EntitySearchOptions[] = [];
    const roots = ["svc/src/main/java"];
    const unknown = await runStaticDiscovery(client(roots, "READY", calls), { repoRoot: root, query: "Order", module: "nope" });
    assert.deepEqual([unknown.scopeState, unknown.stopReason, unknown.scope], ["READY", "scope_empty", { state: "EMPTY", reason: "UNKNOWN_MODULE" }]);
    const added = await runStaticDiscovery(client(roots, "READY", calls), { repoRoot: root, query: "Order", module: "newmod" });
    assert.equal(added.scopeState, "PARTIAL", "a module on disk the index does not cover yet is not a complete empty answer");
    assert.equal(added.stopReason, "index_partial");
    const noTests = await runStaticDiscovery(client(roots, "READY", calls), { repoRoot: root, query: "Order", module: "svc", sourceSet: "test" });
    assert.deepEqual([noTests.scopeState, noTests.scope], ["READY", { state: "EMPTY", reason: "NO_SOURCE_ROOT" }]);
    const building = await runStaticDiscovery(client(roots, "BUILDING", calls), { repoRoot: root, query: "Order", module: "nope" });
    assert.equal(building.scopeState, "PARTIAL", "a non-READY index never yields a complete EMPTY");
    const escape = await runStaticDiscovery(client(roots, "READY", calls), { repoRoot: root, query: "Order", module: "../.." });
    assert.equal(escape.scopeState, "READY", "the on-disk probe never looks outside the repository");
    assert.equal(calls.length, 0, "EMPTY never runs a query");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R06 review: a Maven artifactId names a module whose directory differs; the parent artifactId does not", async () => {
  const pom = (own: string) => `<project><parent><artifactId>platform-parent</artifactId></parent><!-- <artifactId>commented</artifactId> --><artifactId>${own}</artifactId></project>`;
  const root = await layout(["svc-dir/src/main/java", "api-dir/src/main/java"], {
    "svc-dir/pom.xml": pom("order-service"),
    "api-dir/pom.xml": pom("order-api")
  });
  try {
    const calls: EntitySearchOptions[] = [];
    const roots = ["svc-dir/src/main/java", "api-dir/src/main/java"];
    const byArtifact = await runStaticDiscovery(client(roots, "READY", calls), { repoRoot: root, query: "Order", module: "order-service" });
    assert.deepEqual(byArtifact.scope, { state: "RESOLVED", sourceRootIds: ["svc-dir/src/main/java"] });
    assert.deepEqual(calls[0]!.scope?.sourceRoots, ["svc-dir/src/main/java"]);
    for (const module of ["platform-parent", "commented"]) {
      const r = await runStaticDiscovery(client(roots, "READY", calls), { repoRoot: root, query: "Order", module });
      assert.deepEqual(r.scope, { state: "EMPTY", reason: "UNKNOWN_MODULE" }, module);
    }
    const byDir = await runStaticDiscovery(client(roots, "READY", calls), { repoRoot: root, query: "Order", module: "api-dir" });
    assert.deepEqual(byDir.scope, { state: "RESOLVED", sourceRootIds: ["api-dir/src/main/java"] }, "directory names still win");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R07 review: the java_symbol static-query limit text comes from the shared constants", () => {
  assert.ok(STATIC_QUERY_LIMIT_DESCRIPTION.includes(`1..${DISCOVERY_MAX_LIMIT}`));
  assert.ok(STATIC_QUERY_LIMIT_DESCRIPTION.includes(`default ${DISCOVERY_DEFAULT_LIMIT}`));
});

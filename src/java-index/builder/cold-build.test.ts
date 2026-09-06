import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import { JavaIndexStore } from "../index-store.js";
import type { JavaFileBundle, JavaTypeFacts } from "../index-types.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { discoverJavaFiles } from "../manifest.js";
import { buildTypeRegistryView, JavaNameResolver } from "../name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../parse-tree-cache.js";
import { probeLayout } from "../../layout-probe.js";
import { close, openIndexDb } from "../sql/driver.js";
import { ensureSchema } from "../sql/schema.js";
import { runSqlColdBuild } from "./cold-build.js";
import { readBuildProgress, readMeta } from "./progress.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");

async function memoryStoreFromFixtures(): Promise<JavaIndexStore> {
  const backend = await createJavaParserBackend();
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  const resolvedRepoRoot = await realpath(fixturesRoot);
  const layout = probeLayout(resolvedRepoRoot);
  const discovered = await discoverJavaFiles(resolvedRepoRoot, layout);
  const parsed: JavaFileBundle[] = [];
  for (const file of discovered) {
    parsed.push(await parseJavaSourceFile({
      repoRoot: resolvedRepoRoot,
      resolvedRepoRoot,
      inputPath: file.absolutePath,
      generation: 1,
      backend,
      cache,
      layout
    }));
  }
  const registry = buildTypeRegistryView(
    parsed.flatMap(bundle => bundle.types),
    parsed.flatMap(bundle => bundle.methods)
  );
  const resolver = new JavaNameResolver(registry);
  const byId = registry.byId as Map<string, JavaTypeFacts>;
  const resolved: JavaFileBundle[] = [];
  for (const raw of parsed) {
    const next = resolveFileRefs(raw, resolver, registry);
    for (const type of next.types) byId.set(type.typeId, type);
    resolved.push({ ...next, edges: [] });
  }
  const store = new JavaIndexStore();
  for (const bundle of resolved) {
    store.replaceFile({ ...bundle, edges: buildStaticEdges(bundle, registry, resolver) });
  }
  return store;
}

test("sql cold build table counts match JavaIndexStore", async () => {
  const store = await memoryStoreFromFixtures();
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    const result = await runSqlColdBuild({ repoRoot: fixturesRoot, db, batchSize: 5 });
    assert.equal(result.ok, true);
    assert.equal(result.files, store.filesByPath.size);
    assert.equal(result.types, store.typesById.size);
    assert.equal(result.methods, store.methodsById.size);
    assert.equal(result.edges, store.edgesById.size);
    assert.equal(readMeta(db, "buildState"), "READY");
    const kgNodes = db.prepare("SELECT count(*) AS n FROM kg_node").get() as { n: number };
    const entities = db.prepare("SELECT count(*) AS n FROM entity").get() as { n: number };
    assert.ok(kgNodes.n > 0);
    assert.ok(entities.n > 0);
  } finally {
    close(db);
  }
});

test("sql cold build resumes resolve after an injected abort", async () => {
  const store = await memoryStoreFromFixtures();
  const dir = await mkdtemp(path.join(tmpdir(), "iod-cold-"));
  const dbPath = path.join(dir, "index.sqlite");
  const first = openIndexDb(dbPath);
  try {
    ensureSchema(first);
    await assert.rejects(
      () => runSqlColdBuild({
        repoRoot: fixturesRoot,
        db: first,
        batchSize: 2,
        shouldAbort: progress => progress.phase === "resolve" && progress.done >= 4
      }),
      /injected abort/
    );
    assert.equal(readMeta(first, "buildState"), "BUILDING");
    const progress = readBuildProgress(first);
    assert.ok(progress);
    assert.equal(progress.phase, "resolve");
    assert.ok(progress.done >= 4);
    assert.ok(progress.done < store.filesByPath.size);
  } finally {
    close(first);
  }

  const second = openIndexDb(dbPath);
  try {
    ensureSchema(second);
    const result = await runSqlColdBuild({ repoRoot: fixturesRoot, db: second, batchSize: 2 });
    assert.equal(result.files, store.filesByPath.size);
    assert.equal(result.types, store.typesById.size);
    assert.equal(result.methods, store.methodsById.size);
    assert.equal(result.edges, store.edgesById.size);
    assert.equal(readMeta(second, "buildState"), "READY");
  } finally {
    close(second);
  }
});

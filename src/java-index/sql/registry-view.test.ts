import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import type { JavaFileBundle } from "../index-types.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { buildTypeRegistryView, JavaNameResolver } from "../name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../parse-tree-cache.js";
import { close, openIndexDb } from "./driver.js";
import { SqlFactsStore } from "./facts-store.js";
import { buildSqlRegistryView } from "./registry-view.js";
import { ensureSchema } from "./schema.js";
import { writeBundle } from "./rows.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");

function listJavaFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".java")) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

async function parseRawBundles(): Promise<JavaFileBundle[]> {
  const backend = await createJavaParserBackend();
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  const resolvedRepoRoot = await realpath(fixturesRoot);
  const bundles: JavaFileBundle[] = [];
  for (const relativePath of listJavaFiles(fixturesRoot)) {
    bundles.push(await parseJavaSourceFile({
      repoRoot: fixturesRoot,
      resolvedRepoRoot,
      inputPath: path.join(fixturesRoot, relativePath),
      generation: 1,
      backend,
      cache
    }));
  }
  return bundles;
}

function jsonClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

test("buildSqlRegistryView matches buildTypeRegistryView for resolveFileRefs and buildStaticEdges", async () => {
  const bundles = await parseRawBundles();
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    for (const bundle of bundles) writeBundle(db, bundle);
    const sqlView = buildSqlRegistryView(new SqlFactsStore(db));
    const memView = buildTypeRegistryView(
      bundles.flatMap(bundle => bundle.types),
      bundles.flatMap(bundle => bundle.methods)
    );
    const sqlResolver = new JavaNameResolver(sqlView);
    const memResolver = new JavaNameResolver(memView);
    for (const raw of bundles) {
      const sqlResolved = resolveFileRefs(structuredClone(raw), sqlResolver, sqlView);
      const memResolved = resolveFileRefs(structuredClone(raw), memResolver, memView);
      assert.deepEqual(jsonClone(sqlResolved), jsonClone(memResolved), raw.file.relativePath);
      assert.deepEqual(
        jsonClone(buildStaticEdges(sqlResolved, sqlView, sqlResolver)),
        jsonClone(buildStaticEdges(memResolved, memView, memResolver)),
        `edges:${raw.file.relativePath}`
      );
    }
  } finally {
    close(db);
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JavaIndexStore } from "../index-store.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import type { JavaFileBundle } from "../index-types.js";
import { extractMyBatisMapperFacts } from "../mybatis-xml-extractor.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../parse-tree-cache.js";
import { close, openIndexDb } from "./driver.js";
import { ensureSchema } from "./schema.js";
import { readBundle, readMyBatisResource, writeBundle, writeMyBatisResource } from "./rows.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");

function listFiles(root: string, suffix: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(suffix)) out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

async function parseFixtures(): Promise<JavaFileBundle[]> {
  const backend = await createJavaParserBackend();
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  const resolvedRepoRoot = await realpath(fixturesRoot);
  const bundles: JavaFileBundle[] = [];
  for (const relativePath of listFiles(fixturesRoot, ".java")) {
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

test("writeBundle/readBundle round-trips java-index-v2 and matches JavaIndexStore.files()", async () => {
  const bundles = await parseFixtures();
  assert.equal(bundles.length, 27);
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    const store = new JavaIndexStore();
    for (const bundle of bundles) {
      writeBundle(db, bundle);
      const read = readBundle(db, bundle.file.relativePath);
      assert.deepEqual(read, bundle, bundle.file.relativePath);
      store.replaceFile(structuredClone(bundle));
      assert.deepEqual(store.files([bundle.file.relativePath])[0], read, bundle.file.relativePath);
    }
    const first = bundles[0]!;
    const rewritten = { ...first, file: { ...first.file, generation: 2, contentHash: "rewritten" } };
    writeBundle(db, rewritten);
    assert.deepEqual(readBundle(db, first.file.relativePath)?.file.generation, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM file WHERE path=?").get(first.file.relativePath)?.n, 1);
  } finally {
    close(db);
  }
});

test("myBatisRow round-trips java-index-v2 mapper XML", () => {
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    for (const relativePath of listFiles(fixturesRoot, ".xml").filter(p => p.includes("/mapper/"))) {
      const content = readFileSync(path.join(fixturesRoot, relativePath), "utf8");
      const resource = extractMyBatisMapperFacts({
        relativePath,
        content,
        contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
        generation: 1
      });
      assert.ok(resource, relativePath);
      writeMyBatisResource(db, resource);
      assert.deepEqual(readMyBatisResource(db, relativePath), resource, relativePath);
    }
  } finally {
    close(db);
  }
});

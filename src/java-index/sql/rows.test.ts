import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseJavaSourceFile } from "../java-index-file-parse.js";
import type { JavaFileBundle } from "../index-types.js";
import { extractMyBatisMapperFacts } from "../mybatis-xml-extractor.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../builder/parse-cache.js";
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
    for (const bundle of bundles) {
      writeBundle(db, bundle);
      const read = readBundle(db, bundle.file.relativePath);
      assert.deepEqual(read, bundle, bundle.file.relativePath);
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

async function parseSameFqnDuplicateModules(backend: Awaited<ReturnType<typeof createJavaParserBackend>>, cache: ParseTreeCache, root: string): Promise<{ a: JavaFileBundle; b: JavaFileBundle }> {
  const files = [
    { rel: "modA/src/main/java/demo/Shared.java", body: "package demo;\npublic class Shared {\n  void saveA() {\n  }\n  int valueA = 1;\n}\n" },
    { rel: "modB/src/main/java/demo/Shared.java", body: "package demo;\npublic class Shared {\n  void saveB() {\n  }\n  int valueB = 2;\n}\n" }
  ];
  const bundles = [] as JavaFileBundle[];
  for (const file of files) {
    await mkdir(path.join(root, path.dirname(file.rel)), { recursive: true });
    await writeFile(path.join(root, file.rel), file.body, "utf8");
    bundles.push(await parseJavaSourceFile({
      repoRoot: root,
      resolvedRepoRoot: await realpath(root),
      inputPath: path.join(root, file.rel),
      generation: 1,
      backend,
      cache
    }));
  }
  return { a: bundles[0]!, b: bundles[1]! };
}

function sortedTypeIds(db: import("node:sqlite").DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT s.text AS id FROM type t JOIN sym s ON s.id=t.sym ORDER BY s.text"
  ).all() as Array<{ id: string }>;
  return rows.map(row => row.id);
}

test("T02: parser-produced same-FQN declarations in different modules keep distinct source-scoped IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "java-index-t02-samefqn-"));
  try {
    const backend = await createJavaParserBackend();
    const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 4 });
    const { a, b } = await parseSameFqnDuplicateModules(backend, cache, root);
    assert.equal(a.types[0]!.fqn, "demo.Shared");
    assert.equal(b.types[0]!.fqn, "demo.Shared");
    const idA = a.types[0]!.typeId;
    const idB = b.types[0]!.typeId;
    assert.notEqual(idA, idB, "two parser-produced declarations with the same FQN must have distinct source-scoped ids");
    const db = openIndexDb(":memory:");
    try {
      ensureSchema(db);
      writeBundle(db, a);
      writeBundle(db, b);
      const types = db.prepare("SELECT count(*) AS n FROM type").get() as { n: number };
      assert.equal(types.n, 2, "each same-FQN declaration keeps its own type row");
      // Deleting file A's row (writeBundle's delete-then-insert path) must not
      // touch B's declaration or facts.
      db.prepare("DELETE FROM file WHERE path=?").run(a.file.relativePath);
      const remaining = db.prepare("SELECT count(*) AS n FROM type").get() as { n: number };
      assert.equal(remaining.n, 1);
      const readB = readBundle(db, b.file.relativePath);
      assert.ok(readB);
      assert.ok(readB.types.some(type => type.typeId === idB), "B's declaration survives A's deletion");
      assert.equal(readB!.methods.some(m => m.methodId.endsWith("#saveB()")), true);
    } finally {
      close(db);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T02: AB and BA write orders produce the same ownership set", async () => {
  const backend = await createJavaParserBackend();
  const rootA = await mkdtemp(path.join(os.tmpdir(), "java-index-t02-ab-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "java-index-t02-ba-"));
  try {
    const ab = await parseSameFqnDuplicateModules(backend, new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 4 }), rootA);
    const ba = await parseSameFqnDuplicateModules(backend, new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 4 }), rootB);
    const dbAb = openIndexDb(":memory:");
    const dbBa = openIndexDb(":memory:");
    try {
      ensureSchema(dbAb);
      ensureSchema(dbBa);
      writeBundle(dbAb, ab.a);
      writeBundle(dbAb, ab.b);
      writeBundle(dbBa, ba.b);
      writeBundle(dbBa, ba.a);
      const namesAb = sortedTypeIds(dbAb as unknown as import("node:sqlite").DatabaseSync);
      const namesBa = sortedTypeIds(dbBa as unknown as import("node:sqlite").DatabaseSync);
      assert.equal(namesAb.length, 2);
      assert.equal(namesBa.length, 2);
      assert.deepEqual(namesAb, namesBa, "ownership set must not depend on write order");
    } finally {
      close(dbAb);
      close(dbBa);
    }
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("artificially injected identical type_id keeps the documented last-write-wins conflict policy", async () => {
  const bundles = await parseFixtures();
  const first = bundles[0]!;
  assert.ok(first.types.length > 0);
  const second = structuredClone(first);
  second.file = { ...second.file, relativePath: "dup/" + first.file.relativePath };
  // Inject the SAME declaration ids into the second file: a manual collision
  // (the parser never produces this for distinct source files).
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    writeBundle(db, first);
    writeBundle(db, second);
    const files = db.prepare("SELECT count(*) AS n FROM file").get() as { n: number };
    const types = db.prepare("SELECT count(*) AS n FROM type").get() as { n: number };
    const owner = db.prepare(
      "SELECT f.path AS path FROM type t JOIN file f ON f.id=t.file_id JOIN sym s ON s.id=t.sym WHERE s.text=?"
    ).get(first.types[0]!.typeId) as { path: string };
    assert.equal(files.n, 2);
    assert.equal(types.n, first.types.length);
    assert.equal(owner.path, second.file.relativePath);
  } finally {
    close(db);
  }
});

const NO_FACTS_TABLES = ["edge", "kg_node", "kg_edge", "entity"] as const;
const TEXT_BLOB_ALLOW = new Set([
  "meta.key", "meta.value",
  "sym.text",
  "file.path", "file.content_hash", "file.source_root", "file.module", "file.package", "file.parse_state", "file.facts",
  "type.fqn", "type.simple_name", "type.kind", "type.facts",
  "field.name", "field.facts",
  "method.name", "method.facts",
  "kg_node.simple_name",
  "kg_summary.facts",
  "entity.kind", "entity.fqn", "entity.simple_name", "entity.simple_name_lc",
  "mybatis_resource.path", "mybatis_resource.namespace", "mybatis_resource.content_hash", "mybatis_resource.facts",
  "source_root_coverage.root", "source_root_coverage.state"
]);

test("schema v3 has no facts on reconstructable tables and no extra TEXT/BLOB columns", () => {
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all() as Array<{
        name: string;
        type: string;
      }>;
      if ((NO_FACTS_TABLES as readonly string[]).includes(name)) {
        assert.equal(columns.some(column => column.name === "facts"), false, `${name}.facts`);
      }
      for (const column of columns) {
        const affinity = column.type.toUpperCase();
        if (affinity !== "TEXT" && affinity !== "BLOB") continue;
        assert.ok(TEXT_BLOB_ALLOW.has(`${name}.${column.name}`), `${name}.${column.name} ${column.type}`);
      }
    }
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

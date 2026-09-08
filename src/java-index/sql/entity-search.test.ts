import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import { recordsFromBundle, type EntityRecord } from "../entity-search.js";
import { searchEntities } from "../../test-support/entity-search-oracle.js";
import type { JavaFileBundle, JavaTypeFacts } from "../index-types.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { buildTypeRegistryView, JavaNameResolver } from "../name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../builder/parse-cache.js";
import { close, openIndexDb } from "./driver.js";
import { replaceAllEntities } from "./entity-tokens.js";
import { SqlEntitySearch } from "./entity-search.js";
import { ensureSchema } from "./schema.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "..", "fixtures", "java-index-v2");
const goldenPath = path.resolve(dirname, "..", "..", "..", "golden", "java-index-v2.scenarios.jsonl");

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

async function loadRecords(): Promise<EntityRecord[]> {
  const backend = await createJavaParserBackend();
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  const resolvedRepoRoot = await realpath(fixturesRoot);
  const parsed: JavaFileBundle[] = [];
  for (const relativePath of listJavaFiles(fixturesRoot)) {
    parsed.push(await parseJavaSourceFile({
      repoRoot: fixturesRoot,
      resolvedRepoRoot,
      inputPath: path.join(fixturesRoot, relativePath),
      generation: 1,
      backend,
      cache
    }));
  }
  const registry = buildTypeRegistryView(parsed.flatMap(bundle => bundle.types), parsed.flatMap(bundle => bundle.methods));
  const resolver = new JavaNameResolver(registry);
  const byId = registry.byId as Map<string, JavaTypeFacts>;
  const records: EntityRecord[] = [];
  for (const raw of parsed) {
    const next = resolveFileRefs(raw, resolver, registry);
    for (const type of next.types) byId.set(type.typeId, type);
    records.push(...recordsFromBundle({ ...next, edges: buildStaticEdges(next, registry, resolver) }));
  }
  return records;
}

function goldenTasks(): string[] {
  const lines = readFileSync(goldenPath, "utf8").split("\n").filter(Boolean);
  const tasks: string[] = [];
  for (const line of lines) {
    const row = JSON.parse(line) as { name?: string; anchor?: { taskKeywords?: string[] } };
    if (row.name) tasks.push(row.name);
    const keywords = row.anchor?.taskKeywords ?? [];
    if (keywords.length > 0) tasks.push(keywords.join(" "));
  }
  return tasks;
}

function collectTasks(records: readonly EntityRecord[]): string[] {
  const tasks = new Set<string>([
    "",
    "the",
    "zzzz-no-such-token",
    "please open demo.pay.ApplyPayService for the Pay flow",
    ...goldenTasks()
  ]);
  for (const entity of records) {
    tasks.add(entity.simpleName);
    if (entity.fqn) {
      tasks.add(entity.fqn);
      tasks.add(`please inspect ${entity.fqn}`);
    }
  }
  return [...tasks];
}

test("SqlEntitySearch matches searchEntities on java-index-v2 for ≥50 tasks", async () => {
  const records = await loadRecords();
  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    replaceAllEntities(db, records);
    const sql = new SqlEntitySearch(db);
    const tasks = collectTasks(records);
    assert.ok(tasks.length >= 50, `need ≥50 tasks, got ${tasks.length}`);
    for (const task of tasks) {
      assert.deepEqual(sql.search(task), searchEntities(records, task), task);
      assert.deepEqual(sql.search(task, 1), searchEntities(records, task, 1), `limit1:${task}`);
      assert.deepEqual(sql.search(task, 99), searchEntities(records, task, 99), `limit99:${task}`);
    }
    assert.deepEqual(sql.search("OrderService", 0), searchEntities(records, "OrderService", 0));
    assert.equal(sql.search("OrderService", 0).length, sql.search("OrderService", 1).length);
  } finally {
    close(db);
  }
});

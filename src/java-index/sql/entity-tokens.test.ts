import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import { recordsFromBundle, type EntityRecord } from "../entity-search.js";
import type { JavaFileBundle, JavaTypeFacts } from "../index-types.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { buildTypeRegistryView, JavaNameResolver } from "../name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../parse-tree-cache.js";
import { close, openIndexDb } from "./driver.js";
import { readEntityRecords, replaceAllEntities } from "./entity-tokens.js";
import { ensureSchema } from "./schema.js";

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

function sortedTokens(tokens: readonly string[]): string[] {
  return [...tokens].sort();
}

test("SQL entity rows round-trip recordsFromBundle", async () => {
  const expected = await loadRecords();

  const db = openIndexDb(":memory:");
  try {
    ensureSchema(db);
    replaceAllEntities(db, expected);
    const actual = readEntityRecords(db);
    assert.equal(actual.length, expected.length);
    const normalize = (records: readonly EntityRecord[]) => records
      .map(record => ({
        entityId: record.entityId,
        kind: record.kind,
        fqn: record.fqn,
        identifierTokens: sortedTokens(record.identifierTokens),
        chunkTokens: sortedTokens(record.chunkTokens)
      }))
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    assert.deepEqual(normalize(actual), normalize(expected));
  } finally {
    close(db);
  }
});

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStaticEdges, resolveFileRefs } from "./edge-builder.js";
import type { FactsReader } from "./facts-reader.js";
import { JavaIndexStore } from "./index-store.js";
import type { JavaFileBundle, JavaTypeFacts, JavaTypeRef } from "./index-types.js";
import { parseJavaSourceFile } from "./java-index-file-parse.js";
import { createJavaParserBackend } from "./java-parser-backend.js";
import { buildTypeRegistryView, JavaNameResolver } from "./name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "./parse-tree-cache.js";
import type { GraphReader } from "../java-knowledge/graph-reader.js";
import { KnowledgeGraphStore } from "../java-knowledge/graph-store.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(dirname, "..", "..", "fixtures", "java-index-v2");

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

async function loadStore(): Promise<JavaIndexStore> {
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
  const store = new JavaIndexStore();
  const resolved: JavaFileBundle[] = [];
  for (const raw of parsed) {
    const next = resolveFileRefs(raw, resolver, registry);
    for (const type of next.types) byId.set(type.typeId, type);
    resolved.push({ ...next, edges: [] });
  }
  for (const bundle of resolved) {
    store.replaceFile({ ...bundle, edges: buildStaticEdges(bundle, registry, resolver) });
  }
  return store;
}

function relativePathOfFileId(fileId: string): string {
  return fileId.startsWith("file:") ? fileId.slice("file:".length) : fileId;
}

function resolvedRepoTypeIds(ref: JavaTypeRef | undefined): string[] {
  if (!ref) return [];
  const ids: string[] = [];
  if (ref.resolution.state === "RESOLVED_REPO") ids.push(ref.resolution.typeId);
  for (const argument of ref.typeArguments) ids.push(...resolvedRepoTypeIds(argument));
  return ids;
}

function scanRefTargetsType(
  store: JavaIndexStore,
  ref: JavaTypeRef,
  target: JavaTypeFacts,
  implementerFile?: string
): boolean {
  if (resolvedRepoTypeIds(ref).includes(target.typeId)) return true;
  if (ref.simpleName !== target.simpleName) return false;
  if (target.fqn && ref.qualifiedName === target.fqn) return true;
  const ids = store.typeIdsBySimpleName.get(ref.simpleName);
  if (ids && ids.size === 1 && [...ids][0] === target.typeId) return true;
  if (!implementerFile || !target.fqn) return false;
  const file = store.filesByPath.get(implementerFile);
  return Boolean(file?.imports.some(item => item.qualifiedName === target.fqn));
}

function scanImplementersOfAny(store: JavaIndexStore, typeIds: readonly string[]): string[] {
  const targets = typeIds.map(id => store.typesById.get(id)).filter((type): type is JavaTypeFacts => Boolean(type));
  if (targets.length === 0) return [];
  const hits: string[] = [];
  for (const type of store.typesById.values()) {
    const refs = [...type.implements, ...type.extends];
    if (refs.length === 0) continue;
    const implementerFile = relativePathOfFileId(type.fileId);
    if (targets.some(target => refs.some(ref => scanRefTargetsType(store, ref, target, implementerFile)))) {
      hits.push(type.typeId);
    }
  }
  return hits;
}

function scanTypesBySimpleNameOrFqn(store: JavaIndexStore, simple: string, fqn: string): JavaTypeFacts[] {
  return [...store.typesById.values()].filter(type => type.simpleName === simple || type.fqn === fqn);
}

test("JavaIndexStore is a FactsReader and KnowledgeGraphStore is a GraphReader", () => {
  const store: FactsReader = new JavaIndexStore();
  const graph: GraphReader = new KnowledgeGraphStore();
  assert.equal(store.typesById.size, 0);
  assert.equal(graph.nodesById.size, 0);
});

test("heap implementersOfAny and typesBySimpleNameOrFqn match the linear scan on java-index-v2", async () => {
  const store = await loadStore();
  assert.ok(store.typesById.size > 0);
  const typeIds = [...store.typesById.keys()];
  assert.deepEqual(store.implementersOfAny([]), []);
  assert.deepEqual(store.implementersOfAny(["missing-type"]), []);
  assert.deepEqual(store.implementersOfAny(typeIds).sort(), scanImplementersOfAny(store, typeIds).sort());
  for (const typeId of typeIds) {
    const type = store.typesById.get(typeId)!;
    assert.deepEqual(
      store.implementersOfAny([typeId]).sort(),
      scanImplementersOfAny(store, [typeId]).sort(),
      `any:${typeId}`
    );
    const expected = scanTypesBySimpleNameOrFqn(store, type.simpleName, type.fqn ?? type.simpleName)
      .map(item => item.typeId)
      .sort();
    assert.deepEqual(
      store.typesBySimpleNameOrFqn(type.simpleName, type.fqn ?? type.simpleName).map(item => item.typeId).sort(),
      expected,
      `name:${type.simpleName}`
    );
  }
});

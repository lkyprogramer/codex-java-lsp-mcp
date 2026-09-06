import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import { JavaIndexStore } from "../index-store.js";
import type { JavaFileBundle } from "../index-types.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { myBatisQualifiedId, type MyBatisMapperResourceFacts } from "../mybatis-types.js";
import { extractMyBatisMapperFacts } from "../mybatis-xml-extractor.js";
import { buildTypeRegistryView, JavaNameResolver } from "../name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../parse-tree-cache.js";
import { close, openIndexDb, type IndexDatabase } from "./driver.js";
import { SqlFactsStore } from "./facts-store.js";
import { ensureSchema } from "./schema.js";
import { writeBundle, writeMyBatisResource } from "./rows.js";

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

async function loadResolvedBundles(): Promise<JavaFileBundle[]> {
  const backend = await createJavaParserBackend();
  const cache = new ParseTreeCache({ ...DEFAULT_PARSE_TREE_CACHE_OPTIONS, maxEntries: 8 });
  const resolvedRepoRoot = await realpath(fixturesRoot);
  const parsed: JavaFileBundle[] = [];
  for (const relativePath of listFiles(fixturesRoot, ".java")) {
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
  return parsed.map(raw => {
    const resolved = resolveFileRefs(raw, resolver, registry);
    const resolvedRegistry = buildTypeRegistryView(resolved.types, resolved.methods);
    return { ...resolved, edges: buildStaticEdges(resolved, resolvedRegistry, resolver) };
  });
}

function loadMyBatis(): MyBatisMapperResourceFacts[] {
  return listFiles(fixturesRoot, ".xml")
    .filter(relativePath => relativePath.includes("/mapper/"))
    .map(relativePath => {
      const content = readFileSync(path.join(fixturesRoot, relativePath), "utf8");
      return extractMyBatisMapperFacts({
        relativePath,
        content,
        contentHash: createHash("sha256").update(content, "utf8").digest("hex"),
        generation: 1
      });
    })
    .filter((resource): resource is MyBatisMapperResourceFacts => resource !== undefined);
}

function fill(store: JavaIndexStore, db: IndexDatabase, bundles: JavaFileBundle[]): SqlFactsStore {
  ensureSchema(db);
  for (const bundle of bundles) {
    store.replaceFile(bundle);
    writeBundle(db, bundle);
  }
  for (const resource of loadMyBatis()) {
    store.replaceMyBatisResource(resource);
    writeMyBatisResource(db, resource);
  }
  return new SqlFactsStore(db);
}

function jsonClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function sorted<T>(values: Iterable<T>): T[] {
  return [...values].sort();
}

test("SqlFactsStore point lookups, files, mybatis, and iterators match JavaIndexStore", async () => {
  const bundles = await loadResolvedBundles();
  const db = openIndexDb(":memory:");
  try {
    const store = new JavaIndexStore();
    const sql = fill(store, db, bundles);
    const paths = bundles.map(bundle => bundle.file.relativePath);
    const typeIds = [...store.typesById.keys()];
    const methodIds = [...store.methodsById.values()].map(method => method.methodId);
    const fieldIds = [...store.fieldsById.keys()];

    assert.equal(sql.filesByPath.size, store.filesByPath.size);
    assert.equal(sql.typesById.size, store.typesById.size);
    assert.equal(sql.methodsById.size, store.methodsById.size);
    assert.equal(sql.fieldsById.size, store.fieldsById.size);
    assert.equal(sql.typeIdByFqn.size, store.typeIdByFqn.size);
    assert.equal(sql.typeIdsBySimpleName.size, store.typeIdsBySimpleName.size);
    assert.equal(sql.methodIdsByOwnerAndName.size, store.methodIdsByOwnerAndName.size);

    assert.equal(sql.file("missing.java"), undefined);
    assert.deepEqual(sql.files(["missing.java", ...paths, "also-missing.java"]).map(bundle => bundle.file.relativePath), paths);
    assert.deepEqual(sql.files(paths), jsonClone(store.files(paths)));

    for (const path of paths) {
      assert.equal(sql.filesByPath.has(path), true);
      assert.deepEqual(sql.file(path), jsonClone(store.file(path)), path);
      assert.deepEqual(sql.files([path]), jsonClone(store.files([path])), path);
    }

    for (const typeId of typeIds) {
      assert.equal(sql.typesById.has(typeId), true);
      assert.deepEqual(sql.typesById.get(typeId), jsonClone(store.typesById.get(typeId)), typeId);
      const type = store.typesById.get(typeId)!;
      if (type.fqn) {
        assert.equal(sql.typeIdByFqn.get(type.fqn), typeId);
        assert.deepEqual(sql.typeByFqn(type.fqn), jsonClone(store.typeByFqn(type.fqn)));
      }
      assert.deepEqual(sql.methodsOfOwner(typeId), jsonClone(store.methodsOfOwner(typeId)), typeId);
      assert.deepEqual(sorted(sql.typeIdsBySimpleName.get(type.simpleName) ?? []), sorted(store.typeIdsBySimpleName.get(type.simpleName) ?? []));
    }

    for (const methodId of methodIds) {
      assert.equal(sql.methodsById.has(methodId), true);
      assert.deepEqual(sql.methodsById.get(methodId), jsonClone(store.methodsById.get(methodId)), methodId);
      const method = store.methodsById.get(methodId)!;
      const key = `${method.ownerTypeId}#${method.name}`;
      assert.deepEqual(sorted(sql.methodIdsByOwnerAndName.get(key) ?? []), sorted(store.methodIdsByOwnerAndName.get(key) ?? []), key);
    }

    for (const fieldId of fieldIds) {
      assert.equal(sql.fieldsById.has(fieldId), true);
      assert.deepEqual(sql.fieldsById.get(fieldId), jsonClone(store.fieldsById.get(fieldId)), fieldId);
    }

    assert.equal([...sql.iterFiles()].length, store.filesByPath.size);
    assert.equal([...sql.iterTypes()].length, store.typesById.size);
    assert.equal([...sql.iterFields()].length, store.fieldsById.size);
    assert.equal([...sql.iterMethods()].length, store.methodsById.size);
    assert.equal([...sql.iterEdges()].length, store.edgesById.size);

    for (const resource of loadMyBatis()) {
      assert.deepEqual(sql.myBatisResource(resource.relativePath), jsonClone(store.myBatisResource(resource.relativePath)));
      assert.deepEqual(sql.myBatisResourceForNamespace(resource.namespace), jsonClone(store.myBatisResourceForNamespace(resource.namespace)));
      for (const statement of resource.statements) {
        assert.deepEqual(
          sql.myBatisStatement(myBatisQualifiedId(resource.namespace, statement.id)),
          jsonClone(store.myBatisStatement(resource.namespace, statement.id))
        );
      }
    }
  } finally {
    close(db);
  }
});

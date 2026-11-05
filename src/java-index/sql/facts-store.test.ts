import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { realpath, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildStaticEdges, resolveFileRefs } from "../edge-builder.js";
import type { FactsIter, FactsReader } from "../facts-reader.js";

import type { JavaFileBundle, JavaTypeFacts, JavaTypeRef, StaticEdgeKind } from "../index-types.js";
import { parseJavaSourceFile } from "../java-index-file-parse.js";
import { createJavaParserBackend } from "../java-parser-backend.js";
import { myBatisQualifiedId, type MyBatisMapperResourceFacts } from "../mybatis-types.js";
import { extractMyBatisMapperFacts } from "../mybatis-xml-extractor.js";
import { buildTypeRegistryView, JavaNameResolver } from "../name-resolver.js";
import { DEFAULT_PARSE_TREE_CACHE_OPTIONS, ParseTreeCache } from "../builder/parse-cache.js";
import { close, openIndexDb, type IndexDatabase } from "./driver.js";
import { SqlFactsStore } from "./facts-store.js";
import { ensureSchema } from "./schema.js";
import { updateBundleFacts, writeBundle, writeMyBatisResource } from "./rows.js";

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

function fill(db: IndexDatabase, bundles: JavaFileBundle[]): SqlFactsStore {
  ensureSchema(db);
  for (const bundle of bundles) writeBundle(db, bundle);
  for (const resource of loadMyBatis()) writeMyBatisResource(db, resource);
  return new SqlFactsStore(db);
}

function jsonClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function sorted<T>(values: Iterable<T>): T[] {
  return [...values].sort();
}

test("forgetFile drops every cached read one file's rewritten facts fed, and nothing else", async () => {
  const bundles = await loadResolvedBundles();
  const db = openIndexDb(":memory:");
  try {
    const store = fill(db, bundles);
    const bundle = bundles.find(item => item.fields.length > 0 && item.methods.length > 0)!;
    const other = bundles.find(item => item !== bundle && item.types.length > 0)!;
    const type = bundle.types.find(item => item.methodIds.length > 0)!;
    const method = bundle.methods.find(item => item.ownerTypeId === type.typeId)!;
    const field = bundle.fields[0]!;
    const otherType = other.types[0]!;
    const read = () => ({
      file: store.filesByPath.get(bundle.file.relativePath)?.contentHash,
      type: store.typesById.get(type.typeId)?.modifiers,
      method: store.methodsById.get(method.methodId)?.modifiers,
      owned: store.methodsOfOwner(type.typeId).find(item => item.methodId === method.methodId)?.modifiers,
      field: store.fieldsById.get(field.fieldId)?.modifiers,
      other: store.typesById.get(otherType.typeId)?.modifiers
    });
    const cached = read();
    const mark = <T extends { modifiers: string[] }>(item: T): T => ({ ...item, modifiers: [...item.modifiers, "strictfp"] });
    updateBundleFacts(db, {
      ...bundle,
      file: { ...bundle.file, contentHash: "rewritten" },
      types: bundle.types.map(mark),
      methods: bundle.methods.map(mark),
      fields: bundle.fields.map(mark)
    });
    assert.deepEqual(read(), cached, "reads before forgetFile come from the cache");
    const otherBefore = store.typesById.get(otherType.typeId);
    store.forgetFile(bundle);
    const after = read();
    assert.equal(after.file, "rewritten");
    for (const key of ["type", "method", "owned", "field"] as const) assert.ok(after[key]?.includes("strictfp"), key);
    assert.equal(store.typesById.get(otherType.typeId), otherBefore, "another file's entry stays cached");
  } finally {
    close(db);
  }
});

test("SqlFactsStore point lookups, files, mybatis, and iterators match JavaIndexStore", async () => {
  const bundles = await loadResolvedBundles();
  const db = openIndexDb(":memory:");
  try {
    const sql = fill(db, bundles);
    const store = sql;
    const asReader: FactsReader = sql;
    const asHeap: FactsReader = store;
    const asIter: FactsReader & FactsIter = sql;
    const asHeapIter: FactsReader & FactsIter = store;
    assert.equal(asReader.typesById.size, asHeap.typesById.size);
    assert.equal([...asIter.iterFiles()].length, [...asHeapIter.iterFiles()].length);
    const paths = bundles.map(bundle => bundle.file.relativePath);
    const typeIds = [...sql.iterTypes()].map(type => type.typeId);
    const heapRegistry = buildTypeRegistryView(bundles.flatMap(bundle => bundle.types), [], undefined, bundles.map(bundle => bundle.file));
    const methodIds = [...sql.iterMethods()].map(method => method.methodId);
    const fieldIds = [...sql.iterFields()].map(field => field.fieldId);

    assert.equal(sql.filesByPath.size, store.filesByPath.size);
    assert.equal(sql.typesById.size, store.typesById.size);
    assert.equal(sql.methodsById.size, store.methodsById.size);
    assert.equal(sql.fieldsById.size, store.fieldsById.size);
    assert.equal(sql.typeIdsByFqn.size, store.typeIdsByFqn.size);
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
        // Every declaration of the FQN, never a single winner; SQL and the
        // in-memory registry list the same candidates.
        assert.ok(sql.typeIdsByFqn.get(type.fqn)?.includes(typeId), typeId);
        assert.deepEqual([...(sql.typeIdsByFqn.get(type.fqn) ?? [])], [...(heapRegistry.byFqn.get(type.fqn) ?? [])], type.fqn);
        assert.deepEqual(sql.typesByFqn(type.fqn).map(found => found.typeId), [...(sql.typeIdsByFqn.get(type.fqn) ?? [])]);
        const file = sql.file(relativePathOfFileId(type.fileId))!;
        assert.deepEqual(sql.declarationLocation(typeId), { module: file.module, sourceSet: file.sourceSet, sourceRoot: file.sourceRoot });
        assert.deepEqual(heapRegistry.locationOf(typeId), sql.declarationLocation(typeId));
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
    assert.equal([...sql.iterEdges()].length, [...store.iterEdges()].length);

    for (const resource of loadMyBatis()) {
      assert.deepEqual(sql.myBatisResource(resource.relativePath), jsonClone(store.myBatisResource(resource.relativePath)));
      assert.deepEqual(sql.myBatisResourceForNamespace(resource.namespace), jsonClone(store.myBatisResourceForNamespace(resource.namespace)));
      for (const statement of resource.statements) {
        const qid = myBatisQualifiedId(resource.namespace, statement.id);
        assert.deepEqual(sql.myBatisStatement(qid), jsonClone(store.myBatisStatement(qid)));
      }
    }
  } finally {
    close(db);
  }
});

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

function refTargetsType(ref: JavaTypeRef, target: JavaTypeFacts, store: SqlFactsStore, implementerFile?: string): boolean {
  if (resolvedRepoTypeIds(ref).includes(target.typeId)) return true;
  if (ref.simpleName !== target.simpleName) return false;
  if (target.fqn && ref.qualifiedName === target.fqn) return true;
  const ids = store.typeIdsBySimpleName.get(ref.simpleName);
  if (ids && ids.size === 1 && [...ids][0] === target.typeId) return true;
  if (!implementerFile || !target.fqn) return false;
  const file = store.filesByPath.get(implementerFile);
  return Boolean(file?.imports.some(item => item.qualifiedName === target.fqn));
}

function implementersOfAnyFromStore(store: SqlFactsStore, typeIds: readonly string[]): string[] {
  return store.implementersOfAny(typeIds);
}

function typesBySimpleNameOrFqnFromStore(store: SqlFactsStore, simple: string, fqn: string): JavaTypeFacts[] {
  return [...store.iterTypes()].filter(type => type.simpleName === simple || type.fqn === fqn);
}

const REFERENCE_KINDS: StaticEdgeKind[][] = [
  ["IMPLEMENTS"],
  ["EXTENDS"],
  ["CALLS"],
  ["PARAM_TYPE"],
  ["RETURN_TYPE"],
  ["FIELD_TYPE"],
  ["ANNOTATED_WITH"],
  ["IMPLEMENTS", "EXTENDS"]
];

test("SqlFactsStore reference queries, anchor, and typeLookup match JavaIndexStore", async () => {
  const bundles = await loadResolvedBundles();
  const db = openIndexDb(":memory:");
  try {
    const sql = fill(db, bundles);
    const store = sql;
    const typeIds = [...sql.iterTypes()].map(type => type.typeId);
    const methodIds = [...sql.iterMethods()].map(method => method.methodId);
    const fieldIds = [...sql.iterFields()].map(field => field.fieldId);

    assert.equal(sql.anchor("missing.java", 1, 1), undefined);
    assert.deepEqual(sql.repositoryFactMarkers([], []), store.repositoryFactMarkers([], []));
    assert.deepEqual(
      sql.repositoryFactMarkers(["org.springframework"], ["org.springframework"]),
      store.repositoryFactMarkers(["org.springframework"], ["org.springframework"])
    );

    for (const typeId of typeIds) {
      assert.deepEqual(jsonClone(sql.implementers(typeId)), jsonClone(store.implementers(typeId)), typeId);
      assert.deepEqual(jsonClone(sql.implementers(typeId, 1)), jsonClone(store.implementers(typeId, 1)), `${typeId}:limit1`);
      for (const kinds of REFERENCE_KINDS) {
        const set = new Set(kinds);
        assert.deepEqual(jsonClone(sql.typeReferencers(typeId, set)), jsonClone(store.typeReferencers(typeId, set)), `${typeId}:${kinds.join(",")}`);
      }
      const type = store.typesById.get(typeId)!;
      const scope = relativePathOfFileId(type.fileId);
      assert.deepEqual(jsonClone(sql.typeLookup(type.simpleName, scope)), jsonClone(store.typeLookup(type.simpleName, scope)), type.simpleName);
      if (type.fqn) {
        assert.deepEqual(jsonClone(sql.typeLookup(type.fqn, scope)), jsonClone(store.typeLookup(type.fqn, scope)), type.fqn);
      }
      const start = type.range.start;
      assert.deepEqual(jsonClone(sql.anchor(scope, start.line, start.column)), jsonClone(store.anchor(scope, start.line, start.column)), `anchor:${typeId}`);
      assert.deepEqual(
        sorted(sql.typesBySimpleNameOrFqn(type.simpleName, type.fqn ?? type.simpleName).map(item => item.typeId)),
        sorted(typesBySimpleNameOrFqnFromStore(store, type.simpleName, type.fqn ?? type.simpleName).map(item => item.typeId))
      );
    }

    for (const methodId of methodIds) {
      assert.deepEqual(jsonClone(sql.callers(methodId)), jsonClone(store.callers(methodId)), `callers:${methodId}`);
      assert.deepEqual(jsonClone(sql.callers(methodId, 1)), jsonClone(store.callers(methodId, 1)), `callers1:${methodId}`);
      assert.deepEqual(jsonClone(sql.callees(methodId)), jsonClone(store.callees(methodId)), `callees:${methodId}`);
      assert.deepEqual(jsonClone(sql.callees(methodId, 1)), jsonClone(store.callees(methodId, 1)), `callees1:${methodId}`);
      const method = store.methodsById.get(methodId)!;
      const owner = store.typesById.get(method.ownerTypeId);
      if (owner) {
        const scope = relativePathOfFileId(owner.fileId);
        const start = method.range.start;
        assert.deepEqual(jsonClone(sql.anchor(scope, start.line, start.column)), jsonClone(store.anchor(scope, start.line, start.column)), `anchor:${methodId}`);
      }
    }

    for (const fieldId of fieldIds) {
      const field = store.fieldsById.get(fieldId)!;
      const owner = store.typesById.get(field.ownerTypeId);
      if (!owner) continue;
      const scope = relativePathOfFileId(owner.fileId);
      const start = field.range.start;
      assert.deepEqual(jsonClone(sql.anchor(scope, start.line, start.column)), jsonClone(store.anchor(scope, start.line, start.column)), `anchor:${fieldId}`);
    }

    for (const path of bundles.map(bundle => bundle.file.relativePath)) {
      assert.deepEqual(jsonClone(sql.anchor(path, 9999, 1)), jsonClone(store.anchor(path, 9999, 1)), `file-anchor:${path}`);
    }

    assert.deepEqual(sorted(sql.implementersOfAny(typeIds)), sorted(implementersOfAnyFromStore(store, typeIds)));
    assert.deepEqual(sorted(store.implementersOfAny(typeIds)), sorted(sql.implementersOfAny(typeIds)));
    assert.deepEqual(sql.implementersOfAny([]), []);
    assert.deepEqual(store.implementersOfAny([]), []);
    for (const typeId of typeIds) {
      assert.deepEqual(sorted(sql.implementersOfAny([typeId])), sorted(implementersOfAnyFromStore(store, [typeId])), `any:${typeId}`);
      assert.deepEqual(sorted(store.implementersOfAny([typeId])), sorted(sql.implementersOfAny([typeId])), `heap-sql:${typeId}`);
    }
    assert.deepEqual(sql.methodsWithParameterTypes(typeIds), store.methodsWithParameterTypes(typeIds));
    assert.deepEqual(sql.methodsWithParameterTypes(typeIds, 1), store.methodsWithParameterTypes(typeIds, 1));
    assert.deepEqual(sql.methodsWithParameterTypes([]), []);
    assert.deepEqual(jsonClone(sql.typeLookup("MissingType")), jsonClone(store.typeLookup("MissingType")));
  } finally {
    close(db);
  }
});


test("methodsNamed equals owner filtering for overloads, constructors, local owners and replaced cached facts", async()=>{
 const repo=await mkdtemp(path.join(tmpdir(),"methods-named-"));const db=openIndexDb(":memory:");ensureSchema(db);
 const backend=await createJavaParserBackend();const cache=new ParseTreeCache({...DEFAULT_PARSE_TREE_CACHE_OPTIONS,maxEntries:8});
 const file=path.join(repo,"src/main/java/demo",`nested#${"long-owner-".repeat(12)}`,"Owner.java");
 const parse=async(source:string,generation:number)=>{await writeFile(file,source);return parseJavaSourceFile({repoRoot:repo,resolvedRepoRoot:await realpath(repo),inputPath:file,generation,backend,cache});};
 try{
 await mkdir(path.dirname(file),{recursive:true});
 const original=await parse("package demo; class Owner { Owner() {} Owner(int n) {} void find() {} int find(int n) { return n; } void finder() {} void scope() { class Local { Local() {} void find() {} } } }",1);
 writeBundle(db,original);const store=new SqlFactsStore(db);
 const check=(bundle:JavaFileBundle)=>{for(const type of bundle.types){const all=store.methodsOfOwner(type.typeId);for(const name of new Set([...all.map(method=>method.name),"missing","find","finder","Owner","Local","<init>"])) assert.deepEqual(store.methodsNamed(type.typeId,name),all.filter(method=>method.name===name),`${type.typeId} ${name}`);}assert.deepEqual(store.methodsNamed("missing-owner","find"),[]);};
 const owner=original.types.find(type=>type.simpleName==="Owner")!;
 assert.equal(original.methods.filter(method=>method.ownerTypeId===owner.typeId && method.constructor).length,2);
 assert.equal(store.methodsNamed(owner.typeId,"find").length,2);assert.ok(original.types.some(type=>type.simpleName==="Local" && !type.fqn));check(original);
 const rewritten=await parse("package demo; class Owner { Owner(String s) {} void find(String s) {} void scope() { class Local { Local(int n) {} void find(int n) {} } } }",2);
 writeBundle(db,rewritten);store.forgetFile(original);check(rewritten);
 assert.equal(store.methodsNamed(owner.typeId,"find").length,1);assert.deepEqual(store.methodsNamed(owner.typeId,"finder"),[]);
 }finally{close(db);await rm(repo,{recursive:true,force:true});}
});

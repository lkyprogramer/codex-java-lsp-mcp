import assert from "node:assert/strict";
import test from "node:test";
import { JavaIndexStore } from "./index-store.js";
import { SharedFactsPool } from "./shared-facts-pool.js";
import type { JavaFileBundle, JavaFileFacts, JavaMethodFacts, JavaTypeFacts, SourceRange } from "./index-types.js";
import { javaFileId, javaMethodId, javaTypeId } from "./stable-id.js";

const RANGE: SourceRange = {
  start: { line: 1, column: 1 },
  end: { line: 2, column: 2 }
};

function fileBundle(relativePath: string, simpleName: string, contentHash: string): JavaFileBundle {
  const file: JavaFileFacts = {
    fileId: javaFileId(relativePath),
    relativePath,
    sourceRoot: "src/main/java",
    module: ".",
    sourceSet: "main",
    packageName: "demo",
    imports: [],
    topLevelTypeIds: [],
    allTypeIds: [],
    contentHash,
    size: 10,
    mtimeMs: 1,
    parseState: "COMPLETE",
    parseErrorCount: 0,
    generation: 1
  };
  const typeId = javaTypeId({ fqn: `demo.${simpleName}`, relativePath, range: RANGE });
  const type: JavaTypeFacts = {
    typeId,
    fqn: `demo.${simpleName}`,
    simpleName,
    kind: "class",
    fileId: file.fileId,
    range: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    extends: [],
    implements: [],
    permits: [],
    fieldIds: [],
    methodIds: [],
    confidence: 1
  };
  file.topLevelTypeIds.push(typeId);
  file.allTypeIds.push(typeId);
  const methodId = javaMethodId(typeId, "run()");
  const method: JavaMethodFacts = {
    methodId,
    ownerTypeId: typeId,
    name: "run",
    constructor: false,
    signatureKey: "run()",
    range: RANGE,
    modifiers: ["public"],
    annotations: [],
    typeParameters: [],
    parameters: [],
    throws: [],
    callSites: [],
    localTypes: []
  };
  type.methodIds.push(methodId);
  return { file, types: [type], fields: [], methods: [method], edges: [] };
}

test("shared facts pool refcounts and evicts at zero", () => {
  const pool = new SharedFactsPool();
  const first = fileBundle("src/main/java/demo/A.java", "A", "hash-a");
  const shared = pool.acquire("hash-a", () => first);
  assert.equal(pool.acquire("hash-a", () => fileBundle("x", "X", "hash-a")), shared);
  assert.equal(pool.refCount("hash-a"), 2);
  pool.release("hash-a");
  assert.equal(pool.size, 1);
  pool.release("hash-a");
  assert.equal(pool.size, 0);
});

test("two stores share contentHash facts and isolate a changed file", () => {
  const pool = new SharedFactsPool();
  const storeA = new JavaIndexStore(pool);
  const storeB = new JavaIndexStore(pool);
  const original = fileBundle("src/main/java/demo/A.java", "A", "hash-a");
  storeA.replaceFile(original);
  storeB.replaceFile(fileBundle("src/main/java/demo/A.java", "A", "hash-a"));
  const typeId = original.types[0]!.typeId;
  const typeA = storeA.typesById.get(typeId);
  const typeB = storeB.typesById.get(typeId);
  assert.equal(typeA, typeB, "identical contentHash facts are the same object");
  storeA.replaceFile(fileBundle("src/main/java/demo/A.java", "A", "hash-a-changed"));
  assert.equal(storeB.installedBundle("src/main/java/demo/A.java")?.file.contentHash, "hash-a");
  assert.equal(storeA.installedBundle("src/main/java/demo/A.java")?.file.contentHash, "hash-a-changed");
  assert.notEqual(storeA.typesById.get(typeId), storeB.typesById.get(typeId));
  storeA.disposeSharedFacts();
  assert.equal(pool.refCount("hash-a"), 1);
  storeB.disposeSharedFacts();
  assert.equal(pool.size, 0);
});

test("attachFromDonorStore freezes the sibling view so donor.replaceFile does not leak", () => {
  const pool = new SharedFactsPool();
  const donor = new JavaIndexStore(pool);
  const original = fileBundle("src/main/java/demo/A.java", "A", "hash-a");
  donor.replaceFile(original);
  const sibling = new JavaIndexStore(pool);
  assert.equal(sibling.attachFromDonorStore(donor), 1);

  const relativePath = original.file.relativePath;
  const typeId = original.types[0]!.typeId;
  const methodId = original.methods[0]!.methodId;
  const anchored = sibling.anchor(relativePath, RANGE.start.line, RANGE.start.column);
  assert.ok(anchored, "QUERY_ANCHOR entry point must resolve after family seed");
  assert.notEqual(anchored.symbolKind, "FILE");
  assert.equal(anchored.file.contentHash, "hash-a");
  assert.equal(sibling.typesById.get(typeId)?.simpleName, "A");
  assert.equal(sibling.methodsById.get(methodId)?.name, "run");
  assert.equal(sibling.typesById.get(typeId), donor.typesById.get(typeId), "frozen view must share the pooled type object");
  const lookup = sibling.typeLookup("demo.A");
  assert.equal(lookup.state, "RESOLVED");
  assert.equal((lookup as { type: JavaTypeFacts }).type.typeId, typeId);

  const changed = fileBundle(relativePath, "A", "hash-a-changed");
  changed.methods[0] = { ...changed.methods[0]!, name: "updated" };
  donor.replaceFile(changed);
  assert.equal(donor.file(relativePath)?.contentHash, "hash-a-changed");
  assert.equal(donor.methodsById.get(methodId)?.name, "updated");
  assert.equal(sibling.file(relativePath)?.contentHash, "hash-a");
  assert.equal(sibling.installedBundle(relativePath)?.file.contentHash, "hash-a");
  assert.equal(sibling.methodsById.get(methodId)?.name, "run");
  const after = sibling.anchor(relativePath, RANGE.start.line, RANGE.start.column);
  assert.ok(after);
  assert.equal(after.file.contentHash, "hash-a");
  const lookupAfter = sibling.typeLookup("demo.A");
  assert.equal(lookupAfter.state, "RESOLVED");
  assert.equal((lookupAfter as { type: JavaTypeFacts }).type.typeId, typeId);
  assert.equal(sibling.filesByPath.size, 1);
});

test("sibling attachSharedBundle reuses methods without a second SoA intern", () => {
  const pool = new SharedFactsPool();
  const donor = new JavaIndexStore(pool);
  const original = fileBundle("src/main/java/demo/A.java", "A", "hash-a");
  donor.replaceFile(original);
  donor.publishHydratedToPool();
  const sibling = new JavaIndexStore(pool);
  const pooled = pool.peek("hash-a");
  assert.ok(pooled);
  sibling.attachSharedBundle(pooled);
  const methodId = original.methods[0]!.methodId;
  assert.equal(sibling.methodsById.get(methodId), original.methods[0]);
  assert.equal(sibling.typesById.get(original.types[0]!.typeId), donor.typesById.get(original.types[0]!.typeId));
  assert.equal(sibling.filesByPath.size, 1);
  donor.replaceFile(fileBundle("src/main/java/demo/A.java", "A", "hash-a-changed"));
  assert.equal(sibling.methodsById.get(methodId), original.methods[0]);
  assert.equal(sibling.installedBundle("src/main/java/demo/A.java")?.file.contentHash, "hash-a");
});

test("overlayDivergentBundles interns only contentHash diffs after a frozen attach", () => {
  const pool = new SharedFactsPool();
  const donor = new JavaIndexStore(pool);
  const sibling = new JavaIndexStore(pool);
  const shared = fileBundle("src/main/java/demo/Shared.java", "Shared", "hash-shared");
  const unique = fileBundle("src/main/java/demo/Unique.java", "Unique", "hash-unique");
  donor.replaceFile(shared);
  donor.replaceFile(unique);
  assert.equal(sibling.attachFromDonorStore(donor), 2);
  assert.equal(sibling.typesById.get(shared.types[0]!.typeId), donor.typesById.get(shared.types[0]!.typeId));
  const changed = fileBundle("src/main/java/demo/Unique.java", "Unique", "hash-unique-b");
  assert.equal(sibling.overlayDivergentBundles([shared, changed]), 1);
  assert.equal(sibling.file("src/main/java/demo/Shared.java")?.contentHash, "hash-shared");
  assert.equal(sibling.typesById.get(shared.types[0]!.typeId), donor.typesById.get(shared.types[0]!.typeId));
  assert.equal(sibling.file("src/main/java/demo/Unique.java")?.contentHash, "hash-unique-b");
  assert.notEqual(
    sibling.typesById.get(changed.types[0]!.typeId),
    donor.typesById.get(unique.types[0]!.typeId)
  );
  assert.equal(donor.file("src/main/java/demo/Unique.java")?.contentHash, "hash-unique");
  assert.equal(pool.size, 3);
});

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JavaIndexStore } from "./index-store.js";
import { SharedFactsPool } from "./shared-facts-pool.js";
import { FamilyWorkerPool } from "./family-worker-pool.js";
import { JavaIndexClient } from "./java-index-client.js";
import type { JavaFileBundle, JavaFileFacts, JavaMethodFacts, JavaTypeFacts, SourceRange } from "./index-types.js";
import { javaFileId, javaMethodId, javaTypeId } from "./stable-id.js";
import type { WorkerLike } from "./java-index-worker-process.js";

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

test("family worker pool keeps one process until the last root releases", async () => {
  let spawns = 0;
  let terminates = 0;
  class FakeChild implements WorkerLike {
    readonly listeners: { message: Array<(value: unknown) => void> } = { message: [] };
    postMessage(): void {}
    on(event: "message" | "error" | "exit", listener: (value: never) => void): this {
      if (event === "message") this.listeners.message.push(listener as (value: unknown) => void);
      return this;
    }
    terminate(): Promise<number> {
      terminates += 1;
      return Promise.resolve(0);
    }
  }
  const pool = new FamilyWorkerPool(() => {
    spawns += 1;
    return new FakeChild();
  });
  const first = pool.acquire("fam", "root-a");
  const second = pool.acquire("fam", "root-b");
  assert.equal(spawns, 1);
  assert.equal(pool.rootCount("fam"), 2);
  await first.terminate();
  assert.equal(terminates, 0);
  assert.equal(pool.rootCount("fam"), 1);
  await second.terminate();
  assert.equal(terminates, 1);
  assert.equal(pool.rootCount("fam"), 0);
});

test("two family roots share one worker process and keep overlay isolation", async () => {
  const pool = new FamilyWorkerPool();
  const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "java-index-v2");
  const cacheA = mkdtempSync(path.join(tmpdir(), "fs2-a-"));
  const cacheB = mkdtempSync(path.join(tmpdir(), "fs2-b-"));
  const clientA = new JavaIndexClient(fixtures, cacheA, () => pool.acquire("fam-fs2", "root-a"), "root-a");
  const clientB = new JavaIndexClient(fixtures, cacheB, () => pool.acquire("fam-fs2", "root-b"), "root-b");
  try {
    assert.equal((await clientA.open(1)).state, "READY");
    assert.equal((await clientB.open(1)).state, "READY");
    assert.equal(pool.rootCount("fam-fs2"), 2);
    const statusA = await clientA.status();
    const statusB = await clientB.status();
    assert.equal(statusA.state, "READY");
    assert.equal(statusB.state, "READY");
  } finally {
    await clientA.close();
    await clientB.close();
  }
});

test("recycling a family worktree does not hibernate the donor root", async () => {
  const pool = new FamilyWorkerPool();
  const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "java-index-v2");
  const cacheA = mkdtempSync(path.join(tmpdir(), "fs2-keep-a-"));
  const cacheB = mkdtempSync(path.join(tmpdir(), "fs2-keep-b-"));
  const clientA = new JavaIndexClient(fixtures, cacheA, () => pool.acquire("fam-keep", "root-a"), "root-a");
  const clientB = new JavaIndexClient(fixtures, cacheB, () => pool.acquire("fam-keep", "root-b"), "root-b");
  const absolutePath = path.join(fixtures, "src/main/java/demo/PaymentGateway.java");
  try {
    assert.equal((await clientA.open(1)).state, "READY");
    await clientA.refresh(2, [absolutePath], []);
    const donorBundle = (await clientA.queryFiles([absolutePath]))[0];
    const paymentGateway = donorBundle?.types.find(type => type.simpleName === "PaymentGateway");
    assert.ok(paymentGateway);
    assert.equal((await clientB.open(1)).state, "READY");
    assert.equal(pool.rootCount("fam-keep"), 2);
    await clientB.recycle();
    assert.equal(pool.rootCount("fam-keep"), 1);
    const t0 = Date.now();
    const anchor = await clientA.queryAnchor(
      absolutePath,
      paymentGateway.range.start.line,
      paymentGateway.range.start.column
    );
    assert.ok(Date.now() - t0 < 2000, "donor query after sibling recycle must not rehydrate");
    assert.equal(anchor?.symbolId, paymentGateway.typeId);
  } finally {
    await clientA.close();
    await clientB.close();
  }
});

test("family-seeded OPEN answers QUERY_ANCHOR and QUERY_TYPE from the attached store", async () => {
  const pool = new FamilyWorkerPool();
  const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "java-index-v2");
  const cacheA = mkdtempSync(path.join(tmpdir(), "fs2-open-a-"));
  const cacheB = mkdtempSync(path.join(tmpdir(), "fs2-open-b-"));
  const clientA = new JavaIndexClient(fixtures, cacheA, () => pool.acquire("fam-open", "root-a"), "root-a");
  const clientB = new JavaIndexClient(fixtures, cacheB, () => pool.acquire("fam-open", "root-b"), "root-b");
  const absolutePath = path.join(fixtures, "src/main/java/demo/PaymentGateway.java");
  try {
    assert.equal((await clientA.open(1)).state, "READY");
    await clientA.refresh(2, [absolutePath], []);
    const donorBundle = (await clientA.queryFiles([absolutePath]))[0];
    assert.ok(donorBundle);
    const paymentGateway = donorBundle.types.find(type => type.simpleName === "PaymentGateway");
    assert.ok(paymentGateway);
    assert.ok(donorBundle.methods.length > 0);

    assert.equal((await clientB.open(1)).state, "READY");
    const anchor = await clientB.queryAnchor(
      absolutePath,
      paymentGateway.range.start.line,
      paymentGateway.range.start.column
    );
    assert.equal(anchor?.symbolId, paymentGateway.typeId);
    const typeLookup = await clientB.queryType("PaymentGateway", absolutePath);
    assert.equal(typeLookup.state, "RESOLVED");
    assert.equal((typeLookup as { type: JavaTypeFacts }).type.typeId, paymentGateway.typeId);
    const siblingBundle = (await clientB.queryFiles([absolutePath]))[0];
    assert.equal(siblingBundle?.file.contentHash, donorBundle.file.contentHash);
  } finally {
    await clientA.close();
    await clientB.close();
  }
});

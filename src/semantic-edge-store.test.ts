import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileSemanticEdgeStoreV2,
  mapSemanticEdgeForPersistence,
  type PersistedSemanticEdge,
  type RawSemanticEdgeCandidate
} from "./semantic-edge-store.js";

function scratchRepo(): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "semantic-edge-store-"));
  writeFileSync(path.join(repoRoot, "Source.java"), "class Source {}\n");
  writeFileSync(path.join(repoRoot, "Target.java"), "class Target {}\n");
  return repoRoot;
}

function candidateFor(repoRoot: string, overrides: Partial<RawSemanticEdgeCandidate> = {}): RawSemanticEdgeCandidate {
  return {
    sourceFile: path.join(repoRoot, "Source.java"),
    sourceLine: 1,
    sourceColumn: 1,
    targetFile: path.join(repoRoot, "Target.java"),
    targetLine: 1,
    targetColumn: 1,
    relation: "JDT_REFERENCE",
    completion: "COMPLETE",
    buildFingerprint: "build-1",
    generation: 1,
    ...overrides
  };
}

test("a COMPLETE repo-contained edge resolving on both sides persists and reloads", async () => {
  const repoRoot = scratchRepo();
  const candidate = candidateFor(repoRoot);
  const edge = await mapSemanticEdgeForPersistence(candidate, repoRoot, async (file, line, column) => ({
    symbolId: `${path.basename(file)}:${line}:${column}`
  }));
  assert.ok(edge);

  const store = new FileSemanticEdgeStoreV2(repoRoot);
  await store.load();
  await store.putComplete([edge!], 1);
  await store.flush();

  const reloaded = new FileSemanticEdgeStoreV2(repoRoot);
  await reloaded.load();
  const found = reloaded.findFrom(edge!.sourceSymbolId, 1);
  assert.equal(found.length, 1);
  assert.equal(found[0].targetSymbolId, edge!.targetSymbolId);
  assert.equal(found[0].relation, "JDT_REFERENCE");
});

test("a location that cannot map to a stable symbol ID is not persisted", async () => {
  const repoRoot = scratchRepo();
  const candidate = candidateFor(repoRoot);
  const edge = await mapSemanticEdgeForPersistence(candidate, repoRoot, async () => undefined);
  assert.equal(edge, undefined);
});

test("PARTIAL and FAILED outcomes cannot produce a persistable edge", async () => {
  const repoRoot = scratchRepo();
  const resolver = async (file: string, line: number, column: number) => ({ symbolId: `${path.basename(file)}:${line}:${column}` });

  const partial = await mapSemanticEdgeForPersistence(candidateFor(repoRoot, { completion: "PARTIAL_TIMEOUT" }), repoRoot, resolver);
  assert.equal(partial, undefined);

  const failed = await mapSemanticEdgeForPersistence(candidateFor(repoRoot, { completion: "FAILED" }), repoRoot, resolver);
  assert.equal(failed, undefined);
});

test("a changed or deleted dependency removes the edge", async () => {
  const repoRoot = scratchRepo();
  const candidate = candidateFor(repoRoot);
  const edge = await mapSemanticEdgeForPersistence(candidate, repoRoot, async (file, line, column) => ({
    symbolId: `${path.basename(file)}:${line}:${column}`
  }));
  const store = new FileSemanticEdgeStoreV2(repoRoot);
  await store.load();
  await store.putComplete([edge!], 1);
  assert.equal(store.findFrom(edge!.sourceSymbolId, 1).length, 1);

  store.applyChanges({
    generation: 2,
    observedAt: new Date().toISOString(),
    changes: [{ kind: "JAVA_CHANGE", absolutePath: path.join(repoRoot, "Target.java") }],
    storm: false,
    affectedRoots: [repoRoot]
  });

  assert.equal(store.findFrom(edge!.sourceSymbolId, 1).length, 0);
  assert.equal(store.status().invalidations, 1);
  assert.equal(store.status().generation, 2, "applyChanges advances the store's generation from the batch, matching putComplete/clearForBuildChange");
});

test("a build fingerprint change clears the store", async () => {
  const repoRoot = scratchRepo();
  const candidate = candidateFor(repoRoot);
  const edge = await mapSemanticEdgeForPersistence(candidate, repoRoot, async (file, line, column) => ({
    symbolId: `${path.basename(file)}:${line}:${column}`
  }));
  const store = new FileSemanticEdgeStoreV2(repoRoot);
  await store.load();
  await store.putComplete([edge!], 1);
  assert.equal(store.status().entries, 1);
  assert.equal(store.status().buildFingerprint, "build-1");

  store.clearForBuildChange(2);

  assert.equal(store.status().entries, 0);
  assert.equal(store.status().generation, 2);
  assert.equal(store.findFrom(edge!.sourceSymbolId, 2).length, 0);
});

test("an unaffected edge is promoted to the current generation only after dependency fingerprints are revalidated", async () => {
  const repoRoot = scratchRepo();
  const candidate = candidateFor(repoRoot);
  const edge = await mapSemanticEdgeForPersistence(candidate, repoRoot, async (file, line, column) => ({
    symbolId: `${path.basename(file)}:${line}:${column}`
  }));
  const store = new FileSemanticEdgeStoreV2(repoRoot);
  await store.load();
  await store.putComplete([edge!], 1);

  // Ask for generation 5 without any file changing: fingerprints still match,
  // so the edge survives and is promoted (not dropped just because the
  // requested generation moved past validatedGeneration).
  const atFive = store.findFrom(edge!.sourceSymbolId, 5);
  assert.equal(atFive.length, 1);
  assert.equal(atFive[0].validatedGeneration, 5);
  assert.equal(store.status().promoted, 1);

  // A second lookup at the same generation is already promoted; no re-promotion.
  store.findFrom(edge!.sourceSymbolId, 5);
  assert.equal(store.status().promoted, 1);
});

test("an outside-repo source or target is rejected even if handed directly to putComplete", async () => {
  const repoRoot = scratchRepo();
  const outsideEdge: PersistedSemanticEdge = {
    edgeId: "outside",
    sourceSymbolId: "s1",
    targetSymbolId: "t1",
    sourceFile: path.join(repoRoot, "Source.java"),
    targetFile: path.join(tmpdir(), "elsewhere", "Other.java"),
    relation: "JDT_REFERENCE",
    targetRanges: [],
    provenance: "PERSISTED_JDT",
    confidence: 1,
    completion: "COMPLETE",
    dependencies: [],
    buildFingerprint: "build-1",
    validatedGeneration: 1,
    createdAt: new Date().toISOString()
  };
  const store = new FileSemanticEdgeStoreV2(repoRoot);
  await store.load();
  await store.putComplete([outsideEdge], 1);

  assert.equal(store.findFrom("s1", 1).length, 0);
  assert.equal(store.status().rejectedWrites, 1);
  assert.equal(store.status().completeWrites, 0);
});

test("a failed atomic write leaves the previous snapshot readable", async () => {
  const repoRoot = scratchRepo();
  const candidate = candidateFor(repoRoot);
  const edge = await mapSemanticEdgeForPersistence(candidate, repoRoot, async (file, line, column) => ({
    symbolId: `${path.basename(file)}:${line}:${column}`
  }));

  const store = new FileSemanticEdgeStoreV2(repoRoot);
  await store.load();
  await store.putComplete([edge!], 1);
  await store.flush();

  const second = candidateFor(repoRoot, { relation: "JDT_IMPLEMENTATION", buildFingerprint: "build-2" });
  const secondEdge = await mapSemanticEdgeForPersistence(second, repoRoot, async (file, line, column) => ({
    symbolId: `${path.basename(file)}:${line}:${column}`
  }));
  const failingStore = new FileSemanticEdgeStoreV2(repoRoot, {
    beforeRename: async () => { throw new Error("simulated crash before rename"); }
  });
  await failingStore.load();
  await failingStore.putComplete([secondEdge!], 2);
  await assert.rejects(() => failingStore.flush(), /simulated crash before rename/);

  const reloaded = new FileSemanticEdgeStoreV2(repoRoot);
  await reloaded.load();
  const survivors = reloaded.findFrom(edge!.sourceSymbolId, 1);
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].relation, "JDT_REFERENCE");
});

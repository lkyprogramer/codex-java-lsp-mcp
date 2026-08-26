import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSnapshot, loadSnapshotView, writeSnapshotAtomic, type JavaIndexSnapshotV3, type SnapshotIdentity } from "./snapshot.js";
import { decodeSnapshotV4View, encodeSnapshotV4, isSnapshotV4, SNAPSHOT_V4_VERSION } from "./snapshot-v4.js";

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "java-index-snapshot-v4-"));
  return path.join(dir, "java-index-snapshot.json.gz");
}

function snapshot(overrides: Partial<JavaIndexSnapshotV3> = {}): JavaIndexSnapshotV3 {
  return {
    schemaVersion: 3,
    extractorVersion: "schema-3|tree-sitter-0.25.0|tree-sitter-java-0.23.5|extractor-code-abc123",
    stableIdVersion: 1,
    canonicalRepoRoot: "/repo",
    buildFingerprint: "build-a",
    manifestFingerprint: "manifest-a",
    indexedGeneration: 1,
    createdAt: new Date(0).toISOString(),
    coverage: [],
    files: [{
      fileId: "file:src/A.java",
      relativePath: "src/A.java",
      sourceRoot: "src/main/java",
      module: ".",
      sourceSet: "main",
      packageName: "demo",
      imports: [],
      topLevelTypeIds: [],
      allTypeIds: [],
      contentHash: "hash",
      size: 10,
      mtimeMs: 1,
      parseState: "COMPLETE",
      parseErrorCount: 0,
      generation: 1
    }],
    types: [],
    fields: [],
    methods: [],
    edges: [{
      edgeId: "e1",
      fromId: "a",
      toId: "b",
      kind: "CALLS",
      confidence: 1,
      sourceFile: "src/A.java",
      generation: 1,
      resolution: { kind: "AST_EXPLICIT" }
    }],
    myBatisResources: [],
    resourceCoverage: [],
    ...overrides
  };
}

function identityFor(value: JavaIndexSnapshotV3): SnapshotIdentity {
  return {
    extractorVersion: value.extractorVersion,
    stableIdVersion: value.stableIdVersion,
    canonicalRepoRoot: value.canonicalRepoRoot,
    buildFingerprint: value.buildFingerprint
  };
}

test("v4 round-trip keeps facts and is not gzip-framed JSON", async () => {
  const target = tempFile();
  const value = snapshot({ indexedGeneration: 4 });
  await writeSnapshotAtomic(target, value);
  const bytes = await readFile(target);
  assert.equal(isSnapshotV4(bytes), true);
  const loaded = await loadSnapshot(target, identityFor(value));
  assert.equal(loaded?.indexedGeneration, 4);
  assert.equal(loaded?.files[0]?.relativePath, "src/A.java");
  assert.equal(loaded?.edges[0]?.edgeId, "e1");
});

test("v4 files-only view does not decode edges until readRest", async () => {
  const target = tempFile();
  const value = snapshot();
  await writeSnapshotAtomic(target, value);
  const view = await loadSnapshotView(target, identityFor(value));
  assert.ok(view);
  assert.equal(view.files[0]?.relativePath, "src/A.java");
  assert.equal(view.restOnDisk, true);
  assert.equal("payload" in view, false);
  const rest = view.readRest();
  assert.equal(rest.edges[0]?.edgeId, "e1");
});

test("encodeSnapshotV4 releases each segment body after gzip", async () => {
  const value = snapshot();
  const encoded = encodeSnapshotV4({
    extractorVersion: value.extractorVersion,
    stableIdVersion: value.stableIdVersion,
    canonicalRepoRoot: value.canonicalRepoRoot,
    buildFingerprint: value.buildFingerprint,
    manifestFingerprint: value.manifestFingerprint,
    indexedGeneration: value.indexedGeneration,
    createdAt: value.createdAt,
    coverage: value.coverage,
    resourceCoverage: value.resourceCoverage,
    files: value.files,
    types: value.types,
    fields: value.fields,
    methods: value.methods,
    edges: value.edges,
    myBatisResources: value.myBatisResources
  });
  assert.equal(isSnapshotV4(encoded), true);
  assert.equal(value.files.length, 0);
  assert.equal(value.edges.length, 0);
});

test("v5 splits methods over the item limit into multiple parts and concatenates on read", async () => {
  const methods = Array.from({ length: 5001 }, (_, index) => ({
    methodId: `method:demo.A#m${index}()`,
    ownerTypeId: "type:demo.A",
    name: `m${index}`,
    constructor: false,
    signatureKey: `m${index}()`,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    bodyRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    modifiers: [],
    annotations: [],
    typeParameters: [],
    parameters: [],
    throws: [],
    generation: 1
  }));
  const value = snapshot({ methods: methods as never });
  const encoded = encodeSnapshotV4({
    extractorVersion: value.extractorVersion,
    stableIdVersion: value.stableIdVersion,
    canonicalRepoRoot: value.canonicalRepoRoot,
    buildFingerprint: value.buildFingerprint,
    manifestFingerprint: value.manifestFingerprint,
    indexedGeneration: value.indexedGeneration,
    createdAt: value.createdAt,
    coverage: value.coverage,
    resourceCoverage: value.resourceCoverage,
    files: value.files,
    types: value.types,
    fields: value.fields,
    methods: value.methods,
    edges: value.edges,
    myBatisResources: value.myBatisResources
  });
  const view = decodeSnapshotV4View(encoded);
  assert.equal("error" in view, false);
  if ("error" in view) return;
  assert.equal(view.header.schemaVersion, SNAPSHOT_V4_VERSION);
  const methodParts = view.header.segments.filter(entry => entry.kind === "methods");
  assert.ok(methodParts.length >= 2, `expected multiple method parts, got ${methodParts.length}`);
  const chunks = [...view.readSegmentChunks("methods")] as unknown[][];
  assert.equal(chunks.length, methodParts.length);
  assert.equal((view.readSegment("methods") as unknown[]).length, 5001);
});

test("encodeSnapshotV4({ chunkRest: false }) keeps a single methods part", () => {
  const methods = Array.from({ length: 5001 }, (_, index) => ({
    methodId: `method:demo.A#m${index}()`,
    ownerTypeId: "type:demo.A",
    name: `m${index}`,
    constructor: false,
    signatureKey: `m${index}()`,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    bodyRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    modifiers: [],
    annotations: [],
    typeParameters: [],
    parameters: [],
    throws: [],
    generation: 1
  }));
  const value = snapshot({ methods: methods as never });
  const encoded = encodeSnapshotV4({
    extractorVersion: value.extractorVersion,
    stableIdVersion: value.stableIdVersion,
    canonicalRepoRoot: value.canonicalRepoRoot,
    buildFingerprint: value.buildFingerprint,
    manifestFingerprint: value.manifestFingerprint,
    indexedGeneration: value.indexedGeneration,
    createdAt: value.createdAt,
    coverage: value.coverage,
    resourceCoverage: value.resourceCoverage,
    files: value.files,
    types: value.types,
    fields: value.fields,
    methods: value.methods,
    edges: value.edges,
    myBatisResources: value.myBatisResources
  }, { chunkRest: false });
  const view = decodeSnapshotV4View(encoded);
  assert.equal("error" in view, false);
  if ("error" in view) return;
  assert.equal(view.header.segments.filter(entry => entry.kind === "methods").length, 1);
});

test("a crc32 mismatch on a v4 segment is discarded and the file is deleted", async () => {
  const target = tempFile();
  const value = snapshot();
  const encoded = encodeSnapshotV4({
    extractorVersion: value.extractorVersion,
    stableIdVersion: value.stableIdVersion,
    canonicalRepoRoot: value.canonicalRepoRoot,
    buildFingerprint: value.buildFingerprint,
    manifestFingerprint: value.manifestFingerprint,
    indexedGeneration: value.indexedGeneration,
    createdAt: value.createdAt,
    coverage: value.coverage,
    resourceCoverage: value.resourceCoverage,
    files: value.files,
    types: value.types,
    fields: value.fields,
    methods: value.methods,
    edges: value.edges,
    myBatisResources: value.myBatisResources
  });
  encoded[encoded.length - 1] = encoded[encoded.length - 1]! ^ 0xff;
  mkdirSync(path.dirname(target), { recursive: true });
  await writeFile(target, encoded);
  const loaded = await loadSnapshot(target, identityFor(value));
  assert.equal(loaded, undefined);
  assert.equal(existsSync(target), false);
});

function encodeFacts(value: JavaIndexSnapshotV3, chunkRest?: boolean) {
  return encodeSnapshotV4({
    extractorVersion: value.extractorVersion,
    stableIdVersion: value.stableIdVersion,
    canonicalRepoRoot: value.canonicalRepoRoot,
    buildFingerprint: value.buildFingerprint,
    manifestFingerprint: value.manifestFingerprint,
    indexedGeneration: value.indexedGeneration,
    createdAt: value.createdAt,
    coverage: value.coverage,
    resourceCoverage: value.resourceCoverage,
    files: value.files,
    types: value.types,
    fields: value.fields,
    methods: value.methods,
    edges: value.edges,
    myBatisResources: value.myBatisResources
  }, chunkRest === undefined ? {} : { chunkRest });
}

async function decodeMethodsInWorker(bytes: Buffer, maxOldGenerationSizeMb: number): Promise<number> {
  const worker = new Worker(new URL("./snapshot-v4-hydrate-probe-worker.js", import.meta.url), {
    workerData: { bytes },
    resourceLimits: { maxOldGenerationSizeMb, maxYoungGenerationSizeMb: Math.min(32, maxOldGenerationSizeMb) }
  });
  try {
    return await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", code => {
        if (code !== 0) reject(new Error(`worker exit ${code}`));
      });
    });
  } finally {
    await worker.terminate();
  }
}

test("a 256 MiB isolate hydrates chunked methods over the item limit", async () => {
  const methods = Array.from({ length: 5001 }, (_, index) => ({
    methodId: `method:demo.A#m${index}()`,
    ownerTypeId: "type:demo.A",
    name: `m${index}`,
    constructor: false,
    signatureKey: `m${index}()`,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    bodyRange: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    modifiers: [],
    annotations: [],
    typeParameters: [],
    parameters: [],
    throws: [],
    generation: 1
  }));
  const value = snapshot({ methods: methods as never });
  const chunked = encodeFacts(value);
  const view = decodeSnapshotV4View(chunked);
  assert.equal("error" in view, false);
  if ("error" in view) return;
  assert.ok(view.header.segments.filter(entry => entry.kind === "methods").length >= 2);
  assert.equal(await decodeMethodsInWorker(chunked, 256), 5001);
});


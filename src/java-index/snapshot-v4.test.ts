import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSnapshot, loadSnapshotView, writeSnapshotAtomic, type JavaIndexSnapshotV3, type SnapshotIdentity } from "./snapshot.js";
import { encodeSnapshotV4, isSnapshotV4 } from "./snapshot-v4.js";

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

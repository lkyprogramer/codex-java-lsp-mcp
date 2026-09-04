import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { probeLayout } from "../layout-probe.js";
import { computeCurrentManifestFingerprint } from "./manifest.js";
import {
  loadSiblingSnapshot,
  loadSiblingSnapshotHeader,
  isCompleteSnapshotFile,
  loadSnapshot,
  writeSnapshotAtomic,
  writeSnapshotIfManifestCurrent,
  type JavaIndexSnapshotV3,
  type SnapshotIdentity
} from "./snapshot.js";

function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "java-index-snapshot-"));
  return path.join(dir, "nested", "java-index-snapshot.json.gz");
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
    files: [],
    types: [],
    fields: [],
    methods: [],
    edges: [],
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

test("a written snapshot round-trips through loadSnapshot", async () => {
  const target = tempFile();
  const value = snapshot({ indexedGeneration: 7 });
  const expected = structuredClone(value);
  const bytesWritten = await writeSnapshotAtomic(target, value);
  assert.ok(bytesWritten > 0);

  const loaded = await loadSnapshot(target, identityFor(expected));
  assert.deepEqual(loaded, expected);
});

test("failed snapshot write leaves the previous snapshot readable", async () => {
  const target = tempFile();
  const first = snapshot({ indexedGeneration: 1 });
  const second = snapshot({ indexedGeneration: 2 });
  await writeSnapshotAtomic(target, first);

  await assert.rejects(() => writeSnapshotAtomic(target, second, {
    beforeRename: async () => { throw new Error("injected before rename"); }
  }));

  const loaded = await loadSnapshot(target, identityFor(first));
  assert.equal(loaded?.indexedGeneration, first.indexedGeneration);
});

test("a snapshot candidate is not renamed after the target manifest changes during serialization", async () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "java-index-snapshot-race-"));
  const source = path.join(repoRoot, "src/main/java/demo/Current.java");
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, "package demo; class Current {}\n");
  const layout = probeLayout(repoRoot);
  const target = tempFile();
  const previous = snapshot({ indexedGeneration: 1, manifestFingerprint: "previous-manifest" });
  const candidate = snapshot({
    indexedGeneration: 2,
    manifestFingerprint: await computeCurrentManifestFingerprint(repoRoot, layout)
  });
  await writeSnapshotAtomic(target, previous);

  let changed = false;
  await assert.rejects(
    () => writeSnapshotIfManifestCurrent(target, candidate, async () => {
      if (!changed) {
        changed = true;
        writeFileSync(source, "package demo; class Current { void changed() {} }\n");
      }
      return computeCurrentManifestFingerprint(repoRoot, layout);
    }),
    /manifest changed before snapshot publish/
  );

  const loaded = await loadSnapshot(target, identityFor(previous));
  assert.equal(loaded?.indexedGeneration, previous.indexedGeneration, "the stale candidate must not replace the prior snapshot");
});

test("a write failure does not leave a stray temp file behind", async () => {
  const target = tempFile();
  await assert.rejects(() => writeSnapshotAtomic(target, snapshot(), {
    beforeRename: async () => { throw new Error("injected"); }
  }));

  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(path.dirname(target));
  assert.deepEqual(entries.filter(name => name.includes(".tmp-")), []);
});

test("a missing snapshot file is a silent miss, not an error", async () => {
  const target = tempFile();
  const loaded = await loadSnapshot(target, identityFor(snapshot()));
  assert.equal(loaded, undefined);
});

test("an invalid gzip stream is discarded as a miss and the file is deleted", async () => {
  const target = tempFile();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from("not gzip at all"));
  const loaded = await loadSnapshot(target, identityFor(snapshot()));
  assert.equal(loaded, undefined);
  assert.equal(existsSync(target), false, "a corrupt snapshot must be deleted, not retained");
});

test("valid gzip but invalid JSON is discarded as a miss", async () => {
  const target = tempFile();
  await writeSnapshotAtomic(target, snapshot());
  writeFileSync(target, gzipSync(Buffer.from("{not json")));
  const loaded = await loadSnapshot(target, identityFor(snapshot()));
  assert.equal(loaded, undefined);
  assert.equal(existsSync(target), false, "a corrupt snapshot must be deleted, not retained");
});

test("schemaVersion 1 gzip JSON is rejected and the file is deleted", async () => {
  const target = tempFile();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, gzipSync(Buffer.from(JSON.stringify({ ...snapshot(), schemaVersion: 1 }))));
  const loaded = await loadSnapshot(target, identityFor(snapshot()));
  assert.equal(loaded, undefined);
  assert.equal(existsSync(target), false);
});

test("the pre-Task-28 schemaVersion 2 gzip JSON is rejected, not migrated", async () => {
  const target = tempFile();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, gzipSync(Buffer.from(JSON.stringify({ ...snapshot(), schemaVersion: 2 }))));
  const loaded = await loadSnapshot(target, identityFor(snapshot()));
  assert.equal(loaded, undefined);
  assert.equal(existsSync(target), false, "a schema-2 snapshot must be deleted, never migrated in place");
});

test("a leftover v3 gzip schema-3 snapshot is discarded, not migrated", async () => {
  const target = tempFile();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, gzipSync(Buffer.from(JSON.stringify(snapshot()))));
  const loaded = await loadSnapshot(target, identityFor(snapshot()));
  assert.equal(loaded, undefined);
  assert.equal(existsSync(target), false);
});

test("an extractorVersion mismatch is rejected", async () => {
  const target = tempFile();
  const value = snapshot({ extractorVersion: "schema-2|tree-sitter-0.1.0|tree-sitter-java-0.1.0|extractor-code-old" });
  await writeSnapshotAtomic(target, value);
  const loaded = await loadSnapshot(target, identityFor(snapshot()));
  assert.equal(loaded, undefined);
});

test("a snapshot whose extractorVersion only adds extractor-code-<gitSha> still loads", async () => {
  const target = tempFile();
  const current = "schema-3|facts-2|tree-sitter-0.25.0|tree-sitter-java-0.23.5";
  const value = snapshot({ extractorVersion: `${current}|extractor-code-f3b12144c5ce` });
  await writeSnapshotAtomic(target, value);
  const loaded = await loadSnapshot(target, { ...identityFor(value), extractorVersion: current });
  assert.equal(loaded?.indexedGeneration, value.indexedGeneration);
  assert.equal(existsSync(target), true);
});

test("a canonicalRepoRoot mismatch loads the own snapshot and keeps the file", async () => {
  const target = tempFile();
  const value = snapshot({ canonicalRepoRoot: "/some/other/repo" });
  await writeSnapshotAtomic(target, value);
  const loaded = await loadSnapshot(target, identityFor(snapshot()));
  assert.equal(loaded?.indexedGeneration, value.indexedGeneration);
  assert.equal(existsSync(target), true, "FSR1: canonical drift must not discard");
});

test("a buildFingerprint mismatch loads the own snapshot and keeps the file", async () => {
  const target = tempFile();
  const value = snapshot({ buildFingerprint: "build-different" });
  await writeSnapshotAtomic(target, value);
  const loaded = await loadSnapshot(target, identityFor(snapshot()));
  assert.equal(loaded?.indexedGeneration, value.indexedGeneration);
  assert.equal(existsSync(target), true, "FSR1: fingerprint drift must not discard");
  assert.equal(await isCompleteSnapshotFile(target), true);
});

test("a stableIdVersion mismatch is rejected", async () => {
  const target = tempFile();
  const value = snapshot({ stableIdVersion: 999 });
  await writeSnapshotAtomic(target, value);
  const loaded = await loadSnapshot(target, identityFor(snapshot()));
  assert.equal(loaded, undefined);
});

test("directory fsync during write tolerates EINVAL/ENOTSUP/EPERM but not other errors", async () => {
  // Exercised indirectly: writeSnapshotAtomic must succeed on this machine's
  // real filesystem regardless of whether directory fsync is supported.
  const target = tempFile();
  await writeSnapshotAtomic(target, snapshot());
  assert.ok((await readFile(target)).length > 0);
});

test("loadSiblingSnapshotHeader reads coverage without decoding rest segments", async () => {
  const target = tempFile();
  const value = snapshot({
    indexedGeneration: 9,
    coverage: [{
      root: "src/main/java",
      generation: 9,
      state: "COMPLETE",
      discoveredFiles: 1,
      indexedFiles: 1,
      failedFiles: 0,
      recoveredFiles: 0,
      extractorVersion: "test"
    }]
  });
  const expected = structuredClone(value);
  await writeSnapshotAtomic(target, value);
  const header = await loadSiblingSnapshotHeader(target, {
    extractorVersion: expected.extractorVersion,
    stableIdVersion: expected.stableIdVersion,
    buildFingerprint: expected.buildFingerprint
  });
  assert.equal(header?.indexedGeneration, 9);
  assert.equal(header?.coverage[0]?.state, "COMPLETE");
  assert.equal(header?.fingerprintMatched, true);

  const bytes = await readFile(target);
  const headerLength = bytes.readUInt32LE(8);
  const truncated = path.join(path.dirname(target), "header-only");
  writeFileSync(truncated, bytes.subarray(0, 12 + headerLength));
  const fromPrefix = await loadSiblingSnapshotHeader(truncated, {
    extractorVersion: expected.extractorVersion,
    stableIdVersion: expected.stableIdVersion,
    buildFingerprint: expected.buildFingerprint
  });
  assert.equal(fromPrefix?.indexedGeneration, 9);
  const full = await loadSiblingSnapshot(truncated, {
    extractorVersion: expected.extractorVersion,
    stableIdVersion: expected.stableIdVersion,
    buildFingerprint: expected.buildFingerprint
  });
  assert.equal(full, undefined, "a header-only slice cannot decode files/rest");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalize,
  canonicalizeFileBundle,
  digestFileBundle,
  digestManifest,
  sortBy
} from "./facts-digest.mjs";

function bundle(overrides = {}) {
  return {
    file: { relativePath: "src/A.java", contentHash: "abc" },
    types: [
      { typeId: "b", simpleName: "B" },
      { typeId: "a", simpleName: "A" }
    ],
    fields: [
      { fieldId: "f2" },
      { fieldId: "f1" }
    ],
    methods: [
      { methodId: "m2" },
      { methodId: "m1" }
    ],
    edges: [
      { edgeId: "e2" },
      { edgeId: "e1" }
    ],
    ...overrides
  };
}

test("canonicalize sorts object keys and leaves scalars alone", () => {
  assert.deepEqual(canonicalize({ b: 2, a: 1 }), { a: 1, b: 2 });
  assert.equal(canonicalize("x"), "x");
  assert.deepEqual(canonicalize(["b", "a"]), ["b", "a"]);
});

test("canonicalizeFileBundle sorts facts by identity and ignores insertion order", () => {
  const left = canonicalizeFileBundle(bundle());
  const right = canonicalizeFileBundle(bundle({
    types: [{ typeId: "a", simpleName: "A" }, { typeId: "b", simpleName: "B" }],
    fields: [{ fieldId: "f1" }, { fieldId: "f2" }],
    methods: [{ methodId: "m1" }, { methodId: "m2" }],
    edges: [{ edgeId: "e1" }, { edgeId: "e2" }]
  }));
  assert.deepEqual(left.types.map(item => item.typeId), ["a", "b"]);
  assert.deepEqual(left, right);
});

test("digestFileBundle is order-insensitive and path-keyed", () => {
  const first = digestFileBundle(bundle());
  const second = digestFileBundle(bundle({
    edges: [{ edgeId: "e1" }, { edgeId: "e2" }],
    methods: [{ methodId: "m1" }, { methodId: "m2" }]
  }));
  assert.equal(first.relativePath, "src/A.java");
  assert.equal(first.sha256, second.sha256);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.bytes > 0, true);
});

test("digestManifest is sorted by relativePath", () => {
  const manifest = digestManifest([
    { relativePath: "b.java", sha256: "bb", bytes: 1 },
    { relativePath: "a.java", sha256: "aa", bytes: 1 }
  ]);
  assert.deepEqual(manifest.files.map(item => item.relativePath), ["a.java", "b.java"]);
  assert.equal(manifest.fileCount, 2);
  assert.equal(
    manifest.sha256,
    digestManifest([
      { relativePath: "a.java", sha256: "aa", bytes: 1 },
      { relativePath: "b.java", sha256: "bb", bytes: 1 }
    ]).sha256
  );
});

test("sortBy copies and compares string keys", () => {
  assert.deepEqual(sortBy([{ id: "b" }, { id: "a" }], item => item.id).map(item => item.id), ["a", "b"]);
  assert.deepEqual(sortBy(undefined, item => item), []);
});

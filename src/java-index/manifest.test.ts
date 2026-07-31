import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeLayout } from "../layout-probe.js";
import {
  computeCurrentManifestFingerprint,
  computeCurrentSnapshotManifestFingerprint,
  computeManifestFingerprint,
  discoverJavaFiles,
  discoverMyBatisResourceFiles,
  scanSnapshotManifestDiff
} from "./manifest.js";

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

test("manifest discovers tracked and untracked Java files under source roots", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-"));
  write(root, "src/main/java/demo/A.java", "class A {}");
  write(root, "module/src/test/java/demo/BTest.java", "class BTest {}");
  write(root, "target/generated/Ignore.java", "class Ignore {}");

  const layout = probeLayout(root);
  const files = await discoverJavaFiles(root, layout);

  assert.deepEqual(
    files.map(file => file.relativePath).sort(),
    ["module/src/test/java/demo/BTest.java", "src/main/java/demo/A.java"]
  );
  const bFile = files.find(file => file.relativePath.endsWith("BTest.java"))!;
  assert.equal(bFile.sourceRoot, "module/src/test/java");
  assert.equal(bFile.absolutePath, path.join(root, "module/src/test/java/demo/BTest.java"));
});

test("a build/target directory nested inside a source root is not walked", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-nested-"));
  write(root, "src/main/java/demo/Good.java", "class Good {}");
  write(root, "src/main/java/demo/build/Generated.java", "class Generated {}");

  const layout = probeLayout(root);
  const files = await discoverJavaFiles(root, layout);

  assert.deepEqual(files.map(file => file.relativePath), ["src/main/java/demo/Good.java"]);
});

test("a source root with no test tree does not fail the walk", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-no-test-"));
  write(root, "src/main/java/demo/OnlyMain.java", "class OnlyMain {}");

  const layout = probeLayout(root);
  const files = await discoverJavaFiles(root, layout);

  assert.deepEqual(files.map(file => file.relativePath), ["src/main/java/demo/OnlyMain.java"]);
});

test("discoverMyBatisResourceFiles finds every .xml under src/main/resources, not src/test/resources, and skips build directories", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-resources-"));
  write(root, "src/main/resources/mapper/OrderMapper.xml", "<mapper namespace=\"demo.OrderMapper\"/>");
  write(root, "src/main/resources/application.properties", "a=1");
  write(root, "src/test/resources/mapper/TestMapper.xml", "<mapper namespace=\"demo.TestMapper\"/>");
  write(root, "src/main/resources/build/Generated.xml", "<mapper/>");
  // A module with its own resources tree - resourceRootInfos discovers this too.
  write(root, "module-a/src/main/resources/mapper/ModuleAMapper.xml", "<mapper namespace=\"demo.ModuleAMapper\"/>");

  const layout = probeLayout(root);
  const files = await discoverMyBatisResourceFiles(root, layout);

  assert.deepEqual(
    files.map(file => file.relativePath).sort(),
    ["module-a/src/main/resources/mapper/ModuleAMapper.xml", "src/main/resources/mapper/OrderMapper.xml"]
  );
});

test("discoverMyBatisResourceFiles on a repo with no resources directory returns an empty list without failing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-no-resources-"));
  write(root, "src/main/java/demo/A.java", "class A {}");

  const layout = probeLayout(root);
  const files = await discoverMyBatisResourceFiles(root, layout);

  assert.deepEqual(files, []);
});

test("computeManifestFingerprint is independent of entry order", () => {
  const a = computeManifestFingerprint([
    { relativePath: "src/main/java/demo/A.java", contentHash: "hash-a", sourceRoot: "src/main/java" },
    { relativePath: "src/main/java/demo/B.java", contentHash: "hash-b", sourceRoot: "src/main/java" }
  ]);
  const b = computeManifestFingerprint([
    { relativePath: "src/main/java/demo/B.java", contentHash: "hash-b", sourceRoot: "src/main/java" },
    { relativePath: "src/main/java/demo/A.java", contentHash: "hash-a", sourceRoot: "src/main/java" }
  ]);
  assert.equal(a, b);
});

test("computeManifestFingerprint changes when a content hash, path, or source root changes", () => {
  const base = [{ relativePath: "src/main/java/demo/A.java", contentHash: "hash-a", sourceRoot: "src/main/java" }];
  const baseline = computeManifestFingerprint(base);

  assert.notEqual(
    baseline,
    computeManifestFingerprint([{ ...base[0]!, contentHash: "hash-a-edited" }])
  );
  assert.notEqual(
    baseline,
    computeManifestFingerprint([{ ...base[0]!, relativePath: "src/main/java/demo/Renamed.java" }])
  );
  assert.notEqual(
    baseline,
    computeManifestFingerprint([{ ...base[0]!, sourceRoot: "src/test/java" }])
  );
});

test("computeManifestFingerprint keeps Java and mapper XML entries distinct even when their path and hash match", () => {
  const shared = {
    relativePath: "src/main/resources/mapper/OrderMapper.xml",
    contentHash: "same-content",
    sourceRoot: "src/main/resources"
  };
  const javaEntry = { ...shared, kind: "JAVA" as const };
  const mapperEntry = { ...shared, kind: "MYBATIS_XML" as const };

  assert.notEqual(
    computeManifestFingerprint([javaEntry]),
    computeManifestFingerprint([mapperEntry]),
    "schema-3 snapshot manifests must be a typed entry stream"
  );
});

test("computeCurrentManifestFingerprint reflects an independent re-scan of the current files on disk", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-fingerprint-"));
  write(root, "src/main/java/demo/A.java", "class A {}");
  const layout = probeLayout(root);

  const before = await computeCurrentManifestFingerprint(root, layout);
  const beforeAgain = await computeCurrentManifestFingerprint(root, layout);
  assert.equal(before, beforeAgain, "must be stable when nothing changed");

  write(root, "src/main/java/demo/A.java", "class A { void m() {} }");
  const afterEdit = await computeCurrentManifestFingerprint(root, layout);
  assert.notEqual(before, afterEdit, "a content edit must change the fingerprint");

  write(root, "src/main/java/demo/B.java", "class B {}");
  const afterAdd = await computeCurrentManifestFingerprint(root, probeLayout(root));
  assert.notEqual(afterEdit, afterAdd, "a newly added file must change the fingerprint");
});

test("computeCurrentSnapshotManifestFingerprint changes when a supported mapper XML changes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-snapshot-manifest-fingerprint-"));
  write(root, "src/main/java/demo/A.java", "class A {}");
  const mapper = "src/main/resources/mapper/OrderMapper.xml";
  write(root, mapper, '<mapper namespace="demo.OrderMapper"><select id="find">one</select></mapper>');
  const layout = probeLayout(root);

  const before = await computeCurrentSnapshotManifestFingerprint(root, layout);
  write(root, mapper, '<mapper namespace="demo.OrderMapper"><select id="find">two</select></mapper>');
  const after = await computeCurrentSnapshotManifestFingerprint(root, layout);

  assert.notEqual(before, after);
});

test("the write-side and disk-rescan manifest fingerprints agree for identical repo state", async () => {
  // Mirrors refreshFile's own contentHash computation (decode as UTF-8 text,
  // then hash that string as UTF-8) exactly, without needing a full
  // JavaIndexStore/worker round-trip, to pin the one normalization both
  // sides must never drift apart on.
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-fingerprint-agree-"));
  write(root, "src/main/java/demo/A.java", "class A {}");
  write(root, "module/src/test/java/demo/BTest.java", "class BTest {}");
  const layout = probeLayout(root);
  const discovered = await discoverJavaFiles(root, layout);

  const writeSideEntries = discovered.map(file => ({
    relativePath: file.relativePath,
    contentHash: createHash("sha256").update(writtenContent(file.relativePath), "utf8").digest("hex"),
    sourceRoot: file.sourceRoot
  }));
  const writeSideFingerprint = computeManifestFingerprint(writeSideEntries);
  const diskRescanFingerprint = await computeCurrentManifestFingerprint(root, layout);

  assert.equal(writeSideFingerprint, diskRescanFingerprint);

  function writtenContent(relativePath: string): string {
    if (relativePath.endsWith("A.java")) return "class A {}";
    if (relativePath.endsWith("BTest.java")) return "class BTest {}";
    throw new Error(`unexpected file: ${relativePath}`);
  }
});

test("snapshot manifest diff uses file metadata to isolate the paths that need content verification", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "java-manifest-incremental-diff-"));
  const a = "src/main/java/demo/A.java";
  const b = "src/main/java/demo/B.java";
  write(root, a, "class A {}");
  write(root, b, "class B {}");
  const layout = probeLayout(root);
  const snapshotFiles = [a, b].map(relativePath => {
    const absolutePath = path.join(root, relativePath);
    const stats = statSync(absolutePath);
    return {
      relativePath,
      sourceRoot: "src/main/java",
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs
    };
  });

  const unchanged = await scanSnapshotManifestDiff(root, layout, snapshotFiles);
  assert.equal(unchanged.metadataMatches, true);
  assert.deepEqual(unchanged.changed.map(file => file.relativePath), []);
  assert.deepEqual(unchanged.deletedRelativePaths, []);

  write(root, b, "class B { void changed() {} }");
  const changed = await scanSnapshotManifestDiff(root, layout, snapshotFiles);
  assert.equal(changed.metadataMatches, false);
  assert.deepEqual(changed.changed.map(file => file.relativePath), [b]);
  assert.deepEqual(changed.deletedRelativePaths, []);
});

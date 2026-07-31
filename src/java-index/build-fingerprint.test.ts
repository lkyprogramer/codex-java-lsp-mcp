import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeLayout } from "../layout-probe.js";
import { computeBuildFingerprint, computeExtractorVersion } from "./build-fingerprint.js";

function tempRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "build-fingerprint-"));
}

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

test("computeExtractorVersion follows the schema-3|facts-<n>|tree-sitter-<v>|tree-sitter-java-<v>|extractor-code-<hash> format", () => {
  const version = computeExtractorVersion();
  assert.match(version, /^schema-3\|facts-\d+\|tree-sitter-[^|]+\|tree-sitter-java-[^|]+\|extractor-code-.+$/);
  assert.equal(computeExtractorVersion(), version, "must be stable across calls within one process");
});

test("an mtime-only change does not change the build fingerprint", async () => {
  const root = tempRepo();
  write(root, "pom.xml", "<project/>");
  const layout = probeLayout(root);

  const before = await computeBuildFingerprint(root, layout);
  const future = new Date(Date.now() + 60_000);
  utimesSync(path.join(root, "pom.xml"), future, future);
  const after = await computeBuildFingerprint(root, layout);

  assert.equal(before, after);
});

test("a build file content change changes the fingerprint", async () => {
  const root = tempRepo();
  write(root, "pom.xml", "<project/>");
  const layout = probeLayout(root);

  const before = await computeBuildFingerprint(root, layout);
  write(root, "pom.xml", "<project><modelVersion>4.0.0</modelVersion></project>");
  const after = await computeBuildFingerprint(root, layout);

  assert.notEqual(before, after);
});

test("a module-level build file change changes the fingerprint", async () => {
  const root = tempRepo();
  write(root, "settings.gradle", "include 'module-a'");
  write(root, "module-a/build.gradle", "// v1");
  write(root, "module-a/src/main/java/demo/A.java", "class A {}");
  const layout = probeLayout(root);

  const before = await computeBuildFingerprint(root, layout);
  write(root, "module-a/build.gradle", "// v2");
  const after = await computeBuildFingerprint(root, layout);

  assert.notEqual(before, after);
});

test("a source-root/layout change changes the fingerprint", async () => {
  const root = tempRepo();
  write(root, "src/main/java/demo/A.java", "class A {}");
  const layoutBefore = probeLayout(root);
  const before = await computeBuildFingerprint(root, layoutBefore);

  write(root, "src/test/java/demo/ATest.java", "class ATest {}");
  const layoutAfter = probeLayout(root);
  const after = await computeBuildFingerprint(root, layoutAfter);

  assert.notEqual(before, after);
});

test("the order filesystem entries are enumerated in does not affect the fingerprint", async () => {
  const rootA = tempRepo();
  write(rootA, "pom.xml", "<project/>");
  write(rootA, ".java-version", "21");
  const rootB = tempRepo();
  // Same content, written in the opposite order.
  write(rootB, ".java-version", "21");
  write(rootB, "pom.xml", "<project/>");

  const fingerprintA = await computeBuildFingerprint(rootA, probeLayout(rootA));
  const fingerprintB = await computeBuildFingerprint(rootB, probeLayout(rootB));

  assert.equal(fingerprintA, fingerprintB);
});

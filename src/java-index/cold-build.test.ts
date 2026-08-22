import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runColdIndexBuild } from "./cold-build.js";

test("cold build reports phase timings that cover the wall clock", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "cold-build-phases-"));
  const cacheDir = await mkdtemp(path.join(tmpdir(), "cold-build-cache-"));
  const javaDir = path.join(repoRoot, "src", "main", "java", "demo");
  await mkdir(javaDir, { recursive: true });
  await writeFile(path.join(repoRoot, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
  await writeFile(path.join(javaDir, "Solo.java"), "package demo;\n\nclass Solo {}\n");
  const result = await runColdIndexBuild(repoRoot, cacheDir, 1);
  assert.equal(result.ok, true);
  const sum = result.phasesMs.discover + result.phasesMs.parse + result.phasesMs.resolve
    + result.phasesMs.snapshotPrepare + result.phasesMs.snapshotEncode + result.phasesMs.graphEncode;
  assert.ok(result.phasesMs.total >= sum - 50, `total ${result.phasesMs.total} vs phases ${sum}`);
  assert.ok(result.phasesMs.total > 0);
});

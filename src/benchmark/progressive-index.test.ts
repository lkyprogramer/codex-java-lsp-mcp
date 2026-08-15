import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runProgressiveIndex, type ProgressiveScenario } from "./progressive-index.js";

async function writeJava(root: string, relativePath: string, source: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, source);
}

test("progressive benchmark proves BUILDING anchor closure, complete coverage and durable snapshot", async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "progressive-index-repo-"));
  const cacheDir = await mkdtemp(path.join(tmpdir(), "progressive-index-cache-"));
  try {
    await writeFile(path.join(repoRoot, "pom.xml"), "<project><modelVersion>4.0.0</modelVersion></project>\n");
    await Promise.all([
      writeJava(repoRoot, "src/main/java/demo/Anchor.java", [
        "package demo;",
        "import demo.contract.Port;",
        "class Anchor { Port port; }",
        ""
      ].join("\n")),
      writeJava(repoRoot, "src/main/java/demo/contract/Port.java", "package demo.contract; public interface Port {}\n"),
      writeJava(repoRoot, "src/main/java/demo/impl/PortImpl.java", "package demo.impl; import demo.contract.Port; public class PortImpl implements Port {}\n"),
      ...Array.from({ length: 180 }, (_, index) => writeJava(
        repoRoot,
        `src/main/java/demo/filler/Filler${String(index).padStart(3, "0")}.java`,
        `package demo.filler; public class Filler${index} {}\n`
      ))
    ]);
    const scenario: ProgressiveScenario = {
      projectId: "fixture",
      repoCommit: "fixture",
      anchorScenarioId: "anchor-port",
      anchor: { file: "src/main/java/demo/Anchor.java", line: 3, column: 7 },
      requiredTypeDefinitions: [{
        typeText: "demo.contract.Port",
        expectedFile: "src/main/java/demo/contract/Port.java"
      }],
      requiredImplementer: {
        typeText: "demo.contract.Port",
        expectedFile: "src/main/java/demo/impl/PortImpl.java",
        limit: 8
      },
      missingTypeFqn: "fixture.missing.DoesNotExist"
    };
    const result = await runProgressiveIndex({
      repoRoot,
      indexCacheDir: cacheDir,
      scenario,
      pollMs: 5,
      timeoutMs: 20_000
    });
    const evidence = JSON.stringify(result, null, 2);
    assert.equal(result.stages.open.state, "REACHED", evidence);
    assert.equal(result.stages.anchorReady.state, "REACHED", evidence);
    assert.equal(result.stages.moduleReady.state, "REACHED", evidence);
    assert.equal(result.stages.complete.state, "REACHED", evidence);
    assert.equal(result.stages.snapshotDurable.state, "REACHED", evidence);
    assert.equal(result.negativeLookup.beforeComplete.state, "UNRESOLVED");
    assert.notEqual(result.negativeLookup.beforeComplete.coverage, "COMPLETE");
    assert.equal(result.negativeLookup.beforeComplete.authoritative, false);
    assert.deepEqual(result.negativeLookup.afterComplete, {
      state: "UNRESOLVED",
      coverage: "COMPLETE",
      authoritative: true
    });
    assert.match(result.finalSemanticDigest ?? "", /^[a-f0-9]{64}$/);
    assert.ok(result.events.some(event => event.status.coverage.some(root => root.state === "BUILDING")));
  } finally {
    await Promise.all([
      rm(repoRoot, { recursive: true, force: true }),
      rm(cacheDir, { recursive: true, force: true })
    ]);
  }
});

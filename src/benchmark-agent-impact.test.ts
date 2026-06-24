import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("benchmark loads scenarios from external jsonl and prints metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-benchmark-"));
  const goldenDir = path.join(root, "golden");
  await mkdir(goldenDir, { recursive: true });
  const scenarioFile = path.join(goldenDir, "generic-java.scenarios.jsonl");
  await writeFile(scenarioFile, `${JSON.stringify({
    id: "demo",
    name: "Demo",
    repoCommit: "fixture",
    projectId: "generic-java",
    layoutProfile: "generic-java",
    scenarioVersion: 1,
    warmState: "cold-nolsp",
    anchor: {
      file: "src/main/java/demo/Demo.java",
      line: 1,
      column: 1,
      profile: "service"
    },
    golden: {
      mustHit: ["src/main/java/demo/Demo.java"],
      shouldHit: [],
      side: []
    }
  })}\n`);

  const result = spawnSync(process.execPath, [
    "dist/benchmark-agent-impact.js",
    "--repo-root", root,
    "--scenarios", scenarioFile,
    "--project-id", "generic-java",
    "--warm-state", "cold-nolsp",
    "--list-scenarios"
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.metadata.projectId, "generic-java");
  assert.equal(payload.metadata.warmState, "cold-nolsp");
  assert.equal(payload.scenarios[0].id, "demo");
});

test("benchmark can run a no-lsp token baseline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "java-lsp-benchmark-nolsp-"));
  const srcDir = path.join(root, "src", "main", "java", "demo");
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(root, "pom.xml"), "<project></project>\n");
  await writeFile(path.join(srcDir, "DemoController.java"), [
    "package demo;",
    "public class DemoController {",
    "  public DemoResponse updateDemo(DemoRequest request) { return null; }",
    "}",
    ""
  ].join("\n"));
  await writeFile(path.join(srcDir, "DemoRequest.java"), "package demo; public record DemoRequest(String name) {}\n");
  await writeFile(path.join(srcDir, "DemoResponse.java"), "package demo; public record DemoResponse(String name) {}\n");

  const scenarioFile = path.join(root, "generic-java.scenarios.jsonl");
  await writeFile(scenarioFile, `${JSON.stringify({
    id: "demo-update",
    name: "DemoController#updateDemo",
    projectId: "generic-java",
    layoutProfile: "generic-java",
    scenarioVersion: 1,
    warmState: "cold-nolsp",
    anchor: {
      file: "src/main/java/demo/DemoController.java",
      line: 3,
      column: 29,
      profile: "controller",
      taskKeywords: ["demo", "update"]
    },
    golden: {
      mustHit: ["src/main/java/demo/DemoController.java", "src/main/java/demo/DemoRequest.java", "src/main/java/demo/DemoResponse.java"],
      shouldHit: [],
      side: []
    }
  })}\n`);

  const result = spawnSync(process.execPath, [
    "dist/benchmark-agent-impact.js",
    "--repo-root", root,
    "--scenarios", scenarioFile,
    "--project-id", "generic-java",
    "--warm-state", "cold-nolsp",
    "--strategy", "no-lsp",
    "--runs", "1"
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const attempt = payload.rows[0].attempts[0];
  assert.equal(payload.metadata.strategy, "no-lsp");
  assert.equal(attempt.strategy, "no-lsp");
  assert.ok(attempt.estimatedTokens > 0);
  assert.ok(attempt.rgRawBytesExposed > 0);
});

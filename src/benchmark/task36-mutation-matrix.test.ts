import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Task 36 mutation gate reports nine watcher-driven mutations and a truthful overlapping AgentRouter request", () => {
  const artifactDir = mkdtempSync(path.join(tmpdir(), "task36-mutation-matrix-"));
  const output = path.join(artifactDir, "result.json");
  const result = spawnSync(process.execPath, [
    "dist/benchmark/task36-mutation-matrix.js",
    "--output", output
  ], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    encoding: "utf8",
    timeout: 60_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(readFileSync(output, "utf8")) as {
    gate: { staleCount: number; expectedCases: number; passed: boolean };
    watcher: { ready: boolean; batches: number; generations: number[] };
    overlapProbe: {
      source: string;
      requestGeneration: number;
      indexedGeneration: number;
      changedDuringRequest: boolean;
    };
    cases: Array<{
      id: string;
      staleCount: number;
      oldFactAbsent: boolean;
      changedDuringRequest: boolean;
      requestGeneration: number;
      indexedGeneration: number;
    }>;
  };

  assert.deepEqual(payload.cases.map(item => item.id), [
    "method-body",
    "package-private-method",
    "nested-record",
    "rename-java-type-file",
    "delete-java-file",
    "duplicate-simple-name-import-switch",
    "pom-module",
    "mybatis-xml-statement",
    "malformed-java-repair"
  ]);
  assert.equal(payload.gate.expectedCases, 9);
  assert.equal(payload.gate.staleCount, 0);
  assert.equal(payload.gate.passed, true);
  assert.ok(payload.cases.every(item => item.staleCount === 0));
  assert.ok(payload.cases.every(item => item.oldFactAbsent));
  assert.ok(payload.cases.every(item => item.requestGeneration === item.indexedGeneration));
  assert.ok(payload.cases.every(item => item.changedDuringRequest === false));
  assert.equal(payload.watcher.ready, true);
  assert.ok(payload.watcher.batches >= 9);
  assert.ok(payload.watcher.generations.every((generation, index, values) => index === 0 || generation > values[index - 1]));
  assert.equal(payload.overlapProbe.source, "agent-router");
  assert.equal(payload.overlapProbe.changedDuringRequest, true);
  assert.ok(payload.overlapProbe.indexedGeneration > payload.overlapProbe.requestGeneration);
});

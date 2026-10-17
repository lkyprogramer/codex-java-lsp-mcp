import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Task 36 mutation gate reports nine tracker-driven mutations through request views and a held view across a publish", () => {
  const artifactDir = mkdtempSync(path.join(tmpdir(), "task36-mutation-matrix-"));
  const output = path.join(artifactDir, "result.json");
  const result = spawnSync(process.execPath, [
    "dist/benchmark/task36-mutation-matrix.js",
    "--output", output
  ], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    encoding: "utf8",
    timeout: 300_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(readFileSync(output, "utf8")) as {
    schemaVersion: number;
    gate: { staleCount: number; expectedCases: number; passed: boolean };
    tracker: { signals: string; ready: boolean; publishes: number; generations: number[] };
    overlapProbe: {
      source: string;
      requestGeneration: number;
      indexedGeneration: number;
      changedDuringRequest: boolean;
      heldSnapshotId: string;
      latestSnapshotId: string;
      latestGeneration: number;
    };
    cases: Array<{
      id: string;
      staleCount: number;
      oldFactAbsent: boolean;
      viewState: string;
      changedDuringRequest: boolean;
      requestGeneration: number;
      indexedGeneration: number;
    }>;
  };

  assert.equal(payload.schemaVersion, 2);
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
  assert.ok(payload.cases.every(item => item.viewState === "FRESH"));
  assert.ok(payload.cases.every(item => item.requestGeneration === item.indexedGeneration));
  assert.ok(payload.cases.every(item => item.changedDuringRequest === false));
  assert.equal(payload.tracker.signals, "injected");
  assert.equal(payload.tracker.ready, true);
  assert.ok(payload.tracker.publishes >= 10, "the first build plus one publish per mutation");
  assert.ok(payload.tracker.generations.every((generation, index, values) => index === 0 || generation > values[index - 1]));
  assert.equal(payload.overlapProbe.source, "agent-router");
  assert.equal(payload.overlapProbe.changedDuringRequest, false, "a publish during the request does not upgrade its held view");
  assert.equal(payload.overlapProbe.indexedGeneration, payload.overlapProbe.requestGeneration);
  assert.ok(payload.overlapProbe.latestGeneration > payload.overlapProbe.requestGeneration);
  assert.notEqual(payload.overlapProbe.latestSnapshotId, payload.overlapProbe.heldSnapshotId);
});

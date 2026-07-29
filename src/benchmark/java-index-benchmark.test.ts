import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("java index microbenchmark emits every Task 23 measurement from a real worker run", () => {
  const artifactDir = mkdtempSync(path.join(tmpdir(), "java-index-benchmark-artifact-"));
  const output = path.join(artifactDir, "result.json");
  const result = spawnSync(process.execPath, [
    "dist/benchmark/java-index-benchmark.js",
    "--files", "64",
    "--samples", "12",
    "--output", output
  ], {
    cwd: path.resolve(import.meta.dirname, "..", ".."),
    encoding: "utf8",
    timeout: 60_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(payload.fixture.files, 64);
  assert.equal(payload.factEquivalence.incrementalEqualsFull, true);
  assert.ok(payload.snapshot.bytes > 0);
  assert.ok(payload.eventLoopDelay.sweepP99Ms >= 0);
  assert.equal(payload.mutationMatrix.staleCount, 0);
  assert.deepEqual(
    payload.mutationMatrix.operations.map((operation: { id: string }) => operation.id),
    ["method-signature", "add-implementer", "rename-type", "move-package", "delete-type", "pom-module"]
  );
  assert.ok(payload.mutationMatrix.operations.every((operation: { visibleMs: number }) => operation.visibleMs >= 0));
  assert.equal(
    payload.mutationMatrix.operations.find((operation: { id: string }) => operation.id === "method-signature").previousFactAbsent,
    true
  );
  assert.ok(payload.worktreeSeed.synthetic.seeded.reusedFiles > 0);
  assert.equal(payload.worktreeSeed.synthetic.seeded.modifiedTargetReused, false);
  assert.equal(payload.worktreeSeed.synthetic.seeded.deletedSourceFactVisible, false);
  assert.equal(payload.worktreeSeed.synthetic.seeded.negativeLookupAllowed, false);
  assert.equal(payload.worktreeSeed.synthetic.postReconcileEquivalent, true);
  for (const key of [
    "freshFullSweepMs",
    "snapshotLoadMs",
    "fullParseRefreshMs",
    "incrementalRefreshMs",
    "typeLookupMs",
    "implementerLookupMs",
    "callerLookupMs"
  ]) {
    assert.ok(payload.measurements[key].p95Ms >= 0, `missing ${key}`);
    assert.equal(payload.measurements[key].samples, 12, `${key} samples`);
  }
});

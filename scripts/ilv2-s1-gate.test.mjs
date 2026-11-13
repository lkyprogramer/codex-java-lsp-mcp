import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { evaluateGate, runS1Gate, targetChanges } from "./ilv2-s1-gate.mjs";

// One scored task in the shape scoreObservation writes, C0 only.
const row = (taskId, category, credited, bytes, extra = {}) => ({
  taskId, category, planTerms: 1,
  configs: { C0: {
    score: { required: credited.length, credited: credited.filter(Boolean).length, recall: credited.filter(Boolean).length / credited.length, bytes },
    payloadBytes: 100, callBytes: [100], callExact: ["match"], partialCalls: 0, coreExceededCalls: 0,
    targets: credited.map(hit => ({ kind: "java", credited: hit, label: hit ? "IMPACT_SPAN" : "UNSELECTED" })),
    ...extra
  } }
});

test("an unchanged run passes every gate", () => {
  const base = [row("t1", "implementations", [true, false], 1000), row("t2", "callers", [true], 2000)];
  const result = evaluateGate(base, base);
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.lostTargets, { count: 0, byCategory: {} });
});

test("losing one credited target fails even when mean recall rises elsewhere", () => {
  const base = [row("t1", "implementations", [true, false], 1000), row("t2", "callers", [false, false], 1000)];
  const s1 = [row("t1", "implementations", [false, false], 1000), row("t2", "callers", [true, true], 1000)];
  const result = evaluateGate(base, s1);
  assert.equal(result.gates.meanRecallNonInferior, true);
  assert.equal(result.gates.lostTargets, false);
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.lostTargets, { count: 1, byCategory: { implementations: 1 } });
  assert.deepEqual(result.gainedTargets.byCategory, { callers: 2 });
  assert.deepEqual(result.changes.lost, [{ taskId: "t1", category: "implementations", index: 0, kind: "java", before: "IMPACT_SPAN", after: "UNSELECTED" }]);
});

test("received bytes p50 may grow by 20 percent and no more", () => {
  const base = [row("t1", "callers", [true], 1000)];
  assert.equal(evaluateGate(base, [row("t1", "callers", [true], 1200)]).gates.receivedBytesP50, true);
  const over = evaluateGate(base, [row("t1", "callers", [true], 1201)]);
  assert.equal(over.gates.receivedBytesP50, false);
  assert.equal(over.status, "FAIL");
});

test("a lower mean recall fails", () => {
  const result = evaluateGate([row("t1", "callers", [true, true], 1000)], [row("t1", "callers", [true, false], 1000)]);
  assert.equal(result.gates.meanRecallNonInferior, false);
});

test("runs over different tasks or target counts are refused", () => {
  assert.throws(() => targetChanges([row("t1", "callers", [true], 1)], [row("t2", "callers", [true], 1)]), /same tasks/);
  assert.throws(() => targetChanges([row("t1", "callers", [true], 1)], [row("t1", "callers", [true, true], 1)]), /target count/);
});

test("the run checks the baseline hash and keeps task ids out of the summary", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "s1-gate-"));
  try {
    const base = `${JSON.stringify(row("secret-task", "callers", [true], 1000))}\n`;
    const s1 = `${JSON.stringify(row("secret-task", "callers", [false], 1000))}\n`;
    await writeFile(path.join(dir, "base.jsonl"), base);
    await writeFile(path.join(dir, "s1.jsonl"), s1);
    const args = { baselineRowsFile: path.join(dir, "base.jsonl"), rowsFile: path.join(dir, "s1.jsonl"), out: path.join(dir, "out") };
    await assert.rejects(runS1Gate({ ...args, expectBaselineRowsSha256: "0".repeat(64) }), /recorded D15-F artifact/);
    const summary = await runS1Gate({ ...args, expectBaselineRowsSha256: createHash("sha256").update(base).digest("hex") });
    assert.equal(summary.status, "FAIL");
    assert.doesNotMatch(JSON.stringify(summary), /secret-task/);
    assert.match(await readFile(path.join(dir, "out/target-changes.json"), "utf8"), /secret-task/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

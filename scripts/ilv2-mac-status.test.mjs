import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkStatus, derivedStatus } from "./ilv2-mac-status.mjs";

const json = value => `${JSON.stringify(value, null, 2)}\n`;

async function fixture(t, gates, results = {}, manual = "状态见 `docs/index-lifecycle-v2/mac/status.json`。\n", openDecisions = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(results)) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "task-result.json"), json(value));
  }
  await writeFile(path.join(root, "status.json"), json({ schema: "ilv2-mac-status/v1", gates, openDecisions }));
  await writeFile(path.join(root, "manual.md"), manual);
  return { statusFile: path.join(root, "status.json"), manualFile: path.join(root, "manual.md") };
}

test("parent status is derived from children", () => {
  const byId = new Map([["A", { status: "PASS" }], ["B", { status: "PLAN" }], ["C", { status: "FAIL" }]]);
  assert.equal(derivedStatus({ children: ["A", "A"] }, byId), "PASS");
  assert.equal(derivedStatus({ children: ["B", "B"] }, byId), "PLAN");
  assert.equal(derivedStatus({ children: ["A", "B"] }, byId), "IN_PROGRESS");
  assert.equal(derivedStatus({ children: ["A", "C"] }, byId), "FAIL");
});

test("consistent status file passes and reports derived parent status", async t => {
  const files = await fixture(t, [
    { gateId: "G1A", status: "PASS", result: "one/task-result.json" },
    { gateId: "G1B", status: "PLAN" },
    { gateId: "G1", children: ["G1A", "G1B"], result: "parent/task-result.json" }
  ], { one: { gateId: "G1A", status: "PASS" }, parent: { gateId: "G1", status: "IN_PROGRESS", children: [{ gateId: "G1A", status: "PASS" }] } });
  const result = await checkStatus(files);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.summary.map(row => row.status), ["PASS", "PLAN", "IN_PROGRESS"]);
});

test("drift, stored parent status, orphans and manual status copies are rejected", async t => {
  const files = await fixture(t, [
    { gateId: "G1A", status: "PASS", result: "one/task-result.json" },
    { gateId: "G1", status: "PASS", children: ["G1A"] },
    { gateId: "G2", status: "PASS" }
  ], { one: { gateId: "G1A", status: "IN_PROGRESS", evidence: [{ name: "probe" }] }, orphan: { gateId: "G9", status: "PASS" } }, "**执行状态：** PASS\n",
  [{ id: "D1", evidence: { result: "one/task-result.json", name: "probe" } }, { id: "D2", evidence: { result: "one/task-result.json", name: "gone" } }, { id: "D3", evidence: { result: "missing/task-result.json", name: "probe" } }]);
  const { status, errors } = await checkStatus(files);
  assert.ok(!errors.some(error => error.startsWith("D1:")), JSON.stringify(errors));
  assert.equal(status, "FAIL");
  for (const pattern of [/G1A: status.json PASS but one\/task-result.json records IN_PROGRESS/, /G1: parent status is derived/, /G2: PASS requires a task-result/,
    /orphan\/task-result.json is not referenced/, /repeats per-card execution status/, /must reference status.json/, /D2: one\/task-result.json has no evidence gone/, /D3: unreadable evidence/]) {
    assert.ok(errors.some(error => pattern.test(error)), `${pattern} not in ${JSON.stringify(errors)}`);
  }
});

test("repository status.json agrees with every task-result and the manual", async () => {
  const result = await checkStatus();
  assert.deepEqual(result.errors, []);
});

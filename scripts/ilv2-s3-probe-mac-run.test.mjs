import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REQUIRED_ENV, notifyMac, probeStages, reportFor, runProbeValidation } from "./ilv2-s3-probe-mac-run.mjs";

const tempRun = () => mkdtemp(path.join(os.tmpdir(), "s3-run-"));

test("the stage table runs preflight, the probe tests, the build and the probe, each stopping the run on failure", () => {
  const stages = probeStages({ env: {}, runDir: "/runs/x" });
  assert.deepEqual(stages.map(stage => [stage.name, stage.stop]), [["preflight", true], ["probe-tests", true], ["build", true], ["probe", true]]);
  assert.ok(stages.every(stage => stage.timeoutMs > 0));
});

test("a missing environment fails preflight, leaves the rest not run, writes a terminal result and notifies once", async () => {
  const dir = await tempRun();
  try {
    const notes = [];
    const result = await runProbeValidation({ runDir: dir, env: {}, notify: async note => { notes.push(note); return { sent: true }; } });
    assert.equal(result.status, "FAIL");
    assert.deepEqual([result.failedStage, result.notRun], ["preflight", ["probe-tests", "build", "probe"]]);
    for (const name of REQUIRED_ENV) assert.ok(result.stages[0].problems.includes(`${name} is not exported`), name);
    assert.equal(JSON.parse(await readFile(path.join(dir, "result.json"), "utf8")).status, "FAIL");
    assert.deepEqual(notes.map(note => [note.status, note.failedStage]), [["FAIL", "preflight"]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a run directory with other files is refused before anything runs", async () => {
  const dir = await tempRun();
  try {
    await writeFile(path.join(dir, "stray.txt"), "x");
    await assert.rejects(runProbeValidation({ runDir: dir, env: {}, notify: async () => ({ sent: true }) }), /must be empty/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("without osascript the notification is skipped, not fatal", async () => {
  assert.deepEqual(await notifyMac({ status: "PASS", gitSha: "abc", runDir: "/r", osascript: "/nonexistent/osascript" }), { sent: false, reason: "no osascript" });
});

test("the report strips absolute paths and carries the probe counts", async () => {
  const dir = await tempRun();
  try {
    await writeFile(path.join(dir, "result.json"), JSON.stringify({ status: "FAIL", gitSha: "abc", failedStage: "probe", notRun: [], firstError: null,
      stages: [{ name: "probe", status: "FAIL", exitCode: 1, problems: ["cannot read /Users/me/private/run/rows.jsonl"] }], facts: { probe: { targets: { reachable: 0 } } }, artifacts: {} }));
    const report = await reportFor(dir);
    assert.doesNotMatch(JSON.stringify(report), /Users|private/);
    assert.deepEqual(report.probe, { targets: { reachable: 0 } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

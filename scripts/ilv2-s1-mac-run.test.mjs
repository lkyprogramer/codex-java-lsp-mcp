import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile as writeFileFs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkBaselineGate, checkMechanism, parseValidationRoot, redactPaths, reportFor, runStages, terminalStatus } from "./ilv2-s1-mac-run.mjs";

const recorded = JSON.parse(await readFile(new URL("../docs/post-ilv2/results/D18-SHAPE.json", import.meta.url), "utf8")).summary.shapes;
const clone = value => JSON.parse(JSON.stringify(value));
const h0Rows = rows => rows.map((row, index) => [row, index]).filter(([row]) => row.hypotheses.includes("H0_UNEXPLAINED")).map(([, index]) => index);

/** The rerun S1 is expected to produce: H0 targets enter the pool with a protected reason; everything else unchanged. */
function expectedRerun() {
  const rows = clone(recorded);
  for (const index of h0Rows(rows)) Object.assign(rows[index].repro, { inPool: true, protectedReason: true, poolSize: rows[index].repro.poolSize + 2 });
  return rows;
}

test("the recorded D18 shapes carry the 2 H0 rows the mechanism check expects", () => {
  assert.equal(recorded.length, 13);
  assert.equal(h0Rows(recorded).length, 2);
});

test("mechanism passes when only the H0 targets change, as §3.1 expects", () => {
  assert.deepEqual(checkMechanism(recorded, expectedRerun()), { pass: true, problems: [] });
});

test("mechanism fails when an H0 target is still not proven", () => {
  const rows = expectedRerun();
  rows[h0Rows(rows)[0]].repro.protectedReason = false;
  assert.equal(checkMechanism(recorded, rows).pass, false);
});

test("mechanism fails when the call continuation grew on the H0 anchor", () => {
  const rows = expectedRerun();
  rows[h0Rows(rows)[1]].repro.poolWith.CALLS += 1;
  assert.match(checkMechanism(recorded, rows).problems.join(), /CALLS 0 -> 1/);
});

test("mechanism fails when another row's pool changed or the rows are misaligned", () => {
  const changed = expectedRerun();
  changed[0].repro.poolWith.typeGraph += 1;
  assert.match(checkMechanism(recorded, changed).problems.join(), /row 0 .*poolWith changed/);
  assert.equal(checkMechanism(recorded, expectedRerun().slice(1)).pass, false);
});

test("baseline gate requires main to reproduce F exactly", () => {
  const same = { lostTargets: { count: 0 }, gainedTargets: { count: 0 }, receivedBytesP50Increase: 0 };
  assert.equal(checkBaselineGate(same).pass, true);
  assert.equal(checkBaselineGate({ ...same, gainedTargets: { count: 1 } }).pass, false);
  assert.equal(checkBaselineGate({ ...same, receivedBytesP50Increase: 0.01 }).pass, false);
});

test("the kept build root comes from the last validationRoot line", () => {
  const stdout = 'noise\n{"other":1}\n{"validationRoot":"/run/tmp/a","result":"/r.json","gateStatus":"NOT_CLAIMED","cleanupError":null}\n';
  assert.equal(parseValidationRoot(stdout), "/run/tmp/a");
  assert.throws(() => parseValidationRoot("no json"), /no validationRoot/);
});

test("terminal status: any timeout, else any non-pass, else pass", () => {
  assert.equal(terminalStatus([{ status: "PASS" }, { status: "PASS" }]), "PASS");
  assert.equal(terminalStatus([{ status: "PASS" }, { status: "FAIL" }]), "FAIL");
  assert.equal(terminalStatus([{ status: "FAIL" }, { status: "TIMEOUT" }]), "TIMEOUT");
});

const tempRun = () => mkdtemp(path.join(os.tmpdir(), "s1-run-"));
const readResult = async dir => JSON.parse(await readFile(path.join(dir, "result.json"), "utf8"));
const node = process.execPath;

test("a failing prepare still restores, writes a terminal result and leaves later stages not run", async () => {
  const dir = await tempRun();
  try {
    let restored = 0;
    const result = await runStages({ runDir: dir, gitSha: "abc", heartbeatMs: 50, stages: [
      { name: "build", timeoutMs: 1000, stop: true, prepare: async () => { throw new Error("apply failed"); }, restore: async () => { restored += 1; }, check: async () => ({ pass: true }) },
      { name: "later", timeoutMs: 1000, stop: true, check: async () => ({ pass: true }) }
    ] });
    assert.equal(restored, 1);
    assert.equal(result.status, "FAIL");
    const written = await readResult(dir);
    assert.deepEqual([written.status, written.failedStage, written.notRun], ["FAIL", "build", ["later"]]);
    assert.match(written.stages[0].problems[0], /apply failed/);
    assert.equal(JSON.parse(await readFile(path.join(dir, "status.json"), "utf8")).state, "FAIL");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a stage past its timeout is killed as a group, restored and reported TIMEOUT", async () => {
  const dir = await tempRun();
  try {
    let restored = false;
    const started = Date.now();
    const result = await runStages({ runDir: dir, gitSha: "abc", heartbeatMs: 50, killGraceMs: 200, stages: [
      { name: "hang", timeoutMs: 300, stop: true, command: node, args: () => ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        restore: async () => { restored = true; }, check: async () => ({ pass: true }) }
    ] });
    assert.equal(result.status, "TIMEOUT");
    assert.equal(restored, true);
    assert.ok(Date.now() - started < 5000, "SIGKILL follows an ignored SIGTERM");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a descendant holding the output pipes does not keep a finished stage open", async () => {
  const dir = await tempRun();
  try {
    const started = Date.now();
    const result = await runStages({ runDir: dir, gitSha: "abc", heartbeatMs: 50, stages: [
      { name: "leak", timeoutMs: 20_000, stop: true, command: "sh", args: () => ["-c", "(sleep 5 &); echo done"], check: async run => ({ pass: run.exitCode === 0 && run.stdout.includes("done") }) }
    ] });
    assert.equal(result.status, "PASS");
    assert.ok(Date.now() - started < 3000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an unmet need is a non-runnable failure; a non-stopping failure lets later stages run", async () => {
  const dir = await tempRun();
  try {
    const result = await runStages({ runDir: dir, gitSha: "abc", heartbeatMs: 50, stages: [
      { name: "tests", timeoutMs: 1000, stop: false, check: async () => ({ pass: false, problems: ["1 failing"] }) },
      { name: "measure", timeoutMs: 1000, stop: false, needs: () => "no build", check: async () => ({ pass: true }) },
      { name: "report", timeoutMs: 1000, stop: false, check: async () => ({ pass: true }) }
    ] });
    assert.deepEqual(result.stages.map(stage => [stage.name, stage.status]), [["tests", "FAIL"], ["measure", "FAIL"], ["report", "PASS"]]);
    assert.match(result.stages[1].problems[0], /not runnable: no build/);
    assert.equal(result.status, "FAIL");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the report strips absolute paths", async () => {
  assert.equal(redactPaths("cannot read /Users/me/run/x.json: ENOENT"), "cannot read <path>: ENOENT");
  const dir = await tempRun();
  try {
    await writeFileFs(path.join(dir, "result.json"), JSON.stringify({ status: "FAIL", gitSha: "abc", failedStage: "preflight", notRun: ["b"],
      firstError: null, stages: [{ name: "preflight", status: "FAIL", problems: ["F_RUN /Users/me/private/run/rows.jsonl missing"] }], facts: {}, artifacts: {} }));
    const report = await reportFor(dir);
    assert.doesNotMatch(JSON.stringify(report), /Users|private/);
    assert.equal(report.stages[0].problems[0], "F_RUN <path> missing");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

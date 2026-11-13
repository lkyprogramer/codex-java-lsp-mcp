import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkBaselineGate, checkMechanism, parseValidationRoot, terminalStatus } from "./ilv2-s1-mac-run.mjs";

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

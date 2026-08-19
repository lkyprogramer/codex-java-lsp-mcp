import assert from "node:assert/strict";
import test from "node:test";
import { GATE_PROFILES } from "./run-v4-gates.mjs";

const FULL_ARGV = ["scripts/run-isolated-validation.mjs", "--profile", "full"];

test("PR, nightly, and release gate profiles execute different work", () => {
  const pr = JSON.stringify(GATE_PROFILES.pr.steps);
  const nightly = JSON.stringify(GATE_PROFILES.nightly.steps);
  const release = JSON.stringify(GATE_PROFILES.release.steps);
  assert.notEqual(pr, nightly);
  assert.notEqual(nightly, release);
  assert.notEqual(pr, release);
  const allFull = [GATE_PROFILES.pr, GATE_PROFILES.nightly, GATE_PROFILES.release].every(profile =>
    profile.steps.length === 1 && JSON.stringify(profile.steps[0].args) === JSON.stringify(FULL_ARGV)
  );
  assert.equal(allFull, false);
});

test("PR-fast does not run isolated full", () => {
  const argv = GATE_PROFILES.pr.steps.flatMap(step => step.args);
  assert.equal(argv.includes("full"), false);
  assert.equal(argv.includes("targeted"), true);
  assert.equal(argv.includes("dist/**/*.test.js"), true);
});

test("nightly is isolated full without HTTP smoke", () => {
  assert.equal(GATE_PROFILES.nightly.steps.length, 1);
  assert.deepEqual(GATE_PROFILES.nightly.steps[0].args, FULL_ARGV);
  const argv = GATE_PROFILES.nightly.steps.flatMap(step => step.args).join(" ");
  assert.equal(argv.includes("run-v4-http-smoke"), false);
});

test("release adds HTTP smoke after isolated full", () => {
  assert.ok(GATE_PROFILES.release.steps.length >= 2);
  assert.deepEqual(GATE_PROFILES.release.steps[0].args, FULL_ARGV);
  const argv = GATE_PROFILES.release.steps.flatMap(step => step.args).join(" ");
  assert.equal(argv.includes("run-v4-http-smoke.mjs"), true);
});

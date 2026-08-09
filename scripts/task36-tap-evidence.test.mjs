import assert from "node:assert/strict";
import test from "node:test";
import { selectedSubtestNames, selectedSubtests } from "./task36-tap-evidence.mjs";

test("a Node test-file wrapper PASS does not count as a selected behavior test", () => {
  const output = [
    "TAP version 13",
    "1..0",
    "# Subtest: dist/jdtls-session.test.js",
    "ok 1 - dist/jdtls-session.test.js",
    "1..1",
    "# tests 1",
    "# pass 1",
    "# fail 0"
  ].join("\n");

  assert.deepEqual(
    selectedSubtestNames(output, "^concurrent ensureStarted shares one transactional JDT start$"),
    []
  );
});

test("only behavior subtests matching the authority pattern are selected", () => {
  const output = [
    "# Subtest: first behavior",
    "ok 1 - first behavior",
    "# Subtest: unrelated behavior",
    "ok 2 - unrelated behavior",
    "# Subtest: second behavior",
    "ok 3 - second behavior"
  ].join("\n");

  assert.deepEqual(
    selectedSubtestNames(output, "^(first behavior|second behavior)$"),
    ["first behavior", "second behavior"]
  );
});

test("SKIP, TODO, and failed subtests are never accepted as passing behavior evidence", () => {
  const output = [
    "# Subtest: skipped behavior",
    "ok 1 - skipped behavior # SKIP unavailable here",
    "# Subtest: todo behavior",
    "ok 2 - todo behavior # TODO pending implementation",
    "# Subtest: failed behavior",
    "not ok 3 - failed behavior",
    "# Subtest: passing behavior",
    "ok 4 - passing behavior"
  ].join("\n");

  assert.deepEqual(
    selectedSubtests(output, "behavior$").map(result => ({
      name: result.name,
      status: result.status,
      directive: result.directive
    })),
    [
      { name: "skipped behavior", status: "passed", directive: "SKIP" },
      { name: "todo behavior", status: "passed", directive: "TODO" },
      { name: "failed behavior", status: "failed", directive: undefined },
      { name: "passing behavior", status: "passed", directive: undefined }
    ]
  );
  assert.deepEqual(selectedSubtestNames(output, "behavior$"), ["passing behavior"]);
});

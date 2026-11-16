import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, check, importedModules, timerCount, unreferencedScripts } from "./check-repo-hygiene.mjs";

const baseline = {
  ignoredTracked: ["artifacts/v3-a/x.json"],
  productionLoc: { "src/old.ts": 900, "src/small.ts": 100, "src/untested-old.ts": 50 },
  untestedProduction: ["src/untested-old.ts"],
  unreferencedScripts: ["scripts/legacy.mjs"],
  testTimers: { "src/a.test.ts": 2 }
};
const clean = () => JSON.parse(JSON.stringify(baseline));
const rules = (current) => check(baseline, current).map(violation => violation.rule);

test("the baseline itself passes, and fixing debt never fails", () => {
  assert.deepEqual(check(baseline, clean()), []);
  const improved = { ...clean(), ignoredTracked: [], untestedProduction: [], unreferencedScripts: [], testTimers: {}, productionLoc: { "src/old.ts": 850 } };
  assert.deepEqual(check(baseline, improved), []);
});

test("a newly tracked ignored file fails", () => {
  assert.deepEqual(rules({ ...clean(), ignoredTracked: ["artifacts/v3-a/x.json", "artifacts/v3-a/y.json"] }), ["ignored-tracked"]);
});

test("a new production file over 600 lines fails; at 600 it passes", () => {
  const at = loc => ({ ...clean(), productionLoc: { ...baseline.productionLoc, "src/new.ts": loc } });
  assert.deepEqual(rules(at(LIMITS.newProductionLoc)), []);
  assert.deepEqual(rules(at(LIMITS.newProductionLoc + 1)), ["new-production-size"]);
});

test("a file already over 800 lines may not grow; smaller existing files are not size-checked", () => {
  assert.deepEqual(rules({ ...clean(), productionLoc: { ...baseline.productionLoc, "src/old.ts": 901 } }), ["frozen-production-growth"]);
  assert.deepEqual(rules({ ...clean(), productionLoc: { ...baseline.productionLoc, "src/small.ts": 700 } }), []);
});

test("only a new production module must be imported by a test", () => {
  const current = { ...clean(), productionLoc: { ...baseline.productionLoc, "src/new.ts": 10 }, untestedProduction: ["src/untested-old.ts", "src/new.ts"] };
  assert.deepEqual(check(baseline, current), [{ rule: "new-production-untested", file: "src/new.ts" }]);
  assert.deepEqual(rules({ ...clean(), untestedProduction: ["src/untested-old.ts", "src/small.ts"] }), [], "an existing module losing its test is not this rule");
});

test("frozen artifacts stay frozen: a new tracked file under artifacts/ fails, removing one does not", () => {
  const frozen = { ...baseline, trackedArtifacts: ["artifacts/v3-final/a.json"] };
  assert.deepEqual(check(frozen, { ...clean(), trackedArtifacts: ["artifacts/v3-final/a.json"] }), []);
  assert.deepEqual(check(frozen, { ...clean(), trackedArtifacts: [] }), []);
  assert.deepEqual(check(frozen, { ...clean(), trackedArtifacts: ["artifacts/v3-final/a.json", "artifacts/v3-final/b.json"] }),
    [{ rule: "new-tracked-artifact", file: "artifacts/v3-final/b.json" }]);
});

test("a new unreferenced script fails", () => {
  assert.deepEqual(rules({ ...clean(), unreferencedScripts: ["scripts/legacy.mjs", "scripts/new.mjs"] }), ["unreferenced-script"]);
});

test("test timers may not grow, and a new test file starts from zero", () => {
  assert.deepEqual(rules({ ...clean(), testTimers: { "src/a.test.ts": 3 } }), ["test-timer"]);
  assert.deepEqual(check(baseline, { ...clean(), testTimers: { "src/a.test.ts": 2, "src/b.test.ts": 1 } }), [{ rule: "test-timer", file: "src/b.test.ts", count: 1, limit: 0 }]);
});

test("imports resolve static, re-export, side-effect and dynamic relative specifiers to src .ts paths", () => {
  const text = 'import { a } from "./a.js";\nexport { b } from "../b.js";\nimport "./side.js";\nconst c = await import("./dir/c.js");\nimport x from "node:fs";';
  assert.deepEqual([...importedModules("src/sub/x.test.ts", text)].sort(), ["src/b.ts", "src/sub/a.ts", "src/sub/dir/c.ts", "src/sub/side.ts"]);
});

test("timer lines count unless explicitly allowed", () => {
  assert.equal(timerCount("setTimeout(r, 5);\nsetTimeout(done, 1); // hygiene: allow-timer\nclearTimeout(t);"), 1);
});

test("a script counts as referenced by another script, package.json or the index, but not by its own test", () => {
  const texts = { "scripts/a.mjs": "", "scripts/a.test.mjs": 'import "./a.mjs";', "scripts/b.mjs": "", "scripts/c.mjs": 'run("scripts/b.mjs")',
    "package.json": '"x": "node scripts/c.mjs"' };
  assert.deepEqual(unreferencedScripts(["scripts/a.mjs", "scripts/b.mjs", "scripts/c.mjs"], texts), ["scripts/a.mjs"]);
});

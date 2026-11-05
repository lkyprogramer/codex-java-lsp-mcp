import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LEDGER, removedPaths } from "./ilv2-mac-removed-paths.mjs";

function repo(t, files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ilv2-removed-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}
const item = (report, id) => report.items.find(entry => entry.id === id);

test("the ledger keeps D01–D13 and separates CODE from PLAN items", () => {
  assert.deepEqual(LEDGER.map(entry => entry.id), Array.from({ length: 13 }, (_, i) => "D" + String(i + 1).padStart(2, "0")));
  assert.deepEqual(LEDGER.filter(entry => entry.type === "PLAN").map(entry => entry.id), ["D06", "D11", "D12"]);
  for (const entry of LEDGER.filter(e => e.type === "PLAN")) assert.ok(entry.plan, entry.id);
});

test("a removed path called from production code fails, even when it would be fine in a test", t => {
  const root = repo(t, {
    "src/server.ts": 'import { start } from "./runtime.js";\nstart();\n',
    "src/runtime.ts": "export function start() { return new BuilderSupervisor(); }\n",
    "src/runtime.test.ts": "assert.throws(() => new BuilderSupervisor());\n"
  });
  const d04 = item(removedPaths(root), "D04");
  assert.equal(d04.status, "FAIL");
  assert.deepEqual(d04.productionCallers, ["src/runtime.ts"]);
  assert.equal(d04.occurrences.find(entry => entry.file === "src/runtime.test.ts").ok, true, "a test naming the old path is explained");
});

test("an unexplained remaining name fails although nothing reaches it", t => {
  const root = repo(t, { "src/server.ts": "export {};\n", "src/leftover.ts": "export const gates = familyGates;\n" });
  const report = removedPaths(root);
  assert.equal(report.status, "FAIL");
  assert.deepEqual(item(report, "D04").occurrences.map(entry => [entry.file, entry.kind, entry.productionReachable, entry.ok]), [["src/leftover.ts", null, false, false]]);
});

test("a comment in production code that names a removed path is explained, not a caller", t => {
  const root = repo(t, { "src/server.ts": 'import "./tracker.js";\n', "src/java-index/snapshot/workspace-tracker.ts": "// replaced the fs.watch tracker\n", "src/tracker.ts": 'import "./java-index/snapshot/workspace-tracker.js";\n' });
  const d07 = item(removedPaths(root), "D07");
  assert.equal(d07.status, "PASS");
  assert.deepEqual(d07.occurrences.map(entry => [entry.kind, entry.productionReachable]), [["comment", true]]);
});

test("the candidate itself has every remaining historical name explained and no production caller", () => {
  const report = removedPaths(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  assert.deepEqual(report.items.filter(entry => entry.status !== "PASS").map(entry => entry.id), []);
  assert.equal(report.summary.productionCallers, 0);
  assert.ok(report.productionFiles > 50, "the production graph was actually walked");
});

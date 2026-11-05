import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PUBLICATION_PAGES, compareDbs, selfTest } from "./ilv2-mac-snapshot-equivalence.mjs";

test("structural self-test: stat-only writes no fact pages, edits stay equivalent to a cold build", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "g04-structural-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await selfTest({ out: path.join(root, "out"), files: 60, changes: [5, 30] });
  assert.equal(report.status, "PASS", JSON.stringify(report.checks));
  const { statOnly, b5, b30 } = report.scenarios;
  for (const name of Object.keys(statOnly.facts.byName)) assert.ok(PUBLICATION_PAGES.has(name), `stat-only touched ${name}`);
  assert.ok(statOnly.statStore.changed > 0);
  assert.ok(b5.facts.changed > 0 && b30.facts.changed > b5.facts.changed, JSON.stringify([b5.facts.changed, b30.facts.changed]));
  assert.equal(b30.changedFiles, 30);
  // An edited snapshot is not logically equal to its base.
  const unequal = await compareDbs(path.join(root, "out/base/db/index.sqlite"), path.join(root, "out/b5/db/index.sqlite"));
  assert.equal(unequal.equal, false);
  assert.ok(unequal.diff.some(row => row.table === "file"), JSON.stringify(unequal.diff.map(row => row.table)));
});

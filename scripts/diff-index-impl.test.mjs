import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDiff } from "./diff-index-impl.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.join(root, "fixtures", "java-index-v2");

test("diff-index-impl reports 0 diffs on java-index-v2", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "iod-diff-"));
  const report = await runDiff({
    repo,
    db: path.join(dir, "index.sqlite"),
    anchors: 30,
    golden: path.join(root, "golden", "java-index-v2.scenarios.jsonl"),
    out: path.join(dir, "report.json")
  });
  assert.equal(Object.keys(report.rpc).length, 25);
  const diffs = Object.fromEntries(
    Object.entries(report.rpc).filter(([, entry]) => entry.diffs > 0).map(([name, entry]) => [name, entry.diffs])
  );
  assert.deepEqual(diffs, {});
});

import assert from "node:assert/strict";
import test from "node:test";
import { familyOverlapRatio, parseProbeArgs } from "./probe-family-overlap.mjs";

test("familyOverlapRatio is matching contentHash among shared relative paths", () => {
  const primary = new Map([
    ["src/A.java", "aaa"],
    ["src/B.java", "bbb"],
    ["src/C.java", "ccc"]
  ]);
  const worktree = new Map([
    ["src/A.java", "aaa"],
    ["src/B.java", "changed"],
    ["src/D.java", "ddd"]
  ]);
  assert.equal(familyOverlapRatio(primary, worktree), 0.5);
  assert.equal(familyOverlapRatio(primary, primary), 1);
  assert.equal(familyOverlapRatio(new Map(), worktree), 0);
});

test("parseProbeArgs requires snapshot flags", () => {
  const parsed = parseProbeArgs(["--snapshot", "/a.gz", "--snapshot", "/b.gz", "--output", "out.json"]);
  assert.deepEqual(parsed.snapshots, ["/a.gz", "/b.gz"]);
  assert.equal(parsed.output, "out.json");
});

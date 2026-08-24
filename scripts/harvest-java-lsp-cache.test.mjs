import assert from "node:assert/strict";
import test from "node:test";
import { parseHarvestArgs } from "./harvest-java-lsp-cache.mjs";

test("harvest CLI defaults to dry-run and requires values for path flags", () => {
  assert.deepEqual(parseHarvestArgs([]), { dryRun: true, cacheBase: undefined, projectsJson: undefined, help: false });
  assert.equal(parseHarvestArgs(["--apply"]).dryRun, false);
  assert.equal(parseHarvestArgs(["--apply", "--dry-run"]).dryRun, true);
  assert.equal(parseHarvestArgs(["--cache-base", "/tmp/cache"]).cacheBase, "/tmp/cache");
  assert.throws(() => parseHarvestArgs(["--cache-base"]), /requires a value/);
  assert.throws(() => parseHarvestArgs(["--nope"]), /Unknown argument/);
});

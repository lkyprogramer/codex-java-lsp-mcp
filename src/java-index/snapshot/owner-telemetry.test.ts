import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ownerTelemetrySink } from "./owner-telemetry.js";

test("owner telemetry is isolated-validation only, absolute, and stamps each event with time and the owner pid", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "ilv2-telemetry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "owner.jsonl");
  assert.equal(ownerTelemetrySink({ JAVA_LSP_OWNER_TELEMETRY: file }), undefined, "never outside isolated validation");
  assert.equal(ownerTelemetrySink({ JAVA_LSP_ISOLATED_VALIDATION: "1" }), undefined, "no file, no sink");
  assert.throws(() => ownerTelemetrySink({ JAVA_LSP_ISOLATED_VALIDATION: "1", JAVA_LSP_OWNER_TELEMETRY: "relative.jsonl" }), /absolute/);
  const sink = ownerTelemetrySink({ JAVA_LSP_ISOLATED_VALIDATION: "1", JAVA_LSP_OWNER_TELEMETRY: file })!;
  assert.equal(ownerTelemetrySink({ JAVA_LSP_ISOLATED_VALIDATION: "1", JAVA_LSP_OWNER_TELEMETRY: file }), sink, "one sink per file per process");
  sink({ type: "reclaimed", snapshotId: "s-1" });
  sink({ type: "builder", workspaceId: "w", pid: 4242, beat: { seq: 1, at: 1, stage: "start", work: 0 } });
  await delay(50);
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.type, row.pid]), [["reclaimed", process.pid], ["builder", 4242]], "an event's own pid (the builder's) overrides the owner's");
  assert.ok(rows.every(row => Number.isFinite(row.at) && Number.isFinite(row.mono)));
});

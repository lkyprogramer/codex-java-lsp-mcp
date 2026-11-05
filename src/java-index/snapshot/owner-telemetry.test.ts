import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Session } from "node:inspector/promises";
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

test("owner telemetry records process metrics and lifecycle events without connecting an inspector by default", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "ilv2-telemetry-default-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "owner.jsonl");
  const connect = t.mock.method(Session.prototype, "connect", () => undefined);
  const post = t.mock.method(Session.prototype, "post", async () => ({ profile: { nodes: [] } }));
  t.mock.timers.enable({ apis: ["setInterval"] });

  const sink = ownerTelemetrySink({ JAVA_LSP_ISOLATED_VALIDATION: "1", JAVA_LSP_OWNER_TELEMETRY: file })!;
  sink({ type: "reclaimed", snapshotId: "s-1" });
  sink({ type: "builder", workspaceId: "w", pid: 4242, beat: { seq: 1, at: 1, stage: "start", work: 0 } });
  t.mock.timers.tick(5000);
  await delay(50);

  const rows = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.type), ["reclaimed", "builder", "process"]);
  assert.deepEqual(rows[1].beat, { seq: 1, at: 1, stage: "start", work: 0 });
  const sample = rows[2];
  assert.equal(sample.pid, process.pid);
  assert.ok(Number.isFinite(sample.rss) && sample.rss > 0);
  assert.ok(Number.isFinite(sample.heapUsed) && sample.heapUsed > 0);
  assert.ok(Number.isFinite(sample.external) && sample.external >= 0);
  for (const value of [sample.cpu.userMs, sample.cpu.systemMs, sample.loop.p50, sample.loop.p99,
    sample.loop.max, sample.gc.count, sample.gc.totalMs, sample.gc.maxMs]) {
    assert.ok(Number.isFinite(value) && value >= 0);
  }
  assert.equal(typeof sample.gc.maxKind, "string");
  assert.ok(rows.every(row => Number.isFinite(row.at) && Number.isFinite(row.mono)));
  assert.equal(connect.mock.callCount(), 0, "ordinary telemetry must not attach an inspector");
  assert.equal(post.mock.callCount(), 0, "ordinary process sampling must not start or rotate CPU profiles");
});

test("owner telemetry starts the CPU profiler only when explicitly enabled for diagnosis", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "ilv2-telemetry-profile-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "owner.jsonl");
  const connect = t.mock.method(Session.prototype, "connect", () => undefined);
  const post = t.mock.method(Session.prototype, "post", async () => ({}));
  t.mock.timers.enable({ apis: ["setInterval"] });

  ownerTelemetrySink({
    JAVA_LSP_ISOLATED_VALIDATION: "1",
    JAVA_LSP_OWNER_TELEMETRY: file,
    JAVA_LSP_OWNER_CPU_PROFILE: "1"
  });
  await delay(50);

  assert.equal(connect.mock.callCount(), 1);
  assert.deepEqual(post.mock.calls.map(call => call.arguments[0]), [
    "Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start"
  ]);
});

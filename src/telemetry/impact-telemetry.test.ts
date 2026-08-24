import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { repoHash } from "../path-utils.js";
import {
  buildImpactDetail,
  buildToolCounter,
  createImpactTelemetry,
  recordToolInvocation,
  resetImpactTelemetryForTests,
  telemetryEnabled
} from "./impact-telemetry.js";

test("telemetryEnabled is off only when JAVA_LSP_TELEMETRY=0", () => {
  assert.equal(telemetryEnabled({}), true);
  assert.equal(telemetryEnabled({ JAVA_LSP_TELEMETRY: "0" }), false);
  assert.equal(telemetryEnabled({ JAVA_LSP_TELEMETRY: "1" }), true);
});

test("impact detail records required fields and omits source paths and contents", () => {
  const repoRoot = "/Users/demo/exam-parent-v3";
  const value = {
    repoHash: "fc2fdfc87e0f",
    readPlan: [{ fileId: "a" }, { fileId: "b" }],
    cost: { readBytes: 4096, estimatedTokens: 120, resultBytes: 800, suppressedRawBytes: 0 },
    metrics: { phaseMs: { hydrateSnapshot: 12 } }
  };
  const row = buildImpactDetail({
    args: {
      repoRoot,
      mode: "balanced",
      verbosity: "standard",
      file: "exam-service/src/main/java/PayService.java",
      line: 10,
      column: 1
    },
    value,
    elapsedMs: 12.4,
    error: false,
    now: new Date("2026-08-24T15:00:00.000Z")
  });
  const encoded = JSON.stringify(row);
  assert.equal(row.ts, "2026-08-24T15:00:00.000Z");
  assert.equal(row.tool, "java_impact");
  assert.equal(row.repoHash, "fc2fdfc87e0f");
  assert.equal(row.mode, "balanced");
  assert.equal(row.verbosity, "standard");
  assert.equal(row.anchorsCount, 1);
  assert.equal(row.readPlanItems, 2);
  assert.equal(row.plannedSourceBytes, 4096);
  assert.equal(row.estimatedTokens, 120);
  assert.equal(row.elapsedMs, 12);
  assert.equal(row.coldPath, true);
  assert.equal(row.error, false);
  assert.equal(encoded.includes("PayService.java"), false);
  assert.equal(encoded.includes("class "), false);
  assert.equal(encoded.includes(repoRoot), false);
});

test("impact hashes repoRoot when result has no repoHash", () => {
  const repoRoot = "/tmp/java-lsp-telemetry-hash";
  const row = buildImpactDetail({
    args: { repoRoot, anchors: [{ file: "A.java", line: 1, column: 1 }] },
    value: { cost: { estimatedTokens: 3, readBytes: 12 } },
    elapsedMs: 5,
    error: false
  });
  assert.equal(row.repoHash, repoHash(repoRoot));
  assert.equal(row.anchorsCount, 1);
  assert.equal(row.coldPath, false);
  assert.equal(row.coldPathHeuristic, undefined);
});

test("elapsedMs over 2000 without hydrate phases is a heuristic cold path", () => {
  const row = buildImpactDetail({
    args: {},
    value: { metrics: { phaseMs: { query: 10 } } },
    elapsedMs: 2500,
    error: true
  });
  assert.equal(row.coldPath, true);
  assert.equal(row.coldPathHeuristic, true);
  assert.equal(row.error, true);
});

test("non-impact tools emit only the one-line counter", () => {
  const row = buildToolCounter({ tool: "java_status", elapsedMs: 8.2, ok: true, now: new Date("2026-08-24T15:00:00.000Z") });
  assert.deepEqual(Object.keys(row).sort(), ["elapsedMs", "ok", "tool", "ts"]);
  assert.equal(row.ok, true);
  assert.equal(row.elapsedMs, 8);
});

test("record writes JSONL under an isolated dir and JAVA_LSP_TELEMETRY=0 writes nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "java-lsp-telemetry-"));
  const writes: string[] = [];
  const sink = createImpactTelemetry({
    dir,
    enabled: true,
    maxBuffer: 1,
    flushEveryMs: 0,
    appendFile: (file, data) => {
      writes.push(file);
      appendViaFs(file, data);
    }
  });
  sink.record(buildToolCounter({ tool: "java_runtime", elapsedMs: 1, ok: true, now: new Date("2026-08-24T01:02:03.000Z") }));
  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /impact-20260824\.jsonl$/);
  const text = await readFile(writes[0]!, "utf8");
  const line = JSON.parse(text.trim());
  assert.equal(line.tool, "java_runtime");
  assert.equal(line.ok, true);

  const silentDir = await mkdtemp(path.join(tmpdir(), "java-lsp-telemetry-off-"));
  const silent = createImpactTelemetry({
    dir: silentDir,
    env: { JAVA_LSP_TELEMETRY: "0" },
    maxBuffer: 1,
    flushEveryMs: 0
  });
  silent.record({ tool: "java_status", elapsedMs: 1, ok: true });
  silent.flush();
  assert.deepEqual(await readdir(silentDir), []);
});

test("append and flush failures are swallowed", () => {
  const sink = createImpactTelemetry({
    dir: "/definitely-not-writable-java-lsp-telemetry",
    enabled: true,
    maxBuffer: 1,
    flushEveryMs: 0,
    appendFile: () => {
      throw new Error("disk full");
    }
  });
  sink.record({ tool: "java_symbol", elapsedMs: 1, ok: true });
  sink.flush();
});

test("record path stays under 1ms across 1000 iterations", () => {
  const sink = createImpactTelemetry({
    dir: path.join(tmpdir(), "java-lsp-telemetry-bench"),
    enabled: true,
    maxBuffer: 10_000,
    flushEveryMs: 0,
    appendFile: () => undefined
  });
  const row = buildToolCounter({ tool: "java_diagnostics", elapsedMs: 1, ok: true });
  const started = performance.now();
  for (let index = 0; index < 1000; index += 1) {
    sink.record(row);
  }
  const perCall = (performance.now() - started) / 1000;
  assert.ok(perCall < 1, `record path ${perCall}ms per call`);
});

test("initialization deletes telemetry files older than 30 days", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "java-lsp-telemetry-gc-"));
  const stale = path.join(dir, "impact-20200101.jsonl");
  const fresh = path.join(dir, "impact-20260824.jsonl");
  await writeFile(stale, "{}\n");
  await writeFile(fresh, "{}\n");
  createImpactTelemetry({
    dir,
    enabled: true,
    flushEveryMs: 0,
    now: () => new Date("2026-08-24T00:00:00.000Z")
  });
  const names = await readdir(dir);
  assert.equal(names.includes("impact-20200101.jsonl"), false);
  assert.equal(names.includes("impact-20260824.jsonl"), true);
});

test("recordToolInvocation does not mutate the handler value", () => {
  const value = {
    cost: { estimatedTokens: 9, readBytes: 40, resultBytes: 10, suppressedRawBytes: 0 },
    readPlan: []
  };
  const before = JSON.stringify(value);
  recordToolInvocation({
    tool: "java_impact",
    args: { repoRoot: "/tmp/x", mode: "balanced" },
    value,
    elapsedMs: 3,
    error: false,
    sink: createImpactTelemetry({
      dir: path.join(tmpdir(), "java-lsp-telemetry-identity"),
      enabled: true,
      flushEveryMs: 0,
      appendFile: () => undefined
    })
  });
  assert.equal(JSON.stringify(value), before);
});

test("recordToolInvocation no-ops when JAVA_LSP_TELEMETRY=0", async () => {
  resetImpactTelemetryForTests();
  const dir = await mkdtemp(path.join(tmpdir(), "java-lsp-telemetry-env-off-"));
  recordToolInvocation({
    tool: "java_status",
    args: {},
    value: { ok: true },
    elapsedMs: 1,
    error: false,
    env: { JAVA_LSP_TELEMETRY: "0", JAVA_LSP_TELEMETRY_DIR: dir }
  });
  assert.deepEqual(await readdir(dir).catch(() => []), []);
});

function appendViaFs(file: string, data: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, data);
}

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatSummary, parseStatsArgs, parseTelemetryRow, percentile, readTelemetryDir, runStats, summarizeTelemetry } from "./telemetry-stats.js";

const DAY = 86400000;

test("percentile uses nearest rank and is 0 for no samples", () => {
  assert.equal(percentile([], 0.95), 0);
  assert.equal(percentile([7], 0.5), 7);
  assert.equal(percentile([7], 0.95), 7);
  const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
  assert.equal(percentile(twenty, 0.5), 10);
  assert.equal(percentile(twenty, 0.95), 19);
  assert.equal(percentile([...twenty, 21], 0.95), 20);
});

test("rows parse counter and impact shapes; legacy rows get an explicit unknown operation", () => {
  assert.deepEqual(parseTelemetryRow('{"ts":"2026-11-17T00:00:00.000Z","tool":"java_symbol","elapsedMs":4,"ok":true}'),
    { ts: Date.parse("2026-11-17T00:00:00.000Z"), tool: "java_symbol", elapsedMs: 4, ok: true, operation: "unknown" });
  const impact = parseTelemetryRow('{"ts":"2026-11-17T00:00:00.000Z","tool":"java_impact","repoHash":"h","elapsedMs":900,"error":true,"errorCode":"DEADLINE_EXCEEDED","coldPath":true,"estimatedTokens":1200}');
  assert.equal(impact?.ok, false);
  assert.equal(impact?.operation, "-");
  assert.equal(impact?.errorCode, "DEADLINE_EXCEEDED");
  assert.equal(impact?.coldPath, true);
  assert.equal(impact?.estimatedTokens, 1200);
  for (const bad of ["", "not json", "[]", '{"tool":"java_status","elapsedMs":1,"ok":true}', '{"ts":"x","tool":"java_status","elapsedMs":1,"ok":true}',
    '{"ts":"2026-11-17T00:00:00Z","tool":"java_status","elapsedMs":"1","ok":true}', '{"ts":"2026-11-17T00:00:00Z","tool":"java_status","elapsedMs":1}']) {
    assert.equal(parseTelemetryRow(bad), undefined, bad);
  }
});

test("summary groups by tool and operation, keeps the window, and counts errors, states, starts and cold paths", () => {
  const base = Date.parse("2026-11-17T00:00:00.000Z");
  const row = (offset: number, extra: Record<string, unknown>) => ({ ts: base + offset, tool: "java_symbol", operation: "query", elapsedMs: 10, ok: true, ...extra });
  const rows = [
    row(-1, { elapsedMs: 99999 }),
    row(0, { indexState: "FRESH" }),
    row(1, { elapsedMs: 30, ok: false, errorCode: "INDEX_PARTIAL", indexState: "NOT_READY" }),
    row(2, { operation: "references", elapsedMs: 5000 }),
    row(3, { tool: "java_status", operation: "-", start: true }),
    row(4, { tool: "java_impact", operation: "-", coldPath: true, estimatedTokens: 800 }),
    row(5, { tool: "java_impact", operation: "-", coldPath: false, estimatedTokens: 400 }),
    row(DAY + 1, { elapsedMs: 88888 })
  ];
  const summary = summarizeTelemetry(rows, { since: base, until: base + DAY }, 3);
  assert.equal(summary.rows, 6);
  assert.equal(summary.malformed, 3);
  assert.equal(summary.firstTs, "2026-11-17T00:00:00.000Z");
  const group = (tool: string, operation: string) => summary.groups.find(item => item.tool === tool && item.operation === operation);
  assert.deepEqual(group("java_symbol", "query"), {
    tool: "java_symbol", operation: "query", calls: 2, ok: 1, okRate: 0.5, p50Ms: 10, p95Ms: 30, maxMs: 30,
    errorCodes: { INDEX_PARTIAL: 1 }, indexStates: { FRESH: 1, NOT_READY: 1 }
  });
  assert.equal(group("java_symbol", "references")?.calls, 1);
  assert.equal(group("java_status", "-")?.startCalls, 1);
  assert.equal(group("java_impact", "-")?.coldPath, 1);
  assert.equal(group("java_impact", "-")?.tokensP50, 400);
  assert.deepEqual(summary.slowest.map(item => item.elapsedMs), [5000, 30, 10, 10, 10, 10]);
  const text = formatSummary(summary);
  assert.match(text, /java_symbol\treferences\t1\t100\.0\t5000\t5000\t5000/);
  assert.match(text, /java_impact\t-\t2\t100\.0\t.*cold=1 tokensP50=400/);
});

test("empty window summarizes to zero without first/last timestamps", () => {
  const summary = summarizeTelemetry([], { since: 0, until: DAY });
  assert.deepEqual([summary.rows, summary.groups.length, summary.slowest.length, "firstTs" in summary], [0, 0, 0, false]);
  assert.match(formatSummary(summary), /0 calls; malformed lines 0/);
});

test("directory reading skips day files before the window and counts malformed lines", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "telemetry-stats-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "impact-20261101.jsonl"), '{"ts":"2026-11-01T10:00:00Z","tool":"java_status","elapsedMs":1,"ok":true}\n');
  await writeFile(path.join(dir, "impact-20261116.jsonl"), '{"ts":"2026-11-16T05:00:00Z","tool":"java_status","elapsedMs":1,"ok":true}\n{"ts":"2026-11-16T05:00:01Z","tool":"java_st\n\n');
  await writeFile(path.join(dir, "impact-20261117.jsonl"), '{"ts":"2026-11-17T01:00:00Z","tool":"java_symbol","operation":"query","elapsedMs":2,"ok":true}\n');
  await writeFile(path.join(dir, "notes.txt"), "ignored\n");
  const read = await readTelemetryDir(dir, Date.parse("2026-11-16T12:00:00Z"));
  assert.deepEqual([read.files, read.rows.length, read.malformed], [2, 2, 1]);
  const json = JSON.parse(await runStats(["--dir", dir, "--since", "1d", "--json"], Date.parse("2026-11-17T12:00:00Z")));
  assert.equal(json.rows, 1, "the row before since is outside the window though its file was read");
  assert.equal(json.groups[0].operation, "query");
});

test("arguments require an absolute directory and a bounded day window", () => {
  assert.deepEqual(parseStatsArgs(["--dir", "/x"]), { dir: "/x", sinceDays: 7, json: false });
  assert.deepEqual(parseStatsArgs(["--dir", "/x", "--since", "365d", "--json"]), { dir: "/x", sinceDays: 365, json: true });
  assert.throws(() => parseStatsArgs([]), /--dir/);
  assert.throws(() => parseStatsArgs(["--dir", "relative"]), /--dir/);
  for (const since of ["0d", "366d", "7", "7h", ""]) assert.throws(() => parseStatsArgs(["--dir", "/x", "--since", since]), /--since/, since);
  assert.throws(() => parseStatsArgs(["--dir", "/x", "--bogus"]), /unknown argument/);
});

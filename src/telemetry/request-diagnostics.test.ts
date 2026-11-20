import assert from "node:assert/strict";
import test from "node:test";
import { parseRequestDiagnostics } from "./request-diagnostics.js";
import { formatSummary, parseTelemetryRow, summarizeTelemetry } from "./telemetry-stats.js";

test("request diagnostics retain measured zero and keep optional legacy data unknown", () => {
  const base = { ts: "2026-11-20T00:00:00Z", tool: "java_impact", elapsedMs: 4, error: false };
  assert.deepEqual(parseRequestDiagnostics({}), {});
  assert.deepEqual(parseRequestDiagnostics({
    indexState: "STALE", scope: "daemon", prepareMs: 0, repoHash: "/raw/path", bindingVersion: 1
  }), { scope: "daemon", prepareMs: 0, bindingVersion: 1 });
  const rows = [
    base,
    { ...base, scope: "repo", prepareMs: 0, prepareCapMs: 1000, effectiveDeadlineMs: 15000, handlerRemainingMs: 0, prepareOutcome: "none", resultKind: "AMBIGUOUS", deadlineSource: "explicit" },
    { ...base, scope: "repo", error: true, prepareMs: 1000, prepareOutcome: "capped", failureStage: "request.handler" },
    { ...base, prepareMs: -1, prepareCapMs: 1001, effectiveDeadlineMs: 15001, handlerRemainingMs: -1, prepareOutcome: "任意字段", resultKind: "arbitrary", failureStage: "/private/path" }
  ].map(row => parseTelemetryRow(JSON.stringify(row))).filter(row => row !== undefined);
  const summary = summarizeTelemetry(rows, { since: 0, until: Date.parse(base.ts) });
  assert.equal(summary.rows, 4);
  assert.deepEqual([rows[1]?.prepareCapMs, rows[1]?.effectiveDeadlineMs, rows[1]?.handlerRemainingMs], [1000, 15000, 0]);
  assert.deepEqual([rows[3]?.prepareCapMs, rows[3]?.effectiveDeadlineMs, rows[3]?.handlerRemainingMs], [undefined, undefined, undefined]);
  assert.match(formatSummary(summary), /prepareP95ms=1000\(n=2\)/);
  assert.match(formatSummary(summary), /prepare=none=1,capped=1|prepare=capped=1,none=1/);
  assert.match(formatSummary(summary), /failureStage=request\.handler=1/);
  assert.match(formatSummary(summary), /result=AMBIGUOUS=1/);
  assert.doesNotMatch(JSON.stringify(summary), /任意字段|arbitrary|private\/path/);
});

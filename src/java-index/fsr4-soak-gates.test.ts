import assert from "node:assert/strict";
import test from "node:test";
import { fsr4CountLogLine, fsr4HoursAboveClimb, fsr4SoakVerdict, fsr4StepStatus } from "./fsr4-soak-gates.js";

test("compact log lines are not soak events", () => {
  assert.equal(fsr4CountLogLine("[codex-java-lsp] columnar compact tombstoneRatio=0.5"), "compact");
  const verdict = fsr4SoakVerdict({
    fatal: 0,
    ebadf: 0,
    inProcessParseEvents: 0,
    coldBuildChildEvents: 0,
    recycleBudgeted: 0,
    watchHours: 48,
    heapMb: 500,
    hydrateBaselineHeapMb: 484,
    hoursAboveClimb: 0
  });
  assert.deepEqual(verdict.failures, []);
});

test("hours above climb uses worker hydrate baseline, not first-sample heap", () => {
  const quiet = fsr4HoursAboveClimb([
    { sampledAt: "2026-09-01T00:00:00.000Z", heapMb: 774, hydrateBaselineHeapMb: 774 },
    { sampledAt: "2026-09-01T13:00:00.000Z", heapMb: 782, hydrateBaselineHeapMb: 774 }
  ]);
  assert.equal(quiet, 0, "+8 MiB over 13h is below 1.4× 774");
  const stepped = fsr4HoursAboveClimb([
    { sampledAt: "2026-09-01T00:00:00.000Z", heapMb: 484, hydrateBaselineHeapMb: 484 },
    { sampledAt: "2026-09-01T06:00:00.000Z", heapMb: 1135, hydrateBaselineHeapMb: 484 },
    { sampledAt: "2026-09-01T13:00:00.000Z", heapMb: 1136, hydrateBaselineHeapMb: 484 }
  ]);
  assert.ok(stepped >= 6, `expected ≥6h above 1.4× 484, got ${stepped}`);
  assert.equal(
    fsr4HoursAboveClimb([
      { sampledAt: "2026-09-01T00:00:00.000Z", heapMb: 774 },
      { sampledAt: "2026-09-01T13:00:00.000Z", heapMb: 782 }
    ]),
    0,
    "missing hydrate baseline must not use first-sample heap"
  );
});

test("a +30% step that does not recover within 24h FAILs via fsr4SoakVerdict", () => {
  const series = [
    { sampledAt: "2026-09-01T00:00:00.000Z", heapMb: 484, hydrateBaselineHeapMb: 484 },
    { sampledAt: "2026-09-01T01:00:00.000Z", heapMb: 1135, hydrateBaselineHeapMb: 484 },
    { sampledAt: "2026-09-02T02:00:00.000Z", heapMb: 1136, hydrateBaselineHeapMb: 484 }
  ];
  const step = fsr4StepStatus(series);
  assert.ok((step.stepPct ?? 0) > 0.3);
  assert.equal(step.stepRecoveredWithin24h, false);
  const verdict = fsr4SoakVerdict({
    fatal: 0,
    ebadf: 0,
    inProcessParseEvents: 0,
    coldBuildChildEvents: 0,
    recycleBudgeted: 0,
    watchHours: 26,
    heapMb: 1136,
    hydrateBaselineHeapMb: 484,
    hoursAboveClimb: fsr4HoursAboveClimb(series),
    stepPct: step.stepPct,
    stepRecoveredWithin24h: step.stepRecoveredWithin24h
  });
  assert.match(verdict.failures.join(" "), /24h/);
  const recovered = fsr4StepStatus([
    { sampledAt: "2026-09-01T00:00:00.000Z", heapMb: 484 },
    { sampledAt: "2026-09-01T01:00:00.000Z", heapMb: 1135 },
    { sampledAt: "2026-09-01T02:00:00.000Z", heapMb: 500 }
  ]);
  assert.equal(recovered.stepRecoveredWithin24h, true);
  assert.deepEqual(
    fsr4SoakVerdict({
      fatal: 0,
      ebadf: 0,
      inProcessParseEvents: 0,
      coldBuildChildEvents: 0,
      recycleBudgeted: 0,
      watchHours: 3,
      heapMb: 500,
      hydrateBaselineHeapMb: 484,
      hoursAboveClimb: 0,
      stepPct: recovered.stepPct,
      stepRecoveredWithin24h: recovered.stepRecoveredWithin24h
    }).failures,
    []
  );
});

test("climb FAIL is heap > 1.4× hydrate baseline for ≥ 6h", () => {
  const under = fsr4SoakVerdict({
    fatal: 0,
    ebadf: 0,
    inProcessParseEvents: 0,
    coldBuildChildEvents: 0,
    recycleBudgeted: 0,
    watchHours: 10,
    heapMb: 600,
    hydrateBaselineHeapMb: 484,
    hoursAboveClimb: 5
  });
  assert.equal(under.failures.length, 0);
  const over = fsr4SoakVerdict({
    fatal: 0,
    ebadf: 0,
    inProcessParseEvents: 0,
    coldBuildChildEvents: 0,
    recycleBudgeted: 0,
    watchHours: 10,
    heapMb: 800,
    hydrateBaselineHeapMb: 484,
    hoursAboveClimb: 6
  });
  assert.match(over.failures.join(" "), /1\.4/);
});

test("a single-sample step > +30% is marked and fails if not recovered in 24h", () => {
  const marked = fsr4SoakVerdict({
    fatal: 0,
    ebadf: 0,
    inProcessParseEvents: 0,
    coldBuildChildEvents: 0,
    recycleBudgeted: 0,
    watchHours: 8,
    heapMb: 1135,
    hydrateBaselineHeapMb: 484,
    hoursAboveClimb: 0,
    stepPct: 1.3,
    stepRecoveredWithin24h: undefined
  });
  assert.match(marked.warnings.join(" "), /step/);
  const failed = fsr4SoakVerdict({
    fatal: 0,
    ebadf: 0,
    inProcessParseEvents: 0,
    coldBuildChildEvents: 0,
    recycleBudgeted: 0,
    watchHours: 30,
    heapMb: 1135,
    hydrateBaselineHeapMb: 484,
    hoursAboveClimb: 0,
    stepPct: 1.3,
    stepRecoveredWithin24h: false
  });
  assert.match(failed.failures.join(" "), /24h/);
});

test("in-process parse events fail the soak; recycle over 2/24h fails", () => {
  assert.equal(fsr4CountLogLine("[codex-java-lsp] in-process parse files=600"), "in-process-parse");
  assert.equal(fsr4CountLogLine("[codex-java-lsp] worker heap recycle heapUsedMb=900"), "recycle");
  const parseFail = fsr4SoakVerdict({
    fatal: 0,
    ebadf: 0,
    inProcessParseEvents: 1,
    coldBuildChildEvents: 0,
    recycleBudgeted: 0,
    watchHours: 1,
    heapMb: 500,
    hydrateBaselineHeapMb: 484,
    hoursAboveClimb: 0
  });
  assert.match(parseFail.failures.join(" "), /in-process parse/);
  const recycleFail = fsr4SoakVerdict({
    fatal: 0,
    ebadf: 0,
    inProcessParseEvents: 0,
    coldBuildChildEvents: 0,
    recycleBudgeted: 3,
    watchHours: 24,
    heapMb: 500,
    hydrateBaselineHeapMb: 484,
    hoursAboveClimb: 0
  });
  assert.match(recycleFail.failures.join(" "), /recycle/);
});

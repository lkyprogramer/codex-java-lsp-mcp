import test from "node:test";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, statfs, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { childPids, closeRecoveryOwner, command, copyEvidence, eventually, evidence, processAlive, startRecoveryOwner } from "./ilv2-mac-recovery-fixture.mjs";
import { execute, readJson, relevantInput, sha256, verifyFrozenInput } from "./ilv2-mac-contracts.mjs";
import { hostLoad, historyTierState } from "./ilv2-mac-full-delta.mjs";
import { reanalyze } from "./ilv2-mac-system-loop-reanalyze.mjs";
import { LIMITS, summarizeTimingAttempts, idleWindow, fullSample, fullTiming, badSyntaxNegative, settleNegative, analyze, auditEvidence, deltaCalibration, fairness, healthyKills, heartbeatGaps, jobsFrom, leaseLeaks, nearestRank, processProfile, resourcePeaks, seedTier, starvation, timingItem, unboundedCalls } from "./ilv2-mac-system-loop.mjs";

// pageDiff reads every page through synchronous dbstat (seconds on a full index); in this process it would stall the event
// loop and inflate the elapsed of any request in flight, so it runs in a child.
const pageDiff = async (before, after) => JSON.parse((await execute(process.execPath, [...process.execArgv.filter(arg => !arg.startsWith("--test")), "--input-type=module", "-e",
  `import { pageDiff } from ${JSON.stringify(new URL("./ilv2-mac-snapshot-equivalence.mjs", import.meta.url).href)}; process.stdout.write(JSON.stringify(await pageDiff(process.argv[1], process.argv[2])));`,
  before, after], { maxBuffer: 16 * 1024 * 1024 })).stdout);

// ---------------------------------------------------------------- analysis (always runs)

const at = (ms, type, event, pid = 100) => ({ at: ms, pid, type, event });
test("timing admission uses absolute load1 below 20 at both window edges", () => {
  const load = (load1, cpus) => ({ load1, cpus, perCpu: load1 / cpus });
  assert.equal(LIMITS.idleLoad1Limit, 20);
  assert.equal(idleWindow(load(19.999, 4), load(19.999, 64)), true, "CPU count does not change admission");
  for (const busy of [20, 20.001, Infinity, NaN, -1]) {
    assert.equal(idleWindow(load(busy, 64), load(1, 10)), false, "invalid start edge");
    assert.equal(idleWindow(load(1, 10), load(busy, 64)), false, "invalid end edge");
  }
  assert.equal(idleWindow(undefined, load(1, 10)), false);
  assert.equal(idleWindow(load(1, 10), { perCpu: 0.1 }), false, "missing raw load cannot prove admission");
});

test("nearest-rank keeps censored samples and timing items never pass short or loaded windows", () => {
  assert.equal(nearestRank([5, 1, 3, 2, 4], 0.95), 5);
  assert.equal(nearestRank([1, 2, Infinity], 0.5), 2);
  assert.equal(timingItem({ samples: [1, 2], limit: 10, min: 3, idle: true }).verdict, "FAIL", "too few samples");
  assert.equal(timingItem({ samples: [1, 2, 3], limit: 10, min: 3, idle: false }).verdict, "INVALID_EXPERIMENT");
  assert.equal(timingItem({ samples: [1, 2, Infinity], limit: 10, min: 3, idle: true }).verdict, "FAIL", "a censored round is a miss");
  assert.equal(timingItem({ samples: [1, 2, 3], limit: 10, min: 3, idle: true, strictMax: 2 }).verdict, "FAIL", "max bound");
  assert.equal(timingItem({ samples: [1, 2, 3], limit: 10, min: 3, idle: true }).verdict, "PASS");
  assert.deepEqual([seedTier(20), seedTier(21), seedTier(200), seedTier(201)], ["le20", "to200", "to200", "large"]);
});

const fullFixture = () => ({ workspaceId: "w", workspace: "main", sinceEpoch: 0,
  rows: [at(1000, "scheduler", { type: "dispatched", kind: "full", workspaceId: "w", pid: 7, waitedMs: 500 }),
    at(201000, "scheduler", { type: "closed", kind: "full", workspaceId: "w", pid: 7, code: 0, runMs: 200000 }),
    { at: 401000, pid: 100, type: "round", workspaceId: "w", kind: "full", outcome: "published", elapsedMs: 400500,
      boundAt: 401000, snapshotId: "snap-7", bindingVersion: 1, timings: { publishMs: 200000, seal: { checkpointMs: 180000 } } }],
  calls: [{ requestId: 8, workspace: "main", firstCorrect: true, status: "ok", startedAt: 402000, elapsedMs: 100,
    indexView: { workspaceId: "w", snapshotId: "snap-7", bindingVersion: 1 } }],
  loads: [500, 1000, 201000, 402100].map(at => ({ at, load1: 1, cpus: 10, perCpu: 0.1 })) });

test("full service timing includes seal publish and correct query with queue separate", () => {
  const sample = fullSample(fullFixture());
  assert.equal(sample.ms, 401100, "the full gate includes the 200 s seal/publish tail");
  assert.equal(sample.builderRunMs, 200000);
  assert.equal(sample.queueMs, 500);
  const waitingQuery = fullFixture();
  waitingQuery.calls[0].startedAt = 400900;
  waitingQuery.calls[0].elapsedMs = 1200;
  assert.equal(fullSample(waitingQuery).ms, sample.ms, "a request waiting for publication can acquire its new binding");
  assert.equal(fullTiming([sample, sample]).verdict, "FAIL", "three actual samples remain mandatory");
  const within = { ...sample, fullServiceMs: 300000 };
  assert.equal(fullTiming([within, within, within]).verdict, "PASS", "three complete idle fulls under the threshold pass");
  assert.equal(timingItem({ samples: [sample.ms, sample.ms, sample.ms], limit: LIMITS.fullMs, p: 0.5, min: LIMITS.fullSamples, idle: sample.idle }).verdict, "FAIL");
});

test("full service timing cannot pass without the matching published correct query", () => {
  for (const mutate of [f => { f.calls = []; }, f => { f.calls[0].indexView.snapshotId = "other"; },
    f => { f.rows[2].kind = "delta"; }, f => { f.rows[2].elapsedMs = 10; },
    f => { f.rows[2].pid = 999; }, f => { f.calls[0].indexView.bindingVersion = 2; },
    f => { f.calls[0].indexView.workspaceId = "other"; }, f => { f.calls[0].startedAt = 201000; }]) {
    const fixture = fullFixture(); mutate(fixture);
    const missing = fullSample(fixture);
    assert.equal(missing.ms, Infinity);
    const good = { ...fullSample(fullFixture()), fullServiceMs: 1000 };
    assert.equal(fullTiming([good, good, missing]).verdict, "FAIL", "median cannot hide missing query");
  }
});

test("full service timing idle edges cover verification through the correct response", () => {
  const fixture = fullFixture(); fixture.loads[3].load1 = 20;
  assert.equal(fullSample(fixture).idle, false, "idle builder edges cannot hide a busy seal/query edge");
  fixture.loads[3].load1 = 1; fixture.loads[0].load1 = 20;
  assert.equal(fullSample(fixture).idle, false, "the start includes pre-dispatch verification");
});

test("full service timing follows only consecutive verified noops on its published snapshot", () => {
  const fixture = fullFixture();
  fixture.calls[0].indexView.bindingVersion = 3;
  fixture.rows.push(...[2, 3].map(bindingVersion => ({ at: 401000 + bindingVersion, boundAt: 401000 + bindingVersion,
    pid: 100, type: "round", workspaceId: "w", outcome: "noop", kind: "noop", snapshotId: "snap-7", bindingVersion })));
  assert.equal(fullSample(fixture).ms, 401100);
  assert.equal(fullSample(fixture).servedBindingVersion, 3);
  for (const change of [f => { f.rows.pop(); }, f => { f.rows.at(-1).snapshotId = "other"; },
    f => { f.rows.at(-1).outcome = "published"; }, f => { f.rows.at(-1).pid = 999; }]) {
    const broken = structuredClone(fixture); change(broken);
    assert.equal(fullSample(broken).ms, Infinity, "missing or changed binding lineage cannot prove this full");
  }
});

test("full service timing excludes code-zero publish rejection without cross-round evidence", () => {
  const fixture = fullFixture();
  const rejected = fixture.rows[2];
  rejected.outcome = "failed"; rejected.error = "buildKey changed before publish";
  delete rejected.snapshotId; delete rejected.bindingVersion;
  fixture.rows.push(at(403000, "scheduler", { type: "dispatched", kind: "full", workspaceId: "w", pid: 8, waitedMs: 100 }),
    at(503000, "scheduler", { type: "closed", kind: "full", workspaceId: "w", pid: 8, code: 0, runMs: 100000 }),
    { at: 504000, pid: 100, type: "round", workspaceId: "w", kind: "full", outcome: "published", elapsedMs: 101500,
      boundAt: 504000, snapshotId: "snap-8", bindingVersion: 1 });
  fixture.calls.push({ requestId: 9, workspace: "main", firstCorrect: true, status: "ok", startedAt: 504100, elapsedMs: 100,
    indexView: { workspaceId: "w", snapshotId: "snap-8", bindingVersion: 1 } });
  const sample = fullSample(fixture);
  assert.equal(sample.pid, 8, "the rejected attempt is never a successful full sample");
  assert.equal(sample.ms, 101600, "the next round uses only its own start and query");
  assert.deepEqual(sample.rejectedAttempts.map(row => [row.pid, row.error]), [[7, "buildKey changed before publish"]]);
  fixture.calls.pop();
  assert.equal(fullSample(fixture).ms, Infinity, "an earlier query cannot certify the next successful publication");
});

test("full service timing can complete while another workspace full is still running", () => {
  const fixture = fullFixture();
  fixture.rows.push(at(202000, "scheduler", { type: "dispatched", kind: "full", workspaceId: "other", pid: 8, waitedMs: 0 }));
  const first = fullSample(fixture);
  assert.equal(first.endAt, 402100, "first publication is queried before another full closes");
  fixture.rows.push(at(602000, "scheduler", { type: "closed", kind: "full", workspaceId: "other", pid: 8, code: 0, runMs: 400000 }));
  assert.equal(fullSample(fixture).endAt, first.endAt, "another full's completion cannot move this window");
});

test("bad syntax negative requires partial coverage even when stale", () => {
  assert.equal(badSyntaxNegative({ exact: "unknown", scopeState: "PARTIAL", stopReason: "STALE" }), true);
  assert.equal(badSyntaxNegative({ exact: "miss", scopeState: "READY", stopReason: "STALE" }), false);
  assert.equal(badSyntaxNegative({ exact: "miss", scopeState: "READY" }), false);
  assert.equal(badSyntaxNegative({ exact: "match", scopeState: "PARTIAL" }), false);
  assert.equal(badSyntaxNegative(undefined), false);
});

test("jobs, fairness, kills, peaks and heartbeat gaps come from lifecycle telemetry", () => {
  const rows = [
    at(1000, "scheduler", { type: "dispatched", workspaceId: "a", kind: "full", pid: 1, waitedMs: 0, builders: 1, full: 1, parserTokens: 2 }),
    at(2000, "scheduler", { type: "dispatched", workspaceId: "b", kind: "delta", pid: 2, waitedMs: 300, builders: 2, full: 1, parserTokens: 4 }),
    at(2500, "scheduler", { type: "result", workspaceId: "b", kind: "delta", pid: 2, ok: true, files: 5888, runMs: 450, stages: { parse: { files: 1, elapsedMs: 10 } } }),
    at(2600, "scheduler", { type: "closed", workspaceId: "b", kind: "delta", pid: 2, code: 0, signal: null, runMs: 600 }),
    { at: 1500, pid: 1, type: "builder", workspaceId: "a", beat: { seq: 1, at: 1490 } }, { at: 2600, pid: 1, type: "builder", workspaceId: "a", beat: { seq: 2, at: 2490 } },
    at(9000, "scheduler", { type: "closed", workspaceId: "a", kind: "full", pid: 1, code: 0, signal: null, runMs: 8000 }),
    at(12000, "scheduler", { type: "dispatched", workspaceId: "c", kind: "full", pid: 3, waitedMs: 7000, builders: 1, full: 1, parserTokens: 2 }),
    at(13000, "scheduler", { type: "closed", workspaceId: "c", kind: "full", pid: 3, code: null, signal: "SIGKILL", runMs: 1000 }),
    at(14000, "pool", { type: "worker-spawn", pid: 7 }), at(14100, "pool", { type: "worker-spawn", pid: 8 }), at(14200, "pool", { type: "worker-close", pid: 7, code: 0, signal: null, leases: 0 })
  ];
  const jobs = jobsFrom(rows);
  assert.deepEqual(jobs.map(job => [job.pid, job.kind, job.queueAt, job.runMs]), [[1, "full", 1000, 8000], [2, "delta", 1700, 600], [3, "full", 5000, 1000]]);
  assert.equal(jobs[1].touched, 1, "a delta's touched set is what it parsed, not the index size it reports as files");
  const fair = fairness(jobs);
  assert.deepEqual(fair.deltas.map(row => row.waitedMs), [300]);
  assert.deepEqual(fair.handoffs.map(row => [row.pid, row.handoffMs]), [[3, 3000]]);
  assert.equal(healthyKills(rows).length, 1, "an uninjected SIGKILL close is a healthy build killed");
  assert.equal(healthyKills(rows, [3]).length, 0, "an injected kill is a fault, not a health kill");
  assert.deepEqual(resourcePeaks(rows), { builders: 2, full: 1, parserTokens: 4, queryWorkers: 2 });
  assert.deepEqual(heartbeatGaps(rows).map(row => [row.gapMs, row.emitGapMs]), [[1100, 1000]], "arrival and the builder's own beat interval are kept apart");
});

test("evidence audit separates cross-worktree, mixed-capture and unknown hashes; deadlines include the 1 s slack", () => {
  const versions = { w1: { "A.java": { h1: { tokens: [] }, h2: { tokens: ["t2"] } } }, w2: { "A.java": { h9: { tokens: ["t9"] } } } };
  const calls = [
    { requestId: 1, workspace: "w1", token: "t2", candidates: [{ name: "t2", declaration: { relativePath: "A.java", contentHash: "h2" } }] },
    { requestId: 2, workspace: "w1", token: "t2", candidates: [{ name: "t2", declaration: { relativePath: "A.java", contentHash: "h1" } }] },
    { requestId: 3, workspace: "w1", token: "t9", candidates: [{ name: "t9", declaration: { relativePath: "A.java", contentHash: "h9" } }] },
    { requestId: 4, workspace: "w1", candidates: [{ name: "x", declaration: { relativePath: "A.java", contentHash: "zz" } }, { name: "y", declaration: { relativePath: "B.java", contentHash: "q" } }] },
    { requestId: 5, workspace: "w1", token: "A", candidates: [{ name: "A", declaration: { relativePath: "A.java", contentHash: "h1" } }] }
  ];
  const audit = auditEvidence(calls, versions);
  assert.deepEqual([audit.audited, audit.mixed.map(row => row.requestId), audit.cross.map(row => row.requestId), audit.unknown.map(row => row.requestId)], [5, [2], [3], [4]], "an original class name is not an inserted token: no mixed capture");
  assert.deepEqual(unboundedCalls([{ elapsedMs: 4000, deadlineMs: 3000 }, { elapsedMs: 4001, deadlineMs: 3000 }]).length, 1);
});

test("delta calibration fits run time to size and projects it to the limit", () => {
  const jobs = [100, 200].map((files, index) => ({ kind: "delta", ok: true, runMs: 1000 + files * 10, workspaceId: `w${index}`, closeAt: index * 10 }));
  const rounds = [100, 200].map((files, index) => ({ type: "round", workspaceId: `w${index}`, at: index * 10 + 1, outcome: "published", changed: files, deleted: 0 }));
  const keep = deltaCalibration(jobs, rounds, { limit: 400, fullMs: 240000 });
  assert.deepEqual([Math.round(keep.msPerFile), Math.round(keep.projectedRunMsAtLimit), keep.verdict], [10, 5000, "KEEP"]);
  assert.equal(deltaCalibration(jobs, rounds, { limit: 6000, fullMs: 240000 }).verdict, "LOWER", "61 s at 6000 files exceeds the 60 s delta deadline");
  const measured = [...jobs, { kind: "delta", ok: true, runMs: 70000, workspaceId: "w9", closeAt: 50 }];
  const atLimit = deltaCalibration(measured, [...rounds, { type: "round", workspaceId: "w9", at: 51, outcome: "published", changed: 400, deleted: 0 }], { limit: 400, fullMs: 240000 });
  assert.deepEqual([atLimit.basis, atLimit.atLimitMaxMs, atLimit.verdict], ["measured", 70000, "LOWER"], "a measured 70 s job at the limit outweighs a fit that projects 5 s");
  // The limit applies to the dependency closure: 300 changed files that resolve 390 count as 390, and an escalated set is kept.
  const closure = deltaCalibration([...jobs, { kind: "delta", ok: true, runMs: 30000, workspaceId: "w8", closeAt: 40, stages: { resolve: { files: 390 } } }, { kind: "delta", ok: false, escalation: "dependency closure 412 > 400 files", runMs: 21800 }],
    [...rounds, { type: "round", workspaceId: "w8", at: 41, outcome: "published", changed: 300, deleted: 0 }], { limit: 400, fullMs: 240000 });
  assert.deepEqual([closure.points.at(-1).files, closure.points.at(-1).changed, closure.atLimit, closure.atLimitMaxMs, closure.escalated.length], [390, 300, 1, 30000, 1]);
});

test("process samples attribute event-loop spikes to the publishes that just ended", () => {
  const rows = [
    { at: 10000, pid: 1, type: "round", outcome: "published", kind: "delta", changed: 1, timings: { publishMs: 300 } },
    { at: 12000, pid: 1, type: "process", rss: 200, heapUsed: 50, loop: { p50: 1, p99: 20, max: 380 } },
    { at: 30000, pid: 1, type: "process", rss: 300, heapUsed: 60, loop: { p50: 1, p99: 2, max: 140 } }
  ];
  const profile = processProfile(rows);
  assert.deepEqual([profile.samples, profile.rssBytes.max, profile.spikes.length, profile.spikesNearPublish], [2, 300, 2, 1]);
  assert.deepEqual(profile.spikes[0].publishes, [{ kind: "delta", changed: 1, publishMs: 300 }]);
});

test("starvation and lease leaks come from the queue and sweep telemetry, so the lifecycle gates can fail", () => {
  const queued = (ms, ws, owner = 100) => at(ms, "scheduler", { type: "queued", workspaceId: ws, kind: "delta", queued: 1 }, owner);
  const dispatched = (ms, ws, owner = 100) => at(ms, "scheduler", { type: "dispatched", workspaceId: ws, kind: "delta", pid: 9, waitedMs: 0, builders: 1, full: 0, parserTokens: 2 }, owner);
  const rows = [queued(0, "a"), dispatched(1000, "a"), queued(2000, "b"), queued(3000, "c", 200), { at: 3500, pid: 200, type: "round", workspaceId: "x", outcome: "noop" },
    queued(4000, "d"), { at: 5000, pid: 100, type: "round", workspaceId: "d", outcome: "failed" }, dispatched(LIMITS.starvationMs + 9000, "b")];
  const starve = starvation(rows);
  assert.equal(starve.queued, 4);
  assert.deepEqual(starve.starved.map(row => [row.workspaceId, row.waitedMs]), [["b", LIMITS.starvationMs + 7000]], "served only past the bound: starved");
  assert.deepEqual(starve.cutOff.map(row => row.workspaceId), ["c"], "still queued when its owner's telemetry ends: cut off by that owner's exit, not starved");
  const sweep = (ms, owner, kept) => ({ at: ms, pid: owner, type: "sweep", report: { kept } });
  const leases = leaseLeaks([sweep(0, 100, { leased: 1 }), sweep(LIMITS.leaseHoldMs + 1, 100, { leased: 1 }), sweep(LIMITS.leaseHoldMs + 2, 100, {}),
    sweep(0, 200, { leased: 2, "in-flight": 1 }), sweep(9, 200, { leased: 2, "in-flight": 1 }), sweep(0, 300, { leased: 1, "in-flight": 1 }), sweep(5, 300, {})]);
  assert.deepEqual(leases.leaks.map(row => [row.owner, row.reason]), [[100, "held without a build in flight"], [200, "kept at the incarnation's last sweep"]]);
  assert.deepEqual([leases.sweeps, leases.owners], [7, 3]);
});

test("analyze keeps hard gates separate from measured performance and never calls measurement a pass", () => {
  const verdict = analyze({ calls: [], telemetry: [], edits: [{ id: 1, firstCorrectMs: 100, firstCorrect: 1 }], seeds: [], physical: [], fulls: [], statusSamples: [1],
    loads: {}, versions: {}, injectedPids: [], negatives: [], faults: [], restart: { ok: true }, lifecycle: { ok: true } });
  assert.equal(verdict.status, "FAIL", "no calls, jobs, sweeps or audited evidence: the evidence-bound gates cannot pass");
  assert.deepEqual(["isolation", "requestDeadline", "resources", "noStarvation"].map(name => [verdict.hardGates[name].verdict, verdict.hardGates[name].evidenceFloor ?? false]),
    [["FAIL", false], ["FAIL", false], ["FAIL", false], ["FAIL", false]]);
  assert.equal(verdict.hardGates.correctness.verdict, "PASS");
  assert.equal(verdict.performanceReady, false);
  assert.deepEqual(verdict.performanceVerdicts.FAIL.includes("editFirstCorrect"), true);
  assert.equal(verdict.performance.editFirstCorrect.verdict, "FAIL", "1 round < 20");
  assert.equal(verdict.performance.physical20.verdict, "FAIL");
});

const measuredG11Fixture = () => {
  const telemetry = [at(0, "scheduler", { type: "dispatched", kind: "full", workspaceId: "w", pid: 7, waitedMs: 0, builders: 1, full: 1, parserTokens: 2 }),
    at(10000, "scheduler", { type: "closed", kind: "full", workspaceId: "w", pid: 7, code: 0, runMs: 10000 }),
    at(11000, "scheduler", { type: "dispatched", kind: "full", workspaceId: "w2", pid: 8, waitedMs: 2000, builders: 1, full: 1, parserTokens: 2 }),
    at(21000, "scheduler", { type: "closed", kind: "full", workspaceId: "w2", pid: 8, code: 0, runMs: 10000 }),
    { at: 22000, pid: 100, type: "sweep", report: { kept: {} } },
    { at: 1000, pid: 7, type: "builder", beat: { at: 1000 } }, { at: 1100, pid: 7, type: "builder", beat: { at: 1100 } }];
  for (let i = 0; i < 20; i++) {
    const base = 100 + i * 100, pid = 1000 + i;
    telemetry.push(at(base, "scheduler", { type: "queued", kind: "delta", workspaceId: `d${i}` }),
      at(base + 10, "scheduler", { type: "dispatched", kind: "delta", workspaceId: `d${i}`, pid, waitedMs: 10, builders: 2, full: 1, parserTokens: 4 }),
      at(base + 20, "scheduler", { type: "result", kind: "delta", workspaceId: `d${i}`, pid, ok: true, stages: { parse: { files: 1 } } }),
      at(base + 30, "scheduler", { type: "closed", kind: "delta", workspaceId: `d${i}`, pid, code: 0, runMs: 20 }));
  }
  const edits = Array.from({ length: 30 }, (_, id) => {
    const startAt = 30000 + id * 100, pid = 2000 + id, workspaceId = `edit${id}`;
    telemetry.push(at(startAt + 10, "scheduler", { type: "dispatched", kind: "delta", workspaceId, pid, waitedMs: 1, builders: 1, full: 0, parserTokens: 2 }),
      at(startAt + 20, "scheduler", { type: "result", kind: "delta", workspaceId, pid, ok: true, stages: { parse: { files: id < 20 ? 1 : 0 } } }),
      at(startAt + 30, "scheduler", { type: "closed", kind: "delta", workspaceId, pid, code: 0, runMs: 20 }));
    return { id, phase: "edits", window: "normal", windowEnd: "normal", windowVersion: 0, endWindowVersion: 0, ownerPid: 100, workspaceId,
      kind: id < 20 ? "java" : "xml", startAt, endedAt: startAt + 40, firstCorrect: id, firstCorrectMs: 40,
      loadStart: { load1: 1 }, loadEnd: { load1: 1 } };
  });
  return { calls: Array.from({ length: 70 }, (_, requestId) => ({ requestId, workspace: "w", elapsedMs: 1, deadlineMs: 100,
      candidates: [{ name: "A", declaration: { relativePath: "A.java", contentHash: "h" } }] })), telemetry,
    edits,
    seeds: ["le20", "to200"].flatMap(tier => Array.from({ length: 20 }, (_, id) => ({ id: `${tier}-${id}`, tier, phase: "seed", window: "normal", windowEnd: "normal", windowVersion: 0, endWindowVersion: 0, startAt: 23000, endedAt: 23010, firstCorrect: id, firstCorrectMs: 10, loadStart: { load1: 1 }, loadEnd: { load1: 1 } }))),
    physical: [0, 20, 200].flatMap(files => Array.from({ length: 3 }, (_, index) => ({ id: `physical-${files}-${index}`, files, firstCorrect: index, firstCorrectMs: 10, startAt: 23000, endedAt: 23010, loadStart: { load1: 1 }, loadEnd: { load1: 1 },
      newSnapshots: 0, jobs: 0, kind: "seed-bind", volumeValid: true, noiseBytes: 1, fullGrowthBytes: 1000, volumeRatio: 0.01, pageRatio: 0.01 }))),
    fulls: Array.from({ length: 3 }, () => ({ ...fullSample(fullFixture()), fullServiceMs: 400000 })), statusSamples: Array.from({ length: 100 }, (_, requestId) => ({ requestId, phase: "edits", phaseEnd: "edits", window: "normal", windowEnd: "normal", windowVersion: 0, endWindowVersion: 0,
      status: "ok", startedAt: 34000 + requestId * 2, endedAt: 34001 + requestId * 2, elapsedMs: 1, loadStart: { load1: 1 }, loadEnd: { load1: 1 } })),
    phases: [{ name: "fairness", startedAt: 0, endedAt: 22000 }, { name: "edits", startedAt: 30000, endedAt: 34000 }],
    loadSamples: telemetry.flatMap(row => [{ at: row.at, load1: 1 }]),
    loads: Object.fromEntries(["seed", "fairness", "edits", "status"].map(name => [name, { start: { load1: 1 }, end: { load1: 1 } }])),
    versions: { w: { "A.java": { h: { tokens: [] } } } }, injectedPids: [], negatives: [{ ok: true }], faults: [], restart: { ok: true }, lifecycle: { ok: true } };
};

test("G11 reanalysis preserves recorded job load windows and measurement completion", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mac11-reanalysis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = measuredG11Fixture();
  const { calls, telemetry, versions, loadSamples, ...samples } = fixture;
  for (const [name, value] of Object.entries({ "samples.json": samples, "versions.json": versions,
    "load-samples.json": loadSamples, "g11-analysis.json": analyze(fixture) })) {
    await writeFile(path.join(root, name), JSON.stringify(value));
  }
  await writeFile(path.join(root, "calls.jsonl"), calls.map(row => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(path.join(root, "owner-telemetry.jsonl"), telemetry.map(row => JSON.stringify(row)).join("\n") + "\n");
  const result = await reanalyze(root);
  assert.equal(result.status, "PASS");
  assert.equal(result.verdict.measurementComplete, true);
  assert.equal(result.inputs["load-samples.json"], sha256(await readFile(path.join(root, "load-samples.json"))));
});

test("G11 measurement completion rejects missing invalid or censored evidence but permits measured performance failure", () => {
  const complete = analyze(measuredG11Fixture());
  assert.ok(Object.values(complete.hardGates).every(item => item.verdict === "PASS"));
  assert.equal(complete.status, "PASS", "fully measured slow fulls may proceed to MAC-12");
  assert.equal(complete.performanceReady, false);
  for (const mutate of [f => { f.fulls = []; }, f => { f.seeds[0].loadEnd.load1 = 20; },
    f => { delete f.fulls[0].firstCorrect; }, f => { f.statusSamples[0].elapsedMs = Infinity; }]) {
    const fixture = measuredG11Fixture(); mutate(fixture);
    const verdict = analyze(fixture);
    assert.ok(Object.values(verdict.hardGates).every(item => item.verdict === "PASS"));
    assert.equal(verdict.status, "FAIL", "hard PASS alone cannot certify incomplete measurements");
    assert.equal(verdict.measurementComplete, false);
  }
});

test("performance samples cannot borrow edits or seeds from other phases", () => {
  const fixture = measuredG11Fixture();
  fixture.edits.slice(0, 20).forEach(row => { row.phase = "fairness"; });
  fixture.seeds.filter(row => row.tier === "le20").forEach(row => { row.phase = "worktrees"; row.window = "seed"; });
  const performance = analyze(fixture).performance;
  assert.equal(performance.editFirstCorrect.n, 10);
  assert.equal(performance.editFirstCorrect.verdict, "FAIL");
  assert.equal(performance.seedLe20.n, 0);
  assert.equal(performance.seedLe20.verdict, "FAIL");
  assert.equal(performance.singleFileBuild.verdict, "FAIL", "fairness builders cannot fill normal edit samples");
  const wrongKind = measuredG11Fixture(); wrongKind.edits[20].kind = "java";
  assert.equal(analyze(wrongKind).performance.editFirstCorrect.verdict, "FAIL", "extra Java cannot replace a missing XML round");
  const missingDuration = measuredG11Fixture(); delete missingDuration.edits[0].firstCorrectMs;
  assert.equal(analyze(missingDuration).performance.editFirstCorrect.verdict, "FAIL");
});

test("single-file edit builds retain missing jobs close and duration as failed evidence", () => {
  for (const mutate of [f => { f.telemetry = f.telemetry.filter(row => row.event?.pid !== 2000); },
    f => { f.telemetry = f.telemetry.filter(row => !(row.event?.pid === 2000 && row.event.type === "closed")); },
    f => { delete f.telemetry.find(row => row.event?.pid === 2000 && row.event.type === "closed").event.runMs; },
    f => { f.edits[0].ownerPid = 999; }]) {
    const fixture = measuredG11Fixture(); mutate(fixture);
    const item = analyze(fixture).performance.singleFileBuild;
    assert.equal(item.verdict, "FAIL");
    assert.ok(item.censored > 0, "missing normal-edit evidence cannot be silently filtered");
  }
});

test("each edit seed and build timing uses its own load edges", () => {
  for (const [change, itemName] of [[f => { f.edits[0].loadEnd.load1 = 20; }, "editFirstCorrect"],
    [f => { f.seeds[0].loadEnd.load1 = 20; }, "seedLe20"],
    [f => { f.loadSamples.find(row => row.at === 30030).load1 = 20; }, "singleFileBuild"]]) {
    const fixture = measuredG11Fixture(); change(fixture);
    assert.equal(analyze(fixture).performance[itemName].verdict, "INVALID_EXPERIMENT", "idle phase edges cannot hide a busy sample");
  }
});

test("status timing requires real normal request load and preserves incomplete or failed requests", () => {
  const measured = analyze(measuredG11Fixture()).performance.statusStartFalse;
  assert.equal(measured.verdict, "PASS");
  for (const mutate of [f => { f.statusSamples = Array(100).fill(1); },
    f => { delete f.statusSamples[0].loadEnd; }, f => { f.statusSamples[0].loadEnd.load1 = 20; }]) {
    const fixture = measuredG11Fixture(); mutate(fixture);
    assert.equal(analyze(fixture).performance.statusStartFalse.verdict, "INVALID_EXPERIMENT");
  }
  for (const mutate of [f => { f.statusSamples[0].status = "error"; },
    f => { delete f.statusSamples[0].endedAt; }, f => { f.statusSamples[0].status = "pending"; }]) {
    const fixture = measuredG11Fixture(); mutate(fixture);
    assert.equal(analyze(fixture).performance.statusStartFalse.verdict, "FAIL");
  }
  const crossing = measuredG11Fixture();
  crossing.statusSamples[0].endWindowVersion = 2;
  assert.equal(analyze(crossing).performance.statusStartFalse.n, 99, "normal-fault-normal crossings are excluded");
});

test("fairness performance never counts jobs from another phase", () => {
  const fixture = measuredG11Fixture(); fixture.phases = fixture.phases.filter(row => row.name !== "fairness");
  const verdict = analyze(fixture);
  assert.equal(verdict.performance.queuedDuringFull.n, 0);
  assert.equal(verdict.performance.fullHandoff.n, 0);
  assert.equal(verdict.hardGates.noStarvation.verdict, "PASS", "hard gates still inspect the entire run");
});

test("G11 aggregation retains all attempts and measures all valid samples despite an environmental outlier", () => {
  const fixture = measuredG11Fixture();
  fixture.seeds.push({ ...fixture.seeds[0], id: "seed-environment", loadEnd: { load1: 20 } },
    { ...fixture.seeds.find(row => row.tier === "to200"), id: "seed-to200-environment", loadEnd: { load1: 20 } });
  fixture.statusSamples.push({ ...fixture.statusSamples[0], requestId: 1001, loadEnd: { load1: 20 } });
  fixture.fulls.push({ ...fixture.fulls[0], label: "full-environment", loadAtCorrect: { load1: 20 }, idle: false });
  const edit = { ...fixture.edits[0], id: "edit-environment", workspaceId: "edit-environment", startAt: 50000, endedAt: 50040, loadEnd: { load1: 20 } };
  fixture.edits.push(edit);
  fixture.telemetry.push(at(50010, "scheduler", { type: "dispatched", kind: "delta", workspaceId: edit.workspaceId, pid: 3000, waitedMs: 1 }),
    at(50020, "scheduler", { type: "result", kind: "delta", workspaceId: edit.workspaceId, pid: 3000, ok: true, stages: { parse: { files: 1 } } }),
    at(50030, "scheduler", { type: "closed", kind: "delta", workspaceId: edit.workspaceId, pid: 3000, code: 0, runMs: 20 }));
  fixture.loadSamples.push({ at: 50010, load1: 1 }, { at: 50030, load1: 20 });
  const result = analyze(fixture);
  assert.equal(result.measurementComplete, true);
  for (const name of ["seedLe20", "seedTo200", "statusStartFalse", "full", "singleFileBuild", "editFirstCorrect"]) {
    const item = result.performance[name];
    assert.equal(item.invalidN, 1, name);
    assert.equal(item.missingN, 0, name);
    assert.equal(item.attemptedN, item.validN + 1, name);
    assert.equal(item.attempts.filter(row => row.verdict === "INVALID_EXPERIMENT").length, 1, name);
  }
  assert.deepEqual(result.performance.editFirstCorrect.countsByKind, { java: 20, xml: 10 });
});

test("G11 aggregation never hides missing evidence or slow valid samples behind enough valid samples", () => {
  for (const mutate of [row => { delete row.loadEnd; }, row => { row.status = "error"; row.loadEnd = { load1: 20 }; }, row => { delete row.endedAt; }, row => { row.loadEnd = { load1: -1 }; }, row => { row.loadEnd = { load1: Infinity }; }]) {
    const fixture = measuredG11Fixture();
    const missing = { ...fixture.statusSamples[0], requestId: 1001 }; mutate(missing); fixture.statusSamples.push(missing);
    const result = analyze(fixture), item = result.performance.statusStartFalse;
    assert.equal(result.measurementComplete, false);
    assert.equal(item.validN, 100);
    assert.equal(item.missingN, 1);
    assert.equal(item.invalidN, 0, "failure or missing load is never environment-only noise");
  }
  for (const mutate of [row => { delete row.firstCorrect; }, row => { delete row.endAt; }, row => { row.censored = true; }]) {
    const fixture = measuredG11Fixture();
    const missing = { ...fixture.fulls[0] }; mutate(missing); fixture.fulls.push(missing);
    const result = analyze(fixture);
    assert.equal(result.measurementComplete, false);
    assert.deepEqual([result.performance.full.validN, result.performance.full.invalidN, result.performance.full.missingN], [3, 0, 1]);
  }
  const fixture = measuredG11Fixture();
  fixture.statusSamples.push({ ...fixture.statusSamples[0], requestId: 1001, elapsedMs: 10000, endedAt: 44000 });
  const item = analyze(fixture).performance.statusStartFalse;
  assert.equal(item.validN, 101);
  assert.equal(item.max, 10000, "every slow valid response remains in the statistics");
  assert.equal(item.attempts.find(row => row.requestId === 1001).value, 10000);
});

test("G11 physical aggregation retains noisy rows and requires three complete valid measurements per tier", () => {
  const fixture = measuredG11Fixture();
  const base = fixture.physical.find(row => row.files === 20);
  const noisy = { ...base, id: "physical-noise", volumeValid: false, volumeRatio: 1, noiseBytes: 100, fullGrowthBytes: 1000 };
  fixture.physical.push(noisy);
  let result = analyze(fixture), item = result.performance.physical20;
  assert.equal(result.measurementComplete, true);
  assert.deepEqual([item.attemptedN, item.validN, item.invalidN, item.missingN], [4, 3, 1, 0]);
  assert.equal(item.rows.length, 4, "original physical rows remain available");
  fixture.physical.splice(fixture.physical.indexOf(base), 1);
  result = analyze(fixture);
  assert.equal(result.measurementComplete, false);
  assert.equal(result.performance.physical20.validN, 2);
  fixture.physical.push({ ...base, id: "physical-slow", volumeRatio: 0.9 });
  fixture.physical.find(row => row.files === 20 && row !== noisy && row.id !== "physical-slow").volumeRatio = 0.9;
  item = analyze(fixture).performance.physical20;
  assert.equal(item.verdict, "FAIL", "all valid high physical costs participate in the median");
  assert.equal(item.value, 0.9);
  delete noisy.noiseBytes;
  item = analyze(fixture).performance.physical20;
  assert.equal(item.missingN, 1, "an unexplained volume-invalid flag cannot hide missing evidence");
  assert.equal(item.evidenceComplete, false);
});

test("G11 zero-write invariant cannot be excluded by environmental load", () => {
  for (const violation of [{ newSnapshots: 1, jobs: 1 }, { kind: "full" }]) {
    const fixture = measuredG11Fixture(), base = fixture.physical.find(row => row.files === 0);
    fixture.physical.push({ ...base, ...violation, id: "zero-write-violation", loadEnd: { load1: 20 } });
    const result = analyze(fixture);
    assert.equal(result.performance.physicalZero.verdict, "FAIL");
    assert.equal(result.performance.physicalZero.structuralViolations.length, 1);
    assert.equal(result.measurementComplete, false, "structural violations cannot be deferred as performance repairs");
  }
});

test("G11 failed high-load builder and round cannot be excluded as environment-only noise", () => {
  const fixture = measuredG11Fixture();
  fixture.edits.push({ ...fixture.edits[0], id: "failed-edit", workspaceId: "failed-edit", startAt: 50000, endedAt: 50040 });
  fixture.telemetry.push(at(50010, "scheduler", { type: "dispatched", kind: "delta", workspaceId: "failed-edit", pid: 3000, waitedMs: 1 }),
    at(50020, "scheduler", { type: "result", kind: "delta", workspaceId: "failed-edit", pid: 3000, ok: false, stages: { parse: { files: 1 } } }),
    at(50030, "scheduler", { type: "closed", kind: "delta", workspaceId: "failed-edit", pid: 3000, code: 1, runMs: 20, failure: "builder failed" }));
  fixture.loadSamples.push({ at: 50010, load1: 1 }, { at: 50030, load1: 20 });
  let result = analyze(fixture), item = result.performance.singleFileBuild;
  assert.equal(item.verdict, "FAIL");
  assert.deepEqual([item.validN, item.invalidN, item.missingN], [20, 0, 1]);
  assert.equal(item.samples.find(row => row.pid === 3000).failure, "builder failed");
  assert.equal(result.measurementComplete, false);
  const failedRound = measuredG11Fixture();
  failedRound.seeds.push({ ...failedRound.seeds[0], id: "failed-round", outcome: "failed", loadEnd: { load1: 20 } });
  result = analyze(failedRound);
  assert.deepEqual([result.performance.seedLe20.validN, result.performance.seedLe20.invalidN, result.performance.seedLe20.missingN], [20, 0, 1]);
  assert.equal(result.measurementComplete, false);
});

test("G11 seed tier follows actual full escalation even when the round still says delta", () => {
  const make = () => {
    const fixture = measuredG11Fixture();
    Object.assign(fixture.seeds[0], { ownerPid: 100, workspaceId: "seed-full", kind: "delta", jobs: 2, outcome: "published" });
    fixture.telemetry.push(at(23001, "scheduler", { type: "dispatched", kind: "delta", workspaceId: "seed-full", pid: 4000, waitedMs: 0 }),
      at(23002, "scheduler", { type: "result", kind: "delta", workspaceId: "seed-full", pid: 4000, ok: false, escalation: "dependency closure exceeds limit" }),
      at(23003, "scheduler", { type: "closed", kind: "delta", workspaceId: "seed-full", pid: 4000, code: 0, runMs: 2 }),
      at(23004, "scheduler", { type: "dispatched", kind: "full", workspaceId: "seed-full", pid: 4001, waitedMs: 0 }),
      at(23005, "scheduler", { type: "result", kind: "full", workspaceId: "seed-full", pid: 4001, ok: true }),
      at(23009, "scheduler", { type: "closed", kind: "full", workspaceId: "seed-full", pid: 4001, code: 0, runMs: 5 }));
    return fixture;
  };
  const fixture = make(), result = analyze(fixture), item = result.performance.seedLe20;
  assert.equal(item.validN, 19, "an actual full cannot fill the seed quota");
  assert.equal(item.escalatedFullN, 1);
  assert.equal(item.recordedN, 20);
  assert.equal(item.escalatedFulls[0].sample, fixture.seeds[0], "the original sample remains referenced");
  assert.deepEqual(item.escalatedFulls[0].jobs.map(job => [job.owner, job.workspaceId, job.pid, job.kind]),
    [[100, "seed-full", 4000, "delta"], [100, "seed-full", 4001, "full"]]);
  assert.equal(result.performance.full.validN, 3, "excluded seed attempts never fill the full quota");
  assert.equal(result.measurementComplete, false);
  for (const mutate of [f => { f.telemetry.find(row => row.event?.pid === 4001 && row.event.type === "closed").event.code = 1; },
    f => { f.telemetry = f.telemetry.filter(row => !(row.event?.pid === 4001 && row.event.type === "closed")); },
    f => { f.telemetry = f.telemetry.filter(row => row.event?.pid !== 4001); },
    f => { delete f.seeds[0].firstCorrect; }, f => { delete f.seeds[0].loadEnd; },
    f => { f.telemetry.filter(row => [4000, 4001].includes(row.event?.pid)).forEach(row => { row.pid = 999; }); },
    f => { f.telemetry.filter(row => [4000, 4001].includes(row.event?.pid)).forEach(row => { row.event.workspaceId = "other"; }); },
    f => { f.telemetry.filter(row => [4000, 4001].includes(row.event?.pid)).forEach(row => { row.at += 100; }); }]) {
    const incomplete = make(); mutate(incomplete);
    const verdict = analyze(incomplete), seed = verdict.performance.seedLe20;
    assert.equal(seed.escalatedFullN, 0, "failed or unproven attempts cannot be excluded as successful fulls");
    assert.equal(seed.missingN, 1);
    assert.equal(verdict.measurementComplete, false);
  }
});

test("negative waits only for explicit stale partial and preserves real misses and failures", async () => {
  const fresh = { exact: "miss", scopeState: "READY", indexView: { state: "FRESH" } };
  const stale = { scopeState: "PARTIAL", stopReason: "STALE", indexView: { state: "STALE" } };
  async function check(values) {
    let clock = 0, probes = 0;
    const result = await settleNegative(async () => ({ row: { requestId: ++probes }, value: values[Math.min(probes - 1, values.length - 1)] }),
      { timeoutMs: 300, pollMs: 100, now: () => clock, pause: async ms => { clock += ms; } });
    return { ...result, probes, clock };
  }
  const converged = await check([stale, fresh]);
  assert.equal(converged.ok, true); assert.equal(converged.probes, 2);
  for (const positive of [{ ...stale, exact: "match" }, { ...stale, exact: "ambiguous" }, { ...stale, candidates: [{}] }]) {
    const match = await check([positive, fresh]);
    assert.equal(match.ok, false); assert.equal(match.probes, 1, "positive evidence cannot be swallowed");
  }
  const timeout = await check([stale]);
  assert.equal(timeout.ok, false); assert.equal(timeout.timedOut, true); assert.equal(timeout.clock, 300);
  for (const value of [{ ...fresh, indexView: { state: "STALE" } }, { ...stale, indexView: undefined }, { ...fresh, indexView: undefined }]) {
    const result = await check([value, fresh]);
    assert.equal(result.ok, false); assert.equal(result.probes, 1, "malformed confidence cannot retry into success");
  }
});

test("telemetry concurrent polls share one read and release it after completion", async () => {
  const telemetry = new Telemetry("unused");
  let reads = 0, finish;
  telemetry.readRows = () => { reads++; return new Promise(resolve => { finish = resolve; }); };
  const first = telemetry.poll(), second = telemetry.poll();
  assert.equal(first, second, "concurrent observers share the same offset read");
  assert.equal(reads, 1);
  finish([]); await first;
  const next = telemetry.poll();
  assert.equal(reads, 2, "later polls read new bytes");
  finish([]); await next;
});

// ---------------------------------------------------------------- real load (G11)

const INPUTS = process.env.ILV2_MAC11_INPUTS;
const QUICK = process.env.ILV2_MAC11_QUICK === "1";
const PHASES = new Set((process.env.ILV2_MAC11_PHASES ?? "main,seed,worktrees,edits,faults,fairness,daemon").split(","));
// STOP_MS bounds correctness (first correct at all); timing gates are judged on the measured value, not on the stop.
const POLL_MS = 150, STOP_MS = 300_000, FULL_STOP_MS = 2_400_000, GC_CYCLE_MS = 5_000, NOISE_MS = 3_000;
const STATUS_DEADLINE_MS = 3_000, QUERY_DEADLINE_MS = 15_000;
const WORKTREES = [["w1", 1], ["w2", 3], ["w3", 6], ["w4", 10], ["w5", 30], ["w6", 100]];
const FAR = { w5: 160, w6: 200 };
const FULL_SEED_PLAN =
  // Tiers follow each round's own changed+deleted; HEAD~12 and deeper land in 21-200, so they carry the ≥20 samples that tier needs.
  { zero: 3, k: [[1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 3], [8, 3], [10, 3], [12, 5], [15, 2], [20, 4], [25, 4], [30, 4]], exact200: 3, atLimit: [200, 225, 250] };
const SEED_PLAN = QUICK ? { zero: 1, k: [[1, 1], [4, 1], [6, 1], [30, 1]], exact200: 1, atLimit: [225] } : FULL_SEED_PLAN;
const SUPPLEMENT_FILE = process.env.ILV2_MAC11_SUPPLEMENT;
const EDIT_ROUNDS = QUICK ? { java: 3, xml: 2 } : { java: 20, xml: 10 };
function supplementPlan(value, { quick = false } = {}) {
  assert.equal(quick, false, "QUICK and measurement supplements are mutually exclusive");
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "supplement plan must be an object");
  const { seedPlan, editRounds } = value;
  assert.ok(seedPlan && editRounds && typeof seedPlan === "object" && typeof editRounds === "object", "seedPlan and editRounds are required");
  assert.deepEqual(Object.keys(seedPlan).sort(), ["atLimit", "exact200", "k", "zero"]);
  assert.deepEqual(Object.keys(editRounds).sort(), ["java", "xml"]);
  const count = n => { assert.ok(Number.isSafeInteger(n) && n >= 0, "case counts must be finite nonnegative safe integers"); return n; };
  const knownDepths = new Set(FULL_SEED_PLAN.k.map(([depth]) => depth));
  assert.ok(Array.isArray(seedPlan.k) && Array.isArray(seedPlan.atLimit), "k and atLimit must be arrays");
  const k = seedPlan.k.map(row => {
    assert.ok(Array.isArray(row) && row.length === 2 && knownDepths.has(row[0]), "unknown history tier");
    return [row[0], count(row[1])];
  });
  assert.equal(new Set(k.map(([depth]) => depth)).size, k.length, "duplicate history tier");
  assert.ok(seedPlan.atLimit.every(size => FULL_SEED_PLAN.atLimit.includes(size)), "unknown closure tier");
  assert.equal(new Set(seedPlan.atLimit).size, seedPlan.atLimit.length, "duplicate closure tier");
  return { seedPlan: { zero: count(seedPlan.zero), k, exact200: count(seedPlan.exact200), atLimit: [...seedPlan.atLimit] },
    editRounds: { java: count(editRounds.java), xml: count(editRounds.xml) } };
}

function measurementSupplement(verdict, state, { planFile, planSha256, plan, closeout, closeoutError, failure } = {}) {
  const hard = verdict.hardGates;
  const checks = {
    completed: !failure,
    correctResponses: [...state.seeds, ...state.edits, ...state.fulls].length > 0
      && [...state.seeds, ...state.edits, ...state.fulls].every(row => Number.isInteger(row.firstCorrect) && (Number.isFinite(row.firstCorrectMs) || Number.isFinite(row.fullServiceMs)))
      && state.fulls.every(row => Number.isFinite(row.fullServiceMs)),
    auditedEvidence: hard.isolation.audited > 0 && [hard.isolation.cross, hard.isolation.mixed, hard.isolation.unknown].every(rows => Array.isArray(rows) && rows.length === 0),
    requestDeadlines: hard.requestDeadline.verdict === "PASS",
    resources: hard.resources.verdict === "PASS",
    healthyBuilders: Array.isArray(hard.resources.healthyKills) && hard.resources.healthyKills.length === 0,
    noObservedStarvation: Array.isArray(hard.noStarvation.starved) && hard.noStarvation.starved.length === 0,
    closeout: !closeoutError && closeout?.groupsGone === true && Array.isArray(closeout.daemonsAfterNormalStop) && closeout.daemonsAfterNormalStop.length === 0,
    frozenInputUnchanged: verdict.frozenInputUnchanged === true,
    ...(state.negatives.length ? { negatives: state.negatives.every(row => row.ok === true) } : {}),
    ...(state.faults.length ? { faults: state.faults.every(row => row.ok === true) } : {}),
    ...(state.restart ? { restart: state.restart.ok === true } : {})
  };
  const phaseState = name => { const row = state.phases.find(row => row.name === name); return row ? Number.isFinite(row.endedAt) ? "EXECUTED" : "STARTED" : "NOT_RUN"; };
  return { schema: "ilv2-mac11-supplement/v1", mode: "DIAGNOSTIC_ONLY", gateId: "G11", gateStatus: "NOT_GATED",
    status: Object.values(checks).every(value => value === true) ? "PASS" : "FAIL", checks,
    planFile, planSha256, plan, scope: { phases: state.phases.map(row => row.name), seeds: state.seeds.length, edits: state.edits.length, fulls: state.fulls.length },
    coverage: { restart: state.restart ? state.restart.ok ? "EXECUTED" : "FAILED" : "NOT_RUN", fairness: phaseState("fairness") },
    failure: failure ? String(failure.stack ?? failure) : null, closeoutError: closeoutError ? String(closeoutError) : null };
}

test("supplement plan narrows finite known cases without changing measurement limits", () => {
  const limits = structuredClone(LIMITS), defaults = structuredClone(FULL_SEED_PLAN);
  const plan = { seedPlan: { zero: 0, k: [[4, 16], [12, 12]], exact200: 3, atLimit: [] }, editRounds: { java: 7, xml: 4 } };
  assert.deepEqual(supplementPlan(plan), plan);
  assert.deepEqual(LIMITS, limits);
  assert.deepEqual(FULL_SEED_PLAN, defaults);
  assert.throws(() => supplementPlan(plan, { quick: true }), /mutually exclusive/);
  for (const mutate of [p => { p.seedPlan.zero = -1; }, p => { p.editRounds.java = 1.5; },
    p => { p.seedPlan.exact200 = Infinity; }, p => { p.seedPlan.k = [[11, 1]]; },
    p => { p.seedPlan.k.push([4, 1]); }, p => { p.seedPlan.atLimit = [201]; }]) {
    const invalid = structuredClone(plan); mutate(invalid); assert.throws(() => supplementPlan(invalid));
  }
});

test("supplement proof gates only executed contracts and preserves failures", () => {
  const state = measuredG11Fixture();
  state.restart = undefined; state.phases = [{ name: "main", startedAt: 0, endedAt: 10 }];
  const verdict = analyze(state); verdict.frozenInputUnchanged = true;
  const options = { closeout: { groupsGone: true, daemonsAfterNormalStop: [] } };
  const proof = measurementSupplement(verdict, state, options);
  assert.equal(proof.schema, "ilv2-mac11-supplement/v1");
  assert.equal(proof.status, "PASS");
  assert.equal(proof.gateStatus, "NOT_GATED");
  assert.equal(proof.mode, "DIAGNOSTIC_ONLY");
  assert.deepEqual(proof.coverage, { restart: "NOT_RUN", fairness: "NOT_RUN" });
  assert.equal(Object.hasOwn(proof.checks, "restart"), false);
  assert.equal(verdict.hardGates.correctness.verdict, "FAIL", "skipped restart does not acquire a whole-gate pass");
  assert.ok(Object.values(proof.checks).every(value => value === true));
  for (const mutate of [s => { delete s.seeds[0].firstCorrect; }, s => { s.edits[0].firstCorrectMs = Infinity; },
    s => { s.fulls[0].fullServiceMs = Infinity; }, s => { s.lifecycle.ok = false; },
    s => { s.calls[0].elapsedMs = 10000; }, s => { s.negatives[0].ok = false; }]) {
    const broken = structuredClone(state); mutate(broken);
    const analysis = analyze(broken); analysis.frozenInputUnchanged = true;
    assert.equal(measurementSupplement(analysis, broken, options).status, "FAIL");
  }
  assert.equal(measurementSupplement(verdict, state, { ...options, failure: new Error("scope aborted") }).status, "FAIL");
  assert.equal(measurementSupplement(verdict, state, { closeout: { groupsGone: false, daemonsAfterNormalStop: [] } }).status, "FAIL");
});

test("timing attempt export retains environment references missing evidence and every valid slow value", () => {
  const measured = analyze(measuredG11Fixture()).performance.seedLe20;
  const slow = { ...measured.attempts[0], id: "slow", value: LIMITS.seedMs.le20 * 100 };
  const environment = { ...measured.attempts[0], id: "busy", category: "ENVIRONMENT", verdict: "INVALID_EXPERIMENT", loadEnd: { load1: 20 } };
  const attempts = [...measured.attempts, slow, slow, environment];
  const options = { min: LIMITS.seedSamples, limit: LIMITS.seedMs.le20 };
  const result = summarizeTimingAttempts(attempts, options);
  assert.equal(result.attemptedN, 23); assert.equal(result.validN, 22); assert.equal(result.invalidN, 1);
  assert.equal(result.max, slow.value); assert.equal(result.verdict, "FAIL");
  assert.equal(result.evidenceComplete, true, "measured slow attempts remain complete");
  assert.equal(result.attempts, attempts, "all original classified references are retained");
  const missing = { ...environment, id: "missing", category: "MISSING_EVIDENCE", verdict: "INVALID_EXPERIMENT", value: null, loadEnd: undefined };
  const incomplete = summarizeTimingAttempts([...attempts, missing], options);
  assert.equal(incomplete.missingN, 1); assert.equal(incomplete.evidenceComplete, false);
  assert.notEqual(incomplete.verdict, "PASS");
});

const pad = n => String(n).padStart(4, "0");
const git = (root, args) => execute("git", ["--no-optional-locks", "-C", root, ...args], { maxBuffer: 512 * 1024 * 1024 }).then(result => result.stdout);
const nul = text => text.split("\0").filter(Boolean);
const freeBytes = async dir => { const info = await statfs(dir); return info.bavail * info.bsize; };
/** Poll `probe` every `everyMs` until it returns a truthy value; throws past `timeoutMs`. */
async function until(probe, timeoutMs, everyMs = 200) {
  const limit = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() > limit) throw new Error("observation deadline exceeded");
    await delay(everyMs);
  }
}

/** A top-level class file whose name, package and last brace locate a method insertion. */
function javaShape(relativePath, text) {
  const name = path.basename(relativePath, ".java");
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
  if (!pkg || !new RegExp(`\\bclass\\s+${name}\\b`).test(text) || text.lastIndexOf("}") < 0) return undefined;
  return { pkg, name, fqn: `${pkg}.${name}` };
}
const withMethod = (text, method, body = "{}") => { const at = text.lastIndexOf("}"); return `${text.slice(0, at)}  public void ${method}() ${body}\n${text.slice(at)}`; };

/** Changed relevant inputs between `commit` and HEAD; `absent` = not in `commit` (the history helper's convention). */
async function diffRows(repo, commit) {
  const parts = nul(await git(repo, ["diff", "--no-renames", "--name-status", "-z", commit, "HEAD"]));
  const rows = [];
  for (let index = 0; index < parts.length; index += 2) if (relevantInput(parts[index + 1])) rows.push({ path: parts[index + 1], absent: parts[index] === "A" });
  return rows;
}

class Telemetry {
  constructor(file) { this.file = file; this.rows = []; this.offset = 0; this.partial = ""; }
  poll() {
    return this.pending ??= this.readRows().finally(() => { this.pending = undefined; });
  }
  async readRows() {
    let size;
    try { size = (await stat(this.file)).size; } catch (error) { if (error.code === "ENOENT") return this.rows; throw error; }
    if (size <= this.offset) return this.rows;
    const chunk = await new Promise((resolve, reject) => {
      const parts = [];
      createReadStream(this.file, { start: this.offset, end: size - 1 }).on("data", part => parts.push(part)).on("end", () => resolve(Buffer.concat(parts).toString("utf8"))).on("error", reject);
    });
    this.offset = size;
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) if (line) this.rows.push(JSON.parse(line));
    return this.rows;
  }
  async waitFor(predicate, timeoutMs) {
    const limit = performance.now() + timeoutMs;
    for (;;) {
      const found = (await this.poll()).find(predicate);
      if (found) return found;
      if (performance.now() > limit) return undefined;
      await delay(100);
    }
  }
}

test("G11 system loop on isolated lishu-v2 run copies", { skip: !INPUTS && "ILV2_MAC11_INPUTS names the frozen input record list", timeout: 6 * 3600_000 }, async t => {
  const raw = process.env.ILV2_EVIDENCE_ROOT ?? path.join(process.env.ILV2_RUN_ROOT, "raw");
  await mkdir(raw, { recursive: true });
  const supplementBytes = SUPPLEMENT_FILE ? await readFile(SUPPLEMENT_FILE) : undefined;
  const supplement = supplementBytes ? supplementPlan(JSON.parse(supplementBytes.toString("utf8")), { quick: QUICK }) : undefined;
  const seedPlan = supplement?.seedPlan ?? SEED_PLAN, editRounds = supplement?.editRounds ?? EDIT_ROUNDS;
  const supplementIdentity = supplement ? { planFile: path.resolve(SUPPLEMENT_FILE), planSha256: sha256(supplementBytes), plan: supplement } : undefined;
  let supplementProofWritten = false;
  if (supplement) t.after(async () => {
    if (!supplementProofWritten) await evidence("measurement-supplement", { schema: "ilv2-mac11-supplement/v1", mode: "DIAGNOSTIC_ONLY", gateStatus: "NOT_GATED",
      status: "FAIL", checks: { completed: false }, ...supplementIdentity });
  });
  const previousTmpdir = process.env.TMPDIR;
  const scratch = path.join(await realpath(os.tmpdir()), "mac11.noindex");
  await mkdir(scratch, { recursive: true });
  const scratchInfo = await lstat(scratch);
  assert.ok(scratchInfo.isDirectory() && !scratchInfo.isSymbolicLink(), "G11 scratch must be an owned real directory");
  process.env.TMPDIR = scratch;
  t.after(() => { if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir; });
  const record = (await readJson(INPUTS)).find(row => row.name === "lishu-v2");
  assert.ok(record, "lishu-v2 input record");
  const input = { before: await verifyFrozenInput(record) };
  const { rootIdentityOf, workspaceIdFor } = await import("../dist/java-index/snapshot/workspace-tracker.js");
  const telemetryFile = path.join(raw, "owner-telemetry.jsonl");
  const callsFile = path.join(raw, "calls.jsonl");
  const telemetry = new Telemetry(telemetryFile);
  const state = { calls: [], edits: [], seeds: [], physical: [], fulls: [], statusSamples: [], loads: {}, versions: {}, injectedPids: [], negatives: [], faults: [],
    restart: undefined, lifecycle: undefined, phases: [], loadSamples: [], notes: [] };
  const plan = { schema: "ilv2-mac11-run-plan/v1", quick: QUICK, phases: [...PHASES], input: { name: record.name, head: record.head, manifestSha256: record.manifestSha256 },
    limits: LIMITS, pollMs: POLL_MS, stopMs: STOP_MS, requestDeadlines: { status: STATUS_DEADLINE_MS, query: QUERY_DEADLINE_MS }, worktrees: [], seedPlan, editRounds, supplement: supplementIdentity, idleWaits: [],
    deltaClosureLimit: (await import("../dist/index-builder/build-scheduler.js")).DELTA_CLOSURE_LIMIT, gcCycleMs: GC_CYCLE_MS,
    disclosed: ["seed samples are APFS-cloned plain directories of the main copy patched to first-parent commits (no .git), not git worktrees",
      "the six worktrees are real `git worktree add` checkouts in the run copy", "only lishu-v2 is in scope for MAC-11 (the other repos are G08C/G14)"] };
  const waitForIdle = async label => {
    if (!supplement) return;
    const startedAt = Date.now();
    const sample = await until(() => { const current = hostLoad(); return idleWindow(current, current) ? current : false; }, 600_000, 1000);
    plan.idleWaits.push({ label, startedAt, endedAt: Date.now(), load: sample });
  };
  let main, mainRepo;
  const owner = await startRecoveryOwner(t, "mac11", { gcCycleMs: GC_CYCLE_MS,
    env: { JAVA_LSP_OWNER_TELEMETRY: telemetryFile, ILV2_NATIVE_TEST_HOOKS: "1" },
    repos: async dir => {
      mainRepo = path.join(dir, "lishu-v2");
      await execute("/bin/cp", ["-c", "-R", record.repoRoot, mainRepo]);
      await waitForIdle("input-copy-complete");
      return [mainRepo];
    } });
  let http, statusClient, ownerPid;
  try {
    // The job starts at load; its HTTP endpoint is served only once this incarnation is ready.
    ownerPid = (await owner.incarnation()).pid;
    http = await owner.http();
    statusClient = await owner.http();
  } catch (error) { await closeRecoveryOwner(owner).catch(() => {}); throw error; }
  let requestSeq = 0;
  let phase = "setup";
  let window = "normal";
  let windowVersion = 0;
  const setWindow = value => { window = value; windowVersion++; };
  const workspaces = new Map();

  const load = () => ({ at: Date.now(), ...hostLoad() });
  const loadTimer = setInterval(() => state.loadSamples.push(load()), 5000);
  loadTimer.unref();
  const begin = name => { phase = name; state.phases.push({ name, startedAt: Date.now(), load: load() }); state.loads[name] = { start: load() }; };
  const end = name => { state.loads[name].end = load(); state.phases.find(row => row.name === name).endedAt = Date.now(); };

  async function tool(client, ws, name, args, extra = {}) {
    const requestId = ++requestSeq;
    const startedAt = Date.now(), started = performance.now();
    const row = { requestId, phase, window, windowVersion, ownerPid, workspace: ws?.name, workspaceId: ws?.workspaceId,
      startedAt, loadStart: load(), status: "pending" };
    if (extra.statusSample) state.statusSamples.push(row);
    let text = "", value, error;
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
      text = result.content?.[0]?.text ?? "";
      if (result.isError) error = text; else value = JSON.parse(text);
    } catch (caught) { error = caught.message; }
    const completedMono = performance.now(), endedAt = Date.now(), loadEnd = load();
    const elapsedMs = completedMono - started;
    Object.assign(row, { phaseEnd: phase, windowEnd: window, endWindowVersion: windowVersion, endedAt, loadEnd, tool: name, query: args.query, token: extra.token, deadlineMs: name === "java_status" ? STATUS_DEADLINE_MS : QUERY_DEADLINE_MS,
      startedAt, elapsedMs, status: error ? "error" : "ok", ...(error ? { error: String(error).slice(0, 400) } : {}), payloadBytes: Buffer.byteLength(text),
      exact: value?.exact, scopeState: value?.scopeState, stopReason: value?.stopReason, reasons: value?.reasons, droppedStale: value?.droppedStale, repoHash: value?.repoHash, generation: value?.generation,
      indexView: value?.indexView, candidates: (value?.candidates ?? []).map(candidate => ({ name: candidate.declaration?.name, fqn: candidate.declaration?.fqn, matchedBy: candidate.matchedBy,
        declaration: candidate.declaration && { relativePath: candidate.declaration.relativePath, contentHash: candidate.declaration.contentHash },
        evidence: candidate.evidenceRange && { relativePath: candidate.evidenceRange.relativePath, contentHash: candidate.evidenceRange.contentHash } })).concat(
        // operation=evidence: the anchor (the Java declaration) and each served XML unit are audited like a candidate's refs.
        (value?.units ?? []).map(unit => ({ declaration: value.anchor && { relativePath: value.anchor.relativePath, contentHash: value.anchor.contentHash },
          evidence: { relativePath: unit.path, contentHash: unit.contentHash } }))) });
    state.calls.push(row);
    await appendFile(callsFile, `${JSON.stringify(row)}\n`);
    return { row, value, completedMono };
  }
  const status = (ws, client = http) => tool(client, ws, "java_status", { repoRoot: ws.root });

  function remember(ws, relativePath, bytes, tokens = []) {
    const files = (state.versions[ws.name] ??= {});
    const version = ((files[relativePath] ??= {})[sha256(bytes)] ??= { tokens: [] });
    for (const token of tokens) if (!version.tokens.includes(token)) version.tokens.push(token);
  }
  async function write(ws, relativePath, text, tokens = []) {
    const file = path.join(ws.root, relativePath);
    const before = await readFile(file).catch(() => undefined);
    if (before && !state.versions[ws.name]?.[relativePath]) remember(ws, relativePath, before);
    await mkdir(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(text);
    remember(ws, relativePath, bytes, tokens);
    await writeFile(file, bytes);
    return sha256(bytes);
  }
  async function register(name, root, extra = {}) {
    const canonical = await realpath(root);
    const ws = { name, root: canonical, workspaceId: workspaceIdFor(await rootIdentityOf(canonical)), ...extra };
    workspaces.set(name, ws);
    return ws;
  }

  /** A Java oracle: the token's method in `relativePath` with exactly these bytes (hash), from this workspace. */
  const javaOracle = (ws, shape, relativePath, token, hash) => ({ token, args: { repoRoot: ws.root, operation: "query", query: `${shape.fqn}#${token}`, searchMode: "exact", preview: "none" },
    correct: value => value?.exact === "match" && value.candidates.some(candidate => candidate.declaration?.name === token && candidate.declaration.relativePath === relativePath
      && candidate.declaration.contentHash === hash) && (!ws.repoHash || value.repoHash === ws.repoHash) });
  const javaMiss = (ws, shape, token) => ({ token, args: { repoRoot: ws.root, operation: "query", query: `${shape.fqn}#${token}`, searchMode: "exact", preview: "none" },
    correct: value => value?.exact === "miss" && value.scopeState === "READY" });
  /** A MyBatis oracle: the evidence unit linked to the mapper method `id` is this XML statement, with this XML's path and hash
   *  (operation=evidence re-hashes the anchor and every unit against the published index; a text query ranks the statement
   *  document below identifier hits on a real repository and only fills evidenceRange with a preview). */
  const xmlOracle = (ws, mapper, id, hash) => ({ token: id, args: { repoRoot: ws.root, operation: "evidence", file: mapper.java, line: 4 + mapper.ids.indexOf(id), column: 7 },
    correct: value => value?.scopeState === "READY" && value.anchor?.relativePath === mapper.java
      && Boolean(value.units?.some(unit => unit.path === mapper.xml && unit.contentHash === hash && unit.text.includes(`id="${id}"`))) });

  /** Bounded polling (one request every POLL_MS, each bounded by its own deadline) until the oracle holds or the stop time. */
  async function firstCorrect(ws, oracle, { from = performance.now(), stopMs = STOP_MS, pollMs = POLL_MS, client = () => http } = {}) {
    for (;;) {
      const { row, value, completedMono } = await tool(client(), ws, "java_symbol", oracle.args, { token: oracle.token });
      const response = { endedAt: row.endedAt, loadEnd: row.loadEnd, phaseEnd: row.phaseEnd, windowEnd: row.windowEnd, endWindowVersion: row.endWindowVersion };
      if (oracle.correct(value)) { row.firstCorrect = true; state.loadSamples.push(row.loadEnd); return { ...response, ms: completedMono - from, requestId: row.requestId }; }
      if (performance.now() - from > stopMs) return { ...response, ms: Infinity, censored: true, last: { exact: value?.exact, scopeState: value?.scopeState, error: row.error } };
      await delay(pollMs);
    }
  }
  async function negative(ws, oracle, label) {
    const { row, value, ok, attempts, timedOut } = await settleNegative(() => tool(http, ws, "java_symbol", oracle.args, { token: oracle.token }),
      { timeoutMs: STOP_MS, pause: delay });
    state.negatives.push({ label, workspace: ws.name, token: oracle.token, ok, attempts, timedOut, requestId: row.requestId, exact: value?.exact, scopeState: value?.scopeState });
    return ok;
  }
  /** The round that settled this workspace after `sinceEpoch` (its first publish/noop/failure). */
  const roundOf = (ws, sinceEpoch, predicate = () => true, timeoutMs = 30000) =>
    telemetry.waitFor(row => row.type === "round" && row.workspaceId === ws.workspaceId && row.at >= sinceEpoch && predicate(row), timeoutMs);
  // The runtime manager retires a workspace idle past its TTL; status(start=false) never starts one (contract §2.6), so a
  // retired workspace is reopened by a static query, as an agent's next request would.
  const reopen = ws => tool(http, ws, "java_symbol", { repoRoot: ws.root, operation: "query", query: "ilv2mac11reopen", searchMode: "exact", preview: "none" }, { token: "ilv2mac11reopen" });
  const fresh = (ws, timeoutMs = FULL_STOP_MS) => {
    let reopenedAt = -Infinity;
    return until(async () => {
      const { value } = await status(ws);
      if (value?.repoHash) ws.repoHash = value.repoHash;
      if (value?.indexView?.state === "NOT_READY" && ws.registered && performance.now() - reopenedAt > 30_000) { reopenedAt = performance.now(); await reopen(ws); }
      return value?.indexView?.state === "FRESH" ? value : false;
    }, timeoutMs);
  };

  const statusLoop = { stop: false };
  const statusSampler = (async () => {
    while (!statusLoop.stop) {
      const targets = [...workspaces.values()].filter(ws => ws.registered);
      if (targets.length && window === "normal") {
        const ws = targets[Math.floor(Math.random() * targets.length)];
        await tool(statusClient, ws, "java_status", { repoRoot: ws.root }, { statusSample: true });
      }
      await delay(400);
    }
  })();

  let failure;
  try {
    // ------------------------------------------------ P1: main cold full (no base: end-to-end, never a seed sample)
    main = await register("main", mainRepo);
    const mainFiles = (await git(main.root, ["ls-files", "-z", "--", "*.java"])).split("\0").filter(Boolean).sort();
    const touched = new Set();
    for (const [, depth] of WORKTREES.filter(([name]) => name !== "w6")) for (const row of await diffRows(main.root, `HEAD~${depth}`)) touched.add(row.path);
    const stable = [];
    for (const file of mainFiles) {
      if (stable.length >= 2) break;
      if (touched.has(file) || !/\/src\/main\/java\//.test(file)) continue;
      const text = await readFile(path.join(main.root, file), "utf8");
      const shape = javaShape(file, text);
      if (shape && text.length < 20000) stable.push({ relativePath: file, shape, text });
    }
    assert.equal(stable.length, 2, "two stable class files outside every small worktree's difference");
    const [R, R2] = stable;
    plan.oracleFiles = stable.map(row => ({ relativePath: row.relativePath, fqn: row.shape.fqn, sha256: sha256(Buffer.from(row.text)) }));
    const classOracle = ws => ({ token: R.shape.name, args: { repoRoot: ws.root, operation: "query", query: R.shape.fqn, searchMode: "exact", preview: "none" },
      correct: value => value?.exact === "match" && value.candidates.some(candidate => candidate.declaration?.relativePath === R.relativePath
        && candidate.declaration.contentHash === sha256(Buffer.from(R.text))) });
    remember(main, R.relativePath, Buffer.from(R.text));

    const fullOf = async (ws, sinceEpoch, label, oracle) => {
      const sampleNow = () => fullSample({ rows: telemetry.rows, calls: state.calls, loads: state.loadSamples,
        workspaceId: ws.workspaceId, workspace: ws.name, sinceEpoch });
      // A successful builder close may be rejected at publication. Wait for a separately matched published attempt.
      // This is an aggregate observation, evaluated once per poll, not once per
      // recorded row as Telemetry.waitFor's row predicate would be.
      await until(async () => { await telemetry.poll(); return sampleNow().snapshotId; }, FULL_STOP_MS, 100);
      let sample = sampleNow();
      if (!Number.isFinite(sample.ms) && sample.snapshotId && oracle) {
        const published = { snapshotId: sample.snapshotId, bindingVersion: sample.bindingVersion };
        await firstCorrect(ws, { ...oracle, correct: value => oracle.correct(value)
          && value.indexView?.snapshotId === published.snapshotId && value.indexView?.bindingVersion >= published.bindingVersion },
        { stopMs: FULL_STOP_MS, pollMs: 1000 });
        await telemetry.poll();
        sample = sampleNow();
      }
      const row = { label, workspace: ws.name, ...sample };
      state.fulls.push(row);
      return row;
    };

    await waitForIdle("main-full");
    begin("main");
    state.loadSamples.push(load());
    const free0 = await freeBytes(main.root);
    const mainStart = Date.now();
    main.registered = true;
    const mainFirst = await firstCorrect(main, classOracle(main), { stopMs: FULL_STOP_MS, pollMs: 1000 });
    await fresh(main);
    const mainFull = await fullOf(main, mainStart, "main-HEAD");
    const free1 = await freeBytes(main.root);
    const mainBinding = (await owner.bindings())[main.root];
    const mainDb = path.join(owner.mac1, "snapshots", mainBinding.snapshotId, "index.sqlite");
    const mainPages = (await pageDiff(mainDb, mainDb)).pagesAfter;
    state.main = { firstCorrectNoBaseMs: mainFirst.ms, full: mainFull, volumeGrowthBytes: free0 - free1, snapshotId: mainBinding.snapshotId, dbBytes: (await stat(mainDb)).size, pages: mainPages };
    const baseAvailableAt = Date.now();
    end("main");
    assert.ok(Number.isFinite(mainFirst.ms), "main reached its first correct query");

    // ------------------------------------------------ P2: seed samples (base available: main is the only same-key sibling at first)
    const samplesDir = path.join(owner.input, "samples");
    await mkdir(samplesDir);
    const cloneMain = async target => {
      await mkdir(target);
      for (const entry of await readdir(main.root)) if (entry !== ".git") await execute("/bin/cp", ["-c", "-R", path.join(main.root, entry), path.join(target, entry)]);
    };
    let sampleSeq = 0;
    async function seedSample({ commit, rows, label, files, stopMs = STOP_MS }) {
      const n = ++sampleSeq;
      const dir = path.join(samplesDir, `s${pad(n)}`);
      await cloneMain(dir);
      const ws = await register(`s${pad(n)}`, dir);
      const contents = rows.length ? await historyTierState(main.root, { commit, rows }) : new Map();
      let target;
      for (const row of rows) {
        const bytes = contents.get(row.path);
        const file = path.join(ws.root, row.path);
        if (bytes === null) { await rm(file, { force: true }); continue; }
        let text = bytes.toString("utf8");
        if (row.path.endsWith(".java")) {
          text += `\n// ilv2-mac11 sample ${n}\n`;
          const shape = !target && /\/src\/main\/java\//.test(row.path) ? javaShape(row.path, text) : undefined;
          if (shape) { target = { relativePath: row.path, shape, token: `ilv2Mac11S${pad(n)}` }; text = withMethod(text, target.token); }
        } else if (row.path.endsWith(".xml")) text += `\n<!-- ilv2-mac11 sample ${n} -->\n`;
        await write(ws, row.path, text, target?.relativePath === row.path ? [target.token] : []);
      }
      const oracle = target ? javaOracle(ws, target.shape, target.relativePath, target.token, sha256(await readFile(path.join(ws.root, target.relativePath))))
        : classOracle(ws);
      await waitForIdle(`seed-${n}-before-noise`);
      const snapshotsBefore = (await owner.storeObjects()).snapshots;
      const noiseStart = await freeBytes(ws.root);
      await delay(NOISE_MS);
      const noiseEnd = await freeBytes(ws.root);
      const before = load();
      const samplePhase = phase, sampleWindow = window, sampleWindowVersion = windowVersion;
      const startEpoch = Date.now();
      const started = performance.now();
      ws.registered = true;
      const first = await firstCorrect(ws, oracle, { from: started, stopMs });
      const round = await roundOf(ws, startEpoch, () => true, stopMs);
      await telemetry.poll();
      const jobs = telemetry.rows.filter(row => row.type === "scheduler" && row.event.type === "closed" && row.event.workspaceId === ws.workspaceId);
      await delay(1000);
      const settledFree = await freeBytes(ws.root);
      const elapsed = performance.now() - started + 1000;
      const noise = Math.abs(noiseStart - noiseEnd) / NOISE_MS * elapsed;
      const grown = noiseEnd - settledFree;
      const binding = (await owner.bindings())[ws.root];
      const sample = { id: ws.name, label, commit, files, phase: samplePhase, ownerPid, workspaceId: ws.workspaceId, startAt: startEpoch, endedAt: first.endedAt,
        windowEnd: first.windowEnd, windowVersion: sampleWindowVersion, endWindowVersion: first.endWindowVersion, tier: round ? seedTier((round.changed ?? 0) + (round.deleted ?? 0)) : "unknown", window: sampleWindow,
        firstCorrectMs: first.ms, firstCorrect: Number.isFinite(first.ms) ? first.requestId : undefined, censored: first.censored ? first.last : undefined,
        waitBaseMs: Math.max(0, baseAvailableAt - startEpoch), kind: round?.kind, changed: round?.changed, deleted: round?.deleted, seedFrom: round?.seedFrom,
        roundMs: round?.elapsedMs, timings: round?.timings, outcome: round?.outcome, jobs: jobs.length, snapshotId: binding?.snapshotId, loadStart: before, loadEnd: first.loadEnd };
      state.seeds.push(sample);
      if (files !== undefined) {
        const snapshotsAfter = (await owner.storeObjects()).snapshots;
        let pageRatio;
        if (binding && round?.seedFrom && binding.snapshotId !== round.seedFrom) {
          const pages = await pageDiff(path.join(owner.mac1, "snapshots", round.seedFrom, "index.sqlite"), path.join(owner.mac1, "snapshots", binding.snapshotId, "index.sqlite"));
          pageRatio = pages.changed / mainPages;
        }
        const fullGrowth = state.main.volumeGrowthBytes;
        state.physical.push({ id: ws.name, files, firstCorrect: sample.firstCorrect, firstCorrectMs: sample.firstCorrectMs, censored: sample.censored,
          startAt: sample.startAt, endedAt: sample.endedAt, loadStart: sample.loadStart, loadEnd: sample.loadEnd, outcome: sample.outcome, kind: round?.kind, jobs: jobs.length, newSnapshots: snapshotsAfter.filter(id => !snapshotsBefore.includes(id)).length,
          volumeGrowthBytes: grown, noiseBytes: noise, volumeRatio: fullGrowth > 0 ? grown / fullGrowth : undefined,
          volumeValid: files === 0 ? true : fullGrowth > 0 && noise < LIMITS.physicalRatio[files] * fullGrowth, pageRatio, fullGrowthBytes: fullGrowth });
      }
      // The sample's token is not visible from main (cross-workspace negative).
      if (target) await negative(main, javaMiss(main, target.shape, target.token), `sample-${n}-not-in-main`);
      return sample;
    }
    if (PHASES.has("seed")) {
      begin("seed");
      for (let index = 0; index < seedPlan.zero; index += 1) await seedSample({ commit: "HEAD", rows: [], label: "zero", files: 0 });
      for (const [depth, count] of seedPlan.k) {
        const commit = (await git(main.root, ["rev-parse", `HEAD~${depth}`])).trim();
        const rows = await diffRows(main.root, commit);
        for (let index = 0; index < count; index += 1) {
          const javaRows = rows.filter(row => row.path.endsWith(".java"));
          await seedSample({ commit, rows, label: `HEAD~${depth}`, files: depth === 4 && javaRows.length === 20 && rows.length === 20 ? 20 : undefined });
        }
      }
      const commit50 = (await git(main.root, ["rev-parse", "HEAD~50"])).trim();
      const exact = (await diffRows(main.root, commit50)).filter(row => row.path.endsWith(".java")).sort((a, b) => a.path.localeCompare(b.path)).slice(0, 200);
      assert.equal(exact.length, 200, "HEAD~50 has 200 Java differences");
      for (let index = 0; index < seedPlan.exact200; index += 1) await seedSample({ commit: commit50, rows: exact, label: "HEAD~50/200-java", files: 200 });
      // Near the delta closure limit itself: deltaMaxTouched is judged on measured deltas whose dependency closure (changed +
      // name dependents, not the changed count) approaches it; a set past it escalates and records that closure instead.
      const commit100 = (await git(main.root, ["rev-parse", "HEAD~100"])).trim();
      const java100 = (await diffRows(main.root, commit100)).filter(row => row.path.endsWith(".java")).sort((a, b) => a.path.localeCompare(b.path));
      for (const size of seedPlan.atLimit) {
        assert.ok(java100.length >= size, `HEAD~100 has ${size} Java differences`);
        // A set whose closure passes the limit escalates to a full, so it is given a full's stop.
        await seedSample({ commit: commit100, rows: java100.slice(0, size), label: `HEAD~100/${size}-java`, stopMs: FULL_STOP_MS });
      }
      end("seed");
    }

    // ------------------------------------------------ P3: six worktrees registered concurrently (five small deltas + one large full)
    const wt = {};
    if (PHASES.has("worktrees")) {
      begin("worktrees");
      const wtDir = path.join(owner.input, "wt");
      await mkdir(wtDir);
      const registrations = [];
      for (const [name, depth] of WORKTREES) {
        const commit = (await git(main.root, ["rev-parse", `HEAD~${depth}`])).trim();
        const dir = path.join(wtDir, name);
        await git(main.root, ["worktree", "add", "--detach", "-q", dir, commit]);
        const rows = await diffRows(main.root, commit);
        const ws = await register(name, dir, { commit, depth });
        wt[name] = ws;
        const diff = { java: rows.filter(row => row.path.endsWith(".java")).length, xml: rows.filter(row => row.path.endsWith(".xml")).length,
          build: rows.filter(row => !/\.(java|xml)$/.test(row.path)).length };
        let target;
        for (const row of rows.filter(item => item.path.endsWith(".java") && !item.absent && /\/src\/main\/java\//.test(item.path))) {
          const text = await readFile(path.join(ws.root, row.path), "utf8").catch(() => undefined);
          const shape = text && javaShape(row.path, text);
          if (shape) { target = { relativePath: row.path, shape, token: `ilv2Mac11W${name.slice(1)}`, text }; break; }
        }
        if (!target) target = { relativePath: R.relativePath, shape: R.shape, token: `ilv2Mac11W${name.slice(1)}`, text: await readFile(path.join(ws.root, R.relativePath), "utf8") };
        const hash = await write(ws, target.relativePath, withMethod(target.text, target.token), [target.token]);
        ws.unique = { ...target, hash };
        plan.worktrees.push({ name, depth, commit, diff, expectedBuildKind: diff.build > 0 || diff.java + diff.xml > plan.deltaClosureLimit ? "full" : "seed-delta",
          unique: { relativePath: target.relativePath, token: target.token, sha256: hash } });
      }
      await waitForIdle("worktree-registration");
      const startEpoch = Date.now();
      state.loadSamples.push(load());
      await Promise.all(Object.values(wt).map(async ws => {
        ws.registered = true;
        const started = performance.now();
        // Six registrations seal concurrently (five ~full-size seed publishes at once): the stop bounds "correct at all", the
        // measured first-correct time is what the seed thresholds judge.
        const first = await firstCorrect(ws, javaOracle(ws, ws.unique.shape, ws.unique.relativePath, ws.unique.token, ws.unique.hash),
          { from: started, stopMs: FULL_STOP_MS, pollMs: ws.name === "w6" ? 1000 : POLL_MS });
        const round = await roundOf(ws, startEpoch, () => true, FULL_STOP_MS);
        ws.registration = { firstCorrectMs: first.ms, kind: round?.kind, changed: round?.changed, deleted: round?.deleted, seedFrom: round?.seedFrom, timings: round?.timings };
        if (ws.name !== "w6") state.seeds.push({ id: ws.name, label: `worktree HEAD~${ws.depth}`, tier: round ? seedTier((round.changed ?? 0) + (round.deleted ?? 0)) : "unknown",
          phase: "worktrees", window: "normal", ownerPid, workspaceId: ws.workspaceId, firstCorrectMs: first.ms, firstCorrect: Number.isFinite(first.ms) ? first.requestId : undefined, kind: round?.kind, changed: round?.changed,
          deleted: round?.deleted, seedFrom: round?.seedFrom, roundMs: round?.elapsedMs, timings: round?.timings, concurrentWithFull: true });
        else state.w6Registration = { firstCorrectMs: first.ms, firstCorrect: Number.isFinite(first.ms) ? first.requestId : undefined };
      }));
      if (state.w6Registration) await fullOf(wt.w6, startEpoch, "w6-HEAD~100");
      for (const ws of Object.values(wt)) await fresh(ws);
      for (const ws of Object.values(wt)) {
        for (const other of Object.values(wt).filter(item => item !== ws))
          await negative(other, javaMiss(other, ws.unique.shape, ws.unique.token), `${ws.name}-token-not-in-${other.name}`);
        await negative(main, javaMiss(main, ws.unique.shape, ws.unique.token), `${ws.name}-token-not-in-main`);
      }
      assert.equal(wt.w6.registration.kind, "full", "the large branch entered a full");
      end("worktrees");
    }

    // ------------------------------------------------ P4: continuous edits (Java in five worktrees, MyBatis XML in two)
    const javaBase = {};
    const mappers = {};
    let editSeq = 0;
    async function editRound(ws, kind, apply, oracleFor, label) {
      const id = ++editSeq;
      await waitForIdle(`edit-${id}`);
      const before = load();
      const editEpoch = Date.now();
      const editPhase = phase, editWindow = window, editWindowVersion = windowVersion, editOwnerPid = ownerPid;
      state.loadSamples.push(before);
      const tEdit = performance.now();
      const result = await apply();
      const first = await firstCorrect(ws, oracleFor(result), { from: tEdit });
      const round = await roundOf(ws, editEpoch, row => row.outcome === "published", STOP_MS);
      const row = { id, workspace: ws.name, workspaceId: ws.workspaceId, ownerPid: editOwnerPid, phase: editPhase, kind, label, window: editWindow,
        startAt: editEpoch, endedAt: first.endedAt, windowEnd: first.windowEnd, windowVersion: editWindowVersion, endWindowVersion: first.endWindowVersion, firstCorrectMs: first.ms, firstCorrect: Number.isFinite(first.ms) ? first.requestId : undefined,
        censored: first.censored ? first.last : undefined, publishMs: round?.boundAt ? round.boundAt - editEpoch : undefined, roundKind: round?.kind, changed: round?.changed,
        timings: round?.timings, roundMs: round?.elapsedMs, loadStart: before, loadEnd: first.loadEnd };
      state.edits.push(row);
      return { row, result };
    }
    const javaEdit = (ws, token, base = javaBase[ws.name]) => editRound(ws, "java", async () => ({ hash: await write(ws, base.relativePath, withMethod(base.text, token), [token]) }),
      ({ hash }) => javaOracle(ws, base.shape, base.relativePath, token, hash), token);
    const mapperXml = (mapper, id) => `<?xml version="1.0" encoding="UTF-8"?>\n<mapper namespace="${mapper.type}">\n  <select id="${id}" resultType="int">select 1</select>\n</mapper>\n`;
    if (PHASES.has("edits")) {
      begin("edits");
      for (const ws of ["w1", "w2", "w3", "w4", "w5"].map(name => wt[name])) javaBase[ws.name] = { ...R, text: await readFile(path.join(ws.root, R.relativePath), "utf8") };
      // The mapper pair: same relative paths in w1 and w2, different statements (§5.2 同相对路径不同 Java/XML 内容).
      const resources = (await git(main.root, ["ls-files", "-z", "--", "*/src/main/resources/*"])).split("\0").filter(Boolean).sort()[0];
      const moduleRoot = resources.slice(0, resources.indexOf("/src/main/resources/"));
      for (const ws of [wt.w1, wt.w2]) {
        const tag = ws.name.toUpperCase();
        // Statement ids avoid secret-named words ("Token" etc.): preview redaction withholds such a line as SOURCE_SENSITIVE.
        const mapper = { type: "ilv2mac11.Mac11Mapper", java: `${moduleRoot}/src/main/java/ilv2mac11/Mac11Mapper.java`, xml: `${moduleRoot}/src/main/resources/ilv2mac11/Mac11Mapper.xml`,
          ids: Array.from({ length: editRounds.xml + 1 }, (_, index) => `mac11${tag}Stmt${pad(index)}`) };
        mappers[ws.name] = mapper;
        mapper.round = 0;
        await write(ws, mapper.java, `package ilv2mac11;\n\npublic interface Mac11Mapper {\n${mapper.ids.map(id => `  int ${id}();\n`).join("")}}\n`, mapper.ids);
        const hash = await write(ws, mapper.xml, mapperXml(mapper, mapper.ids[0]), [mapper.ids[0]]);
        mapper.setup = await firstCorrect(ws, xmlOracle(ws, mapper, mapper.ids[0], hash), { stopMs: STOP_MS });
        plan.mapper = { moduleRootSha256: sha256(Buffer.from(moduleRoot)), java: "…/src/main/java/ilv2mac11/Mac11Mapper.java", xml: "…/src/main/resources/ilv2mac11/Mac11Mapper.xml" };
      }
      const order = ["w1", "w2", "w3", "w4", "w5"];
      let javaRounds = 0, xmlRounds = 0;
      while (javaRounds < editRounds.java || xmlRounds < editRounds.xml) {
        if (javaRounds < editRounds.java) {
          const ws = wt[order[javaRounds % order.length]];
          const token = `ilv2Mac11E${pad(++javaRounds)}`;
          const previous = ws.lastJava;
          await javaEdit(ws, token);
          ws.lastJava = token;
          if (previous) await negative(ws, javaMiss(ws, R.shape, previous), `${ws.name}-replaced-${previous}`);
          for (const other of order.map(name => wt[name]).filter(item => item !== ws).slice(0, 1)) await negative(other, javaMiss(other, R.shape, token), `${token}-not-in-${other.name}`);
        }
        if (xmlRounds < editRounds.xml && (javaRounds % 2 === 0 || javaRounds >= editRounds.java)) {
          const ws = xmlRounds % 2 === 0 ? wt.w1 : wt.w2;
          const mapper = mappers[ws.name];
          const index = ++mapper.round;
          xmlRounds += 1;
          const id = mapper.ids[index];
          await editRound(ws, "xml", async () => ({ hash: await write(ws, mapper.xml, mapperXml(mapper, id), [id]) }), ({ hash }) => xmlOracle(ws, mapper, id, hash), id);
        }
      }
      end("edits");
    }

    // ------------------------------------------------ P5: faults (bad syntax, same stat, touch, edit-revert, drop)
    if (PHASES.has("faults")) {
      begin("faults");
      const w3 = wt.w3, w4 = wt.w4;
      for (const ws of [w3, w4]) await fresh(ws, 300000);
      const r2 = { ...R2, text: await readFile(path.join(w3.root, R2.relativePath), "utf8") };
      // Bad syntax in R while R2 gets a valid edit: the valid edit is served; a negative stays PARTIAL; the fix restores READY.
      {
        const broken = "ilv2Mac11Broken1", valid = "ilv2Mac11Valid1";
        const badSince = Date.now();
        const tEdit = performance.now();
        // No top-level type survives: the file's parse state is FAILED, not RECOVERED.
        await write(w3, R.relativePath, `package ${R.shape.pkg};\n\n<<< ilv2-mac11 ${broken} >>>\n`, []);
        const hash = await write(w3, R2.relativePath, withMethod(r2.text, valid), [valid]);
        const servedValid = await firstCorrect(w3, javaOracle(w3, R2.shape, R2.relativePath, valid, hash), { from: tEdit });
        const { value: partial } = await tool(http, w3, "java_symbol", javaMiss(w3, R.shape, "ilv2Mac11Absent").args);
        const badRound = await roundOf(w3, badSince, row => row.outcome === "published", STOP_MS);
        // Coverage must still be partial once all pending bad-syntax edits have been published.
        await fresh(w3, STOP_MS);
        const { value: publishedPartial } = await tool(http, w3, "java_symbol", javaMiss(w3, R.shape, "ilv2Mac11Absent").args);
        const fixed = "ilv2Mac11Fixed1";
        const fixedHash = await write(w3, R.relativePath, withMethod(javaBase.w3.text, fixed), [fixed]);
        const restored = await firstCorrect(w3, javaOracle(w3, R.shape, R.relativePath, fixed, fixedHash));
        const ready = await negative(w3, javaMiss(w3, R.shape, "ilv2Mac11Absent"), "bad-syntax-fixed-ready-miss");
        state.faults.push({ name: "bad-syntax", ok: Number.isFinite(servedValid.ms) && badSyntaxNegative(partial) && Boolean(badRound) && badSyntaxNegative(publishedPartial) && Number.isFinite(restored.ms) && ready,
          validMs: servedValid.ms, publishedPartial: { exact: publishedPartial?.exact, scopeState: publishedPartial?.scopeState, stopReason: publishedPartial?.stopReason }, partial: { exact: partial?.exact, scopeState: partial?.scopeState, stopReason: partial?.stopReason }, restoredMs: restored.ms });
        w3.lastJava = fixed;
      }
      // Same size and whole-second mtime: only the real event reveals the change.
      {
        const file = path.join(w4.root, R.relativePath);
        const second = Math.floor(Date.now() / 1000) - 120;
        const a = "ilv2Mac11Same0001", b = "ilv2Mac11Same0002";
        const hashA = await write(w4, R.relativePath, withMethod(javaBase.w4.text, a), [a]);
        await utimes(file, second, second);
        const seenA = await firstCorrect(w4, javaOracle(w4, R.shape, R.relativePath, a, hashA));
        const before = await stat(file);
        const tEdit = performance.now();
        const hashB = await write(w4, R.relativePath, withMethod(javaBase.w4.text, b), [b]);
        await utimes(file, second, second);
        const after = await stat(file);
        const seenB = await firstCorrect(w4, javaOracle(w4, R.shape, R.relativePath, b, hashB), { from: tEdit });
        state.faults.push({ name: "same-stat", ok: Number.isFinite(seenA.ms) && Number.isFinite(seenB.ms) && before.size === after.size && before.mtimeMs === after.mtimeMs,
          sameSize: before.size === after.size, sameMtime: before.mtimeMs === after.mtimeMs, ms: seenB.ms });
        w4.lastJava = b;
        // Touch: a real event, no content change: a noop round, the binding keeps its snapshot.
        await fresh(w4, 120000);
        const bound = (await owner.bindings())[w4.root].snapshotId;
        const touchEpoch = Date.now();
        await utimes(file, new Date(), new Date(Date.now() + 3000));
        const round = await roundOf(w4, touchEpoch, () => true, 30000);
        await fresh(w4, 30000);
        const still = (await owner.bindings())[w4.root].snapshotId;
        const served = await firstCorrect(w4, javaOracle(w4, R.shape, R.relativePath, b, hashB));
        state.faults.push({ name: "touch", ok: round?.outcome === "noop" && still === bound && Number.isFinite(served.ms), round: round && { kind: round.kind, outcome: round.outcome, mode: round.mode }, snapshotKept: still === bound });
      }
      // Edit then revert before it settles: the final state is the reverted content.
      {
        const file = R.relativePath;
        const revertTo = await readFile(path.join(w3.root, file), "utf8");
        const transient = "ilv2Mac11Revert1";
        await write(w3, file, withMethod(javaBase.w3.text, transient), [transient]);
        await delay(20);
        const hash = await write(w3, file, revertTo, [w3.lastJava]);
        const back = await firstCorrect(w3, javaOracle(w3, R.shape, file, w3.lastJava, hash));
        const gone = await until(async () => (await tool(http, w3, "java_symbol", javaMiss(w3, R.shape, transient).args)).value?.exact === "miss", 30000, POLL_MS).catch(() => false);
        state.faults.push({ name: "edit-revert", ok: Number.isFinite(back.ms) && gone === true, ms: back.ms });
      }
      // A dropped-events signal from w4's native helper (its SIGUSR2 test hook): a full hash in the same stream, then FRESH.
      {
        const daemon = (await owner.readyRows()).at(-1).pid;
        const helper = childPids(daemon).find(pid => command(pid).includes(` watch `) && command(pid).endsWith(w4.root));
        const dropEpoch = Date.now();
        if (helper) process.kill(helper, "SIGUSR2");
        const round = helper && await roundOf(w4, dropEpoch, row => row.mode === "full-hash", 60000);
        await fresh(w4, 60000);
        const served = await firstCorrect(w4, javaOracle(w4, R.shape, R.relativePath, w4.lastJava, sha256(await readFile(path.join(w4.root, R.relativePath)))));
        state.faults.push({ name: "event-drop", ok: Boolean(helper && round && round.outcome !== "failed") && Number.isFinite(served.ms), helperFound: Boolean(helper),
          round: round && { mode: round.mode, outcome: round.outcome, hashed: round.hashed, kind: round.kind }, signal: "NATIVE_TEST_HOOK (synthetic UserDropped; macOS dropped nothing)" });
      }
      end("faults");
    }

    // ------------------------------------------------ P6+P8: two long fulls, a builder SIGKILL, short-delta fairness
    if (PHASES.has("fairness")) {
      begin("fairness");
      const sinceEpoch = Date.now();
      state.loadSamples.push(load());
      const far = {};
      for (const name of ["w5", "w6"]) {
        far[name] = (await git(main.root, ["rev-parse", `HEAD~${FAR[name]}`])).trim();
        await git(wt[name].root, ["checkout", "--detach", "-q", far[name]]);
      }
      // The far worktrees may have been idle past the runtime TTL since P3: the next request reopens them.
      for (const name of ["w5", "w6"]) await reopen(wt[name]);
      plan.far = Object.fromEntries(Object.entries(far).map(([name, commit]) => [name, { depth: FAR[name], commit }]));
      const fullObservations = Promise.all([wt.w5, wt.w6].map(async ws => {
        let captured;
        for (const relativePath of [R.relativePath, ...mainFiles.filter(file => file !== R.relativePath)]) {
          const bytes = await readFile(path.join(ws.root, relativePath)).catch(error => { if (error.code !== "ENOENT") throw error; });
          const shape = bytes && javaShape(relativePath, bytes.toString("utf8"));
          if (shape) { remember(ws, relativePath, bytes); captured = { relativePath, shape, hash: sha256(bytes) }; break; }
        }
        assert.ok(captured, "a captured class exists on the far branch");
        const oracle = { token: captured.shape.name, args: { repoRoot: ws.root, operation: "query", query: captured.shape.fqn, searchMode: "exact", preview: "none" },
          correct: value => value?.exact === "match" && value.candidates.some(candidate => candidate.declaration?.relativePath === captured.relativePath
            && candidate.declaration.contentHash === captured.hash) };
        return fullOf(ws, sinceEpoch, `${ws.name}-HEAD~${FAR[ws.name]}`, oracle);
      }));
      // The first far full still running 20 s after its dispatch gets killed (fault window). A full
      // refused at its start (its round captured a checkout still writing build inputs) exits at once
      // and is no victim: the next dispatched far full is.
      const farFull = (after, skip) => row => row.type === "scheduler" && row.event.type === "dispatched" && row.event.kind === "full" && row.at >= after
        && !skip.has(row.event.pid) && [wt.w5.workspaceId, wt.w6.workspaceId].includes(row.event.workspaceId);
      const passed = new Set();
      let firstFull = await telemetry.waitFor(farFull(sinceEpoch, passed), 600000);
      assert.ok(firstFull, "a far checkout escalated to a full");
      // Short deltas in w1/w2 every 6 s while fulls run (normal window for them).
      const fairnessEdits = (async () => {
        let n = 0;
        const deadline = performance.now() + FULL_STOP_MS;
        while (performance.now() < deadline) {
          await telemetry.poll();
          // A code-zero builder whose publish was refused does not finish either full observation.
          if ([wt.w5, wt.w6].every(ws => state.fulls.some(row => row.label === `${ws.name}-HEAD~${FAR[ws.name]}` && Number.isFinite(row.ms)))) break;
          const ws = n % 2 === 0 ? wt.w1 : wt.w2;
          const token = `ilv2Mac11F${pad(++n)}`;
          const { row } = await javaEdit(ws, token);
          row.label = `fairness-${token}`; row.kind = "java-fairness";
          ws.lastJava = token;
          await delay(6000);
        }
      })();
      let killAt;
      for (;;) {
        await delay(Math.max(0, firstFull.at + 20000 - Date.now()));
        setWindow("fault");
        killAt = Date.now();
        try { process.kill(firstFull.event.pid, "SIGKILL"); break; } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        // Already exited: not a running builder. No fault was injected; wait for the next far full.
        setWindow("normal");
        state.notes.push(`fairness: far full pid ${firstFull.event.pid} exited before the fault window; the next far full is the victim`);
        passed.add(firstFull.event.pid);
        firstFull = await telemetry.waitFor(farFull(sinceEpoch, passed), 600000);
        assert.ok(firstFull, "a far full runs into the fault window");
      }
      const victim = [wt.w5, wt.w6].find(ws => ws.workspaceId === firstFull.event.workspaceId);
      state.injectedPids.push(firstFull.event.pid);
      const killedClose = await telemetry.waitFor(row => row.type === "scheduler" && row.event.type === "closed" && row.event.pid === firstFull.event.pid, 30000);
      const failedRound = await roundOf(victim, killAt, row => row.outcome === "failed", 60000);
      setWindow("normal");
      await fairnessEdits;
      const fulls = await fullObservations;
      for (const ws of [wt.w5, wt.w6]) await fresh(ws);
      state.faults.push({ name: "builder-sigkill", ok: killedClose?.event.signal === "SIGKILL" && Boolean(failedRound) && fulls.every(row => Number.isFinite(row.ms)),
        pid: firstFull.event.pid, workspace: victim.name, close: killedClose?.event, failedRound: failedRound && { error: failedRound.error, kind: failedRound.kind } });
      // Edits after the far checkouts are served from the new trees.
      for (const ws of [wt.w5, wt.w6]) {
        const text = await readFile(path.join(ws.root, R.relativePath), "utf8").catch(() => undefined);
        const shape = text && javaShape(R.relativePath, text);
        if (!shape) { state.notes.push(`${ws.name}: ${R.relativePath} absent after the far checkout; post-full edit uses another file`); continue; }
        javaBase[ws.name] = { relativePath: R.relativePath, shape, text };
        await javaEdit(ws, `ilv2Mac11Far${ws.name.slice(1)}`);
        ws.lastJava = `ilv2Mac11Far${ws.name.slice(1)}`;
      }
      end("fairness");
    }

    // ------------------------------------------------ P7: daemon SIGKILL, restart, correct queries everywhere
    if (PHASES.has("daemon")) {
      begin("daemon");
      setWindow("fault");
      const row = (await owner.readyRows()).at(-1);
      const killedAt = owner.kill(row);
      let exitMs = Infinity;
      try { await eventually(() => !processAlive(-row.pgid), LIMITS.daemonExitMs); exitMs = performance.now() - killedAt; } catch { /* recorded as Infinity */ }
      const next = await owner.incarnation(row.pid);
      ownerPid = next.pid;
      http = await owner.http();
      statusClient = await owner.http();
      setWindow("normal");
      const checks = [];
      for (const ws of [main, ...Object.values(wt)]) {
        if (!ws) continue;
        const relativePath = ws.lastJava && javaBase[ws.name] ? javaBase[ws.name].relativePath : ws.unique?.relativePath ?? R.relativePath;
        const bytes = await readFile(path.join(ws.root, relativePath));
        const shape = ws.lastJava && javaBase[ws.name] ? javaBase[ws.name].shape : ws.unique?.shape;
        const token = ws.lastJava ?? ws.unique?.token;
        const oracle = token ? javaOracle(ws, shape, relativePath, token, sha256(bytes)) : classOracle(ws);
        const first = await firstCorrect(ws, oracle, { from: killedAt, stopMs: 180000 });
        checks.push({ workspace: ws.name, token: oracle.token, ms: first.ms });
      }
      // Serving the old bindings is half of a restart: every worktree's next edit must publish under the new incarnation too
      // (its trackers start fresh against bindings an earlier incarnation committed).
      const edits = [];
      for (const ws of Object.values(wt)) {
        if (!javaBase[ws.name]) continue;
        const token = `ilv2Mac11R${ws.name.slice(1)}`;
        const { row: edit } = await javaEdit(ws, token);
        edit.label = `restart-${token}`; edit.kind = "java-restart";
        ws.lastJava = token;
        edits.push({ workspace: ws.name, token, ms: edit.firstCorrectMs });
      }
      state.restart = { ok: exitMs <= LIMITS.daemonExitMs && checks.every(check => Number.isFinite(check.ms)) && edits.every(check => Number.isFinite(check.ms)),
        exitMs, oldPid: row.pid, newPid: next.pid, checks, edits };
      end("daemon");
    }

    // ------------------------------------------------ lifecycle: leases released, GC converged, sealed snapshots intact
    statusLoop.stop = true;
    await statusSampler;
    await delay(3 * GC_CYCLE_MS);
    const bindings = await owner.bindings();
    const bound = new Set(Object.values(bindings).map(binding => binding.snapshotId));
    const objects = await owner.storeObjects();
    const verified = [];
    for (const snapshotId of bound) verified.push(await owner.verifySnapshot(snapshotId));
    await telemetry.poll();
    const sweeps = telemetry.rows.filter(row => row.type === "sweep");
    const missing = state.calls.filter(call => /missing|ENOENT|no such snapshot/i.test(call.error ?? ""));
    state.lifecycle = { ok: objects.snapshots.every(id => bound.has(id)) && objects.jobs.length === 0 && verified.every(row => row.matches && row.sidecars.length === 0)
      && sweeps.every(row => !row.error) && missing.length === 0,
      snapshots: objects.snapshots.length, bound: bound.size, unbound: objects.snapshots.filter(id => !bound.has(id)), jobs: objects.jobs, verified: verified.filter(row => !row.matches || row.sidecars.length),
      sweeps: sweeps.length, sweepErrors: sweeps.filter(row => row.error).map(row => row.error), reclaimed: telemetry.rows.filter(row => row.type === "reclaimed").length,
      missingSnapshotErrors: missing.map(call => call.requestId) };
  } catch (error) { failure = error; }
  finally {
    statusLoop.stop = true;
    await statusSampler.catch(() => {});
    clearInterval(loadTimer);
    await telemetry.poll().catch(() => {});
    let closeout, closeoutError;
    try { await copyEvidence(owner, "mac11-owner"); closeout = await closeRecoveryOwner(owner); } catch (error) { closeoutError = error; }
    input.after = await verifyFrozenInput(record).catch(error => ({ error: String(error) }));
    const verdict = analyze({ ...state, telemetry: telemetry.rows, quick: QUICK, deltaClosureLimit: plan.deltaClosureLimit });
    verdict.input = input;
    verdict.frozenInputUnchanged = input.after?.head === record.head && !input.after.error;
    if (failure) verdict.status = "FAIL";
    verdict.failure = failure ? String(failure.stack ?? failure) : null;
    verdict.closeout = closeout ?? null;
    verdict.closeoutError = closeoutError ? String(closeoutError) : null;
    await evidence("run-plan", plan);
    await evidence("samples", { main: state.main, seeds: state.seeds, edits: state.edits, physical: state.physical, fulls: state.fulls, faults: state.faults, negatives: state.negatives,
      restart: state.restart, lifecycle: state.lifecycle, w6Registration: state.w6Registration, phases: state.phases, loads: state.loads, notes: state.notes,
      statusSamples: state.statusSamples, injectedPids: state.injectedPids });
    await evidence("versions", state.versions);
    await evidence("load-samples", state.loadSamples);
    if (supplement) {
      const proof = measurementSupplement(verdict, state, { ...supplementIdentity, closeout, closeoutError, failure });
      verdict.status = proof.status === "PASS" ? "DIAGNOSTIC_ONLY" : "FAIL";
      verdict.gateStatus = "NOT_GATED";
      await evidence("measurement-supplement", proof);
      supplementProofWritten = true;
    }
    await evidence("g11-analysis", verdict);
    if (closeoutError) throw closeoutError;
  }
  if (failure) throw failure;
  const verdict = await readJson(path.join(raw, "g11-analysis.json"));
  if (supplement) {
    const proof = await readJson(path.join(raw, "measurement-supplement.json"));
    assert.equal(proof.status, "PASS", `supplement scope contracts: ${JSON.stringify(proof.checks)}`);
    for (const [name, ok] of Object.entries(proof.checks)) assert.equal(ok, true, `supplement contract ${name}`);
  } else {
    for (const [name, item] of Object.entries(verdict.hardGates)) assert.equal(item.verdict, "PASS", `hard gate ${name}: ${JSON.stringify(item).slice(0, 2000)}`);
    if (!QUICK) assert.equal(verdict.measurementComplete, true, `incomplete performance measurements: ${verdict.incompleteMeasurements.join(", ")}`);
    assert.equal(verdict.frozenInputUnchanged, true);
  }
});

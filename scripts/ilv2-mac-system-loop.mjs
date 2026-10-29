// input: one G11 run's calls, owner lifecycle telemetry, edit/seed/physical samples and host load windows.
// output: G11 hard-gate verdicts, the performance items with their actual PASS/FAIL/INVALID_EXPERIMENT,
//         performanceReady, and parse/resolve/graph/SQL/seal/queue profiles.
// pos: MAC-11 system-loop analysis (verification §5.2/§5.3/§6.1). Pure functions over recorded rows;
//      the real-load driver is ilv2-mac-system-loop.test.mjs. Thresholds are the manual's, not relaxed.
import { TIMING_LOAD1_LIMIT, timingWindowIdle } from "./ilv2-mac-contracts.mjs";

export const LIMITS = {
  fullMs: 327_900, fullSamples: 3,
  seedMs: { le20: 5_000, to200: 15_000 }, seedSamples: 20,
  queuedP95Ms: 2_000, queuedMaxMs: 5_000, fullHandoffMs: 5_000,
  singleBuildP95Ms: 2_000, editP95Ms: 3_000, editRounds: 20, xmlEditRounds: 10,
  heartbeatGapMs: 2_000, statusP99Ms: 200, statusSamples: 100,
  physicalRatio: { 20: 0.1, 200: 0.3 }, physicalRounds: 3,
  builders: 2, full: 1, parsers: 4, queries: 2,
  deadlineSlackMs: 1_000, daemonExitMs: 10_000, idleLoad1Limit: TIMING_LOAD1_LIMIT,
  // Harness bounds, not manual thresholds: a short job queued longer than starvationMs is starved; a lease held this long
  // with no build in flight is leaked (request/candidate leases last seconds; the longest seen idle-held lease was 35 s).
  starvationMs: 600_000, leaseHoldMs: 120_000
};

/** Nearest-rank percentile (§5.3): the ceil(p·n)-th sorted value. Censored samples are Infinity and stay in. */
export function nearestRank(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function stats(values) {
  const finite = values.filter(Number.isFinite);
  return { n: values.length, censored: values.length - finite.length, p50: nearestRank(values, 0.5), p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99), max: values.length ? Math.max(...values) : undefined };
}

/** The seed tier of a measured difference (changed + deleted files against the chosen base). */
export function seedTier(files) {
  return files <= 20 ? "le20" : files <= 200 ? "to200" : "large";
}

/** Timing windows require absolute load1 < 20 at both edges; CPU count is metadata only. */
export function idleWindow(start, end, limit = LIMITS.idleLoad1Limit) {
  return timingWindowIdle(start, end, limit);
}

/** Match one full attempt by owner/workspace and the enclosing round, then its exact published view.
 * Queue stays separate; service time includes verification, checkpoint/seal, publication and the correct response.
 * A later round or a query on an older binding must never repair missing evidence for this attempt. */
export function fullSample({ rows, calls, loads, workspaceId, workspace, sinceEpoch = 0 }) {
  const attempts = rows.filter(row => row.type === "scheduler" && row.event.type === "closed" && row.event.workspaceId === workspaceId
    && row.event.kind === "full" && row.at >= sinceEpoch && row.event.code === 0).map(closed => {
    const dispatch = rows.find(row => row.pid === closed.pid && row.type === "scheduler" && row.event.type === "dispatched"
      && row.event.workspaceId === workspaceId && row.event.kind === "full" && row.event.pid === closed.event.pid && row.at <= closed.at);
    const matches = dispatch ? rows.filter(row => row.pid === closed.pid && row.type === "round" && row.workspaceId === workspaceId
      && row.kind === "full" && row.at >= closed.at && row.at - row.elapsedMs <= dispatch.at + 1
      && row.at - row.elapsedMs >= sinceEpoch - 1) : [];
    return { closed, dispatch, round: matches.length === 1 ? matches[0] : undefined };
  });
  const { closed, dispatch, round } = attempts.find(attempt => attempt.round?.outcome === "published") ?? {};
  const rejectedAttempts = attempts.filter(attempt => attempt.round?.outcome !== "published").map(({ closed, round }) => ({
    pid: closed.event.pid, ownerPid: closed.pid, builderRunMs: closed.event.runMs, closeAt: closed.at,
    outcome: round?.outcome ?? "unmatched", error: round?.error, roundMs: round?.elapsedMs }));
  const startAt = round && round.at - round.elapsedMs;
  const holdsPublishedView = call => {
    if (call.indexView?.workspaceId !== workspaceId || call.indexView?.snapshotId !== round.snapshotId) return false;
    const heldVersion = call.indexView.bindingVersion;
    if (!Number.isSafeInteger(heldVersion) || heldVersion < round.bindingVersion) return false;
    if (heldVersion === round.bindingVersion) return true;
    // A verified noop may advance the watermark before the query acquires. Only a
    // consecutive, recorded chain on this immutable snapshot can extend the proof.
    const versions = rows.filter(row => row.pid === round.pid && row.type === "round" && row.workspaceId === workspaceId
      && row.outcome === "noop" && row.snapshotId === round.snapshotId && row.bindingVersion > round.bindingVersion
      && row.bindingVersion <= heldVersion && row.at >= round.at && row.boundAt <= call.startedAt + call.elapsedMs)
      .map(row => row.bindingVersion).sort((a, b) => a - b);
    return versions.length === heldVersion - round.bindingVersion && versions.every((version, index) => version === round.bindingVersion + index + 1);
  };
  const correct = round?.snapshotId && Number.isFinite(round.boundAt) && round.bindingVersion !== undefined ? calls.filter(call => call.workspace === workspace
    && call.firstCorrect === true && call.status === "ok" && call.startedAt + call.elapsedMs >= round.boundAt
    && holdsPublishedView(call)
    && Number.isFinite(call.elapsedMs)).sort((a, b) => a.startedAt + a.elapsedMs - b.startedAt - b.elapsedMs)[0] : undefined;
  const endAt = correct && correct.startedAt + correct.elapsedMs;
  const queueMs = dispatch?.event.waitedMs;
  const fullServiceMs = correct && Number.isFinite(queueMs) && queueMs >= 0 && endAt >= round.at
    ? endAt - startAt - queueMs : Infinity;
  const near = epoch => loads.reduce((best, sample) => !best || Math.abs(sample.at - epoch) < Math.abs(best.at - epoch) ? sample : best, undefined);
  const loadAtStart = Number.isFinite(startAt) ? near(startAt) : undefined;
  const loadAtCorrect = Number.isFinite(endAt) ? near(endAt) : undefined;
  return { pid: closed?.event.pid, ownerPid: closed?.pid, ms: fullServiceMs, fullServiceMs, builderRunMs: closed?.event.runMs, queueMs,
    startAt, endAt, firstCorrect: correct?.requestId, snapshotId: round?.snapshotId, bindingVersion: round?.bindingVersion,
    roundMs: round?.elapsedMs, files: round?.changed, timings: round?.timings, rejectedAttempts, servedBindingVersion: correct?.indexView?.bindingVersion,
    idle: idleWindow(loadAtStart, loadAtCorrect), loadAtStart, loadAtCorrect };
}

/** Missing correct service evidence cannot be hidden by the median of other successful fulls. */
export function fullTiming(fulls) {
  return sampledTiming(fulls, { pick: row => row.fullServiceMs, limit: LIMITS.fullMs, p: 0.5, min: LIMITS.fullSamples,
    complete: row => row.firstCorrect !== undefined && Number.isFinite(row.startAt) && Number.isFinite(row.endAt) && row.endAt >= row.startAt,
    startLoad: row => row.loadAtStart, endLoad: row => row.loadAtCorrect });
}

/** STALE may keep a negative partial, but never justify an unmarked READY miss. */
export function badSyntaxNegative(value) {
  return value?.scopeState === "PARTIAL" && value.exact !== "match";
}

/** Retry only an explicitly stale partial negative. A positive or malformed confidence is final failure. */
export async function settleNegative(probe, { timeoutMs, pause, now = () => performance.now(), pollMs = 150 }) {
  const started = now();
  let attempts = 0;
  for (;;) {
    const result = await probe();
    attempts++;
    const value = result.value;
    if (value?.exact === "miss" && value.scopeState === "READY" && value.indexView?.state === "FRESH") return { ...result, ok: true, attempts };
    if (value?.exact === "match" || value?.exact === "ambiguous" || value?.candidates?.length > 0
      || value?.scopeState !== "PARTIAL" || value?.indexView?.state !== "STALE") return { ...result, ok: false, attempts };
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) return { ...result, ok: false, attempts, timedOut: true };
    await pause(Math.min(pollMs, remaining));
  }
}

/**
 * One timing item. Missing samples fail the gate (no minimum, no PASS); a non-idle window makes a
 * measured value INVALID_EXPERIMENT, never PASS; Infinity (censored) samples count as misses.
 */
export function timingItem({ samples, limit, p = 0.95, min, idle, strictMax, evidenceComplete }) {
  const summary = stats(samples);
  const value = nearestRank(samples, p);
  const base = { ...summary, p, limit, value, idle, minSamples: min, ...(evidenceComplete === undefined ? {} : { evidenceComplete }) };
  if (samples.length < min) return { ...base, verdict: "FAIL", reason: `${samples.length} samples < ${min}` };
  if (summary.censored > 0) return { ...base, verdict: "FAIL", reason: "missing or censored timing evidence" };
  const meets = value <= limit && (strictMax === undefined || summary.max <= strictMax);
  if (!idle) return { ...base, verdict: "INVALID_EXPERIMENT", reason: "host load1 missing or outside the timing limit at a window edge", measured: meets ? "WITHIN_LIMIT" : "OVER_LIMIT" };
  if (evidenceComplete === false) return { ...base, verdict: "FAIL", reason: "required sample evidence is incomplete" };
  return { ...base, verdict: meets ? "PASS" : "FAIL", ...(strictMax !== undefined ? { maxLimit: strictMax } : {}) };
}

/** Keep every attempt; only complete measurements with known loads can be excluded for environment.
 * n/validN count all valid samples, invalidN counts environment-only attempts, missingN always blocks completion. */
function sampledTiming(rows, { pick, complete = () => true, startLoad = row => row?.loadStart, endLoad = row => row?.loadEnd,
  environmentReason = () => undefined, invalidPhysicalDenominator = () => false, minByKind, ...limits }) {
  const knownLoad = load => Number.isFinite(load?.load1) && load.load1 >= 0;
  const attempts = rows.map((row, sourceIndex) => {
    const value = pick(row), loadStart = startLoad(row), loadEnd = endLoad(row);
    const explainedPhysicalValue = value === undefined && invalidPhysicalDenominator(row);
    const dataComplete = (Number.isFinite(value) || explainedPhysicalValue) && !row?.censored && !row?.error && row?.outcome !== "failed" && row?.status !== "error" && row?.status !== "pending" && complete(row);
    const loadsKnown = knownLoad(loadStart) && knownLoad(loadEnd);
    const missing = !dataComplete || !loadsKnown;
    const reason = !dataComplete ? "missing, failed, unclosed or censored measurement evidence" : !loadsKnown ? "missing or invalid load1 at a sample edge"
      : [!idleWindow(loadStart, loadEnd) && "host load1 outside the timing limit at a sample edge", environmentReason(row)].filter(Boolean).join("; ");
    const category = missing ? "MISSING_EVIDENCE" : reason ? "ENVIRONMENT" : "VALID";
    return { sourceIndex, id: row?.id, label: row?.label, requestId: row?.requestId, editId: row?.editId, ownerPid: row?.ownerPid ?? row?.owner,
      workspace: row?.workspace, workspaceId: row?.workspaceId, pid: row?.pid, snapshotId: row?.snapshotId, kind: row?.kind, firstCorrect: row?.firstCorrect,
      startAt: row?.startAt ?? row?.startedAt ?? row?.dispatchAt, endedAt: row?.endedAt ?? row?.endAt ?? row?.closeAt,
      value, loadStart, loadEnd, status: row?.status, outcome: row?.outcome, ok: row?.ok, code: row?.code, signal: row?.signal, failure: row?.failure, forcedExit: row?.forcedExit, category, verdict: category === "VALID" ? "VALID" : category === "ENVIRONMENT" || dataComplete ? "INVALID_EXPERIMENT" : "FAIL",
      ...(reason ? { reason } : {}), ...(category === "ENVIRONMENT" && explainedPhysicalValue ? { invalidPhysicalDenominator: true } : {}),
      volumeValid: row?.volumeValid, volumeGrowthBytes: row?.volumeGrowthBytes, noiseBytes: row?.noiseBytes, fullGrowthBytes: row?.fullGrowthBytes, fullNoiseBytes: row?.fullNoiseBytes };
  });
  return summarizeTimingAttempts(attempts, { ...limits, minByKind });
}

/** Aggregate already classified attempts without selecting a fast subset or discarding missing evidence. */
export function summarizeTimingAttempts(attempts, { limit, p = 0.95, min, strictMax, minByKind }) {
  const limits = { limit, p, min, strictMax };
  const valid = attempts.filter(row => row.category === "VALID");
  const invalidN = attempts.filter(row => row.category === "ENVIRONMENT").length;
  const missing = attempts.filter(row => row.category === "MISSING_EVIDENCE");
  const countsByKind = minByKind && Object.fromEntries(Object.keys(minByKind).map(kind => [kind, valid.filter(row => row.kind === kind).length]));
  const kindsMet = !minByKind || Object.entries(minByKind).every(([kind, min]) => countsByKind[kind] >= min);
  const result = timingItem({ ...limits, samples: valid.map(row => row.value), idle: true });
  const detail = { attemptedN: attempts.length, validN: valid.length, invalidN, missingN: missing.length,
    censored: attempts.filter(row => !Number.isFinite(row.value)
      && !(row.category === "ENVIRONMENT" && row.invalidPhysicalDenominator === true && row.value === undefined)).length,
    evidenceComplete: missing.length === 0 && kindsMet, attempts,
    ...(minByKind ? { countsByKind, minByKind } : {}) };
  if (missing.length) return { ...result, ...detail, verdict: missing.some(row => row.verdict === "FAIL") ? "FAIL" : "INVALID_EXPERIMENT", reason: "required sample evidence is missing" };
  if (valid.length < limits.min || !kindsMet) return { ...result, ...detail, verdict: invalidN ? "INVALID_EXPERIMENT" : "FAIL", reason: "too few valid samples in the required groups" };
  return { ...result, ...detail };
}

/**
 * Builder jobs from scheduler telemetry: queue time is dispatch − waitedMs, run from dispatch to close.
 * Keyed by owner incarnation and builder pid (each attempt is one builder process).
 */
export function jobsFrom(rows) {
  const jobs = new Map();
  for (const row of rows) {
    if (row.type !== "scheduler") continue;
    const event = row.event;
    if (!["dispatched", "result", "closed"].includes(event.type) || event.pid === undefined) continue;
    const key = `${row.pid}:${event.pid}`;
    const job = jobs.get(key) ?? { owner: row.pid, pid: event.pid, workspaceId: event.workspaceId, kind: event.kind };
    if (event.type === "dispatched") Object.assign(job, { dispatchAt: row.at, queueAt: row.at - event.waitedMs, waitedMs: event.waitedMs, baseId: event.baseId,
      builders: event.builders, full: event.full, parserTokens: event.parserTokens });
    // files is the resulting index's size; the files this job actually parsed are its touched set.
    if (event.type === "result") Object.assign(job, { resultAt: row.at, ok: event.ok, escalation: event.escalation, files: event.files, touched: event.stages?.parse?.files, stages: event.stages, resultRunMs: event.runMs });
    if (event.type === "closed") Object.assign(job, { closeAt: row.at, code: event.code, signal: event.signal, runMs: event.runMs, failure: event.failure, forcedExit: event.forcedExit });
    jobs.set(key, job);
  }
  return [...jobs.values()].sort((a, b) => (a.dispatchAt ?? a.closeAt) - (b.dispatchAt ?? b.closeAt));
}

/** Scheduler-forced exits and signalled closes that the run did not inject: a healthy build killed. */
export function healthyKills(rows, injectedPids = []) {
  const injected = new Set(injectedPids);
  const out = [];
  for (const row of rows) {
    if (row.type !== "scheduler" && row.type !== "pool") continue;
    const event = row.event;
    if (injected.has(event.pid)) continue;
    if (event.type === "forced-exit" || event.type === "reap-overdue" || (row.type === "scheduler" && event.type === "closed" && (event.signal || event.forcedExit)))
      out.push({ at: row.at, source: row.type, ...event });
  }
  return out;
}

/** Peak concurrency: builders, fulls and parser tokens at each dispatch; live query workers from spawn/close. */
export function resourcePeaks(rows) {
  const peaks = { builders: 0, full: 0, parserTokens: 0, queryWorkers: 0 };
  const workers = new Map();
  for (const row of rows) {
    if (row.type === "scheduler" && row.event.type === "dispatched") {
      peaks.builders = Math.max(peaks.builders, row.event.builders); peaks.full = Math.max(peaks.full, row.event.full);
      peaks.parserTokens = Math.max(peaks.parserTokens, row.event.parserTokens);
    }
    if (row.type === "pool") {
      const live = workers.get(row.pid) ?? new Set();
      if (row.event.type === "worker-spawn") live.add(row.event.pid);
      if (row.event.type === "worker-close") live.delete(row.event.pid);
      workers.set(row.pid, live);
      peaks.queryWorkers = Math.max(peaks.queryWorkers, live.size);
    }
  }
  return peaks;
}

/** Owner-side gaps between consecutive liveness lines of each builder process (receipt time). */
export function heartbeatGaps(rows) {
  const last = new Map(), gaps = [];
  // The sink stamps the owner pid first and the builder event's own `pid` overrides it: here `row.pid` is the builder.
  // gapMs is the arrival interval at the owner (contract §2.6); emitGapMs is the builder's own beat interval, which
  // separates a slow builder from an owner whose event loop delayed the arrival.
  for (const row of rows) {
    if (row.type !== "builder") continue;
    const key = String(row.pid);
    const previous = last.get(key);
    if (previous !== undefined) gaps.push({ pid: row.pid, workspaceId: row.workspaceId, gapMs: row.at - previous.at, emitGapMs: (row.beat?.at ?? NaN) - (previous.beat?.at ?? NaN), stage: row.beat?.stage });
    last.set(key, row);
  }
  return gaps;
}

/**
 * Short jobs the scheduler queued and did not serve within the bound. Each queued entry is answered by the next dispatch
 * (an escalation's re-dispatch merges a pending entry) or failed round of that workspace in the same owner; one still
 * open when its owner's telemetry ends is cut off by the owner's exit (a daemon kill), not starved, unless already overdue.
 */
export function starvation(rows, boundMs = LIMITS.starvationMs) {
  const lastAt = new Map(), open = new Map(), starved = [], cutOff = [];
  let queued = 0;
  for (const row of rows) lastAt.set(row.pid, Math.max(lastAt.get(row.pid) ?? -Infinity, row.at));
  const serve = (owner, workspaceId, at) => {
    const pending = open.get(`${owner}:${workspaceId}`);
    const entry = pending?.shift();
    if (entry && at - entry.at > boundMs) starved.push({ ...entry, waitedMs: at - entry.at });
  };
  for (const row of rows) {
    const event = row.event;
    if (row.type === "scheduler" && event.type === "queued" && event.kind !== "full") {
      queued += 1;
      const key = `${row.pid}:${event.workspaceId}`;
      open.set(key, [...(open.get(key) ?? []), { owner: row.pid, workspaceId: event.workspaceId, kind: event.kind, at: row.at }]);
    }
    if (row.type === "scheduler" && event.type === "dispatched") serve(row.pid, event.workspaceId, row.at);
    if (row.type === "round" && row.outcome === "failed") serve(row.pid, row.workspaceId, row.at);
  }
  for (const pending of open.values()) for (const entry of pending) {
    const age = lastAt.get(entry.owner) - entry.at;
    (age > boundMs ? starved : cutOff).push({ ...entry, waitedMs: age });
  }
  return { queued, starved, cutOff };
}

/** Unbound snapshots kept past the hold bound, or at the last sweep. A workspace may legitimately
 * wait on another workspace's shared snapshot lease; its reclamation is judged after that lease ends. */
export function leaseLeaks(rows, holdMs = LIMITS.leaseHoldMs) {
  const byOwner = new Map(), leaks = [], missingTargets = [];
  for (const row of rows) if (row.type === "sweep" && row.report) byOwner.set(row.pid, [...(byOwner.get(row.pid) ?? []), row]);
  for (const [owner, sweeps] of byOwner) {
    const held = new Map();
    let lastSnapshots = [];
    for (const sweep of sweeps) {
      const kept = sweep.report.kept ?? {};
      const count = kept.leased ?? 0;
      const targets = sweep.report.leasedTargets ?? [];
      const validTarget = target => target && typeof target === "object" && Object.keys(target).length === 1
        && ((typeof target.snapshotId === "string" && target.snapshotId.length > 0)
          || (typeof target.workspaceId === "string" && target.workspaceId.length > 0));
      if (!Number.isInteger(count) || count < 0 || !Array.isArray(targets) || targets.length !== count
        || !targets.every(validTarget) || new Set(targets.map(target => JSON.stringify(target))).size !== targets.length) {
        missingTargets.push({ owner, at: sweep.at, leased: count, reason: "leased target identities missing or inconsistent" });
        held.clear();
        lastSnapshots = [];
        continue;
      }
      lastSnapshots = targets.flatMap(target => typeof target.snapshotId === "string" ? [target.snapshotId] : []);
      // Preserve the existing in-flight exclusion: aggregate reports cannot assign a build to a specific target.
      if (kept["in-flight"]) { held.clear(); continue; }
      for (const snapshotId of held.keys()) if (!lastSnapshots.includes(snapshotId)) held.delete(snapshotId);
      for (const snapshotId of lastSnapshots) {
        const state = held.get(snapshotId) ?? { since: sweep.at, reported: false };
        held.set(snapshotId, state);
        if (!state.reported && sweep.at - state.since > holdMs) {
          leaks.push({ owner, snapshotId, since: state.since, at: sweep.at, reason: "held without a build in flight" });
          state.reported = true;
        }
      }
    }
    for (const snapshotId of lastSnapshots) leaks.push({ owner, snapshotId, at: sweeps.at(-1).at, reason: "kept at the incarnation's last sweep" });
  }
  return { sweeps: [...byOwner.values()].reduce((n, sweeps) => n + sweeps.length, 0), owners: byOwner.size, leaks,
    evidenceComplete: missingTargets.length === 0, missingTargets };
}

/**
 * Fairness (§6.1): small deltas whose queue wait overlapped a running full, and each full that waited
 * behind another full: its dispatch after the previous full's close.
 */
export function fairness(jobs) {
  const fulls = jobs.filter(job => job.kind === "full" && job.dispatchAt !== undefined);
  const running = (at, end) => fulls.some(full => full.dispatchAt <= end && (full.closeAt ?? Infinity) >= at);
  const deltas = jobs.filter(job => job.kind !== "full" && job.dispatchAt !== undefined && running(job.queueAt, job.dispatchAt))
    .map(job => ({ owner: job.owner, workspaceId: job.workspaceId, pid: job.pid, waitedMs: job.waitedMs, queueAt: job.queueAt, dispatchAt: job.dispatchAt }));
  const handoffs = [];
  for (const full of fulls) {
    const before = fulls.filter(other => other !== full && other.closeAt !== undefined && other.closeAt <= full.dispatchAt && other.closeAt > full.queueAt);
    if (!before.length) continue;
    const previous = before.reduce((a, b) => (a.closeAt > b.closeAt ? a : b));
    handoffs.push({ owner: full.owner, workspaceId: full.workspaceId, pid: full.pid, afterPid: previous.pid, previousCloseAt: previous.closeAt, dispatchAt: full.dispatchAt, handoffMs: full.dispatchAt - previous.closeAt });
  }
  return { deltas, handoffs };
}

/** Per-stage wall-time profile of builder jobs (from their reported PipelineMetrics) and owner round timings. */
export function profiles(jobs, rounds) {
  const flatTimings = round => round.timings && { ...Object.fromEntries(Object.entries(round.timings).filter(([, value]) => typeof value === "number")),
    ...Object.fromEntries(Object.entries(round.timings.seal ?? {}).map(([name, value]) => [`seal.${name}`, value])) };
  const group = (items, pick) => {
    const out = {};
    for (const item of items) for (const [name, value] of Object.entries(pick(item) ?? {})) if (Number.isFinite(value)) (out[name] ??= []).push(value);
    return Object.fromEntries(Object.entries(out).map(([name, values]) => [name, stats(values)]));
  };
  const stageMs = job => job.stages && Object.fromEntries(["capture", "parse", "resolve", "graphSearch", "sql"].map(name => [name, job.stages[name]?.elapsedMs]));
  const byKind = {};
  for (const job of jobs) (byKind[job.kind] ??= []).push(job);
  return {
    builder: Object.fromEntries(Object.entries(byKind).map(([kind, items]) => [kind, { jobs: items.length, stages: group(items, stageMs),
      queueMs: stats(items.filter(job => Number.isFinite(job.waitedMs)).map(job => job.waitedMs)),
      runMs: stats(items.filter(job => Number.isFinite(job.runMs)).map(job => job.runMs)) }])),
    owner: Object.fromEntries(Object.entries(rounds.reduce((acc, round) => { (acc[round.kind ?? round.outcome] ??= []).push(round); return acc; }, {}))
      .map(([kind, items]) => [kind, { rounds: items.length, timings: group(items, flatTimings), elapsedMs: stats(items.map(round => round.elapsedMs)) }]))
  };
}

/**
 * Owner process samples (inherited MAC-08C items): RSS under real load, and event-loop delay spikes
 * with the publish rounds that ended within one sample window before them.
 */
export function processProfile(rows, spikeMs = 100) {
  const samples = rows.filter(row => row.type === "process");
  const publishes = rows.filter(row => row.type === "round" && row.outcome === "published");
  const spikes = samples.filter(row => row.loop?.max > spikeMs).map(row => ({ at: row.at, pid: row.pid, maxMs: row.loop.max,
    publishes: publishes.filter(round => round.at <= row.at && round.at > row.at - 5000).map(round => ({ kind: round.kind, changed: round.changed, publishMs: round.timings?.publishMs })) }));
  return { samples: samples.length, rssBytes: stats(samples.map(row => row.rss)), heapUsedBytes: stats(samples.map(row => row.heapUsed)),
    loopP99Ms: stats(samples.map(row => row.loop?.p99 ?? 0)), loopMaxMs: stats(samples.map(row => row.loop?.max ?? 0)), spikes,
    spikesNearPublish: spikes.filter(row => row.publishes.length).length };
}

/**
 * deltaMaxTouched calibration (contract §2.5): builder run time of completed deltas against their size
 * (least-squares line), projected to the limit and compared with the delta job deadline and the full.
 */
export function deltaCalibration(jobs, rounds, { limit, deltaJobMs = 60_000, fullMs } = {}) {
  // x is the dependency closure the limit applies to (the files a delta resolves), falling back to the round's changed set.
  const points = jobs.filter(job => job.kind === "delta" && job.ok && !job.escalation && Number.isFinite(job.runMs)).map(job => {
    const round = rounds.find(row => row.type === "round" && row.workspaceId === job.workspaceId && row.at >= job.closeAt && row.outcome === "published");
    return { files: job.stages?.resolve?.files ?? (round?.changed ?? 0) + (round?.deleted ?? 0), changed: (round?.changed ?? 0) + (round?.deleted ?? 0), runMs: job.runMs, publishMs: round?.timings?.publishMs, kind: round?.kind };
  }).filter(point => point.files > 0);
  const escalated = jobs.filter(job => job.kind === "delta" && job.escalation).map(job => ({ escalation: job.escalation, runMs: job.runMs }));
  const n = points.length;
  if (n < 2) return { points, n, escalated, verdict: "INSUFFICIENT_SAMPLES" };
  const mx = points.reduce((sum, p) => sum + p.files, 0) / n, my = points.reduce((sum, p) => sum + p.runMs, 0) / n;
  const sxx = points.reduce((sum, p) => sum + (p.files - mx) ** 2, 0);
  const slope = sxx ? points.reduce((sum, p) => sum + (p.files - mx) * (p.runMs - my), 0) / sxx : 0;
  const intercept = my - slope * mx;
  const projectedMs = intercept + slope * limit;
  // Measured jobs near the limit (closure in its top quarter) decide when present; the fit below the limit is the fallback.
  const near = points.filter(p => p.files >= 0.75 * limit && p.files <= limit).map(p => p.runMs);
  const atLimitMaxMs = near.length ? Math.max(...near) : undefined;
  const judged = atLimitMaxMs ?? projectedMs;
  return { points, n, msPerFile: slope, interceptMs: intercept, limit, projectedRunMsAtLimit: projectedMs, atLimit: near.length, atLimitMaxMs, escalated, deltaJobMs, fullMs,
    maxObservedFiles: Math.max(...points.map(p => p.files)), basis: atLimitMaxMs === undefined ? "fit" : "measured",
    verdict: judged < deltaJobMs && (fullMs === undefined || judged < fullMs) ? "KEEP" : "LOWER" };
}

/** Requests that ran past their deadline plus the 1 s slack (§6.1 请求截止). */
export function unboundedCalls(calls, slackMs = LIMITS.deadlineSlackMs) {
  return calls.filter(call => !(call.elapsedMs <= call.deadlineMs + slackMs));
}

/**
 * Evidence audit of every recorded candidate: its (relativePath, contentHash) must be a version this
 * run wrote (or the original) in the queried workspace. A hash that belongs only to another workspace
 * is cross-worktree evidence; a hash of a version without the matched token is a mixed capture.
 */
export function auditEvidence(calls, versions) {
  const cross = [], mixed = [], unknown = [];
  // Only tokens this run inserted can prove a mixed capture; an original name is in every version.
  const inserted = new Set(Object.values(versions).flatMap(files => Object.values(files).flatMap(hashes => Object.values(hashes).flatMap(version => version.tokens ?? []))));
  let audited = 0;
  for (const call of calls) {
    for (const candidate of call.candidates ?? []) {
      for (const ref of [candidate.declaration, candidate.evidence].filter(Boolean)) {
        const own = versions[call.workspace]?.[ref.relativePath];
        if (!own) continue;
        audited += 1;
        const version = own[ref.contentHash];
        if (!version) {
          const elsewhere = Object.entries(versions).filter(([name, files]) => name !== call.workspace && files[ref.relativePath]?.[ref.contentHash]).map(([name]) => name);
          (elsewhere.length ? cross : unknown).push({ requestId: call.requestId, workspace: call.workspace, ...ref, elsewhere });
          continue;
        }
        if (ref === candidate.declaration && candidate.name && version.tokens && !version.tokens.includes(candidate.name) && call.token === candidate.name && inserted.has(candidate.name))
          mixed.push({ requestId: call.requestId, workspace: call.workspace, ...ref, name: candidate.name });
      }
    }
  }
  return { audited, cross, mixed, unknown };
}

const gate = (pass, detail) => ({ verdict: pass ? "PASS" : "FAIL", ...detail });

/** The G11 verdict body. Hard gates decide G11; performance items are recorded as measured. */
export function analyze({ calls, telemetry, edits, seeds, physical, fulls, statusSamples, loads, loadSamples = [], phases = [], versions, injectedPids, negatives, faults, restart, lifecycle, quick, deltaClosureLimit }) {
  const jobs = jobsFrom(telemetry);
  const rounds = telemetry.filter(row => row.type === "round");
  const audit = auditEvidence(calls, versions);
  const kills = healthyKills(telemetry, injectedPids);
  const unbounded = unboundedCalls(calls);
  const peaks = resourcePeaks(telemetry);
  const fair = fairness(jobs);
  const gaps = heartbeatGaps(telemetry);
  const starve = starvation(telemetry);
  const leases = leaseLeaks(telemetry);
  // A gate decided on no evidence is not a pass: each hard gate also needs the evidence it judges to exist.
  const dispatched = jobs.filter(job => job.dispatchAt !== undefined).length;
  const floor = {
    isolation: audit.audited >= edits.length + seeds.length && (negatives ?? []).length > 0,
    requestDeadline: calls.length > 0,
    resources: dispatched > 0 && leases.sweeps > 0 && leases.evidenceComplete,
    noStarvation: starve.queued > 0 && (quick || fair.deltas.length > 0)
  };
  const hard = {
    correctness: gate(edits.every(row => row.firstCorrect !== undefined) && seeds.every(row => row.firstCorrect !== undefined) && (negatives ?? []).every(row => row.ok)
      && (faults ?? []).every(row => row.ok) && (restart?.ok ?? false),
    { editsMissed: edits.filter(row => row.firstCorrect === undefined).map(row => row.id), seedsMissed: seeds.filter(row => row.firstCorrect === undefined).map(row => row.id),
      negativesFailed: (negatives ?? []).filter(row => !row.ok), faultsFailed: (faults ?? []).filter(row => !row.ok).map(row => row.name), restart: restart ?? null }),
    isolation: gate(floor.isolation && audit.cross.length === 0 && audit.mixed.length === 0 && audit.unknown.length === 0,
      { audited: audit.audited, negatives: (negatives ?? []).length, evidenceFloor: floor.isolation, cross: audit.cross, mixed: audit.mixed, unknown: audit.unknown }),
    requestDeadline: gate(floor.requestDeadline && unbounded.length === 0, { calls: calls.length, evidenceFloor: floor.requestDeadline, unbounded: unbounded.map(call => ({ requestId: call.requestId, tool: call.tool, deadlineMs: call.deadlineMs, elapsedMs: call.elapsedMs })) }),
    resources: gate(peaks.builders <= LIMITS.builders && peaks.full <= LIMITS.full && peaks.parserTokens <= LIMITS.parsers && peaks.queryWorkers <= LIMITS.queries
      && kills.length === 0 && (lifecycle?.ok ?? false) && floor.resources && leases.leaks.length === 0,
      { peaks, healthyKills: kills, lifecycle: lifecycle ?? null, dispatched, leaseLeaks: leases, evidenceFloor: floor.resources }),
    noStarvation: gate(floor.noStarvation && starve.starved.length === 0 && jobs.filter(job => job.kind !== "full").every(job => job.closeAt !== undefined || job.dispatchAt !== undefined),
      { queued: starve.queued, starved: starve.starved, cutOffByOwnerExit: starve.cutOff, boundMs: LIMITS.starvationMs, deltasDuringFull: fair.deltas.length,
        maxWaitedMs: fair.deltas.length ? Math.max(...fair.deltas.map(row => row.waitedMs)) : null, evidenceFloor: floor.noStarvation })
  };
  const near = epoch => Number.isFinite(epoch) ? loadSamples.reduce((best, sample) => !best || Math.abs(sample.at - epoch) < Math.abs(best.at - epoch) ? sample : best, undefined) : undefined;
  const normalWindow = row => row.window === "normal" && row.windowEnd === "normal"
    && Number.isInteger(row.windowVersion) && row.windowVersion === row.endWindowVersion;
  const firstMs = row => normalWindow(row) && Number.isFinite(row.startAt) && Number.isFinite(row.endedAt) && row.endedAt >= row.startAt
    && row.firstCorrect !== undefined && Number.isFinite(row.firstCorrectMs) ? row.firstCorrectMs : Infinity;
  const seedKinds = seeds.map((sample, sourceIndex) => {
    const matching = Number.isInteger(sample.ownerPid) && typeof sample.workspaceId === "string" && Number.isFinite(sample.startAt) && Number.isFinite(sample.endedAt)
      ? jobs.filter(job => job.owner === sample.ownerPid && job.workspaceId === sample.workspaceId
        && (Number.isFinite(job.dispatchAt) ? job.dispatchAt <= sample.endedAt && (!Number.isFinite(job.closeAt) || job.closeAt >= sample.startAt)
          : [job.resultAt, job.closeAt].some(at => Number.isFinite(at) && at >= sample.startAt && at <= sample.endedAt))) : [];
    const full = sample.kind === "full" || matching.some(job => job.kind === "full" || job.escalation);
    const settled = job => Number.isFinite(job.dispatchAt) && job.dispatchAt >= sample.startAt && Number.isFinite(job.closeAt) && job.closeAt <= sample.endedAt
      && Number.isFinite(job.runMs) && job.code === 0 && !job.signal && !job.failure && !job.forcedExit && (job.ok === true || Boolean(job.escalation));
    const sampleComplete = Number.isFinite(firstMs(sample)) && !sample.censored && !sample.error && sample.outcome !== "failed"
      && sample.status !== "error" && sample.status !== "pending"
      && [sample.loadStart, sample.loadEnd].every(load => Number.isFinite(load?.load1) && load.load1 >= 0);
    const jobEvidenceComplete = matching.some(job => job.kind === "full" && job.ok === true) && matching.every(settled);
    const confirmedFull = full && sampleComplete && jobEvidenceComplete;
    const unresolved = (full && !confirmedFull) || (sample.jobs > 0 && matching.length === 0);
    return { sourceIndex, sample, jobs: matching, jobEvidenceComplete, classification: confirmedFull ? "escalated-full" : unresolved ? "incomplete-evidence" : "seed",
      reason: confirmedFull ? "actual builder full cannot fill a seed tier" : unresolved ? "full/escalation or declared jobs lack complete successful job, query or load evidence" : undefined };
  });
  const seedTiming = (name, limit) => {
    const rows = seedKinds.filter(row => row.sample.tier === name && row.sample.phase === "seed" && row.sample.window === "normal");
    const escalatedFulls = rows.filter(row => row.classification === "escalated-full");
    const unresolvedSeedAttempts = rows.filter(row => row.classification === "incomplete-evidence");
    const blocked = new Set(unresolvedSeedAttempts.filter(row => !row.jobEvidenceComplete).map(row => row.sample));
    return { ...sampledTiming(rows.filter(row => row.classification !== "escalated-full").map(row => row.sample),
      { pick: row => blocked.has(row) ? Infinity : firstMs(row), limit, min: LIMITS.seedSamples }),
      recordedN: rows.length, escalatedFullN: escalatedFulls.length, escalatedFulls, unresolvedSeedAttempts };
  };
  const normalEdits = edits.filter(row => row.phase === "edits" && row.window === "normal" && ["java", "xml"].includes(row.kind));
  const singleBuilds = normalEdits.flatMap(edit => {
    const matching = jobs.filter(job => Number.isInteger(edit.ownerPid) && typeof edit.workspaceId === "string"
      && job.kind !== "full" && job.owner === edit.ownerPid && job.workspaceId === edit.workspaceId
      && Number.isFinite(edit.startAt) && Number.isFinite(edit.endedAt) && job.dispatchAt >= edit.startAt && job.dispatchAt <= edit.endedAt);
    if (!matching.length) return [{ editId: edit.id, ms: Infinity, missing: "no job in the normal edit window" }];
    return matching.filter(job => job.touched === 1 || job.touched === undefined).map(job => {
      const complete = job.touched === 1 && job.ok === true && job.code === 0 && !job.signal && !job.failure && !job.forcedExit && Number.isFinite(job.closeAt) && job.closeAt <= edit.endedAt
        && Number.isFinite(job.runMs) && normalWindow(edit);
      return { editId: edit.id, ownerPid: job.owner, workspaceId: job.workspaceId, pid: job.pid,
        dispatchAt: job.dispatchAt, closeAt: job.closeAt, ok: job.ok, code: job.code, signal: job.signal, failure: job.failure, forcedExit: job.forcedExit, ms: complete ? job.runMs : Infinity,
        ...(complete ? {} : { missing: "failed job or missing touched count, close or duration inside the normal edit window" }),
        loadStart: near(job.dispatchAt), loadEnd: near(job.closeAt) };
    });
  });
  const fairPhase = fairness(jobs.filter(job => phases.some(phase => phase.name === "fairness" && Number.isFinite(phase.startedAt)
    && Number.isFinite(phase.endedAt) && job.dispatchAt >= phase.startedAt && job.dispatchAt <= phase.endedAt)));
  const fairDeltas = fairPhase.deltas.map(row => ({ ...row, loadStart: near(row.queueAt), loadEnd: near(row.dispatchAt) }));
  const fairHandoffs = fairPhase.handoffs.map(row => ({ ...row, loadStart: near(row.previousCloseAt), loadEnd: near(row.dispatchAt) }));
  // Explicit fault crossings are excluded. Unknown/legacy rows stay visible as invalid evidence.
  const normalStatus = statusSamples.filter(row => row?.window !== "fault" && row?.windowEnd !== "fault"
    && !(Number.isInteger(row?.windowVersion) && Number.isInteger(row?.endWindowVersion) && row.windowVersion !== row.endWindowVersion));
  const statusMs = row => typeof row === "number" ? row : row?.status === "ok" && normalWindow(row)
    && typeof row.phase === "string" && Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt) && row.endedAt >= row.startedAt
    && Number.isFinite(row.elapsedMs) ? row.elapsedMs : Infinity;
  const performance = {
    full: fullTiming(fulls),
    seedLe20: seedTiming("le20", LIMITS.seedMs.le20),
    seedTo200: seedTiming("to200", LIMITS.seedMs.to200),
    queuedDuringFull: sampledTiming(fairDeltas, { pick: row => row.waitedMs, limit: LIMITS.queuedP95Ms, strictMax: LIMITS.queuedMaxMs, min: 1 }),
    fullHandoff: sampledTiming(fairHandoffs, { pick: row => row.handoffMs, limit: LIMITS.fullHandoffMs, p: 1, min: 1 }),
    singleFileBuild: { ...sampledTiming(singleBuilds, { pick: row => row.ms, limit: LIMITS.singleBuildP95Ms, min: LIMITS.editRounds }), samples: singleBuilds },
    editFirstCorrect: sampledTiming(normalEdits, { pick: firstMs, limit: LIMITS.editP95Ms, min: LIMITS.editRounds + LIMITS.xmlEditRounds,
      minByKind: { java: LIMITS.editRounds, xml: LIMITS.xmlEditRounds } }),
    heartbeat: timingItem({ samples: gaps.map(row => row.gapMs), limit: LIMITS.heartbeatGapMs, p: 1, min: 1, idle: true }),
    statusStartFalse: sampledTiming(normalStatus, { pick: statusMs, limit: LIMITS.statusP99Ms, p: 0.99, min: LIMITS.statusSamples }),
    physicalZero: physicalZero(physical),
    physical20: physicalItem(physical, 20),
    physical200: physicalItem(physical, 200)
  };
  const hardPass = Object.values(hard).every(item => item.verdict === "PASS");
  const incompleteMeasurements = Object.entries(performance).filter(([, item]) => item.n < item.minSamples
    || item.verdict === "INVALID_EXPERIMENT" || item.evidenceComplete === false || (item.censored ?? 0) > 0
    || (item.value !== undefined && !Number.isFinite(item.value))).map(([name]) => name);
  const measurementComplete = incompleteMeasurements.length === 0;
  const performanceReady = Object.values(performance).every(item => item.verdict === "PASS");
  const performanceVerdicts = {};
  for (const [name, item] of Object.entries(performance)) (performanceVerdicts[item.verdict] ??= []).push(name);
  return {
    gateId: "G11", status: quick ? "DIAGNOSTIC_ONLY" : hardPass && measurementComplete ? "PASS" : "FAIL", hardGates: hard, performance, measurementComplete, incompleteMeasurements, performanceReady, performanceVerdicts,
    performanceNote: "performance items are measured and recorded as PASS/FAIL/INVALID_EXPERIMENT; measurement completion is not a performance pass",
    profiles: profiles(jobs, rounds), process: processProfile(telemetry),
    deltaCalibration: deltaCalibration(jobs, rounds, { limit: deltaClosureLimit ?? 400, fullMs: nearestRank(fulls.map(row => row.ms), 0.5) }), jobs: jobs.map(({ stages, ...job }) => ({ ...job, stages })), fairness: fair, fairnessPerformance: fairPhase, heartbeat: stats(gaps.map(row => row.gapMs)), heartbeatEmit: stats(gaps.map(row => row.emitGapMs).filter(Number.isFinite))
  };
}

function physicalComplete(row) {
  return row.firstCorrect !== undefined && Number.isFinite(row.firstCorrectMs) && !row.censored && row.outcome !== "failed"
    && Number.isFinite(row.startAt) && Number.isFinite(row.endedAt) && row.endedAt >= row.startAt
    && Number.isFinite(row.newSnapshots) && Number.isFinite(row.jobs) && typeof row.kind === "string";
}

function physicalZero(physical) {
  const rows = physical.filter(row => row.files === 0);
  const zeroWrite = row => row.newSnapshots === 0 && row.jobs === 0 && row.kind === "seed-bind";
  const structuralViolations = rows.filter(row => Number.isFinite(row.newSnapshots) && Number.isFinite(row.jobs)
    && typeof row.kind === "string" && !zeroWrite(row));
  // A known structural failure is blocking evidence, even when its host-load window is invalid.
  return { ...sampledTiming(rows, { pick: row => zeroWrite(row) ? 0 : 1,
    complete: row => physicalComplete(row) && zeroWrite(row), limit: 0, p: 1, min: LIMITS.physicalRounds }),
    structuralPass: structuralViolations.length === 0, structuralViolations, rows };
}

/** Net physical growth against the same-input fresh full; noisy complete attempts stay visible but do not fill valid samples. */
function physicalItem(physical, files) {
  const rows = physical.filter(row => row.files === files), limit = LIMITS.physicalRatio[files];
  const noiseKnown = row => Number.isFinite(row.volumeGrowthBytes) && Number.isFinite(row.noiseBytes) && row.noiseBytes >= 0
    && Number.isFinite(row.fullGrowthBytes) && (!Object.hasOwn(row, "fullNoiseBytes") || Number.isFinite(row.fullNoiseBytes) && row.fullNoiseBytes >= 0);
  const fullReliable = row => row.fullGrowthBytes > 0 && (!Object.hasOwn(row, "fullNoiseBytes") || row.fullGrowthBytes > row.fullNoiseBytes);
  const result = sampledTiming(rows, { pick: row => row.volumeRatio, limit, p: 0.5, min: LIMITS.physicalRounds,
    complete: row => physicalComplete(row) && noiseKnown(row) && typeof row.volumeValid === "boolean"
      && row.volumeValid === (fullReliable(row) && row.noiseBytes < limit * row.fullGrowthBytes),
    invalidPhysicalDenominator: row => !fullReliable(row),
    environmentReason: row => !fullReliable(row) ? "fresh-full physical growth is nonpositive or within measured full noise"
      : !row.volumeValid ? "volume-allocation noise exceeds the measured difference" : undefined });
  const validRows = result.attempts.filter(row => row.category === "VALID").map(row => rows[row.sourceIndex]);
  return { ...result, rows, volumeRatio: stats(validRows.map(row => row.volumeRatio)),
    pageRatio: stats(validRows.map(row => row.pageRatio).filter(Number.isFinite)) };
}

// input: one G11 run's calls, owner lifecycle telemetry, edit/seed/physical samples and host load windows.
// output: G11 hard-gate verdicts, the performance items with their actual PASS/FAIL/INVALID_EXPERIMENT,
//         performanceReady, and parse/resolve/graph/SQL/seal/queue profiles.
// pos: MAC-11 system-loop analysis (verification §5.2/§5.3/§6.1). Pure functions over recorded rows;
//      the real-load driver is ilv2-mac-system-loop.test.mjs. Thresholds are the manual's, not relaxed.

export const LIMITS = {
  fullMs: 327_900, fullSamples: 3,
  seedMs: { le20: 5_000, to200: 15_000 }, seedSamples: 20,
  queuedP95Ms: 2_000, queuedMaxMs: 5_000, fullHandoffMs: 5_000,
  singleBuildP95Ms: 2_000, editP95Ms: 3_000, editRounds: 20,
  heartbeatGapMs: 2_000, statusP99Ms: 200, statusSamples: 100,
  physicalRatio: { 20: 0.1, 200: 0.3 }, physicalRounds: 3,
  builders: 2, full: 1, parsers: 4, queries: 2,
  deadlineSlackMs: 1_000, daemonExitMs: 10_000, idleLoadPerCpu: 1.0
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

/** A window is a valid timing window only when load1/CPU ≤ 1.0 at both edges (§6.1 计时有效性). */
export function idleWindow(start, end, limit = LIMITS.idleLoadPerCpu) {
  return Boolean(start && end && start.perCpu <= limit && end.perCpu <= limit);
}

/**
 * One timing item. Missing samples fail the gate (no minimum, no PASS); a non-idle window makes a
 * measured value INVALID_EXPERIMENT, never PASS; Infinity (censored) samples count as misses.
 */
export function timingItem({ samples, limit, p = 0.95, min, idle, strictMax }) {
  const summary = stats(samples);
  const value = nearestRank(samples, p);
  const base = { ...summary, p, limit, value, idle, minSamples: min };
  if (samples.length < min) return { ...base, verdict: "FAIL", reason: `${samples.length} samples < ${min}` };
  const meets = value <= limit && (strictMax === undefined || summary.max <= strictMax);
  if (!idle) return { ...base, verdict: "INVALID_EXPERIMENT", reason: "host load/cpu above the idle limit at a window edge", measured: meets ? "WITHIN_LIMIT" : "OVER_LIMIT" };
  return { ...base, verdict: meets ? "PASS" : "FAIL", ...(strictMax !== undefined ? { maxLimit: strictMax } : {}) };
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
 * Fairness (§6.1): small deltas whose queue wait overlapped a running full, and each full that waited
 * behind another full: its dispatch after the previous full's close.
 */
export function fairness(jobs) {
  const fulls = jobs.filter(job => job.kind === "full" && job.dispatchAt !== undefined);
  const running = (at, end) => fulls.some(full => full.dispatchAt <= end && (full.closeAt ?? Infinity) >= at);
  const deltas = jobs.filter(job => job.kind !== "full" && job.dispatchAt !== undefined && running(job.queueAt, job.dispatchAt))
    .map(job => ({ workspaceId: job.workspaceId, pid: job.pid, waitedMs: job.waitedMs, queueAt: job.queueAt }));
  const handoffs = [];
  for (const full of fulls) {
    const before = fulls.filter(other => other !== full && other.closeAt !== undefined && other.closeAt <= full.dispatchAt && other.closeAt > full.queueAt);
    if (!before.length) continue;
    const previous = before.reduce((a, b) => (a.closeAt > b.closeAt ? a : b));
    handoffs.push({ workspaceId: full.workspaceId, pid: full.pid, afterPid: previous.pid, handoffMs: full.dispatchAt - previous.closeAt });
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
export function analyze({ calls, telemetry, edits, seeds, physical, fulls, statusSamples, loads, versions, injectedPids, negatives, faults, restart, lifecycle, quick, deltaClosureLimit }) {
  const jobs = jobsFrom(telemetry);
  const rounds = telemetry.filter(row => row.type === "round");
  const audit = auditEvidence(calls, versions);
  const kills = healthyKills(telemetry, injectedPids);
  const unbounded = unboundedCalls(calls);
  const peaks = resourcePeaks(telemetry);
  const fair = fairness(jobs);
  const gaps = heartbeatGaps(telemetry);
  const idle = name => idleWindow(loads[name]?.start, loads[name]?.end);
  const hard = {
    correctness: gate(edits.every(row => row.firstCorrect !== undefined) && seeds.every(row => row.firstCorrect !== undefined) && (negatives ?? []).every(row => row.ok)
      && (faults ?? []).every(row => row.ok) && (restart?.ok ?? false),
    { editsMissed: edits.filter(row => row.firstCorrect === undefined).map(row => row.id), seedsMissed: seeds.filter(row => row.firstCorrect === undefined).map(row => row.id),
      negativesFailed: (negatives ?? []).filter(row => !row.ok), faultsFailed: (faults ?? []).filter(row => !row.ok).map(row => row.name), restart: restart ?? null }),
    isolation: gate(audit.cross.length === 0 && audit.mixed.length === 0 && audit.unknown.length === 0, { audited: audit.audited, cross: audit.cross, mixed: audit.mixed, unknown: audit.unknown }),
    requestDeadline: gate(unbounded.length === 0, { calls: calls.length, unbounded: unbounded.map(call => ({ requestId: call.requestId, tool: call.tool, deadlineMs: call.deadlineMs, elapsedMs: call.elapsedMs })) }),
    resources: gate(peaks.builders <= LIMITS.builders && peaks.full <= LIMITS.full && peaks.parserTokens <= LIMITS.parsers && peaks.queryWorkers <= LIMITS.queries
      && kills.length === 0 && (lifecycle?.ok ?? false), { peaks, healthyKills: kills, lifecycle: lifecycle ?? null }),
    noStarvation: gate(fair.deltas.every(row => Number.isFinite(row.waitedMs)) && jobs.filter(job => job.kind !== "full").every(job => job.closeAt !== undefined || job.dispatchAt !== undefined),
      { deltasDuringFull: fair.deltas.length, maxWaitedMs: fair.deltas.length ? Math.max(...fair.deltas.map(row => row.waitedMs)) : null })
  };
  const tier = name => seeds.filter(row => row.tier === name && row.window === "seed").map(row => row.firstCorrectMs ?? Infinity);
  const singleBuilds = jobs.filter(job => job.kind !== "full" && job.touched === 1 && Number.isFinite(job.runMs)).map(job => job.runMs);
  const editMs = edits.map(row => row.firstCorrectMs ?? Infinity);
  const performance = {
    full: timingItem({ samples: fulls.map(row => row.ms), limit: LIMITS.fullMs, p: 0.5, min: LIMITS.fullSamples, idle: fulls.length > 0 && fulls.every(row => row.idle) }),
    seedLe20: timingItem({ samples: tier("le20"), limit: LIMITS.seedMs.le20, min: LIMITS.seedSamples, idle: idle("seed") }),
    seedTo200: timingItem({ samples: tier("to200"), limit: LIMITS.seedMs.to200, min: LIMITS.seedSamples, idle: idle("seed") }),
    queuedDuringFull: timingItem({ samples: fair.deltas.map(row => row.waitedMs), limit: LIMITS.queuedP95Ms, strictMax: LIMITS.queuedMaxMs, min: 1, idle: idle("fairness") }),
    fullHandoff: timingItem({ samples: fair.handoffs.map(row => row.handoffMs), limit: LIMITS.fullHandoffMs, p: 1, min: 1, idle: idle("fairness") }),
    singleFileBuild: timingItem({ samples: singleBuilds, limit: LIMITS.singleBuildP95Ms, min: LIMITS.editRounds, idle: idle("edits") }),
    editFirstCorrect: timingItem({ samples: editMs, limit: LIMITS.editP95Ms, min: LIMITS.editRounds, idle: idle("edits") }),
    heartbeat: timingItem({ samples: gaps.map(row => row.gapMs), limit: LIMITS.heartbeatGapMs, p: 1, min: 1, idle: true }),
    statusStartFalse: timingItem({ samples: statusSamples, limit: LIMITS.statusP99Ms, p: 0.99, min: LIMITS.statusSamples, idle: idle("status") }),
    physicalZero: physicalZero(physical),
    physical20: physicalItem(physical, 20),
    physical200: physicalItem(physical, 200)
  };
  const hardPass = Object.values(hard).every(item => item.verdict === "PASS");
  const performanceReady = Object.values(performance).every(item => item.verdict === "PASS");
  return {
    gateId: "G11", status: quick ? "DIAGNOSTIC_ONLY" : hardPass ? "PASS" : "FAIL", hardGates: hard, performance, performanceReady,
    performanceNote: "performance items are measured and recorded as PASS/FAIL/INVALID_EXPERIMENT; measurement completion is not a performance pass",
    profiles: profiles(jobs, rounds), process: processProfile(telemetry),
    deltaCalibration: deltaCalibration(jobs, rounds, { limit: deltaClosureLimit ?? 400, fullMs: nearestRank(fulls.map(row => row.ms), 0.5) }), jobs: jobs.map(({ stages, ...job }) => ({ ...job, stages })), fairness: fair, heartbeat: stats(gaps.map(row => row.gapMs)), heartbeatEmit: stats(gaps.map(row => row.emitGapMs).filter(Number.isFinite))
  };
}

function physicalZero(physical) {
  const rows = physical.filter(row => row.files === 0);
  const ok = rows.length >= LIMITS.physicalRounds && rows.every(row => row.newSnapshots === 0 && row.jobs === 0 && row.kind === "seed-bind");
  return { verdict: ok ? "PASS" : "FAIL", n: rows.length, minSamples: LIMITS.physicalRounds, rows };
}

/** Net physical growth against the same-input fresh full: volume deltas with dry-run noise correction, page diff as support. */
function physicalItem(physical, files) {
  const rows = physical.filter(row => row.files === files);
  const limit = LIMITS.physicalRatio[files];
  const pages = rows.map(row => row.pageRatio).filter(Number.isFinite);
  const base = { n: rows.length, minSamples: LIMITS.physicalRounds, limit, pageRatio: stats(pages), rows };
  if (rows.length < LIMITS.physicalRounds) return { ...base, verdict: "FAIL", reason: `${rows.length} rounds < ${LIMITS.physicalRounds}` };
  if (rows.some(row => !row.volumeValid)) return { ...base, verdict: "INVALID_EXPERIMENT", reason: "volume-allocation noise exceeds the measured difference in at least one round",
    pageRatioMedian: nearestRank(pages, 0.5), pageRatioWithinLimit: nearestRank(pages, 0.5) <= limit };
  const ratios = rows.map(row => row.volumeRatio);
  const median = nearestRank(ratios, 0.5);
  return { ...base, verdict: median <= limit ? "PASS" : "FAIL", volumeRatio: stats(ratios), value: median };
}

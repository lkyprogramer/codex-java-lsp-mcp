import test from "node:test";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, realpath, rm, stat, statfs, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { childPids, closeRecoveryOwner, command, copyEvidence, eventually, evidence, processAlive, startRecoveryOwner } from "./ilv2-mac-recovery-fixture.mjs";
import { execute, readJson, relevantInput, sha256, verifyFrozenInput } from "./ilv2-mac-contracts.mjs";
import { hostLoad, historyTierState } from "./ilv2-mac-full-delta.mjs";
import { LIMITS, analyze, auditEvidence, deltaCalibration, fairness, healthyKills, heartbeatGaps, jobsFrom, nearestRank, processProfile, resourcePeaks, seedTier, timingItem, unboundedCalls } from "./ilv2-mac-system-loop.mjs";

// pageDiff reads every page through synchronous dbstat (seconds on a full index); in this process it would stall the event
// loop and inflate the elapsed of any request in flight, so it runs in a child.
const pageDiff = async (before, after) => JSON.parse((await execute(process.execPath, [...process.execArgv.filter(arg => !arg.startsWith("--test")), "--input-type=module", "-e",
  `import { pageDiff } from ${JSON.stringify(new URL("./ilv2-mac-snapshot-equivalence.mjs", import.meta.url).href)}; process.stdout.write(JSON.stringify(await pageDiff(process.argv[1], process.argv[2])));`,
  before, after], { maxBuffer: 16 * 1024 * 1024 })).stdout);

// ---------------------------------------------------------------- analysis (always runs)

const at = (ms, type, event, pid = 100) => ({ at: ms, pid, type, event });
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

test("analyze keeps hard gates separate from measured performance and never calls measurement a pass", () => {
  const verdict = analyze({ calls: [], telemetry: [], edits: [{ id: 1, firstCorrectMs: 100, firstCorrect: 1 }], seeds: [], physical: [], fulls: [], statusSamples: [1],
    loads: {}, versions: {}, injectedPids: [], negatives: [], faults: [], restart: { ok: true }, lifecycle: { ok: true } });
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.performanceReady, false);
  assert.equal(verdict.performance.editFirstCorrect.verdict, "FAIL", "1 round < 20");
  assert.equal(verdict.performance.physical20.verdict, "FAIL");
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
const SEED_PLAN = QUICK
  ? { zero: 1, k: [[1, 1], [4, 1], [6, 1], [30, 1]], exact200: 1, atLimit: [225] }
  // Tiers follow each round's own changed+deleted; HEAD~12 and deeper land in 21-200, so they carry the ≥20 samples that tier needs.
  : { zero: 3, k: [[1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 3], [8, 3], [10, 3], [12, 5], [15, 2], [20, 4], [25, 4], [30, 4]], exact200: 3, atLimit: [200, 225, 250] };
const EDIT_ROUNDS = QUICK ? { java: 3, xml: 2 } : { java: 20, xml: 10 };
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
  async poll() {
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
    limits: LIMITS, pollMs: POLL_MS, stopMs: STOP_MS, requestDeadlines: { status: STATUS_DEADLINE_MS, query: QUERY_DEADLINE_MS }, worktrees: [], seedPlan: SEED_PLAN, editRounds: EDIT_ROUNDS,
    deltaClosureLimit: (await import("../dist/index-builder/build-scheduler.js")).DELTA_CLOSURE_LIMIT, gcCycleMs: GC_CYCLE_MS,
    disclosed: ["seed samples are APFS-cloned plain directories of the main copy patched to first-parent commits (no .git), not git worktrees",
      "the six worktrees are real `git worktree add` checkouts in the run copy", "only lishu-v2 is in scope for MAC-11 (the other repos are G08C/G14)"] };
  let main, mainRepo;
  const owner = await startRecoveryOwner(t, "mac11", { gcCycleMs: GC_CYCLE_MS,
    env: { JAVA_LSP_OWNER_TELEMETRY: telemetryFile, ILV2_NATIVE_TEST_HOOKS: "1" },
    repos: async dir => {
      mainRepo = path.join(dir, "lishu-v2");
      await execute("/bin/cp", ["-c", "-R", record.repoRoot, mainRepo]);
      return [mainRepo];
    } });
  let http, statusClient;
  try {
    // The job starts at load; its HTTP endpoint is served only once this incarnation is ready.
    await owner.incarnation();
    http = await owner.http();
    statusClient = await owner.http();
  } catch (error) { await closeRecoveryOwner(owner).catch(() => {}); throw error; }
  let requestSeq = 0;
  let phase = "setup";
  let window = "normal";
  const workspaces = new Map();

  const load = () => ({ at: Date.now(), ...hostLoad() });
  const loadTimer = setInterval(() => state.loadSamples.push(load()), 5000);
  loadTimer.unref();
  const begin = name => { phase = name; state.phases.push({ name, startedAt: Date.now(), load: load() }); state.loads[name] = { start: load() }; };
  const end = name => { state.loads[name].end = load(); state.phases.find(row => row.name === name).endedAt = Date.now(); };

  async function tool(client, ws, name, args, extra = {}) {
    const requestId = ++requestSeq;
    const startedAt = Date.now(), started = performance.now();
    let text = "", value, error;
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
      text = result.content?.[0]?.text ?? "";
      if (result.isError) error = text; else value = JSON.parse(text);
    } catch (caught) { error = caught.message; }
    const elapsedMs = performance.now() - started;
    const row = { requestId, phase, window, workspace: ws?.name, tool: name, query: args.query, token: extra.token, deadlineMs: name === "java_status" ? STATUS_DEADLINE_MS : QUERY_DEADLINE_MS,
      startedAt, elapsedMs, status: error ? "error" : "ok", ...(error ? { error: String(error).slice(0, 400) } : {}), payloadBytes: Buffer.byteLength(text),
      exact: value?.exact, scopeState: value?.scopeState, stopReason: value?.stopReason, reasons: value?.reasons, droppedStale: value?.droppedStale, repoHash: value?.repoHash, generation: value?.generation,
      indexView: value?.indexView, candidates: (value?.candidates ?? []).map(candidate => ({ name: candidate.declaration?.name, fqn: candidate.declaration?.fqn, matchedBy: candidate.matchedBy,
        declaration: candidate.declaration && { relativePath: candidate.declaration.relativePath, contentHash: candidate.declaration.contentHash },
        evidence: candidate.evidenceRange && { relativePath: candidate.evidenceRange.relativePath, contentHash: candidate.evidenceRange.contentHash } })).concat(
        // operation=evidence: the anchor (the Java declaration) and each served XML unit are audited like a candidate's refs.
        (value?.units ?? []).map(unit => ({ declaration: value.anchor && { relativePath: value.anchor.relativePath, contentHash: value.anchor.contentHash },
          evidence: { relativePath: unit.path, contentHash: unit.contentHash } }))) };
    state.calls.push(row);
    await appendFile(callsFile, `${JSON.stringify(row)}\n`);
    return { row, value };
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
      const { row, value } = await tool(client(), ws, "java_symbol", oracle.args, { token: oracle.token });
      if (oracle.correct(value)) { row.firstCorrect = true; return { ms: performance.now() - from, requestId: row.requestId }; }
      if (performance.now() - from > stopMs) return { ms: Infinity, censored: true, last: { exact: value?.exact, scopeState: value?.scopeState, error: row.error } };
      await delay(pollMs);
    }
  }
  async function negative(ws, oracle, label) {
    const { row, value } = await tool(http, ws, "java_symbol", oracle.args, { token: oracle.token });
    const ok = oracle.correct(value);
    state.negatives.push({ label, workspace: ws.name, token: oracle.token, ok, requestId: row.requestId, exact: value?.exact, scopeState: value?.scopeState });
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
        const { row } = await tool(statusClient, ws, "java_status", { repoRoot: ws.root });
        if (row.status === "ok") state.statusSamples.push(row.elapsedMs);
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

    const fullOf = async (ws, sinceEpoch, label) => {
      const job = await telemetry.waitFor(row => row.type === "scheduler" && row.event.type === "closed" && row.event.workspaceId === ws.workspaceId && row.event.kind === "full"
        && row.at >= sinceEpoch && row.event.code === 0, FULL_STOP_MS);
      const dispatched = job && [...telemetry.rows].reverse().find(row => row.type === "scheduler" && row.event.type === "dispatched" && row.event.pid === job.event.pid);
      const round = job && await roundOf(ws, job.at - 1, row => row.outcome === "published", 120000);
      const idle = Boolean(dispatched) && [loadNear(dispatched.at), loadNear(job.at)].every(sample => sample && sample.perCpu <= LIMITS.idleLoadPerCpu);
      const row = { label, workspace: ws.name, pid: job?.event.pid, ms: job ? job.event.runMs : Infinity, roundMs: round?.elapsedMs, files: round?.changed, idle,
        loadAtDispatch: dispatched && loadNear(dispatched.at), loadAtClose: job && loadNear(job.at), timings: round?.timings };
      state.fulls.push(row);
      return row;
    };
    const loadNear = epoch => state.loadSamples.reduce((best, sample) => (!best || Math.abs(sample.at - epoch) < Math.abs(best.at - epoch) ? sample : best), undefined);

    begin("main");
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
      const snapshotsBefore = (await owner.storeObjects()).snapshots;
      const noiseStart = await freeBytes(ws.root);
      await delay(NOISE_MS);
      const noiseEnd = await freeBytes(ws.root);
      const before = load();
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
      const after = load();
      const sample = { id: ws.name, label, commit, files, tier: round ? seedTier((round.changed ?? 0) + (round.deleted ?? 0)) : "unknown", window: "seed",
        firstCorrectMs: first.ms, firstCorrect: Number.isFinite(first.ms) ? first.requestId : undefined, censored: first.censored ? first.last : undefined,
        waitBaseMs: Math.max(0, baseAvailableAt - startEpoch), kind: round?.kind, changed: round?.changed, deleted: round?.deleted, seedFrom: round?.seedFrom,
        roundMs: round?.elapsedMs, timings: round?.timings, outcome: round?.outcome, jobs: jobs.length, snapshotId: binding?.snapshotId, loadStart: before, loadEnd: after };
      state.seeds.push(sample);
      if (files !== undefined) {
        const snapshotsAfter = (await owner.storeObjects()).snapshots;
        let pageRatio;
        if (binding && round?.seedFrom && binding.snapshotId !== round.seedFrom) {
          const pages = await pageDiff(path.join(owner.mac1, "snapshots", round.seedFrom, "index.sqlite"), path.join(owner.mac1, "snapshots", binding.snapshotId, "index.sqlite"));
          pageRatio = pages.changed / mainPages;
        }
        const fullGrowth = state.main.volumeGrowthBytes;
        state.physical.push({ id: ws.name, files, kind: round?.kind, jobs: jobs.length, newSnapshots: snapshotsAfter.filter(id => !snapshotsBefore.includes(id)).length,
          volumeGrowthBytes: grown, noiseBytes: noise, volumeRatio: fullGrowth > 0 ? grown / fullGrowth : undefined,
          volumeValid: files === 0 ? true : fullGrowth > 0 && noise < LIMITS.physicalRatio[files] * fullGrowth, pageRatio, fullGrowthBytes: fullGrowth });
      }
      // The sample's token is not visible from main (cross-workspace negative).
      if (target) await negative(main, javaMiss(main, target.shape, target.token), `sample-${n}-not-in-main`);
      return sample;
    }
    if (PHASES.has("seed")) {
      begin("seed");
      for (let index = 0; index < SEED_PLAN.zero; index += 1) await seedSample({ commit: "HEAD", rows: [], label: "zero", files: 0 });
      for (const [depth, count] of SEED_PLAN.k) {
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
      for (let index = 0; index < SEED_PLAN.exact200; index += 1) await seedSample({ commit: commit50, rows: exact, label: "HEAD~50/200-java", files: 200 });
      // Near the delta closure limit itself: deltaMaxTouched is judged on measured deltas whose dependency closure (changed +
      // name dependents, not the changed count) approaches it; a set past it escalates and records that closure instead.
      const commit100 = (await git(main.root, ["rev-parse", "HEAD~100"])).trim();
      const java100 = (await diffRows(main.root, commit100)).filter(row => row.path.endsWith(".java")).sort((a, b) => a.path.localeCompare(b.path));
      for (const size of SEED_PLAN.atLimit) {
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
      const startEpoch = Date.now();
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
          window: "seed", firstCorrectMs: first.ms, firstCorrect: Number.isFinite(first.ms) ? first.requestId : undefined, kind: round?.kind, changed: round?.changed,
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
      const before = load();
      const editEpoch = Date.now();
      const tEdit = performance.now();
      const result = await apply();
      const first = await firstCorrect(ws, oracleFor(result), { from: tEdit });
      const round = await roundOf(ws, editEpoch, row => row.outcome === "published", STOP_MS);
      const row = { id, workspace: ws.name, kind, label, window, firstCorrectMs: first.ms, firstCorrect: Number.isFinite(first.ms) ? first.requestId : undefined,
        censored: first.censored ? first.last : undefined, publishMs: round?.boundAt ? round.boundAt - editEpoch : undefined, roundKind: round?.kind, changed: round?.changed,
        timings: round?.timings, roundMs: round?.elapsedMs, loadStart: before, loadEnd: load() };
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
          ids: Array.from({ length: EDIT_ROUNDS.xml + 1 }, (_, index) => `mac11${tag}Stmt${pad(index)}`) };
        mappers[ws.name] = mapper;
        mapper.round = 0;
        await write(ws, mapper.java, `package ilv2mac11;\n\npublic interface Mac11Mapper {\n${mapper.ids.map(id => `  int ${id}();\n`).join("")}}\n`, mapper.ids);
        const hash = await write(ws, mapper.xml, mapperXml(mapper, mapper.ids[0]), [mapper.ids[0]]);
        mapper.setup = await firstCorrect(ws, xmlOracle(ws, mapper, mapper.ids[0], hash), { stopMs: STOP_MS });
        plan.mapper = { moduleRootSha256: sha256(Buffer.from(moduleRoot)), java: "…/src/main/java/ilv2mac11/Mac11Mapper.java", xml: "…/src/main/resources/ilv2mac11/Mac11Mapper.xml" };
      }
      const order = ["w1", "w2", "w3", "w4", "w5"];
      let javaRounds = 0, xmlRounds = 0;
      while (javaRounds < EDIT_ROUNDS.java || xmlRounds < EDIT_ROUNDS.xml) {
        if (javaRounds < EDIT_ROUNDS.java) {
          const ws = wt[order[javaRounds % order.length]];
          const token = `ilv2Mac11E${pad(++javaRounds)}`;
          const previous = ws.lastJava;
          await javaEdit(ws, token);
          ws.lastJava = token;
          if (previous) await negative(ws, javaMiss(ws, R.shape, previous), `${ws.name}-replaced-${previous}`);
          for (const other of order.map(name => wt[name]).filter(item => item !== ws).slice(0, 1)) await negative(other, javaMiss(other, R.shape, token), `${token}-not-in-${other.name}`);
        }
        if (xmlRounds < EDIT_ROUNDS.xml && (javaRounds % 2 === 0 || javaRounds >= EDIT_ROUNDS.java)) {
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
        const tEdit = performance.now();
        // No top-level type survives: the file's parse state is FAILED, not RECOVERED.
        await write(w3, R.relativePath, `package ${R.shape.pkg};\n\n<<< ilv2-mac11 ${broken} >>>\n`, []);
        const hash = await write(w3, R2.relativePath, withMethod(r2.text, valid), [valid]);
        const servedValid = await firstCorrect(w3, javaOracle(w3, R2.shape, R2.relativePath, valid, hash), { from: tEdit });
        const { value: partial } = await tool(http, w3, "java_symbol", javaMiss(w3, R.shape, "ilv2Mac11Absent").args);
        const fixed = "ilv2Mac11Fixed1";
        const fixedHash = await write(w3, R.relativePath, withMethod(javaBase.w3.text, fixed), [fixed]);
        const restored = await firstCorrect(w3, javaOracle(w3, R.shape, R.relativePath, fixed, fixedHash));
        const ready = await negative(w3, javaMiss(w3, R.shape, "ilv2Mac11Absent"), "bad-syntax-fixed-ready-miss");
        state.faults.push({ name: "bad-syntax", ok: Number.isFinite(servedValid.ms) && partial?.exact !== "match" && partial?.scopeState === "PARTIAL" && Number.isFinite(restored.ms) && ready,
          validMs: servedValid.ms, partial: { exact: partial?.exact, scopeState: partial?.scopeState, stopReason: partial?.stopReason }, restoredMs: restored.ms });
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
      const far = {};
      for (const name of ["w5", "w6"]) {
        far[name] = (await git(main.root, ["rev-parse", `HEAD~${FAR[name]}`])).trim();
        await git(wt[name].root, ["checkout", "--detach", "-q", far[name]]);
      }
      // The far worktrees may have been idle past the runtime TTL since P3: the next request reopens them.
      for (const name of ["w5", "w6"]) await reopen(wt[name]);
      plan.far = Object.fromEntries(Object.entries(far).map(([name, commit]) => [name, { depth: FAR[name], commit }]));
      // The first full dispatched gets killed once it has beaten for 20 s (fault window).
      const firstFull = await telemetry.waitFor(row => row.type === "scheduler" && row.event.type === "dispatched" && row.event.kind === "full" && row.at >= sinceEpoch
        && [wt.w5.workspaceId, wt.w6.workspaceId].includes(row.event.workspaceId), 600000);
      assert.ok(firstFull, "a far checkout escalated to a full");
      const victim = [wt.w5, wt.w6].find(ws => ws.workspaceId === firstFull.event.workspaceId);
      // Short deltas in w1/w2 every 6 s while fulls run (normal window for them).
      const fairnessEdits = (async () => {
        let n = 0;
        const deadline = performance.now() + FULL_STOP_MS;
        while (performance.now() < deadline) {
          await telemetry.poll();
          const closedFulls = telemetry.rows.filter(row => row.type === "scheduler" && row.event.type === "closed" && row.event.kind === "full" && row.at >= sinceEpoch && row.event.code === 0);
          if (closedFulls.length >= 2) break;
          const ws = n % 2 === 0 ? wt.w1 : wt.w2;
          const token = `ilv2Mac11F${pad(++n)}`;
          const { row } = await javaEdit(ws, token);
          row.label = `fairness-${token}`; row.kind = "java-fairness";
          ws.lastJava = token;
          await delay(6000);
        }
      })();
      await delay(20000);
      window = "fault";
      process.kill(firstFull.event.pid, "SIGKILL");
      state.injectedPids.push(firstFull.event.pid);
      const killedClose = await telemetry.waitFor(row => row.type === "scheduler" && row.event.type === "closed" && row.event.pid === firstFull.event.pid, 30000);
      const failedRound = await roundOf(victim, sinceEpoch, row => row.outcome === "failed", 60000);
      window = "normal";
      await fairnessEdits;
      const fulls = [];
      for (const ws of [wt.w5, wt.w6]) fulls.push(await fullOf(ws, sinceEpoch, `${ws.name}-HEAD~${FAR[ws.name]}`));
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
      window = "fault";
      const row = (await owner.readyRows()).at(-1);
      const killedAt = owner.kill(row);
      let exitMs = Infinity;
      try { await eventually(() => !processAlive(-row.pgid), LIMITS.daemonExitMs); exitMs = performance.now() - killedAt; } catch { /* recorded as Infinity */ }
      const next = await owner.incarnation(row.pid);
      http = await owner.http();
      statusClient = await owner.http();
      window = "normal";
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
    await evidence("g11-analysis", verdict);
    if (closeoutError) throw closeoutError;
  }
  if (failure) throw failure;
  const verdict = await readJson(path.join(raw, "g11-analysis.json"));
  for (const [name, item] of Object.entries(verdict.hardGates)) assert.equal(item.verdict, "PASS", `hard gate ${name}: ${JSON.stringify(item).slice(0, 2000)}`);
  assert.equal(verdict.frozenInputUnchanged, true);
});

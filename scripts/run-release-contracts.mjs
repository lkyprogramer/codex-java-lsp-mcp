#!/usr/bin/env node
// input: compiled isolated candidate, frozen K01-K32 matrix and optional real JDT evidence.
// output: complete contract inventory with raw relative paths, hashes and exact execution levels.
// pos: R12 authority wrapper; missing/skip/wrong-candidate evidence never becomes PASS.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectedSubtests } from "./task36-tap-evidence.mjs";
import { verifyRuntime } from "./ilv2-mac-contracts.mjs";
import { assertIsolationOracle, assertReferenceOracle, assertSharedOracle, fixtureDigest } from "./release-jdt-contracts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = value => createHash("sha256").update(value).digest("hex");
const MATRIX_PATH = "docs/java-specialist-release-audit-v1.1/contracts/runtime-matrix.json";
const CURRENT_PATH = "scripts/release-k-contract-matrix.json";
const matrixBytes = readFileSync(path.join(root, MATRIX_PATH));
const matrix = JSON.parse(matrixBytes.toString("utf8"));
// The frozen v1.1 matrix keeps K01–K32; the current overlay names the contract version (MAC-14).
const currentBytes = readFileSync(path.join(root, CURRENT_PATH));
const current = JSON.parse(currentBytes.toString("utf8"));
if (current.baseMatrix?.path !== MATRIX_PATH || current.baseMatrix.sha256 !== sha(matrixBytes)) throw new Error("current K contract matrix is not based on the frozen runtime matrix");
const source = "dist/benchmark/release-source-contracts.test.js";
const mcp = "scripts/release-mcp-contracts.test.mjs";
const view = "dist/java-index/snapshot/request-view.test.js";
const store = "dist/java-index/snapshot/snapshot-store.test.js";
const seed = "dist/java-index/snapshot/owner-seed.test.js";
const gc = "dist/java-index/snapshot/owner-gc.test.js";
const pool = "dist/java-index/snapshot/query-pool.test.js";
const exact = name => "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
/** Contract version of the K setup/oracles (MAC-14, verification §6.2); recorded in every result. */
export const K_CONTRACT_VERSION = current.contractVersion;
/**
 * Each contract runs one or more [test file, name pattern] entries and passes only when every entry
 * selected at least one passing test. MAC-14 moved K03/K06/K11/K20/K21/K24/K30 and K12 onto the owner
 * path: MCP through the owner daemon, or the real IndexOwner with sealed snapshots and query workers.
 */
export const CONTRACT_TESTS = Object.freeze({
  K01: [["dist/java-index/sql/rows.test.js", "^T02: parser-produced same-FQN"]],
  K02: [["dist/java-index/sql/rows.test.js", "^T02: AB and BA write orders"]],
  K03: [[mcp, "^K03:"]],
  K04: [[source, "^K04:"]], K05: [[mcp, "^K05:"]],
  K06: [[mcp, "^K06:"], [view, exact("a workspace without its own verified binding is NOT_READY, never a sibling")]],
  K07: [[source, "^K07:"]], K08: [[source, "^K08:"]],
  K09: [[source, "^K09:"]], K10: [[source, "^K10:"]], K11: [[mcp, "^K11:"]],
  K12: [[mcp, "^K12:"], [view, exact("nonzero-deadline-bounds-all-stages")], [view, exact("a handler that outlives its deadline loses its view and its snapshot lease")]],
  K13: [["dist/java-index/sql/entity-search-intent.test.js", "^T04: a mixed query"]],
  K14: [["dist/java-index/sql/entity-search-bounded.test.js", "^R07: (an exact miss|exact match)"]],
  K15: [[mcp, "^K15:"]],
  K16: [["dist/java-index/builder/r08-evidence.test.js", "^K16/P01:"]],
  K17: [[mcp, "^K17:"]],
  K18: [["dist/java-index/sql/search-docs.test.js", "^K18:"]],
  K19: [[mcp, "^K19:"]],
  K20: [[view, exact("publish-does-not-upgrade-held-view")], [gc, exact("a superseded snapshot under a held lease survives every cycle and goes within two cycles of the release")]],
  K21: [[seed, "^K21:"]],
  K22: [[source, "^K22:"]], K23: [[source, "^K23:"]],
  K24: [["dist/index-builder/integrity.test.js", "^K24:"], [view, "^K24:"]],
  K25: [[mcp, "^K25:"]], K27: [[mcp, "^K27:"]],
  K30: [[store, exact("a snapshot with a WAL, SHM or journal sidecar is not a sealed snapshot")],
    [store, exact("a sealed candidate is in flight until finished, and a reader lease keeps its view across publishes")],
    [store, exact("no lease of any purpose loses its snapshot to a sweep; the last release makes it reclaimable")],
    [pool, exact("a worker's leases follow the connections it reports open")],
    [gc, exact("a superseded snapshot under a held lease survives every cycle and goes within two cycles of the release")]],
  K31: [[source, "^K31:"]], K32: [[source, "^K32:"]]
});

export function candidateIdentity(cwd = root) {
  const git = args => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error("cannot bind candidate git identity");
    return result.stdout;
  };
  const files = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))]
    .filter(file => /^(src\/|scripts\/|fixtures\/|native\/|package(?:-lock)?\.json$|tsconfig\.json$|install-runtime\.sh$)/.test(file)).sort();
  const hashes = files.map(file => [file, existsSync(path.join(cwd, file)) ? sha(readFileSync(path.join(cwd, file))) : "DELETED"]);
  return { baseSha: git(["rev-parse", "HEAD"]).trim(), sourceDigest: sha(JSON.stringify(hashes)), files: hashes.length, dirty: git(["status", "--porcelain"]).trim().length > 0, lockfileHash: sha(readFileSync(path.join(cwd, "package-lock.json"))) };
}

/** A contract with several entries passes only when every entry passed; each entry stays visible. */
export function combinedEvidence(parts) {
  const status = parts.length > 0 && parts.every(part => part.status === "PASS") ? "PASS" : "FAIL";
  return parts.length === 1 ? parts[0] : { status, parts, selected: parts.flatMap(part => part.selected) };
}

export function testEvidence(result, pattern) {
  const selected = selectedSubtests(result.stdout + "\n" + result.stderr, pattern);
  const passed = result.exitCode === 0 && !result.timedOut && selected.length > 0 && selected.every(test => test.status === "passed" && !test.directive);
  return { status: passed ? "PASS" : "FAIL", selected, exitCode: result.exitCode, timedOut: result.timedOut };
}

/** MAC-08C: K29 is measured on the public request path only (measure-request-load.ts). */
export const K29_REQUEST_PROTOCOL = "k29-request-path-v2";

/**
 * Static steps: request latency p95 <= 150 ms. With updates (MAC-08C split, owner-approved): the
 * service time after prepare p95 <= 150 ms, and the prepare wait itself is judged on its own contract
 * (capped at 1000 ms, p95 <= 1000 ms) instead of inside the 150 ms. Event loop p95 <= 20 ms everywhere.
 */
export function loadEvidenceGate(report) {
  const steps = report?.steps ?? [];
  const peak = steps.find(step => step.concurrency === 20);
  const updates = report?.withUpdates;
  const all = [...steps, ...(updates ? [updates] : [])];
  const complete = all.length >= 3 && peak?.requests >= 100 && all.every(step => step.settled && step.worker.queuePeak <= 32 && step.requests > 0);
  // The load must pass the request view, the query pool (IPC workers) and previews; a report from the
  // retired in-process SQL driver (protocol p3-capacity-v1) cannot stand in for it.
  const requestPath = report?.protocol === K29_REQUEST_PROTOCOL && all.length > 0
    && all.every(step => step.errors === 0 && step.worker.submits >= step.requests && step.worker.pids?.length >= 1 && step.previews > 0 && step.prepareUnattributed === 0)
    && updates?.publishes >= 1;
  const within = (value, limit) => Number.isFinite(value) && value <= limit;
  const loop = all.length > 0 && all.every(step => within(step.eventLoopDelayMs?.p95, 20));
  const staticSlo = steps.length > 0 && steps.every(step => within(step.latencyMs?.p95, 150));
  const updatesSlo = within(updates?.serviceMs?.p95, 150) && within(updates?.prepareMs?.p95, 1000);
  const slo = loop && staticSlo && updatesSlo;
  return { status: complete && requestPath && slo ? "PASS" : "FAIL", protocol: report?.protocol ?? null, mechanismPass: !!complete, requestPathPass: !!requestPath, performancePass: slo,
    warmStaticP95LimitMs: 150, withUpdatesServiceP95LimitMs: 150, withUpdatesPrepareP95LimitMs: 1000, eventLoopP95LimitMs: 20,
    withUpdates: updates ? { latencyMs: updates.latencyMs, serviceMs: updates.serviceMs, prepareMs: updates.prepareMs, prepareOutcomes: updates.prepareOutcomes } : null, steps: all };
}

/**
 * Exit status and summary for a run. With --cases, unselected contracts stay NOT_RUN: the run passes
 * when every selected contract passed, but it never claims the full K set.
 */
export function contractOutcome(rows, selected, candidateDrift = false) {
  const chosen = rows.filter(row => selected.includes(row.id));
  const summary = Object.fromEntries(["PASS", "FAIL", "BLOCKED_ENV", "NOT_RUN"].map(state => [state, rows.filter(row => row.status === state).length]));
  const selection = chosen.length === rows.length ? "all" : "selected";
  const selectedPass = chosen.length > 0 && chosen.every(row => row.status === "PASS");
  return {
    exitCode: !candidateDrift && selectedPass ? 0 : 1,
    summary: { ...summary, selection, selected: chosen.map(row => row.id), selectedPass, allContractsPass: selection === "all" && selectedPass && !candidateDrift }
  };
}

export const JDT_EVIDENCE_SCHEMA = "release-real-jdt-evidence/v2";

/**
 * MAC-14: real JDT evidence is accepted only from the owner path (schema v2) for this exact candidate,
 * native binary and fixture; the oracles are the ones the producer asserted, re-checked here.
 */
export function acceptJdtEvidence(payload, identity, id, native = nativeIdentity()) {
  if (payload?.schema !== JDT_EVIDENCE_SCHEMA) return { status: "FAIL", reason: "real JDT evidence is not owner-path " + JDT_EVIDENCE_SCHEMA };
  if (payload.candidateIdentity?.sourceDigest !== identity.sourceDigest) return { status: "FAIL", reason: "real JDT evidence candidate mismatch" };
  if (payload.nativeBinarySha256 !== native.binarySha256 || payload.nativeSourceDigest !== native.sourceDigest) return { status: "FAIL", reason: "real JDT evidence native mismatch" };
  if (payload.fixtureDigest !== fixtureDigest) return { status: "FAIL", reason: "real JDT evidence fixture mismatch" };
  const row = payload[id];
  if (row?.status !== "PASS" || !row.evidence) return { status: "FAIL", reason: "missing real JDT result" };
  const e = row.evidence;
  try {
    if (id === "K26") {
      const summary = e.enabled?.locator?.summary;
      if (!(e.disabled?.isError === true && /--enable-lsp/.test(e.disabled.message ?? "") && e.disabled.status?.lsp?.enabled === false && e.disabled.status?.started === false &&
        summary?.candidates > 0 && summary.errors === 0 && summary.selectionResolvesDeclaration === summary.candidates)) throw new Error("enablement or locator oracle missing");
      assertReferenceOracle(e.enabled.references);
      const isolation = e.enabled.isolation;
      assertIsolationOracle({ a: isolation?.a ?? {}, b: isolation?.b ?? {} });
      assertReferenceOracle(isolation.references?.a ?? {}); assertReferenceOracle(isolation.references?.b ?? {});
      if (!isolation.sessions?.a?.repoHash || isolation.sessions.a.repoHash === isolation.sessions.b?.repoHash) throw new Error("worktrees share a JDT session");
    }
    if (id === "K28") assertSharedOracle(e);
  } catch (error) {
    return { status: "FAIL", reason: (id === "K26" ? "real definition/reference, enablement or isolation oracle: " : "shared real JDT waiter oracle: ") + error.message };
  }
  return { status: "PASS", observed: row.evidence };
}

/** Digest of every driver this runner executes: itself, each contract test file, the JDT and load drivers. */
export function driverDigests(cwd = root) {
  const files = [...new Set(["scripts/run-release-contracts.mjs", "scripts/release-jdt-contracts.mjs", "scripts/run-isolated-jdt-benchmark.mjs", "dist/benchmark/measure-request-load.js",
    ...Object.values(CONTRACT_TESTS).flatMap(entries => entries.map(([file]) => file))])].sort();
  return Object.fromEntries(files.map(file => [file, existsSync(path.join(cwd, file)) ? sha(readFileSync(path.join(cwd, file))) : "MISSING"]));
}

export function nativeIdentity(cwd = root) {
  const manifest = JSON.parse(readFileSync(path.join(cwd, "dist/native/manifest.json"), "utf8"));
  return { binarySha256: manifest.binarySha256, sourceDigest: manifest.sourceDigest };
}

function execute(args, timeoutMs = 90000) {
  return new Promise(resolve => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const grouped = process.platform !== "win32";
    const child = spawn(process.execPath, args, { cwd: root, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    let timedOut = false, killTimer, spawnError;
    const kill = signal => { try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch (error) { if (error.code !== "ESRCH") spawnError = error.message; } };
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), 1000); }, timeoutMs);
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.once("error", error => { spawnError = error.message; });
    child.once("close", code => { clearTimeout(timer); clearTimeout(killTimer); resolve({ exitCode: code, timedOut, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() + (spawnError ?? "") }); });
  });
}

async function main(argv) {
  await verifyRuntime();
  const value = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
  if (!argv.includes("--isolated") || process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") throw new Error("run with --isolated inside run-isolated-validation");
  if (!value("--output")) throw new Error("--output is required");
  const output = path.resolve(value("--output"));
  if (output === root || output.startsWith(root + path.sep)) throw new Error("evidence output must be outside candidate");
  if (existsSync(path.join(output, "k-contract-results.json"))) throw new Error("previous evidence is immutable; use a new output directory");
  mkdirSync(path.join(output, "raw"), { recursive: true });
  const before = candidateIdentity();
  const selected = value("--cases")?.split(",") ?? matrix.contracts.map(row => row.id);
  if (selected.some(id => !matrix.contracts.some(row => row.id === id))) throw new Error("unknown contract id");
  const evidence = (rel, bytes) => { writeFileSync(path.join(output, rel), bytes); return { path: rel, sha256: sha(bytes) }; };
  const rows = [];
  for (const contract of matrix.contracts) {
    const row = { id: contract.id, level: contract.requiredLevel, expected: contract.oracle, status: "NOT_RUN", evidence: [] };
    if (!selected.includes(contract.id)) { rows.push(row); continue; }
    if (CONTRACT_TESTS[contract.id]) {
      const parts = [];
      for (const [index, [file, pattern]] of CONTRACT_TESTS[contract.id].entries()) {
        const args = ["--test", "--test-concurrency=1", "--test-name-pattern=" + pattern, file];
        const result = await execute(args, 300000);
        const suffix = CONTRACT_TESTS[contract.id].length > 1 ? `.${index + 1}` : "";
        parts.push({ file, pattern, ...testEvidence(result, pattern), command: [process.execPath, ...args] });
        row.evidence.push(evidence(`raw/${row.id}${suffix}.stdout.log`, result.stdout), evidence(`raw/${row.id}${suffix}.stderr.log`, result.stderr));
      }
      Object.assign(row, combinedEvidence(parts));
      if (row.id === "K27") row.scope = "disabled production integration: lexical remains usable, zero fetches; no nonexistent automatic dense fallback is claimed";
    } else if (contract.id === "K29") {
      const out = path.join(output, "raw", "load");
      const args = ["dist/benchmark/measure-request-load.js", "--files", "1000", "--samples", "100", "--steps", "1,5,20", "--output", out];
      const result = await execute(args, 600000);
      row.evidence.push(evidence("raw/K29.stdout.log", result.stdout), evidence("raw/K29.stderr.log", result.stderr));
      const reportPath = path.join(out, "query-request-load-report.json");
      if (result.exitCode !== 0 || !existsSync(reportPath)) Object.assign(row, { status: "FAIL", exitCode: result.exitCode });
      else {
        Object.assign(row, loadEvidenceGate(JSON.parse(readFileSync(reportPath, "utf8"))));
        row.evidence.push({ path: "raw/load/query-request-load-report.json", sha256: sha(readFileSync(reportPath)) });
      }
      row.command = [process.execPath, ...args];
      row.scope = "fixed generated 1000-file corpus through the public request path; measured here, not an all-repository capacity claim";
    } else if (contract.id === "K26" || contract.id === "K28") {
      const input = value("--jdt-evidence");
      if (!input) { row.status = "BLOCKED_ENV"; row.reason = "real JDT evidence not provided"; }
      else if (!existsSync(input)) { row.status = "BLOCKED_ENV"; row.reason = "real JDT evidence file missing: " + input; }
      else {
        const raw = readFileSync(input);
        Object.assign(row, acceptJdtEvidence(JSON.parse(raw), before, contract.id));
        row.evidence.push(evidence(`raw/${row.id}.real-jdt.json`, raw));
      }
    }
    rows.push(row);
    console.log(JSON.stringify({ id: row.id, status: row.status, level: row.level }));
  }
  const after = candidateIdentity();
  const candidateDrift = before.sourceDigest !== after.sourceDigest;
  const outcome = contractOutcome(rows, selected, candidateDrift);
  const result = { schema: "java-specialist-k-contract-results/v2", contractVersion: K_CONTRACT_VERSION, candidateIdentity: before, native: nativeIdentity(),
    matrix: { path: MATRIX_PATH, sha256: sha(matrixBytes) }, currentMatrix: { path: CURRENT_PATH, sha256: sha(currentBytes) }, drivers: driverDigests(), candidateDrift, generatedAt: new Date().toISOString(), contracts: rows, summary: outcome.summary };
  writeFileSync(path.join(output, "k-contract-results.json"), JSON.stringify(result, null, 2) + "\n");
  process.exitCode = outcome.exitCode;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });

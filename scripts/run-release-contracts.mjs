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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = value => createHash("sha256").update(value).digest("hex");
const matrix = JSON.parse(readFileSync(path.join(root, "docs/java-specialist-release-audit-v1.1/contracts/runtime-matrix.json"), "utf8"));
const source = "dist/benchmark/release-source-contracts.test.js";
const index = "dist/benchmark/release-index-contracts.test.js";
const mcp = "scripts/release-mcp-contracts.test.mjs";
export const CONTRACT_TESTS = Object.freeze({
  K01: ["dist/java-index/sql/rows.test.js", "^T02: parser-produced same-FQN"],
  K02: ["dist/java-index/sql/rows.test.js", "^T02: AB and BA write orders"],
  K03: [index, "^K03:"], K04: [source, "^K04:"], K05: [mcp, "^K05:"],
  K06: [index, "^K06:"], K07: [source, "^K07:"], K08: [source, "^K08:"],
  K09: [source, "^K09:"], K10: [source, "^K10:"], K11: [index, "^K11:"],
  K12: [mcp, "^K12:"],
  K13: ["dist/java-index/sql/entity-search-intent.test.js", "^T04: a mixed query"],
  K14: ["dist/java-index/sql/entity-search-bounded.test.js", "^R07: (an exact miss|exact match)"],
  K15: [mcp, "^K15:"],
  K16: ["dist/java-index/builder/r08-evidence.test.js", "^K16/P01:"],
  K17: [mcp, "^K17:"],
  K18: ["dist/java-index/sql/search-docs.test.js", "^K18:"],
  K19: [mcp, "^K19:"], K20: [index, "^K20:"], K21: [index, "^K21:"],
  K22: [source, "^K22:"], K23: [source, "^K23:"],
  K24: ["dist/index-builder/integrity.test.js", "^K24:"],
  K25: [mcp, "^K25:"], K27: [mcp, "^K27:"], K30: [index, "^K30:"],
  K31: [source, "^K31:"], K32: [source, "^K32:"]
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

export function testEvidence(result, pattern) {
  const selected = selectedSubtests(result.stdout + "\n" + result.stderr, pattern);
  const passed = result.exitCode === 0 && !result.timedOut && selected.length > 0 && selected.every(test => test.status === "passed" && !test.directive);
  return { status: passed ? "PASS" : "FAIL", selected, exitCode: result.exitCode, timedOut: result.timedOut };
}

/** MAC-08C: K29 is measured on the public request path only (measure-request-load.ts). */
export const K29_REQUEST_PROTOCOL = "k29-request-path-v1";

export function loadEvidenceGate(report) {
  const steps = report?.steps ?? [];
  const peak = steps.find(step => step.concurrency === 20);
  const all = [...steps, ...(report?.withUpdates ? [report.withUpdates] : [])];
  const complete = all.length >= 3 && peak?.requests >= 100 && all.every(step => step.settled && step.worker.queuePeak <= 32 && step.requests > 0);
  // The load must pass the request view, the query pool (IPC workers) and previews; a report from the
  // retired in-process SQL driver (protocol p3-capacity-v1) cannot stand in for it.
  const requestPath = report?.protocol === K29_REQUEST_PROTOCOL && all.length > 0
    && all.every(step => step.errors === 0 && step.worker.submits >= step.requests && step.worker.pids?.length >= 1 && step.previews > 0)
    && report.withUpdates?.publishes >= 1;
  const slo = all.length > 0 && all.every(step => Number.isFinite(step.latencyMs?.p95) && step.latencyMs.p95 <= 150 && Number.isFinite(step.eventLoopDelayMs?.p95) && step.eventLoopDelayMs.p95 <= 20);
  return { status: complete && requestPath && slo ? "PASS" : "FAIL", protocol: report?.protocol ?? null, mechanismPass: !!complete, requestPathPass: !!requestPath, performancePass: slo, warmStaticP95LimitMs: 150, eventLoopP95LimitMs: 20, steps: all };
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

export function acceptJdtEvidence(payload, identity, id) {
  if (payload?.candidateIdentity?.sourceDigest !== identity.sourceDigest) return { status: "FAIL", reason: "real JDT evidence candidate mismatch" };
  const row = payload[id];
  if (row?.status !== "PASS" || !row.evidence) return { status: "FAIL", reason: "missing real JDT result" };
  const e = row.evidence;
  if (id === "K26" && !(e.disabled?.isError === true && e.disabled.status?.lsp?.enabled === false &&
      e.disabled.status?.started === false && e.enabled?.locator?.summary?.candidates > 0 &&
      e.enabled.locator.summary.errors === 0 &&
      e.enabled.locator.summary.selectionResolvesDeclaration === e.enabled.locator.summary.candidates &&
      e.enabled.references?.groups?.flatMap(group => group.files ?? []).some(file =>
        file.path === "src/main/java/probe/Caller.java" && file.positions?.some(p => p.line === 5 && p.column === 23)))) {
    return { status: "FAIL", reason: "real definition/reference or enablement oracle missing" };
  }
  if (id === "K28" && !(e.shortCode === "DEADLINE_EXCEEDED" && e.backendCalls === 1 &&
      e.whileShortExited?.inflight === 1 && e.whileShortExited.sharedJoins === 1 &&
      e.whileShortExited.abortedNoWaiters === 0 && e.longOutcome?.completion === "COMPLETE" &&
      e.settled?.inflight === 0 && e.settled.completeWrites === 1 && e.settled.abortedNoWaiters === 0)) {
    return { status: "FAIL", reason: "shared real JDT waiter oracle missing" };
  }
  return { status: "PASS", observed: row.evidence };
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
      const [file, pattern] = CONTRACT_TESTS[contract.id];
      const args = ["--test", "--test-concurrency=1", "--test-name-pattern=" + pattern, file];
      const result = await execute(args);
      Object.assign(row, testEvidence(result, pattern), { command: [process.execPath, ...args] });
      row.evidence.push(evidence(`raw/${row.id}.stdout.log`, result.stdout), evidence(`raw/${row.id}.stderr.log`, result.stderr));
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
  const result = { schema: "java-specialist-k-contract-results/v1", candidateIdentity: before, candidateDrift, generatedAt: new Date().toISOString(), contracts: rows, summary: outcome.summary };
  writeFileSync(path.join(output, "k-contract-results.json"), JSON.stringify(result, null, 2) + "\n");
  process.exitCode = outcome.exitCode;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });

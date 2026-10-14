#!/usr/bin/env node
// Gate bookkeeping generator. `manifest` derives the closeout inventory from the
// run root; `compose` turns validation-index.jsonl + closeout.json + a short human
// verdict into task-result.json and upserts status.json, rejecting a PASS that the
// recorded facts do not support. Hand-copied hashes and counts are not accepted.
import { lstat, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAC_WORK_ROOT, cliOptions, isMain, readJson, requireValue, runCli, sha256, writeJson } from "./ilv2-mac-contracts.mjs";
import { ISOLATED_LAUNCHD_LABEL } from "./ilv2-mac-fixture-quota.mjs";
import { GATE_STATUSES, MANUAL_FILE, STATUS_FILE, checkStatus } from "./ilv2-mac-status.mjs";

// Gates whose PASS also needs a second build of the same source (manual §0.2).
export const INDEPENDENT_RERUN_GATES = new Set(["G09", "G11", "G14", "G17"]);
const LOCAL_ALWAYS = ["closeout-manifest.json", "task-result.json"];
// Main runs share one candidate (--reuse), so even the native bytes match; an
// independent rebuild in another root is bound by the native source instead.
const MAIN_IDENTITY = ["sourceDigest", "nativeSha256", "runtimeManifestSha256"];
const REBUILD_IDENTITY = ["sourceDigest", "nativeSourceDigest", "runtimeManifestSha256"];
// Fixtures publish PIDs under several names (pid, childPid, daemonPid, supervisorPid);
// a parent's PID is not ours to wait for.
const PID_KEY = /^(?:pid|[a-z]+Pid|[a-z]+_pid)$/, PGID_KEY = /^(?:pgid|[a-z]+Pgid|[a-z]+_pgid)$/, FOREIGN_PID_KEYS = new Set(["parentPid", "parent_pid"]);

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function evidenceFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /\.(?:jsonl?|plist)$/.test(entry.name)) files.push(file);
    }
  }
  if (await exists(directory)) await visit(directory);
  return files;
}

function jsonValues(text, file) {
  if (file.endsWith(".jsonl")) return text.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  try { return [JSON.parse(text)]; } catch { return []; }
}

/** Owned PIDs/groups/labels published by fixtures and the broker. A group is owned only when its leader is a recorded PID. */
export async function collectOwnedResources(runRoot) {
  const pids = new Map(), groups = new Set(), labels = new Set();
  const files = [...await evidenceFiles(path.join(runRoot, "raw")), path.join(runRoot, "validation-index.jsonl")];
  if (await exists(path.join(runRoot, "tmp"))) {
    for (const entry of await readdir(path.join(runRoot, "tmp"))) files.push(path.join(runRoot, "tmp", entry, "broker-root.json"));
  }
  for (const file of files) {
    let text;
    try { text = await readFile(file, "utf8"); } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) continue; throw error; }
    const source = path.relative(runRoot, file);
    if (file.endsWith(".plist")) {
      for (const [, label] of text.matchAll(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/g)) if (ISOLATED_LAUNCHD_LABEL.test(label)) labels.add(label);
      continue;
    }
    const visit = value => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object") return;
      for (const [key, id] of Object.entries(value)) {
        if (!Number.isInteger(id) || id <= 1) continue;
        if (PID_KEY.test(key) && !FOREIGN_PID_KEYS.has(key) && !pids.has(id)) pids.set(id, source);
        else if (PGID_KEY.test(key)) groups.add(id);
      }
      if (typeof value.label === "string" && ISOLATED_LAUNCHD_LABEL.test(value.label)) labels.add(value.label);
      Object.values(value).forEach(visit);
    };
    jsonValues(text, file).forEach(visit);
  }
  const processes = [...pids].sort(([a], [b]) => a - b)
    .map(([pid, source]) => groups.has(pid) ? { pid, pgid: pid, ownedGroup: true, source } : { pid, source });
  const domain = `gui/${process.getuid()}`;
  return { processes, launchdJobs: [...labels].sort().map(label => ({ domain, label })) };
}

export async function buildCloseoutManifest(runRoot, gateId, { extra = [], workRoot = MAC_WORK_ROOT } = {}) {
  // The id only labels what expires at this closeout: a gate (G03A) or a workflow change (WF-MAC5).
  requireValue(path.isAbsolute(runRoot) && /^[A-Z][A-Z0-9-]{1,31}$/.test(gateId), "absolute run root and closeout id required");
  requireValue((await readFile(path.join(runRoot, "run-root.txt"), "utf8")).trim() === runRoot, "preregistered run root required");
  const artifacts = [], explicit = new Set(extra.map(row => row.path));
  const add = row => { if (!explicit.has(row.path)) artifacts.push(row); };
  for (const entry of await readdir(runRoot, { withFileTypes: true })) {
    const file = path.join(runRoot, entry.name);
    if (entry.name === "raw" && entry.isDirectory()) add({ path: file, class: "RAW", recursive: true, consumer: `${gateId} review`, expiresAtGate: gateId });
    else if (entry.name === "tmp" && entry.isDirectory()) add({ path: file, class: "BULK", recursive: true, consumer: `${gateId} isolated candidate and fixtures`, expiresAtGate: gateId });
    else if (entry.name === "closeout" || LOCAL_ALWAYS.includes(entry.name)) continue;
    else if (entry.isFile()) add({ path: file, class: "LOCAL" });
    else requireValue(explicit.has(file), `unregistered top-level ${entry.isDirectory() ? "directory" : "entry"} ${entry.name}: move it under raw/ or tmp/, or register it with --extra`);
  }
  for (const name of LOCAL_ALWAYS) add({ path: path.join(runRoot, name), class: "LOCAL" });
  add({ path: path.join(runRoot, "closeout"), class: "LOCAL", recursive: true });
  return { runRoot, gateId, closeoutDirectory: path.join(runRoot, "closeout"), workRoot, artifacts: [...artifacts, ...extra], ...await collectOwnedResources(runRoot) };
}

export async function readValidationIndex(runRoot) {
  const byName = new Map();
  let text = "";
  try { text = await readFile(path.join(runRoot, "validation-index.jsonl"), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const line of text.split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    requireValue(row.schema === "ilv2-validation-index/v1" && !byName.has(row.name), `invalid or duplicate validation index row: ${row.name}`);
    byName.set(row.name, row);
  }
  return { byName, sha256: sha256(text) };
}

const sumTap = (commands, key) => commands.reduce((sum, row) => sum + (row.tap?.[key] ?? 0), 0);
function checkSummary(row, role) {
  return { name: row.name, role, status: row.status, mainError: row.mainError, result: row.result, sourceDigest: row.identity?.sourceDigest ?? null,
    commands: row.commands.length, tests: sumTap(row.commands, "tests"), pass: sumTap(row.commands, "pass"), fail: sumTap(row.commands, "fail"),
    elapsedMs: Math.round(row.commands.reduce((sum, command) => sum + (command.elapsedMs ?? 0), 0)),
    argv: row.commands.at(-1)?.argv ?? null };
}

/** Facts a PASS must satisfy; an empty list means the verdict is supported by the records. */
export function passViolations({ verdict, index, closeout, review, residualDirectories = [] }) {
  const errors = [];
  const named = names => (names ?? []).map(name => index.byName.get(name) ?? (errors.push(`unknown validation run ${name}`), null)).filter(Boolean);
  const main = named(verdict.main), red = named(verdict.expectedRed), rerun = named(verdict.independentRerun);
  if (!main.length) errors.push("PASS requires at least one main validation run");
  // A selected-commands pass is not enough: a build-only run, or a pattern that
  // matched no file, still exits 0. Main and rerun runs must have run tests cleanly.
  const ranTests = row => row.status === "SELECTED_COMMANDS_PASSED" && row.commands.some(command => command.tap?.tests > 0)
    && row.commands.every(command => !command.tap || (command.tap.fail === 0 && (command.tap.cancelled ?? 0) === 0));
  for (const row of main) if (!ranTests(row)) errors.push(`main run ${row.name} did not run tests cleanly (${row.status})`);
  const identity = main[0]?.identity;
  for (const field of MAIN_IDENTITY) if (main.length && !identity?.[field]) errors.push(`${main[0].name}: ${field} missing`);
  for (const [rows, fields] of [[main, MAIN_IDENTITY], [rerun, REBUILD_IDENTITY]]) {
    for (const row of rows) for (const field of fields) if (row.identity?.[field] !== identity?.[field]) errors.push(`${row.name}: ${field} differs from ${main[0].name}`);
  }
  for (const row of red) {
    // A RED proof must be a failing test, not a compile or broker failure.
    if (row.status !== "FAIL" || !(row.commands.at(-1)?.tap?.fail > 0)) errors.push(`expected-RED run ${row.name} did not fail a test`);
  }
  if (INDEPENDENT_RERUN_GATES.has(verdict.gateId) && !rerun.length) errors.push(`${verdict.gateId} requires an independent rerun`);
  for (const row of rerun) {
    if (!ranTests(row)) errors.push(`independent rerun ${row.name} did not run tests cleanly (${row.status})`);
    if (main.some(other => other.validationRoot === row.validationRoot)) errors.push(`independent rerun ${row.name} reused a main candidate`);
  }
  if (!closeout) errors.push("PASS requires closeout/closeout.json");
  else {
    if (closeout.status !== "PASS" || closeout.resourceExit?.status !== "PASS") errors.push("closeout did not pass");
    if (closeout.archive && closeout.archive.physicalVerification !== "PASS") errors.push("archive physical verification did not pass");
    if (closeout.closeoutId !== (verdict.gateId ?? verdict.workflowId)) errors.push(`closeout ${closeout.closeoutId} is not for ${verdict.gateId ?? verdict.workflowId}`);
    // Runs appended after closeout were never inventoried for exit or archived.
    if (closeout.validationIndex?.sha256 !== index.sha256) errors.push("validation-index.jsonl changed after closeout");
  }
  for (const directory of residualDirectories) errors.push(`${directory}/ still exists after closeout`);
  if (verdict.gateId) {
    if (!review) errors.push("gate PASS requires an independent review");
    else if (review.status !== "PASS" || review.openFindings?.length || !identity?.sourceDigest || review.source !== identity.sourceDigest) errors.push("independent review is not a clean review of this source digest");
  }
  return errors;
}

async function optionalJson(file) {
  try { const bytes = await readFile(file); return { value: JSON.parse(bytes), sha256: sha256(bytes) }; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function composeTaskResult({ runRoot, verdictFile, outFile, statusFile = STATUS_FILE, manualFile = MANUAL_FILE }) {
  const verdict = await readJson(verdictFile);
  requireValue(verdict.schema === "ilv2-task-verdict/v1" && verdict.taskId && Boolean(verdict.gateId) !== Boolean(verdict.workflowId), "verdict needs schema, taskId and exactly one of gateId/workflowId");
  requireValue(GATE_STATUSES.has(verdict.status), `invalid status ${verdict.status}`);
  const status = await readJson(statusFile);
  const gate = verdict.gateId ? status.gates.find(row => row.gateId === verdict.gateId) : null;
  requireValue(!verdict.gateId || (gate && !gate.children), `${verdict.gateId} is not a leaf gate in status.json`);
  const index = await readValidationIndex(runRoot);
  const closeout = await optionalJson(path.join(runRoot, "closeout", "closeout.json"));
  if (closeout?.value.archive) requireValue(sha256(await readFile(closeout.value.archive.path)) === closeout.value.archive.sha256, "archive bytes differ from closeout.json");
  const review = verdict.review ? await optionalJson(path.resolve(runRoot, verdict.review)) : null;
  requireValue(!verdict.review || review, `review file missing: ${verdict.review}`);
  if (verdict.status === "PASS") {
    const residualDirectories = [];
    for (const name of ["raw", "tmp"]) if (await exists(path.join(runRoot, name))) residualDirectories.push(name);
    const errors = passViolations({ verdict, index, closeout: closeout?.value, review: review?.value, residualDirectories });
    requireValue(!errors.length, `PASS not supported by records:\n- ${errors.join("\n- ")}`);
  }
  const roles = [["main", verdict.main], ["expected-red", verdict.expectedRed], ["independent-rerun", verdict.independentRerun]];
  const checks = roles.flatMap(([role, names]) => (names ?? []).map(name => checkSummary(index.byName.get(name) ?? requireValue(false, `unknown validation run ${name}`), role)));
  const evidence = [];
  for (const row of verdict.evidence ?? []) {
    const record = await optionalJson(path.resolve(runRoot, row.file));
    requireValue(record, `evidence file missing: ${row.file}`);
    evidence.push({ name: row.name, file: row.file, sha256: record.sha256, status: record.value.status ?? null, provenance: row.provenance ?? null });
  }
  const resources = closeout?.value.resourceExit;
  const result = {
    schema: "ilv2-task-result/v2", generatedBy: "scripts/ilv2-mac-task-result.mjs",
    taskId: verdict.taskId, ...(verdict.gateId ? { gateId: verdict.gateId } : { workflowId: verdict.workflowId }), status: verdict.status,
    dependency: verdict.dependency ?? null,
    identity: index.byName.get(verdict.main?.[0])?.identity ?? null,
    checks, evidence,
    closeout: closeout ? { status: closeout.value.status, sha256: closeout.sha256, registeredPids: resources?.processes.length ?? 0,
      ownedGroups: resources?.processes.filter(row => row.ownedGroup).length ?? 0, launchdJobs: resources?.launchdJobs.length ?? 0,
      unregisteredPaths: closeout.value.unregisteredPaths, expiredResidualBytes: closeout.value.expiredResidualBytes,
      carryOver: closeout.value.carryOver, archive: closeout.value.archive } : "NOT_RUN",
    independent: { review: review ? { status: review.value.status, sha256: review.sha256, source: review.value.source ?? null, openFindings: review.value.openFindings ?? [] } : "NOT_RUN" },
    validationIndexSha256: index.sha256,
    notClaimed: verdict.notClaimed ?? [], next: verdict.next ?? null, authorization: verdict.authorization ?? null,
    notes: verdict.notes ?? null, privateEvidence: runRoot
  };
  const previous = await optionalJson(outFile);
  requireValue(!previous || previous.value.generatedBy === result.generatedBy, "refusing to overwrite a hand-written task-result");
  await writeJson(outFile, result);

  const relative = path.relative(path.dirname(statusFile), outFile);
  if (gate) {
    // A regenerated result supersedes the old record, including its commit.
    for (const key of Object.keys(gate)) if (!["gateId", "taskId"].includes(key)) delete gate[key];
    Object.assign(gate, { status: verdict.status, result: relative });
  } else {
    status.workflow = (status.workflow ?? []).filter(row => row.id !== verdict.workflowId);
    status.workflow.push({ id: verdict.workflowId, status: verdict.status, result: relative });
  }
  if (Array.isArray(verdict.statusNext)) status.next = verdict.statusNext;
  const staged = `${statusFile}.${process.pid}.tmp`;
  await writeFile(staged, `${JSON.stringify(status, null, 2)}\n`);
  await rename(staged, statusFile);
  return { result, statusCheck: await checkStatus({ statusFile, manualFile }) };
}

if (isMain(import.meta.url)) runCli(async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "manifest") {
    const options = cliOptions(args, ["--run-root", "--gate", "--extra"]);
    const manifest = await buildCloseoutManifest(options["run-root"], options.gate, { extra: options.extra ? await readJson(options.extra) : [] });
    await writeJson(path.join(manifest.runRoot, "closeout-manifest.json"), manifest);
    console.log(JSON.stringify({ manifest: path.join(manifest.runRoot, "closeout-manifest.json"), artifacts: manifest.artifacts.length, processes: manifest.processes.length,
      ownedGroups: manifest.processes.filter(row => row.ownedGroup).length, launchdJobs: manifest.launchdJobs.length }));
  } else if (command === "compose") {
    const options = cliOptions(args, ["--run-root", "--verdict", "--out", "--status"]);
    const { result, statusCheck } = await composeTaskResult({ runRoot: options["run-root"], verdictFile: options.verdict, outFile: path.resolve(options.out), statusFile: options.status ?? STATUS_FILE });
    console.log(JSON.stringify({ status: result.status, checks: result.checks.map(row => `${row.role}:${row.name}:${row.status}`), statusCheck: statusCheck.status, statusErrors: statusCheck.errors }, null, 2));
    process.exitCode = statusCheck.status === "PASS" ? 0 : 1;
  } else throw new Error("usage: ilv2-mac-task-result.mjs manifest --run-root R --gate G [--extra F] | compose --run-root R --verdict F --out O [--status S]");
});

#!/usr/bin/env node
// G11 re-analysis: runs the current system-loop analysis over a recorded run's raw evidence, read-only.
//   --evidence DIR   recorded samples, calls, owner telemetry, versions and raw host-load samples
//   [--out FILE]     write the verdict there (must not exist); default stdout
// The recorded g11-analysis.json stays as the run wrote it; this output is a separate, reproducible verdict.
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliOptions, isMain, requireValue, sha256 } from "./ilv2-mac-contracts.mjs";
import { analyze, heartbeatGaps, LIMITS, summarizeTimingAttempts, timingItem } from "./ilv2-mac-system-loop.mjs";

export async function reanalyze(dir) {
  const bytes = {};
  for (const name of ["samples.json", "calls.jsonl", "owner-telemetry.jsonl", "versions.json", "load-samples.json", "g11-analysis.json"]) bytes[name] = await readFile(path.join(dir, name));
  const rows = name => bytes[name].toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const samples = JSON.parse(bytes["samples.json"]);
  const recorded = JSON.parse(bytes["g11-analysis.json"]);
  const telemetry = rows("owner-telemetry.jsonl");
  const verdict = analyze({ ...samples, calls: rows("calls.jsonl"), telemetry, versions: JSON.parse(bytes["versions.json"]),
    loadSamples: JSON.parse(bytes["load-samples.json"]), quick: false, deltaClosureLimit: recorded.deltaCalibration?.limit ?? 400 });
  const brief = analysis => Object.fromEntries(Object.entries(analysis.hardGates).map(([name, item]) => [name, item.verdict]));
  return {
    evidence: dir, inputs: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, sha256(value)])),
    recorded: { status: recorded.status, hardGates: brief(recorded), incompleteMeasurements: recorded.incompleteMeasurements }, status: verdict.status, hardGates: brief(verdict), performanceReady: verdict.performanceReady,
    performanceVerdicts: verdict.performanceVerdicts, verdict,
    heartbeatSamples: heartbeatGaps(telemetry).map(row => row.gapMs),
    recordedEnvelope: { failure: recorded.failure, closeout: recorded.closeout, closeoutError: recorded.closeoutError,
      frozenInputUnchanged: recorded.frozenInputUnchanged, measurementComplete: recorded.measurementComplete }
  };
}

export function requireMeasuredShortfall(report, result, command, stdout) {
  const text = stdout.toString("utf8");
  const incomplete = report.recorded.incompleteMeasurements;
  requireValue(Object.keys(report.hardGates).length > 0
    && Object.keys(report.hardGates).every(name => report.recorded.hardGates[name] === "PASS")
    && report.recordedEnvelope.measurementComplete === false && Array.isArray(incomplete) && incomplete.length > 0,
  "primary recorded failure is not a measured shortfall");
  requireValue(result.mainError === `${result.identity.runtime.execPath} exited with 1 (no signal)`
    && command.status === "FAIL" && command.exitCode === 1 && command.signal === null && command.error === null
    && command.stdoutSha256 === sha256(stdout), "primary command failure or stdout identity differs");
  const message = `incomplete performance measurements: ${incomplete.join(", ")}`;
  requireValue(text.split("\n").filter(line => /^not ok\b/.test(line)).length === 1
    && text.split("\n").filter(line => line.trim() === message).length === 1
    && /^# tests 1$/m.test(text) && /^# pass 0$/m.test(text) && /^# fail 1$/m.test(text)
    && /^# cancelled 0$/m.test(text) && /^# skipped 0$/m.test(text)
    && /^  code: 'ERR_ASSERTION'$/m.test(text) && /^  expected: true$/m.test(text)
    && /^  actual: false$/m.test(text) && /^  operator: 'strictEqual'$/m.test(text),
  "primary stdout is not the sole measurement-completion assertion");
}

/** Each run keeps its own hard-gate analysis; only complete performance attempts are pooled. */
export function combineMeasurements(reports) {
  requireValue(reports.length > 0, "primary evidence required");
  requireValue(new Set(reports.map(report => report.evidence)).size === reports.length, "duplicate evidence directory");
  const rawFingerprint = report => sha256(JSON.stringify(Object.entries(report.inputs).filter(([name]) => name !== "g11-analysis.json").sort()));
  requireValue(new Set(reports.map(rawFingerprint)).size === reports.length, "duplicate recorded measurements");
  const traces = reports.filter(report => report.inputs["calls.jsonl"] && report.inputs["owner-telemetry.jsonl"])
    .map(report => `${report.inputs["calls.jsonl"]}:${report.inputs["owner-telemetry.jsonl"]}`);
  requireValue(new Set(traces).size === traces.length, "duplicate execution traces");
  const primary = reports[0], performance = {};
  for (const [name, first] of Object.entries(primary.verdict.performance)) {
    const items = reports.map(report => report.verdict.performance[name]);
    requireValue(items.every(Boolean), `missing performance group ${name}`);
    if (name === "heartbeat") {
      performance[name] = timingItem({ samples: reports.flatMap(report => report.heartbeatSamples),
        limit: LIMITS.heartbeatGapMs, p: 1, min: 1, idle: true });
      continue;
    }
    const attempts = reports.flatMap((report, index) => report.verdict.performance[name].attempts.map(row => ({ ...row, evidence: report.evidence, runIndex: index })));
    const result = summarizeTimingAttempts(attempts, { limit: first.limit, p: first.p, min: first.minSamples,
      strictMax: name === "queuedDuringFull" ? LIMITS.queuedMaxMs : first.maxLimit, minByKind: first.minByKind });
    const structuralViolations = items.flatMap(item => item.structuralViolations ?? []);
    const escalatedFulls = reports.flatMap(report => (report.verdict.performance[name].escalatedFulls ?? []).map(row => ({ ...row, evidence: report.evidence })));
    performance[name] = { ...result, ...(escalatedFulls.length ? { escalatedFulls } : {}),
      ...(structuralViolations.length ? { structuralViolations, evidenceComplete: false, verdict: "FAIL" } : {}) };
  }
  const incompleteMeasurements = Object.entries(performance).filter(([, item]) => item.n < item.minSamples
    || item.verdict === "INVALID_EXPERIMENT" || item.evidenceComplete === false || (item.censored ?? 0) > 0
    || (item.value !== undefined && !Number.isFinite(item.value))).map(([name]) => name);
  const hardPass = Object.values(primary.hardGates).every(value => value === "PASS");
  return { status: hardPass && incompleteMeasurements.length === 0 ? "PASS" : "FAIL", hardGates: primary.hardGates,
    hardGateEvidence: primary.evidence, measurementComplete: incompleteMeasurements.length === 0, incompleteMeasurements,
    performanceReady: Object.values(performance).every(item => item.verdict === "PASS"), performance,
    inputs: reports.map(report => ({ evidence: report.evidence, hashes: report.inputs, recordedStatus: report.recorded.status })) };
}

async function compiledJs(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && file.endsWith(".js")) entries.push([path.relative(root, file), sha256(await readFile(file))]);
    }
  }
  await visit(path.join(root, "dist"));
  requireValue(entries.length > 0, "compiled product inventory is empty");
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

/** Provenance is checked against actual broker results and compiled files, never a claimed digest. */
export async function reanalyzeWithSupplements(primaryDir, supplementDirs, candidateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const dirs = await Promise.all([primaryDir, ...supplementDirs].map(dir => realpath(dir)));
  requireValue(new Set(dirs).size === dirs.length, "duplicate evidence directory");
  const current = JSON.parse(await readFile(path.join(candidateRoot, "..", "validation-candidate.json")));
  const product = await compiledJs(candidateRoot), reports = [], provenance = [];
  let inputIdentity;
  for (const [index, dir] of dirs.entries()) {
    const resultBytes = await readFile(path.join(dir, "..", "result.json"));
    const result = JSON.parse(resultBytes);
    const planBytes = await readFile(path.join(dir, "run-plan.json")), plan = JSON.parse(planBytes);
    requireValue(plan.quick === false, "QUICK evidence cannot certify G11");
    const input = JSON.stringify(plan.input);
    if (inputIdentity === undefined) inputIdentity = input;
    requireValue(input === inputIdentity, "frozen input identity differs");
    requireValue(result.identity.source === result.identity.candidateSource && !result.cleanupError, "broker source drift or cleanup error");
    requireValue(result.identity.runtime.runtimeManifestSha256 === current.identity.runtime.runtimeManifestSha256
      && result.identity.native.sourceDigest === current.identity.native.sourceDigest, "runtime/native identity differs");
    const previous = await compiledJs(result.candidateRoot);
    requireValue(JSON.stringify(product) === JSON.stringify(previous), "compiled product differs from recorded run");
    requireValue(result.identity.native.binarySha256 === current.identity.native.binarySha256, "native binary identity differs");
    for (const [root, identity] of [[candidateRoot, current.identity], [result.candidateRoot, result.identity]])
      requireValue(sha256(await readFile(path.join(root, "dist", "native", "ilv2-mac"))) === identity.native.binarySha256, "actual native bytes differ from broker identity");
    const report = await reanalyze(dir);
    const envelope = report.recordedEnvelope;
    requireValue(envelope.failure === null && envelope.closeoutError === null && envelope.frozenInputUnchanged === true
      && envelope.closeout?.bootout === 0 && envelope.closeout?.groupsGone === true, "incomplete real execution or exit evidence");
    let shortfallProof;
    if (index === 0) {
      requireValue(Object.values(report.hardGates).every(value => value === "PASS"), "primary hard gate failed");
      if (result.status !== "SELECTED_COMMANDS_PASSED") {
        const prefix = path.basename(dir).replace(/\.evidence$/, "");
        const commandBytes = await readFile(path.join(dir, "..", `${prefix}.command.json`));
        const stdout = await readFile(path.join(dir, "..", `${prefix}.stdout.txt`));
        requireMeasuredShortfall(report, result, JSON.parse(commandBytes), stdout);
        shortfallProof = { commandSha256: sha256(commandBytes), stdoutSha256: sha256(stdout) };
      }
    } else {
      const proof = JSON.parse(await readFile(path.join(dir, "measurement-supplement.json")));
      requireValue(result.status === "SELECTED_COMMANDS_PASSED" && proof.schema === "ilv2-mac11-supplement/v1"
        && proof.status === "PASS" && proof.gateStatus === "NOT_GATED" && Object.keys(proof.checks ?? {}).length > 0
        && Object.values(proof.checks).every(value => value === true), "supplement did not pass its exercised contracts");
    }
    reports.push(report);
    provenance.push({ evidence: dir, brokerResultSha256: sha256(resultBytes), runPlanSha256: sha256(planBytes),
      source: result.identity.source, compiledJsCompared: product.length, compiledJsDigest: sha256(JSON.stringify(product)),
      ...(shortfallProof ? { shortfallProof } : {}) });
  }
  return { ...combineMeasurements(reports), provenance, source: current.identity.source };
}

if (isMain(import.meta.url)) {
  const options = cliOptions(process.argv.slice(2), ["--evidence", "--supplements", "--out"]);
  requireValue(options.evidence, "--evidence DIR required");
  const result = options.supplements ? await reanalyzeWithSupplements(options.evidence, JSON.parse(await readFile(options.supplements))) : await reanalyze(path.resolve(options.evidence));
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) await writeFile(options.out, text, { flag: "wx" });
  else process.stdout.write(text);
}

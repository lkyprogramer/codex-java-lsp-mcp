#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { CONTRACT_VERSION, readJson, writeJson, newOutput, requireValue, cliOptions, isMain, runCli, verifyRuntime, sha256 } from "./ilv2-mac-contracts.mjs";
import { field } from "./ilv2-mac-driver.mjs";

export function validatePlan(plan) {
  requireValue(plan.contractVersion === CONTRACT_VERSION && Array.isArray(plan.slots) && plan.slots.length > 0, "invalid run plan");
  const ids = new Set();
  for (const slot of plan.slots) {
    requireValue(typeof slot.id === "string" && slot.id && !ids.has(slot.id), "duplicate or missing slot");
    ids.add(slot.id);
    requireValue(["query", "status", "prewarm"].includes(slot.operation), "invalid planned operation");
    requireValue(["normal", "fault"].includes(slot.window), "planned window required");
    requireValue(typeof slot.workspaceId === "string" && slot.workspaceId, "planned workspace required");
    requireValue(Number.isFinite(slot.deadlineMs) && slot.deadlineMs > 0 && slot.deadlineMs <= 600000, "invalid planned deadline");
    requireValue(Number.isFinite(slot.stopAfterMs) && slot.stopAfterMs >= slot.deadlineMs && slot.stopAfterMs <= 600000, "bounded slot stop required");
    requireValue(Number.isFinite(slot.atMs) && slot.atMs >= 0, "planned dispatch offset required");
    if (slot.operation === "query") {
      requireValue(slot.expected?.workspaceId === slot.workspaceId && typeof slot.expected.sourceHash === "string" && slot.expected.sourceHash.length > 0, "query oracle requires target workspace and hash");
      requireValue(slot.expected.match && Object.keys(slot.expected.match).length > 0, "query oracle requires content assertion");
    }
    if (slot.pollMs !== undefined) requireValue(slot.pollMs >= 100 && slot.pollMs <= 200, "first-correct polling must be 100-200 ms");
  }
  requireValue(Number.isInteger(plan.concurrency) && plan.concurrency > 0 && plan.concurrency <= 100, "bounded concurrency required");
  requireValue(Array.isArray(plan.slos) && plan.slos.length > 0, "selected SLOs required");
  requireValue(new Set(plan.slos.map(slo => slo.id)).size === plan.slos.length, "duplicate SLO IDs");
  for (const slo of plan.slos) {
    requireValue(typeof slo.id === "string" && ["elapsedMs", "firstCorrectMs", "publishMs"].includes(slo.metric), "invalid SLO metric");
    requireValue(["normal", "fault"].includes(slo.window) && Number.isFinite(slo.limitMs) && slo.limitMs >= 0, "invalid SLO boundary");
    requireValue(slo.percentile > 0 && slo.percentile <= 1 && Number.isInteger(slo.minSamples) && slo.minSamples > 0, "invalid SLO denominator");
  }
  return plan;
}
export function evaluateOracle(value, expected) {
  if (!value || value.status !== "OK" || value.workspaceId !== expected.workspaceId || value.sourceHash !== expected.sourceHash || !value.snapshotId) return false;
  if (expected.snapshotId && value.snapshotId !== expected.snapshotId) return false;
  return Object.entries(expected.match).every(([selector, expectedValue]) => JSON.stringify(field(value, selector)) === JSON.stringify(expectedValue));
}
export function percentile(values, fraction) {
  requireValue(values.length > 0 && fraction > 0 && fraction <= 1 && values.every(value => Number.isFinite(value) && value >= 0), "invalid percentile sample");
  return [...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1];
}
export function summarize(plan, calls, { since = -Infinity, until = Infinity } = {}) {
  validatePlan(plan);
  const errors = [];
  const sampleIds = new Set();
  const slots = new Map(plan.slots.map(slot => [slot.id, slot]));
  const finals = new Map();
  for (const call of calls) {
    if (!call.sampleId || sampleIds.has(call.sampleId)) errors.push("duplicate-or-missing-sample-id");
    sampleIds.add(call.sampleId);
    const slot = slots.get(call.slotId);
    if (!slot) { errors.push("unknown-slot"); continue; }
    if (call.window !== slot.window || call.operation !== slot.operation || call.workspaceId !== slot.workspaceId) errors.push(`slot-identity:${slot.id}`);
    if (call.kind !== "slot") continue;
    if (finals.has(call.slotId)) { errors.push(`duplicate-slot:${call.slotId}`); continue; }
    const timestamp = Date.parse(call.startedAt);
    if (!Number.isFinite(timestamp) || timestamp < since || timestamp > until) { errors.push(`slot-outside-window:${slot.id}`); continue; }
    let measured;
    try { measured = Number(BigInt(call.endMonoNs) - BigInt(call.startMonoNs)) / 1e6; } catch { measured = NaN; }
    if (!Number.isFinite(measured) || measured < 0 || Math.abs(measured - call.elapsedMs) > 0.001) errors.push(`invalid-monotonic-time:${slot.id}`);
    const correct = slot.operation !== "query" ? call.status === "PASS" : evaluateOracle(call.response, slot.expected);
    const passed = call.status === "PASS" && correct && Number.isFinite(measured) && measured <= slot.stopAfterMs + 1000;
    if (slot.operation === "status" && call.readOnly !== true) errors.push(`status-not-read-only:${slot.id}`);
    if (!passed || !Number.isFinite(call.maxAttemptMs) || call.maxAttemptMs < 0 || call.maxAttemptMs > slot.deadlineMs + 1000) errors.push(`failed-slot:${slot.id}`);
    finals.set(slot.id, { ...call, passed });
  }
  for (const id of slots.keys()) if (!finals.has(id)) errors.push(`missing-slot:${id}`);
  const metrics = plan.slos.map(slo => {
    const selected = plan.slots.filter(slot => slot.window === slo.window && (!slo.operation || slot.operation === slo.operation));
    const values = selected.map(slot => finals.get(slot.id)).filter(call => call?.passed).map(call => call[slo.metric]).filter(value => Number.isFinite(value) && value >= 0);
    const complete = values.length === selected.length && values.length >= slo.minSamples;
    return { ...slo, expected: selected.length, n: values.length, completed: selected.filter(slot => finals.get(slot.id)?.passed).length,
      p50: values.length ? percentile(values, 0.5) : null, p95: values.length ? percentile(values, 0.95) : null,
      p99: values.length ? percentile(values, 0.99) : null, max: values.length ? Math.max(...values) : null,
      measured: values.length ? percentile(values, slo.percentile) : null,
      status: complete && percentile(values, slo.percentile) <= slo.limitMs ? "PASS" : "FAIL" };
  });
  return { contractVersion: CONTRACT_VERSION, status: errors.length || metrics.some(metric => metric.status !== "PASS") ? "FAIL" : "PASS",
    expectedSlots: plan.slots.length, completedSlots: [...finals.values()].filter(call => call.passed).length, errors, metrics };
}
export async function readCalls(file) {
  return (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
if (isMain(import.meta.url)) runCli(async () => {
  const options = cliOptions(process.argv.slice(2), ["--telemetry", "--calls", "--plan", "--since", "--until", "--out"]);
  const runtime = await verifyRuntime();
  const since = Date.parse(options.since), until = Date.parse(options.until);
  requireValue(Number.isFinite(since) && Number.isFinite(until) && since <= until, "valid report window required");
  const identity = await readJson(`${options.telemetry}/identity.json`);
  requireValue(identity.runtimeManifestSha256 === runtime.runtimeManifestSha256 && identity.contractVersion === CONTRACT_VERSION, "telemetry runtime identity mismatch");
  const plan = await readJson(options.plan);
  const manifest = await readJson(`${options.telemetry}/calls-manifest.json`);
  requireValue(identity.planDigest === sha256(JSON.stringify(plan)) && manifest.planDigest === identity.planDigest && manifest.driverDigest === identity.driverDigest, "telemetry plan or driver digest mismatch");
  requireValue(manifest.callsSha256 === sha256(await readFile(options.calls)), "calls digest mismatch");
  const out = await newOutput(process.env.ILV2_RUN_ROOT, options.out);
  const result = summarize(plan, await readCalls(options.calls), { since, until });
  await writeJson(`${out}/slo-result.json`, result);
  process.exitCode = result.status === "PASS" ? 0 : 1;
});

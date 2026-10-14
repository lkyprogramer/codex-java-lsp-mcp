#!/usr/bin/env node
// status.json is the only gate-status source for ILV2-MAC. A parent gate's
// status is derived from its children and never stored, so it cannot drift.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliOptions, isMain, readJson, requireValue, runCli } from "./ilv2-mac-contracts.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STATUS_FILE = path.join(repoRoot, "docs/index-lifecycle-v2/mac/status.json");
export const MANUAL_FILE = path.join(repoRoot, "docs/deep/codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md");
export const GATE_STATUSES = new Set(["PLAN", "IN_PROGRESS", "PASS", "FAIL", "BLOCKED_ENV", "BLOCKED_AUTH", "NOT_RUN", "NOT_REPRODUCED", "INVALID_EXPERIMENT"]);
// The manual keeps contracts only; per-card execution status paragraphs duplicated this file.
const MANUAL_STATUS_MARKER = /\*\*执行状态[:：]?/;

/** Find a gate's recorded status in a task-result file of either the v1 or generated v2 shape. */
export function recordedGateStatus(result, gateId) {
  if (result.gateId === gateId) return result.status;
  if (result.gateVerdict?.id === gateId) return result.gateVerdict.status;
  return result.children?.find(child => child.gateId === gateId)?.status;
}

export function derivedStatus(gate, byId) {
  if (!gate.children) return gate.status;
  const children = gate.children.map(id => derivedStatus(byId.get(id), byId));
  if (children.every(status => status === "PASS")) return "PASS";
  if (children.every(status => status === "PLAN")) return "PLAN";
  if (children.some(status => status === "FAIL")) return "FAIL";
  return "IN_PROGRESS";
}

export async function checkStatus({ statusFile = STATUS_FILE, manualFile = MANUAL_FILE } = {}) {
  const status = await readJson(statusFile);
  const baseDir = path.dirname(statusFile);
  const errors = [];
  requireValue(status.schema === "ilv2-mac-status/v1" && Array.isArray(status.gates), "unsupported status file");
  const byId = new Map();
  for (const gate of status.gates) {
    if (byId.has(gate.gateId)) errors.push(`${gate.gateId}: duplicate gate`);
    byId.set(gate.gateId, gate);
  }
  const referenced = new Set();
  for (const gate of status.gates) {
    if (gate.children) {
      if (Object.hasOwn(gate, "status")) errors.push(`${gate.gateId}: parent status is derived from children and must not be stored`);
      for (const child of gate.children) if (!byId.has(child)) errors.push(`${gate.gateId}: unknown child ${child}`);
    } else if (!GATE_STATUSES.has(gate.status)) errors.push(`${gate.gateId}: invalid status ${gate.status}`);
    if (!gate.result) {
      if (!gate.children && !["PLAN", "NOT_RUN"].includes(gate.status)) errors.push(`${gate.gateId}: ${gate.status} requires a task-result reference`);
      continue;
    }
    const file = path.resolve(baseDir, gate.result);
    referenced.add(file);
    let result;
    try { result = JSON.parse(await readFile(file, "utf8")); } catch (error) { errors.push(`${gate.gateId}: unreadable result ${gate.result} (${error.code ?? error.message})`); continue; }
    const recorded = recordedGateStatus(result, gate.gateId);
    const expected = derivedStatus(gate, byId);
    if (recorded === undefined) errors.push(`${gate.gateId}: ${gate.result} does not record this gate`);
    else if (recorded !== expected) errors.push(`${gate.gateId}: status.json ${expected} but ${gate.result} records ${recorded}`);
  }
  for (const item of status.workflow ?? []) {
    const file = path.resolve(baseDir, item.result);
    referenced.add(file);
    try {
      const result = JSON.parse(await readFile(file, "utf8"));
      if (result.status !== item.status) errors.push(`${item.id}: status.json ${item.status} but ${item.result} records ${result.status}`);
    } catch (error) { errors.push(`${item.id}: unreadable result ${item.result} (${error.code ?? error.message})`); }
  }
  // An open decision must point at evidence that a generated result actually carries.
  for (const decision of status.openDecisions ?? []) {
    const pointer = decision.evidence ?? {};
    try {
      const result = JSON.parse(await readFile(path.resolve(baseDir, pointer.result ?? ""), "utf8"));
      if (!result.evidence?.some(row => row.name === pointer.name)) errors.push(`${decision.id}: ${pointer.result} has no evidence ${pointer.name}`);
    } catch (error) { errors.push(`${decision.id}: unreadable evidence ${pointer.result} (${error.code ?? error.message})`); }
  }
  for (const entry of await readdir(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(baseDir, entry.name, "task-result.json");
    try { await readFile(file); } catch { continue; }
    if (!referenced.has(file)) errors.push(`${entry.name}/task-result.json is not referenced by status.json`);
  }
  const manual = await readFile(manualFile, "utf8");
  if (MANUAL_STATUS_MARKER.test(manual)) errors.push("manual repeats per-card execution status; keep it in status.json");
  if (!manual.includes("index-lifecycle-v2/mac/status.json")) errors.push("manual must reference status.json as the status source");
  const summary = status.gates.map(gate => ({ gateId: gate.gateId, status: byId.has(gate.gateId) ? derivedStatus(gate, byId) : null }));
  return { status: errors.length ? "FAIL" : "PASS", errors, summary };
}

if (isMain(import.meta.url)) runCli(async () => {
  const options = cliOptions(process.argv.slice(2), ["--status", "--manual"]);
  const result = await checkStatus({ statusFile: options.status ?? STATUS_FILE, manualFile: options.manual ?? MANUAL_FILE });
  console.log(JSON.stringify({ status: result.status, errors: result.errors,
    gates: Object.fromEntries(result.summary.map(row => [row.gateId, row.status])) }, null, 2));
  process.exitCode = result.status === "PASS" ? 0 : 1;
});

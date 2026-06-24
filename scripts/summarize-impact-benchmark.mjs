#!/usr/bin/env node
// input: benchmark-agent-impact JSON files.
// output: compact payload/quality summaries and optional before/after deltas.
// pos: Read-only helper for token-search efficiency reports.
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/summarize-impact-benchmark.mjs <benchmark.json> [more.json]");
  process.exit(1);
}

const summaries = files.map(summarizeFile);
console.log(JSON.stringify({
  summaries,
  comparisons: compareAdjacent(summaries)
}, null, 2));

function summarizeFile(file) {
  const payload = JSON.parse(readFileSync(file, "utf8"));
  const attempts = (payload.rows || []).flatMap(row => row.attempts || []);
  const totals = payload.totals || average(attempts);
  const totalPayload = number(totals.totalAgentVisiblePayload);
  const rawPayload = number(totals.rawSearchPayload);
  const readingPayload = number(totals.readingPayload);
  return {
    file,
    projectId: payload.metadata?.projectId,
    strategy: payload.metadata?.strategy,
    warmState: payload.metadata?.warmState,
    verbosity: payload.metadata?.verbosity,
    runs: payload.metadata?.runs,
    scenarios: payload.rows?.length || 0,
    rawSearchPayload: rawPayload,
    readingPayload,
    totalAgentVisiblePayload: totalPayload,
    estimatedTokens: number(totals.estimatedTokens),
    rawShare: share(rawPayload, totalPayload),
    readingShare: share(readingPayload, totalPayload),
    precision: number(totals.precision),
    recall: number(totals.recall),
    pRead: number(totals.pRead),
    rReadMust: number(totals.rReadMust),
    elapsedMsP50: number(totals.elapsedMsP50),
    elapsedMsP95: number(totals.elapsedMsP95)
  };
}

function compareAdjacent(items) {
  const comparisons = [];
  for (let index = 1; index < items.length; index += 1) {
    const before = items[index - 1];
    const after = items[index];
    comparisons.push({
      before: before.file,
      after: after.file,
      rawSearchPayloadDeltaPct: deltaPct(before.rawSearchPayload, after.rawSearchPayload),
      readingPayloadDeltaPct: deltaPct(before.readingPayload, after.readingPayload),
      totalAgentVisiblePayloadDeltaPct: deltaPct(before.totalAgentVisiblePayload, after.totalAgentVisiblePayload),
      estimatedTokensDeltaPct: deltaPct(before.estimatedTokens, after.estimatedTokens),
      rReadMustDelta: round(after.rReadMust - before.rReadMust),
      pReadDelta: round(after.pRead - before.pRead)
    });
  }
  return comparisons;
}

function average(items) {
  const totals = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        totals[key] = (totals[key] || 0) + value;
      }
    }
  }
  for (const key of Object.keys(totals)) {
    totals[key] /= items.length || 1;
  }
  return totals;
}

function share(value, total) {
  return total > 0 ? round(value / total) : 0;
}

function deltaPct(before, after) {
  return before > 0 ? round((after - before) / before) : 0;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? round(value) : 0;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

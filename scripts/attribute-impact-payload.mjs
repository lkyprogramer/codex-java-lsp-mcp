#!/usr/bin/env node
// input: built dist plus benchmark scenarios.
// output: runtime javaImpact payload bytes by verbosity and component.
// pos: Verifies MCP handler payload shape, including withPhaseMs behavior.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRouter } from "../dist/agent-router/index.js";
import { SourceIndex } from "../dist/source-index.js";
import { JdtlsSession } from "../dist/jdtls-session.js";
import { javaImpact } from "../dist/tools/impact.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = parseArgs(process.argv.slice(2));
const scenarioFile = cli.scenarios || path.join(projectDir, "golden", `${cli.projectId}.scenarios.jsonl`);
if (!existsSync(path.join(projectDir, "dist", "tools", "impact.js"))) {
  throw new Error("dist/tools/impact.js does not exist; run npm run build first.");
}

const scenarios = loadScenarios(scenarioFile).filter(scenario => !scenario.projectId || scenario.projectId === cli.projectId);
const session = new JdtlsSession(cli.repoRoot);
const sourceIndex = new SourceIndex(cli.repoRoot);
const router = new AgentRouter(cli.repoRoot, session, sourceIndex);
const context = {
  repoRoot: cli.repoRoot,
  session,
  sourceIndex,
  router
};

const rows = [];
for (const scenario of scenarios) {
  const byVerbosity = {};
  for (const verbosity of ["standard", "diagnostic", "compact"]) {
    const result = await javaImpact(context, {
      anchors: [scenario.anchor],
      mode: cli.mode,
      profile: scenario.anchor.profile,
      semanticPolicy: "fast",
      semanticTimeoutMs: 1500,
      readPlanMaxItems: undefined,
      testReadMode: "defer",
      focusModules: scenario.anchor.focusModules || [],
      excludeModules: [],
      taskKeywords: scenario.anchor.taskKeywords || [],
      crossModulePolicy: "auto",
      verbosity
    });
    byVerbosity[verbosity] = attribution(result);
  }
  rows.push({
    id: scenario.id,
    name: scenario.name,
    verbosity: byVerbosity
  });
}

await session.stop();

console.log(JSON.stringify({
  metadata: {
    generatedAt: new Date().toISOString(),
    repoRoot: cli.repoRoot,
    projectId: cli.projectId,
    scenarios: scenarioFile,
    mode: cli.mode
  },
  totals: averageAttribution(rows),
  rows
}, null, 2));

function attribution(result) {
  const payload = result && typeof result === "object" ? result : {};
  const metrics = payload.metrics && typeof payload.metrics === "object" ? payload.metrics : {};
  return {
    totalBytes: byteLength(payload),
    filesBytes: byteLength(payload.files || []),
    readPlanBytes: byteLength(payload.readPlan || []),
    rgSummaryBytes: byteLength(payload.rgSummary || {}),
    rgSectionFilesBytes: byteLength((payload.rgSummary?.sections || []).map(section => section.files || [])),
    evidenceGapsBytes: byteLength(payload.evidenceGaps || []),
    metricsBytes: byteLength(metrics),
    hasPhaseMs: Object.hasOwn(metrics, "phaseMs"),
    hasCache: Object.hasOwn(metrics, "cache"),
    hasRgCache: Object.hasOwn(metrics, "rgCache"),
    hasSourceFacts: Object.hasOwn(metrics, "sourceFacts"),
    outputBytes: metrics.outputBytes || 0
  };
}

function averageAttribution(rows) {
  const result = {};
  for (const verbosity of ["standard", "diagnostic", "compact"]) {
    result[verbosity] = average(rows.map(row => row.verbosity[verbosity]));
  }
  return result;
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
    totals[key] = round(totals[key] / (items.length || 1));
  }
  return totals;
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function loadScenarios(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    values.set(args[index], args[index + 1]);
    index += 1;
  }
  const projectId = values.get("--project-id") || "generic-java";
  return {
    repoRoot: values.get("--repo-root") || path.join(projectDir, "fixtures", "generic-java"),
    scenarios: values.get("--scenarios"),
    projectId,
    mode: values.get("--mode") || "balanced"
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

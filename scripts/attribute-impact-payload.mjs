#!/usr/bin/env node
// input: built dist plus benchmark scenarios.
// output: runtime javaImpact payload bytes by verbosity and component.
// pos: Verifies MCP handler payload shape, including withPhaseMs behavior.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRouter } from "../dist/agent-router/index.js";
import { buildImpactPayloadProjectionV3 } from "../dist/benchmark/attribution-v3.js";
import { SqlJavaIndexClient } from "../dist/java-index/sql/sql-client.js";
import { RouterJavaIndex } from "../dist/java-index/router-java-index.js";
import { JdtlsSession } from "../dist/jdtls-session.js";
import { javaImpact } from "../dist/tools/impact.js";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = parseArgs(process.argv.slice(2));
if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
  throw new Error("attribute-impact-payload must run through the detached isolated validation harness");
}
const scenarioFile = cli.scenarios || path.join(projectDir, "golden", `${cli.projectId}.scenarios.jsonl`);
if (!existsSync(path.join(projectDir, "dist", "tools", "impact.js"))) {
  throw new Error("dist/tools/impact.js does not exist; run npm run build first.");
}

const scenarios = loadScenarios(scenarioFile).filter(scenario => !scenario.projectId || scenario.projectId === cli.projectId);
const isolatedIndexCache = cli.indexCacheDir || mkdtempSync(path.join(os.tmpdir(), "java-impact-payload-index-"));
const ownsIndexCache = cli.indexCacheDir === undefined;
const session = new JdtlsSession(cli.repoRoot);
const javaIndexClient = new SqlJavaIndexClient(cli.repoRoot, isolatedIndexCache);
const javaIndex = new RouterJavaIndex(cli.repoRoot, javaIndexClient);
const router = new AgentRouter(cli.repoRoot, session, javaIndex);
const context = {
  repoRoot: cli.repoRoot,
  session,
  javaIndex,
  javaIndexClient,
  router
};

const rows = [];
try {
  for (const scenario of scenarios) {
    const canonical = await javaImpact(context, {
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
      verbosity: "diagnostic"
    });
    const projection = buildImpactPayloadProjectionV3(canonical);
    rows.push({
      id: scenario.id,
      name: scenario.name,
      schemaVersion: projection.schemaVersion,
      canonicalExecutions: projection.canonicalExecutions,
      candidateReadPlanSha256: projection.candidateReadPlanSha256,
      defaultToolSerializedBytes: projection.defaultToolSerializedBytes,
      defaultToolEstimatedTokens: projection.defaultToolEstimatedTokens,
      diagnosticSerializedBytes: projection.diagnosticSerializedBytes,
      diagnosticEstimatedTokens: projection.diagnosticEstimatedTokens,
      standardToDiagnosticBytesRatio: projection.standardToDiagnosticBytesRatio,
      verbosity: projection.projections
    });
  }

  console.log(JSON.stringify({
    metadata: {
      generatedAt: new Date().toISOString(),
      repoRoot: cli.repoRoot,
      projectId: cli.projectId,
      scenarios: scenarioFile,
      indexBackend: "v2",
      mode: cli.mode,
      measurement: "single-diagnostic-canonical-with-pure-verbosity-projections",
      canonicalExecutionsPerScenario: 1,
      defaultToolResponse: "standard",
      indexCacheDir: isolatedIndexCache,
      indexCacheIsolation: ownsIndexCache ? "temporary-owned" : "caller-supplied"
    },
    totals: averageAttribution(rows),
    rows
  }, null, 2));
} finally {
  await session.stop().catch(() => undefined);
  await javaIndexClient.close().catch(() => undefined);
  if (ownsIndexCache) rmSync(isolatedIndexCache, { recursive: true, force: true });
}

function averageAttribution(rows) {
  const result = {};
  for (const verbosity of ["standard", "diagnostic", "compact"]) {
    const entries = rows.map(row => row.verbosity[verbosity]);
    result[verbosity] = {
      ...average(entries),
      fields: Object.fromEntries(
        Object.keys(entries[0]?.fields || {}).map(field => [
          field,
          average(entries.map(entry => entry.fields[field]))
        ])
      )
    };
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
    mode: values.get("--mode") || "balanced",
    indexCacheDir: values.get("--index-cache-dir")
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

// input: Built MCP server and an enabled Java repo.
// output: LSP startup, impact, warm reuse, and JVM flag benchmark measurements.
// pos: Reproducible performance harness for JDT LS tuning decisions.
import { existsSync, rmSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { repoCacheRoot } from "./repo-layout.js";

type JsonObject = Record<string, unknown>;

type Measurement = {
  id: string;
  kind: string;
  env?: Record<string, string>;
  clearWorkspace?: boolean;
  waitMs?: number;
  statusStartMs?: number;
  impactMs?: number;
  warmImpactMs?: number;
  phaseMs?: JsonObject;
  warmPhaseMs?: JsonObject;
  metrics?: JsonObject;
  cacheFileBytes?: number;
  error?: string;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const repoRoot = process.env.JAVA_LSP_BENCH_REPO_ROOT
  || process.env.LISHUEDU_ROOT
  || "/Users/luo/Documents/program/lishu/lishuedu";
const anchor = {
  file: process.env.JAVA_LSP_BENCH_FILE || "modules/school/src/main/java/com/lishu/edu/school/interfaces/web/SchoolTemplateImportController.java",
  line: Number(process.env.JAVA_LSP_BENCH_LINE || 109),
  column: Number(process.env.JAVA_LSP_BENCH_COLUMN || 12),
  role: "controller"
};
const startupRepeats = Number(process.env.JAVA_LSP_BENCH_STARTUP_REPEATS || 3);
const waitMs = Number(process.env.JAVA_LSP_BENCH_STATUS_WAIT_MS || 5000);

if (!existsSync(repoRoot)) {
  throw new Error(`Benchmark repo does not exist: ${repoRoot}`);
}

const tempRoot = await mkdtemp(path.join(tmpdir(), "java-lsp-bench-"));
const cdsPath = path.join(tempRoot, "jdtls.jsa");
const aotPath = path.join(tempRoot, "jdtls.aot");
const measurements: Measurement[] = [];

try {
  measurements.push(await impactRun("default-direct-cold", {}, true, false));
  measurements.push(await impactRun("autobuild-off-direct-cold", { JAVA_LSP_AUTOBUILD: "off" }, true, false));
  measurements.push(await impactRun("default-status-wait-cold", {}, true, true));

  for (const profile of startupProfiles()) {
    for (let index = 0; index < startupRepeats; index += 1) {
      measurements.push(await startupRun(`${profile.id}-${index + 1}`, profile.env));
    }
  }

  const cdsTraining = await startupRun("cds-training", {
    JDTLS_EXTRA_ARGS: `--jvm-arg=-XX:+AutoCreateSharedArchive --jvm-arg=-XX:SharedArchiveFile=${cdsPath}`
  });
  cdsTraining.cacheFileBytes = await waitForFileBytes(cdsPath, 15000);
  measurements.push(cdsTraining);
  if (cdsTraining.cacheFileBytes) {
    for (let index = 0; index < startupRepeats; index += 1) {
      measurements.push(await startupRun(`cds-use-${index + 1}`, {
        JDTLS_EXTRA_ARGS: `--jvm-arg=-XX:SharedArchiveFile=${cdsPath}`
      }));
    }
  }

  const aotTraining = await startupRun("aot-training", {
    JDTLS_EXTRA_ARGS: `--jvm-arg=-XX:AOTCacheOutput=${aotPath}`
  });
  aotTraining.cacheFileBytes = await waitForFileBytes(aotPath, 15000);
  measurements.push(aotTraining);
  if (aotTraining.cacheFileBytes) {
    for (let index = 0; index < startupRepeats; index += 1) {
      measurements.push(await startupRun(`aot-use-${index + 1}`, {
        JDTLS_EXTRA_ARGS: `--jvm-arg=-XX:AOTCache=${aotPath}`
      }));
    }
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    repoRoot,
    anchor,
    startupRepeats,
    waitMs,
    tempRoot,
    summary: summarize(measurements),
    measurements
  }, null, 2));
} finally {
  if (process.env.JAVA_LSP_BENCH_KEEP_TEMP !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function startupProfiles(): Array<{ id: string; env: Record<string, string> }> {
  return [
    { id: "default-start", env: {} },
    { id: "g1-xms1g-dedup-start", env: { JDTLS_EXTRA_ARGS: "--jvm-arg=-Xms1g --jvm-arg=-XX:+UseStringDeduplication" } },
    { id: "zgc-xms1g-start", env: { JDTLS_EXTRA_ARGS: "--jvm-arg=-Xms1g --jvm-arg=-XX:+UseZGC" } }
  ];
}

async function startupRun(id: string, env: Record<string, string>): Promise<Measurement> {
  return withServer(env, async client => {
    const status = await timed(() => callTool(client, "java_status", { repoRoot, start: true }, 180000));
    await callTool(client, "java_shutdown", { repoRoot }, 180000).catch(() => undefined);
    return {
      id,
      kind: "startup",
      env,
      statusStartMs: status.elapsedMs,
      metrics: pickStatusMetrics(status.value)
    };
  }).catch(error => ({ id, kind: "startup", env, error: errorMessage(error) }));
}

async function impactRun(id: string, env: Record<string, string>, clearWorkspace: boolean, preStart: boolean): Promise<Measurement> {
  if (clearWorkspace) {
    clearJdtlsWorkspace();
  }
  return withServer(env, async client => {
    let statusStartMs: number | undefined;
    if (preStart) {
      const status = await timed(() => callTool(client, "java_status", { repoRoot, start: true }, 180000));
      statusStartMs = status.elapsedMs;
      await delay(waitMs);
    }
    const impact = await timed(() => callTool(client, "java_impact", impactArgs(), 180000));
    const warmImpact = await timed(() => callTool(client, "java_impact", impactArgs(), 180000));
    await callTool(client, "java_shutdown", { repoRoot }, 180000).catch(() => undefined);
    return {
      id,
      kind: "impact",
      env,
      clearWorkspace,
      waitMs: preStart ? waitMs : undefined,
      statusStartMs,
      impactMs: impact.elapsedMs,
      warmImpactMs: warmImpact.elapsedMs,
      phaseMs: metricObject(impact.value, "phaseMs"),
      warmPhaseMs: metricObject(warmImpact.value, "phaseMs"),
      metrics: {
        first: metricObject(impact.value, "sourceFacts"),
        warm: metricObject(warmImpact.value, "sourceFacts")
      }
    };
  }).catch(error => ({ id, kind: "impact", env, clearWorkspace, error: errorMessage(error) }));
}

function impactArgs(): JsonObject {
  return {
    repoRoot,
    anchors: [anchor],
    mode: "balanced",
    profile: "controller",
    semanticPolicy: "required",
    semanticTimeoutMs: 10000,
    testReadMode: "defer",
    focusModules: ["school"],
    excludeModules: [],
    taskKeywords: ["school", "template", "import", "confirm"],
    crossModulePolicy: "auto"
  };
}

async function withServer<T>(env: Record<string, string>, action: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectDir, "dist", "server.js")],
    cwd: projectDir,
    env: {
      ...process.env,
      ...env,
      JAVA_LSP_REPO_ROOT: repoRoot
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "codex-java-lsp-benchmark", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}

async function callTool(client: Client, name: string, args: JsonObject, timeout: number): Promise<JsonObject> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout }) as {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  const text = result.content?.[0]?.text || "";
  if (result.isError) {
    throw new Error(`${name} failed: ${text}`);
  }
  return JSON.parse(text) as JsonObject;
}

async function timed<T>(action: () => Promise<T>): Promise<{ elapsedMs: number; value: T }> {
  const startedAt = performance.now();
  const value = await action();
  return { elapsedMs: Math.round(performance.now() - startedAt), value };
}

function clearJdtlsWorkspace(): void {
  rmSync(path.join(repoCacheRoot(repoRoot), "workspace"), { recursive: true, force: true });
}

function pickStatusMetrics(status: JsonObject): JsonObject {
  return {
    started: status.started,
    pid: status.pid,
    fileWatcher: status.fileWatcher,
    resource: status.resource,
    progress: status.progress
  };
}

function metricObject(value: JsonObject, key: string): JsonObject {
  const metrics = value.metrics as JsonObject | undefined;
  const nested = metrics?.[key];
  return nested && typeof nested === "object" ? nested as JsonObject : {};
}

async function waitForFileBytes(file: string, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      return statSync(file).size;
    }
    await delay(250);
  }
  return undefined;
}

function summarize(rows: Measurement[]): JsonObject {
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const value = row.impactMs ?? row.statusStartMs;
    if (value === undefined || row.error) {
      continue;
    }
    const key = row.id.replace(/-\d+$/, "");
    grouped.set(key, [...grouped.get(key) || [], value]);
  }
  return Object.fromEntries([...grouped.entries()].map(([key, values]) => [key, {
    samples: values.length,
    minMs: Math.min(...values),
    medianMs: median(values),
    maxMs: Math.max(...values)
  }]));
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

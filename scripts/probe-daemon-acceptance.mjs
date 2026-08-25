#!/usr/bin/env node
// input: a healthy loopback daemon at JAVA_LSP_HTTP_PORT (default 38456).
// output: JSON with D2/D3/D4/D7 probe numbers; D1 footprint is sampled if `footprint` exists.
// pos: V1 acceptance script for the 2026-08-25 daemon stability/memory plan.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const port = process.env.JAVA_LSP_HTTP_PORT ?? "38456";
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const cacheBase = path.join(homedir(), "Library/Caches/codex-java-lsp");
const tornaRoot = "/Users/luo/Documents/program/lishu-v2-worktrees/torna-rest-all-apps";
const tornaCache = path.join(cacheBase, "07230b6e0a13");
const tornaSnap = path.join(tornaCache, "java-index-snapshot.json.gz");
const tornaMetrics = path.join(tornaCache, "cold-build-metrics.json");
const stormSamples = Number(process.env.JAVA_LSP_V1_STORM_SAMPLES ?? "12");

const pins = {
  lishuedu: {
    projectId: "lishuedu",
    hot: true,
    file: "/Users/luo/Documents/program/lishu/lishuedu/apps/lishu-edu-app/src/main/java/com/lishu/edu/LishuEduApiApplication.java"
  },
  "lishu-v2": {
    projectId: "lishu-v2",
    hot: true,
    file: "/Users/luo/Documents/program/lishu-v2/apps/lishu-education-backend/src/main/java/com/lishu/edu/education/LishuEducationBackendApplication.java"
  },
  cipherlink: {
    projectId: "cipherlink",
    hot: false,
    file: "/Users/luo/Documents/program/cipherlink/apps/cipherlink-backend/src/main/java/com/hhtele/cipherlink/backend/CipherlinkBackendApplication.java"
  },
  "exam-parent-v3": {
    projectId: "exam-parent-v3",
    hot: false,
    file: "/Users/luo/Documents/program/exam-parent-v3/lishu-exam-service/src/main/java/com/lishu/exam/LishuExamApplication.java"
  }
};

function toolText(result) {
  return (result.content ?? []).map(part => part.text ?? "").join("");
}

async function call(client, name, args) {
  const t0 = performance.now();
  const result = await client.callTool({ name, arguments: args });
  return { elapsedMs: performance.now() - t0, isError: Boolean(result.isError), text: toolText(result) };
}

function daemonPid() {
  try {
    return execFileSync("pgrep", ["-f", "max-old-space-size=768.*http-server.js"], { encoding: "utf8" })
      .trim()
      .split("\n")[0] || null;
  } catch {
    return null;
  }
}

async function healthzSample(n) {
  const samples = [];
  let timeouts = 0;
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
      samples.push(performance.now() - t0);
      if (!response.ok) timeouts += 1;
    } catch {
      timeouts += 1;
      samples.push(2000);
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: samples.length,
    timeouts,
    maxMs: Math.max(0, ...samples),
    p99Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] ?? 0
  };
}

function footprintMiB(pid) {
  if (!pid) return Promise.resolve(null);
  return new Promise(resolve => {
    const child = spawn("footprint", ["-p", pid], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("close", () => {
      const match = /phys_footprint:\s+([\d.]+)\s+MB/i.exec(out);
      resolve(match ? Number(match[1]) : null);
    });
  });
}

const client = new Client({ name: "v1-acceptance-probe", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(url));

const health = await healthzSample(stormSamples);
const pid = daemonPid();
const impacts = {};
for (const [id, pin] of Object.entries(pins)) {
  const result = await call(client, "java_impact", {
    projectId: pin.projectId,
    anchors: [{ file: pin.file, line: 1, column: 1 }],
    mode: "minimal",
    semanticPolicy: "fast"
  });
  impacts[id] = {
    hot: pin.hot,
    elapsedMs: result.elapsedMs,
    isError: result.isError,
    toolFail: result.isError || /Deadline exceeded before java-index/i.test(result.text)
  };
}

const d4short = await call(client, "java_impact", {
  projectId: "cipherlink",
  anchors: [{ file: pins.cipherlink.file, line: 1, column: 1 }],
  mode: "minimal",
  semanticPolicy: "fast",
  deadlineMs: 1500
});
const d4retry = await call(client, "java_impact", {
  projectId: "cipherlink",
  anchors: [{ file: pins.cipherlink.file, line: 1, column: 1 }],
  mode: "minimal",
  semanticPolicy: "fast"
});

const metricsBefore = existsSync(tornaMetrics) ? statSync(tornaMetrics).mtimeMs : null;
if (existsSync(tornaSnap) && process.env.JAVA_LSP_V1_KEEP_TORNA_SNAP !== "1") {
  unlinkSync(tornaSnap);
}
const d7status = await call(client, "java_status", { repoRoot: tornaRoot });
let d7payload;
try {
  d7payload = JSON.parse(d7status.text);
} catch {
  d7payload = { parseError: d7status.text.slice(0, 400) };
}
const d7impact = await call(client, "java_impact", {
  repoRoot: tornaRoot,
  anchors: [{
    file: `${tornaRoot}/apps/lishu-education-backend/src/main/java/com/lishu/edu/education/LishuEducationBackendApplication.java`,
    line: 1,
    column: 1
  }],
  mode: "minimal",
  semanticPolicy: "fast",
  deadlineMs: 15000
});
await client.close().catch(() => undefined);

const seed = d7payload.javaIndex?.worktreeSeed ?? null;
const metricsAfter = existsSync(tornaMetrics) ? statSync(tornaMetrics).mtimeMs : null;
const report = {
  health,
  pid,
  footprintMiB: await footprintMiB(pid),
  impacts,
  d4: {
    shortElapsedMs: d4short.elapsedMs,
    shortError: d4short.isError,
    retryElapsedMs: d4retry.elapsedMs,
    retryError: d4retry.isError,
    rangeGap: d4short.text.includes("Read-range query exceeded")
  },
  d7: {
    statusElapsedMs: d7status.elapsedMs,
    statusError: d7status.isError,
    seed,
    impactError: d7impact.isError,
    childSpawned: metricsAfter !== null && metricsBefore !== null && metricsAfter > metricsBefore + 500
  }
};

const d2 = health.timeouts === 0 && health.p99Ms < 100;
const d3a = Object.values(impacts).some(row => row.hot && !row.toolFail && row.elapsedMs <= 3000);
const d3b = Object.values(impacts).filter(row => !row.hot).every(row => !row.toolFail);
const d4 = !d4retry.isError && d4retry.elapsedMs <= 500;
const d7 = (seed?.completion === "SEEDED_DEGRADED" || seed?.completion === "RECONCILED_COMPLETE")
  && (seed?.reusedFiles ?? 0) >= 0.9 * 1886
  && report.d7.childSpawned === false
  && d7status.elapsedMs <= 15000
  && !d7status.isError;
report.gates = { D2: d2, D3a: d3a, D3b: d3b, D4: d4, D7: d7 };

const out = process.env.JAVA_LSP_V1_PROBE_OUT ?? path.join(process.cwd(), "docs/phase-d/v1-probe.json");
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = d2 && d3a && d3b && d4 && d7 ? 0 : 2;

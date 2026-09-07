#!/usr/bin/env node
// input: a healthy loopback daemon at JAVA_LSP_HTTP_PORT (default 38456).
// output: JSON with D2/D4/D6 and P2-G2/G5 probe numbers.
// pos: P3-T3 acceptance: drop D3a/D3b/D7/FSX_*; index-on-disk SQLite daemon.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
    file: "/Users/luo/Documents/program/exam-parent-v3/exam-management/src/main/java/com/hhtele/exam/management/ExamManagementApplication.java"
  }
};

function toolText(result) {
  return (result.content ?? []).map(part => part.text ?? "").join("");
}

async function call(client, name, args) {
  const t0 = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const text = toolText(result);
  return {
    elapsedMs: performance.now() - t0,
    isError: Boolean(result.isError),
    text,
    toolFail: Boolean(result.isError) || /Deadline exceeded before java-index/i.test(text)
  };
}

function daemonPid() {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).trim();
    return out.split("\n")[0] || null;
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

const daemonLog = path.join(homedir(), "Library/Logs/codex-java-lsp-mcp/daemon.stderr.log");
const logOffset = existsSync(daemonLog) ? statSync(daemonLog).size : 0;

function scanDaemonLogWindow() {
  if (!existsSync(daemonLog)) {
    return { fatal: 0, ebadf: 0, crashMarkers: 0, ready: 0, windowBytes: 0 };
  }
  const buf = readFileSync(daemonLog);
  const text = buf.subarray(Math.min(logOffset, buf.length)).toString("utf8");
  return {
    fatal: (text.match(/FATAL ERROR/g) ?? []).length,
    ebadf: (text.match(/spawn EBADF/g) ?? []).length,
    crashMarkers: (text.match(/codex-java-lsp-crash/g) ?? []).length,
    ready: (text.match(/HTTP daemon ready/g) ?? []).length,
    windowBytes: text.length
  };
}

function crashMarkerSourcePresent() {
  const candidates = [
    path.join(process.cwd(), "src/process-crash-markers.ts"),
    path.join(process.cwd(), "dist/process-crash-markers.js"),
    path.join(homedir(), "Library/Application Support/codex-java-lsp-mcp/current/dist/process-crash-markers.js")
  ];
  return candidates.some(file => existsSync(file) && readFileSync(file, "utf8").includes("codex-java-lsp-crash"));
}

const client = new Client({ name: "v1-acceptance-probe", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(url));

const health = await healthzSample(stormSamples);
const pid = daemonPid();
const unregisteredRoot = "/Users/luo/Documents/github/codex-java-lsp-mcp/fixtures/generic-java";
const d6status = await call(client, "java_status", { repoRoot: unregisteredRoot });
const impacts = {};
for (const [id, pin] of Object.entries(pins)) {
  const first = await call(client, "java_impact", {
    projectId: pin.projectId,
    anchors: [{ file: pin.file, line: 1, column: 1 }],
    mode: "minimal",
    semanticPolicy: "fast",
    deadlineMs: 15000
  });
  const follow = [];
  for (let i = 0; i < 2; i += 1) {
    follow.push(await call(client, "java_impact", {
      projectId: pin.projectId,
      anchors: [{ file: pin.file, line: 1, column: 1 }],
      mode: "minimal",
      semanticPolicy: "fast",
      deadlineMs: 15000
    }));
  }
  impacts[id] = {
    hot: pin.hot,
    elapsedMs: first.elapsedMs,
    isError: first.isError,
    toolFail: first.toolFail,
    errorText: first.toolFail ? first.text.slice(0, 240) : "",
    followElapsedMs: follow.map(row => row.elapsedMs),
    followFail: follow.some(row => row.toolFail)
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

function rssMiB(targetPid) {
  if (!targetPid) return null;
  try {
    return Number(execFileSync("/bin/ps", ["-o", "rss=", "-p", String(targetPid)], { encoding: "utf8" }).trim()) / 1024;
  } catch {
    return null;
  }
}

await new Promise(resolve => setTimeout(resolve, 5000));
const g2 = await call(client, "java_impact", {
  projectId: "lishu-v2",
  anchors: [{ file: pins["lishu-v2"].file, line: 1, column: 1 }],
  mode: "minimal",
  semanticPolicy: "fast",
  deadlineMs: 15000
});
const rssAfterQuery = rssMiB(pid);
await client.close().catch(() => undefined);

const d2 = health.timeouts === 0 && health.p99Ms < 100;
const d4 = !d4retry.isError && d4retry.elapsedMs <= 500;
const d6 = !d6status.toolFail && d6status.elapsedMs <= 3000;
const g2pass = !g2.toolFail && g2.elapsedMs <= 300;
const g5pass = rssAfterQuery !== null && rssAfterQuery <= 250;
const report = {
  health,
  pid,
  d6: {
    elapsedMs: d6status.elapsedMs,
    isError: d6status.isError,
    toolFail: d6status.toolFail,
    errorText: d6status.toolFail ? d6status.text.slice(0, 240) : ""
  },
  d4: {
    shortElapsedMs: d4short.elapsedMs,
    shortError: d4short.isError,
    retryElapsedMs: d4retry.elapsedMs,
    retryError: d4retry.isError
  },
  g2: { elapsedMs: g2.elapsedMs, toolFail: g2.toolFail },
  g5: { rssAfterQueryMiB: rssAfterQuery },
  gates: { D2: d2, D4: d4, D6: d6, "P2-G2": g2pass, "P2-G5": g5pass }
};
const out = process.env.JAVA_LSP_V1_PROBE_OUT ?? path.join(process.cwd(), "docs/phase-x/p3-probe.json");
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = d2 && d4 && d6 && g2pass && g5pass ? 0 : 2;
process.exit();


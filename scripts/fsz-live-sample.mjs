#!/usr/bin/env node
// One FSZ live sample: healthz, pin STATUS heapSplit (columnar/intern/tombstone),
// telemetry, log scan for heartbeat recycle + columnar compact.
// Writes heap-growth.jsonl + latest.json under this directory. Exit 1 on FAIL.
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOME = homedir();
const WATCH = path.join(HOME, "Library/Logs/codex-java-lsp-mcp/fsz-watch");
const JSONL = path.join(WATCH, "heap-growth.jsonl");
const STATE_PATH = path.join(WATCH, "state.json");
const LATEST = path.join(WATCH, "latest.json");
const LOG = path.join(HOME, "Library/Logs/codex-java-lsp-mcp/daemon.stderr.log");
const TELEMETRY = path.join(HOME, "Library/Caches/codex-java-lsp/telemetry");
const RUNTIME = path.join(HOME, "Library/Application Support/codex-java-lsp-mcp");
const FSY_JSONL = path.join(HOME, "Library/Logs/codex-java-lsp-mcp/fsy-watch/heap-growth.jsonl");
const EXPECTED_SHA = "6148de23d3cd";
const PORT = process.env.JAVA_LSP_HTTP_PORT ?? "38456";
const PINS = [
  { projectId: "lishu-v2", hot: true },
  { projectId: "lishuedu", hot: true },
  { projectId: "cipherlink", hot: false },
  { projectId: "exam-parent-v3", hot: false }
];
const FSZ_SPLIT_KEYS = [
  "columnarBytes",
  "stringTableBytes",
  "tombstoneRatio",
  "knowledgeBuilderBytes",
  "entitySearchBytes"
];

mkdirSync(WATCH, { recursive: true });

const now = new Date();
const sampledAt = now.toISOString();
const failures = [];
const warnings = [];

function loadState() {
  if (!existsSync(STATE_PATH)) {
    return {
      watchStartedAt: sampledAt,
      recycleEvents: [],
      compactEvents: [],
      samples: 0
    };
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function toolText(result) {
  return (result.content ?? []).map(part => part.text ?? "").join("");
}

function pickSplit(heapSplit) {
  if (!heapSplit || typeof heapSplit !== "object") return null;
  return {
    heapUsedMb: heapSplit.heapUsedMb,
    rssMb: heapSplit.rssMb,
    poolBundles: heapSplit.poolBundles,
    familyRootCount: heapSplit.familyRootCount,
    thisRootFiles: heapSplit.thisRootFiles,
    thisRootOverlayFiles: heapSplit.thisRootOverlayFiles,
    graphSynced: heapSplit.graphSynced,
    donorStoreBytes: heapSplit.donorStoreBytes,
    overlayBytes: heapSplit.overlayBytes,
    graphBytes: heapSplit.graphBytes,
    parseTreeCacheBytes: heapSplit.parseTreeCacheBytes,
    otherBytes: heapSplit.otherBytes,
    columnarBytes: heapSplit.columnarBytes,
    stringTableBytes: heapSplit.stringTableBytes,
    tombstoneRatio: heapSplit.tombstoneRatio,
    knowledgeBuilderBytes: heapSplit.knowledgeBuilderBytes,
    entitySearchBytes: heapSplit.entitySearchBytes
  };
}

async function healthz() {
  const response = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(5000) });
  const body = await response.json();
  if (!response.ok || body.status !== "ok") failures.push(`healthz not ok: ${JSON.stringify(body)}`);
  if (body.buildSha && !String(body.buildSha).startsWith(EXPECTED_SHA)) {
    failures.push(`unexpected buildSha ${body.buildSha} (want ${EXPECTED_SHA})`);
  }
  return body;
}

function daemonPid() {
  try {
    const out = execFileSync("launchctl", ["print", `gui/${process.getuid()}/com.lky.codex-java-lsp-mcp`], {
      encoding: "utf8"
    });
    const match = out.match(/^\s*pid = (\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function physFootprintMb(pid) {
  if (!pid) return undefined;
  try {
    const out = execFileSync("footprint", ["-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const match = out.match(/phys_footprint[^\d]*([\d.]+)\s*([KMG])/i);
    if (!match) return undefined;
    const value = Number(match[1]);
    const unit = match[2].toUpperCase();
    if (unit === "G") return value * 1024;
    if (unit === "K") return value / 1024;
    return value;
  } catch {
    return undefined;
  }
}

function telemetrySnapshot() {
  if (!existsSync(TELEMETRY) || !statSync(TELEMETRY).isDirectory()) {
    failures.push("telemetry/ directory missing");
    return { present: false, files: [], bytes: 0, lines: 0 };
  }
  const files = readdirSync(TELEMETRY).filter(name => /^impact-\d+\.jsonl$/.test(name)).sort();
  let bytes = 0;
  let lines = 0;
  for (const name of files) {
    const full = path.join(TELEMETRY, name);
    bytes += statSync(full).size;
    lines += readFileSync(full, "utf8").split("\n").filter(Boolean).length;
  }
  if (files.length === 0) warnings.push("telemetry/ exists but has no impact-*.jsonl");
  return { present: true, files, bytes, lines };
}

function scanLogs(state) {
  if (!existsSync(LOG)) {
    failures.push("daemon.stderr.log missing");
    return {
      readyLine: null,
      fatal: 0,
      ebadf: 0,
      recycle: [],
      compact: [],
      heartbeat: [],
      newRecycles: [],
      newCompacts: [],
      windowStart: -1
    };
  }
  const text = readFileSync(LOG, "utf8");
  const lines = text.split("\n");
  let readyIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].includes("HTTP daemon ready at http://127.0.0.1:")) {
      readyIndex = i;
      break;
    }
  }
  const window = readyIndex >= 0 ? lines.slice(readyIndex) : lines.slice(-200);
  const fatal = window.filter(line => line.includes("FATAL ERROR")).length;
  const ebadf = window.filter(line => /spawn EBADF/i.test(line)).length;
  const recycle = window.filter(line => line.includes("worker heap recycle"));
  const heartbeat = window.filter(line => line.includes("source=heartbeat"));
  const compact = window.filter(line => line.includes("columnar compact"));
  if (fatal > 0) failures.push(`FATAL ERROR in current process window: ${fatal}`);
  if (ebadf > 0) failures.push(`spawn EBADF in current process window: ${ebadf}`);
  const seenRecycle = new Set((state.recycleEvents ?? []).map(event => event.line));
  const seenCompact = new Set((state.compactEvents ?? []).map(event => event.line));
  const newRecycles = [];
  const newCompacts = [];
  for (const line of recycle) {
    if (seenRecycle.has(line)) continue;
    newRecycles.push({ ts: sampledAt, line: line.slice(0, 240) });
  }
  for (const line of compact) {
    if (seenCompact.has(line)) continue;
    newCompacts.push({ ts: sampledAt, line: line.slice(0, 240) });
  }
  return {
    readyLine: readyIndex >= 0 ? readyIndex + 1 : null,
    fatal,
    ebadf,
    recycle,
    compact,
    heartbeat,
    newRecycles,
    newCompacts,
    windowStart: readyIndex
  };
}

async function pinStatuses() {
  const current = path.join(RUNTIME, "current");
  const sdkRoot = path.join(current, "node_modules/@modelcontextprotocol/sdk/dist/esm");
  const { Client } = await import(pathToFileURL(path.join(sdkRoot, "client/index.js")).href);
  const { StreamableHTTPClientTransport } = await import(
    pathToFileURL(path.join(sdkRoot, "client/streamableHttp.js")).href
  );
  const client = new Client({ name: "fsz-watch", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const pins = [];
  try {
    for (const pin of PINS) {
      const result = await client.callTool({
        name: "java_status",
        arguments: { projectId: pin.projectId, start: false, detail: "diagnostic" }
      });
      const text = toolText(result);
      let payload = {};
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { parseError: text.slice(0, 200) };
      }
      const javaIndex = payload.javaIndex ?? {};
      const heapSplit = pickSplit(javaIndex.heapSplit);
      const heapUsedMb = heapSplit?.heapUsedMb
        ?? (typeof javaIndex.heapUsedBytes === "number" ? javaIndex.heapUsedBytes / (1024 * 1024) : null);
      const pinSample = {
        projectId: pin.projectId,
        hot: pin.hot,
        isError: Boolean(result.isError),
        indexState: javaIndex.state ?? payload.state,
        files: javaIndex.files,
        factsHydrated: javaIndex.factsHydrated,
        hibernated: javaIndex.hibernated,
        heapUsedMb: heapUsedMb == null ? null : Math.round(heapUsedMb),
        heapSplit
      };
      pins.push(pinSample);
      if (result.isError) warnings.push(`${pin.projectId} java_status error`);
      if (typeof heapUsedMb === "number" && heapUsedMb >= 1530) {
        failures.push(`${pin.projectId} heapUsedMb=${Math.round(heapUsedMb)} near 1536 wall`);
      } else if (typeof heapUsedMb === "number" && heapUsedMb > 1200) {
        warnings.push(`${pin.projectId} heapUsedMb=${Math.round(heapUsedMb)} above FSZ1 recycle threshold`);
      }
      if (pin.hot && javaIndex.hibernated) {
        warnings.push(`${pin.projectId} hot pin is hibernated`);
      }
      if (pin.hot && !javaIndex.hibernated && heapSplit) {
        for (const key of FSZ_SPLIT_KEYS) {
          if (heapSplit[key] == null) warnings.push(`${pin.projectId} heapSplit missing ${key}`);
        }
      }
      if (typeof heapSplit?.tombstoneRatio === "number" && heapSplit.tombstoneRatio > 0.35) {
        warnings.push(`${pin.projectId} tombstoneRatio=${heapSplit.tombstoneRatio.toFixed(3)} above compact threshold`);
      }
    }
  } finally {
    await client.close().catch(() => undefined);
  }
  return pins;
}

function slopeMiBPer24h(samples, pins) {
  const hot = pins.filter(pin => pin.hot && typeof pin.heapUsedMb === "number");
  if (hot.length === 0 || samples.length < 1) return null;
  const first = samples[0];
  const firstHot = (first.pins ?? []).filter(pin => pin.hot && typeof pin.heapUsedMb === "number");
  if (firstHot.length === 0) return null;
  const hours = (Date.parse(sampledAt) - Date.parse(first.sampledAt)) / 3600000;
  if (hours < 3) return { hours, value: null, note: "need >=3h span" };
  const nowMax = Math.max(...hot.map(pin => pin.heapUsedMb));
  const firstMax = Math.max(...firstHot.map(pin => pin.heapUsedMb));
  const value = ((nowMax - firstMax) / hours) * 24;
  return { hours, firstMax, nowMax, value };
}

function monotonicClimbHours(samples, pins) {
  const series = [...samples, { sampledAt, pins }]
    .map(sample => {
      const hot = (sample.pins ?? []).filter(pin => pin.hot && typeof pin.heapUsedMb === "number");
      if (hot.length === 0) return null;
      return { sampledAt: sample.sampledAt, max: Math.max(...hot.map(pin => pin.heapUsedMb)) };
    })
    .filter(Boolean);
  if (series.length < 2) return null;
  let climbStart = series[series.length - 1];
  for (let i = series.length - 2; i >= 0; i -= 1) {
    if (series[i].max <= climbStart.max) {
      climbStart = series[i];
      continue;
    }
    break;
  }
  const hours = (Date.parse(series[series.length - 1].sampledAt) - Date.parse(climbStart.sampledAt)) / 3600000;
  return {
    hours,
    from: climbStart.max,
    to: series[series.length - 1].max,
    fromAt: climbStart.sampledAt
  };
}

function fsyBaseline() {
  if (!existsSync(FSY_JSONL)) return null;
  const rows = readFileSync(FSY_JSONL, "utf8").split("\n").filter(Boolean).map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
  if (rows.length === 0) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const pinHeap = sample => Object.fromEntries(
    (sample.pins ?? []).map(pin => [pin.projectId, pin.heapUsedMb])
  );
  return {
    samples: rows.length,
    firstAt: first.sampledAt,
    lastAt: last.sampledAt,
    firstHeap: pinHeap(first),
    lastHeap: pinHeap(last),
    lastFatal: last.logs?.fatal ?? null,
    lastRecycle: last.logs?.recycleThisWindow ?? null,
    lastVerdict: last.verdict
  };
}

const state = loadState();
let health;
try {
  health = await healthz();
} catch (error) {
  health = { error: String(error) };
  failures.push(`healthz fetch failed: ${error instanceof Error ? error.message : String(error)}`);
}

const pid = daemonPid();
const footprintMb = physFootprintMb(pid);
const telemetry = telemetrySnapshot();
const logs = scanLogs(state);
let pins = [];
try {
  pins = await pinStatuses();
} catch (error) {
  failures.push(`java_status failed: ${error instanceof Error ? error.message : String(error)}`);
}

const isFirstSample = (state.samples ?? 0) === 0;
state.recycleEvents = [...(state.recycleEvents ?? []), ...logs.newRecycles];
state.compactEvents = [...(state.compactEvents ?? []), ...logs.newCompacts];
if (isFirstSample) {
  state.recycleBaseline = state.recycleEvents.length;
  state.compactBaseline = state.compactEvents.length;
}
const watchHours = (Date.parse(sampledAt) - Date.parse(state.watchStartedAt)) / 3600000;
const recycleBudgeted = Math.max(0, state.recycleEvents.length - (state.recycleBaseline ?? 0));
const compactBudgeted = Math.max(0, state.compactEvents.length - (state.compactBaseline ?? 0));
if (watchHours >= 24 && recycleBudgeted + compactBudgeted > 3) {
  failures.push(`FSZ §8.4 not converged: ${recycleBudgeted} recycle + ${compactBudgeted} compact after T0 in ${watchHours.toFixed(1)}h`);
}

const priorSamples = existsSync(JSONL)
  ? readFileSync(JSONL, "utf8").split("\n").filter(Boolean).map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean)
  : [];
const slope = slopeMiBPer24h(priorSamples, pins);
if (slope?.value != null && slope.value > 50) {
  warnings.push(`hot-pin heap slope ${slope.value.toFixed(1)} MiB/24h exceeds 50`);
}
const climb = monotonicClimbHours(priorSamples, pins);
if (climb?.hours >= 12 && climb.to > climb.from) {
  warnings.push(`hot-pin heap climbed ${climb.from}->${climb.to} over ${climb.hours.toFixed(1)}h`);
}

const soak24h = watchHours >= 24 && failures.length === 0 ? "PASS" : watchHours >= 24 ? "FAIL" : "IN_PROGRESS";
const verdict = failures.length > 0 ? "FAILED" : warnings.length > 0 ? "WARN" : "OK";
const fsy = fsyBaseline();

const sample = {
  sampledAt,
  verdict,
  soak24h,
  expectedSha: EXPECTED_SHA,
  watchStartedAt: state.watchStartedAt,
  watchHours: Number(watchHours.toFixed(2)),
  health,
  pid,
  footprintMb,
  telemetry,
  logs: {
    readyLine: logs.readyLine,
    fatal: logs.fatal,
    ebadf: logs.ebadf,
    recycleThisWindow: logs.recycle.length,
    recycleHeartbeatThisWindow: logs.heartbeat.length,
    compactThisWindow: logs.compact.length,
    recycleSinceWatch: state.recycleEvents.length,
    compactSinceWatch: state.compactEvents.length,
    recycleBudgeted,
    compactBudgeted
  },
  slope,
  climb,
  pins,
  fsyBaseline: fsy,
  failures,
  warnings
};

appendFileSync(JSONL, `${JSON.stringify(sample)}\n`);
writeFileSync(LATEST, `${JSON.stringify(sample, null, 2)}\n`);
state.samples = (state.samples ?? 0) + 1;
state.lastSampleAt = sampledAt;
state.lastVerdict = verdict;
writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  verdict,
  soak24h,
  sampledAt,
  buildSha: health?.buildSha,
  recycleSinceWatch: state.recycleEvents.length,
  compactSinceWatch: state.compactEvents.length,
  recycleBudgeted,
  compactBudgeted,
  telemetryLines: telemetry.lines,
  pins: pins.map(pin => ({
    projectId: pin.projectId,
    heapUsedMb: pin.heapUsedMb,
    files: pin.files,
    hibernated: pin.hibernated,
    tombstoneRatio: pin.heapSplit?.tombstoneRatio ?? null,
    columnarBytes: pin.heapSplit?.columnarBytes ?? null,
    stringTableBytes: pin.heapSplit?.stringTableBytes ?? null,
    entitySearchBytes: pin.heapSplit?.entitySearchBytes ?? null,
    knowledgeBuilderBytes: pin.heapSplit?.knowledgeBuilderBytes ?? null
  })),
  failures,
  warnings,
  jsonl: JSONL
})}\n`);

process.exitCode = failures.length > 0 ? 1 : 0;

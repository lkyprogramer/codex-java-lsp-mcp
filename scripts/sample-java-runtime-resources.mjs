#!/usr/bin/env node
// input: An isolated validation command plus sampling configuration.
// output: Raw process-tree RSS/CPU/fd samples and a hashable resource summary.
// pos: V3.2-05 sidecar; it only observes the child tree it spawns and can never attach to the active LSP.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateCandidateNodeCommand } from "./isolation-utils.mjs";

export function parsePsTable(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([^\s]+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuTimeMs: parseCpuTimeMs(match[4]),
      command: match[5]
    });
  }
  return rows;
}

export function processTree(rows, rootPid) {
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!included.has(row.pid) && included.has(row.ppid)) {
        included.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(row => included.has(row.pid));
}

export function summarizeResourceSamples(samples, warmupMs, javaIndex = "unknown") {
  const processes = new Map();
  for (const sample of samples) {
    for (const process of sample.processes) {
      const identity = `${process.pid}:${process.startIdentity ?? "UNMEASURED"}`;
      const entry = processes.get(identity) ?? {
        pid: process.pid,
        ppid: process.ppid,
        startIdentity: process.startIdentity,
        role: process.role,
        executable: process.executable,
        commandSha256: process.commandSha256 ?? sha256(process.command ?? ""),
        firstSeenMs: sample.tMs,
        lastSeenMs: sample.tMs,
        peakRssBytes: 0,
        peakFdCount: undefined,
        firstCpuTimeMs: process.cpuTimeMs,
        lastCpuTimeMs: process.cpuTimeMs
      };
      entry.lastSeenMs = sample.tMs;
      entry.peakRssBytes = Math.max(entry.peakRssBytes, process.rssBytes);
      if (Number.isFinite(process.fdCount)) {
        entry.peakFdCount = Math.max(entry.peakFdCount ?? 0, process.fdCount);
      }
      entry.lastCpuTimeMs = process.cpuTimeMs;
      processes.set(identity, entry);
    }
  }
  const totals = samples.map(sample => ({
    tMs: sample.tMs,
    rssBytes: sample.processes.reduce((sum, process) => sum + process.rssBytes, 0)
  }));
  const postWarmup = totals.filter(sample => sample.tMs >= warmupMs);
  return {
    sampleCount: samples.length,
    peakProcessTreeRssBytes: totals.length > 0
      ? totals.reduce((peak, sample) => Math.max(peak, sample.rssBytes), 0)
      : undefined,
    warmupMs,
    sampledRetentionSlopeBytesPerMinute: postWarmup.length >= 3
      && postWarmup.at(-1).tMs - postWarmup[0].tMs >= 1000
      ? Math.round(linearSlope(postWarmup) * 60_000)
      : undefined,
    processes: [...processes.values()]
      .map(process => ({
        ...process,
        cpuTimeDeltaMs: Math.max(0, process.lastCpuTimeMs - process.firstCpuTimeMs)
      }))
      .sort((left, right) => left.pid - right.pid),
    workerThreadAccounting: {
      javaIndexWorker: javaIndex === "present"
        ? "INCLUDED_IN_NODE_PROCESS"
        : javaIndex === "absent"
          ? "NOT_PRESENT"
          : "UNMEASURED",
      reason: javaIndex === "present"
        ? "JavaIndex uses node:worker_threads and has no separate OS RSS/CPU/fd identity"
        : javaIndex === "absent"
          ? "the selected benchmark profile does not create JavaIndex"
          : "the generic command runner cannot infer whether JavaIndex was created"
    }
  };
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("resource sampling is allowed only inside the isolated validation harness");
  }
  validateCandidateNodeCommand(cli.command);
  const resolvedOutput = path.resolve(cli.output);
  if (existsSync(resolvedOutput)) throw new Error(`resource output already exists: ${resolvedOutput}`);
  const startedAt = performance.now();
  const child = spawn(cli.command[0], cli.command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  // Register lifecycle listeners immediately. A very short target can exit
  // while the first ps/fd sample is still running; attaching later would miss
  // the one-shot event and hang the evidence runner forever.
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const samples = [];
  const failures = [];
  const identities = new Map();
  let sampling = false;
  let activeSample = Promise.resolve();
  let missedSamples = 0;
  let sampleIndex = 0;
  const sample = async () => {
    if (sampling) {
      missedSamples += 1;
      return activeSample;
    }
    if (child.pid === undefined) return;
    sampling = true;
    activeSample = (async () => {
      const sampleStartedAt = performance.now();
      try {
        const table = parsePsTable(await capture("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], 1000));
        const tree = processTree(table, child.pid);
        const processes = [];
        for (const process of tree) {
          let startIdentity = identities.get(process.pid);
          if (!startIdentity) {
            startIdentity = await processStartIdentity(process.pid).catch(error => {
              failures.push({ tMs: roundedMs(performance.now() - startedAt), phase: "process-identity", pid: process.pid, error: errorMessage(error) });
              return undefined;
            });
            if (startIdentity) identities.set(process.pid, startIdentity);
          }
          const observedFdCount = sampleIndex % cli.fdSampleEvery === 0
            ? await fdCount(process.pid).catch(error => {
                failures.push({ tMs: roundedMs(performance.now() - startedAt), phase: "fd", pid: process.pid, error: errorMessage(error) });
                return undefined;
              })
            : undefined;
          processes.push({
            pid: process.pid,
            ppid: process.ppid,
            startIdentity,
            role: process.pid === child.pid ? "target-root" : jdtProcess(process.command) ? "jdt" : "descendant",
            executable: path.basename(process.command.trim().split(/\s+/)[0] || "unknown"),
            commandSha256: sha256(process.command),
            rssBytes: process.rssBytes,
            cpuTimeMs: process.cpuTimeMs,
            fdCount: observedFdCount
          });
        }
        if (processes.length > 0) {
          samples.push({
            tMs: roundedMs(performance.now() - startedAt),
            durationMs: roundedMs(performance.now() - sampleStartedAt),
            processes
          });
          sampleIndex += 1;
        }
      } catch (error) {
        failures.push({ tMs: roundedMs(performance.now() - startedAt), phase: "process-tree", error: errorMessage(error) });
      }
    })();
    try {
      await activeSample;
    } finally {
      sampling = false;
    }
  };
  await sample();
  const timer = setInterval(() => { void sample(); }, cli.intervalMs);
  const exit = await exitPromise;
  clearInterval(timer);
  await activeSample;
  await sample();
  const summary = summarizeResourceSamples(samples, cli.warmupMs, cli.javaIndex);
  const fdMeasured = samples.some(item => item.processes.some(process => Number.isFinite(process.fdCount)));
  const processTreeMeasured = samples.length > 0;
  const payload = {
    schemaVersion: "java-intelligence-v32-process-tree-resources/v1",
    status: exit.code === 0 ? "PARTIAL" : "FAILED",
    generatedAt: new Date().toISOString(),
    configuration: {
      intervalMs: cli.intervalMs,
      fdSampleEvery: cli.fdSampleEvery,
      warmupMs: cli.warmupMs,
      commandSha256: sha256(JSON.stringify(cli.command)),
      isolation: "spawned-child-tree-only",
      javaIndex: cli.javaIndex,
      missedSamples
    },
    rootProcess: { pid: child.pid, exitCode: exit.code, signal: exit.signal },
    observations: {
      processTree: { status: processTreeMeasured ? "MEASURED" : "UNMEASURED", missingReason: processTreeMeasured ? undefined : "no process sample completed" },
      rss: { status: processTreeMeasured ? "MEASURED" : "UNMEASURED", missingReason: processTreeMeasured ? undefined : "no process sample completed" },
      cpu: { status: processTreeMeasured ? "MEASURED" : "UNMEASURED", missingReason: processTreeMeasured ? undefined : "no process sample completed" },
      fd: { status: fdMeasured ? "MEASURED" : "UNMEASURED", missingReason: fdMeasured ? undefined : "no fd sample completed" },
      eventLoopDelay: { status: "UNMEASURED", reason: "external process sampler cannot inspect Node event-loop delay" },
      gc: { status: "UNMEASURED", reason: "external process sampler cannot inspect Node GC events" },
      queueDepth: { status: "UNMEASURED", reason: "queue depth requires the benchmark's in-process telemetry" }
    },
    summary,
    failures,
    samples
  };
  await writeJsonAtomically(resolvedOutput, payload);
  console.log(JSON.stringify({ status: payload.status, output: resolvedOutput, samples: samples.length }));
  if (exit.code !== 0) process.exitCode = typeof exit.code === "number" ? exit.code : 1;
}

function parseCli(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator >= 0 ? args.slice(0, separator) : args;
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  let output;
  let intervalMs = 250;
  let fdSampleEvery = 4;
  let warmupMs = 1000;
  let javaIndex = "unknown";
  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--output") output = optionArgs[++index];
    else if (arg === "--interval-ms") intervalMs = positiveInteger(optionArgs[++index], arg);
    else if (arg === "--fd-sample-every") fdSampleEvery = positiveInteger(optionArgs[++index], arg);
    else if (arg === "--warmup-ms") warmupMs = nonNegativeInteger(optionArgs[++index], arg);
    else if (arg === "--java-index") javaIndex = enumValue(optionArgs[++index], arg, new Set(["present", "absent", "unknown"]));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!output) throw new Error("--output is required");
  if (command.length === 0) throw new Error("a command is required after --");
  return { output, intervalMs, fdSampleEvery, warmupMs, javaIndex, command };
}

function parseCpuTimeMs(value) {
  const dayParts = value.split("-");
  const days = dayParts.length === 2 ? Number(dayParts[0]) : 0;
  const clock = dayParts.at(-1).split(":").map(Number);
  const seconds = clock.pop() ?? 0;
  const minutes = clock.pop() ?? 0;
  const hours = clock.pop() ?? 0;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function linearSlope(samples) {
  const meanX = samples.reduce((sum, sample) => sum + sample.tMs, 0) / samples.length;
  const meanY = samples.reduce((sum, sample) => sum + sample.rssBytes, 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    numerator += (sample.tMs - meanX) * (sample.rssBytes - meanY);
    denominator += (sample.tMs - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function jdtProcess(command) {
  return /(?:org\.eclipse\.equinox|jdt\.ls|jdtls|\/java(?:\s|$))/i.test(command);
}

async function fdCount(pid) {
  if (process.platform === "linux") return (await readdir(`/proc/${pid}/fd`)).length;
  if (process.platform !== "darwin") throw new Error(`fd sampling unsupported on ${process.platform}`);
  const output = await capture("lsof", ["-n", "-P", "-a", "-p", String(pid), "-Ff"], 500);
  return output.split(/\r?\n/).filter(line => /^f/.test(line)).length;
}

async function processStartIdentity(pid) {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    const fields = stat.slice(closing + 2).trim().split(/\s+/);
    if (!fields[19]) throw new Error("missing /proc start ticks");
    return `linux-proc-startticks:${fields[19]}`;
  }
  if (process.platform === "darwin") {
    const started = (await capture("ps", ["-p", String(pid), "-o", "lstart="], 500)).trim();
    if (!started) throw new Error("missing process start time");
    return `darwin-lstart:${started}`;
  }
  throw new Error(`process identity unsupported on ${process.platform}`);
}

function capture(command, args, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

async function writeJsonAtomically(target, payload) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await link(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function enumValue(value, label, allowed) {
  if (!allowed.has(value)) throw new Error(`${label} must be one of ${[...allowed].join(", ")}`);
  return value;
}

function roundedMs(value) {
  return Math.round(Math.max(0, value) * 1000) / 1000;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function printUsage() {
  console.log("Usage: node scripts/sample-java-runtime-resources.mjs --output FILE [--interval-ms 250] [--warmup-ms 1000] [--java-index present|absent|unknown] -- COMMAND [ARGS]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

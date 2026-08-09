#!/usr/bin/env node
// input: An isolated benchmark command plus process sampling configuration.
// output: A source-locked resource manifest with external and in-process sidecars.
// pos: V3.2-05 formal resource evidence runner; it never observes processes it did not spawn.
import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateCandidateNodeCommand } from "./isolation-utils.mjs";

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("resource benchmark requires run-isolated-validation.mjs");
  }
  validateCandidateNodeCommand(cli.command);
  const output = path.resolve(cli.output);
  const stem = output.endsWith(".json") ? output.slice(0, -5) : output;
  const processTreeOutput = `${stem}.process-tree.json`;
  const inProcessOutput = `${stem}.in-process.json`;
  for (const target of [output, processTreeOutput, inProcessOutput]) {
    if (existsSync(target)) throw new Error(`resource artifact already exists: ${target}`);
  }
  const root = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "java-runtime-resource-run-"));
  const temporaryProcessTree = path.join(root, "process-tree.json");
  const temporaryInProcess = path.join(root, "in-process.json");
  try {
    await mkdir(path.dirname(output), { recursive: true });
    const sampler = path.join(path.dirname(fileURLToPath(import.meta.url)), "sample-java-runtime-resources.mjs");
    const samplerArgs = [
      sampler,
      "--output", temporaryProcessTree,
      "--interval-ms", String(cli.intervalMs),
      "--fd-sample-every", String(cli.fdSampleEvery),
      "--warmup-ms", String(cli.warmupMs),
      "--java-index", cli.javaIndex,
      "--",
      ...cli.command
    ];
    const exitCode = await run(process.execPath, samplerArgs, {
      ...process.env,
      JAVA_LSP_RESOURCE_TELEMETRY_FILE: temporaryInProcess,
      JAVA_LSP_RESOURCE_INTERVAL_MS: String(cli.intervalMs)
    });
    const processTree = await readJsonIfPresent(temporaryProcessTree);
    const inProcess = await readJsonIfPresent(temporaryInProcess);
    const combined = combinedObservations(processTree, inProcess, cli.javaIndex);
    const status = exitCode !== 0
      ? "FAILED"
      : Object.values(combined).every(item => item.status === "MEASURED" || item.status === "NOT_APPLICABLE")
        ? "PASS"
        : "PARTIAL";

    if (processTree) await copyExclusive(temporaryProcessTree, processTreeOutput);
    if (inProcess) await copyExclusive(temporaryInProcess, inProcessOutput);
    const manifest = {
      schemaVersion: "java-intelligence-v32-resource-manifest/v1",
      status,
      generatedAt: new Date().toISOString(),
      profile: cli.profile,
      isolation: {
        marker: "JAVA_LSP_ISOLATED_VALIDATION=1",
        scope: "spawned-command-process-tree",
        activeRuntimeAttached: false
      },
      configuration: {
        intervalMs: cli.intervalMs,
        fdSampleEvery: cli.fdSampleEvery,
        warmupMs: cli.warmupMs,
        javaIndex: cli.javaIndex,
        commandSha256: sha256(JSON.stringify(cli.command))
      },
      target: { exitCode },
      observations: combined,
      samplerOverhead: summarizeSamplerOverhead(processTree),
      artifacts: {
        processTree: processTree ? await artifactIdentity(processTreeOutput) : missingArtifact("external sampler produced no artifact"),
        inProcess: inProcess ? await artifactIdentity(inProcessOutput) : missingArtifact("target emitted no in-process telemetry")
      }
    };
    await writeExclusive(output, manifest);
    console.log(JSON.stringify({ status, output, exitCode }));
    if (exitCode !== 0) process.exitCode = exitCode;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function combinedObservations(processTree, inProcess, javaIndex) {
  const external = processTree?.observations ?? {};
  const internal = inProcess?.observations ?? {};
  return {
    rss: normalizeObservation(external.rss, "external RSS unavailable"),
    cpu: normalizeObservation(external.cpu, "external CPU unavailable"),
    fd: normalizeObservation(external.fd, "external fd sampling unavailable"),
    eventLoopDelay: normalizeObservation(internal.eventLoopDelay, "target emitted no event-loop telemetry"),
    gc: normalizeObservation(internal.gc, "target emitted no GC telemetry"),
    queueDepth: javaIndex === "absent"
      ? { status: "NOT_APPLICABLE", reason: "selected profile has no JavaIndex" }
      : normalizeObservation(internal.queueDepth, "target emitted no JavaIndex queue-depth telemetry")
  };
}

function normalizeObservation(value, reason) {
  if (value?.status === "MEASURED" || value?.status === "NOT_APPLICABLE") return value;
  return { status: "UNMEASURED", reason: value?.reason ?? value?.missingReason ?? reason };
}

function summarizeSamplerOverhead(processTree) {
  const durations = (processTree?.samples ?? [])
    .map(sample => sample.durationMs)
    .filter(value => Number.isFinite(value))
    .sort((left, right) => left - right);
  return {
    status: durations.length > 0 ? "MEASURED" : "UNMEASURED",
    sampleCount: durations.length,
    missedSamples: processTree?.configuration?.missedSamples,
    durationMsP50: percentile(durations, 0.5),
    durationMsP95: percentile(durations, 0.95),
    durationMsMax: durations.at(-1)
  };
}

async function artifactIdentity(file) {
  const bytes = await readFile(file);
  return { status: "PRESENT", file, bytes: bytes.length, sha256: sha256(bytes) };
}

function missingArtifact(reason) {
  return { status: "MISSING", reason };
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function copyExclusive(source, target) {
  await copyFile(source, target, constants.COPYFILE_EXCL);
}

async function writeExclusive(file, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, payload, { flag: "wx", mode: 0o600 });
}

function parseCli(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator >= 0 ? args.slice(0, separator) : args;
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  let output;
  let profile = "generic";
  let intervalMs = 250;
  let fdSampleEvery = 4;
  let warmupMs = 1000;
  let javaIndex = "unknown";
  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--output") output = optionArgs[++index];
    else if (arg === "--profile") profile = optionArgs[++index];
    else if (arg === "--interval-ms") intervalMs = positiveInteger(optionArgs[++index], arg);
    else if (arg === "--fd-sample-every") fdSampleEvery = positiveInteger(optionArgs[++index], arg);
    else if (arg === "--warmup-ms") warmupMs = nonNegativeInteger(optionArgs[++index], arg);
    else if (arg === "--java-index") javaIndex = enumValue(optionArgs[++index], arg, new Set(["present", "absent", "unknown"]));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!output) throw new Error("--output is required");
  if (command.length === 0) throw new Error("a command is required after --");
  return { output, profile, intervalMs, fdSampleEvery, warmupMs, javaIndex, command };
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd: process.cwd(), stdio: "inherit" });
    child.once("error", reject);
    child.once("close", code => resolve(typeof code === "number" ? code : 1));
  });
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

function percentile(sorted, percentileValue) {
  if (sorted.length === 0) return undefined;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * percentileValue) - 1))];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function printUsage() {
  console.log("Usage: node scripts/run-java-runtime-resource-benchmark.mjs --output FILE --profile NAME --java-index present|absent|unknown -- COMMAND [ARGS]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

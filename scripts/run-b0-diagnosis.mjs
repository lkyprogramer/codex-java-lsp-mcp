#!/usr/bin/env node
// input: Isolated ruoyi pin + golden jsonl. Tuning scenes only.
// output: B0 miss-layer diagnosis JSON. Holdout is never written into the bench jsonl.
// pos: B0 T2. Requires isolated validation.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTuningScenes } from "./audit-golden-quality.mjs";
import {
  diagnoseBenchmarkPayload,
  summarizeDiagnosis
} from "./diagnose-impact-misses.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseCli(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help") return { help: true };
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    repo: options.get("--repo"),
    jsonl: options.get("--jsonl") || path.join(sourceRoot, "golden", "ruoyi-vue-pro.scenarios.jsonl"),
    output: options.get("--output"),
    deadlineMs: options.get("--deadline-ms") || "30000"
  };
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("benchmark did not emit JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function runBenchmark(repoRoot, scenarioFile, deadlineMs) {
  const script = path.join(sourceRoot, "dist", "benchmark-agent-impact.js");
  const args = [
    "--max-old-space-size=8192",
    script,
    "--project-id", "ruoyi-vue-pro",
    "--repo-root", repoRoot,
    "--scenarios", scenarioFile,
    "--layout-profile", "maven-reactor",
    "--warm-state", "cold-nolsp",
    "--mode", "balanced",
    "--semantic-policy", "fast",
    "--strategy", "impact",
    "--verbosity", "diagnostic",
    "--deadline-ms", String(deadlineMs),
    "--runs", "1"
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: sourceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`benchmark-agent-impact exit ${code}`));
        return;
      }
      resolve(extractJson(stdout));
    });
  });
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log("usage: node scripts/run-b0-diagnosis.mjs --repo <pin> --output <json>");
    return;
  }
  if (!cli.repo || !cli.output) throw new Error("--repo and --output are required");
  if (process.env.JAVA_LSP_ISOLATED_VALIDATION !== "1") {
    throw new Error("run-b0-diagnosis must run through isolated validation");
  }
  const loaded = loadTuningScenes(await readFile(path.resolve(cli.jsonl), "utf8"));
  const tuningFile = path.join(process.env.TMPDIR || "/tmp", "b0-ruoyi-tuning.jsonl");
  await writeFile(tuningFile, `${loaded.tuning.map(scene => JSON.stringify(scene)).join("\n")}\n`);
  console.error(`b0: tuning ${loaded.tuning.length} holdoutSkipped ${loaded.holdoutSkipped}`);
  const payload = await runBenchmark(path.resolve(cli.repo), tuningFile, cli.deadlineMs);
  const scenes = diagnoseBenchmarkPayload(payload, loaded.tuning);
  const summary = summarizeDiagnosis(scenes);
  const report = {
    schemaVersion: "b-b0-diagnosis/v1",
    dated: new Date().toISOString().slice(0, 10),
    holdoutSkipped: loaded.holdoutSkipped,
    tuning: loaded.tuning.length,
    diagnosed: scenes.length,
    retune: false,
    taskSuccess: "UNMEASURED",
    ...summary,
    scenes
  };
  await mkdir(path.dirname(path.resolve(cli.output)), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    decision: summary.next,
    output: path.resolve(cli.output),
    missFiles: summary.missFiles,
    shares: summary.shares,
    topPatterns: summary.topPatterns,
    holdoutSkipped: loaded.holdoutSkipped
  }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

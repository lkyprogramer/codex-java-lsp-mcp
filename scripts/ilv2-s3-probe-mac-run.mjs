#!/usr/bin/env node
// S3 probe on the Mac in one background job (docs/post-ilv2/s3-static-callers-design.md §8.1), following the
// long-running validation rules: per-stage logs, timeouts, a 30 s heartbeat in status.json, result.json as the terminal
// state, and one terminal Mac notification from this process. `--report` prints the counts-only S3-PROBE.json.
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cliOptions, isMain, requireValue, runCli } from "./ilv2-mac-contracts.mjs";
import { capture, parseValidationRoot, redactPaths, runStages } from "./ilv2-s1-mac-run.mjs";
import { S1_ROWS_SHA256 } from "./ilv2-s3-callers-probe.mjs";

const MINUTE = 60_000;
export const REQUIRED_ENV = Object.freeze(["ILV2_NODE_BIN", "ILV2_MAC10_DATASET", "ILV2_MAC10_INPUTS", "DS", "S1RUN"]);
const sha256File = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const readJsonFile = async file => JSON.parse(await readFile(file, "utf8"));

export function probeStages({ env, runDir }) {
  const node = env.ILV2_NODE_BIN;
  const at = (...parts) => path.join(runDir, ...parts);
  const replay = name => path.join(env.S1RUN ?? "", "s1-replay", name);
  const slug = path.basename(runDir).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 80) || "s3-probe";
  const exitOk = run => ({ pass: run.exitCode === 0, problems: run.exitCode === 0 ? [] : [`exit ${run.exitCode}`] });
  return [
    { name: "preflight", timeoutMs: 2 * MINUTE, stop: true, check: async () => {
      const problems = [];
      if ((await capture("git", ["status", "--porcelain"])).trim()) problems.push("working tree is not clean");
      for (const name of REQUIRED_ENV) if (!env[name]) problems.push(`${name} is not exported`);
      if (!env.S1RUN || !existsSync(replay("rows.jsonl")) || !existsSync(replay("responses.jsonl"))) problems.push("S1RUN s1-replay rows/responses missing");
      else if (await sha256File(replay("rows.jsonl")) !== S1_ROWS_SHA256) problems.push("S1RUN s1-replay rows.jsonl is not the recorded S1 replay");
      return { pass: problems.length === 0, problems };
    } },
    { name: "probe-tests", timeoutMs: 10 * MINUTE, stop: true, command: node, args: () => ["--test", "--test-concurrency=1", "scripts/ilv2-s3-callers-probe.test.mjs"], check: async run => exitOk(run) },
    { name: "build", timeoutMs: 40 * MINUTE, stop: true, command: "sh",
      args: () => ["scripts/run-isolated-node.sh", "scripts/run-isolated-validation.mjs", "--profile", "compile", "--keep", "--name", `${slug}-build`],
      check: async (run, ctx) => {
        if (run.exitCode !== 0) return { pass: false, problems: [`exit ${run.exitCode}`] };
        const dist = path.join(parseValidationRoot(run.stdout), "candidate/dist");
        requireValue(existsSync(path.join(dist, "build-stamp.json")), "no built dist in the kept validation root");
        ctx.facts.dist = dist;
        ctx.artifacts.buildStampSha256 = await sha256File(path.join(dist, "build-stamp.json"));
        return { pass: true };
      } },
    { name: "probe", timeoutMs: 60 * MINUTE, stop: true, needs: ctx => ctx.facts.dist ? null : "no build",
      command: node, args: ctx => ["scripts/ilv2-s3-callers-probe.mjs", "--dataset", env.ILV2_MAC10_DATASET, "--tasks", `${env.DS}/tasks-dev.jsonl`,
        "--gold", `${env.DS}/private/gold-dev.jsonl`, "--inputs", env.ILV2_MAC10_INPUTS, "--dist", ctx.facts.dist,
        "--responses", replay("responses.jsonl"), "--rows", replay("rows.jsonl"), "--out", at("probe")],
      check: async (run, ctx) => {
        if (run.exitCode !== 0 || !existsSync(at("probe/summary.json"))) return { pass: false, problems: [`exit ${run.exitCode}`] };
        ctx.facts.probe = await readJsonFile(at("probe/summary.json"));
        return { pass: true };
      } }
  ];
}

/** One macOS notification at the terminal state (long-running-validation.md §3); a failure is logged, never fatal. */
export async function notifyMac({ status, gitSha, runDir, failedStage, osascript = "/usr/bin/osascript" }) {
  if (!existsSync(osascript)) return { sent: false, reason: "no osascript" };
  const details = [`${String(gitSha).slice(0, 7)} · ${path.basename(runDir)}`, status === "PASS" ? null : `stage ${failedStage ?? "-"}`].filter(Boolean).join(" · ");
  const script = 'on run argv\n display notification (item 3 of argv) with title "Codex · Mac 验收" subtitle ((item 1 of argv) & " · " & (item 2 of argv))\nend run';
  return new Promise(resolve => {
    const child = spawn(osascript, ["-e", script, "S3-PROBE", status, details], { stdio: "ignore" });
    child.on("error", error => resolve({ sent: false, reason: error.message }));
    child.on("exit", code => resolve({ sent: code === 0, reason: code === 0 ? null : `exit ${code}` }));
  });
}

export async function runProbeValidation({ runDir, env = process.env, notify = notifyMac }) {
  requireValue(path.isAbsolute(runDir) && existsSync(runDir), "--run-dir must be an existing absolute directory");
  requireValue((await readdir(runDir)).every(name => name === "runner.log"), "--run-dir must be empty (runner.log allowed)");
  const gitSha = (await capture("git", ["rev-parse", "HEAD"])).trim();
  const result = await runStages({ runDir, gitSha, env, stages: probeStages({ env, runDir }) });
  const sent = await notify({ status: result.status, gitSha, runDir, failedStage: result.failedStage });
  if (!sent.sent) console.error(`notification not sent: ${sent.reason}`);
  return result;
}

/** The counts-only file to commit as docs/post-ilv2/results/S3-PROBE.json: no paths, no task ids. */
export async function reportFor(runDir) {
  const result = await readJsonFile(path.join(runDir, "result.json"));
  return { taskId: "S3-PROBE", status: result.status, sourceHead: result.gitSha, failedStage: result.failedStage, notRun: result.notRun,
    firstError: result.firstError && redactPaths(result.firstError),
    stages: result.stages.map(({ name, status, exitCode, startedAt, endedAt, problems }) => ({ name, status, exitCode: exitCode ?? null, startedAt, endedAt,
      problems: (problems ?? []).map(redactPaths) })),
    buildStampSha256: result.artifacts.buildStampSha256 ?? null,
    probe: result.facts.probe ?? null };
}

async function main(args) {
  const options = cliOptions(args, ["--run-dir", "--report"]);
  if (options.report) {
    console.log(JSON.stringify(await reportFor(path.resolve(options.report)), null, 2));
    return;
  }
  requireValue(options["run-dir"], "--run-dir is required");
  const result = await runProbeValidation({ runDir: path.resolve(options["run-dir"]) });
  console.log(JSON.stringify({ status: result.status, failedStage: result.failedStage }));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));

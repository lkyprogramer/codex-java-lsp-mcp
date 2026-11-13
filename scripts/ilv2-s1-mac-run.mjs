#!/usr/bin/env node
// S1 Mac validation, one branch, one background run (docs/post-ilv2/s1-implementation-listing.md §4). Follows the
// long-running validation rules (docs/deep/ilv2-mac-manual/long-running-validation.md): every stage has its own log,
// exit code, timeout and check; status.json carries a heartbeat; result.json is the terminal hand-off.
// The baseline build is main's src on this branch: the S1 src diff is reversed in the working tree only for that build
// (run-isolated-validation turns uncommitted changes into the candidate patch) and restored right after.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cliOptions, isMain, requireValue, runCli } from "./ilv2-mac-contracts.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUN_SCHEMA = "post-ilv2/s1-mac-run/v1";
export const BASELINE_SRC_COMMIT = "3d9a8d6"; // main after PR #6; its src equals 8f18ea7, S1's parent
export const S1_COMMIT = "63a2257";
export const F_HASHES = Object.freeze({
  responses: "206fe3e0e403e4c586b23310793ff80d3469df29bc0e211af5324fe0afc18a5b",
  rows: "37c8967368fb4414583f21229aefdb979dd929d99491e59b6c0419765f281d7a"
});
export const W2_CALIBRATION = Object.freeze({ meanRecall: "0.38916666666666666", fullRecall: "3" });
export const TARGETED_TESTS = Object.freeze([
  "dist/agent-router/candidate-collectors.test.js", "dist/agent-router/candidate-helpers.test.js",
  "dist/agent-router/providers/static-provider.test.js", "dist/agent-router/providers/relationship-provider.test.js",
  "dist/agent-router/read-plan.test.js", "dist/agent-router/materialize-candidates.test.js", "dist/agent-router/evidence-normalizer.test.js",
  "dist/java-index/router-integration.test.js", "dist/java-index/router-java-index.test.js"
]);
export const SCRIPT_TESTS = Object.freeze(["scripts/ilv2-s1-gate.test.mjs", "scripts/ilv2-s1-mac-run.test.mjs",
  "scripts/ilv2-relation-defect-shape.test.mjs", "scripts/ilv2-relation-text-check.test.mjs", "scripts/ilv2-impact-budget-diagnosis.test.mjs"]);
const MINUTE = 60_000;

/** The kept build root from run-isolated-validation's last stdout JSON line. */
export function parseValidationRoot(stdout) {
  const line = stdout.trim().split("\n").reverse().find(entry => entry.startsWith("{") && entry.includes("\"validationRoot\""));
  requireValue(line, "run-isolated-validation printed no validationRoot");
  return JSON.parse(line).validationRoot;
}

/** §3.1: S1's D18 rerun against the recorded D18 shapes, row by row in the same order. */
export function checkMechanism(recorded, rerun) {
  const problems = [];
  if (recorded.length !== rerun.length) return { pass: false, problems: [`row count ${rerun.length} != ${recorded.length}`] };
  recorded.forEach((before, index) => {
    const after = rerun[index];
    const where = `row ${index} (${before.hypotheses.join("+")})`;
    if (before.category !== after.category || before.linkClass !== after.linkClass) problems.push(`${where}: target order differs`);
    if (before.hypotheses.includes("H0_UNEXPLAINED")) {
      if (!after.repro.inPool || !after.repro.protectedReason) problems.push(`${where}: H0 target not in pool with a protected reason`);
      if (after.repro.poolWith.CALLS !== before.repro.poolWith.CALLS) problems.push(`${where}: CALLS ${before.repro.poolWith.CALLS} -> ${after.repro.poolWith.CALLS}`);
    } else {
      if (after.repro.poolSize !== before.repro.poolSize) problems.push(`${where}: poolSize ${before.repro.poolSize} -> ${after.repro.poolSize}`);
      if (JSON.stringify(after.repro.poolWith) !== JSON.stringify(before.repro.poolWith)) problems.push(`${where}: poolWith changed`);
    }
  });
  return { pass: problems.length === 0, problems };
}

/** §3.2 step 0: main must reproduce F exactly before F can be S1's baseline. */
export function checkBaselineGate(summary) {
  const problems = [];
  if (summary.lostTargets.count !== 0) problems.push(`lost ${summary.lostTargets.count}`);
  if (summary.gainedTargets.count !== 0) problems.push(`gained ${summary.gainedTargets.count}`);
  if (summary.receivedBytesP50Increase !== 0) problems.push(`received bytes p50 ${summary.receivedBytesP50Increase}`);
  return { pass: problems.length === 0, problems };
}

/** Terminal status: every stage ran and passed its check, and the S1 gate passed. */
export function terminalStatus(stages) {
  if (stages.some(stage => stage.status === "TIMEOUT")) return "TIMEOUT";
  if (stages.some(stage => stage.status !== "PASS")) return "FAIL";
  return "PASS";
}

const sha256File = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const readJsonFile = async file => JSON.parse(await readFile(file, "utf8"));
async function writeAtomic(file, value) {
  // Unique temp name: the heartbeat and a stage transition may write concurrently.
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, ...options });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out) : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
  });
}

/** One stage process in its own group; stdout+stderr to <stage>.log; killed as a group on timeout. */
function runProcess({ command, args, log, timeoutMs, env }) {
  return new Promise(resolve => {
    const stream = createWriteStream(log, { flags: "a" });
    const child = spawn(command, args, { cwd: repoRoot, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", timedOut = false;
    child.stdout.on("data", chunk => { stdout += chunk; stream.write(chunk); });
    child.stderr.on("data", chunk => stream.write(chunk));
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGTERM"); } catch {} }, timeoutMs);
    child.on("close", code => { clearTimeout(timer); stream.end(); resolve({ exitCode: code, timedOut, stdout }); });
  });
}

export async function runS1Validation({ runDir }) {
  const env = process.env;
  for (const name of ["ILV2_NODE_BIN", "ILV2_RUNTIME_MANIFEST", "ILV2_MAC10_DATASET", "ILV2_MAC10_INPUTS", "DS", "F_RUN", "Q02_IDS"]) requireValue(env[name], `${name} is required`);
  requireValue(path.isAbsolute(runDir) && existsSync(runDir), "--run-dir must be an existing absolute directory");
  requireValue((await readdir(runDir)).every(name => name === "runner.log"), "--run-dir must be empty (runner.log allowed)");
  const node = env.ILV2_NODE_BIN;
  const head = (await capture("git", ["rev-parse", "HEAD"])).trim();
  const statusFile = path.join(runDir, "status.json");
  const eventsFile = path.join(runDir, "events.jsonl");
  const stages = [];
  let current = null;
  const status = extra => writeAtomic(statusFile, { schema: RUN_SCHEMA, runDir, gitSha: head, pid: process.pid, heartbeat: new Date().toISOString(),
    stage: current?.name ?? null, stageStartedAt: current?.startedAt ?? null, stageTimeoutMs: current?.timeoutMs ?? null, completed: stages.map(stage => stage.name), ...extra });
  const event = record => appendFile(eventsFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  const heartbeat = setInterval(() => { status({ state: "RUNNING" }).catch(() => {}); }, 30_000);
  const artifacts = {};
  const facts = {};

  const finish = async (failure) => {
    clearInterval(heartbeat);
    const result = { schema: RUN_SCHEMA, status: failure ? failure.status : terminalStatus(stages), gitSha: head, runDir,
      failedStage: failure?.stage ?? stages.find(stage => stage.status !== "PASS")?.name ?? null, firstError: failure?.error ?? null,
      stages, notRun: STAGES_DEF.map(stage => stage.name).filter(name => !stages.some(stage => stage.name === name)), facts, artifacts };
    current = null;
    await status({ state: result.status });
    await writeAtomic(path.join(runDir, "result.json"), result);
    return result;
  };

  // A stage: run, then check. `stop: true` ends the run on failure; later stages become NOT_RUN.
  const stage = async ({ name, timeoutMin, stop, command, args, check }) => {
    current = { name, startedAt: new Date().toISOString(), timeoutMs: timeoutMin * MINUTE };
    await status({ state: "RUNNING" });
    await event({ stage: name, event: "start" });
    const log = path.join(runDir, `${name}.log`);
    const run = command ? await runProcess({ command, args, log, timeoutMs: current.timeoutMs, env }) : { exitCode: 0, timedOut: false, stdout: "" };
    let verdict;
    try { verdict = run.timedOut ? { pass: false, problems: ["timeout"] } : await check(run); }
    catch (error) { verdict = { pass: false, problems: [error.message] }; }
    const record = { name, status: run.timedOut ? "TIMEOUT" : verdict.pass ? "PASS" : "FAIL", exitCode: run.exitCode, startedAt: current.startedAt,
      endedAt: new Date().toISOString(), log, problems: verdict.problems ?? [], ...(verdict.detail ? { detail: verdict.detail } : {}) };
    stages.push(record);
    await event({ stage: name, event: "end", status: record.status, exitCode: run.exitCode, problems: record.problems });
    return record.status === "PASS" || !stop;
  };

  const isolated = (name, profile, extra = []) => ({ command: "sh", args: ["scripts/run-isolated-node.sh", "scripts/run-isolated-validation.mjs", "--profile", profile, "--keep", "--name", name, ...extra] });
  const replayArgs = (server, out) => ["scripts/ilv2-impact-budget-diagnosis.mjs", "--dataset", env.ILV2_MAC10_DATASET, "--tasks", `${env.DS}/tasks-dev.jsonl`,
    "--gold", `${env.DS}/private/gold-dev.jsonl`, "--inputs", env.ILV2_MAC10_INPUTS, "--server-js", server, "--out", out,
    "--calibration-task-ids", env.Q02_IDS, "--expect-mean-recall", W2_CALIBRATION.meanRecall, "--expect-full-recall", W2_CALIBRATION.fullRecall];
  const gateArgs = (rows, out) => ["scripts/ilv2-s1-gate.mjs", "--baseline-rows", `${env.F_RUN}/rows.jsonl`, "--expect-baseline-rows-sha256", F_HASHES.rows, "--rows", rows, "--out", out];
  const builtServer = async (run, key) => {
    const root = parseValidationRoot(run.stdout);
    const server = path.join(root, "candidate/dist/server.js");
    requireValue(existsSync(server), `no built server at ${server}`);
    artifacts[key] = { validationRoot: root, server, buildStampSha256: await sha256File(path.join(root, "candidate/dist/build-stamp.json")) };
    return server;
  };

  const STAGES_DEF = [
    { name: "preflight", timeoutMin: 2, stop: true, check: async () => {
      const problems = [];
      if ((await capture("git", ["status", "--porcelain"])).trim()) problems.push("working tree is not clean");
      try { await capture("git", ["merge-base", "--is-ancestor", S1_COMMIT, "HEAD"]); } catch { problems.push(`HEAD does not contain S1 ${S1_COMMIT}`); }
      try { await capture("git", ["merge-base", "--is-ancestor", BASELINE_SRC_COMMIT, "HEAD"]); } catch { problems.push(`HEAD does not contain ${BASELINE_SRC_COMMIT}`); }
      for (const [key, expected] of Object.entries(F_HASHES)) {
        const actual = await sha256File(path.join(env.F_RUN, `${key}.jsonl`));
        if (actual !== expected) problems.push(`F_RUN ${key}.jsonl sha256 ${actual}`);
      }
      return { pass: problems.length === 0, problems };
    } },
    { name: "baseline-build", timeoutMin: 40, stop: true, prepare: async () => {
      // Working tree src := baseline src; restored in `restore` whatever happens.
      const patch = await capture("git", ["diff", "HEAD", BASELINE_SRC_COMMIT, "--", "src"]);
      await writeFile(path.join(runDir, "baseline-src.patch"), patch);
      await capture("git", ["apply", path.join(runDir, "baseline-src.patch")]);
      await capture("git", ["diff", "--quiet", BASELINE_SRC_COMMIT, "--", "src"]);
    }, restore: () => capture("git", ["checkout", "HEAD", "--", "src"]),
      ...isolated("s1-baseline-compile", "compile"), check: async run => {
      if (run.exitCode !== 0) return { pass: false, problems: [`exit ${run.exitCode}`] };
      facts.baselineServer = await builtServer(run, "baselineBuild");
      return { pass: true };
    } },
    { name: "s1-build-targeted", timeoutMin: 60, stop: false, ...isolated("s1-targeted", "targeted", ["--", "node", "--test", "--test-concurrency=1", ...TARGETED_TESTS]),
      check: async run => {
        // The kept build serves the later stages even when a test fails; a missing server stops them below.
        try { facts.s1Server = await builtServer(run, "s1Build"); } catch (error) { return { pass: false, problems: [error.message] }; }
        return { pass: run.exitCode === 0, problems: run.exitCode === 0 ? [] : [`targeted tests exit ${run.exitCode}`] };
      } },
    { name: "script-tests", timeoutMin: 10, stop: false, command: node, args: ["--test", "--test-concurrency=1", ...SCRIPT_TESTS],
      check: async run => ({ pass: run.exitCode === 0, problems: run.exitCode === 0 ? [] : [`exit ${run.exitCode}`] }) },
    { name: "mechanism", timeoutMin: 45, stop: true, needs: "s1Server", command: node, args: () => ["scripts/ilv2-relation-defect-shape.mjs", "--dataset", env.ILV2_MAC10_DATASET,
      "--tasks", `${env.DS}/tasks-dev.jsonl`, "--gold", `${env.DS}/private/gold-dev.jsonl`, "--inputs", env.ILV2_MAC10_INPUTS, "--server-js", facts.s1Server,
      "--responses", `${env.F_RUN}/responses.jsonl`, "--rows", `${env.F_RUN}/rows.jsonl`,
      "--expect-responses-sha256", F_HASHES.responses, "--expect-rows-sha256", F_HASHES.rows, "--out", path.join(runDir, "s1-d18")],
      check: async run => {
        if (run.exitCode !== 0) return { pass: false, problems: [`exit ${run.exitCode}`] };
        const recorded = (await readJsonFile(path.join(repoRoot, "docs/post-ilv2/results/D18-SHAPE.json"))).summary.shapes;
        const rerun = await readJsonFile(path.join(runDir, "s1-d18/summary.json"));
        artifacts.mechanismSummary = { path: path.join(runDir, "s1-d18/summary.json"), sha256: await sha256File(path.join(runDir, "s1-d18/summary.json")) };
        const verdict = checkMechanism(recorded, rerun.shapes);
        facts.mechanism = verdict;
        return verdict;
      } },
    { name: "main-replay", timeoutMin: 240, stop: true, needs: "baselineServer", command: node, args: () => replayArgs(facts.baselineServer, path.join(runDir, "main-replay")),
      check: async run => {
        const summary = await readJsonFile(path.join(runDir, "main-replay/summary.json"));
        facts.mainCalibration = summary.calibration;
        return { pass: run.exitCode === 0 && summary.calibration.status === "PASS", problems: run.exitCode === 0 ? [] : [`exit ${run.exitCode}, calibration ${summary.calibration.status}`] };
      } },
    { name: "main-gate", timeoutMin: 5, stop: true, command: node, args: () => gateArgs(path.join(runDir, "main-replay/rows.jsonl"), path.join(runDir, "main-gate")),
      check: async run => {
        if (run.exitCode !== 0) return { pass: false, problems: [`exit ${run.exitCode}`] };
        const summary = await readJsonFile(path.join(runDir, "main-gate/summary.json"));
        facts.mainGate = summary;
        return checkBaselineGate(summary);
      } },
    { name: "s1-replay", timeoutMin: 240, stop: true, needs: "s1Server", command: node, args: () => replayArgs(facts.s1Server, path.join(runDir, "s1-replay")),
      check: async run => {
        // Calibration may fail on S1 by design (non-zero exit); scoring must still have happened (no projection mismatch).
        const summaryFile = path.join(runDir, "s1-replay/summary.json");
        if (!existsSync(summaryFile) || !existsSync(path.join(runDir, "s1-replay/rows.jsonl"))) return { pass: false, problems: [`exit ${run.exitCode}, not scored (see log)`] };
        facts.s1Calibration = { ...(await readJsonFile(summaryFile)).calibration, exitCode: run.exitCode };
        return { pass: true };
      } },
    { name: "s1-gate", timeoutMin: 5, stop: true, command: node, args: () => gateArgs(path.join(runDir, "s1-replay/rows.jsonl"), path.join(runDir, "s1-gate")),
      check: async run => {
        if (run.exitCode !== 0) return { pass: false, problems: [`exit ${run.exitCode}`] };
        const summary = await readJsonFile(path.join(runDir, "s1-gate/summary.json"));
        facts.s1Gate = summary;
        return { pass: summary.status === "PASS", problems: summary.status === "PASS" ? [] : Object.entries(summary.gates).filter(([, ok]) => !ok).map(([gate]) => `gate ${gate} failed`) };
      } }
  ];

  await status({ state: "RUNNING" });
  await event({ event: "run-start", gitSha: head, pid: process.pid });
  for (const definition of STAGES_DEF) {
    if (definition.needs && !facts[definition.needs]) return finish({ status: "FAIL", stage: definition.name, error: `${definition.needs} unavailable from an earlier stage` });
    let keepGoing;
    try {
      await definition.prepare?.();
      keepGoing = await stage({ ...definition, args: typeof definition.args === "function" ? definition.args() : definition.args });
    } catch (error) {
      stages.push({ name: definition.name, status: "FAIL", problems: [error.message] });
      keepGoing = false;
    } finally {
      if (definition.restore) await definition.restore();
    }
    if (!keepGoing) return finish(null);
  }
  return finish(null);
}

/** The counts-only file to commit as docs/post-ilv2/results/S1-GATE.json. */
export async function reportFor(runDir) {
  const result = await readJsonFile(path.join(runDir, "result.json"));
  return { taskId: "S1-GATE", status: result.status, sourceHead: result.gitSha, failedStage: result.failedStage, notRun: result.notRun,
    stages: result.stages.map(({ name, status, exitCode, startedAt, endedAt, problems }) => ({ name, status, exitCode, startedAt, endedAt, problems })),
    builds: Object.fromEntries(Object.entries(result.artifacts).filter(([key]) => key.endsWith("Build")).map(([key, value]) => [key, { buildStampSha256: value.buildStampSha256 }])),
    mechanism: result.facts.mechanism ?? null, mainCalibration: result.facts.mainCalibration ?? null, mainGate: result.facts.mainGate ?? null,
    s1Calibration: result.facts.s1Calibration ?? null, s1Gate: result.facts.s1Gate ?? null };
}

async function main(args) {
  const options = cliOptions(args, ["--run-dir", "--report"]);
  if (options.report) {
    console.log(JSON.stringify(await reportFor(path.resolve(options.report)), null, 2));
    return;
  }
  requireValue(options["run-dir"], "--run-dir is required");
  const result = await runS1Validation({ runDir: path.resolve(options["run-dir"]) });
  console.log(JSON.stringify({ status: result.status, failedStage: result.failedStage }));
}

if (isMain(import.meta.url)) runCli(() => main(process.argv.slice(2)));

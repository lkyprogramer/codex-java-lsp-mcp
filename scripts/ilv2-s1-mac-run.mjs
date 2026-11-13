#!/usr/bin/env node
// S1 Mac validation, one branch, one background run (docs/post-ilv2/s1-implementation-listing.md §4). Follows the
// long-running validation rules (docs/deep/ilv2-mac-manual/long-running-validation.md): every stage has its own log,
// exit code, timeout and check; status.json carries a heartbeat; result.json is the terminal hand-off, written on
// failure, exception and SIGTERM/SIGINT as well.
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
  "dist/agent-router/rank-candidates.test.js", "dist/agent-router/type-reference.test.js", "dist/agent-router/request-budget.test.js",
  "dist/agent-router/anchor.test.js", "dist/java-index/router-integration.test.js", "dist/java-index/router-java-index.test.js"
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

/** §3.2 step 0: does main reproduce F exactly (so F can be S1's baseline)? */
export function checkBaselineGate(summary) {
  const problems = [];
  if (summary.lostTargets.count !== 0) problems.push(`lost ${summary.lostTargets.count}`);
  if (summary.gainedTargets.count !== 0) problems.push(`gained ${summary.gainedTargets.count}`);
  if (summary.receivedBytesP50Increase !== 0) problems.push(`received bytes p50 ${summary.receivedBytesP50Increase}`);
  return { pass: problems.length === 0, problems };
}

/** Terminal status: any timeout, else any non-pass stage, else pass. */
export function terminalStatus(stages) {
  if (stages.some(stage => stage.status === "TIMEOUT")) return "TIMEOUT";
  if (stages.some(stage => stage.status !== "PASS")) return "FAIL";
  return "PASS";
}

/** Absolute paths out of anything that leaves the Mac. */
export const redactPaths = text => String(text).replace(/(?:~|\/)[^\s:'",)]*\/[^\s:'",)]*/g, "<path>");
const sha256File = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const readJsonFile = async file => JSON.parse(await readFile(file, "utf8"));
async function writeAtomic(file, value) {
  // Unique temp name: the heartbeat and a stage transition may write concurrently.
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, file);
}

export function capture(command, args, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });
    let out = "", err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(out) : reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${err.trim().slice(0, 300)}`)));
  });
}

/**
 * One stage process in its own group; stdout+stderr appended to `log`. On timeout the group gets SIGTERM, then SIGKILL
 * after `killGraceMs`. Resolves on `exit`, not `close`: a descendant holding the pipes must not keep the stage open.
 */
export function runProcess({ command, args, log, timeoutMs, env, cwd = repoRoot, killGraceMs = 10_000 }) {
  return new Promise(resolve => {
    const stream = createWriteStream(log, { flags: "a" });
    let child;
    try { child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { stream.end(); resolve({ exitCode: null, timedOut: false, stdout: "", error: error.message }); return; }
    let stdout = "", timedOut = false, settled = false, killTimer;
    const kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
    const settle = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      // Let already-buffered output land, then detach from the pipes.
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); stream.end(); resolve({ ...result, timedOut, stdout }); }, 200);
    };
    child.stdout.on("data", chunk => { stdout += chunk; stream.write(chunk); });
    child.stderr.on("data", chunk => stream.write(chunk));
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); killTimer = setTimeout(() => kill("SIGKILL"), killGraceMs); }, timeoutMs);
    child.on("error", error => settle({ exitCode: null, error: error.message }));
    child.on("exit", code => settle({ exitCode: code }));
  });
}

/**
 * The generic engine. A stage: { name, timeoutMs, stop, needs?(ctx), prepare?(ctx), restore?(ctx), command?, args?(ctx),
 * check(run, ctx) → { pass, problems?, detail? } }. `stop` ends the run when the stage does not pass; later stages
 * become notRun. Any exception, and SIGTERM/SIGINT, still restores the active stage and writes result.json.
 */
export async function runStages({ runDir, gitSha, stages, env = process.env, cwd = repoRoot, heartbeatMs = 30_000, killGraceMs = 10_000, extraResult = () => ({}) }) {
  const statusFile = path.join(runDir, "status.json");
  const ctx = { runDir, env, facts: {}, artifacts: {} };
  const records = [];
  let current = null, restoreActive = null, finished = false;
  const status = extra => writeAtomic(statusFile, { schema: RUN_SCHEMA, runDir, gitSha, pid: process.pid, heartbeat: new Date().toISOString(),
    stage: current?.name ?? null, stageStartedAt: current?.startedAt ?? null, stageTimeoutMs: current?.timeoutMs ?? null,
    completed: records.map(record => record.name), ...extra });
  const event = record => appendFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  const heartbeat = setInterval(() => { if (!finished) status({ state: "RUNNING" }).catch(() => {}); }, heartbeatMs);

  const finish = async (override) => {
    if (finished) return null;
    finished = true;
    clearInterval(heartbeat);
    const result = { schema: RUN_SCHEMA, status: override?.status ?? terminalStatus(records), gitSha, runDir,
      failedStage: override?.stage ?? records.find(record => record.status !== "PASS")?.name ?? null, firstError: override?.error ?? null,
      stages: records, notRun: stages.map(stage => stage.name).filter(name => !records.some(record => record.name === name)),
      facts: ctx.facts, artifacts: ctx.artifacts, ...extraResult(ctx, records) };
    current = null;
    await status({ state: result.status });
    await writeAtomic(path.join(runDir, "result.json"), result);
    await event({ event: "run-end", status: result.status });
    return result;
  };

  const onSignal = signal => {
    (async () => {
      try { await restoreActive?.(); } catch {}
      if (current) records.push({ name: current.name, status: "FAIL", problems: [`interrupted by ${signal}`] });
      await finish({ status: "INTERRUPTED", stage: current?.name ?? null, error: `received ${signal}` });
    })().finally(() => process.exit(130));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  try {
    await status({ state: "RUNNING" });
    await event({ event: "run-start", gitSha, pid: process.pid });
    for (const definition of stages) {
      const missing = definition.needs?.(ctx);
      if (missing) {
        records.push({ name: definition.name, status: "FAIL", problems: [`not runnable: ${missing}`] });
        if (definition.stop) break;
        continue;
      }
      current = { name: definition.name, startedAt: new Date().toISOString(), timeoutMs: definition.timeoutMs };
      await status({ state: "RUNNING" });
      await event({ stage: definition.name, event: "start" });
      let record;
      restoreActive = definition.restore ? () => definition.restore(ctx) : null;
      try {
        await definition.prepare?.(ctx);
        const run = definition.command
          ? await runProcess({ command: definition.command, args: definition.args?.(ctx) ?? [], log: path.join(runDir, `${definition.name}.log`),
            timeoutMs: definition.timeoutMs, env, cwd, killGraceMs })
          : { exitCode: 0, timedOut: false, stdout: "" };
        let verdict;
        if (run.timedOut) verdict = { pass: false, problems: ["timeout"] };
        else if (run.error) verdict = { pass: false, problems: [`spawn: ${run.error}`] };
        else { try { verdict = await definition.check(run, ctx); } catch (error) { verdict = { pass: false, problems: [error.message] }; } }
        record = { name: definition.name, status: run.timedOut ? "TIMEOUT" : verdict.pass ? "PASS" : "FAIL", exitCode: run.exitCode,
          problems: verdict.problems ?? [], ...(verdict.detail ? { detail: verdict.detail } : {}) };
      } catch (error) {
        record = { name: definition.name, status: "FAIL", exitCode: null, problems: [error.message] };
      } finally {
        if (restoreActive) {
          try { await restoreActive(); }
          catch (error) { record = { ...(record ?? { name: definition.name }), status: "FAIL", problems: [...(record?.problems ?? []), `restore: ${error.message}`] }; ctx.restoreFailed = true; }
          restoreActive = null;
        }
      }
      records.push({ ...record, startedAt: current.startedAt, endedAt: new Date().toISOString(), log: path.join(runDir, `${definition.name}.log`) });
      await event({ stage: definition.name, event: "end", status: record.status, exitCode: record.exitCode, problems: record.problems });
      current = null;
      if (ctx.restoreFailed) return finish({ status: "FAIL", stage: definition.name, error: "working tree restore failed; run `git checkout HEAD -- src`" });
      if (record.status !== "PASS" && definition.stop) break;
    }
    return await finish(null);
  } catch (error) {
    return await finish({ status: "FAIL", stage: current?.name ?? null, error: error.message });
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
}

/** The S1 stage table (§4). Main's mismatch with F does not stop the run: S1 is still measured, the verdict waits. */
export function s1Stages({ env, runDir }) {
  const node = env.ILV2_NODE_BIN;
  const slug = path.basename(runDir).replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[^a-zA-Z0-9]+/, "").slice(0, 80) || "s1";
  const isolated = (suffix, profile, extra = []) => ({ command: "sh",
    args: () => ["scripts/run-isolated-node.sh", "scripts/run-isolated-validation.mjs", "--profile", profile, "--keep", "--name", `${slug}-${suffix}`, ...extra] });
  const replay = (server, out) => ["scripts/ilv2-impact-budget-diagnosis.mjs", "--dataset", env.ILV2_MAC10_DATASET, "--tasks", `${env.DS}/tasks-dev.jsonl`,
    "--gold", `${env.DS}/private/gold-dev.jsonl`, "--inputs", env.ILV2_MAC10_INPUTS, "--server-js", server, "--out", out,
    "--calibration-task-ids", env.Q02_IDS, "--expect-mean-recall", W2_CALIBRATION.meanRecall, "--expect-full-recall", W2_CALIBRATION.fullRecall];
  const gate = (baselineRows, baselineSha, rows, out) => ["scripts/ilv2-s1-gate.mjs", "--baseline-rows", baselineRows,
    "--expect-baseline-rows-sha256", baselineSha, "--rows", rows, "--out", out];
  const at = (...parts) => path.join(runDir, ...parts);
  const built = async (run, ctx, key) => {
    const root = parseValidationRoot(run.stdout);
    const server = path.join(root, "candidate/dist/server.js");
    requireValue(existsSync(server), "no built server in the kept validation root");
    ctx.artifacts[key] = { validationRoot: root, buildStampSha256: await sha256File(path.join(root, "candidate/dist/build-stamp.json")) };
    return server;
  };
  const scored = dir => existsSync(at(dir, "summary.json")) && existsSync(at(dir, "rows.jsonl"));
  const exitOk = run => ({ pass: run.exitCode === 0, problems: run.exitCode === 0 ? [] : [`exit ${run.exitCode}`] });

  return [
    { name: "preflight", timeoutMs: 2 * MINUTE, stop: true, check: async () => {
      const problems = [];
      if ((await capture("git", ["status", "--porcelain"])).trim()) problems.push("working tree is not clean");
      for (const commit of [S1_COMMIT, BASELINE_SRC_COMMIT]) {
        try { await capture("git", ["merge-base", "--is-ancestor", commit, "HEAD"]); } catch { problems.push(`HEAD does not contain ${commit}`); }
      }
      for (const name of ["ILV2_NODE_BIN", "ILV2_RUNTIME_MANIFEST", "ILV2_MAC10_DATASET", "ILV2_MAC10_INPUTS", "DS", "F_RUN", "Q02_IDS"]) {
        if (!env[name]) problems.push(`${name} is not exported`);
      }
      for (const [key, expected] of Object.entries(F_HASHES)) {
        const file = path.join(env.F_RUN ?? "", `${key}.jsonl`);
        if (!env.F_RUN || !existsSync(file)) { problems.push(`F_RUN ${key}.jsonl missing`); continue; }
        if (await sha256File(file) !== expected) problems.push(`F_RUN ${key}.jsonl sha256 differs`);
      }
      return { pass: problems.length === 0, problems };
    } },
    { name: "baseline-build", timeoutMs: 40 * MINUTE, stop: true,
      prepare: async ctx => {
        // Working tree src := baseline src for this build only.
        const patch = at("baseline-src.patch");
        await writeFile(patch, await capture("git", ["diff", "HEAD", BASELINE_SRC_COMMIT, "--", "src"]));
        ctx.artifacts.baselineSrcPatchSha256 = await sha256File(patch);
        await capture("git", ["apply", patch]);
        await capture("git", ["diff", "--quiet", BASELINE_SRC_COMMIT, "--", "src"]);
      },
      restore: async () => {
        await capture("git", ["checkout", "HEAD", "--", "src"]);
        requireValue(!(await capture("git", ["status", "--porcelain", "--", "src"])).trim(), "src is not clean after restore");
      },
      ...isolated("baseline", "compile"),
      check: async (run, ctx) => {
        if (run.exitCode !== 0) return { pass: false, problems: [`exit ${run.exitCode}`] };
        ctx.facts.baselineServer = await built(run, ctx, "baselineBuild");
        return { pass: true };
      } },
    { name: "s1-build-targeted", timeoutMs: 60 * MINUTE, stop: false, ...isolated("s1", "targeted", ["--", "node", "--test", "--test-concurrency=1", ...TARGETED_TESTS]),
      check: async (run, ctx) => {
        // The kept build serves later stages even when a test fails; without a server they report not runnable.
        try { ctx.facts.s1Server = await built(run, ctx, "s1Build"); } catch (error) { return { pass: false, problems: [error.message] }; }
        return exitOk(run);
      } },
    { name: "script-tests", timeoutMs: 10 * MINUTE, stop: false, command: node, args: () => ["--test", "--test-concurrency=1", ...SCRIPT_TESTS], check: async run => exitOk(run) },
    { name: "mechanism", timeoutMs: 45 * MINUTE, stop: true, needs: ctx => ctx.facts.s1Server ? null : "no S1 build",
      command: node, args: ctx => ["scripts/ilv2-relation-defect-shape.mjs", "--dataset", env.ILV2_MAC10_DATASET,
        "--tasks", `${env.DS}/tasks-dev.jsonl`, "--gold", `${env.DS}/private/gold-dev.jsonl`, "--inputs", env.ILV2_MAC10_INPUTS, "--server-js", ctx.facts.s1Server,
        "--responses", `${env.F_RUN}/responses.jsonl`, "--rows", `${env.F_RUN}/rows.jsonl`,
        "--expect-responses-sha256", F_HASHES.responses, "--expect-rows-sha256", F_HASHES.rows, "--out", at("s1-d18")],
      check: async (run, ctx) => {
        if (run.exitCode !== 0) return { pass: false, problems: [`exit ${run.exitCode}`] };
        const recorded = (await readJsonFile(path.join(repoRoot, "docs/post-ilv2/results/D18-SHAPE.json"))).summary.shapes;
        ctx.facts.mechanism = checkMechanism(recorded, (await readJsonFile(at("s1-d18/summary.json"))).shapes);
        return ctx.facts.mechanism;
      } },
    { name: "main-replay", timeoutMs: 240 * MINUTE, stop: false, needs: ctx => ctx.facts.baselineServer ? null : "no baseline build",
      command: node, args: ctx => replay(ctx.facts.baselineServer, at("main-replay")),
      check: async (run, ctx) => {
        if (!scored("main-replay")) return { pass: false, problems: [`exit ${run.exitCode}, not scored`] };
        ctx.facts.mainRowsSha256 = await sha256File(at("main-replay/rows.jsonl"));
        ctx.facts.mainCalibration = { ...(await readJsonFile(at("main-replay/summary.json"))).calibration, exitCode: run.exitCode };
        return { pass: ctx.facts.mainCalibration.status === "PASS", problems: ctx.facts.mainCalibration.status === "PASS" ? [] : ["calibration FAIL on main"] };
      } },
    { name: "main-gate", timeoutMs: 5 * MINUTE, stop: false, needs: ctx => ctx.facts.mainRowsSha256 ? null : "main replay not scored",
      command: node, args: () => gate(`${env.F_RUN}/rows.jsonl`, F_HASHES.rows, at("main-replay/rows.jsonl"), at("main-gate")),
      check: async (run, ctx) => {
        if (run.exitCode !== 0) return { pass: false, problems: [`exit ${run.exitCode}`] };
        ctx.facts.mainGate = await readJsonFile(at("main-gate/summary.json"));
        return checkBaselineGate(ctx.facts.mainGate);
      } },
    { name: "s1-replay", timeoutMs: 240 * MINUTE, stop: true, needs: ctx => ctx.facts.s1Server ? null : "no S1 build",
      command: node, args: ctx => replay(ctx.facts.s1Server, at("s1-replay")),
      check: async (run, ctx) => {
        // Calibration may fail on S1 by design (non-zero exit); scoring must still have happened (no projection mismatch).
        if (!scored("s1-replay")) return { pass: false, problems: [`exit ${run.exitCode}, not scored`] };
        ctx.facts.s1Calibration = { ...(await readJsonFile(at("s1-replay/summary.json"))).calibration, exitCode: run.exitCode };
        return { pass: true };
      } },
    { name: "s1-gate", timeoutMs: 5 * MINUTE, stop: false, command: node, args: () => gate(`${env.F_RUN}/rows.jsonl`, F_HASHES.rows, at("s1-replay/rows.jsonl"), at("s1-gate")),
      check: async (run, ctx) => {
        if (run.exitCode !== 0) return { pass: false, problems: [`exit ${run.exitCode}`] };
        ctx.facts.s1Gate = await readJsonFile(at("s1-gate/summary.json"));
        return { pass: ctx.facts.s1Gate.status === "PASS", problems: Object.entries(ctx.facts.s1Gate.gates).filter(([, ok]) => !ok).map(([name]) => `gate ${name} failed`) };
      } },
    // Report only: S1 against main itself, for the case where main does not reproduce F.
    { name: "s1-vs-main", timeoutMs: 5 * MINUTE, stop: false, needs: ctx => ctx.facts.mainRowsSha256 ? null : "main replay not scored",
      command: node, args: ctx => gate(at("main-replay/rows.jsonl"), ctx.facts.mainRowsSha256, at("s1-replay/rows.jsonl"), at("s1-vs-main")),
      check: async (run, ctx) => {
        if (run.exitCode !== 0) return { pass: false, problems: [`exit ${run.exitCode}`] };
        ctx.facts.s1VsMain = await readJsonFile(at("s1-vs-main/summary.json"));
        return { pass: true };
      } }
  ];
}

export async function runS1Validation({ runDir, env = process.env }) {
  requireValue(path.isAbsolute(runDir) && existsSync(runDir), "--run-dir must be an existing absolute directory");
  requireValue((await readdir(runDir)).every(name => name === "runner.log"), "--run-dir must be empty (runner.log allowed)");
  const gitSha = (await capture("git", ["rev-parse", "HEAD"])).trim();
  return runStages({ runDir, gitSha, env, stages: s1Stages({ env, runDir }),
    extraResult: (ctx, records) => ({ baselineMatchesF: records.find(record => record.name === "main-gate")?.status === "PASS" }) });
}

/** The counts-only file to commit as docs/post-ilv2/results/S1-GATE.json: no paths, no task ids. */
export async function reportFor(runDir) {
  const result = await readJsonFile(path.join(runDir, "result.json"));
  return { taskId: "S1-GATE", status: result.status, sourceHead: result.gitSha, failedStage: result.failedStage, notRun: result.notRun,
    firstError: result.firstError && redactPaths(result.firstError), baselineMatchesF: result.baselineMatchesF ?? null,
    stages: result.stages.map(({ name, status, exitCode, startedAt, endedAt, problems }) => ({ name, status, exitCode: exitCode ?? null, startedAt, endedAt,
      problems: (problems ?? []).map(redactPaths) })),
    builds: { baselineSrcPatchSha256: result.artifacts.baselineSrcPatchSha256 ?? null,
      baseline: result.artifacts.baselineBuild?.buildStampSha256 ?? null, s1: result.artifacts.s1Build?.buildStampSha256 ?? null },
    // Gate summaries hold counts and hashes only (task identities stay in target-changes.json on the Mac).
    mechanism: result.facts.mechanism ?? null, mainCalibration: result.facts.mainCalibration ?? null, mainGate: result.facts.mainGate ?? null,
    s1Calibration: result.facts.s1Calibration ?? null, s1Gate: result.facts.s1Gate ?? null, s1VsMain: result.facts.s1VsMain ?? null };
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

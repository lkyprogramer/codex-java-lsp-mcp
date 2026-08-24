#!/usr/bin/env node
// input: three real Java repositories (already-cloned worktrees the caller owns) and one
//   real-symbol anchor per repo (file/line/column of an identifier with real references).
// output: cold ("fresh", no prewarm) vs prewarm-proxy ("reused", session already READY)
//   first-touch P95 delta and peak JDT java-process RSS/%CPU delta, per repo.
// pos: V3.2-23 trial-gate measurement (development-plan Sprint4). Deliberately reuses the
//   existing src/benchmark/semantic-first-touch.ts CLI (Task 35) unmodified through the
//   standard two-layer isolation chain - no production src/ changes, so this script does not
//   touch the LOC ledger. If the gate below passes, a follow-up task designs the actual opt-in
//   production trigger (repo-runtime-manager.ts idle timer + cross-process-lease.ts machine
//   lease); this script only answers whether that investment is worth making.
import { spawn, execFile } from "node:child_process";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JDT_MATCH = "org.eclipse.jdt.ls.core.id1";
const SAMPLE_INTERVAL_MS = 300;
const P95_IMPROVEMENT_GATE = 0.30;
const RESOURCE_INCREASE_GATE = 0.10;

// One real, referenced identifier per golden repo. cipherlink's anchor is the exact one
// already documented in docs/phase-v3/phase5-semantic-first-touch-decision.md (Task 35);
// lishuedu/exam-parent-v3 anchors are freshly picked (a ServiceImpl class name with >=1
// real usage beyond its own declaration, verified with a plain grep before use).
const ANCHORS = {
  cipherlink: {
    file: "modules/organization/src/main/java/com/hhtele/cipherlink/organization/application/DefaultOrganizationAppService.java",
    line: 693,
    column: 23
  },
  lishuedu: {
    file: "modules/iam/src/main/java/com/lishu/edu/iam/application/service/InternalUserAppServiceImpl.java",
    line: 37,
    column: 14
  },
  "exam-parent-v3": {
    file: "exam-service/exam-service-candidate/src/main/java/com/hhtele/exam/service/candidate/impl/OrgServiceImpl.java",
    line: 26,
    column: 14
  }
};

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  await mkdir(cli.outputDir, { recursive: true });
  const results = {};
  for (const project of Object.keys(ANCHORS)) {
    const repoRoot = cli.repositories[project];
    if (!repoRoot) throw new Error(`missing --${project} <repo root>`);
    await assertNoStrayJdt();
    console.log(`idle-prewarm-experiment: ${project} fresh (baseline, no prewarm)`);
    const fresh = await runCondition({
      project, repoRoot, workspaceState: "fresh", runs: cli.runs, anchor: ANCHORS[project], outputDir: cli.outputDir
    });
    await assertNoStrayJdt();
    console.log(`idle-prewarm-experiment: ${project} reused (prewarm proxy: session already READY)`);
    const reused = await runCondition({
      project, repoRoot, workspaceState: "reused", runs: cli.runs, anchor: ANCHORS[project], outputDir: cli.outputDir
    });
    results[project] = evaluate(fresh, reused);
    console.log(`idle-prewarm-experiment: ${project} -> ${JSON.stringify(results[project])}`);
  }
  const overall = Object.values(results).every(cell => cell.pass);
  const summary = {
    schemaVersion: "v32-idle-prewarm-experiment/v1",
    purpose: "V3.2-23 trial gate: does a JDT session that already finished importing before the "
      + "request arrives (prewarm proxy) beat a from-scratch cold start (baseline) by >=30% P95 "
      + "totalMs, without >10% more peak RSS/%CPU on the JDT java process. Measurement-only - no "
      + "production code changed by this script.",
    gate: { p95ImprovementMin: P95_IMPROVEMENT_GATE, resourceIncreaseMax: RESOURCE_INCREASE_GATE },
    method: "baseline = P95(totalMs) across `--workspace-state fresh` attempts (each a brand-new "
      + "JdtlsSession + fresh project import). warmProxy = P95(totalMs) across `--workspace-state "
      + "reused` attempts 2..N within one CLI invocation (attempt 1 still pays a cold "
      + "session+import cost and is excluded from the warm sample; attempts 2..N run against the "
      + "same already-imported, already-READY session, standing in for 'prewarm already finished "
      + "before the request arrived'). Peak RSS/%CPU sampled externally via `ps` against the JDT "
      + "java process (matched on the equinox application id, which keeps the launcher's pid "
      + "stable since jdtls execvp()s into java) every 300ms for each condition's full wall-clock "
      + "lifetime.",
    results,
    overall: overall ? "PASS" : "FAIL"
  };
  await writeFile(path.join(cli.outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  if (!overall) process.exitCode = 1;
}

async function runCondition({ project, repoRoot, workspaceState, runs, anchor, outputDir }) {
  const label = `${project}-${workspaceState}`;
  const stdoutFile = path.join(outputDir, `${label}.stdout.log`);
  const stderrFile = path.join(outputDir, `${label}.stderr.log`);
  await writeFile(stdoutFile, "");
  await writeFile(stderrFile, "");
  const jdtlsBin = process.env.JDTLS_BIN ?? "/opt/homebrew/bin/jdtls";
  const args = [
    path.join(scriptRoot, "scripts", "run-isolated-validation.mjs"),
    "--profile", "compile",
    "--env", `JDTLS_BIN=${jdtlsBin}`,
    "--env", `JAVA_LSP_BENCH_ANCHOR_FILE=${anchor.file}`,
    "--env", `JAVA_LSP_BENCH_ANCHOR_LINE=${String(anchor.line)}`,
    "--env", `JAVA_LSP_BENCH_ANCHOR_COLUMN=${String(anchor.column)}`,
    "--",
    "node", "scripts/run-isolated-jdt-benchmark.mjs",
    "--repo-root", repoRoot,
    "--",
    "node", "dist/benchmark/semantic-first-touch.js",
    "--repo-root", "{repo}",
    "--project-id", project,
    "--workspace-state", workspaceState,
    "--operation", "references",
    "--runs", String(runs),
    "--timeout-ms", "180000"
  ];
  const sampler = startResourceSampler();
  let stdoutBuffer = "";
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn("sh", [path.join(scriptRoot, "scripts", "run-isolated-node.sh"), ...args], {
      cwd: scriptRoot,
      env: process.env
    });
    child.stdout.on("data", chunk => {
      stdoutBuffer += chunk.toString("utf8");
      void appendFile(stdoutFile, chunk);
    });
    child.stderr.on("data", chunk => {
      void appendFile(stderrFile, chunk);
    });
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
  sampler.stop();
  if (exitCode !== 0) {
    throw new Error(`${label} exited with code ${exitCode}; see ${stderrFile}`);
  }
  const payload = parsePayloadAfterStatusLines(stdoutBuffer, stdoutFile);
  const resource = sampler.result();
  return { attempts: payload.attempts, ...resource };
}

// run-isolated-validation.mjs and run-isolated-jdt-benchmark.mjs each print one single-line
// status JSON object before handing off; semantic-first-touch.js's own pretty-printed
// { metadata, attempts } payload is everything after those two lines (matches the
// `tail -n +3` convention already used for prior real-JDT isolated benchmark runs this sprint).
function parsePayloadAfterStatusLines(buffer, stdoutFile) {
  const lines = buffer.split("\n");
  const rest = lines.slice(2).join("\n");
  try {
    const parsed = JSON.parse(rest);
    if (!Array.isArray(parsed?.attempts)) throw new Error("no attempts array");
    return parsed;
  } catch (error) {
    throw new Error(`could not parse semantic-first-touch payload from stdout (see ${stdoutFile}): ${error.message}`);
  }
}

function evaluate(fresh, reused) {
  const baselineTotals = fresh.attempts.map(attempt => attempt.totalMs).sort((left, right) => left - right);
  const warmTotals = reused.attempts.slice(1).map(attempt => attempt.totalMs).sort((left, right) => left - right);
  const baselineP95 = percentile(baselineTotals, 95);
  const warmP95 = percentile(warmTotals, 95);
  const p95ImprovementRatio = (baselineP95 - warmP95) / baselineP95;
  const rssIncreaseRatio = fresh.peakRssKb > 0 ? (reused.peakRssKb - fresh.peakRssKb) / fresh.peakRssKb : undefined;
  const cpuIncreaseRatio = fresh.peakCpuPercent > 0 ? (reused.peakCpuPercent - fresh.peakCpuPercent) / fresh.peakCpuPercent : undefined;
  const pass = Number.isFinite(p95ImprovementRatio) && p95ImprovementRatio >= P95_IMPROVEMENT_GATE
    && rssIncreaseRatio !== undefined && rssIncreaseRatio <= RESOURCE_INCREASE_GATE
    && cpuIncreaseRatio !== undefined && cpuIncreaseRatio <= RESOURCE_INCREASE_GATE;
  return {
    baselineP95TotalMs: round(baselineP95),
    warmP95TotalMs: round(warmP95),
    p95ImprovementRatio: round(p95ImprovementRatio),
    freshPeakRssKb: fresh.peakRssKb,
    reusedPeakRssKb: reused.peakRssKb,
    rssIncreaseRatio: rssIncreaseRatio !== undefined ? round(rssIncreaseRatio) : null,
    freshPeakCpuPercent: fresh.peakCpuPercent,
    reusedPeakCpuPercent: reused.peakCpuPercent,
    cpuIncreaseRatio: cpuIncreaseRatio !== undefined ? round(cpuIncreaseRatio) : null,
    freshSampleCount: fresh.sampleCount,
    reusedSampleCount: reused.sampleCount,
    pass
  };
}

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return NaN;
  const index = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, index)];
}

function startResourceSampler() {
  let peakRssKb = 0;
  let peakCpuPercent = 0;
  let sampleCount = 0;
  let stopped = false;
  let pending = false;
  const timer = setInterval(() => {
    if (stopped || pending) return;
    pending = true;
    void sampleOnce().finally(() => { pending = false; });
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
  async function sampleOnce() {
    const pids = await findJdtPids();
    for (const pid of pids) {
      try {
        const { stdout } = await execFileAsync("ps", ["-o", "rss=,%cpu=", "-p", pid]);
        const [rssKb, cpuPercent] = stdout.trim().split(/\s+/).map(Number);
        if (Number.isFinite(rssKb)) peakRssKb = Math.max(peakRssKb, rssKb);
        if (Number.isFinite(cpuPercent)) peakCpuPercent = Math.max(peakCpuPercent, cpuPercent);
      } catch {
        // the process may have exited between pgrep and ps; skip this sample.
      }
    }
    sampleCount += 1;
  }
  return {
    stop() { stopped = true; clearInterval(timer); },
    result() { return { peakRssKb, peakCpuPercent, sampleCount }; }
  };
}

async function assertNoStrayJdt() {
  const pids = await findJdtPids();
  if (pids.length > 0) {
    throw new Error(
      `refusing to start: found pre-existing JDT process(es) matching "${JDT_MATCH}" (pid(s) ${pids.join(",")}). `
      + "This experiment requires no other JDT session running on the machine."
    );
  }
}

async function findJdtPids() {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", JDT_MATCH]);
    return stdout.split("\n").map(line => line.trim()).filter(Boolean);
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function parseCli(args) {
  const repositories = {};
  let outputDir;
  let runs = 3;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--output-dir") { outputDir = args[++index]; continue; }
    if (arg === "--runs") { runs = Number.parseInt(args[++index], 10); continue; }
    if (arg === "--lishuedu") { repositories.lishuedu = args[++index]; continue; }
    if (arg === "--cipherlink") { repositories.cipherlink = args[++index]; continue; }
    if (arg === "--exam-parent-v3") { repositories["exam-parent-v3"] = args[++index]; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!outputDir) throw new Error("--output-dir is required");
  if (!Number.isInteger(runs) || runs < 2) throw new Error("--runs must be an integer >= 2 (attempt 1 is excluded from the warm sample)");
  return { outputDir: path.resolve(outputDir), runs, repositories };
}

function printUsage() {
  console.log("Usage: node scripts/run-idle-prewarm-experiment.mjs --output-dir DIR --lishuedu DIR --cipherlink DIR --exam-parent-v3 DIR [--runs 3]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

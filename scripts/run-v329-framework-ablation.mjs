#!/usr/bin/env node
// input: three real Java repositories (golden worktrees the caller owns), each with its own
//   golden/{projectId}.scenarios.jsonl already checked in.
// output: for each of {spring, mybatis, mapstruct} x each repo, an ON run (full adapter
//   registry) and an OFF run (--exclude-framework-adapter <id>) of dist/benchmark-agent-impact.js,
//   each through its own top-level two-layer isolation-chain invocation (own detached clone, own
//   JavaIndex cache, own process) so ON/OFF never share warm state; plus a diff of golden/
//   task-blocking-relevant totals and independent cost, and a manifest recording the runtimeBuild
//   gitSha each arm actually ran against (the source-locked provenance the plan requires).
// pos: V3.2-29 (development-plan Sprint5, provider measured-or-remove). warmState is fixed to
//   cold-nolsp (no real jdtls spawn needed - framework adapters run off JavaIndex/rg evidence,
//   not live LSP), so this script does not need the host-load/stray-jdt guards V3.2-24's
//   experiment script needed.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER_IDS = ["spring", "mybatis", "mapstruct"];
const REPOS = {
  cipherlink: "/private/tmp/codex-java-v3-golden-20260809/cipherlink",
  lishuedu: "/private/tmp/codex-java-v3-golden-20260809/lishuedu",
  "exam-parent-v3": "/private/tmp/codex-java-v3-golden-20260809/exam-parent-v3"
};
const GAIN_FIELDS = ["recall", "pRead", "rTaskBlocking", "rReadMust", "NDCG_read@6"];
const COST_FIELDS = ["elapsedMs", "totalAgentVisiblePayload", "readPlanFiles", "readPlanBytes"];

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) return printUsage();
  await mkdir(cli.outputDir, { recursive: true });
  const manifest = { schemaVersion: "v32-framework-ablation/v1", generatedAt: new Date().toISOString(), adapters: {} };
  for (const adapterId of cli.adapters) {
    manifest.adapters[adapterId] = { repos: {} };
    for (const [project, repoRoot] of Object.entries(REPOS)) {
      console.log(`v329-framework-ablation: ${adapterId} x ${project} - ON`);
      const on = await runArm({ project, repoRoot, excludeAdapter: "", label: `${adapterId}-${project}-on`, outputDir: cli.outputDir });
      console.log(`v329-framework-ablation: ${adapterId} x ${project} - OFF`);
      const off = await runArm({ project, repoRoot, excludeAdapter: adapterId, label: `${adapterId}-${project}-off`, outputDir: cli.outputDir });
      const cell = { on: totalsOf(on.payload), off: totalsOf(off.payload), gainDelta: {}, costDelta: {} };
      for (const field of GAIN_FIELDS) cell.gainDelta[field] = requireField(cell.on, cell.off, field);
      for (const field of COST_FIELDS) cell.costDelta[field] = requireField(cell.on, cell.off, field);
      // gitSha reflects committed HEAD only; executableTree (from the isolation status line) is the
      // real per-arm provenance token - it differs between ON/OFF exactly when the tree differs.
      cell.onExecutableTree = on.executableTree;
      cell.offExecutableTree = off.executableTree;
      manifest.adapters[adapterId].repos[project] = cell;
      console.log(`v329-framework-ablation: ${adapterId} x ${project} -> gainDelta=${JSON.stringify(cell.gainDelta)}`);
    }
  }
  await writeFile(path.join(cli.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
}

function totalsOf(payload) {
  return { metadata: payload.metadata, ...payload.totals };
}

async function runArm({ project, repoRoot, excludeAdapter, label, outputDir }) {
  const stdoutFile = path.join(outputDir, `${label}.stdout.log`);
  const args = [
    path.join(scriptRoot, "scripts", "run-isolated-validation.mjs"), "--profile", "compile", "--",
    "node", "scripts/run-isolated-jdt-benchmark.mjs", "--repo-root", repoRoot, "--",
    "node", "dist/benchmark-agent-impact.js", "--repo-root", "{repo}",
    "--project-id", project, "--warm-state", "cold-nolsp", "--mode", "balanced",
    "--semantic-policy", "fast", "--verbosity", "diagnostic", "--runs", "1"
  ];
  if (excludeAdapter) args.push("--exclude-framework-adapter", excludeAdapter);
  let stdoutBuffer = "";
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn("sh", [path.join(scriptRoot, "scripts", "run-isolated-node.sh"), ...args], { cwd: scriptRoot, env: process.env });
    child.stdout.on("data", chunk => { stdoutBuffer += chunk.toString("utf8"); });
    child.stderr.on("data", () => {});
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
  await writeFile(stdoutFile, stdoutBuffer);
  if (exitCode !== 0) throw new Error(`${label} exited with code ${exitCode}; see ${stdoutFile}`);
  return parsePayload(stdoutBuffer, stdoutFile);
}

function parsePayload(buffer, stdoutFile) {
  const lines = buffer.split("\n");
  const markerIndices = lines.reduce((acc, line, index) => (line.startsWith('{"isolation"') ? [...acc, index] : acc), []);
  if (markerIndices.length === 0) throw new Error(`no isolation status line found in ${stdoutFile}`);
  // The outer run-isolated-validation.mjs status line is first; its executableTree is the
  // candidate src/ tree actually under test (the working-tree patch applied on top of HEAD),
  // unlike runtimeBuild.gitSha inside the payload which only ever names the committed HEAD.
  const outerStatus = JSON.parse(lines[markerIndices[0]]);
  const rest = lines.slice(markerIndices[markerIndices.length - 1] + 1)
    .filter(line => !line.trim().startsWith("[exited with code"))
    .join("\n");
  try {
    return { payload: JSON.parse(rest), executableTree: outerStatus.executableTree };
  } catch (error) {
    throw new Error(`could not parse benchmark-agent-impact payload from ${stdoutFile}: ${error.message}`);
  }
}

function requireField(on, off, field) {
  if (!(field in on) || !(field in off)) throw new Error(`totals is missing required field "${field}"`);
  return round4(on[field] - off[field]);
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function parseCli(args) {
  let outputDir;
  let adapters = ADAPTER_IDS;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--output-dir") { outputDir = args[++index]; continue; }
    if (arg === "--adapter") { adapters = [args[++index]]; continue; }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!outputDir) throw new Error("--output-dir is required");
  return { outputDir: path.resolve(outputDir), adapters };
}

function printUsage() {
  console.log("Usage: node scripts/run-v329-framework-ablation.mjs --output-dir DIR [--adapter spring|mybatis|mapstruct]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

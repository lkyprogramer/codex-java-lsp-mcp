#!/usr/bin/env node
// input: The V3.2-07a six holdout tasks, optional Sprint0' identity, and explicit external-call authorization.
// output: A source-locked Agent-trace plan, or BLOCKED_EXTERNAL with UNMEASURED usage — never invented zeros.
// pos: V4-10 harness. External model calls stay off until the user supplies a key and --authorize-external.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTraceTasks } from "./record-mcp-trace-matrix.mjs";
import {
  V4_SPRINT0_IDENTITY_COMMIT,
  V4_SPRINT0_PRODUCTION_TREE
} from "./verify-v4-sprint0-baseline.mjs";

export const AGENT_TRACE_SCHEMA_VERSION = "java-intelligence-v4-agent-trace-matrix/v1";
export const AGENT_TRACE_ROUNDS = ["AB", "BA"];
export const AGENT_TRACE_VARIANTS = ["old", "new"];

export function blockedExternalResult(reason = "missing API key or --authorize-external") {
  return {
    schemaVersion: AGENT_TRACE_SCHEMA_VERSION,
    status: "BLOCKED_EXTERNAL",
    reason,
    modelUsage: { status: "UNMEASURED" },
    taskSuccess: { status: "UNMEASURED" },
    blindReview: { status: "UNMEASURED" }
  };
}

export function hasExternalAgentCredentials(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.JAVA_LSP_AGENT_API_KEY);
}

export function parseAgentTraceCli(args, env = process.env) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "--authorize-external" || key === "--dry-run" || key === "--execute-live") {
      flags.add(key);
      continue;
    }
    if (!key.startsWith("--") || index + 1 >= args.length) throw new Error(`invalid argument: ${key}`);
    options.set(key, args[++index]);
  }
  return {
    help: flags.has("--help"),
    dryRun: flags.has("--dry-run"),
    authorizeExternal: flags.has("--authorize-external"),
    executeLive: flags.has("--execute-live"),
    sprint0Manifest: options.get("--sprint0-manifest"),
    outputDir: options.get("--output-dir"),
    oldSide: options.get("--old-side") ?? V4_SPRINT0_IDENTITY_COMMIT,
    newSide: options.get("--new-side"),
    maxTasks: options.get("--max-tasks") ? Number(options.get("--max-tasks")) : 3,
    liveOffset: options.get("--live-offset") ? Number(options.get("--live-offset")) : 0,
    repositories: {
      lishuedu: options.get("--lishuedu") || env.LISHUEDU_ROOT,
      cipherlink: options.get("--cipherlink") || env.CIPHERLINK_ROOT,
      "exam-parent-v3": options.get("--exam-parent-v3") || env.EXAM_PARENT_V3_ROOT
    },
    env
  };
}

export async function planAgentTraceMatrix(cli, { loadTasks = loadTraceTasks } = {}) {
  const { tasks, goldenFiles } = await loadTasks();
  if (tasks.length !== 6) throw new Error("agent-trace contract must freeze exactly six holdout tasks");
  const cells = [];
  for (const task of tasks) {
    for (const round of AGENT_TRACE_ROUNDS) {
      for (const variant of AGENT_TRACE_VARIANTS) {
        cells.push({
          taskId: task.taskId,
          projectId: task.projectId,
          repoCommit: task.repoCommit,
          round,
          variant,
          oldSide: cli.oldSide,
          newSide: cli.newSide ?? "PHASE1_TREE_PENDING"
        });
      }
    }
  }
  return {
    schemaVersion: AGENT_TRACE_SCHEMA_VERSION,
    identity: {
      oldSide: cli.oldSide,
      newSide: cli.newSide ?? null,
      sprint0Commit: V4_SPRINT0_IDENTITY_COMMIT,
      sprint0ProductionTree: V4_SPRINT0_PRODUCTION_TREE
    },
    goldenFiles,
    tasks: tasks.map(task => ({
      taskId: task.taskId,
      projectId: task.projectId,
      scenarioId: task.scenarioId,
      repoCommit: task.repoCommit,
      requiredContextFiles: task.requiredContextFiles,
      anchor: task.anchor
    })),
    protocol: {
      rounds: AGENT_TRACE_ROUNDS,
      variants: AGENT_TRACE_VARIANTS,
      cells: cells.length,
      locked: ["provider", "model", "version", "temperature", "seed"]
    },
    cells
  };
}

export async function runAgentTraceMatrix(cli) {
  const plan = await planAgentTraceMatrix(cli);
  if (cli.sprint0Manifest) {
    if (!existsSync(cli.sprint0Manifest)) {
      throw new Error(`Sprint0' manifest is missing: ${cli.sprint0Manifest}`);
    }
    const sprint0 = JSON.parse(readFileSync(cli.sprint0Manifest, "utf8"));
    if (sprint0.identity?.commit !== V4_SPRINT0_IDENTITY_COMMIT) {
      throw new Error("agent-trace old side must bind the V4 Sprint0' merge identity");
    }
  }
  if (!cli.authorizeExternal || !hasExternalAgentCredentials(cli.env)) {
    return {
      ...blockedExternalResult(),
      plan
    };
  }
  if (!cli.executeLive) {
    return {
      schemaVersion: AGENT_TRACE_SCHEMA_VERSION,
      status: "READY_BUT_NOT_EXECUTED",
      reason: "external execution remains a separate, user-triggered step; pass --execute-live to send traffic",
      modelUsage: { status: "UNMEASURED" },
      taskSuccess: { status: "UNMEASURED" },
      blindReview: { status: "UNMEASURED" },
      plan
    };
  }
  if (cli.dryRun) {
    throw new Error("--execute-live cannot be combined with --dry-run");
  }
  if (!cli.outputDir) throw new Error("--execute-live requires --output-dir outside the source checkout");
  const { executeLiveTrace, selectLiveTasks } = await import("./run-agent-trace-live.mjs");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(cli.outputDir, { recursive: true });
  const selected = selectLiveTasks(plan.tasks, {
    maxTasks: cli.maxTasks,
    onePerProject: true,
    offset: cli.liveOffset
  });
  const live = await executeLiveTrace({
    tasks: selected,
    repositories: cli.repositories,
    outputDir: cli.outputDir,
    env: cli.env
  });
  const file = path.join(cli.outputDir, "live-trace.json");
  const planWithLive = { ...plan, liveTasks: selected.map(task => task.taskId) };
  await writeFile(file, `${JSON.stringify({ plan: planWithLive, live }, null, 2)}\n`);
  return {
    schemaVersion: AGENT_TRACE_SCHEMA_VERSION,
    status: live.status,
    modelUsage: live.modelUsage,
    taskSuccess: live.taskSuccess,
    blindReview: live.blindReview,
    lambdaMagnitude: live.lambdaMagnitude,
    outputFile: file,
    plan: planWithLive,
    live
  };
}

function printUsage() {
  console.log(`usage: node scripts/run-agent-trace-matrix.mjs [--dry-run] [--authorize-external] [--execute-live] \\
  [--max-tasks 3] [--live-offset 0] [--output-dir <dir>] [--lishuedu <root>] [--cipherlink <root>] [--exam-parent-v3 <root>] \\
  [--sprint0-manifest docs/phase-v4/v4-sprint0-manifest.json] [--old-side <sha>] [--new-side <sha>]`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cli = parseAgentTraceCli(process.argv.slice(2));
  if (cli.help) {
    printUsage();
  } else {
    runAgentTraceMatrix(cli).then(result => {
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "BLOCKED_EXTERNAL") process.exitCode = 3;
    }).catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
  }
}

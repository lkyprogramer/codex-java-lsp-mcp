#!/usr/bin/env node
// input: Frozen dev task set (dataset/prompts/dev.jsonl), gold (dataset/gold),
//         a model backend (OpenAI-compatible API or codex CLI), and the local
//         product MCP server for java_symbol. No backend credentials means the
//         run reports BLOCKED_AUTH and nothing is measured.
// output: A java-devkit-task-eval/v1 results pack: per-task taskOutcome
//         (UNMEASURED until the external evaluator scores it), a SOURCE_RECEIVED
//         ledger built from actual tool/model events (never model narrative),
//         provider raw usage (null when missing, never bytes/4), and a
//         BLOCKED_AUTH report when no agent backend is authorized.
// pos: M2 T09 - host recorder adapter. Q-track answers are strict JSON scored
//      against frozen gold; P-track outcomes come from externally frozen tests
//      run against the candidate worktree. Path occurrences only ever feed the
//      coverage proxy, never the task outcome.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  runLiveAgentTask,
  openImpactSession,
  liveProjectCacheRoot,
  ARM_SYSTEM_PROMPTS
} from "./run-agent-trace-live.mjs";
import { openaiCompatibleChat, openaiCompatibleConfig } from "./openai-compatible-chat.mjs";

export const EVAL_PACK_SCHEMA_VERSION = "java-devkit-task-eval/v1";
const DISCOVERY_SCHEMA = "java-discovery/v1";

// T09 step 3: the agent gets the same model, prompt and budget and may use
// its tools freely - it is never forced to call java_symbol first.
export const EVAL_SYSTEM_PROMPT = `${ARM_SYSTEM_PROMPTS.old ?? "You are a Java specialist agent."}\n\nYou may use the java_symbol and read tools in any order, or none at all. Finish by replying with ONE strict JSON object and nothing else: for qa tasks use exactly the keys named in the task; for repair tasks use {"patchApplied": true|false, "summary": "..."}.`;;

export const EVAL_JAVA_SYMBOL_TOOL = {
  type: "function",
  function: {
    name: "java_symbol",
    description: "Locate Java declarations (types/methods) by name, FQN, or task intent. Returns declarations with 1-based locators and byte-exact source previews.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symbol name, FQN, owner#method, or free task text" },
        terms: { type: "array", items: { type: "string" }, description: "Alternative search terms" },
        searchMode: { type: "string", enum: ["auto", "exact", "text"] },
        limit: { type: "integer" },
        module: { type: "string" },
        sourceSet: { type: "string", enum: ["main", "test"] }
      },
      required: ["query"]
    }
  }
};

export const EVAL_READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read an exact file window from the repository (repo-relative path).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "integer" },
        maxLines: { type: "integer" }
      },
      required: ["path"]
    }
  }
};

/** Backends that can run a live agent. Anything else is BLOCKED_AUTH. */
export function detectBackend(env = process.env, checks = { hasCodexCli: () => false }) {
  if (env.OPENAI_API_KEY && env.OPENAI_BASE_URL && env.OPENAI_MODEL) {
    return { kind: "openai-api", model: env.OPENAI_MODEL, baseUrl: env.OPENAI_BASE_URL };
  }
  if (checks.hasCodexCli?.()) {
    return { kind: "codex-cli", model: env.CODEX_MODEL ?? "codex-cli" };
  }
  return null;
}

export function backendDeficit(env = process.env, checks = { hasCodexCli: () => false }) {
  const openaiMissing = [];
  if (!env.OPENAI_API_KEY) openaiMissing.push("OPENAI_API_KEY");
  if (!env.OPENAI_BASE_URL) openaiMissing.push("OPENAI_BASE_URL");
  if (!env.OPENAI_MODEL) openaiMissing.push("OPENAI_MODEL");
  if (openaiMissing.length === 0) return [];
  if (checks.hasCodexCli?.()) return [];
  return [...openaiMissing, "codex CLI"];
}

/** K-contract: missing usage stays null; it is never estimated from bytes/4. */
function usageOrZero(usage) {
  if (!usage || typeof usage !== "object") return null;
  if (usage.status !== "MEASURED" && usage.status !== "PARTIAL") return null;
  return {
    status: usage.status,
    promptTokens: Number(usage.promptTokens ?? usage.prompt_tokens ?? 0),
    completionTokens: Number(usage.completionTokens ?? usage.completion_tokens ?? 0)
  };
}

/**
 * One SOURCE_RECEIVED event per chunk of actual source text that crossed the
 * wire. The recorder builds these from transport/tool output; a model
 * narrative (a summary that merely mentions a path) never creates an event.
 */
export function sourceReceivedEvent({ callId, toolName, path: repoRelativePath, text, startLine, endLine }) {
  return {
    type: "SOURCE_RECEIVED",
    callId,
    path: String(repoRelativePath).replaceAll("\\", "/").replace(/^\.\/+/, ""),
    contentHash: createHash("sha256").update(String(text), "utf8").digest("hex"),
    startLine: Number(startLine),
    endLine: Number(endLine),
    text: String(text),
    origin: toolName === "read" ? "explicit_read" : "tool_response"
  };
}

/**
 * Extracts SOURCE_RECEIVED events from one tool result. Two shapes exist:
 *  - the read tool: the host returns the exact file text plus its range;
 *  - java_symbol (discovery): candidates carry byte-exact source previews
 *    with evidenceRange, identified by the frozen schemaVersion.
 * Plain text summaries produce no event: a summary is not source.
 */
export function extractSourceEvents({ callId, toolName, result }) {
  const events = [];
  if (!result) return events;
  if (toolName === "read") {
    const text = typeof result.text === "string" ? result.text
      : Array.isArray(result) ? result.map(block => (typeof block?.text === "string" ? block.text : "")).join("")
        : "";
    if (typeof result.path === "string" && text) {
      const lines = text.split("\n");
      const startLine = Number(result.startLine ?? 1);
      events.push(sourceReceivedEvent({
        callId,
        toolName,
        path: result.path,
        text,
        startLine,
        endLine: startLine + Math.max(0, lines.length - 1)
      }));
    }
    return events;
  }
  const text = typeof result === "string" ? result
    : Array.isArray(result) ? result.map(block => (typeof block?.text === "string" ? block.text : "")).join("")
      : typeof result.text === "string" ? result.text
        : "";
  if (!text) return events;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return events;
  }
  if (!payload || payload.schemaVersion !== DISCOVERY_SCHEMA || !Array.isArray(payload.candidates)) {
    return events;
  }
  for (const candidate of payload.candidates) {
    if (candidate?.previewKind === "source" && typeof candidate.preview === "string"
      && candidate.declaration?.relativePath && candidate.evidenceRange) {
      events.push(sourceReceivedEvent({
        callId,
        toolName,
        path: candidate.declaration.relativePath,
        text: candidate.preview,
        startLine: candidate.evidenceRange.startLine,
        endLine: candidate.evidenceRange.endLine
      }));
    }
  }
  return events;
}

export function createRecorder() {
  const events = [];
  return {
    recordToolResult({ callId, toolName, result }) {
      for (const event of extractSourceEvents({ callId, toolName, result })) events.push(event);
      return events.length;
    },
    events: () => events
  };
}

/** Q track: the answer is strict JSON; every gold key must match exactly. */
export function scoreQaAnswer(goldAnswer, rawAnswer) {
  let parsed;
  try {
    parsed = JSON.parse(rawAnswer);
  } catch {
    return { status: "INVALID_ANSWER", correct: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "INVALID_ANSWER", correct: false };
  }
  if (!goldAnswer || typeof goldAnswer !== "object") {
    return { status: "NO_GOLD", correct: false };
  }
  const keys = Object.keys(goldAnswer);
  for (const key of keys) {
    if (!(key in parsed)) return { status: "INCOMPLETE_ANSWER", correct: false, missing: [key] };
  }
  for (const key of keys) {
    if (String(parsed[key]) !== String(goldAnswer[key])) {
      return { status: "WRONG_ANSWER", correct: false, wrong: [key] };
    }
  }
  return { status: "CORRECT", correct: true };
}

/**
 * Assembles the results pack. The denominator keeps every task (timeouts and
 * errors included); a task whose outcome was never externally measured stays
 * UNMEASURED - the pack never promotes a proxy into a task success.
 */
export function assemblePack({ status, backend, datasetHash, arms, repeats, runs, blockedReasons }) {
  const packs = runs.map(run => ({
    taskId: run.taskId,
    arm: run.arm,
    repeat: run.repeat,
    taskOutcome: run.taskOutcome ?? "UNMEASURED",
    taskSuccess: run.taskSuccess ?? null,
    answerStatus: run.answerStatus ?? null,
    toolCallCount: run.toolCallCount ?? 0,
    sourceReceived: run.sourceReceived ?? [],
    usage: usageOrZero(run.usage),
    timedOut: Boolean(run.timedOut),
    error: run.error ?? null
  }));
  const measured = packs.filter(pack => pack.taskSuccess === true || pack.taskSuccess === false);
  return {
    schemaVersion: EVAL_PACK_SCHEMA_VERSION,
    status,
    ...(blockedReasons?.length ? { blockedReasons } : {}),
    backend: backend ?? null,
    datasetHash: datasetHash ?? null,
    arms,
    repeats,
    denominator: packs.length,
    packs,
    taskSuccessRate: measured.length > 0 ? measured.filter(pack => pack.taskSuccess === true).length / measured.length : null
  };
}

export function loadTaskFile(file) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}

export function loadGoldFile(file) {
  const rows = loadTaskFile(file);
  return new Map(rows.map(row => [row.id, row]));
}

/**
 * Live eval runner (T09 step 5): 12 devpilot tasks x arms x repeats through
 * the real product MCP server and an authorized model backend. Only reached
 * with a real backend; without one, main() already reported BLOCKED_AUTH.
 * Q-track outcomes are scored against frozen gold; P-track (repair) outcomes
 * stay UNMEASURED unless an external frozen-test runner is injected.
 */
export async function runLiveEvalRun({
  tasks,
  gold,
  arms = ["product", "control"],
  repeats = 1,
  repoRoots,
  outputDir,
  env = process.env,
  serverJs,
  repairTester
}) {
  const config = openaiCompatibleConfig(env);
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL are required for a live eval run");
  }
  mkdirSync(outputDir, { recursive: true });
  const recorder = createRecorder();
  const runs = [];
  for (const task of tasks) {
    const repoRoot = repoRoots?.[task.corpus];
    if (!repoRoot) {
      for (const arm of arms) {
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
          runs.push({
            taskId: task.id,
            arm,
            repeat,
            taskOutcome: "UNMEASURED",
            taskSuccess: null,
            error: `no staged repository for corpus ${task.corpus}`
          });
        }
      }
      continue;
    }
    const goldRow = gold?.get(task.id);
    for (const arm of arms) {
      let session;
      try {
        session = await openImpactSession({
          repoRoot,
          serverJs,
          cacheRoot: liveProjectCacheRoot(outputDir, task.corpus),
          env
        });
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
          let callSeq = 0;
          const run = await runLiveAgentTask({
            task: {
              taskId: task.id,
              taskText: task.query,
              projectId: task.corpus,
              requiredContextFiles: (goldRow?.required_evidence ?? []).map(item => item.path),
              anchor: task.anchors?.[0] ?? { file: "unknown", line: 1, column: 1 }
            },
            arm: "old",
            systemPrompt: EVAL_SYSTEM_PROMPT,
            tools: [EVAL_JAVA_SYMBOL_TOOL, EVAL_READ_TOOL],
            chat: ({ messages, tools, maxTokens }) => openaiCompatibleChat({ ...config, messages, tools, maxTokens }),
            invoke: (name, args) => {
              callSeq += 1;
              const callId = `eval:${task.id}:${arm}:${repeat}:${callSeq}`;
              if (name === "java_symbol") {
                return session.symbol(args, text => {
                  recorder.recordToolResult({ callId, toolName: name, result: text });
                });
              }
              if (name === "read") {
                try {
                  const absolute = path.join(repoRoot, String(args.path).replaceAll("\\", "/"));
                  const full = readFileSync(absolute, "utf8");
                  const lines = full.split("\n");
                  const startLine = Math.max(1, Math.trunc(args.startLine ?? 1));
                  const maxLines = Math.max(1, Math.min(400, Math.trunc(args.maxLines ?? 200)));
                  const text = lines.slice(startLine - 1, startLine - 1 + maxLines).join("\n");
                  const result = { path: args.path, text, startLine, endLine: Math.min(lines.length, startLine - 1 + maxLines) };
                  recorder.recordToolResult({ callId, toolName: name, result });
                  return result;
                } catch (error) {
                  return { error: String(error.message ?? error) };
                }
              }
              return { error: `unknown tool ${name}` };
            }
          });
          const scored = scoreRunOutcome({ task, goldRow, run: {
            stopReason: run.stopReason,
            error: run.error,
            finalContent: run.finalContent,
            usage: run.usage,
            toolCallCount: run.toolCallCount
          }, repairTester });
          runs.push({
            taskId: task.id,
            arm,
            repeat,
            taskOutcome: scored.taskOutcome,
            taskSuccess: scored.taskSuccess,
            answerStatus: scored.answerStatus,
            stopReason: run.stopReason,
            toolCallCount: run.toolCallCount,
            usage: run.usage,
            timedOut: run.stopReason === "MAX_ROUNDS" || run.stopReason === "FAILED_RUNTIME",
            ...(run.error ? { error: run.error } : {})
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (let repeat = 1; repeat <= repeats; repeat += 1) {
          runs.push({
            taskId: task.id,
            arm,
            repeat,
            taskOutcome: "UNMEASURED",
            taskSuccess: null,
            error: message.slice(0, 300)
          });
        }
      } finally {
        if (session) await session.close().catch(() => undefined);
      }
    }
  }
  return {
    runs,
    sourceReceived: recorder.events(),
    backend: { kind: "openai-api", model: config.model }
  };
}

/**
 * Task outcome is scored externally, never by the retrieval proxy: qa tasks
 * against frozen gold; repair tasks only through an injected frozen-test
 * runner; anything else stays UNMEASURED. Timeouts and errors stay in the
 * denominator with taskSuccess null.
 */
export function scoreRunOutcome({ task, goldRow, run, repairTester }) {
  const failed = run.stopReason === "FAILED_RUNTIME"
    || run.stopReason === "FAILED_CONTEXT_CAP"
    || run.stopReason === "MAX_COMPLETION_TOKENS";
  if (failed) {
    return { taskOutcome: "UNMEASURED", taskSuccess: null, answerStatus: run.stopReason };
  }
  if (task.kind === "qa") {
    const score = scoreQaAnswer(goldRow?.answer, run.finalContent);
    return {
      taskOutcome: "MEASURED",
      taskSuccess: score.correct,
      answerStatus: score.status
    };
  }
  if (task.kind === "repair" && repairTester) {
    const verdict = repairTester({ task, finalContent: run.finalContent });
    return {
      taskOutcome: "MEASURED",
      taskSuccess: Boolean(verdict?.passed),
      answerStatus: verdict?.status ?? "external"
    };
  }
  return { taskOutcome: "UNMEASURED", taskSuccess: null, answerStatus: task.kind };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const tasksFile = flag("--tasks");
  const goldFile = flag("--gold");
  const output = flag("--output");
  const arms = (flag("--arms") ?? "product,control").split(",").filter(Boolean);
  const repeats = Math.max(1, Number(flag("--repeats") ?? 1));
  const dryRun = argv.includes("--dry-run");
  if (!tasksFile || !output) {
    console.error("usage: evaluate-java-task.mjs --tasks <dev.jsonl> [--gold <gold.jsonl>] --output <dir> [--arms product,control] [--repeats N] [--dry-run]");
    return 2;
  }
  const datasetHash = goldFile
    ? createHash("sha256").update(readFileSync(goldFile)).digest("hex")
    : null;
  const tasks = loadTaskFile(tasksFile);
  const backend = detectBackend(env);
  if (!backend || dryRun) {
    const runs = tasks.flatMap(task => arms.flatMap(arm =>
      Array.from({ length: repeats }, (_, repeat) => ({
        taskId: task.id,
        arm,
        repeat: repeat + 1,
        taskOutcome: "UNMEASURED",
        taskSuccess: null
      }))));
    const pack = assemblePack({
      status: dryRun ? "DRY_RUN" : "BLOCKED_AUTH",
      backend: dryRun ? null : backend,
      datasetHash,
      arms,
      repeats,
      runs,
      blockedReasons: dryRun ? undefined : backendDeficit(env)
    });
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "results-pack.json"), `${JSON.stringify(pack, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ status: pack.status, denominator: pack.denominator, taskSuccessRate: pack.taskSuccessRate, output: path.join(output, "results-pack.json") }, null, 2));
    return 0;
  }
  // Live path: an authorized backend exists. A live run additionally needs a
  // staged corpus per task and gold; without them the pack reports exactly
  // what is missing instead of measuring anything.
  const repoRoots = Object.fromEntries(String(flag("--repo-roots") ?? "").split(",")
    .filter(Boolean)
    .map(pair => {
      const index = pair.indexOf("=");
      return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : [pair, pair];
    }));
  if (!goldFile) {
    console.error("live run requires --gold <gold.jsonl> (frozen evaluator-side labels)");
    return 2;
  }
  const live = await runLiveEvalRun({
    tasks,
    gold: loadGoldFile(goldFile),
    arms,
    repeats,
    repoRoots,
    outputDir: output,
    env,
    serverJs: flag("--server-js") ?? path.join(path.dirname(new URL(import.meta.url).pathname), "dist", "server.js")
  });
  const pack = assemblePack({
    status: "MEASURED",
    backend: live.backend,
    datasetHash,
    arms,
    repeats,
    runs: live.runs
  });
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "results-pack.json"), `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  writeFileSync(path.join(output, "source-received.jsonl"),
    `${live.sourceReceived.map(event => JSON.stringify(event)).join("\n")}${live.sourceReceived.length ? "\n" : ""}`, "utf8");
  console.log(JSON.stringify({ status: pack.status, denominator: pack.denominator, taskSuccessRate: pack.taskSuccessRate, output: path.join(output, "results-pack.json") }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(String(error?.stack ?? error));
    process.exit(1);
  });
}
// input:  M3 agent 层 A/B 驱动。A2 = M2 product 臂（java_symbol + read，生产
//         dist/server.js）；A3 = 完全相同的 model/system prompt/tools/budget，
//         唯一差异：任务文本追加 precomputed 外部 dense 提示块（DISCOVERY_HINT，
//         行范围供重读验证）——KEEP_EXTERNAL 式外部融合，零产品钩子。
// output: java-devkit-task-eval/v1 兼容 results pack（仓库外）+ 每任务提示块留档。
// pos:    docs/10 实验控制 —— 各臂共享 model/prompt/native tools/预算；
//         provider 开销进总账（本驱动记录 embedding 调用与建库成本）。
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runLiveAgentTask,
  openImpactSession,
  liveProjectCacheRoot
} from "../../scripts/run-agent-trace-live.mjs";
import { openaiCompatibleChat, openaiCompatibleConfig } from "../../scripts/openai-compatible-chat.mjs";
import { buildToolSet, createAttemptWorkspace } from "../../scripts/eval-native-tools.mjs";
import {
  EVAL_SYSTEM_PROMPT,
  EVAL_JAVA_SYMBOL_TOOL,
  armOrder,
  createRecorder,
  scoreRunOutcome
} from "../../scripts/evaluate-java-task.mjs";
import { DenseDiscoveryIndex, embeddingProviderFromEnv, readSearchDocumentFacts, waitForReadyIndex } from "./provider.mjs";
import { gatedDenseSearch, shouldRunDense } from "./gate.mjs";
import { evaluateRepair } from "../../scripts/eval-repair-adapter.mjs";
import { redactBackend, summarizeArm } from "./ab-summary.mjs";

// 可搬运：每个根目录都来自 CLI 参数或环境变量；没有个人绝对路径默认值，
// 缺参数就直接失败，而不是悄悄写到某个人的家目录。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function requiredPath({ flag, env, fallback, label }) {
  const value = cliValue(flag) ?? process.env[env] ?? fallback;
  if (!value) {
    throw new Error(`${label} is required: pass ${flag} <path> or set ${env}. This driver has no personal absolute-path defaults.`);
  }
  return path.resolve(value);
}
const KIT = requiredPath({ flag: "--kit-root", env: "JSB_KIT_ROOT", fallback: path.join(REPO_ROOT, "docs/java-specialist-release-audit-v1.1/baseline-kit"), label: "frozen kit root" });
const STAGE = requiredPath({ flag: "--stage", env: "M3_STAGE", label: "stage root (per-task repo copies)" });
const SERVER_JS = requiredPath({ flag: "--server-js", env: "M3_SERVER_JS", fallback: path.join(REPO_ROOT, "dist/server.js"), label: "product dist/server.js" });
const OUTPUT = requiredPath({ flag: "--out", env: "M3_OUT", label: "run output root (outside the checkout)" });
const CACHE_ROOT = requiredPath({ flag: "--cache", env: "M3_CACHE", fallback: path.join(OUTPUT, "index-cache"), label: "index cache root (outside the checkout)" });
const TASKS_FILE = requiredPath({ flag: "--tasks", env: "M3_TASKS", fallback: path.join(KIT, "dataset/prompts/dev.jsonl"), label: "task split file" });
const GOLD_FILE = requiredPath({ flag: "--gold", env: "M3_GOLD", fallback: path.join(KIT, "dataset/gold/dev.jsonl"), label: "gold split file" });
const CHAT_ENV_FILE = cliValue("--chat-env") ?? process.env.M3_CHAT_ENV ?? null;
const PILOT_TASK_IDS = (process.env.M3_PILOT
  ? process.env.M3_PILOT.split(",").filter(Boolean)
  : (() => { return readFileSync(TASKS_FILE, "utf8").trim().split("\n").map(l => JSON.parse(l).id); })());
const REPEATS = Math.max(1, Number(process.env.M3_REPEATS ?? 3));
const MAX_ROUNDS = 16;
const SEED = Number(process.env.M3_SEED ?? 1984);

function findSqliteFiles(root) {
  const out = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".sqlite")) {
        try { if (statSync(full).size > 0) out.push(full); } catch { /* ignore */ }
      }
    }
  };
  walk(root);
  return out;
}

function formatHintBlock(hints) {
  if (!hints.length) return "";
  const lines = hints.map(hint => {
    const span = hint.startLine != null ? ` lines ${hint.startLine}${hint.endLine != null && hint.endLine > hint.startLine ? `-${hint.endLine}` : ""}` : "";
    const hash = hint.indexedContentHash ? "" : " (path-only: re-read the file to locate the declaration)";
    return `- ${hint.relativePath}${span}${hash}`;
  });
  return `\nOptional semantic discovery hints (external vector provider, DISCOVERY_HINT only - verify by reading the code):\n${lines.join("\n")}`;
}

async function main() {
  const chatEnvFile = CHAT_ENV_FILE ? JSON.parse(readFileSync(CHAT_ENV_FILE, "utf8")) : {};
  if (process.env.OPENROUTER_API_KEY === undefined && typeof chatEnvFile.OPENROUTER_API_KEY === "string") {
    process.env.OPENROUTER_API_KEY = chatEnvFile.OPENROUTER_API_KEY;
  }
  const chatEnv = openaiCompatibleConfig();
  if (!chatEnv.baseUrl || !chatEnv.apiKey || !chatEnv.model) {
    throw new Error(
      "chat backend not configured: pass --chat-env <json> or export PCR_LIVE_*/OPENAI_* (base URL, API key, model). No model call is made without it."
    );
  }
  const provider = embeddingProviderFromEnv(
    { OPENROUTER_EMBEDDING_MODEL: chatEnvFile.OPENROUTER_EMBEDDING_MODEL, ...process.env },
    { cacheFile: path.join(CACHE_ROOT, "embeddings-cache.json") }
  );
  await mkdirSync(OUTPUT, { recursive: true });
  const hintsDir = path.join(OUTPUT, "hints");
  await mkdirSync(hintsDir, { recursive: true });
  const workRoot = path.join(OUTPUT, "repair-work");
  await mkdirSync(workRoot, { recursive: true });

  const tasks = (await readFile(TASKS_FILE, "utf8"))
    .trim().split("\n").map(line => JSON.parse(line))
    .filter(task => PILOT_TASK_IDS.includes(task.id));
  const goldMap = new Map(
    (await readFile(GOLD_FILE, "utf8"))
      .trim().split("\n").map(line => JSON.parse(line)).map(g => [g.id, g])
  );

  const byCorpus = new Map();
  for (const task of tasks) {
    const list = byCorpus.get(task.corpus) ?? [];
    list.push(task);
    byCorpus.set(task.corpus, list);
  }

  const runs = [];
  const corpusCosts = [];
  const chat = ({ messages, tools, maxTokens }) => openaiCompatibleChat({ ...chatEnv, messages, tools, maxTokens });
  // Infrastructure accommodation: the 27B endpoint occasionally 429/5xxs or drops
  // the connection mid-run. Retry a bounded number of times so FAILED_RUNTIME
  // means a genuine infrastructure failure, not a single flaky request.
  const chatWithRetry = async (payload) => {
    const backoffs = [5_000, 15_000, 30_000, 45_000, 60_000, 60_000];
    let last;
    for (let attempt = 0; attempt < backoffs.length; attempt += 1) {
      try {
        return await chat(payload);
      } catch (error) {
        last = error;
        const text = String(error?.message ?? error);
        // 5xx/429 plus upstream-gateway failures (the local codex gateway can
        // flap its upstream OAuth session for tens of seconds at a time).
        const retryable = /HTTP 429|HTTP 5\d\d|fetch failed|socket|timeout|aborted/i.test(text);
        if (!retryable || attempt === backoffs.length - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, backoffs[attempt]));
      }
    }
    throw last;
  };

  for (const [corpus, corpusTasks] of byCorpus) {
    const repoRoot = path.join(STAGE, corpusTasks[0].id, "repo");
    const cacheRoot = liveProjectCacheRoot(OUTPUT, corpus);
    process.stderr.write(`[m3-ab] corpus=${corpus} tasks=${corpusTasks.length}\n`);

    // A3 的 dense 提示在任务开始前一次性算好（外部 provider，预算内）。
    // Fail closed: without a dense index both arms get the same text and the
    // run would spend model budget to report "no dense gain" as a result.
    const dense = new Map();
    let denseBuild;
    {
      const session0 = await openImpactSession({ repoRoot, serverJs: SERVER_JS, cacheRoot, env: process.env });
      let dbPath = path.join(cacheRoot, "index.sqlite");
      let found;
      try {
        await session0.symbol({ query: "java", limit: 1 }).catch(() => undefined);
        found = existsSync(dbPath) ? [dbPath] : findSqliteFiles(cacheRoot);
        // The warm-up may return mid-build; keep the server (and its builder)
        // alive until the index is READY.
        if (found.length > 0) await waitForReadyIndex(found[0]);
      } finally {
        await session0.close?.().catch(() => undefined);
      }
      if (found.length > 0) {
        dbPath = found[0];
        const index = new DenseDiscoveryIndex({
          provider,
          facts: readSearchDocumentFacts(repoRoot, dbPath),
          corpusHash: corpus,
          repoRoot
        });
        const declared = await index.build();
        if (declared === 0) throw new Error(`dense index for ${corpus} has no declarations`);
        denseBuild = { dbPath, declarations: declared, ...index.buildCost, indexIdentity: index.providerIndexIdentity };
        for (const task of corpusTasks) {
          const gate = shouldRunDense({ query: task.query });
          if (!gate.run) {
            dense.set(task.id, { hints: [], reason: gate.reason });
            continue;
          }
          // Cached under cacheIdentity (provider identity + query text hash).
          // A failure stops the run before any chat call: a task without its
          // hints would spend model budget on two identical arms.
          let vector;
          try {
            vector = await provider.embedQuery(task.query);
          } catch (error) {
            throw new Error(`query embedding failed for ${task.id}; no chat call was made: ${error instanceof Error ? error.message : String(error)}`);
          }
          dense.set(task.id, { hints: index.search(vector, { topK: 8 }), reason: "ok" });
        }
      } else {
        throw new Error(`dense index UNAVAILABLE for ${corpus}: index.sqlite not found under ${cacheRoot}`);
      }
    }
    corpusCosts.push({ corpus, denseBuild });
    for (const task of corpusTasks) {
      // 提示先落盘，然后在同一个 task 作用域里跑两臂。HEAD 上这个循环提前
      // 闭合，连带后面的括号把 main() 也提前关掉，汇总段落到模块作用域，
      // 驱动一运行就 ReferenceError: byCorpus is not defined。
      const hints = (dense.get(task.id) ?? { hints: [], reason: "unavailable" }).hints ?? [];
      await writeFile(path.join(hintsDir, `${task.id}.json`), JSON.stringify({
        taskId: task.id,
        query: task.query,
        hintBlock: formatHintBlock(hints),
        hints
      }, null, 1));

      const goldRow = goldMap.get(task.id);
      const isRepair = task.kind === "repair";
      const contract = isRepair
        ? "patchApplied: boolean, summary: string"
        : (task.output_contract?.answer_keys
          ? Object.entries(task.output_contract.answer_keys).map(([key, type]) => `${key}: ${type}`).join(", ")
          : "");
      const baseText = isRepair
        ? `${task.query}\nThis is a repair task: locate the defect and FIX it by using the write_file tool to write the full corrected content of each source file you change (repo-relative path). Only change what the fix requires. Finish by replying with ONE JSON object with exactly these keys: ${contract}.`
        : `${task.query}${contract ? `\nAnswer contract: reply with ONE JSON object with exactly these keys: ${contract}.` : ""}${task.budget ? `\nSource budget: all source you receive (read windows and previews together) may total at most ${task.budget.max_lines} lines / ${task.budget.max_bytes} bytes; receiving more fails the task.` : ""}`;
      const repairManifestEntry = isRepair
        ? JSON.parse(await readFile(path.join(KIT, "dataset/repairs/manifest.json"), "utf8")).find(e => e.task_id === task.id)
        : undefined;
      const hintBlock = formatHintBlock((dense.get(task.id) ?? { hints: [] }).hints ?? []);
      for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
        // Seed-balanced arm order per (task, repeat): neither arm always runs first.
        for (const arm of armOrder(["a2-lexical", "a3-dense-hint"], { seed: SEED, taskId: task.id, repeat })) {
          // R03: one isolated candidate per attempt is the single read/write/
          // test root, and the java_symbol session is opened ON it; after every
          // write the session is re-opened on a fresh index so the next query
          // observes the change.
          const attemptKey = `${task.id}:${arm}:r${repeat}`;
          const candidateRoot = createAttemptWorkspace(repoRoot, attemptKey, OUTPUT);
          const toolSet = buildToolSet("product", isRepair ? "repair" : "qa", { candidateRoot });
          let generation = 0;
          const cacheFor = () => path.join(CACHE_ROOT, "attempts", path.basename(candidateRoot), `w${generation}`);
          const sessions = [];
          let session = await openImpactSession({ repoRoot: candidateRoot, serverJs: SERVER_JS, cacheRoot: cacheFor(), env: process.env });
          sessions.push(session);
          const recorder = createRecorder();
          const toolTrace = [];
          let run;
          try {
            run = await runLiveAgentTask({
              task: {
                taskId: task.id,
                // The only per-arm difference: A3 appends the precomputed external
                // hint block. Everything else (prompt, tools, budget) is shared.
                taskText: arm === "a3-dense-hint" ? `${baseText}${hintBlock}` : baseText,
                projectId: task.corpus,
                requiredContextFiles: [],
                anchor: task.anchors?.[0] ?? { file: "unknown", line: 1, column: 1 }
              },
              arm: "old",
              systemPrompt: EVAL_SYSTEM_PROMPT,
              tools: [EVAL_JAVA_SYMBOL_TOOL, ...toolSet.tools],
              chat: ({ messages, tools, maxTokens }) => chatWithRetry({ messages, tools, maxTokens }),
              maxRounds: MAX_ROUNDS,
              onChat: request => {
                appendFileSync(path.join(OUTPUT, "model-payloads.jsonl"), `${JSON.stringify({ attempt: { taskId: task.id, arm, repeat }, requestIndex: request.requestIndex, payloadHash: request.payloadHash, tools: request.tools, messages: request.messages })}\n`);
                for (const receipt of request.newReceipts) recorder.recordModelDelivery(receipt, request);
              },
              invoke: async (name, args, callId) => {
                let result;
                if (name === "java_symbol") {
                  result = session
                    ? await session.symbol(args)
                    : { error: "discovery session unavailable after a write; results would be stale", errorClass: "PARTIAL" };
                } else {
                  result = await toolSet.invoke(name, args);
                }
                recorder.recordToolResult({ callId, toolName: name, result });
                if (result?.written === true) {
                  const old = session;
                  session = null;
                  await old?.close?.().catch(() => undefined);
                  generation += 1;
                  try {
                    session = await openImpactSession({ repoRoot: candidateRoot, serverJs: SERVER_JS, cacheRoot: cacheFor(), env: process.env });
                    sessions.push(session);
                  } catch (error) {
                    recorder.record({ type: "SESSION_REBIND_FAILED", callId, error: String(error?.message ?? error).slice(0, 300) });
                  }
                }
                const errText = typeof result?.error === "string" ? result.error : null;
                toolTrace.push({
                  name,
                  args: { query: args.query, path: args.path, startLine: args.startLine },
                  ok: !errText,
                  error: errText ? errText.slice(0, 200) : undefined,
                  candidateCount: Array.isArray(result?.candidates) ? result.candidates.length : undefined,
                  written: result?.written === true || undefined
                });
                return result;
              }
            });
          } finally {
            for (const opened of sessions) await opened.close?.().catch(() => undefined);
          }
          // R04: repair success comes ONLY from the frozen Python judge on this
          // attempt's candidate tree; a blocked judge is UNMEASURED (it stays in
          // the denominator), never replaced by another implementation's verdict.
          const repairVerdict = isRepair
            ? await evaluateRepair({
                kitRoot: KIT,
                taskId: task.id,
                mode: "candidate",
                candidateRoot,
                outputRoot: path.join(OUTPUT, "judge", path.basename(candidateRoot))
              })
            : null;
          const events = recorder.events();
          const scored = scoreRunOutcome({ task, goldRow, run: { ...run, sourceReceived: events }, repairVerdict });
          runs.push({
            taskId: task.id,
            arm,
            repeat,
            kind: task.kind,
            stopReason: run.stopReason,
            error: run.error ?? null,
            toolCallCount: run.toolCallCount,
            usage: run.usage,
            taskOutcome: scored.taskOutcome,
            taskSuccess: scored.taskSuccess,
            answerStatus: scored.answerStatus,
            candidateRoot,
            judge: repairVerdict
              ? {
                  implementation: "frozen-python-bridge",
                  state: repairVerdict.state,
                  validatedSuccess: repairVerdict.validatedSuccess === true,
                  reason: repairVerdict.reason ?? null,
                  policy: repairVerdict.policy ?? null,
                  judgeArtifactPath: repairVerdict.judgeArtifactPath ?? null
                }
              : undefined,
            sourceReceived: events.filter(event => event.type === "SOURCE_RECEIVED"),
            toolTrace,
            finalAnswer: (run.finalContent ?? "").slice(0, 400)
          });
          process.stderr.write(`[m3-ab] ${task.id} ${arm} r${repeat} ${scored.taskOutcome}/${scored.answerStatus} success=${scored.taskSuccess}\n`);
        }
      }
    }
  }

  // 汇总：成功率 = 成功 / 全部计划 attempt（失败、阻塞都在分母里）；
  // conditionalAccuracy 只作上下文。
  {
  const pack = {
    schema: "java-specialist-m3-agent-ab/v1",
    generatedAt: new Date().toISOString(),
    backend: redactBackend(chatEnv),
    embedding: { ...provider.costReport() },
    arms: {
      "a2-lexical": "java_symbol (production) + native list/rg/read (repair: + write_file/test)",
      "a3-dense-hint": "a2-lexical + precomputed external DISCOVERY_HINT block in task text"
    },
    repeats: REPEATS,
    maxRounds: MAX_ROUNDS,
    taskIds: PILOT_TASK_IDS,
    seed: SEED,
    summary: [summarizeArm(runs, "a2-lexical"), summarizeArm(runs, "a3-dense-hint")],
    perTask: PILOT_TASK_IDS.map(id => ({
      taskId: id,
      a2: runs.filter(run => run.taskId === id && run.arm === "a2-lexical").map(run => run.taskSuccess),
      a3: runs.filter(run => run.taskId === id && run.arm === "a3-dense-hint").map(run => run.taskSuccess)
    })),
    corpusCosts,
    runs
  };
  await writeFile(path.join(OUTPUT, "results-pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ summary: pack.summary, runs: runs.length }, null, 1));
  }
}

main().catch(error => {
  process.stderr.write(`[m3-ab] FAILED: ${error?.stack ?? error}\n`);
  process.exit(1);
});
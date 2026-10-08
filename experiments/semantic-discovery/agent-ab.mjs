// input:  M3 agent 层 A/B 驱动。A2 = M2 product 臂（java_symbol + read，生产
//         dist/server.js）；A3 = 完全相同的 model/system prompt/tools/budget，
//         唯一差异：任务文本追加 precomputed 外部 dense 提示块（DISCOVERY_HINT，
//         行范围供重读验证）——KEEP_EXTERNAL 式外部融合，零产品钩子。
// output: java-devkit-task-eval/v1 兼容 results pack（仓库外）+ 每任务提示块留档。
// pos:    docs/10 实验控制 —— 各臂共享 model/prompt/native tools/预算；
//         provider 开销进总账（本驱动记录 embedding 调用与建库成本）。
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runLiveAgentTask,
  openImpactSession,
  liveProjectCacheRoot
} from "../../scripts/run-agent-trace-live.mjs";
import { openaiCompatibleChat, openaiCompatibleConfig } from "../../scripts/openai-compatible-chat.mjs";
import { resolveInCandidate } from "../../scripts/eval-native-tools.mjs";
import {
  EVAL_SYSTEM_PROMPT,
  EVAL_JAVA_SYMBOL_TOOL,
  EVAL_READ_TOOL,
  scoreRunOutcome
} from "../../scripts/evaluate-java-task.mjs";
import { DenseDiscoveryIndex, EmbeddingProvider, readSearchDocumentFacts, cosine } from "./provider.mjs";
import { gatedDenseSearch, shouldRunDense } from "./gate.mjs";
import { judgeRepair } from "./repair-judge.mjs";
import { REPAIR_STATE, evaluateRepair } from "../../scripts/eval-repair-adapter.mjs";

// docs/07：agent 在自己的候选拷贝里干活；判断器比较 candidate 与原始
// fixture 的全部文件 hash，非 allowed_edits 变动即拒绝。
const EVAL_WRITE_FILE_TOOL = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a full file into your working copy of the repository (repo-relative path). Use for repair tasks; the evaluator judges the resulting file diff.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"]
    }
  }
};

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
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? chatEnvFile.OPENROUTER_API_KEY;
  const chatEnv = openaiCompatibleConfig();
  if (!chatEnv.baseUrl || !chatEnv.apiKey || !chatEnv.model) {
    throw new Error(
      "chat backend not configured: pass --chat-env <json> or export PCR_LIVE_*/OPENAI_* (base URL, API key, model). No model call is made without it."
    );
  }
  const provider = new EmbeddingProvider({
    apiKey: process.env.EMBEDDING_API_KEY ?? process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_EMBEDDING_MODEL ?? chatEnvFile.OPENROUTER_EMBEDDING_MODEL,
    baseUrl: process.env.EMBEDDING_BASE_URL ?? "https://openrouter.ai/api/v1",
    timeoutMs: 60_000,
    cacheFile: path.join(CACHE_ROOT, "embeddings-cache.json")
  });
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
    const dense = new Map();
    let denseBuild = { unavailable: true, reason: "not attempted" };
    try {
      const session0 = await openImpactSession({ repoRoot, serverJs: SERVER_JS, cacheRoot, env: process.env });
      await session0.symbol({ query: "java", limit: 1 }).catch(() => undefined);
      await session0.close?.().catch(() => undefined);
      let dbPath = path.join(cacheRoot, "index.sqlite");
      const found = existsSync(dbPath) ? [dbPath] : findSqliteFiles(cacheRoot);
      if (found.length > 0) {
        dbPath = found[0];
        const index = new DenseDiscoveryIndex({
          provider,
          facts: readSearchDocumentFacts(repoRoot, dbPath),
          corpusHash: corpus,
          repoRoot
        });
        const declared = await index.build();
        denseBuild = { dbPath, declarations: declared, ...index.buildCost, indexIdentity: index.providerIndexIdentity };
        for (const task of corpusTasks) {
          const gate = shouldRunDense({ query: task.query });
          if (!gate.run) {
            dense.set(task.id, { hints: [], reason: gate.reason });
            continue;
          }
          try {
            const vectors = await provider.embed([task.query], [`${provider.model}::query::${task.query}`]);
            const result = { hints: index.search(vectors[0], { topK: 8 }), reason: "ok" };
            dense.set(task.id, result);
          } catch {
            dense.set(task.id, { hints: [], reason: "embedding_failed" });
          }
        }
      } else {
        denseBuild = { unavailable: true, reason: "index.sqlite not found" };
      }
    } catch (error) {
      denseBuild = { unavailable: true, reason: error instanceof Error ? error.message : String(error) };
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
        : `${task.query}${contract ? `\nAnswer contract: reply with ONE JSON object with exactly these keys: ${contract}.` : ""}`;
      const repairManifestEntry = isRepair
        ? JSON.parse(await readFile(path.join(KIT, "dataset/repairs/manifest.json"), "utf8")).find(e => e.task_id === task.id)
        : undefined;
      const hintBlock = formatHintBlock((dense.get(task.id) ?? { hints: [] }).hints ?? []);
      for (const arm of ["a2-lexical", "a3-dense-hint"]) {
        for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
          // 每轮独立候选拷贝 + 独立会话：会话初始绑定 fixture，agent 写入
          // candidate 后 rebind 到 candidate，使下一跳 java_symbol 观察到修改。
          const runWork = path.join(OUTPUT, "repair-work", `${task.id}:${arm}:r${repeat}`);
          rmSync(runWork, { recursive: true, force: true });
          mkdirSync(runWork, { recursive: true });
          const candidateRoot = path.join(runWork, "candidate");
          cpSync(repoRoot, candidateRoot, { recursive: true });
          const attemptSession = { session: await openImpactSession({ repoRoot, serverJs: SERVER_JS, cacheRoot, env: process.env }) };
          const rebond = async () => {
            const old = attemptSession.session;
            attemptSession.session = await openImpactSession({ repoRoot: candidateRoot, serverJs: SERVER_JS, cacheRoot: `${cacheRoot}-cand-r${repeat}`, env: process.env });
            await old.close().catch(() => undefined);
          };
          const toolTrace = [];
          const run = await runLiveAgentTask({
            task: {
              taskId: task.id,
              // The only per-arm difference: A3 appends the precomputed external
              // hint block. Everything else (prompt, tools, budget) is shared.
              taskText: arm === "a3-dense-hint" ? `${baseText}${hintBlock}` : baseText,
              projectId: task.corpus,
              requiredContextFiles: (goldRow?.required_evidence ?? []).map(item => item.path),
              anchor: task.anchors?.[0] ?? { file: "unknown", line: 1, column: 1 }
            },
            arm: "old",
            systemPrompt: EVAL_SYSTEM_PROMPT,
            tools: isRepair
              ? [EVAL_JAVA_SYMBOL_TOOL, EVAL_READ_TOOL, EVAL_WRITE_FILE_TOOL]
              : [EVAL_JAVA_SYMBOL_TOOL, EVAL_READ_TOOL],
            chat: ({ messages, tools, maxTokens }) => chatWithRetry({ messages, tools, maxTokens }),
            maxRounds: MAX_ROUNDS,
            invoke: async (name, args) => {
              let result;
              if (name === "java_symbol") {
                result = await attemptSession.session.symbol(args);
              } else if (name === "read") {
                const check = resolveInCandidate(candidateRoot, args.path);
                if (check.error) {
                  result = { error: check.error };
                } else {
                  try {
                    const full = readFileSync(check.target, "utf8");
                    const lines = full.split("\n");
                    const startLine = Math.max(1, Math.trunc(args.startLine ?? 1));
                    const maxLines = Math.max(1, Math.min(400, Math.trunc(args.maxLines ?? 200)));
                    result = {
                      path: args.path,
                      text: lines.slice(startLine - 1, startLine - 1 + maxLines).join("\n"),
                      startLine,
                      endLine: Math.min(lines.length, startLine - 1 + maxLines)
                    };
                  } catch (error) {
                    result = { error: String(error.message ?? error) };
                  }
                }
              } else if (name === "write_file") {
                const check = resolveInCandidate(candidateRoot, args.path);
                if (check.error) {
                  result = { error: check.error };
                } else {
                  try {
                    mkdirSync(path.dirname(check.target), { recursive: true });
                    await writeFile(check.target, String(args.content ?? ""), "utf8");
                    result = { path: args.path, written: true };
                    // 写入后把会话 rebind 到 candidate：下一跳 java_symbol 观察修改。
                    await rebond();
                  } catch (error) {
                    result = { error: String(error.message ?? error) };
                  }
                }
              } else {
                result = { error: `unknown tool ${name}` };
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
          // docs/07：repair 结果由实际文件 diff + 外部冻结测试判定；
          // 模型声称的 patchApplied/summary、实际 diff、外部测试三分记录，不合并。
          // R04：优先走原 Python frozen judge（thin bridge）；只有环境阻塞
          // （无 Python/无编译器）时才退回同策略的离线判定器，并如实记录实现。
          let judge = null;
          if (isRepair && repairManifestEntry) {
            const bridged = await evaluateRepair({
              kitRoot: KIT,
              taskId: task.id,
              mode: "candidate",
              candidateRoot,
              outputRoot: path.join(runWork, "judge"),
              timeoutMs: (repairManifestEntry.timeout_seconds ?? 10) * 4_000 + 60_000
            });
            judge = {
              judgeImplementation: "frozen-python-bridge",
              status: bridged.state,
              passed: bridged.validatedSuccess,
              detail: bridged.reason ?? null,
              diffReport: bridged.policy ?? null,
              judgeArtifactPath: bridged.judgeArtifactPath ?? null
            };
            if ([REPAIR_STATE.BLOCKED_ENV, REPAIR_STATE.BLOCKED_SETUP].includes(bridged.state)) {
              const offline = await judgeRepair({
                task: { id: task.id },
                manifestEntry: repairManifestEntry,
                fixtureRoot: repoRoot,
                candidateRoot,
                workDir: path.join(runWork, "judge-offline"),
                javaHome: process.env.JAVA_HOME || null,
                testSourceFile: path.join(KIT, "dataset", repairManifestEntry.test_file)
              });
              judge = { ...offline, judgeImplementation: "js-offline-fallback", blockedBy: bridged.reason };
            }
          }
          const judgeBlocked = judge
            ? [REPAIR_STATE.BLOCKED_ENV, REPAIR_STATE.BLOCKED_SETUP, REPAIR_STATE.JUDGE_ERROR, REPAIR_STATE.TIMEOUT].includes(judge.status)
            : false;
          const scored = isRepair && repairManifestEntry
            ? {
                taskOutcome: judgeBlocked ? "BLOCKED" : "MEASURED",
                taskSuccess: judgeBlocked ? null : judge.passed,
                answerStatus: judgeBlocked ? `REPAIR_${judge.status}` : judge.passed ? "REPAIR_PASS" : `REPAIR_FAIL_${judge.status}`
              }
            : scoreRunOutcome({
                task,
                goldRow,
                run: {
                  stopReason: run.stopReason,
                  error: run.error,
                  finalContent: run.finalContent,
                  usage: run.usage,
                  toolCallCount: run.toolCallCount
                }
              });
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
            judge: judge
              ? {
                  status: judge.status,
                  passed: judge.passed,
                  detail: judge.detail,
                  diffReport: judge.diffReport ?? judge.policy ?? null,
                  judgeImplementation: judge.judgeImplementation,
                  judgeArtifactPath: judge.judgeArtifactPath
                }
              : undefined,
            toolTrace,
            finalAnswer: (run.finalContent ?? "").slice(0, 400)
          });
          process.stderr.write(`[m3-ab] ${task.id} ${arm} r${repeat} ${scored.taskOutcome}/${scored.answerStatus} success=${scored.taskSuccess}\n`);
          await attemptSession.session.close?.().catch(() => undefined);
        }
      }
    }
  }

  // 汇总：两臂共享分母（全部 attempt），measured 只计可判定 attempt；
  // BLOCKED 的 attempt 留在分母里，不静默丢弃。
  {
    const measured = runs.filter(run => run.taskOutcome === "MEASURED");
  const summarize = arm => {
    const subset = measured.filter(run => run.arm === arm);
    const byKind = kind => {
      const ks = subset.filter(run => (run.kind ?? "qa") === kind);
      return ks.length ? { measured: ks.length, successes: ks.filter(run => run.taskSuccess).length, rate: ks.filter(run => run.taskSuccess).length / ks.length } : null;
    };
    return {
      arm,
      measured: subset.length,
      denominator: runs.filter(run => run.arm === arm).length,
      successes: subset.filter(run => run.taskSuccess).length,
      rate: subset.length ? subset.filter(run => run.taskSuccess).length / subset.length : null,
      qa: byKind("qa"),
      repair: byKind("repair")
    };
  };
  const pack = {
    schema: "java-specialist-m3-agent-ab/v1",
    generatedAt: new Date().toISOString(),
    backend: chatEnv,
    embedding: { ...provider.costReport() },
    arms: {
      "a2-lexical": "java_symbol (production) + read",
      "a3-dense-hint": "a2-lexical + precomputed external DISCOVERY_HINT block in task text"
    },
    repeats: REPEATS,
    maxRounds: MAX_ROUNDS,
    taskIds: PILOT_TASK_IDS,
    summary: [summarize("a2-lexical"), summarize("a3-dense-hint")],
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
// input:  M3 agent 层 A/B 驱动。A2 = M2 product 臂（java_symbol + read，生产
//         dist/server.js）；A3 = 完全相同的 model/system prompt/tools/budget，
//         唯一差异：任务文本追加 precomputed 外部 dense 提示块（DISCOVERY_HINT，
//         行范围供重读验证）——KEEP_EXTERNAL 式外部融合，零产品钩子。
// output: java-devkit-task-eval/v1 兼容 results pack（仓库外）+ 每任务提示块留档。
// pos:    docs/10 实验控制 —— 各臂共享 model/prompt/native tools/预算；
//         provider 开销进总账（本驱动记录 embedding 调用与建库成本）。
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runLiveAgentTask,
  openImpactSession,
  liveProjectCacheRoot
} from "../../scripts/run-agent-trace-live.mjs";
import { openaiCompatibleChat, openaiCompatibleConfig } from "../../scripts/openai-compatible-chat.mjs";
import {
  EVAL_SYSTEM_PROMPT,
  EVAL_JAVA_SYMBOL_TOOL,
  EVAL_READ_TOOL,
  scoreRunOutcome
} from "../../scripts/evaluate-java-task.mjs";
import { DenseDiscoveryIndex, EmbeddingProvider, readSearchDocumentFacts, cosine } from "./provider.mjs";
import { gatedDenseSearch, shouldRunDense } from "./gate.mjs";

const KIT = "/Users/luo/Documents/github/codex-java-lsp-mcp/docs/java-specialist-devkit-v1";
const STAGE = "/Users/luo/Documents/github/java-devkit-v1-runs/m1/m1-quality/stage";
const SERVER_JS = "/Users/luo/Documents/github/codex-java-lsp-mcp/dist/server.js";
const RUN = "/Users/luo/Documents/github/java-devkit-v1-runs/m3";
const OUTPUT = process.env.M3_OUT ?? path.join(RUN, "agent-ab");
const PILOT_TASK_IDS = (process.env.M3_PILOT
  ? process.env.M3_PILOT.split(",").filter(Boolean)
  : [
      "JSB-PAYMENTS-01", "JSB-PAYMENTS-03", "JSB-INVENTORY-02", "JSB-INVENTORY-03",
      "JSB-ACCESS-01", "JSB-ACCESS-03", "JSB-ADMISSIONS-01", "JSB-PRICING-03",
      "JSB-PETCLINIC-02", "JSB-MYBATIS-01", "JSB-MYBATIS-02", "JSB-GSON-03"
    ]);
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
  const orEnv = JSON.parse(readFileSync(path.join(RUN, "openrouter.env.json"), "utf8"));
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? orEnv.OPENROUTER_API_KEY;
  const chatEnv = openaiCompatibleConfig();
  if (!chatEnv.baseUrl || !chatEnv.apiKey || !chatEnv.model) {
    throw new Error("chat backend not configured: source /Users/luo/Documents/grok/.env (PCR_LIVE_* -> OPENAI_*) first");
  }
  const provider = new EmbeddingProvider({
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_EMBEDDING_MODEL ?? orEnv.OPENROUTER_EMBEDDING_MODEL,
    timeoutMs: 60_000
  });
  await mkdirSync(OUTPUT, { recursive: true });
  const hintsDir = path.join(OUTPUT, "hints");
  await mkdirSync(hintsDir, { recursive: true });

  const tasks = (await import("node:fs/promises").then(m => m.readFile(path.join(KIT, "dataset/prompts/dev.jsonl"), "utf8")))
    .trim().split("\n").map(line => JSON.parse(line))
    .filter(task => PILOT_TASK_IDS.includes(task.id));
  const goldMap = new Map(
    (await import("node:fs/promises").then(m => m.readFile(path.join(KIT, "dataset/gold/dev.jsonl"), "utf8")))
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
    let last;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await chat(payload);
      } catch (error) {
        last = error;
        const text = String(error?.message ?? error);
        const retryable = /HTTP 429|HTTP 5\d\d|fetch failed|socket|timeout|aborted/i.test(text);
        if (!retryable || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 4000 * (attempt + 1)));
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
            const vectors = await provider.embed([task.query]);
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
      const hints = (dense.get(task.id) ?? { hints: [], reason: "unavailable" }).hints ?? [];
      await writeFile(path.join(hintsDir, `${task.id}.json`), JSON.stringify({
        taskId: task.id,
        query: task.query,
        hintBlock: formatHintBlock(hints),
        hints
      }, null, 1));
    }

    for (const task of corpusTasks) {
      const goldRow = goldMap.get(task.id);
      const contract = task.output_contract?.answer_keys
        ? Object.entries(task.output_contract.answer_keys).map(([key, type]) => `${key}: ${type}`).join(", ")
        : "";
      const baseText = `${task.query}${contract ? `\nAnswer contract: reply with ONE JSON object with exactly these keys: ${contract}.` : ""}`;
      const hintBlock = formatHintBlock((dense.get(task.id) ?? { hints: [] }).hints ?? []);
      for (const arm of ["a2-lexical", "a3-dense-hint"]) {
        const session = await openImpactSession({ repoRoot, serverJs: SERVER_JS, cacheRoot, env: process.env });
        for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
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
            tools: [EVAL_JAVA_SYMBOL_TOOL, EVAL_READ_TOOL],
            chat: ({ messages, tools, maxTokens }) => chatWithRetry({ messages, tools, maxTokens }),
            maxRounds: MAX_ROUNDS,
            invoke: (name, args) => {
              if (name === "java_symbol") return session.symbol(args);
              if (name === "read") {
                try {
                  const absolute = path.join(repoRoot, String(args.path).replaceAll("\\", "/"));
                  const full = readFileSync(absolute, "utf8");
                  const lines = full.split("\n");
                  const startLine = Math.max(1, Math.trunc(args.startLine ?? 1));
                  const maxLines = Math.max(1, Math.min(400, Math.trunc(args.maxLines ?? 200)));
                  return {
                    path: args.path,
                    text: lines.slice(startLine - 1, startLine - 1 + maxLines).join("\n"),
                    startLine,
                    endLine: Math.min(lines.length, startLine - 1 + maxLines)
                  };
                } catch (error) {
                  return { error: String(error.message ?? error) };
                }
              }
              return { error: `unknown tool ${name}` };
            }
          });
          const scored = scoreRunOutcome({
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
            stopReason: run.stopReason,
            error: run.error ?? null,
            toolCallCount: run.toolCallCount,
            usage: run.usage,
            taskOutcome: scored.taskOutcome,
            taskSuccess: scored.taskSuccess,
            answerStatus: scored.answerStatus,
            finalAnswer: (run.finalContent ?? "").slice(0, 400)
          });
          process.stderr.write(`[m3-ab] ${task.id} ${arm} r${repeat} ${scored.taskOutcome}/${scored.answerStatus} success=${scored.taskSuccess}\n`);
        }
        await session.close?.().catch(() => undefined);
      }
    }
  }

  const measured = runs.filter(run => run.taskOutcome === "MEASURED");
  const summarize = arm => {
    const subset = measured.filter(run => run.arm === arm);
    return {
      arm,
      measured: subset.length,
      denominator: runs.filter(run => run.arm === arm).length,
      successes: subset.filter(run => run.taskSuccess).length,
      rate: subset.length ? subset.filter(run => run.taskSuccess).length / subset.length : null
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

main().catch(error => {
  process.stderr.write(`[m3-ab] FAILED: ${error?.stack ?? error}\n`);
  process.exit(1);
});
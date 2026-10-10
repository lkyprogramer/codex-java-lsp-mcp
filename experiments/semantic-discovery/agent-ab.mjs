// input:  The frozen kit (dev split, bundled corpora by default), the product
//         MCP server and an OpenAI-compatible chat backend plus embedding
//         endpoint (user-authorized).
// output: R11 agent-layer A/B. Both arms share model, system prompt, tools
//         (java_symbol + native) and task budget; the only difference is the
//         content of one precomputed candidate block in the task text, built by
//         the same resolver/renderer under the same K=10 cap:
//         A2 = lexical top-K, A3 = RRF(lexical, dense, k0=60) top-K.
//         QA is scored by the frozen kit (scoreWithFrozenKit), repair by the
//         frozen judge; the pack carries the ExperimentProfile/protocol hash.
// pos:    docs/next-stage/experiment-v1.1.md; kit docs/06-experiment-redesign.md.
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
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
  attemptStateOf,
  createRecorder,
  EVAL_PROTOCOL_VERSION,
  scoreRunOutcome,
  scoreWithFrozenKit
} from "../../scripts/evaluate-java-task.mjs";
import { createHash } from "node:crypto";
import {
  DENSE_REPRESENTATION_VERSION,
  DenseDiscoveryIndex,
  QUERY_REPRESENTATION_VERSION,
  embeddingProviderFromEnv,
  readSearchDocumentFacts,
  waitForReadyIndex
} from "./provider.mjs";
import { shouldRunDense } from "./gate.mjs";
import {
  CANDIDATE_K,
  CHANNEL_POOL_K,
  DeclarationResolver,
  comparePilotReports,
  experimentProfile,
  formatCandidateBlock,
  medianPromptTokens,
  lexicalDeclarationIds,
  protocolHash,
  renderEvidence,
  rrfFuse
} from "./budget.mjs";
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
// The kit's bundled corpora: scoreWithFrozenKit validates received source
// against them, so any other stage would be scored against the wrong files.
const STAGE = path.join(KIT, "dataset/corpora");
if (cliValue("--stage") || process.env.M3_STAGE) {
  throw new Error("agent-ab runs on the kit's bundled corpora only (the frozen QA scorer validates received source against them); --stage/M3_STAGE are not supported");
}
const SERVER_JS = requiredPath({ flag: "--server-js", env: "M3_SERVER_JS", fallback: path.join(REPO_ROOT, "dist/server.js"), label: "product dist/server.js" });
const OUTPUT = requiredPath({ flag: "--out", env: "M3_OUT", label: "run output root (outside the checkout)" });
const CACHE_ROOT = requiredPath({ flag: "--cache", env: "M3_CACHE", fallback: path.join(OUTPUT, "index-cache"), label: "index cache root (outside the checkout)" });
const TASKS_FILE = requiredPath({ flag: "--tasks", env: "M3_TASKS", fallback: path.join(KIT, "dataset/prompts/dev.jsonl"), label: "task split file" });
const GOLD_FILE = requiredPath({ flag: "--gold", env: "M3_GOLD", fallback: path.join(KIT, "dataset/gold/dev.jsonl"), label: "gold split file" });
const CHAT_ENV_FILE = cliValue("--chat-env") ?? process.env.M3_CHAT_ENV ?? null;
// Default: the pre-registered pilot of configs/experiment.json.
const EXPERIMENT_CONFIG = path.join(REPO_ROOT, "docs/java-specialist-devkit-v1/configs/experiment.json");
const PILOT_TASK_IDS = process.env.M3_PILOT
  ? process.env.M3_PILOT.split(",").filter(Boolean)
  : JSON.parse(readFileSync(EXPERIMENT_CONFIG, "utf8")).pilot.task_ids;
const ARMS = ["a2-lexical-block", "a3-rrf-block"];
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

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

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
    const repoRoot = path.join(STAGE, corpus);
    const cacheRoot = liveProjectCacheRoot(OUTPUT, corpus);
    process.stderr.write(`[m3-ab] corpus=${corpus} tasks=${corpusTasks.length}\n`);

    // Both arms' candidate blocks are computed before any chat call, from
    // one READY index snapshot. Fail closed: no dense index, or a failed query
    // embedding, stops the run before model budget is spent.
    const blocks = new Map();
    let denseBuild;
    {
      const session0 = await openImpactSession({ repoRoot, serverJs: SERVER_JS, cacheRoot, env: process.env });
      let resolver = null;
      try {
        await session0.symbol({ query: "java", limit: 1 }).catch(() => undefined);
        const found = existsSync(path.join(cacheRoot, "index.sqlite")) ? [path.join(cacheRoot, "index.sqlite")] : findSqliteFiles(cacheRoot);
        if (found.length === 0) throw new Error(`dense index UNAVAILABLE for ${corpus}: index.sqlite not found under ${cacheRoot}`);
        const dbPath = found[0];
        // The warm-up may return mid-build; keep the server (and its builder)
        // alive until the index is READY.
        await waitForReadyIndex(dbPath);
        const index = new DenseDiscoveryIndex({ provider, facts: readSearchDocumentFacts(repoRoot, dbPath), corpusHash: corpus, repoRoot });
        const declared = await index.build();
        if (declared === 0) throw new Error(`dense index for ${corpus} has no declarations`);
        denseBuild = { dbPath, declarations: declared, ...index.buildCost, indexIdentity: index.providerIndexIdentity };
        resolver = new DeclarationResolver(dbPath);
        for (const task of corpusTasks) {
          const lexicalResult = await session0.symbol({ query: task.query, limit: CANDIDATE_K });
          if (lexicalResult?.error) throw new Error(`java_symbol failed for ${task.id}; no chat call was made: ${lexicalResult.error}`);
          const lexicalIds = lexicalDeclarationIds(lexicalResult, CHANNEL_POOL_K);
          const gate = shouldRunDense({ query: task.query });
          let dense = [];
          if (gate.run) {
            let vector;
            try {
              vector = await provider.embedQuery(task.query);
            } catch (error) {
              throw new Error(`query embedding failed for ${task.id}; no chat call was made: ${error instanceof Error ? error.message : String(error)}`);
            }
            dense = index.rank(vector, { topK: CHANNEL_POOL_K });
          }
          const fused = rrfFuse(lexicalIds, dense.map(entry => entry.declarationId));
          const rendered = {
            "a2-lexical-block": renderEvidence({ declarationIds: lexicalIds, resolver, repoRoot, budget: task.budget }),
            "a3-rrf-block": renderEvidence({ declarationIds: fused.map(entry => entry.declarationId), resolver, repoRoot, budget: task.budget })
          };
          const entry = {
            taskId: task.id,
            gate: gate.reason,
            lexicalIds,
            dense,
            fused,
            arms: Object.fromEntries(ARMS.map(arm => [arm, {
              finalCandidates: rendered[arm].finalCandidates,
              dropped: rendered[arm].dropped,
              block: formatCandidateBlock(rendered[arm].finalCandidates)
            }]))
          };
          blocks.set(task.id, entry);
          await writeFile(path.join(hintsDir, `${task.id}.json`), JSON.stringify(entry, null, 1));
        }
      } finally {
        resolver?.close();
        await session0.close?.().catch(() => undefined);
      }
    }
    corpusCosts.push({ corpus, denseBuild });
    for (const task of corpusTasks) {
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
      for (let repeat = 1; repeat <= REPEATS; repeat += 1) {
        // Seed-balanced arm order per (task, repeat): neither arm always runs first.
        for (const arm of armOrder(ARMS, { seed: SEED, taskId: task.id, repeat })) {
          // R03: one isolated candidate per attempt is the single read/write/
          // test root, and the java_symbol session is opened ON it; after every
          // write the session is re-opened on a fresh index so the next query
          // observes the change.
          const attemptKey = `${task.id}:${arm}:r${repeat}`;
          const attemptStarted = Date.now();
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
                // The only per-arm difference: the content of the candidate block
                // (same renderer, same cap). Prompt, tools and budget are shared.
                taskText: `${baseText}${blocks.get(task.id).arms[arm].block}`,
                projectId: task.corpus,
                requiredContextFiles: [],
                anchor: task.anchors?.[0] ?? { file: "unknown", line: 1, column: 1 }
              },
              arm: "old",
              systemPrompt: EVAL_SYSTEM_PROMPT,
              tools: [EVAL_JAVA_SYMBOL_TOOL, ...toolSet.tools],
              chat: ({ messages, tools, maxTokens }) => chatWithRetry({ messages, tools, maxTokens }),
              maxRounds: MAX_ROUNDS,
              // Eval protocol v1.2: the same received-source ledger for both arms.
              ...(!isRepair && task.budget ? { sourceBudget: task.budget } : {}),
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
            attemptState: attemptStateOf(run),
            elapsedMs: Date.now() - attemptStarted,
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
            finalAnswer: typeof run.finalContent === "string" ? run.finalContent.slice(0, 4000) : ""
          });
          process.stderr.write(`[m3-ab] ${task.id} ${arm} r${repeat} ${scored.taskOutcome}/${scored.answerStatus} success=${scored.taskSuccess}\n`);
        }
      }
    }
  }

  // The live runs are on disk before any scoring step can fail.
  await writeFile(path.join(OUTPUT, "runs-raw.json"), `${JSON.stringify({ protocolArms: ARMS, runs, corpusCosts }, null, 1)}\n`);
  // QA success comes from the frozen kit scorer (payload-attached source,
  // strict answer, task budget); repair success from the frozen judge.
  // Success rate = successes / every scheduled attempt (R02).
  const scorer = scoreWithFrozenKit({ kitRoot: KIT, tasks, runs, arms: ARMS, repeats: REPEATS, outputDir: OUTPUT, model: chatEnv.model });
  if (scorer.kind !== "frozen-kit") {
    await writeFile(path.join(OUTPUT, "results-pack.json"), `${JSON.stringify({ schema: "java-specialist-r11-agent-ab/v1", status: "SCORING_FAILED", scorer, runs }, null, 2)}\n`);
    throw new Error(`frozen kit scoring unavailable: ${scorer.reason} (raw runs kept in runs-raw.json)`);
  }
  // Paired kit comparison on the pilot rows (QA only: repair is judged
  // outside the kit report and summarized per arm).
  const comparison = comparePilotReports({
    kitRoot: KIT,
    baselineReportPath: scorer.reports[ARMS[0]].reportPath,
    candidateReportPath: scorer.reports[ARMS[1]].reportPath,
    pilotIds: PILOT_TASK_IDS,
    outputDir: path.join(OUTPUT, "frozen-score"),
    name: "a2-vs-a3"
  });
  const medians = Object.fromEntries(ARMS.map(arm => [arm, medianPromptTokens(runs.filter(run => run.arm === arm))]));
  const qa = comparison.metrics?.qa_contract_pass ?? null;
  const agentEvidence = {
    qaDelta: qa?.cluster_macro_delta ?? null,
    qaDeltaCI: qa?.cluster_bootstrap_95 ?? null,
    qaDeltaLower: qa?.cluster_bootstrap_95?.[0] ?? null,
    qaClusters: qa?.clusters ?? null,
    promptTokenMedians: medians,
    tokenMedianRatio: medians[ARMS[0]] && medians[ARMS[1]] != null ? medians[ARMS[1]] / medians[ARMS[0]] : null
  };
  const budgets = new Set(tasks.map(task => JSON.stringify(task.budget)));
  if (budgets.size !== 1) throw new Error("pilot tasks do not share one budget");
  const profile = experimentProfile({
    question: "dense mechanism at the agent layer: same model/prompt/tools/budget; candidate block = lexical top-K vs RRF(lexical, dense) top-K",
    arms: ARMS,
    corpus: { mode: "bundled-scoped", corpusHash: scorer.corpusHash, datasetHash: scorer.datasetHash, split: scorer.split, taskIds: PILOT_TASK_IDS },
    representation: {
      searchDocument: "search_doc_text (product index schema v8, java facts revision 4: locator = declaration name)",
      dense: DENSE_REPRESENTATION_VERSION,
      query: QUERY_REPRESENTATION_VERSION
    },
    provider: provider.identityBase(),
    lexical: { tool: "java_symbol", limit: CANDIDATE_K, mode: "auto" },
    budget: JSON.parse([...budgets][0]),
    scorer: { kit: "harness/scoring.py via scoreWithFrozenKit (QA) + frozen repair judge", scorerHash: scorer.scorerHash, corpusMode: "bundled-scoped" },
    agent: {
      model: chatEnv.model,
      systemPromptSha256: sha256(EVAL_SYSTEM_PROMPT),
      tools: ["java_symbol", "native (buildToolSet product)"],
      candidateBlock: "formatCandidateBlock: ranked path:line name, at most K",
      evalProtocol: EVAL_PROTOCOL_VERSION,
      maxRounds: MAX_ROUNDS,
      repeats: REPEATS,
      seed: SEED
    }
  });
  const pack = {
    schema: "java-specialist-r11-agent-ab/v1",
    generatedAt: new Date().toISOString(),
    protocolHash: protocolHash(profile),
    profile,
    backend: redactBackend(chatEnv),
    embedding: { ...provider.costReport() },
    scorer,
    summary: ARMS.map(arm => summarizeArm(runs, arm)),
    comparison,
    agentEvidence,
    perTask: PILOT_TASK_IDS.map(id => ({
      taskId: id,
      ...Object.fromEntries(ARMS.map(arm => [arm, runs.filter(run => run.taskId === id && run.arm === arm).map(run => run.taskSuccess)]))
    })),
    corpusCosts,
    runs
  };
  await writeFile(path.join(OUTPUT, "results-pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ protocolHash: pack.protocolHash, summary: pack.summary, runs: runs.length }, null, 1));
}

main().catch(error => {
  process.stderr.write(`[m3-ab] FAILED: ${error?.stack ?? error}\n`);
  process.exit(1);
});
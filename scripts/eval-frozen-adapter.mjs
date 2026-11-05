#!/usr/bin/env node
// input:  冻结计划行（task×variant×arm×repeat）+ 每行的 AttemptOutcome
//         （状态、严格解析后的答案对象、SOURCE_RECEIVED 映射的 read_events、
//         provider 原始 usage）。
// output: 原冻结 kit 可直接消费的 `java-specialist-results/v1` pack，交给
//         `python -m harness score --input <pack.json> --split all` 由唯一
//         冻结评分器复算；本文件不实现任何第二套答案比较逻辑。
// pos:    R02 的桥接层。kit 的 score 命令对 corpus 指纹/dataset hash 做校验，
//         所以 pack 必须携带与本次运行一致的 run_profile；本 adapter 只负责
//         形状映射与计划完整性（缺行补 MISSING、重复行直接报错），不打分。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const FROZEN_RESULTS_SCHEMA = "java-specialist-results/v1";

/** Attempt states are fixed by the design delta; anything else is a protocol
 * violation, not a runtime outcome. */
export const ATTEMPT_STATES = Object.freeze([
  "COMPLETED",
  "FAILED_RUNTIME",
  "TIMEOUT",
  "MISSING_RESULT",
  "BLOCKED_SETUP"
]);

const STATE_TO_KIT_STATUS = Object.freeze({
  COMPLETED: "OK",
  FAILED_RUNTIME: "ERROR",
  TIMEOUT: "ERROR",
  MISSING_RESULT: "MISSING",
  BLOCKED_SETUP: "BLOCKED"
});

function normalizeToken(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Map an internal usage object to the kit's provider usage row. Unmeasured
 * usage stays null (never 0); partial fields stay null individually. */
export function usageToKitRow(usage) {
  if (!usage || typeof usage !== "object") return null;
  if (usage.status !== "MEASURED" && usage.status !== "PARTIAL") return null;
  const input = normalizeToken(usage.inputTokens ?? usage.promptTokens ?? usage.prompt_tokens);
  const output = normalizeToken(usage.outputTokens ?? usage.completionTokens ?? usage.completion_tokens);
  const cached = normalizeToken(usage.cachedInputTokens);
  if (input === null && output === null && cached === null) return null;
  const row = { source: "provider" };
  if (input !== null) row.input_tokens = input;
  if (output !== null) row.output_tokens = output;
  if (cached !== null) row.cached_input_tokens = cached;
  return row;
}

/** SOURCE_RECEIVED events become the kit's read_events rows. They are
 * minted only from slices of a tool message that was dispatched to the
 * model (payload-attached), never from raw tool output (SOURCE_FETCHED).
 * content_hash is the WHOLE-FILE sha256 the kit validates; the kit also
 * re-reads the corpus and compares the exact text, so a lossy, stale or
 * fabricated slice is rejected there, not here. */
export function sourceReceivedToReadEvents(sourceReceived) {
  return (Array.isArray(sourceReceived) ? sourceReceived : [])
    .filter(event => event?.type === "SOURCE_RECEIVED")
    .map(event => ({
      path: String(event.path).replaceAll("\\", "/"),
      start_line: Number(event.startLine),
      end_line: Number(event.endLine),
      content_hash: String(event.fileContentHash ?? ""),
      text: String(event.text ?? ""),
      origin: event.origin === "explicit_read" ? "explicit_read" : "tool_response"
    }));
}

function plannedKey(key) {
  return `${key.taskId}\u0000${key.variant ?? "primary"}\u0000${key.repeat ?? 0}`;
}

/**
 * Builds the frozen-kit results pack for ONE arm. `plan` is the full frozen
 * attempt key list (taskId + variant, repeat is 0-based like the kit); each
 * planned row appears exactly once in `results` - missing attempts are
 * synthesized as MISSING, duplicate attempts throw (a protocol error that
 * must be fixed, not silently deduplicated).
 */
export function buildFrozenResultsPack({
  plan,
  attempts,
  arm,
  datasetHash,
  corpusHash,
  sourceSha,
  runProfile,
  model
}) {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error("plan must be a nonempty list of frozen attempt keys");
  }
  if (!Array.isArray(attempts)) {
    throw new Error("attempts must be a list");
  }
  if (!runProfile || typeof runProfile !== "object" || !runProfile.evaluation_mode || !runProfile.corpus_hash) {
    throw new Error("runProfile with evaluation_mode and corpus_hash is required");
  }
  const planned = new Set();
  for (const entry of plan) {
    const key = plannedKey({ taskId: entry.taskId ?? entry, variant: entry.variant, repeat: entry.repeat });
    if (planned.has(key)) throw new Error(`duplicate planned attempt: ${key.replaceAll("\u0000", " / ")}`);
    planned.add(key);
  }
  const seen = new Map();
  const results = [];
  for (const attempt of attempts) {
    const key = attempt?.key;
    if (!key || typeof key.taskId !== "string") {
      throw new Error("every attempt needs a key with taskId");
    }
    if (!ATTEMPT_STATES.includes(attempt.state)) {
      throw new Error(`unknown attempt state: ${attempt.state}`);
    }
    const packKey = `${key.taskId}\u0000${key.variant ?? "primary"}\u0000${key.repeat ?? 0}`;
    if (key.arm !== arm) {
      throw new Error(`attempt ${packKey} belongs to arm ${key.arm}, pack is arm ${arm}`);
    }
    if (seen.has(packKey)) {
      throw new Error(`duplicate scheduled attempt: ${packKey}`);
    }
    if (!planned.has(packKey)) {
      throw new Error(`attempt outside the frozen plan: ${packKey.replaceAll("\u0000", " / ")}`);
    }
    seen.set(packKey, true);
    const repeat = Number(key.repeat ?? 0);
    if (!Number.isInteger(repeat) || repeat < 0) {
      throw new Error(`repeat must be a nonnegative integer (kit is 0-based): ${packKey}`);
    }
    const row = {
      task_id: key.taskId,
      variant: key.variant ?? "primary",
      repeat,
      status: STATE_TO_KIT_STATUS[attempt.state],
      regions: Array.isArray(attempt.regions) ? attempt.regions : [],
      candidates: Array.isArray(attempt.candidates) ? attempt.candidates : [],
      // The strictly-parsed answer object (or null). The kit's strict_equal
      // is the only answer comparison; a raw string is a protocol error.
      answer: attempt.answer === undefined ? null : attempt.answer,
      usage: usageToKitRow(attempt.usage),
      read_events: sourceReceivedToReadEvents(attempt.sourceReceived),
      elapsed_ms: Number.isFinite(attempt.elapsedMs) ? attempt.elapsedMs : null
    };
    if (row.answer !== null && (row.answer === null || typeof row.answer !== "object" || Array.isArray(row.answer))) {
      throw new Error(`answer for ${packKey} must be a strictly parsed object or null`);
    }
    results.push(row);
  }
  // Planned rows without an attempt become MISSING rows (stay in the
  // kit's denominator; its summary counts them as invalid, never success).
  for (const entry of plan) {
    const packKey = plannedKey({
      taskId: entry.taskId ?? entry,
      variant: entry.variant,
      repeat: entry.repeat
    });
    if (!seen.has(packKey)) {
      const [taskId, variant = "primary", repeat = 0] = packKey.split("\u0000");
      results.push({
        task_id: taskId,
        variant,
        repeat: Number(repeat),
        status: "MISSING",
        regions: [],
        candidates: [],
        answer: null,
        usage: null,
        read_events: []
      });
    }
  }
  return {
    schema: FROZEN_RESULTS_SCHEMA,
    dataset_hash: datasetHash,
    run_profile: runProfile,
    arm,
    ...(sourceSha ? { source_sha: sourceSha } : {}),
    ...(model ? { model } : {}),
    results
  };
}

/** The scheduled-denominator view the v1.1 release audit reports:
 * successRate = successes / scheduled; conditional accuracy is extra
 * context and can never replace it. `success` must be a boolean or null -
 * truthy objects and Promises are never successes. */
export function scheduledDenominatorSummary({ plan, attempts }) {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error("plan must be a nonempty list of frozen attempt keys");
  }
  if (!Array.isArray(attempts)) {
    throw new Error("attempts must be a list");
  }
  const planned = new Set();
  for (const entry of plan) {
    const key = plannedKey({ taskId: entry.taskId ?? entry, variant: entry.variant, repeat: entry.repeat });
    if (planned.has(key)) throw new Error(`duplicate planned attempt: ${key}`);
    planned.add(key);
  }
  const seen = new Set();
  let successes = 0;
  let scored = 0;
  for (const attempt of attempts) {
    const key = attempt?.key;
    if (!key || typeof key.taskId !== "string") {
      throw new Error("every attempt needs a key with taskId");
    }
    const packKey = `${key.taskId}\u0000${key.variant ?? "primary"}\u0000${key.repeat ?? 0}`;
    if (seen.has(packKey)) throw new Error(`duplicate scheduled attempt: ${packKey}`);
    if (!planned.has(packKey)) throw new Error(`attempt outside the frozen plan: ${packKey}`);
    seen.add(packKey);
    const success = attempt.taskSuccess;
    if (success === true) {
      successes += 1;
      scored += 1;
    } else if (success === false) {
      scored += 1;
    } else if (success !== null) {
      throw new Error(`taskSuccess must be true/false/null for ${packKey}`);
    }
  }
  const scheduled = plan.length;
  return {
    scheduledAttempts: scheduled,
    recordedAttempts: seen.size,
    missingAttempts: scheduled - seen.size,
    measuredAttempts: scored,
    successes,
    // End-to-end: failures, timeouts and missing rows all count against.
    successRate: scheduled > 0 ? successes / scheduled : null,
    // Context only - never reported as the gate metric.
    conditionalAccuracy: scored > 0 ? successes / scored : null
  };
}

/** corpus_mode must say what was actually indexed: the kit's bundled
 * scoped corpora and an external full checkout are never mixed. */
export function runProfileFrom({ corpusHash, corpusMode, variants = "primary", repeats, model, hostId = "eval-frozen-adapter/v1" }) {
  if (corpusMode !== "bundled-scoped" && corpusMode !== "external-full") {
    throw new Error("corpusMode must be bundled-scoped or external-full");
  }
  return {
    corpus_mode: corpusMode,
    corpus_hash: corpusHash,
    variant_set: variants,
    evaluation_mode: "agent",
    repeats,
    cache_state: "per-attempt-retrieval-control",
    model_id: model ?? null,
    host_id: hostId,
    budget_profile: "fixed-160-lines-16000-bytes/v1"
  };
}

/** CLI: node eval-frozen-adapter.mjs --plan plan.json --attempts attempts.json
 *  --arm product --dataset-hash <sha> --corpus-hash <sha> [--corpus-mode bundled-scoped|external-full] [--source-sha <sha>]
 *  [--model <id>] [--repeats N] --output results.json
 * Writes the java-specialist-results/v1 pack ready for the kit scorer. */
async function main(argv = process.argv.slice(2)) {
  const flag = name => {    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const readJson = file => {
    if (!file) throw new Error(`missing ${file}`);
    return JSON.parse(readFileSync(file, "utf8"));
  };
  const plan = await readJson(flag("--plan"));
  const attempts = await readJson(flag("--attempts"));
  const output = flag("--output");
  if (!output) throw new Error("--output is required");
  const pack = buildFrozenResultsPack({
    plan,
    attempts,
    arm: flag("--arm") ?? "product",
    datasetHash: flag("--dataset-hash") ?? "",
    corpusHash: flag("--corpus-hash") ?? "",
    sourceSha: flag("--source-sha"),
    runProfile: runProfileFrom({
      corpusHash: flag("--corpus-hash") ?? "",
      corpusMode: flag("--corpus-mode") ?? "bundled-scoped",
      repeats: Number(flag("--repeats") ?? 1),
      model: flag("--model")
    }),
    model: flag("--model")
  });
  const summary = scheduledDenominatorSummary({ plan, attempts });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, arm: pack.arm, results: pack.results.length, ...summary, hash: createHash("sha256").update(JSON.stringify(pack)).digest("hex") }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().then(code => process.exit(code)).catch(error => {
    console.error(String(error?.stack ?? error));
    process.exit(1);
  });
}
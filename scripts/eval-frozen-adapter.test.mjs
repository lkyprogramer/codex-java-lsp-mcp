#!/usr/bin/env node
// input:  冻结计划行 + AttemptOutcome 行（含 provider usage、SOURCE_RECEIVED
//         事件、严格解析后的答案对象）。
// output: R02 回归锁——唯一评分语义（严格类型/extra/重复键/无 source 不通过）、
//         完整 scheduled 分母（失败/缺失都进入）、usage null 语义、以及
//         adapter 输出能被原冻结 kit scorer 直接复算（端到端，python3 可用时）。
// pos:    纯离线；kit 端到端只跑本地 bundle 语料，无任何网络/模型调用。
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildFrozenResultsPack,
  usageToKitRow,
  sourceReceivedToReadEvents,
  scheduledDenominatorSummary,
  runProfileFrom,
  FROZEN_RESULTS_SCHEMA
} from "./eval-frozen-adapter.mjs";
import {
  scoreQaAnswer,
  scoreRunOutcome,
  assemblePack,
  findDuplicateJsonKeys,
  receivedLineCoverage,
  usageOrNull
} from "./evaluate-java-task.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kitRoot = path.join(repoRoot, "docs", "java-specialist-devkit-v1");

test("E01: strict QA types do not coerce string to boolean or number", () => {
  assert.equal(scoreQaAnswer({ ok: true }, '{"ok":"true"}').correct, false);
  assert.equal(scoreQaAnswer({ n: 1 }, '{"n":"1"}').correct, false);
  assert.equal(scoreQaAnswer({ ok: true }, '{"ok":1}').correct, false, "number is not boolean");
  assert.equal(scoreQaAnswer({ ok: true }, '{"ok":true}').correct, true);
});

test("E02: strict QA rejects extra keys", () => {
  assert.equal(scoreQaAnswer({ ok: true }, '{"ok":true,"extra":0}').correct, false);
  assert.equal(scoreQaAnswer({ a: 1, b: 2 }, '{"b":2,"a":1}').correct, true, "key order is irrelevant");
  assert.equal(scoreQaAnswer({ ok: true }, '{"a":0,"ok":true}').status, "EXTRA_KEYS");
});

test("E03: strict QA rejects duplicate keys, including nested", () => {
  assert.equal(scoreQaAnswer({ ok: true }, '{"ok":false,"ok":true}').correct, false);
  assert.equal(scoreQaAnswer({ ok: true }, '{"ok":true,"ok":false}').status, "INVALID_ANSWER");
  assert.deepEqual(findDuplicateJsonKeys('{"a":{"x":1,"x":2},"a":{"y":3}}'), ["x", "a"]);
  // an escaped quote inside a value must not masquerade as a key; the JSON
  // text under test is: {"s":"k:\" not a key"}  (backslash-quote is an escape)
  const escapedJson = '{' + '"s":"k:' + '\\' + '" not a key' + '"}';
  assert.deepEqual(findDuplicateJsonKeys(escapedJson), []);
  assert.equal(scoreQaAnswer({ s: 'k:"' + ' not a key' }, escapedJson).correct, true);
  // NaN / Infinity literals are rejected (non-finite JSON)
  assert.equal(scoreQaAnswer({ a: 1 }, '{"a":NaN}').correct, false);
  assert.equal(scoreQaAnswer({ a: 1 }, '{"a":Infinity}').correct, false);
  // bounded input length
  assert.equal(scoreQaAnswer({ a: 1 }, `{"a":1,"pad":"${"x".repeat(300_000)}"}`).status, "INVALID_ANSWER");
});

test("E04: contract QA cannot succeed with no received required source", () => {
  const scoreWithoutReceivedEvidence = scoreRunOutcome({
    task: { kind: "qa" },
    goldRow: { answer: { ok: true }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 1 }] },
    run: { stopReason: "MODEL_STOP", finalContent: '{"ok":true}', sourceReceived: [] }
  });
  assert.equal(scoreWithoutReceivedEvidence.taskSuccess, false);
  // partial coverage is not coverage
  const partial = scoreRunOutcome({
    task: { kind: "qa" },
    goldRow: { answer: { ok: true }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 2 }] },
    run: {
      stopReason: "MODEL_STOP",
      finalContent: '{"ok":true}',
      sourceReceived: [{ type: "SOURCE_RECEIVED", path: "A.java", startLine: 1, endLine: 1, text: "t", origin: "explicit_read" }]
    }
  });
  assert.equal(partial.taskSuccess, false);
  assert.equal(partial.answerStatus, "MISSING_REQUIRED_EVIDENCE");
  // full coverage + strict answer succeeds
  const full = scoreRunOutcome({
    task: { kind: "qa" },
    goldRow: { answer: { ok: true }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 1 }] },
    run: {
      stopReason: "MODEL_STOP",
      finalContent: '{"ok":true}',
      sourceReceived: [{ type: "SOURCE_RECEIVED", path: "A.java", startLine: 1, endLine: 1, text: "t", origin: "explicit_read" }]
    }
  });
  assert.equal(full.taskSuccess, true);
  // coverage helper: line-set semantics
  const cov = receivedLineCoverage([{ path: "A.java", start_line: 2, end_line: 3 }], [{ type: "SOURCE_RECEIVED", path: "A.java", startLine: 1, endLine: 2 }]);
  assert.equal(cov.missing.length, 1);
});

test("E05: failed scheduled runs remain in the success-rate denominator", () => {
  const pack = assemblePack({
    status: "MEASURED",
    arms: ["product"],
    repeats: 1,
    runs: [
      { taskId: "a", arm: "product", repeat: 1, taskSuccess: true },
      { taskId: "b", arm: "product", repeat: 1, taskSuccess: null, stopReason: "FAILED_RUNTIME" }
    ]
  });
  assert.equal(pack.denominator, 2);
  assert.equal(pack.taskSuccessRate, 0.5);
  // successes / measured must not masquerade as the gate metric
  assert.equal(pack.conditionalAccuracy, 1);
  // a missing planned row is synthesized and still counts against
  const withPlan = assemblePack({
    status: "MEASURED",
    arms: ["product"],
    repeats: 1,
    runs: [{ taskId: "a", arm: "product", repeat: 1, taskSuccess: true }],
    planned: [
      { taskId: "a", arm: "product", repeat: 1 },
      { taskId: "b", arm: "product", repeat: 1 }
    ]
  });
  assert.equal(withPlan.denominator, 2);
  assert.equal(withPlan.taskSuccessRate, 0.5);
  assert.deepEqual(withPlan.missingResults, ["b"]);
  // zero scheduled rows: no rate, not 0/0
  const empty = assemblePack({ status: "MEASURED", arms: ["product"], repeats: 1, runs: [] });
  assert.equal(empty.taskSuccessRate, null);
  assert.equal(empty.conditionalAccuracy, null);
});

test("E06: wrong QA answer is rejected (positive guard)", () => {
  assert.equal(scoreQaAnswer({ n: 2 }, '{"n":3}').correct, false);
  assert.equal(scoreQaAnswer({ n: 2 }, '{"n":2}').correct, true);
  // array answer is not an object answer
  assert.equal(scoreQaAnswer({ n: 2 }, "[2]").status, "INVALID_ANSWER");
  // markdown fence is a format failure under strict JSON (never stripped)
  assert.equal(scoreQaAnswer({ n: 2 }, "```json\n{\"n\":2}\n```").status, "INVALID_ANSWER");
});

test("repair verdicts: only the frozen judge's validatedSuccess === true is a success", () => {
  const base = { task: { kind: "repair" }, goldRow: null, run: { stopReason: "MODEL_STOP", finalContent: '{"patchApplied":true}' } };
  assert.equal(scoreRunOutcome({ ...base, repairVerdict: { state: "VALIDATED_SUCCESS", validatedSuccess: true } }).taskSuccess, true);
  assert.equal(scoreRunOutcome({ ...base, repairVerdict: { state: "TEST_FAILED", validatedSuccess: "yes" } }).taskSuccess, false);
  assert.equal(scoreRunOutcome({ ...base, repairVerdict: { state: "TEST_FAILED", validatedSuccess: false } }).taskSuccess, false);
  assert.equal(scoreRunOutcome({ ...base, repairVerdict: { state: "TIMEOUT", validatedSuccess: false } }).taskSuccess, false, "a hanging candidate is a failed candidate");
  const promise = scoreRunOutcome({ ...base, repairVerdict: Promise.resolve({ validatedSuccess: true }) });
  assert.equal(promise.taskSuccess, null);
  assert.equal(promise.answerStatus, "INVALID_JUDGE_VERDICT");
  for (const state of ["BLOCKED_ENV", "BLOCKED_SETUP", "JUDGE_ERROR"]) {
    const blocked = scoreRunOutcome({ ...base, repairVerdict: { state, validatedSuccess: false } });
    assert.equal(blocked.taskSuccess, null, `${state} is unmeasured, not a failure`);
    assert.equal(blocked.taskOutcome, "UNMEASURED");
  }
  const noJudge = scoreRunOutcome({ ...base });
  assert.equal(noJudge.taskOutcome, "UNMEASURED");
  assert.equal(noJudge.taskSuccess, null);
  // the candidate tree is judged even when the agent loop itself failed
  const failedLoop = scoreRunOutcome({ ...base, run: { stopReason: "FAILED_RUNTIME" }, repairVerdict: { state: "VALIDATED_SUCCESS", validatedSuccess: true } });
  assert.equal(failedLoop.taskSuccess, true);
});

test("usage: unknown stays null, provider raw preserved with hash", () => {
  assert.equal(usageOrNull(undefined), null);
  assert.equal(usageOrNull({ status: "UNMEASURED" }), null);
  const partial = usageOrNull({
    status: "PARTIAL",
    promptTokens: 100,
    completionTokens: null,
    rawUsage: { prompt_tokens: 100 },
    rawUsageHash: "abc"
  });
  assert.equal(partial.inputTokens, 100);
  assert.equal(partial.outputTokens, null, "missing field is null, never 0");
  assert.deepEqual(partial.rawUsage, { prompt_tokens: 100 });
  assert.equal(partial.rawUsageHash, "abc");
});

test("adapter: usage mapping to kit rows", () => {
  assert.equal(usageToKitRow(null), null);
  assert.equal(usageToKitRow({ status: "UNMEASURED" }), null);
  assert.deepEqual(usageToKitRow({ status: "PARTIAL", promptTokens: 5, completionTokens: null }), {
    source: "provider",
    input_tokens: 5
  });
  assert.deepEqual(usageToKitRow({ status: "MEASURED", inputTokens: 1, outputTokens: 2, cachedInputTokens: null }), {
    source: "provider",
    input_tokens: 1,
    output_tokens: 2
  });
});

test("adapter: only SOURCE_RECEIVED rows become kit read_events, with the file hash", () => {
  const events = sourceReceivedToReadEvents([
    { type: "SOURCE_RECEIVED", path: "a\\B.java", startLine: 3, endLine: 5, contentHash: "slice", fileContentHash: "file", text: "t", origin: "explicit_read" },
    { type: "SOURCE_RECEIVED", path: "C.java", startLine: 1, endLine: 1, contentHash: "h2", fileContentHash: "f2", text: "u", origin: "tool_response" },
    { type: "SOURCE_FETCHED", path: "D.java", startLine: 1, endLine: 1, text: "raw only" },
    { type: "MODEL_PAYLOAD_ATTACHED", path: "ignored" }
  ]);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { path: "a/B.java", start_line: 3, end_line: 5, content_hash: "file", text: "t", origin: "explicit_read" });
  assert.equal(events[1].origin, "tool_response");
});

test("adapter: full plan - missing synthesized as MISSING, duplicates throw", () => {
  const plan = [
    { taskId: "T-A", variant: "primary", repeat: 0 },
    { taskId: "T-B", variant: "primary", repeat: 0 }
  ];
  const profile = runProfileFrom({ corpusHash: "ch", corpusMode: "bundled-scoped", repeats: 1 });
  assert.throws(() => runProfileFrom({ corpusHash: "ch", repeats: 1 }), /corpusMode/);
  const pack = buildFrozenResultsPack({
    plan,
    arm: "product",
    datasetHash: "dh",
    corpusHash: "ch",
    runProfile: profile,
    attempts: [{
      key: { taskId: "T-A", variant: "primary", arm: "product", repeat: 0 },
      state: "COMPLETED",
      taskSuccess: true,
      answer: { ok: true },
      usage: { status: "MEASURED", inputTokens: 10, outputTokens: 4 },
      sourceReceived: [{ type: "SOURCE_RECEIVED", path: "A.java", startLine: 1, endLine: 2, contentHash: "h", text: "t", origin: "explicit_read" }]
    }]
  });
  assert.equal(pack.schema, FROZEN_RESULTS_SCHEMA);
  assert.equal(pack.results.length, 2);
  const missing = pack.results.find(r => r.task_id === "T-B");
  assert.equal(missing.status, "MISSING");
  assert.equal(missing.answer, null);
  assert.equal(missing.usage, null);
  const dup = {
    key: { taskId: "T-A", variant: "primary", arm: "product", repeat: 0 },
    state: "COMPLETED",
    taskSuccess: true,
    answer: null,
    usage: null,
    sourceReceived: []
  };
  assert.throws(
    () => buildFrozenResultsPack({ plan, arm: "product", datasetHash: "dh", corpusHash: "ch", runProfile: profile, attempts: [dup, dup] }),
    /duplicate scheduled attempt/
  );
  assert.throws(
    () => buildFrozenResultsPack({ plan, arm: "control", datasetHash: "dh", corpusHash: "ch", runProfile: profile, attempts: [dup] }),
    /belongs to arm/
  );
  const stray = { ...dup, key: { taskId: "T-Z", variant: "primary", arm: "product", repeat: 0 } };
  assert.throws(
    () => buildFrozenResultsPack({ plan, arm: "product", datasetHash: "dh", corpusHash: "ch", runProfile: profile, attempts: [stray] }),
    /outside the frozen plan/
  );
  assert.throws(
    () => buildFrozenResultsPack({ plan: [...plan, plan[0]], arm: "product", datasetHash: "dh", corpusHash: "ch", runProfile: profile, attempts: [] }),
    /duplicate planned attempt/
  );
});

test("adapter: scheduled denominator summary matches the gate metric", () => {
  const plan = [
    { taskId: "T-A", variant: "primary", repeat: 0 },
    { taskId: "T-B", variant: "primary", repeat: 0 }
  ];
  const attempts = [
    { key: { taskId: "T-A", variant: "primary", arm: "product", repeat: 0 }, state: "COMPLETED", taskSuccess: true, usage: null, sourceReceived: [] },
    { key: { taskId: "T-B", variant: "primary", arm: "product", repeat: 0 }, state: "FAILED_RUNTIME", taskSuccess: null, usage: null, sourceReceived: [] }
  ];
  const summary = scheduledDenominatorSummary({ plan, attempts });
  assert.equal(summary.scheduledAttempts, 2);
  assert.equal(summary.successes, 1);
  assert.equal(summary.successRate, 1 / 2);
  assert.throws(() => scheduledDenominatorSummary({ plan, attempts: [{ ...attempts[0], taskSuccess: { truthy: true } }] }), /must be true\/false\/null/);
  // an attempt outside the plan can never inflate the rate above 1
  assert.throws(() => scheduledDenominatorSummary({ plan: [plan[0]], attempts }), /outside the frozen plan/);
});

// The authoritative check: the pack the ADAPTER builds (from received
// slices produced by the real read tool + model-boundary serializer) is
// scored by the ORIGINAL frozen kit CLI. A required line that the budget cut
// out of the model payload must not be credited. Needs python3 (else
// BLOCKED_ENV skip).
test("adapter end-to-end: frozen kit CLI scores the adapter's own pack", async t => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("python3 unavailable (BLOCKED_ENV)");
    return;
  }
  const { buildToolSet, createAttemptWorkspace } = await import("./eval-native-tools.mjs");
  const { serializeModelToolResult } = await import("./eval-tool-wire.mjs");
  const { createRecorder, loadTaskFile, loadGoldFile } = await import("./evaluate-java-task.mjs");
  const { writeFileSync, rmSync } = await import("node:fs");
  const dataset = path.join(kitRoot, "dataset");
  const task = loadTaskFile(path.join(dataset, "prompts", "dev.jsonl")).find(row => row.id === "JSB-PAYMENTS-01");
  const gold = loadGoldFile(path.join(dataset, "gold", "dev.jsonl")).get(task.id);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "eval-frozen-adapter-"));
  try {
    const candidate = createAttemptWorkspace(path.join(dataset, "corpora", task.corpus), "e2e", tmp);
    const tools = buildToolSet("control", "qa", { candidateRoot: candidate });
    const evidencePath = gold.required_evidence[0].path;
    const lastRequired = Math.max(...gold.required_evidence.map(item => item.end_line));
    const read = await tools.invoke("read", { path: evidencePath, startLine: 1, maxLines: lastRequired });
    const attemptFor = (repeat, maxBytes) => {
      const recorder = createRecorder();
      const serialized = serializeModelToolResult("read", read, { maxBytes });
      recorder.recordModelDelivery({ callId: `c${repeat}`, toolName: "read", contentHash: serialized.modelPayloadHash, payloadBytes: 0, slices: serialized.slices });
      return {
        key: { taskId: task.id, variant: "primary", arm: "control", repeat },
        state: "COMPLETED",
        answer: gold.answer,
        usage: null,
        sourceReceived: recorder.events()
      };
    };
    const hashes = JSON.parse(execFileSync("python3", ["-c",
      "import json,sys;from pathlib import Path;from harness.dataset import dataset_digest;from harness.cli import corpus_fingerprint;d=Path(sys.argv[1]);print(json.dumps({'dataset':dataset_digest(d),'corpus':corpus_fingerprint(d/'corpora')}))",
      dataset], { cwd: kitRoot, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
    // repeat 0: whole window delivered; repeat 1: a budget that cuts the tail.
    const pack = buildFrozenResultsPack({
      plan: [{ taskId: task.id, variant: "primary", repeat: 0 }, { taskId: task.id, variant: "primary", repeat: 1 }],
      attempts: [attemptFor(0, 32768), attemptFor(1, 600)],
      arm: "control",
      datasetHash: hashes.dataset,
      runProfile: runProfileFrom({ corpusHash: hashes.corpus, corpusMode: "bundled-scoped", repeats: 2 })
    });
    const packPath = path.join(tmp, "pack.json");
    const reportPath = path.join(tmp, "report.json");
    writeFileSync(packPath, JSON.stringify(pack), "utf8");
    execFileSync("python3", ["-m", "harness", "--dataset", dataset, "score", "--input", packPath, "--split", "dev", "--output", reportPath], { cwd: kitRoot, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const row = repeat => report.rows.find(r => r.task_id === task.id && r.repeat === repeat);
    assert.deepEqual(row(0).errors, [], "kit must accept the adapter's read receipts byte-exactly");
    assert.equal(row(0).qa_contract_pass, true);
    assert.equal(row(1).received_evidence_complete, false, "lines cut from the model payload are not received");
    assert.equal(row(1).qa_contract_pass, false);
    assert.equal(report.rows.filter(r => r.status === "MISSING").length, 2 * 23, "the rest of the dev split stays in the denominator");
    assert.match(report.scorer_hash, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

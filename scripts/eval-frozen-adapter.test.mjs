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
      sourceReceived: [{ path: "A.java", startLine: 1, endLine: 1, text: "t", origin: "explicit_read" }]
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
      sourceReceived: [{ path: "A.java", startLine: 1, endLine: 1, text: "t", origin: "explicit_read" }]
    }
  });
  assert.equal(full.taskSuccess, true);
  // coverage helper: line-set semantics
  const cov = receivedLineCoverage([{ path: "A.java", start_line: 2, end_line: 3 }], [{ path: "A.java", startLine: 1, endLine: 2 }]);
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

test("repair verdicts: only passed === true is a success", () => {
  const base = { task: { kind: "repair" }, goldRow: null, run: { stopReason: "MODEL_STOP", finalContent: "{}" } };
  assert.equal(scoreRunOutcome({ ...base, repairTester: () => ({ passed: true }) }).taskSuccess, true);
  assert.equal(scoreRunOutcome({ ...base, repairTester: () => ({ passed: "yes" }) }).taskSuccess, false);
  assert.equal(scoreRunOutcome({ ...base, repairTester: () => ({ passed: Promise.resolve(true) }) }).taskSuccess, false);
  assert.equal(scoreRunOutcome({ ...base, repairTester: () => ({}) }).taskSuccess, false);
  const noJudge = scoreRunOutcome({ ...base, repairTester: undefined });
  assert.equal(noJudge.taskOutcome, "UNMEASURED");
  assert.equal(noJudge.taskSuccess, null);
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

test("adapter: SOURCE_RECEIVED rows become kit read_events", () => {
  const events = sourceReceivedToReadEvents([
    { type: "SOURCE_RECEIVED", path: "a\\B.java", startLine: 3, endLine: 5, contentHash: "h", text: "t", origin: "explicit_read" },
    { type: "SOURCE_RECEIVED", path: "C.java", startLine: 1, endLine: 1, contentHash: "h2", text: "u", origin: "tool_response" },
    { type: "MODEL_TOOL_DELIVERED", path: "ignored" }
  ]);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { path: "a/B.java", start_line: 3, end_line: 5, content_hash: "h", text: "t", origin: "explicit_read" });
  assert.equal(events[1].origin, "tool_response");
});

test("adapter: full plan - missing synthesized as MISSING, duplicates throw", () => {
  const plan = [
    { taskId: "T-A", variant: "primary", repeat: 0 },
    { taskId: "T-B", variant: "primary", repeat: 0 }
  ];
  const profile = runProfileFrom({ corpusHash: "ch", repeats: 1 });
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
});

// The authoritative check: the adapter's pack must be accepted and re-scored
// by the ORIGINAL frozen kit scorer (score_pack, the same function
// `python -m harness score` runs). Requires python3 + the staged kit;
// skipped as BLOCKED_ENV when absent.
test("adapter end-to-end: kit scorer re-scores the adapter pack", async t => {
  let python = "python3";
  try {
    execFileSync(python, ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("python3 unavailable (BLOCKED_ENV)");
    return;
  }
  if (!existsSync(path.join(kitRoot, "harness"))) {
    t.skip("frozen kit not staged (BLOCKED_ENV)");
    return;
  }
  const { execFileSync: runPy } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "eval-frozen-adapter-"));
  const params = JSON.stringify({
    kitRoot,
    datasetDir: path.join(kitRoot, "dataset"),
    tmp
  });
  writeFileSync(path.join(tmp, "params.json"), params, "utf8");
  const buildScript = `
import json, sys
from pathlib import Path
params = json.loads(Path(sys.argv[1]).read_text())
sys.path.insert(0, params["kitRoot"])
from harness import cli
from harness.dataset import load_dataset
dataset_path = Path(params["datasetDir"])
ds = load_dataset(dataset_path)
corpus_root = (Path(params["kitRoot"]) / "dataset" / "corpora").resolve()
task = next(t for t in ds["tasks"] if t["kind"] == "qa" and t["split"] == "dev")
gold = ds["gold"][task["id"]]
events = []
import hashlib
for r in gold["required_evidence"]:
    p = corpus_root / task["corpus"] / r["path"]
    raw = p.read_bytes(); raw.decode("utf-8")
    lines = raw.splitlines(keepends=True)
    events.append({"path": r["path"], "start_line": 1, "end_line": len(lines),
                   "content_hash": hashlib.sha256(raw).hexdigest(),
                   "text": b"".join(lines).decode("utf-8"), "origin": "explicit_read"})
pack = {"schema": "java-specialist-results/v1",
        "dataset_hash": cli.dataset_digest(Path(params["datasetDir"])),
        "run_profile": {"corpus_mode": "bundled-scoped", "corpus_hash": cli.corpus_fingerprint(corpus_root), "variant_set": "primary",
                        "evaluation_mode": "structured-qa", "repeats": 1, "cache_state": "per-attempt-retrieval-control",
                        "model_id": None, "host_id": "eval-frozen-adapter/v1"},
        "arm": "product",
        "results": [{"task_id": task["id"], "variant": "primary", "repeat": 0, "status": "OK",
                     "regions": [], "candidates": [], "answer": gold["answer"],
                     "usage": None, "read_events": events, "elapsed_ms": 42}]}
(Path(params["tmp"]) / "results.json").write_text(json.dumps(pack, ensure_ascii=False))
rep = cli.score_pack(dataset_path, corpus_root, pack, "dev")
row = rep["rows"][0]
unattempted = sum(1 for r in rep["rows"] if r["status"] == "MISSING")
print(json.dumps({"qa": row["qa_contract_pass"], "valid": row["valid"],
                  "received_complete": row["received_evidence_complete"],
                  "unattempted": unattempted, "scorer_hash": rep["scorer_hash"]}))
`;
  const out = runPy(python, ["-c", buildScript, path.join(tmp, "params.json")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
  const parsed = JSON.parse(out);
  assert.equal(parsed.valid, true, "kit must accept the adapter-shaped row");
  assert.equal(parsed.qa, true, "original scorer must mark a correct-and-received QA as passing");
  assert.equal(parsed.received_complete, true);
  assert.equal(parsed.unattempted, 23, "split-dev universe stays in the denominator");
  assert.match(parsed.scorer_hash, /^[0-9a-f]{64}$/);
});

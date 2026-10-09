// input: evaluate-java-task.mjs unit surface: backend detection, the
//         BLOCKED_AUTH pack, SOURCE_RECEIVED recording from tool results,
//         Q-track answer scoring, and the recorded-run replay invariants.
// output: RED→GREEN evidence for the M2 T09 host recorder adapter. The live
//         agent loop itself is BLOCKED_AUTH on this host (no model
//         credentials), so these tests pin the recorder/scoring semantics
//         that a live run will consume.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assemblePack,
  backendDeficit,
  createRecorder,
  detectBackend,
  EVAL_PACK_SCHEMA_VERSION,
  extractSourceEvents,
  loadTaskFile,
  loadGoldFile,
  main,
  scoreQaAnswer,
  scoreRunOutcome
} from "./evaluate-java-task.mjs";

test("backend detection: no credentials is null, OpenAI triple is openai-api, codex cli wins otherwise", () => {
  assert.equal(detectBackend({}, { hasCodexCli: () => false }), null);
  assert.equal(detectBackend({ OPENAI_API_KEY: "k" }, { hasCodexCli: () => false }), null);
  const api = detectBackend({
    OPENAI_API_KEY: "k",
    OPENAI_BASE_URL: "https://api.example/v1",
    OPENAI_MODEL: "gpt-test"
  }, { hasCodexCli: () => false });
  assert.deepEqual(api, { kind: "openai-api", model: "gpt-test", baseUrl: "https://api.example/v1" });
  const cli = detectBackend({}, { hasCodexCli: () => true });
  assert.equal(cli.kind, "codex-cli");
});

test("backendDeficit lists exactly the missing authorizations", () => {
  const missing = backendDeficit({}, { hasCodexCli: () => false });
  assert.ok(missing.includes("OPENAI_API_KEY"));
  assert.ok(missing.includes("OPENAI_BASE_URL"));
  assert.ok(missing.includes("OPENAI_MODEL"));
  assert.ok(missing.some(item => item.includes("codex")));
  assert.deepEqual(backendDeficit({
    OPENAI_API_KEY: "k",
    OPENAI_BASE_URL: "https://api.example/v1",
    OPENAI_MODEL: "m"
  }, { hasCodexCli: () => false }), []);
  assert.deepEqual(backendDeficit({}, { hasCodexCli: () => true }), [], "codex CLI alone satisfies the deficit");
});

test("BLOCKED_AUTH pack: every task UNMEASURED, null success, null usage, exit 0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-blocked-"));
  try {
    await mkdir(path.join(dir, "tasks"), { recursive: true });
    const tasksFile = path.join(dir, "tasks", "dev.jsonl");
    writeFileSync(tasksFile, [
      JSON.stringify({ id: "T-A", corpus: "c1", kind: "qa", query: "q1" }),
      JSON.stringify({ id: "T-B", corpus: "c2", kind: "repair", query: "q2" })
    ].join("\n") + "\n", "utf8");
    const output = path.join(dir, "out");
    const env = { MXBAI_API_KEY: "x" }; // a key for another provider is not a backend
    const code = await main([
      "--tasks", tasksFile,
      "--output", output,
      "--arms", "product,control",
      "--repeats", "3"
    ], env);
    assert.equal(code, 0);
    const pack = JSON.parse(await readFileSync(path.join(output, "results-pack.json"), "utf8"));
    assert.equal(pack.schemaVersion, EVAL_PACK_SCHEMA_VERSION);
    assert.equal(pack.status, "BLOCKED_AUTH");
    assert.ok(pack.blockedReasons.length > 0);
    // 2 tasks x 2 arms x 3 repeats = 12 denominator entries, all UNMEASURED
    assert.equal(pack.denominator, 12);
    // Gate metric is successes / scheduled: zero successes over 12 scheduled.
    assert.equal(pack.taskSuccessRate, 0);
    assert.equal(pack.conditionalAccuracy, null, "nothing measured: no conditional rate");
    for (const runPack of pack.packs) {
      assert.equal(runPack.taskOutcome, "UNMEASURED");
      assert.equal(runPack.taskSuccess, null);
      assert.equal(runPack.usage, null, "missing usage stays null; never bytes/4");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SOURCE_FETCHED: java_symbol preview becomes a raw tool_response event with sha256 + range", () => {
  const discovery = JSON.stringify({
    schemaVersion: "java-discovery/v1",
    candidates: [
      {
        declaration: {
          name: "OrderService",
          relativePath: "src/main/java/x/OrderService.java",
          contentHash: "abc",
          signature: "void submit()",
          selection: { line: 10, column: 5 }
        },
        preview: "public void submit() {\n    queue.offer(order);\n}\n",
        previewKind: "source",
        evidenceRange: { startLine: 10, endLine: 12 }
      }
    ]
  });
  const events = extractSourceEvents({
    callId: "call-1",
    toolName: "java_symbol",
    result: [{ type: "text", text: discovery }]
  });
  assert.equal(events.length, 1);
  const event = events[0];
  // Raw tool output is FETCHED, never RECEIVED: only a payload-attached
  // slice (recordModelDelivery) can be credited as received.
  assert.equal(event.type, "SOURCE_FETCHED");
  assert.equal(event.fileContentHash, "abc");
  assert.equal(event.callId, "call-1");
  assert.equal(event.path, "src/main/java/x/OrderService.java");
  assert.equal(event.origin, "tool_response");
  assert.equal(event.startLine, 10);
  assert.equal(event.endLine, 12);
  assert.equal(event.contentHash, createHash("sha256").update("public void submit() {\n    queue.offer(order);\n}\n", "utf8").digest("hex"));
});

test("SOURCE_FETCHED: the read tool is explicit_read, no phantom line; summaries create no event", () => {
  const readEvents = extractSourceEvents({
    callId: "call-2",
    toolName: "read",
    result: { path: "src/main/java/x/Payment.java", text: "line1\nline2\nline3", startLine: 4 }
  });
  assert.equal(readEvents.length, 1);
  assert.equal(readEvents[0].origin, "explicit_read");
  assert.equal(readEvents[0].startLine, 4);
  assert.equal(readEvents[0].endLine, 6);
  // a trailing newline does not create a phantom line
  const trailing = extractSourceEvents({ callId: "c", toolName: "read", result: { path: "A.java", text: "a\nb\n", startLine: 1 } });
  assert.equal(trailing[0].endLine, 2);

  // A model-facing summary that merely names a path is not source.
  const summary = extractSourceEvents({
    callId: "call-3",
    toolName: "java_symbol",
    result: [{ type: "text", text: "Found OrderService in src/main/java/x/OrderService.java (summary)" }]
  });
  assert.equal(summary.length, 0);

  // A discovery payload without a preview carries locator evidence only.
  const noPreview = extractSourceEvents({
    callId: "call-4",
    toolName: "java_symbol",
    result: JSON.stringify({
      schemaVersion: "java-discovery/v1",
      candidates: [{ declaration: { relativePath: "a/B.java", selection: { line: 1, column: 1 } } }]
    })
  });
  assert.equal(noPreview.length, 0);
});

test("SOURCE_FETCHED: a pre-parsed discovery payload (live session path) still records", () => {
  const payload = {
    schemaVersion: "java-discovery/v1",
    candidates: [{
      declaration: { relativePath: "a/B.java", selection: { line: 3, column: 1 } },
      preview: "class B {\n}",
      previewKind: "source",
      evidenceRange: { startLine: 3, endLine: 4 }
    }]
  };
  const events = extractSourceEvents({ callId: "call-9", toolName: "java_symbol", result: payload });
  assert.equal(events.length, 1);
  assert.equal(events[0].contentHash, createHash("sha256").update("class B {\n}", "utf8").digest("hex"));
  assert.equal(events[0].origin, "tool_response");
});

test("Q-track scoring: strict JSON, exact keys, no partial credit", () => {
  const gold = { storageType: "Set<String>", method: "accept" };
  assert.equal(scoreQaAnswer(gold, JSON.stringify(gold)).status, "CORRECT");
  assert.equal(scoreQaAnswer(gold, JSON.stringify(gold)).correct, true);
  assert.equal(scoreQaAnswer(gold, JSON.stringify({ storageType: "List<String>", method: "accept" })).status, "WRONG_ANSWER");
  assert.equal(scoreQaAnswer(gold, JSON.stringify({ storageType: "Set<String>" })).status, "INCOMPLETE_ANSWER");
  assert.equal(scoreQaAnswer(gold, "not json").status, "INVALID_ANSWER");
  assert.equal(scoreQaAnswer(gold, "[]").status, "INVALID_ANSWER");
  // R02: markdown fences are a format failure under strict JSON - never
  // stripped, never a pass.
  assert.equal(scoreQaAnswer(gold, "```json\n" + JSON.stringify(gold) + "\n```").status, "INVALID_ANSWER");
  // R02: the answer key set comes from frozen gold; extra keys are rejected.
  assert.equal(scoreQaAnswer(gold, JSON.stringify({ ...gold, extra: 1 })).status, "EXTRA_KEYS");
});

test("scoreRunOutcome: failures stay UNMEASURED in the denominator; qa outcomes are external", () => {
  const task = { id: "T-A", kind: "qa" };
  const failed = scoreRunOutcome({ task, goldRow: { answer: { a: "1" } }, run: { stopReason: "FAILED_RUNTIME", finalContent: "" } });
  assert.equal(failed.taskOutcome, "UNMEASURED");
  assert.equal(failed.taskSuccess, null);
  const qaGood = scoreRunOutcome({
    task,
    goldRow: { answer: { a: "1" }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 1 }] },
    run: {
      stopReason: "MODEL_STOP",
      finalContent: JSON.stringify({ a: "1" }),
      sourceReceived: [{ type: "SOURCE_RECEIVED", path: "A.java", startLine: 1, endLine: 1, text: "t", origin: "explicit_read" }]
    }
  });
  assert.equal(qaGood.taskOutcome, "MEASURED");
  assert.equal(qaGood.taskSuccess, true);
  // the same window merely FETCHED (never attached to a request) is no evidence
  const qaFetchedOnly = scoreRunOutcome({
    task,
    goldRow: { answer: { a: "1" }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 1 }] },
    run: {
      stopReason: "MODEL_STOP",
      finalContent: JSON.stringify({ a: "1" }),
      sourceReceived: [{ type: "SOURCE_FETCHED", path: "A.java", startLine: 1, endLine: 1, text: "t", origin: "explicit_read" }]
    }
  });
  assert.equal(qaFetchedOnly.taskSuccess, false);
  assert.equal(qaFetchedOnly.answerStatus, "MISSING_REQUIRED_EVIDENCE");
  // received source over the task budget fails, as in the frozen kit
  const qaOverBudget = scoreRunOutcome({
    task: { ...task, budget: { max_lines: 1, max_bytes: 16000 } },
    goldRow: { answer: { a: "1" }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 1 }] },
    run: {
      stopReason: "MODEL_STOP",
      finalContent: JSON.stringify({ a: "1" }),
      sourceReceived: [{ type: "SOURCE_RECEIVED", path: "A.java", startLine: 1, endLine: 2, text: "t\nu\n", origin: "explicit_read" }]
    }
  });
  assert.equal(qaOverBudget.taskSuccess, false);
  assert.equal(qaOverBudget.answerStatus, "RECEIVED_OVER_BUDGET");
  // correct answer without the required frozen source is NOT a success
  const qaNoEvidence = scoreRunOutcome({
    task,
    goldRow: { answer: { a: "1" }, required_evidence: [{ path: "A.java", start_line: 1, end_line: 1 }] },
    run: { stopReason: "MODEL_STOP", finalContent: JSON.stringify({ a: "1" }), sourceReceived: [] }
  });
  assert.equal(qaNoEvidence.taskSuccess, false);
  assert.equal(qaNoEvidence.answerStatus, "MISSING_REQUIRED_EVIDENCE");
  // gold without a frozen answer is a protocol gap, not a measured failure
  const qaNoGold = scoreRunOutcome({ task, goldRow: null, run: { stopReason: "MODEL_STOP", finalContent: "{}" } });
  assert.equal(qaNoGold.taskOutcome, "UNMEASURED");
  assert.equal(qaNoGold.taskSuccess, null);
  const repairWithoutJudge = scoreRunOutcome({
    task: { id: "T-B", kind: "repair" },
    goldRow: null,
    run: { stopReason: "MODEL_STOP", finalContent: "{}" }
  });
  assert.equal(repairWithoutJudge.taskOutcome, "UNMEASURED");
  const repairValidated = scoreRunOutcome({
    task: { id: "T-B", kind: "repair" },
    goldRow: null,
    run: { stopReason: "MODEL_STOP", finalContent: '{"patchApplied":false}' },
    repairVerdict: { state: "VALIDATED_SUCCESS", validatedSuccess: true }
  });
  assert.equal(repairValidated.taskSuccess, true, "the frozen judge, not patchApplied, decides");
});

test("recorded-run replay: pack invariants hold for a mix of measured and failed runs", () => {
  const pack = assemblePack({
    status: "MEASURED",
    backend: { kind: "openai-api", model: "gpt-test" },
    datasetHash: "dh",
    arms: ["product", "control"],
    repeats: 1,
    runs: [
      { taskId: "T-A", arm: "product", repeat: 1, taskOutcome: "MEASURED", taskSuccess: true, usage: { status: "MEASURED", promptTokens: 100, completionTokens: 20 } },
      { taskId: "T-A", arm: "control", repeat: 1, taskOutcome: "MEASURED", taskSuccess: false, usage: { status: "UNMEASURED" } },
      { taskId: "T-B", arm: "product", repeat: 1, taskOutcome: "UNMEASURED", taskSuccess: null, timedOut: true, usage: undefined }
    ]
  });
  assert.equal(pack.denominator, 3, "timeout/error runs stay in the denominator");
  assert.equal(pack.taskSuccessRate, 1 / 3, "gate metric is successes / scheduled");
  assert.equal(pack.conditionalAccuracy, 0.5, "conditional accuracy is context, not the gate");
  assert.equal(pack.measuredAttempts, 2);
  assert.equal(pack.packs[0].usage.inputTokens, 100);
  assert.equal(pack.packs[0].usage.outputTokens, 20);
  assert.equal(pack.packs[1].usage, null, "UNMEASURED usage stays null");
  assert.equal(pack.packs[2].usage, null);
  assert.equal(pack.packs[2].timedOut, true);
});

test("task and gold loaders read the frozen jsonl pair", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-load-"));
  try {
    const tasksFile = path.join(dir, "dev.jsonl");
    const goldFile = path.join(dir, "gold.jsonl");
    writeFileSync(tasksFile, JSON.stringify({ id: "T-A", corpus: "c1", kind: "qa", query: "q" }) + "\n", "utf8");
    writeFileSync(goldFile, JSON.stringify({ id: "T-A", answer: { a: "1" } }) + "\n", "utf8");
    const tasks = loadTaskFile(tasksFile);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, "T-A");
    const gold = loadGoldFile(goldFile);
    assert.deepEqual(gold.get("T-A").answer, { a: "1" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
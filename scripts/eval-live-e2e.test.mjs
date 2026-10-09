// input:  evaluate-java-task main() 的 live 分支：本地脚本化 OpenAI 兼容 HTTP
//         服务（无外网、无模型）+ 真实 dist/server.js MCP + 原生工具 + 冻结 kit
//         （python3 -m harness score / repair）。
// output: R01–R04 端到端回归锁——完整计划分母不丢行、只按随请求发出的源码
//         计分、kit 为 QA 唯一权威评分、repair 由冻结 judge 判定 candidate 树、
//         写入后下一次 java_symbol 观察到修改、tool_calls 后紧跟 tool 回复。
// pos:    scripted sentinel：脚本扮演 agent 只为验证闭环；它不是 LIVE 样本，
//         通过不代表任何模型有效性。缺 dist/javac/python3 时按 BLOCKED_ENV 跳过。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { armOrder, buildPlannedAttempts, main } from "./evaluate-java-task.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kitRoot = path.join(repoRoot, "docs", "java-specialist-release-audit-v1.1", "baseline-kit");
const dataset = path.join(kitRoot, "dataset");
const serverJs = path.join(repoRoot, "dist", "server.js");
const SERVICE = "src/main/java/lab/payments/PaymentService.java";

test("buildPlannedAttempts is one flat row per task x arm x repeat", () => {
  const planned = buildPlannedAttempts([{ id: "T1" }, { id: "T2" }], ["product", "control"], 2);
  assert.equal(planned.length, 8);
  assert.ok(planned.every(row => !Array.isArray(row) && typeof row.taskId === "string" && row.variant === "primary"));
  assert.equal(new Set(planned.map(row => `${row.taskId}/${row.arm}/${row.repeat}`)).size, 8);
});

test("armOrder is seeded, reproducible and balanced across consecutive repeats", () => {
  const arms = ["product", "control"];
  for (const taskId of ["A", "B", "C", "JSB-PAYMENTS-01"]) {
    const first = armOrder(arms, { seed: 7, taskId, repeat: 1 });
    const second = armOrder(arms, { seed: 7, taskId, repeat: 2 });
    assert.deepEqual(first, armOrder(arms, { seed: 7, taskId, repeat: 1 }));
    assert.notEqual(first[0], second[0], "the starting arm alternates between repeats");
    assert.deepEqual([...first].sort(), [...arms].sort());
  }
});

function blockedEnv() {
  if (!existsSync(serverJs)) return "dist/server.js not built";
  for (const [bin, args] of [["python3", ["--version"]], ["javac", ["-version"]], ["java", ["-version"]]]) {
    try {
      execFileSync(bin, args, { stdio: "ignore" });
    } catch {
      return `${bin} unavailable`;
    }
  }
  return null;
}

function datasetDigest() {
  return execFileSync("python3", ["-c", "import sys;from pathlib import Path;from harness.dataset import dataset_digest;print(dataset_digest(Path(sys.argv[1])))", dataset], {
    cwd: kitRoot,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }
  }).trim();
}

/** Scripted OpenAI-compatible endpoint. Each attempt is recognised by its
 * first request (system + user only); its step is the number of assistant
 * turns already in the conversation. */
function scriptedEndpoint() {
  const reference = JSON.parse(readFileSync(path.join(dataset, "repairs", "JSB-PAYMENTS-03", "reference-change.json"), "utf8"));
  const pristine = readFileSync(path.join(dataset, "corpora", "payments", SERVICE), "utf8");
  const qaAttempts = { product: 0, control: 0 };
  const call = (name, args) => ({ choices: [{ message: { content: "", tool_calls: [{ id: `call-${name}-${Math.random().toString(16).slice(2, 8)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] });
  const answer = content => ({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
  const script = body => {
    const user = body.messages.find(m => m.role === "user")?.content ?? "";
    const arm = (body.tools ?? []).some(t => t.function?.name === "java_symbol") ? "product" : "control";
    const step = body.messages.filter(m => m.role === "assistant").length;
    if (user.includes("同租户两个不同请求")) {
      // repair: product writes the correct fix, control writes a wrong one.
      if (step === 0) return call("read", { path: SERVICE });
      if (step === 1) {
        const content = arm === "product" ? pristine.replace(reference.before, reference.after) : pristine.replace(reference.before, "String key = requestId;");
        return call("write_file", { path: SERVICE, content });
      }
      if (step === 2 && arm === "product") return call("java_symbol", { query: "PaymentService accept", searchMode: "text" });
      if (step <= 3) return call("test", {});
      return answer('{"patchApplied":true,"summary":"scripted"}');
    }
    // QA JSB-PAYMENTS-01: first attempt per arm reads the evidence fully,
    // the second reads a window that misses lines 8-11.
    if (step === 0) qaAttempts[arm] += 1;
    const full = qaAttempts[arm] === 1;
    // (the product arm's second attempt asks for an unrelated declaration so
    // no preview happens to cover lines 8-11)
    if (step === 0) {
      return arm === "product"
        ? call("java_symbol", full ? { query: "PaymentService duplicate request", limit: 2 } : { query: "PaymentService#preview", searchMode: "exact", limit: 1 })
        : call("rg", { pattern: "class PaymentService" });
    }
    if (step === 1) return call("read", { path: SERVICE, startLine: 1, maxLines: full ? 12 : 7 });
    return answer('{"storageType":"Set<String>","method":"accept"}');
  };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(script(body)));
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("live main(): scripted agent through the real loop, MCP server, native tools and frozen kit", { timeout: 300_000 }, async t => {
  const blocked = blockedEnv();
  if (blocked) {
    t.skip(`BLOCKED_ENV: ${blocked}`);
    return;
  }
  const before = datasetDigest();
  const server = await scriptedEndpoint();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "eval live e2e "));
  const output = path.join(tmp, "run out");
  try {
    const env = {
      ...process.env,
      OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      OPENAI_API_KEY: "scripted-not-a-secret",
      OPENAI_MODEL: "scripted-sentinel"
    };
    const code = await main([
      "--tasks", path.join(dataset, "prompts", "dev.jsonl"),
      "--gold", path.join(dataset, "gold", "dev.jsonl"),
      "--kit-root", kitRoot,
      "--filter", "JSB-PAYMENTS-01,JSB-PAYMENTS-03",
      "--repeats", "2",
      "--max-rounds", "8",
      "--server-js", serverJs,
      "--output", output
    ], env);
    assert.equal(code, 0);
    const pack = JSON.parse(readFileSync(path.join(output, "results-pack.json"), "utf8"));
    const row = (taskId, arm, repeat) => pack.packs.find(r => r.taskId === taskId && r.arm === arm && r.repeat === repeat);

    // Full planned denominator, every row an actual result (no synthetic MISSING).
    assert.equal(pack.denominator, 8);
    assert.equal(pack.missingResults, undefined);
    assert.ok(pack.packs.every(r => r.attemptState === "COMPLETED"), JSON.stringify(pack.packs.map(r => [r.taskId, r.arm, r.repeat, r.attemptState, r.answerStatus])));
    assert.equal(pack.scorer.kind, "frozen-kit", JSON.stringify(pack.scorer));

    // QA: the frozen kit decides; the evidence window decides success.
    for (const arm of ["product", "control"]) {
      const good = row("JSB-PAYMENTS-01", arm, 1);
      const short = row("JSB-PAYMENTS-01", arm, 2);
      assert.equal(good.frozenScore.qaContractPass, true, `${arm} r1: ${JSON.stringify(good.frozenScore)}`);
      assert.equal(good.taskSuccess, true);
      assert.equal(short.frozenScore.receivedEvidenceComplete, false, `${arm} r2 never received lines 8-11`);
      assert.equal(short.taskSuccess, false);
      assert.ok(good.sourceReceived.every(e => e.type === "SOURCE_RECEIVED"));
    }

    // Repair: only the frozen judge on the candidate tree decides (both
    // arms self-report patchApplied=true).
    const fixed = row("JSB-PAYMENTS-03", "product", 1);
    const wrong = row("JSB-PAYMENTS-03", "control", 1);
    assert.equal(fixed.repairJudge.state, "VALIDATED_SUCCESS", JSON.stringify(fixed.repairJudge));
    assert.equal(fixed.taskSuccess, true);
    assert.equal(wrong.repairJudge.state, "TEST_FAILED", JSON.stringify(wrong.repairJudge));
    assert.equal(wrong.taskSuccess, false);
    assert.equal(pack.byArm.product.successes, 3);
    assert.equal(pack.byArm.product.successRate, 3 / 4);
    assert.equal(pack.byArm.control.successRate, 1 / 4);

    // Wire: protocol order in every dispatched request, and the java_symbol
    // query after the write observes the written code.
    const requests = readFileSync(path.join(output, "model-payloads.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const request of requests) {
      request.messages.forEach((message, index) => {
        if (message.role !== "assistant" || !message.tool_calls) return;
        const replies = request.messages.slice(index + 1, index + 1 + message.tool_calls.length);
        assert.deepEqual(replies.map(m => m.tool_call_id), message.tool_calls.map(c => c.id));
      });
    }
    const repairProduct = requests.filter(r => r.attempt.taskId === "JSB-PAYMENTS-03" && r.attempt.arm === "product");
    const symbolReply = repairProduct.at(-1).messages.filter(m => m.role === "tool")[2];
    assert.ok(symbolReply.content.includes("tenant.length()"), `java_symbol after the write must see it: ${symbolReply.content.slice(0, 300)}`);
    assert.ok(!JSON.stringify(requests).includes("scripted-not-a-secret"), "credentials never reach the payload log");

    // Frozen inputs untouched.
    assert.equal(datasetDigest(), before);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

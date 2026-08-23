import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TRACE_SCHEMA_VERSION,
  blockedExternalResult,
  hasExternalAgentCredentials,
  parseAgentTraceCli,
  planAgentTraceMatrix,
  runAgentTraceMatrix
} from "./run-agent-trace-matrix.mjs";

test("blocked external result never substitutes 0 for usage or TaskSuccess", () => {
  const blocked = blockedExternalResult();
  assert.equal(blocked.status, "BLOCKED_EXTERNAL");
  assert.equal(blocked.modelUsage.status, "UNMEASURED");
  assert.equal(blocked.taskSuccess.status, "UNMEASURED");
  assert.equal(blocked.modelUsage.input, undefined);
  assert.notEqual(blocked.modelUsage.status, 0);
});

test("credentials helper is false without a provider key", () => {
  assert.equal(hasExternalAgentCredentials({}), false);
  assert.equal(hasExternalAgentCredentials({ ANTHROPIC_API_KEY: "sk-test" }), true);
});

test("matrix plan freezes six holdout tasks and 36 three-arm ABC/CBA cells", async () => {
  const plan = await planAgentTraceMatrix(parseAgentTraceCli(["--dry-run"]));
  assert.equal(plan.schemaVersion, "java-intelligence-jin-n5-three-arm-trace/v2");
  assert.equal(AGENT_TRACE_SCHEMA_VERSION, plan.schemaVersion);
  assert.equal(plan.tasks.length, 6);
  assert.equal(plan.cells.length, 36);
  assert.deepEqual(plan.protocol.variants, ["old", "jin", "serena"]);
  assert.deepEqual(plan.protocol.rounds, ["ABC", "CBA"]);
  assert.equal(plan.protocol.arms.old, "java_impact");
  assert.equal(plan.protocol.arms.jin, "java_context");
  assert.ok(plan.tasks.every(task => task.taskId.includes(":") && /^[a-f0-9]{40}$/.test(task.repoCommit)));
});

test("runner stays BLOCKED_EXTERNAL without explicit authorization even if a key is present", async () => {
  const result = await runAgentTraceMatrix(parseAgentTraceCli([], { ANTHROPIC_API_KEY: "sk-test" }));
  assert.equal(result.status, "BLOCKED_EXTERNAL");
  assert.equal(result.modelUsage.status, "UNMEASURED");
  assert.equal(result.plan.tasks.length, 6);
});

test("authorization without a key still cannot invent measured usage", async () => {
  const result = await runAgentTraceMatrix(parseAgentTraceCli(["--authorize-external"], {}));
  assert.equal(result.status, "BLOCKED_EXTERNAL");
  assert.equal(result.taskSuccess.status, "UNMEASURED");
});

test("model-profile openrouter and local-qwen bind host/model without sending", async () => {
  const openrouter = parseAgentTraceCli(["--model-profile", "openrouter"], {});
  assert.equal(openrouter.modelProfile.id, "openrouter");
  assert.equal(openrouter.modelProfile.host, "openrouter.ai");
  assert.equal(openrouter.modelProfile.model, "stealth/ox-alpha");
  assert.equal(openrouter.env.OPENAI_MODEL, "stealth/ox-alpha");
  assert.equal(openrouter.modelProfile.apiKey, undefined);
  const local = parseAgentTraceCli(["--model-profile", "local-qwen"], {});
  assert.equal(local.modelProfile.host, "47.106.205.246:1082");
  assert.equal(local.modelProfile.model, "openclaw/Qwen3.8-27B-WORK");
  assert.equal(local.modelProfile.host.includes("192.168.10.29"), false);
  const plan = await planAgentTraceMatrix(local);
  assert.equal(plan.modelProfile.host, "47.106.205.246:1082");
  assert.throws(() => parseAgentTraceCli(["--model-profile", "not-a-profile"], {}), /unknown model profile/);
});

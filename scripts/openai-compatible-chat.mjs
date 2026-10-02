#!/usr/bin/env node
// input: OpenAI-compatible chat.completions fields plus base URL and API key from env.
// output: Parsed chat completion JSON. Never logs the bearer token.
// pos: Eval-only HTTP client for live agent-trace. Not a production MCP dependency.
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 112 * 1024;
export const DEFAULT_PROMPT_CAP_TOKENS = 100_000;
export const DEFAULT_MAX_COMPLETION_TOKENS = 2_048;

export function openaiCompatibleConfig(env = process.env) {
  const baseUrl = (env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const apiKey = env.OPENAI_API_KEY || env.JAVA_LSP_AGENT_API_KEY || "";
  const model = env.OPENAI_MODEL || "";
  const reasoningEffort = env.OPENAI_REASONING_EFFORT || undefined;
  return { baseUrl, apiKey, model, reasoningEffort };
}

export async function openaiCompatibleChat({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  toolChoice = "auto",
  maxTokens = DEFAULT_MAX_COMPLETION_TOKENS,
  temperature = 0,
  reasoningEffort,
  fetchImpl = globalThis.fetch
}) {
  if (!baseUrl) throw new Error("OPENAI_BASE_URL is required");
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!model) throw new Error("OPENAI_MODEL is required");
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model,
    messages,
    tools,
    tool_choice: tools?.length ? toolChoice : undefined,
    max_tokens: maxTokens,
    temperature,
    // Qwen3 thinking can consume the whole max_tokens budget before tool_calls.
    // This endpoint honors chat_template_kwargs.enable_thinking=false (top-level enable_thinking is ignored).
    chat_template_kwargs: { enable_thinking: false }
  };
  // Reasoning-level passthrough for gateways that accept it (e.g. local
  // codex gateways); symmetric for every arm. Ignored by endpoints that
  // do not recognize the field.
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`openai-compatible HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

import { createHash } from "node:crypto";

export function estimateTokensFromText(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 4);
}

export function estimatePromptTokens(messages, tools) {
  return estimateTokensFromText(JSON.stringify({ messages, tools }));
}

export function usageFromCompletion(completion) {
  const usage = completion?.usage;
  if (!usage || typeof usage !== "object") return { status: "UNMEASURED" };
  const prompt = numberOrMissing(usage.prompt_tokens);
  const completionTokens = numberOrMissing(usage.completion_tokens);
  const total = numberOrMissing(usage.total_tokens);
  if (prompt === undefined && completionTokens === undefined && total === undefined) {
    return { status: "UNMEASURED" };
  }
  // v1.1: unknown fields stay null, never 0; the provider's raw usage object
  // (it never carries credentials - auth lives in the request header only) is
  // preserved and hashed so post-hoc audit can re-derive the measurement.
  const cached = numberOrMissing(usage.prompt_tokens_details?.cached_tokens);
  const reasoning = numberOrMissing(usage.completion_tokens_details?.reasoning_tokens);
  const rawUsage = JSON.parse(JSON.stringify(usage, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)));
  return {
    status: "MEASURED",
    promptTokens: prompt,
    completionTokens,
    totalTokens: total ?? ((prompt ?? 0) + (completionTokens ?? 0)),
    cachedInputTokens: cached,
    reasoningTokens: reasoning,
    rawUsage,
    rawUsageHash: createHash("sha256").update(JSON.stringify(rawUsage), "utf8").digest("hex")
  };
}

export function mergeUsage(left, right) {
  const add = (a, b) => (a == null && b == null) ? null : (a ?? 0) + (b ?? 0);
  const bothMeasured = left?.status === "MEASURED" && right?.status === "MEASURED";
  if (left?.status !== "MEASURED" && right?.status !== "MEASURED") {
    return { status: "UNMEASURED" };
  }
  if (left?.status !== "MEASURED") return { ...right };
  if (right?.status !== "MEASURED") return { ...left, status: "PARTIAL" };
  return {
    status: bothMeasured ? "MEASURED" : "PARTIAL",
    promptTokens: add(left.promptTokens, right.promptTokens),
    completionTokens: add(left.completionTokens, right.completionTokens),
    totalTokens: add(left.totalTokens, right.totalTokens),
    // Per-field provenance: a detail missing on one round is merged null,
    // never promoted to 0.
    cachedInputTokens: add(left.cachedInputTokens, right.cachedInputTokens),
    reasoningTokens: add(left.reasoningTokens, right.reasoningTokens),
    rawUsage: { left: left.rawUsage ?? null, right: right.rawUsage ?? null },
    rawUsageHash: {
      ...(left.rawUsageHash ? { left: left.rawUsageHash } : {}),
      ...(right.rawUsageHash ? { right: right.rawUsageHash } : {})
    }
  };
}

function numberOrMissing(value) {
  return Number.isFinite(value) ? value : undefined;
}

#!/usr/bin/env node
// input: OpenAI-compatible chat.completions fields plus base URL and API key from env.
// output: Parsed chat completion JSON. Never logs the bearer token.
// pos: Eval-only HTTP client for live agent-trace. Not a production MCP dependency.
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 112 * 1024;
export const DEFAULT_PROMPT_CAP_TOKENS = 100_000;
export const DEFAULT_MAX_COMPLETION_TOKENS = 2_048;
export const DEFAULT_CHAT_TEMPLATE_KWARGS = Object.freeze({ enable_thinking: false });

/** Model request settings only; connection/auth fields never enter the audit. */
export function chatRequestConfigForAudit({
  maxTokens = DEFAULT_MAX_COMPLETION_TOKENS,
  reasoningEffort,
  chatTemplateKwargs = DEFAULT_CHAT_TEMPLATE_KWARGS
} = {}) {
  return {
    max_tokens: maxTokens,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    chat_template_kwargs: { enable_thinking: chatTemplateKwargs.enable_thinking }
  };
}

/** Preserve response evidence without copying provider/debug or auth fields. */
export function completionForAudit(completion) {
  const picked = (value, keys) => Object.fromEntries(keys
    .filter(key => value != null && Object.hasOwn(value, key))
    .map(key => [key, structuredClone(value[key])]));
  return {
    ...picked(completion, ["id", "model", "created"]),
    choices: (Array.isArray(completion?.choices) ? completion.choices : []).map(choice => ({
      ...picked(choice, ["index", "finish_reason"]),
      message: {
        ...picked(choice?.message, ["role", "content", "reasoning_content", "refusal"]),
        ...(Array.isArray(choice?.message?.tool_calls) ? {
          tool_calls: choice.message.tool_calls.map(call => ({
            ...picked(call, ["id", "type"]),
            function: picked(call.function, ["name", "arguments"])
          }))
        } : {})
      }
    })),
    ...(completion?.usage != null ? { usage: {
      ...picked(completion.usage, ["prompt_tokens", "completion_tokens", "total_tokens"]),
      ...(completion.usage.prompt_tokens_details != null ? {
        prompt_tokens_details: picked(completion.usage.prompt_tokens_details, ["cached_tokens", "audio_tokens"])
      } : {}),
      ...(completion.usage.completion_tokens_details != null ? {
        completion_tokens_details: picked(completion.usage.completion_tokens_details, [
          "reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"
        ])
      } : {})
    } } : {})
  };
}

export function openaiCompatibleConfig(env = process.env) {
  const baseUrl = (env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  const apiKey = env.OPENAI_API_KEY || env.JAVA_LSP_AGENT_API_KEY || "";
  const model = env.OPENAI_MODEL || "";
  const reasoningEffort = env.OPENAI_REASONING_EFFORT || undefined;
  return { baseUrl, apiKey, model, reasoningEffort };
}

/** Absolute per-request deadline (connect + headers + body). */
export const DEFAULT_CHAT_TIMEOUT_MS = 300_000;

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
  chatTemplateKwargs = DEFAULT_CHAT_TEMPLATE_KWARGS,
  timeoutMs = DEFAULT_CHAT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  // Receives the exact request body string that is sent (post-ILV2 Q01 delivery receipts bind to these bytes).
  onSerializedBody
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
    temperature,
    // These are requested settings, not proof of provider thinking behavior.
    ...chatRequestConfigForAudit({ maxTokens, reasoningEffort, chatTemplateKwargs })
  };
  // Serialized once: the receipt and the network see the same bytes.
  const serialized = JSON.stringify(body);
  onSerializedBody?.(serialized);
  // One absolute deadline covers connect, headers AND body decoding.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`openai-compatible request exceeded ${timeoutMs}ms`)), timeoutMs);
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: serialized,
      signal: controller.signal
    });
    text = await response.text();
  } finally {
    clearTimeout(timer);
  }
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

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
  return { baseUrl, apiKey, model };
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
  fetchImpl = globalThis.fetch
}) {
  if (!baseUrl) throw new Error("OPENAI_BASE_URL is required");
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  if (!model) throw new Error("OPENAI_MODEL is required");
  const url = `${baseUrl}/chat/completions`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: tools?.length ? toolChoice : undefined,
      max_tokens: maxTokens,
      temperature,
      // Qwen3 thinking can consume the whole max_tokens budget before tool_calls.
      // This endpoint honors chat_template_kwargs.enable_thinking=false (top-level enable_thinking is ignored).
      chat_template_kwargs: { enable_thinking: false }
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`openai-compatible HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

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
  return {
    status: "MEASURED",
    promptTokens: prompt,
    completionTokens,
    totalTokens: total ?? ((prompt ?? 0) + (completionTokens ?? 0))
  };
}

export function mergeUsage(left, right) {
  if (left?.status !== "MEASURED" && right?.status !== "MEASURED") {
    return { status: "UNMEASURED" };
  }
  if (left?.status !== "MEASURED") return { ...right };
  if (right?.status !== "MEASURED") return { ...left, status: "PARTIAL" };
  return {
    status: "MEASURED",
    promptTokens: (left.promptTokens ?? 0) + (right.promptTokens ?? 0),
    completionTokens: (left.completionTokens ?? 0) + (right.completionTokens ?? 0),
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0)
  };
}

function numberOrMissing(value) {
  return Number.isFinite(value) ? value : undefined;
}

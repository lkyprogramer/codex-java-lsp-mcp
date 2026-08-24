#!/usr/bin/env node
// input: A live --model-profile name plus optional OPENAI_* env overrides.
// output: Frozen host/model/baseUrl for L1 dual-model live. Never logs keys.
// pos: F0/E4 SSOT. local-qwen host is 47.106.205.246:1082 (not the retired 192.168.10.29:28343).

export const LIVE_MODEL_PROFILE_IDS = Object.freeze(["local-qwen", "openrouter"]);

export const LIVE_MODEL_PROFILES = Object.freeze({
  "local-qwen": Object.freeze({
    id: "local-qwen",
    model: "openclaw/Qwen3.8-27B-WORK",
    baseUrl: "http://47.106.205.246:1082/v1",
    host: "47.106.205.246:1082"
  }),
  openrouter: Object.freeze({
    id: "openrouter",
    model: "stealth/ox-alpha",
    baseUrl: "https://openrouter.ai/api/v1",
    host: "openrouter.ai"
  })
});

export const RETIRED_LOCAL_QWEN_HOST = "192.168.10.29:28343";

export function liveModelProfileHost(profile) {
  try {
    return new URL(profile.baseUrl).host;
  } catch {
    return profile.host;
  }
}

export function resolveLiveModelProfile(name, env = process.env) {
  const id = String(name || env.JAVA_LSP_MODEL_PROFILE || "local-qwen");
  const frozen = LIVE_MODEL_PROFILES[id];
  if (!frozen) throw new Error(`unknown model profile: ${id}`);
  const baseUrl = String(env.OPENAI_BASE_URL || frozen.baseUrl).replace(/\/$/, "");
  const model = String(env.OPENAI_MODEL || frozen.model);
  return {
    id: frozen.id,
    model,
    baseUrl,
    host: liveModelProfileHost({ baseUrl, host: frozen.host }),
    apiKey: env.OPENAI_API_KEY || env.JAVA_LSP_AGENT_API_KEY || env.ANTHROPIC_API_KEY || ""
  };
}

export function applyLiveModelProfile(env, name) {
  const resolved = resolveLiveModelProfile(name, env);
  return {
    ...env,
    JAVA_LSP_MODEL_PROFILE: resolved.id,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL || resolved.baseUrl,
    OPENAI_MODEL: env.OPENAI_MODEL || resolved.model
  };
}

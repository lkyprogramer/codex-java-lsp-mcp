import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_MODEL_PROFILES,
  LIVE_MODEL_PROFILE_IDS,
  RETIRED_LOCAL_QWEN_HOST,
  applyLiveModelProfile,
  resolveLiveModelProfile
} from "./live-model-profiles.mjs";

test("local-qwen profile is the 29-model at 47.106.205.246:1082", () => {
  const profile = LIVE_MODEL_PROFILES["local-qwen"];
  assert.equal(profile.model, "openclaw/Qwen3.8-27B-WORK");
  assert.equal(profile.host, "47.106.205.246:1082");
  assert.equal(profile.baseUrl, "http://47.106.205.246:1082/v1");
  assert.equal(resolveLiveModelProfile("local-qwen").host, "47.106.205.246:1082");
  assert.equal(resolveLiveModelProfile("local-qwen").model, "openclaw/Qwen3.8-27B-WORK");
  assert.equal(`${profile.baseUrl}/chat/completions`, "http://47.106.205.246:1082/v1/chat/completions");
  assert.equal(profile.baseUrl.endsWith("/chat/completions"), false);
});

test("local-qwen does not resolve to the retired 192.168.10.29:28343 host", () => {
  const resolved = resolveLiveModelProfile("local-qwen", {});
  assert.equal(resolved.host.includes("192.168.10.29"), false);
  assert.notEqual(resolved.host, RETIRED_LOCAL_QWEN_HOST);
  assert.equal(JSON.stringify(LIVE_MODEL_PROFILES).includes(RETIRED_LOCAL_QWEN_HOST), false);
  assert.equal(resolved.baseUrl.includes("192.168.10.29"), false);
});

test("openrouter profile stays stealth/ox-alpha", () => {
  const resolved = resolveLiveModelProfile("openrouter", {});
  assert.equal(resolved.id, "openrouter");
  assert.equal(resolved.model, "stealth/ox-alpha");
  assert.equal(resolved.host, "openrouter.ai");
  assert.deepEqual(LIVE_MODEL_PROFILE_IDS, ["local-qwen", "openrouter"]);
});

test("OPENAI_* env overrides profile defaults without leaking into unknown ids", () => {
  const resolved = resolveLiveModelProfile("local-qwen", {
    OPENAI_BASE_URL: "http://example.test:9",
    OPENAI_MODEL: "custom-model"
  });
  assert.equal(resolved.host, "example.test:9");
  assert.equal(resolved.model, "custom-model");
  assert.throws(() => resolveLiveModelProfile("not-a-profile"), /unknown model profile/);
  const applied = applyLiveModelProfile({}, "openrouter");
  assert.equal(applied.OPENAI_MODEL, "stealth/ox-alpha");
  assert.equal(applied.JAVA_LSP_MODEL_PROFILE, "openrouter");
});

// input:  semantic-discovery 实验包的行为契约（离线 fake provider 为主，
//         OpenRouter 真端点 e2e 由 EMBEDDING_E2E=1 显式开启）。
// output: RED→GREEN 证据 —— Z1 提示契约、Z2 门控（exact/anchor 不 embed）、
//         K27 故障降级（未授权/超时/hash 不一致 → A2，无重试风暴）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DenseDiscoveryIndex,
  EMBEDDING_DIM,
  EmbeddingProvider,
  HINT_AUTHORITY,
  UNVERSIONED_CACHE_EPOCH,
  cacheIdentity,
  discoveryHint,
  readSearchDocumentFacts
} from "./provider.mjs";
import { classifyQueryIntent, gatedDenseSearch, shouldRunDense } from "./gate.mjs";

class FakeProvider {
  constructor({ failWith, timeout } = {}) {
    this.provider = "fake";
    this.model = "fake-model";
    this.calls = 0;
    this.batchCalls = 0;
    this.itemsEmbedded = 0;
    this.errors = 0;
    this.latencyMs = 0;
    this.failWith = failWith;
    this.timeout = timeout;
  }
  async embed(texts) {
    this.calls += 1;
    if (this.failWith) {
      this.errors += 1;
      throw this.failWith;
    }
    this.itemsEmbedded += texts.length;
    this.latencyMs += 1;
    // Deterministic pseudo-embedding: "needle" documents get a hot first axis.
    return texts.map(text => {
      const vector = new Array(EMBEDDING_DIM).fill(0);
      vector[0] = /needle/.test(text) ? 1 : 0.05;
      vector[1] = /payment/.test(text) ? 1 : 0.05;
      return vector;
    });
  }
  costReport() {
    return {
      provider: this.provider,
      model: this.model,
      httpCalls: this.calls,
      batchCalls: this.batchCalls,
      itemsEmbedded: this.itemsEmbedded,
      errors: this.errors,
      latencyMs: this.latencyMs
    };
  }
}

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
// a/Payment.java exists with the indexed hash; b/Other.java's indexed hash is stale.
const REPO = mkdtempSync(path.join(tmpdir(), "sem-disc-repo-"));
const PAYMENT_SOURCE = "package a;\n\n/** the needle */\npublic class Payment {}\n";
mkdirSync(path.join(REPO, "a"), { recursive: true });
mkdirSync(path.join(REPO, "b"), { recursive: true });
writeFileSync(path.join(REPO, "a/Payment.java"), PAYMENT_SOURCE);
writeFileSync(path.join(REPO, "b/Other.java"), "package b;\npublic class Other {}\n");
process.on("exit", () => rmSync(REPO, { recursive: true, force: true }));

const FACTS = [
  { docId: 1, relativePath: "a/Payment.java", startLine: 3, endLine: 10, kind: "signature", contentHash: sha256(PAYMENT_SOURCE), declarationId: "decl1", text: "public class Payment" },
  { docId: 2, relativePath: "a/Payment.java", startLine: 4, endLine: 4, kind: "comment", contentHash: sha256(PAYMENT_SOURCE), declarationId: "decl1", text: "the needle: duplicate request guard" },
  { docId: 3, relativePath: "b/Other.java", startLine: 2, endLine: 9, kind: "signature", contentHash: "h2", declarationId: "decl2", text: "public class Other payment" }
];

function builtIndex(provider = new FakeProvider()) {
  const index = new DenseDiscoveryIndex({ provider, facts: FACTS, corpusHash: "c".repeat(40), repoRoot: REPO });
  return index;
}

/** Offline OpenAI-compatible endpoint: "alpha" texts embed to [1,0], others to [0,1]. */
function offlineProvider(options = {}) {
  return new EmbeddingProvider({
    apiKey: "OFFLINE_FAKE_KEY",
    model: "offline-model",
    maxRetries: 0,
    timeoutMs: 200,
    fetchImpl: async (_url, init) => ({
      ok: true,
      json: async () => ({ data: JSON.parse(init.body).input.map((text, index) => ({ index, embedding: text.includes("alpha") ? [1, 0] : [0, 1] })) })
    }),
    ...options
  });
}

test("Z1: hints carry identity, rank and the DISCOVERY_HINT authority only", async () => {
  const index = builtIndex();
  await index.build();
  const provider = index.provider;
  const queryVector = await provider.embed(["duplicate request guard"]);
  const hints = index.search(queryVector[0], { topK: 2 });
  assert.ok(hints.length > 0);
  assert.equal(hints[0].authority, HINT_AUTHORITY);
  assert.equal(hints[0].provider, "fake");
  assert.ok(hints[0].providerIndexIdentity.includes("fake-model"));
  assert.ok(hints[0].providerIndexIdentity.includes("cccccccccccc"), "index identity pins the corpus hash prefix");
  assert.equal(hints[0].rank, 1);
  // The comment document containing the needle must rank the Payment file first.
  assert.equal(hints[0].relativePath, "a/Payment.java");
  assert.ok(hints[0].startLine <= 4 && hints[0].endLine >= 4, "the hint range must span the merged declaration");
  assert.equal(hints[0].indexedContentHash, sha256(PAYMENT_SOURCE));
});

test("Z1: a hash that no longer matches on disk yields a path-only hint (no stale lines)", async () => {
  const index = builtIndex();
  await index.build();
  const provider = index.provider;
  const queryVector = await provider.embed(["public class Other payment"]);
  const staleHint = index.search(queryVector[0], { topK: 3 }).find(hint => hint.relativePath === "b/Other.java");
  assert.ok(staleHint, "the stale declaration is still hinted by path");
  assert.equal(staleHint.indexedContentHash, undefined, "stale hash must be dropped, never promoted");
  assert.ok(staleHint.startLine == null && staleHint.endLine == null, "a stale hint carries no actionable line range");
  const fresh = index.search(queryVector[0], { topK: 3 }).find(hint => hint.relativePath === "a/Payment.java");
  assert.equal(fresh.indexedContentHash, sha256(PAYMENT_SOURCE));
  assert.deepEqual([fresh.startLine, fresh.endLine], [3, 10], "a verified hint keeps its range");
});

test("R10: two declarations of one file keep their own vectors across a cache reload", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sem-disc-cache-"));
  try {
    const cacheFile = path.join(dir, "cache.json");
    const facts = [
      { relativePath: "A.java", declarationId: "alpha", contentHash: "f".repeat(64), startLine: 1, endLine: 1, text: "alpha unique" },
      { relativePath: "A.java", declarationId: "beta", contentHash: "f".repeat(64), startLine: 2, endLine: 2, text: "beta distinct" }
    ];
    const coldProvider = offlineProvider({ cacheFile });
    const cold = new DenseDiscoveryIndex({ provider: coldProvider, facts, corpusHash: "corpus", repoRoot: dir });
    await cold.build();
    const warmProvider = offlineProvider({ cacheFile, fetchImpl: async () => { throw new Error("a warm build must not call the endpoint"); } });
    const reloaded = new DenseDiscoveryIndex({ provider: warmProvider, facts, corpusHash: "corpus", repoRoot: dir });
    await reloaded.build();
    assert.deepEqual(reloaded.vectors, cold.vectors);
    assert.deepEqual(cold.vectors, [[1, 0], [0, 1]]);
    assert.equal(cold.providerIndexIdentity, reloaded.providerIndexIdentity);
    // atomic writes: no temp file is left behind, and the file holds valid records only
    assert.deepEqual(readdirSync(dir).sort(), ["cache.json"]);
    const stored = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.equal(Object.keys(stored.entries).length, 2);
    assert.ok(!readFileSync(cacheFile, "utf8").includes("OFFLINE_FAKE_KEY"), "the API key never reaches the cache");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R10: cache hits are validated; legacy or malformed entries are re-embedded, never trusted", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sem-disc-cache-"));
  try {
    const cacheFile = path.join(dir, "cache.json");
    const facts = [
      { relativePath: "A.java", declarationId: "alpha", contentHash: "f".repeat(64), startLine: 1, endLine: 1, text: "alpha unique" },
      { relativePath: "A.java", declarationId: "beta", contentHash: "f".repeat(64), startLine: 2, endLine: 2, text: "beta distinct" }
    ];
    // the pre-R10 layout: model::path::hash -> vector (keyed without declaration/text/endpoint)
    writeFileSync(cacheFile, JSON.stringify({ [`offline-model::A.java::${"f".repeat(64)}`]: [0, 1] }));
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls += 1;
      return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map((text, index) => ({ index, embedding: text.includes("alpha") ? [1, 0] : [0, 1] })) }) };
    };
    const build = async () => {
      const index = new DenseDiscoveryIndex({ provider: offlineProvider({ cacheFile, fetchImpl }), facts, corpusHash: "corpus", repoRoot: dir });
      await index.build();
      return index.vectors;
    };
    assert.deepEqual(await build(), [[1, 0], [0, 1]]);
    assert.equal(calls, 1, "a legacy entry is not a hit");
    calls = 0;
    assert.deepEqual(await build(), [[1, 0], [0, 1]]);
    assert.equal(calls, 0, "valid records are hits");
    const stored = JSON.parse(readFileSync(cacheFile, "utf8"));
    const alphaKey = Object.keys(stored.entries).find(key => stored.entries[key].vector[0] === 1);
    const corruptions = [
      { ...stored.entries[alphaKey], vector: [1, null] },
      { ...stored.entries[alphaKey], vector: [1] },
      { ...stored.entries[alphaKey], dim: 3, vector: [1, 0, 0] },
      { ...stored.entries[alphaKey], key: "another-key" }
    ];
    for (const bad of corruptions) {
      writeFileSync(cacheFile, JSON.stringify({ ...stored, entries: { ...stored.entries, [alphaKey]: bad } }));
      calls = 0;
      assert.deepEqual(await build(), [[1, 0], [0, 1]], `malformed record ${JSON.stringify(bad)}`);
      assert.equal(calls, 1, `malformed record ${JSON.stringify(bad)} must be re-embedded`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R10: the dense text and cache keys do not depend on the order facts arrive in", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sem-disc-order-"));
  try {
    const cacheFile = path.join(dir, "cache.json");
    const facts = [
      { relativePath: "A.java", declarationId: "alpha", contentHash: "f".repeat(64), startLine: 1, endLine: 1, kind: "signature", text: "alpha signature" },
      { relativePath: "A.java", declarationId: "alpha", contentHash: "f".repeat(64), startLine: 2, endLine: 3, kind: "comment", text: "alpha comment" },
      { relativePath: "B.java", declarationId: "beta", contentHash: "e".repeat(64), startLine: 1, endLine: 1, kind: "signature", text: "beta signature" }
    ];
    const first = new DenseDiscoveryIndex({ provider: offlineProvider({ cacheFile }), facts, corpusHash: "corpus", repoRoot: dir });
    await first.build();
    assert.deepEqual(first.declarationRows().map(row => row.text), ["alpha signature\nalpha comment", "beta signature"], "documents join in source order");
    const reordered = new DenseDiscoveryIndex({
      provider: offlineProvider({ cacheFile, fetchImpl: async () => { throw new Error("reordered input must hit the cache"); } }),
      facts: [...facts].reverse(),
      corpusHash: "corpus",
      repoRoot: dir
    });
    await reordered.build();
    assert.deepEqual(reordered.vectors, first.vectors);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R10: identity covers endpoint, revision and representation but never the API key", () => {
  const facts = [{ relativePath: "A.java", declarationId: "alpha", contentHash: "f".repeat(64), startLine: 1, endLine: 1, text: "alpha" }];
  const identity = options => new DenseDiscoveryIndex({ provider: offlineProvider(options), facts, corpusHash: "corpus", repoRoot: tmpdir() }).providerIndexIdentity;
  const endpointA = { baseUrl: "https://one.invalid/v1" };
  const endpointB = { baseUrl: "https://two.invalid/v1" };
  assert.notEqual(identity(endpointA), identity(endpointB));
  assert.notEqual(identity({ revision: "r1" }), identity({ revision: "r2" }));
  assert.equal(identity({ apiKey: "key-one" }), identity({ apiKey: "key-two" }), "the key is a credential, not an identity");
  assert.notEqual(identity({}), identity({ cacheEpoch: "next-epoch" }), "an unversioned model is pinned to an explicit epoch");
  assert.equal(offlineProvider().identityBase().revision, `unversioned:${UNVERSIONED_CACHE_EPOCH}`);

  const base = { endpoint: "https://one.invalid/v1/embeddings", provider: "openrouter", model: "m", revision: "r", dim: 2, metric: "cosine", representationVersion: "v", declarationId: "d", textHash: "t", sourceManifestHash: "s" };
  assert.match(cacheIdentity(base), /^[0-9a-f]{64}$/);
  assert.equal(cacheIdentity(base), cacheIdentity(Object.fromEntries(Object.entries(base).reverse())), "canonical: field order does not matter");
  for (const field of Object.keys(base)) {
    assert.notEqual(cacheIdentity({ ...base, [field]: `${base[field]}x` }), cacheIdentity(base), `${field} is part of the identity`);
  }
  assert.throws(() => cacheIdentity({ ...base, apiKey: "secret" }), /apiKey/);
});

test("R10: the deadline covers the response body, retries and backoff; timers are cleared", async () => {
  const bodyNeverFinishesWithinDeadline = () => offlineProvider({
    timeoutMs: 40,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(resolve => setTimeout(() => resolve({ data: [{ index: 0, embedding: [1, 0] }] }), 300)) })
  }).embed(["alpha"]);
  const started = Date.now();
  await assert.rejects(bodyNeverFinishesWithinDeadline, /timeout/i);
  assert.ok(Date.now() - started < 250, "rejected at the deadline, not when the body arrived");

  let attempts = 0;
  const retrying = offlineProvider({
    timeoutMs: 120,
    maxRetries: 5,
    fetchImpl: async () => { attempts += 1; return { ok: false, status: 503, text: async () => "busy" }; }
  });
  const retryStarted = Date.now();
  await assert.rejects(() => retrying.embed(["alpha"]), /timeout|503/i);
  assert.ok(Date.now() - retryStarted < 400, `retries and backoff stay inside the total deadline (${Date.now() - retryStarted}ms)`);
  assert.equal(attempts, 1, "a 1.5s backoff never starts when it cannot fit in the deadline");

  const timersBefore = process.getActiveResourcesInfo().filter(name => name === "Timeout").length;
  await offlineProvider({ timeoutMs: 5_000 }).embed(["alpha", "beta"]);
  const timersAfter = process.getActiveResourcesInfo().filter(name => name === "Timeout").length;
  assert.equal(timersAfter, timersBefore, "a finished call leaves no deadline timer behind");
});

test("Z2: exact and known-anchor queries never call the embedding provider", async () => {
  const provider = new FakeProvider();
  const index = builtIndex(provider);
  await index.build();
  const buildCalls = provider.calls;

  const exact = await gatedDenseSearch({ query: "com.acme.Payment#accept", index, provider });
  assert.equal(exact.fallback, "A2");
  assert.equal(exact.reason, "exact_not_embedded");
  assert.equal(provider.calls, buildCalls, "exact queries must not embed");

  const anchor = await gatedDenseSearch({
    query: "a/Payment.java",
    index,
    provider,
    knownAnchorPaths: ["a/Payment.java"]
  });
  assert.equal(anchor.reason, "known_anchor_not_embedded");
  assert.equal(provider.calls, buildCalls, "known anchor names must not embed");
});

test("Z2: free-text intent does embed and returns DISCOVERY_HINT hints", async () => {
  const provider = new FakeProvider();
  const index = builtIndex(provider);
  await index.build();
  const before = provider.calls;
  const result = await gatedDenseSearch({ query: "duplicate request guard", index, provider });
  assert.equal(result.fallback, "NONE");
  assert.ok(result.hints.length > 0);
  assert.ok(provider.calls > before);
  assert.ok(result.hints.every(hint => hint.authority === HINT_AUTHORITY));
});

test("K27: unauthorized / failing provider falls back to A2 quietly without retry storms", async () => {
  // Unauthorized: constructing the real provider with no key throws; the gate
  // layer must never let that crash the caller.
  assert.throws(() => new EmbeddingProvider({ apiKey: "", model: "x" }), /NOT_AUTHORIZED/);

  const provider = new FakeProvider({ failWith: new Error("offline") });
  const index = builtIndex(provider);
  await index.build().catch(() => undefined);
  index.vectors = FACTS.map(() => new Array(EMBEDDING_DIM).fill(0.05));
  const result = await gatedDenseSearch({
    query: "duplicate request guard",
    index,
    provider,
    queryEmbed: async () => {
      throw new Error("embedding endpoint unreachable");
    }
  });
  assert.equal(result.fallback, "A2");
  assert.equal(result.reason, "provider_error");
  assert.deepEqual(result.hints, []);
});

test("K27: timeout aborts the in-flight embedding call (bounded, no infinite wait)", async () => {
  const slowFetch = async (_url, options) => {
    await new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
    return new Response("{}", { status: 200 });
  };
  const provider = new EmbeddingProvider({
    apiKey: "test",
    model: "fake",
    timeoutMs: 60,
    maxRetries: 0,
    fetchImpl: slowFetch
  });
  await assert.rejects(
    () => provider.embed(["some text"]),
    /abort|EMBEDDING|embedding/i
  );
  assert.ok(provider.errors >= 1);
});

test("R10: the same cache file never serves vectors across endpoint, revision or model", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sem-disc-cross-"));
  try {
    const cacheFile = path.join(dir, "cache.json");
    const facts = [{ relativePath: "A.java", declarationId: "alpha", contentHash: "f".repeat(64), startLine: 1, endLine: 1, text: "alpha unique" }];
    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls += 1;
      return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map((_t, index) => ({ index, embedding: [1, 0] })) }) };
    };
    const build = async options => {
      calls = 0;
      await new DenseDiscoveryIndex({ provider: offlineProvider({ cacheFile, fetchImpl, ...options }), facts, corpusHash: "corpus", repoRoot: dir }).build();
      return calls;
    };
    assert.equal(await build({ baseUrl: "https://one.invalid/v1" }), 1);
    assert.equal(await build({ baseUrl: "https://one.invalid/v1" }), 0, "same identity: hit");
    assert.equal(await build({ baseUrl: "https://two.invalid/v1" }), 1, "another endpoint re-embeds");
    assert.equal(await build({ baseUrl: "https://one.invalid/v1", revision: "r2" }), 1, "another revision re-embeds");
    assert.equal(await build({ baseUrl: "https://one.invalid/v1", model: "other-model" }), 1, "another model re-embeds");
    assert.throws(() => cacheIdentity({ endpoint: "e", provider: "p", model: "m", revision: "r", dim: 2, metric: "cosine", representationVersion: "v", declarationId: "d", textHash: "t" }), /missing field sourceManifestHash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R10: keyless (query) calls never touch the cache; full hits do not rewrite it; finished batches survive a later failure", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sem-disc-io-"));
  try {
    const cacheFile = path.join(dir, "cache.json");
    await offlineProvider({ cacheFile }).embed(["alpha query"]);
    assert.equal(existsSync(cacheFile), false, "a query embedding is not cached");
    const facts = [{ relativePath: "A.java", declarationId: "alpha", contentHash: "f".repeat(64), startLine: 1, endLine: 1, text: "alpha unique" }];
    await new DenseDiscoveryIndex({ provider: offlineProvider({ cacheFile }), facts, corpusHash: "corpus", repoRoot: dir }).build();
    const written = statSync(cacheFile).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 20));
    await new DenseDiscoveryIndex({ provider: offlineProvider({ cacheFile }), facts, corpusHash: "corpus", repoRoot: dir }).build();
    assert.equal(statSync(cacheFile).mtimeMs, written, "an all-hit build does not rewrite the cache");

    // 17 rows = two batches; the second batch fails after the first succeeded
    const many = Array.from({ length: 17 }, (_, i) => ({ relativePath: "M.java", declarationId: `m${String(i).padStart(2, "0")}`, contentHash: "e".repeat(64), startLine: i + 1, endLine: i + 1, text: `alpha ${i}` }));
    let batches = 0;
    const flaky = offlineProvider({ cacheFile, fetchImpl: async (_url, init) => {
      batches += 1;
      if (batches === 2) return { ok: false, status: 400, text: async () => "bad request" };
      return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map((_t, index) => ({ index, embedding: [1, 0] })) }) };
    } });
    await assert.rejects(() => new DenseDiscoveryIndex({ provider: flaky, facts: many, corpusHash: "corpus", repoRoot: dir }).build(), /HTTP 400/);
    let refetched = 0;
    const rerun = offlineProvider({ cacheFile, fetchImpl: async (_url, init) => {
      refetched += JSON.parse(init.body).input.length;
      return { ok: true, json: async () => ({ data: JSON.parse(init.body).input.map((_t, index) => ({ index, embedding: [1, 0] })) }) };
    } });
    await new DenseDiscoveryIndex({ provider: rerun, facts: many, corpusHash: "corpus", repoRoot: dir }).build();
    assert.equal(refetched, 1, "the 16 rows of the finished batch were cached before the failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R10: a body-stage timeout aborts the request; a fast failure whose retry cannot fit is not reported as a timeout", async () => {
  let signal;
  await assert.rejects(() => offlineProvider({
    timeoutMs: 40,
    fetchImpl: async (_url, init) => { signal = init.signal; return { ok: true, json: () => new Promise(() => {}) }; }
  }).embed(["alpha"]), /timeout/);
  assert.equal(signal.aborted, true, "the in-flight request (socket/body) is cancelled at the deadline");

  const failing = offlineProvider({ timeoutMs: 200, maxRetries: 3, fetchImpl: async () => ({ ok: false, status: 503, text: async () => "busy" }) });
  await assert.rejects(() => failing.embed(["alpha"]), error => /retry budget exhausted/.test(error.message) && !/timeout after/.test(error.message));
  assert.equal(failing.errors, 1, "one failed attempt is one error");
});

test("R10: a declaration with documents from another source file is stale when that file changes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sem-disc-multi-"));
  try {
    const java = "interface M { void find(); }\n";
    const xml = "<mapper><select id=\"find\"/></mapper>\n";
    writeFileSync(path.join(dir, "M.java"), java);
    writeFileSync(path.join(dir, "M.xml"), xml);
    const facts = [
      { relativePath: "M.java", sourcePath: "M.java", declarationId: "find", contentHash: sha256(java), startLine: 1, endLine: 1, text: "alpha find" },
      { relativePath: "M.java", sourcePath: "M.xml", declarationId: "find", contentHash: sha256(xml), startLine: 40, endLine: 44, text: "alpha select" }
    ];
    const index = new DenseDiscoveryIndex({ provider: offlineProvider(), facts, corpusHash: "corpus", repoRoot: dir });
    await index.build();
    const [fresh] = index.search([1, 0], { topK: 1 });
    assert.deepEqual([fresh.indexedContentHash, fresh.startLine, fresh.endLine], [sha256(java), 1, 1], "the range comes from the declaration's own file only");
    writeFileSync(path.join(dir, "M.xml"), "<mapper/>\n");
    const [stale] = index.search([1, 0], { topK: 1 });
    assert.ok(stale.indexedContentHash === undefined && stale.startLine == null && stale.endLine == null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R10: experiment entry points refuse to run before any session or model call", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const script of ["compare.mjs", "agent-ab.mjs"]) {
    const run = spawnSync(process.execPath, [path.join(here, script)], { cwd: here, env, encoding: "utf8", timeout: 30_000 });
    assert.notEqual(run.status, 0, `${script} must not run`);
    assert.match(`${run.stdout}${run.stderr}`, /DISABLED_INVALID/, `${script}: ${run.stderr.slice(0, 300)}`);
  }
});

test("intent classifier matches the A2 contract: CJK and code shapes route differently", () => {
  assert.equal(classifyQueryIntent("PaymentService"), "exact");
  assert.equal(classifyQueryIntent("com.acme.Payment#accept"), "exact");
  assert.equal(classifyQueryIntent("PaymentService 在哪里阻止重复请求？"), "text");
  assert.equal(classifyQueryIntent("Map<String, V>"), "text");
  assert.equal(classifyQueryIntent("rollback"), "text");
  assert.equal(shouldRunDense({ query: "com.acme.Payment#accept" }).run, false);
  assert.equal(shouldRunDense({ query: "重复请求怎么拦截" }).run, true);
});

test("R10: readSearchDocumentFacts refuses to rebuild text from the unordered token index", () => {
  // The product index stores token postings, not the ordered SearchDocument
  // text; joining tokens would embed a different (unordered) representation.
  assert.throws(() => readSearchDocumentFacts(tmpdir(), path.join(tmpdir(), "missing.sqlite")), /DISABLED_INVALID/);
});

test("E2E (optional): real OpenRouter embedding round-trip when EMBEDDING_E2E=1", { skip: process.env.EMBEDDING_E2E !== "1" }, async () => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_EMBEDDING_MODEL ?? "liquid/lfm-2.5-embedding-350m:free";
  const provider = new EmbeddingProvider({ apiKey, model, timeoutMs: 60_000 });
  const vectors = await provider.embed(["duplicate request guard", "processed set adds request id"]);
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0].length, EMBEDDING_DIM);
  assert.ok(provider.costReport().itemsEmbedded === 2);
  const similar = await provider.embed(["duplicate request guard", "completely unrelated logistics"]);
  const sameTopic = vectors[0].reduce((sum, v, i) => sum + v * similar[0][i], 0);
  const crossTopic = vectors[0].reduce((sum, v, i) => sum + v * similar[1][i], 0);
  assert.ok(sameTopic > crossTopic, "sanity: same-topic similarity must exceed cross-topic");
}, { timeout: 120_000 });
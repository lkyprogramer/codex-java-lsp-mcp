// input:  semantic-discovery 实验包的行为契约（离线 fake provider 为主，
//         OpenRouter 真端点 e2e 由 EMBEDDING_E2E=1 显式开启）。
// output: RED→GREEN 证据 —— Z1 提示契约、Z2 门控（exact/anchor 不 embed）、
//         K27 故障降级（未授权/超时/hash 不一致 → A2，无重试风暴）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  DenseDiscoveryIndex,
  EMBEDDING_DIM,
  EmbeddingProvider,
  HINT_AUTHORITY,
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

const FACTS = [
  { docId: 1, relativePath: "a/Payment.java", startLine: 3, endLine: 10, kind: "signature", contentHash: "h1", declarationId: "decl1", text: "public class Payment" },
  { docId: 2, relativePath: "a/Payment.java", startLine: 4, endLine: 4, kind: "comment", contentHash: "h1", declarationId: "decl1", text: "the needle: duplicate request guard" },
  { docId: 3, relativePath: "b/Other.java", startLine: 2, endLine: 9, kind: "signature", contentHash: "h2", declarationId: "decl2", text: "public class Other payment" }
];

function builtIndex(provider = new FakeProvider()) {
  const index = new DenseDiscoveryIndex({ provider, facts: FACTS, corpusHash: "c".repeat(40), repoRoot: "/tmp" });
  return index;
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
});

test("Z1: a hash that no longer matches on disk yields a path-only hint (no stale lines)", async () => {
  const index = builtIndex();
  await index.build();
  // /tmp/a/Payment.java does not exist on disk in the fixture -> hash check fails.
  const provider = index.provider;
  const queryVector = await provider.embed(["duplicate request guard"]);
  const hints = index.search(queryVector[0], { topK: 1 });
  assert.equal(hints[0].indexedContentHash, undefined, "stale hash must be dropped, never promoted");
  assert.ok(hints[0].relativePath, "the path hint remains so the caller re-reads and re-locates");
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

test("intent classifier matches the A2 contract: CJK and code shapes route differently", () => {
  assert.equal(classifyQueryIntent("PaymentService"), "exact");
  assert.equal(classifyQueryIntent("com.acme.Payment#accept"), "exact");
  assert.equal(classifyQueryIntent("PaymentService 在哪里阻止重复请求？"), "text");
  assert.equal(classifyQueryIntent("Map<String, V>"), "text");
  assert.equal(classifyQueryIntent("rollback"), "text");
  assert.equal(shouldRunDense({ query: "com.acme.Payment#accept" }).run, false);
  assert.equal(shouldRunDense({ query: "重复请求怎么拦截" }).run, true);
});

test("readSearchDocumentFacts reads the product index read-only (smoke on a real sqlite)", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/sem-disc-`);
  try {
    const dbPath = `${dir}/index.sqlite`;
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sym(id INTEGER PRIMARY KEY, text TEXT NOT NULL);
      CREATE TABLE search_doc(sym INTEGER PRIMARY KEY, declaration_sym INTEGER NOT NULL,
        path_sym INTEGER, content_hash TEXT NOT NULL, kind TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, token_len INTEGER NOT NULL);
      CREATE TABLE search_doc_token(doc_sym INTEGER NOT NULL, token_sym INTEGER NOT NULL, tf INTEGER NOT NULL,
        PRIMARY KEY(doc_sym, token_sym));
      INSERT INTO sym VALUES (1, 'type:v2:x%2FP.java#x.P'), (2, 'x/P.java'), (3, 't1'), (4, 't2');
      INSERT INTO search_doc VALUES (10, 1, 2, 'hash1', 'signature', 3, 9, 2);
      INSERT INTO search_doc_token VALUES (10, 3, 1), (10, 4, 1);
    `);
    db.close();
    const facts = readSearchDocumentFacts(dir, dbPath);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].relativePath, "x/P.java");
    assert.equal(facts[0].declarationId, "type:v2:x%2FP.java#x.P");
    assert.equal(facts[0].text, "t1 t2");
    assert.equal(facts[0].contentHash, "hash1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
// R11: the A2/A3 dense experiment compares equal evidence budgets with the
// frozen kit scorer. Zero-cost: a real kit corpus (payments) cold-built by
// the product, the product's lexical search, an offline embedding endpoint
// with an on-disk cache, and the kit's own harness/scoring.py evaluate().
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { close, openIndexDb } from "../dist/java-index/sql/driver.js";
import { ensureSchema } from "../dist/java-index/sql/schema.js";
import { runSqlColdBuild } from "../dist/index-builder/cold-build.js";
import { SqlEntitySearch } from "../dist/java-index/sql/entity-search.js";
import { DenseDiscoveryIndex, EmbeddingProvider, readSearchDocumentFacts } from "../experiments/semantic-discovery/provider.mjs";
import {
  CANDIDATE_K,
  DeclarationResolver,
  LEGACY_INVALID_PROTOCOL_HASHES,
  decideFourWay,
  evidenceTotals,
  experimentProfile,
  formatCandidateBlock,
  kitEvaluate,
  kitResult,
  lexicalDeclarationIds,
  medianPromptTokens,
  protocolHash,
  renderEvidence,
  rrfFuse,
  seededFill,
  stratifiedDelta
} from "../experiments/semantic-discovery/budget.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIT = path.join(REPO_ROOT, "docs/java-specialist-release-audit-v1.1/baseline-kit");
const jsonl = file => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
const TASKS = new Map(jsonl(path.join(KIT, "dataset/prompts/dev.jsonl")).map(task => [task.id, task]));
const GOLD = new Map(jsonl(path.join(KIT, "dataset/gold/dev.jsonl")).map(gold => [gold.id, gold]));
const TASK = TASKS.get("JSB-PAYMENTS-01");
const BUDGET = TASK.budget;

/** Offline OpenAI-compatible embeddings: a stable bag-of-words hash vector. */
function offlineFetch(counter) {
  return async (_url, init) => {
    counter.calls += 1;
    const input = JSON.parse(init.body).input;
    const embed = text => {
      const vector = new Array(32).fill(0);
      for (const word of text.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean)) {
        let h = 0;
        for (const ch of word) h = (h * 31 + ch.codePointAt(0)) >>> 0;
        vector[h % 32] += 1;
      }
      vector[31] += 0.01;
      return vector;
    };
    return { ok: true, json: async () => ({ data: input.map((text, index) => ({ index, embedding: embed(text) })) }) };
  };
}

async function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "r11-budget-"));
  const repoRoot = path.join(dir, "repo");
  cpSync(path.join(KIT, "dataset/corpora", TASK.corpus), repoRoot, { recursive: true });
  const dbPath = path.join(dir, "index.sqlite");
  const db = openIndexDb(dbPath);
  ensureSchema(db);
  await runSqlColdBuild({ repoRoot, db, generation: 1 });
  const counter = { calls: 0 };
  const makeProvider = () => new EmbeddingProvider({
    apiKey: "OFFLINE", model: "offline-bow", baseUrl: "https://offline.invalid/v1", dimensions: 32,
    maxRetries: 0, timeoutMs: 2_000, cacheFile: path.join(dir, "embeddings.json"), fetchImpl: offlineFetch(counter)
  });
  return { dir, repoRoot, dbPath, db, makeProvider, counter };
}

/** Both arms through the same lexical source, resolver, renderer and budget. */
async function arms({ db, dbPath, repoRoot, makeProvider, provider = makeProvider(), query = TASK.query, budget = BUDGET }) {
  const lexical = new SqlEntitySearch(db).searchDetailed(query, CANDIDATE_K, "text").hits.map(hit => hit.entityId);
  const dense = new DenseDiscoveryIndex({ provider, facts: readSearchDocumentFacts(repoRoot, dbPath), corpusHash: "payments", repoRoot });
  await dense.build();
  const denseIds = dense.rank(await provider.embedQuery(query), { topK: CANDIDATE_K }).map(entry => entry.declarationId);
  const fused = rrfFuse(lexical, denseIds);
  const resolver = new DeclarationResolver(dbPath);
  try {
    return {
      lexical,
      denseIds,
      fused,
      a2: renderEvidence({ declarationIds: lexical, resolver, repoRoot, budget }),
      a3: renderEvidence({ declarationIds: fused.map(entry => entry.declarationId), resolver, repoRoot, budget })
    };
  } finally {
    resolver.close();
  }
}

const score = (rendered, repoRoot, task = TASK) =>
  kitEvaluate({ kitRoot: KIT, cases: [{ task, gold: GOLD.get(task.id), result: kitResult(task.id, rendered), root: repoRoot }] })[0];

test("R11: A2 and A3 both stop at K=10 candidates and inside the frozen line/byte/region budget", async () => {
  const f = await fixture();
  try {
    const { a2, a3, lexical, denseIds } = await arms(f);
    assert.ok(new Set([...lexical, ...denseIds]).size > CANDIDATE_K, "the fused pool is larger than the cap");
    assert.ok(a2.finalCandidates.length <= 10 && a3.finalCandidates.length <= 10);
    const [s2, s3] = [score(a2, f.repoRoot), score(a3, f.repoRoot)];
    for (const [arm, row] of [["a2", s2], ["a3", s3]]) {
      assert.equal(row.valid, true, `${arm}: ${row.errors}`);
      assert.equal(row.budget_pass, true, `${arm} within the task budget`);
    }
    assert.ok(s2.emitted_bytes <= 16000 && s3.emitted_bytes <= 16000);
    assert.equal(s3.emitted_bytes, a3.emitted_bytes, "the renderer counts bytes as the kit does");
    assert.equal(s3.emitted_lines, a3.emitted_lines);

    // Agent layer: both arms get one block of the same shape; only the list differs.
    const [b2, b3] = [formatCandidateBlock(a2.finalCandidates), formatCandidateBlock(a3.finalCandidates)].map(block => block.split("\n"));
    assert.equal(b2[1], b3[1], "same header");
    assert.ok(b2.length - 2 <= CANDIDATE_K && b3.length - 2 <= CANDIDATE_K);
    for (const line of [...b2.slice(2), ...b3.slice(2)]) {
      assert.match(line, /^\d+\. [^\s:]+:\d+ [\w$<>]+$/, "the block carries locators only, never source text");
    }
    assert.deepEqual(formatCandidateBlock([]).split("\n").slice(1), [b2[1], "(none)"]);

    // A tight budget clips both arms by the same rule; the kit still passes them.
    const tight = { max_regions: 3, max_lines: 9, max_bytes: 200 };
    const clipped = await arms({ ...f, budget: tight });
    const task = { ...TASK, budget: tight };
    for (const rendered of [clipped.a2, clipped.a3]) {
      const row = score(rendered, f.repoRoot, task);
      assert.equal(row.budget_pass, true, JSON.stringify(rendered.regions));
      assert.ok(rendered.regions.length <= 3 && row.emitted_lines <= 9 && row.emitted_bytes <= 200);
    }
  } finally {
    close(f.db);
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("R11: a path-only or stale candidate earns no required line recall", async () => {
  const f = await fixture();
  try {
    const gold = GOLD.get(TASK.id);
    const evidencePath = gold.required_evidence[0].path;
    const pathOnly = kitEvaluate({ kitRoot: KIT, cases: [{
      task: TASK, gold,
      result: { task_id: TASK.id, status: "OK", regions: [{ path: evidencePath }], candidates: [], answer: null, usage: null },
      root: f.repoRoot
    }] })[0];
    assert.equal(pathOnly.required_line_recall, 0);
    assert.equal(pathOnly.valid, false, "the kit rejects a region without a range outright");

    // A declaration the resolver cannot locate is reported, never rendered as a whole-file region.
    const unlocatable = renderEvidence({ declarationIds: ["method:missing#x()"], resolver: { resolve: () => null }, repoRoot: f.repoRoot, budget: BUDGET });
    assert.deepEqual([unlocatable.regions, unlocatable.finalCandidates, unlocatable.dropped.unresolved], [[], [], ["method:missing#x()"]]);

    const fresh = await arms(f);
    assert.ok(score(fresh.a3, f.repoRoot).required_line_recall > 0, "the fixture can cover the evidence when fresh");
    // The evidence file changes after indexing: its declarations are dropped,
    // never rendered with their old ranges.
    writeFileSync(path.join(f.repoRoot, evidencePath), `${readFileSync(path.join(f.repoRoot, evidencePath), "utf8")}\n// edited\n`);
    const stale = await arms(f);
    for (const rendered of [stale.a2, stale.a3]) {
      assert.ok(rendered.dropped.stale.length > 0);
      assert.equal(rendered.regions.some(region => region.path === evidencePath), false);
      assert.equal(score(rendered, f.repoRoot).required_line_recall, 0);
    }
  } finally {
    close(f.db);
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("R11: a warm cache reproduces the cold run's fused candidates and evidence without embedding calls", async () => {
  const f = await fixture();
  try {
    const cold = await arms(f);
    const coldCalls = f.counter.calls;
    assert.ok(coldCalls > 0);
    const warm = await arms(f);
    assert.equal(f.counter.calls, coldCalls, "declaration and query vectors come from the cache");
    assert.deepEqual(warm.fused, cold.fused);
    assert.deepEqual(warm.a3, cold.a3);
  } finally {
    close(f.db);
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("R11: RRF uses 1/(k0+rank) per channel, dedups by declaration and breaks ties deterministically", () => {
  const fused = rrfFuse(["a", "b", "c", "a"], ["c", "d"], { k0: 60, k: 3 });
  assert.deepEqual(fused.map(entry => entry.declarationId), ["c", "a", "b"]);
  assert.equal(fused[0].score, 1 / 63 + 1 / 61);
  assert.deepEqual([fused[1].lexicalRank, fused[1].denseRank], [1, null], "a missing channel contributes nothing");
  assert.deepEqual(rrfFuse(["x"], ["y"]).map(entry => entry.declarationId), ["x", "y"], "equal scores: lexical rank first");
  assert.equal(rrfFuse(Array.from({ length: 30 }, (_, i) => `l${i}`), Array.from({ length: 30 }, (_, i) => `d${i}`)).length, CANDIDATE_K);
});

test("R11: the protocol hash names every fixed field and differs from the invalid protocols", () => {
  const base = {
    question: "dense-mechanism",
    arms: ["a2-lexical", "a3-rrf-dense"],
    corpus: { mode: "external-full", corpusHash: "c", datasetHash: "d", split: "dev", taskIds: ["JSB-PAYMENTS-01"] },
    representation: { searchDocument: "search_doc_text/v8", dense: "searchdoc-v2/declaration-join-v1" },
    provider: { endpoint: "https://e/v1/embeddings", model: "m", dim: 1024 },
    lexical: { tool: "java_symbol", limit: 10 },
    budget: BUDGET,
    scorer: { kit: "harness/scoring.py", scorerHash: "s" }
  };
  const newProtocolHash = protocolHash(experimentProfile(base));
  for (const oldInvalidProtocolHash of LEGACY_INVALID_PROTOCOL_HASHES) assert.notEqual(newProtocolHash, oldInvalidProtocolHash);
  assert.notEqual(protocolHash(experimentProfile({ ...base, budget: { ...BUDGET, max_lines: 161 } })), newProtocolHash);
  assert.notEqual(protocolHash(experimentProfile({ ...base, provider: { ...base.provider, dim: 2048 } })), newProtocolHash);
  assert.notEqual(protocolHash(experimentProfile({ ...base, arms: [...base.arms, "a2-seeded-fill"] })), newProtocolHash, "adding an arm is a new protocol");
  assert.equal(protocolHash(experimentProfile({ ...base, corpus: { ...base.corpus } })), newProtocolHash, "key order does not matter");
  assert.throws(() => experimentProfile({ ...base, budget: { max_regions: 8, max_lines: 0, max_bytes: 1 } }), /max_lines/);
});

test("R11: macro-task and micro-evidence recall keep their numerators and denominators", () => {
  const gold = new Map([
    ["t1", { required_evidence: [{ path: "A", start_line: 1, end_line: 4 }] }],
    ["t2", { required_evidence: [{ path: "B", start_line: 1, end_line: 1 }] }]
  ]);
  const totals = evidenceTotals([{ task_id: "t1", required_line_recall: 0.5 }, { task_id: "t2", required_line_recall: 1 }], gold);
  assert.deepEqual(totals.macroTask, { numerator: 1.5, denominator: 2, value: 0.75 });
  assert.deepEqual(totals.microEvidence, { numerator: 3, denominator: 5, value: 0.6 });
  assert.throws(() => evidenceTotals([{ task_id: "t1", required_line_recall: 0.3 }], gold), /non-integer/);
});

test("R11: the four-way decision passes GO only with every gate; the retrieval screen alone is INCONCLUSIVE", () => {
  const gates = JSON.parse(readFileSync(path.join(KIT, "schemas/gates.json"), "utf8"));
  const ok = { a2: { summary: { overall: { invalid: 0, over_budget: 0 } } }, a3: { summary: { overall: { invalid: 0, over_budget: 0 } } } };
  const metric = (delta, ci, clusters = 8) => ({ cluster_macro_delta: delta, cluster_bootstrap_95: ci, clusters });
  const cmp = ({ recall, lines = metric(0.02, [0, 0.05]), mrr = metric(0.01, [0, 0.03]) }) =>
    ({ metrics: { declaration_recall_at_10: recall, required_line_recall: lines, mrr } });
  const strong = metric(0.15, [0.05, 0.25]);
  const fill = { metrics: { declaration_recall_at_10: metric(0.1, [0.02, 0.2]) } };
  const agent = { qaDeltaLower: 0, tokenMedianRatio: 0.8 };
  const decide = args => decideFourWay({ comparison: cmp({ recall: strong }), fillComparison: fill, reports: ok, gates, agent, ...args });

  assert.equal(decide({}).decision, "GO_OPTIONAL");
  const screenOnly = decide({ agent: null });
  assert.deepEqual([screenOnly.decision, screenOnly.screen], ["INCONCLUSIVE", "PASS"], "the retrieval screen alone never yields GO");
  assert.equal(decide({ fillComparison: { metrics: { declaration_recall_at_10: metric(0, [-0.05, 0.05]) } } }).decision, "INCONCLUSIVE",
    "not better than the non-semantic fill control");
  assert.equal(decide({ comparison: cmp({ recall: strong, mrr: metric(-0.1, [-0.2, -0.05]) }) }).decision, "INCONCLUSIVE", "MRR regression");
  assert.equal(decide({ comparison: cmp({ recall: strong, lines: metric(0, [-0.1, 0.1]) }) }).decision, "INCONCLUSIVE", "line-recall regression");
  assert.equal(decide({ comparison: cmp({ recall: metric(0.15, [0.05, 0.25], 3) }) }).decision, "INCONCLUSIVE", "too few clusters for GO");
  assert.equal(decide({ agent: { qaDeltaLower: -0.2, tokenMedianRatio: 0.8 } }).decision, "INCONCLUSIVE", "agent QA regression");
  const costly = decide({ agent: { qaDeltaLower: 0, tokenMedianRatio: 2.7 } });
  assert.equal(costly.decision, "INCONCLUSIVE");
  assert.ok(costly.reasons.some(reason => reason.includes(String(gates.dense_input_token_median_max_ratio))), "the frozen token gate is applied");
  assert.equal(decide({ comparison: cmp({ recall: metric(0.01, [-0.04, 0.06]) }) }).decision, "NO_GO");
  assert.equal(decide({ comparison: cmp({ recall: metric(0.01, [-0.04, 0.06], 3) }) }).decision, "INCONCLUSIVE", "too few clusters for NO_GO");
  assert.equal(decide({ comparison: cmp({ recall: metric(0.05, [-0.1, 0.2]) }) }).decision, "INCONCLUSIVE");
  const bad = { ...ok, a3: { summary: { overall: { invalid: 1, over_budget: 0 } } } };
  assert.equal(decide({ reports: bad }).decision, "INVALID_EXPERIMENT");
});

test("R11: the fill control pads lexical to K without semantics; strata and token medians are exact", () => {
  const all = Array.from({ length: 30 }, (_, i) => `d${i}`);
  const filled = seededFill(["d3", "d7"], all);
  assert.equal(filled.length, CANDIDATE_K);
  assert.deepEqual(filled.slice(0, 2), ["d3", "d7"], "lexical order kept first");
  assert.equal(new Set(filled).size, CANDIDATE_K);
  assert.deepEqual(seededFill(["d3", "d7"], [...all].reverse()), filled, "independent of input order");
  assert.notDeepEqual(seededFill(["d3", "d7"], all, { seed: "other" }), filled);

  const lexical = lexicalDeclarationIds({ candidates: [{ declaration: { id: "a" } }, { declaration: { id: "a" } }, { declaration: {} }, { declaration: { id: "b" } }] });
  assert.deepEqual(lexical, ["a", "b"], "java_symbol candidates -> ranked unique declaration ids");

  const report = rows => ({ rows });
  const strata = stratifiedDelta(
    report([{ task_id: "t1", origin: "authored", mrr: 1 }, { task_id: "t2", origin: "upstream", mrr: 0.5 }]),
    report([{ task_id: "t1", origin: "authored", mrr: 0.5 }, { task_id: "t2", origin: "upstream", mrr: 0.5 }]),
    "mrr", "origin");
  assert.deepEqual(strata, { authored: { tasks: 1, baseline: 1, candidate: 0.5, delta: -0.5 }, upstream: { tasks: 1, baseline: 0.5, candidate: 0.5, delta: 0 } });

  assert.equal(medianPromptTokens([{ usage: { promptTokens: 10 } }, { usage: { inputTokens: 30 } }, { usage: { promptTokens: 20 } }, { usage: { promptTokens: 40 } }]), 25);
  assert.equal(medianPromptTokens([{ usage: { promptTokens: 10 } }, { usage: null }]), null, "missing usage is not a median");
});

// input:  The frozen kit (dev split), its hydrated external-full corpus, the
//         product MCP server (dist/server.js) and an OpenAI-compatible
//         embedding endpoint (user-authorized; embeddingProviderFromEnv).
// output: R11 retrieval-layer experiment: A2 = product java_symbol top-K,
//         A3 = RRF(lexical, dense, k0=60) top-K, both rendered by one evidence
//         renderer under the task budget and scored by the kit itself
//         (harness score + compare), with the ExperimentProfile/protocol hash,
//         macro-task and micro-evidence totals and the four-way decision.
// pos:    docs/next-stage/experiment-v1.1.md; kit docs/06-experiment-redesign.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openImpactSession } from "../../scripts/run-agent-trace-live.mjs";
import {
  DENSE_REPRESENTATION_VERSION,
  DenseDiscoveryIndex,
  QUERY_REPRESENTATION_VERSION,
  embeddingProviderFromEnv,
  readSearchDocumentFacts,
  waitForReadyIndex
} from "./provider.mjs";
import { shouldRunDense } from "./gate.mjs";
import {
  CANDIDATE_K,
  CHANNEL_POOL_K,
  DeclarationResolver,
  decideFourWay,
  evidenceTotals,
  experimentProfile,
  kitCompare,
  kitHashes,
  kitResult,
  kitScorePack,
  lexicalDeclarationIds,
  protocolHash,
  renderEvidence,
  rrfFuse,
  seededFill,
  stratifiedDelta
} from "./budget.mjs";

// Every root comes from the CLI or the environment; no personal defaults.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
function cliValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function requiredPath({ flag, env, fallback, label }) {
  const value = cliValue(flag) ?? process.env[env] ?? fallback;
  if (!value) {
    throw new Error(`${label} is required: pass ${flag} <path> or set ${env}. This driver has no personal absolute-path defaults.`);
  }
  return path.resolve(value);
}
const KIT = requiredPath({ flag: "--kit-root", env: "JSB_KIT_ROOT", fallback: path.join(REPO_ROOT, "docs/java-specialist-release-audit-v1.1/baseline-kit"), label: "frozen kit root" });
const STAGE = requiredPath({ flag: "--stage", env: "M3_STAGE", label: "hydrated external-full corpus root (harness hydrate-public)" });
const SPLIT = cliValue("--split") ?? "dev";
const SERVER_JS = requiredPath({ flag: "--server-js", env: "M3_SERVER_JS", fallback: path.join(REPO_ROOT, "dist/server.js"), label: "product dist/server.js" });
const OUTPUT = requiredPath({ flag: "--out", env: "M3_OUT", label: "run output root (outside the checkout)" });
const CACHE_ROOT = requiredPath({ flag: "--cache", env: "M3_CACHE", fallback: path.join(OUTPUT, "index-cache"), label: "index cache root (outside the checkout)" });
// a2-seeded-fill: the non-semantic control - lexical padded to K by a seeded
// shuffle, so "A3 fills more slots" is not mistaken for a dense gain.
const ARMS = ["a2-lexical", "a3-rrf-dense", "a2-seeded-fill"];
// Optional agent-layer evidence for the decision: an agent-ab.mjs results pack
// or a pilot-compare.mjs <name>-evidence.json.
const AGENT_PACK = cliValue("--agent-pack") ? path.resolve(cliValue("--agent-pack")) : null;

function findSqliteFiles(root) {
  const out = [];
  const walk = dir => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".sqlite")) {
        try {
          if (statSync(full).size > 0) out.push(full);
        } catch { /* ignore */ }
      }
    }
  };
  walk(root);
  return out;
}

const jsonl = file => readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));

function sourceSha() {
  const run = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain", "--", "src", "experiments", "scripts"], { cwd: REPO_ROOT, encoding: "utf8" });
  return `${run.stdout.trim()}${dirty.stdout.trim() ? "+dirty" : ""}`;
}

/** The task budget is part of the protocol: every task of the run must share it. */
function sharedBudget(tasks) {
  const budgets = new Set(tasks.map(task => JSON.stringify({
    max_regions: task.budget?.max_regions, max_lines: task.budget?.max_lines, max_bytes: task.budget?.max_bytes
  })));
  if (budgets.size !== 1) throw new Error(`tasks do not share one evidence budget: ${[...budgets].join(" | ")}`);
  return JSON.parse([...budgets][0]);
}

async function main() {
  if (!existsSync(path.join(STAGE, "gson")) || !existsSync(path.join(STAGE, "payments"))) {
    throw new Error(`${STAGE} is not a hydrated corpus root (expected <corpus>/ directories from harness hydrate-public)`);
  }
  const provider = embeddingProviderFromEnv(process.env, { cacheFile: path.join(CACHE_ROOT, "embeddings-cache.json") });
  mkdirSync(CACHE_ROOT, { recursive: true });
  mkdirSync(OUTPUT, { recursive: true });

  const tasks = jsonl(path.join(KIT, `dataset/prompts/${SPLIT}.jsonl`));
  const gold = new Map(jsonl(path.join(KIT, `dataset/gold/${SPLIT}.jsonl`)).map(row => [row.id, row]));
  for (const task of tasks) if (!gold.get(task.id)) throw new Error(`gold missing for ${task.id}`);
  const budget = sharedBudget(tasks);
  const hashes = kitHashes({ kitRoot: KIT, corporaRoot: STAGE });
  // The hydrate manifest (when present) pins the corpus; a modified stage is a different corpus.
  const manifestPath = `${STAGE}-manifest.json`;
  if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).corpus_hash !== hashes.corpus) {
    throw new Error(`${STAGE} no longer matches ${manifestPath} (corpus hash changed)`);
  }
  const profile = experimentProfile({
    question: "dense mechanism: A2 lexical vs A3 lexical+dense RRF on one SearchDocument representation (retrieval layer)",
    arms: ARMS,
    corpus: { mode: "external-full", corpusHash: hashes.corpus, datasetHash: hashes.dataset, split: SPLIT, taskIds: tasks.map(task => task.id) },
    representation: {
      searchDocument: "search_doc_text (product index schema v8)",
      dense: DENSE_REPRESENTATION_VERSION,
      query: QUERY_REPRESENTATION_VERSION
    },
    provider: provider.identityBase(),
    lexical: { tool: "java_symbol", limit: CANDIDATE_K, mode: "auto" },
    budget,
    scorer: { kit: "harness/scoring.py evaluate via harness score/compare", scorerHash: hashes.scorer, corpusMode: "external-full" }
  });
  const hash = protocolHash(profile);
  process.stderr.write(`[r11] protocol ${hash}\n`);

  const byCorpus = new Map();
  for (const task of tasks) byCorpus.set(task.corpus, [...(byCorpus.get(task.corpus) ?? []), task]);

  const results = Object.fromEntries(ARMS.map(arm => [arm, []]));
  const rows = [];
  const corpusCosts = [];
  const startedWall = Date.now();

  for (const [corpus, corpusTasks] of byCorpus) {
    const repoRoot = path.join(STAGE, corpus);
    const cacheRoot = path.join(CACHE_ROOT, `external-full-${corpus}`);
    process.stderr.write(`[r11] corpus=${corpus} tasks=${corpusTasks.length}\n`);
    const session = await openImpactSession({ repoRoot, serverJs: SERVER_JS, cacheRoot, env: process.env });
    let resolver = null;
    try {
      await session.symbol({ query: "java", limit: 1 }).catch(() => undefined);
      const found = existsSync(path.join(cacheRoot, "index.sqlite")) ? [path.join(cacheRoot, "index.sqlite")] : findSqliteFiles(cacheRoot);
      // Fail closed: without a dense index A3 would equal A2.
      if (found.length === 0) throw new Error(`dense index UNAVAILABLE for ${corpus}: index.sqlite not found under ${cacheRoot}`);
      const dbPath = found[0];
      // The warm-up query returns while the cold build may still run.
      await waitForReadyIndex(dbPath);
      const index = new DenseDiscoveryIndex({ provider, facts: readSearchDocumentFacts(repoRoot, dbPath), corpusHash: corpus, repoRoot });
      const declared = await index.build();
      if (declared === 0) throw new Error(`dense index for ${corpus} has no declarations`);
      corpusCosts.push({ corpus, dbPath, declarations: declared, ...index.buildCost, indexIdentity: index.providerIndexIdentity });
      process.stderr.write(`[r11]   dense index: ${declared} declarations, ${index.buildCost.deltaItemsEmbedded} embeddings\n`);
      resolver = new DeclarationResolver(dbPath);

      for (const task of corpusTasks) {
        const lexicalResult = await session.symbol({ query: task.query, limit: CANDIDATE_K });
        if (lexicalResult?.error) throw new Error(`java_symbol failed for ${task.id}: ${lexicalResult.error}`);
        // A PARTIAL scope means the index did not cover the request: not a valid A2 answer.
        if (lexicalResult?.scopeState === "PARTIAL") throw new Error(`java_symbol scope PARTIAL for ${task.id} (stopReason ${lexicalResult.stopReason})`);
        const lexicalIds = lexicalDeclarationIds(lexicalResult, CHANNEL_POOL_K);
        // Exact/anchored intents never embed (Z2 gate): A3 then equals A2.
        const gate = shouldRunDense({ query: task.query });
        let dense = [];
        let queryVectorSha256 = null;
        if (gate.run) {
          // A failed query embedding stops the run: a silent A2 fallback would
          // be scored as "no dense gain".
          const vector = await provider.embedQuery(task.query);
          queryVectorSha256 = createHash("sha256").update(JSON.stringify(vector)).digest("hex");
          dense = index.rank(vector, { topK: CHANNEL_POOL_K });
        }
        const fused = rrfFuse(lexicalIds, dense.map(entry => entry.declarationId));
        const a2 = renderEvidence({ declarationIds: lexicalIds, resolver, repoRoot, budget });
        const a3 = renderEvidence({ declarationIds: fused.map(entry => entry.declarationId), resolver, repoRoot, budget });
        const fill = renderEvidence({ declarationIds: seededFill(lexicalIds, index.rows.map(row => row.declarationId)), resolver, repoRoot, budget });
        results["a2-lexical"].push(kitResult(task.id, a2));
        results["a3-rrf-dense"].push(kitResult(task.id, a3));
        results["a2-seeded-fill"].push(kitResult(task.id, fill));
        rows.push({
          taskId: task.id,
          corpus,
          gate: gate.reason,
          queryVectorSha256,
          lexical: { ids: lexicalIds, truncated: lexicalResult?.truncated ?? null, scopeState: lexicalResult?.scopeState ?? null },
          dense: dense.map(({ declarationId, score, rank }) => ({ declarationId, score, rank })),
          fused,
          arms: {
            "a2-lexical": { finalCandidates: a2.finalCandidates, regions: a2.regions, emitted_lines: a2.emitted_lines, emitted_bytes: a2.emitted_bytes, dropped: a2.dropped },
            "a3-rrf-dense": { finalCandidates: a3.finalCandidates, regions: a3.regions, emitted_lines: a3.emitted_lines, emitted_bytes: a3.emitted_bytes, dropped: a3.dropped },
            "a2-seeded-fill": { finalCandidates: fill.finalCandidates, regions: fill.regions, emitted_lines: fill.emitted_lines, emitted_bytes: fill.emitted_bytes, dropped: fill.dropped }
          }
        });
        process.stderr.write(`[r11]   ${task.id} gate=${gate.reason} a2=${a2.finalCandidates.length}c/${a2.emitted_lines}l a3=${a3.finalCandidates.length}c/${a3.emitted_lines}l dense-only=${fused.filter(entry => entry.lexicalRank === null).length}\n`);
      }
    } finally {
      resolver?.close();
      await session.close?.().catch(() => undefined);
    }
  }

  // Score with the kit itself: one results pack per arm, then the paired,
  // cluster-bootstrap comparison.
  const scoreDir = path.join(OUTPUT, "kit-score");
  mkdirSync(scoreDir, { recursive: true });
  const runProfile = {
    corpus_mode: "external-full",
    corpus_hash: hashes.corpus,
    variant_set: "primary",
    evaluation_mode: "retrieval",
    repeats: 1,
    cache_state: "warm-declaration-and-query-vectors",
    model_id: null,
    host_id: "semantic-discovery-compare/r11",
    budget_profile: "fixed-160-lines-16000-bytes/v1",
    protocol_hash: hash
  };
  const reports = {};
  const reportPaths = {};
  for (const arm of ARMS) {
    const packPath = path.join(scoreDir, `${arm}-results.json`);
    reportPaths[arm] = path.join(scoreDir, `${arm}-report.json`);
    writeFileSync(packPath, `${JSON.stringify({
      schema: "java-specialist-results/v1",
      dataset_hash: hashes.dataset,
      run_profile: runProfile,
      arm,
      source_sha: sourceSha(),
      results: results[arm]
    }, null, 1)}\n`);
    reports[arm] = kitScorePack({ kitRoot: KIT, corporaRoot: STAGE, packPath, reportPath: reportPaths[arm], split: SPLIT });
  }
  const comparison = kitCompare({
    kitRoot: KIT,
    baselinePath: reportPaths["a2-lexical"],
    candidatePath: reportPaths["a3-rrf-dense"],
    outputPath: path.join(scoreDir, "a2-vs-a3-compare.json")
  });
  const fillComparison = kitCompare({
    kitRoot: KIT,
    baselinePath: reportPaths["a2-seeded-fill"],
    candidatePath: reportPaths["a3-rrf-dense"],
    outputPath: path.join(scoreDir, "fill-vs-a3-compare.json")
  });
  const strata = {};
  for (const [name, base] of [["a2-lexical", "a2-lexical"], ["a2-seeded-fill", "a2-seeded-fill"]]) {
    strata[`${name}->a3-rrf-dense`] = Object.fromEntries(["origin", "corpus"].map(by => [by, Object.fromEntries(
      ["declaration_recall_at_10", "mrr", "required_line_recall"].map(metric => [metric, stratifiedDelta(reports[base], reports["a3-rrf-dense"], metric, by)])
    )]));
  }
  const agentPack = AGENT_PACK ? JSON.parse(readFileSync(AGENT_PACK, "utf8")) : null;
  const gates = JSON.parse(readFileSync(path.join(KIT, "schemas/gates.json"), "utf8"));
  // An agent-ab results pack (agentEvidence) or a pilot-compare evidence file.
  const agentEvidence = agentPack?.agentEvidence ?? (agentPack && "qaDeltaLower" in agentPack ? agentPack : null);
  const decision = decideFourWay({ comparison, fillComparison, reports, gates, agent: agentEvidence });
  const totals = Object.fromEntries(ARMS.map(arm => [arm, {
    overall: reports[arm].summary.overall,
    ...evidenceTotals(reports[arm].rows, gold)
  }]));

  const pack = {
    schema: "java-specialist-r11-retrieval/v1",
    generatedAt: new Date().toISOString(),
    wallMs: Date.now() - startedWall,
    protocolHash: hash,
    profile,
    provider: provider.costReport(),
    decision,
    agentEvidence: agentEvidence ? { source: AGENT_PACK, ...agentEvidence } : null,
    comparison,
    fillComparison,
    strata,
    meanCandidates: Object.fromEntries(ARMS.map(arm => [arm, rows.reduce((sum, row) => sum + row.arms[arm].finalCandidates.length, 0) / rows.length])),
    totals,
    corpusCosts,
    rows
  };
  writeFileSync(path.join(OUTPUT, "results-pack.json"), `${JSON.stringify(pack, null, 1)}\n`);
  process.stdout.write(JSON.stringify({
    protocolHash: hash,
    decision,
    strataRecallAt10ByOrigin: strata["a2-lexical->a3-rrf-dense"].origin.declaration_recall_at_10,
    fillVsA3RecallAt10: fillComparison.metrics.declaration_recall_at_10 && {
      delta: fillComparison.metrics.declaration_recall_at_10.cluster_macro_delta,
      ci95: fillComparison.metrics.declaration_recall_at_10.cluster_bootstrap_95
    },
    totals: Object.fromEntries(Object.entries(totals).map(([arm, value]) => [arm, {
      recallAt10: value.overall.declaration_recall_at_10,
      mrr: value.overall.mrr,
      macroLineRecall: value.macroTask,
      microEvidence: value.microEvidence,
      meanEmittedBytes: value.overall.emitted_bytes,
      invalid: value.overall.invalid,
      overBudget: value.overall.over_budget
    }])),
    comparison: Object.fromEntries(Object.entries(comparison.metrics).map(([metric, value]) => [metric, value && {
      delta: value.cluster_macro_delta, ci95: value.cluster_bootstrap_95, clusters: value.clusters
    }]))
  }, null, 1));
}

main().catch(error => {
  process.stderr.write(`[r11] FAILED: ${error?.stack ?? error}\n`);
  process.exit(1);
});

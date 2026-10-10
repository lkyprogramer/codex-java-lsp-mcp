// input:  M3 开发语料（24 dev 任务、8 语料）+ 产品 MCP server（dist/server.js，
//         生产路径）+ OpenAI 兼容 embedding 端点（用户授权，见 embeddingProviderFromEnv）+ 仓库外 index cache。
// output: A2（产品 java_symbol 词法路线）vs A3（A2 + 外部 dense 提示）的检索层
//         对比：gold required_evidence 覆盖率（逐证据项 path+范围重叠）、
//         exact 负对照（0 次 embedding）、dense 建库/查询成本分账。
// pos:    docs/10 实验控制 —— 同一 SearchDocument 对齐表示上做 lexical/dense 对比；
//         预算等同，provider schema/token 开销进总账，建库成本另列摊销。
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openImpactSession } from "../../scripts/run-agent-trace-live.mjs";
import { createHash } from "node:crypto";
import { DenseDiscoveryIndex, cosine, embeddingProviderFromEnv, readSearchDocumentFacts, waitForReadyIndex } from "./provider.mjs";
import { gatedDenseSearch } from "./gate.mjs";
import { requiredLineRecall } from "./line-recall.mjs";

// 可搬运：语料根、索引缓存、输出目录、server.js 全部来自 CLI/env；没有个人
// 绝对路径默认值。STAGE 两种布局自动识别：
//  - full profile：full-stage/<corpus>/... （每语料一个目录，含全部任务的任务集）
//  - scoped：stage/<taskId>/repo（按任务 ID 分目录）
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
const STAGE = requiredPath({ flag: "--stage", env: "M3_STAGE", label: "stage root (corpus or per-task repo copies)" });
const STAGE_FULL = existsSync(path.join(STAGE, "gson")) || existsSync(path.join(STAGE, "ledger", "src"));
const PROFILE = STAGE_FULL ? "external-full" : "scoped";
const TASKS_FILES = (cliValue("--tasks") ?? process.env.M3_TASKS ?? "").split(",").filter(Boolean);
const GOLD_FILES = (cliValue("--gold") ?? process.env.M3_GOLD ?? "").split(",").filter(Boolean);
const SERVER_JS = requiredPath({ flag: "--server-js", env: "M3_SERVER_JS", fallback: path.join(REPO_ROOT, "dist/server.js"), label: "product dist/server.js" });
const OUTPUT = requiredPath({ flag: "--out", env: "M3_OUT", label: "run output root (outside the checkout)" });
const CACHE_ROOT = requiredPath({ flag: "--cache", env: "M3_CACHE", fallback: path.join(OUTPUT, "index-cache"), label: "index cache root (outside the checkout)" });

function overlap(evidence, startLine, endLine) {
  return startLine <= evidence.end_line && endLine >= evidence.start_line;
}

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

async function main() {
  const provider = embeddingProviderFromEnv(process.env, { cacheFile: path.join(CACHE_ROOT, "embeddings-cache.json") });
  const model = provider.model;
  mkdirSync(CACHE_ROOT, { recursive: true });
  mkdirSync(OUTPUT, { recursive: true });

  const taskLines = [...(TASKS_FILES.length ? [] : [path.join(KIT, "dataset/prompts/dev.jsonl")]), ...TASKS_FILES];
  const goldLines = [...(GOLD_FILES.length ? [] : [path.join(KIT, "dataset/gold/dev.jsonl")]), ...GOLD_FILES];
  const tasks = [];
  for (const file of taskLines) tasks.push(...(await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line)));
  const gold = new Map();
  for (const file of goldLines) for (const g of (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line))) gold.set(g.id, g);
  for (const task of tasks) {
    if (!gold.get(task.id)) throw new Error(`gold missing for ${task.id}`);
  }

  const byCorpus = new Map();
  for (const task of tasks) {
    const list = byCorpus.get(task.corpus) ?? [];
    list.push(task);
    byCorpus.set(task.corpus, list);
  }

  const rows = [];
  const corpusCosts = [];
  let negativeControlExact = 0;
  let negativeControlEmbedded = 0;
  const startedWall = Date.now();

  for (const [corpus, corpusTasks] of byCorpus) {
    const first = corpusTasks[0];
    // full 布局：STAGE/<corpus>；scoped 布局：STAGE/<task-id>/repo。
    const repoRoot = STAGE_FULL ? path.join(STAGE, corpus) : path.join(STAGE, first.id, "repo");
    const cacheRoot = path.join(CACHE_ROOT, `${PROFILE}-${corpus}`);
    process.stderr.write(`[m3] corpus=${corpus} tasks=${corpusTasks.length}\n`);

    const session = await openImpactSession({ repoRoot, serverJs: SERVER_JS, cacheRoot, env: process.env });
    let index = null;
    let denseBuild = null;
    let denseReady = false;
    try {
      // 产品 server 懒建 SQL 索引：先预热一次，再在 cacheRoot 下递归找 index.sqlite
      // （部分版本按 repoRoot hash 分子目录）。
      await session.symbol({ query: "java", limit: 1 }).catch(() => undefined);
      let dbPath = path.join(cacheRoot, "index.sqlite");
      const found = existsSync(dbPath) ? [dbPath] : findSqliteFiles(cacheRoot);
      if (found.length > 0) dbPath = found[0];
      denseBuild = { dbPath };
      if (found.length > 0) {
        // Fail closed: without a dense index A3 would equal A2 and the run
        // would report "no dense gain" as a result.
        {
          // The warm-up query returns while the cold build may still run.
          await waitForReadyIndex(dbPath);
          const facts = readSearchDocumentFacts(repoRoot, dbPath);
          index = new DenseDiscoveryIndex({ provider, facts, corpusHash: corpus, repoRoot });
          const declared = await index.build();
          denseReady = declared > 0;
          if (!denseReady) throw new Error(`dense index for ${corpus} has no declarations`);
          denseBuild = {
            dbPath,
            declarations: declared,
            ...index.buildCost,
            indexIdentity: index.providerIndexIdentity,
            indexedAt: index.indexedAt
          };
          process.stderr.write(`[m3]   dense index: ${declared} declarations, ${denseBuild.deltaItemsEmbedded} embeddings, ${(denseBuild.wallMs / 1000).toFixed(1)}s\n`);
        }
      } else {
        throw new Error(`dense index UNAVAILABLE for ${corpus}: index.sqlite not found under ${cacheRoot}`);
      }
      corpusCosts.push({ corpus, denseBuild });

      for (const task of corpusTasks) {
        const g = gold.get(task.id);
        // A2: production-path java_symbol。候选行范围 = preview 窗口（与 M2
        // SOURCE_RECEIVED 口径一致：path + startLine..endLine）；无 preview 时
        // 退化为 selection.line 单行。
      let a2 = undefined;
      try {
        a2 = await session.symbol({ query: task.query });
      } catch (error) {
        a2 = { error: error instanceof Error ? error.message : String(error) };
      }
        const a2Paths = (a2?.candidates ?? []).map(c => {
          const decl = c.declaration ?? {};
          if (typeof c.preview === "string" && c.previewKind === "source" && c.evidenceRange) {
            // The product reports the preview's own source range (R08).
            const range = c.evidenceRange;
            return { path: range.relativePath ?? decl.relativePath ?? c.relativePath, startLine: range.startLine, endLine: range.endLine };
          }
          const startLine = decl.selection?.line;
          return { path: decl.relativePath ?? c.relativePath, startLine, endLine: startLine };
        });
        // 行范围取候选的 read 窗口；M2 的 SOURCE_RECEIVED 口径是 (path, line) 命中证据。
        const a2Coverage = requiredLineRecall(a2Paths, g);

        // A3: A2 + gated dense hints (exact/anchor -> zero embeddings, negative control).
        // Query vectors are cached under cacheIdentity (the endpoint's output drifts
        // slightly between runs); the hash and top scores make a rerun attributable.
        let queryVector = null;
        const a3 = await gatedDenseSearch({
          query: task.query,
          index,
          provider,
          topK: 8,
          queryEmbed: async texts => {
            queryVector = await provider.embedQuery(texts[0]);
            return [queryVector];
          }
        }).catch(error => ({
          hints: [],
          fallback: "A2",
          reason: `gate_error: ${error instanceof Error ? error.message : String(error)}`,
          embeddedQueries: 0
        }));
        if (a3.reason === "exact_not_embedded") negativeControlExact += 1;
        else if (a3.embeddedQueries > 0) negativeControlEmbedded += 1;
        const a3Paths = [
          ...a2Paths,
          ...a3.hints.map(hint => ({
            path: hint.relativePath,
            startLine: hint.startLine,
            endLine: hint.endLine
          }))
        ];
        const a3Coverage = requiredLineRecall(a3Paths, g);
        rows.push({
          taskId: task.id,
          corpus,
          query: task.query,
          a2Candidates: (a2?.candidates ?? []).length,
          a2Error: a2?.error ?? null,
          a2Recall: a2Coverage.recall,
          a2UniqueLines: a2Coverage.uniqueLines,
          a2Complete: a2Coverage.complete,
          a2Incomplete: a2Coverage.incomplete,
          a3: {
            denseReason: a3.reason,
            denseHints: a3.hints.length,
            embeddedQueries: a3.embeddedQueries,
            topHint: a3.hints[0] ?? null,
            queryVectorSha256: queryVector ? createHash("sha256").update(JSON.stringify(queryVector)).digest("hex") : null,
            // cosine of the 9 best rows: rank 8 vs 9 is the cut, rank 1 vs 2 the top margin
            topScores: queryVector ? index.vectors.map(vector => cosine(queryVector, vector)).sort((a, b) => b - a).slice(0, 9) : [],
            recall: a3Coverage.recall,
            uniqueLines: a3Coverage.uniqueLines,
            malformedHints: a3Coverage.malformedRegions,
            pathOnlyHints: a3Coverage.pathOnlyRegions,
            complete: a3Coverage.complete,
            a3OnlyComplete: a3Coverage.complete.filter(item => !a2Coverage.complete.includes(item))
          }
        });
        process.stderr.write(`[m3]   ${task.id} a2=${a2Coverage.recall?.toFixed(2) ?? "n/a"} a3=${a3Coverage.recall?.toFixed(2) ?? "n/a"} reason=${a3.reason}\n`);
      }
    } finally {
      await session.close?.().catch(() => undefined);
    }
  }

  // Tasks without required evidence (recall null, as in the kit) are excluded.
  const mean = values => {
    const scored = values.filter(value => typeof value === "number");
    return scored.length ? scored.reduce((sum, value) => sum + value, 0) / scored.length : null;
  };
  const micro = {
    micro_a2: mean(rows.map(row => row.a2Recall)),
    micro_a3: mean(rows.map(row => row.a3.recall)),
    // A3 = A2 + hints, so it always emits at least as many lines: this is not
    // an equal-budget comparison (R11 caps both arms after fusion).
    mean_unique_lines_a2: mean(rows.map(row => row.a2UniqueLines)),
    mean_unique_lines_a3: mean(rows.map(row => row.a3.uniqueLines))
  };
  const perCorpus = new Map();
  for (const row of rows) {
    const entry = perCorpus.get(row.corpus) ?? { a2: [], a3: [] };
    entry.a2.push(row.a2Recall);
    entry.a3.push(row.a3.recall);
    perCorpus.set(row.corpus, entry);
  }
  const corpusAgg = [...perCorpus.entries()].map(([corpus, v]) => ({
    corpus,
    a2: mean(v.a2),
    a3: mean(v.a3)
  }));

  const pack = {
    schema: "java-specialist-m3-retrieval/v2",
    scorer: "required_line_recall (kit line_set semantics; path-only regions score 0)",
    budget: "UNEQUAL: a3 = a2 + up to 8 dense hints; not an R11 equal-budget result",
    generatedAt: new Date().toISOString(),
    wallMs: Date.now() - startedWall,
    profile: PROFILE,
    stage: STAGE,
    taskFiles: TASKS_FILES.length ? TASKS_FILES : ["dev.jsonl(default)"],
    provider: { ...provider.costReport(), model },
    arms: {
      a2: "product java_symbol (lexical, production MCP path)",
      a3: `a2 + external dense DISCOVERY_HINT (${provider.provider} ${model})`
    },
    micro,
    perCorpus: corpusAgg,
    negativeControl: { exactTasksNotEmbedded: negativeControlExact, textTasksEmbedded: negativeControlEmbedded },
    corpusCosts,
    rows
  };
  await writeFile(path.join(OUTPUT, "results-pack.json"), JSON.stringify(pack, null, 1));
  process.stdout.write(JSON.stringify({ micro, perCorpus: corpusAgg, negativeControl: pack.negativeControl, rows: rows.length }, null, 1));
}

main().catch(error => {
  process.stderr.write(`[m3] FAILED: ${error?.stack ?? error}\n`);
  process.exit(1);
});
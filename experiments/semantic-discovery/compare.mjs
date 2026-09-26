// input:  M3 开发语料（24 dev 任务、8 语料）+ 产品 MCP server（dist/server.js，
//         生产路径）+ OpenRouter embedding（用户授权）+ 仓库外 index cache。
// output: A2（产品 java_symbol 词法路线）vs A3（A2 + 外部 dense 提示）的检索层
//         对比：gold required_evidence 覆盖率（逐证据项 path+范围重叠）、
//         exact 负对照（0 次 embedding）、dense 建库/查询成本分账。
// pos:    docs/10 实验控制 —— 同一 SearchDocument 对齐表示上做 lexical/dense 对比；
//         预算等同，provider schema/token 开销进总账，建库成本另列摊销。
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openImpactSession } from "../../scripts/run-agent-trace-live.mjs";
import { DenseDiscoveryIndex, EmbeddingProvider, readSearchDocumentFacts } from "./provider.mjs";
import { gatedDenseSearch } from "./gate.mjs";

const KIT = "/Users/luo/Documents/github/codex-java-lsp-mcp/docs/java-specialist-devkit-v1";
// M3_STAGE：语料根目录。两种布局自动识别：
//  - full profile：full-stage/<corpus>/... （每语料一个目录，含全部任务的任务集）
//  - scoped：m1-stage/JSB-XXX/repo、locked-stage/JSB-XXX/repo（按任务 ID 分目录）
const STAGE = process.env.M3_STAGE ?? "/Users/luo/Documents/github/java-devkit-v1-runs/m1/m1-quality/stage";
const STAGE_FULL = existsSync(path.join(STAGE, "gson")) || existsSync(path.join(STAGE, "ledger", "src"));
const PROFILE = STAGE_FULL ? "external-full" : "scoped";
const TASKS_FILES = (process.env.M3_TASKS ?? "").split(",").filter(Boolean);
const GOLD_FILES = (process.env.M3_GOLD ?? "").split(",").filter(Boolean);
const CACHE_ROOT = process.env.M3_CACHE ?? "/Users/luo/Documents/github/java-devkit-v1-runs/m3/index-cache";
const SERVER_JS = "/Users/luo/Documents/github/codex-java-lsp-mcp/dist/server.js";
const OUTPUT = process.env.M3_OUT ?? "/Users/luo/Documents/github/java-devkit-v1-runs/m3/retrieval-comparison";

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

/**
 * 证据项被覆盖：同一路径上，候选/提示的行范围与该证据项范围相交。
 * 提示无行范围（path-only）时仅当该文件的其他候选也覆盖到才不算——
 * 检索层口径按 docs/06：证据按 (path, start_line) 匹配，行范围缺失视为整文件候选。
 */
function coverage(pathsWithRanges, gold) {
  const covered = [];
  const missed = [];
  for (const evidence of gold.required_evidence ?? []) {
    const hit = (pathsWithRanges ?? []).some(c => {
      if (c.path !== evidence.path) return false;
      if (c.startLine == null || c.endLine == null) return true; // path-only: whole file
      return overlap(evidence, c.startLine, c.endLine);
    });
    (hit ? covered : missed).push(`${evidence.path}:${evidence.start_line}-${evidence.end_line}`);
  }
  return { covered, missed, recall: gold.required_evidence?.length ? covered.length / gold.required_evidence.length : 1 };
}

async function main() {
  const apiKey = process.env.EMBEDDING_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("EMBEDDING_NOT_AUTHORIZED: no embedding API key");
  const model = process.env.OPENROUTER_EMBEDDING_MODEL ?? "liquid/lfm-2.5-embedding-350m:free";
  const provider = new EmbeddingProvider({
    apiKey,
    model,
    baseUrl: process.env.EMBEDDING_BASE_URL ?? "https://openrouter.ai/api/v1",
    timeoutMs: 60_000,
    cacheFile: path.join(process.env.M3_CACHE ?? "/Users/luo/Documents/github/java-devkit-v1-runs/m3/index-cache", "embeddings-cache.json")
  });
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
        try {
          const facts = readSearchDocumentFacts(repoRoot, dbPath);
          index = new DenseDiscoveryIndex({ provider, facts, corpusHash: corpus, repoRoot });
          const declared = await index.build();
          denseReady = declared > 0;
          denseBuild = {
            dbPath,
            declarations: declared,
            ...index.buildCost,
            indexIdentity: index.providerIndexIdentity,
            indexedAt: index.indexedAt
          };
          process.stderr.write(`[m3]   dense index: ${declared} declarations, ${denseBuild.deltaItemsEmbedded} embeddings, ${(denseBuild.wallMs / 1000).toFixed(1)}s\n`);
        } catch (error) {
          denseBuild = { dbPath, unavailable: true, reason: error instanceof Error ? error.message : String(error) };
          process.stderr.write(`[m3]   dense index UNAVAILABLE: ${denseBuild.reason}\n`);
        }
      } else {
        denseBuild = { ...denseBuild, unavailable: true, reason: "index.sqlite not found under cacheRoot" };
        process.stderr.write(`[m3]   dense index UNAVAILABLE: ${denseBuild.reason}\n`);
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
          const relPath = decl.relativePath ?? c.relativePath;
          let startLine = decl.selection?.line;
          let endLine = startLine;
          if (typeof c.preview === "string" && c.previewKind === "source") {
            const lines = c.preview.split(/(?<=\r\n|\n|\r)/);
            if (lines[lines.length - 1] === "") lines.pop();
            startLine = decl.selection?.line;
            endLine = startLine != null ? startLine + lines.length - 1 : undefined;
          }
          return { path: relPath, startLine, endLine };
        });
        // 行范围取候选的 read 窗口；M2 的 SOURCE_RECEIVED 口径是 (path, line) 命中证据。
        const a2Coverage = coverage(a2Paths, g);

        // A3: A2 + gated dense hints (exact/anchor -> zero embeddings, negative control).
        const a3 = await gatedDenseSearch({
          query: task.query,
          index,
          provider,
          topK: 8
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
        const a3Coverage = coverage(a3Paths, g);
        rows.push({
          taskId: task.id,
          corpus,
          query: task.query,
          a2Candidates: (a2?.candidates ?? []).length,
          a2Error: a2?.error ?? null,
          a2Recall: a2Coverage.recall,
          a2Covered: a2Coverage.covered,
          a2Missed: a2Coverage.missed,
          a3: {
            denseReason: a3.reason,
            denseHints: a3.hints.length,
            embeddedQueries: a3.embeddedQueries,
            topHint: a3.hints[0] ?? null,
            recall: a3Coverage.recall,
            covered: a3Coverage.covered,
            a3OnlyGained: a3Coverage.covered.filter(item => !a2Coverage.covered.includes(item))
          }
        });
        process.stderr.write(`[m3]   ${task.id} a2=${a2Coverage.recall.toFixed(2)} a3=${a3Coverage.recall.toFixed(2)} reason=${a3.reason}\n`);
      }
    } finally {
      await session.close?.().catch(() => undefined);
    }
  }

  const micro = {
    micro_a2: rows.reduce((sum, row) => sum + row.a2Recall, 0) / rows.length,
    micro_a3: rows.reduce((sum, row) => sum + row.a3.recall, 0) / rows.length
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
    a2: v.a2.reduce((s, x) => s + x, 0) / v.a2.length,
    a3: v.a3.reduce((s, x) => s + x, 0) / v.a3.length
  }));

  const pack = {
    schema: "java-specialist-m3-retrieval/v1",
    generatedAt: new Date().toISOString(),
    wallMs: Date.now() - startedWall,
    profile: PROFILE,
    stage: STAGE,
    taskFiles: TASKS_FILES.length ? TASKS_FILES : ["dev.jsonl(default)"],
    provider: { ...provider.costReport(), model },
    arms: {
      a2: "product java_symbol (lexical, production MCP path)",
      a3: "a2 + external dense DISCOVERY_HINT (openrouter liquid/lfm-2.5-embedding-350m)"
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
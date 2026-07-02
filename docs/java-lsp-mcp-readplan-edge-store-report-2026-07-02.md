# readPlan EdgeStore Phase 3 验收报告

日期：2026-07-02

## 结论

Phase 3 已完成并通过 gate。

- 新增 `EdgeStore` 持久语义边表，warm-required LSP verify 成功结果会写入 `semantic-edges.jsonl`。
- cold/fast 路径会消费持久边，且 `semanticPolicy=required` 跳过持久边，由 live LSP 负责。
- 三仓空边表 cold 基线不回退，`R_read_must=1.0000`。
- lishuedu warm 建边后 cold recall 从 `0.8206` 提升到 `0.8456`，`R_read_must` 保持 `1.0000`。
- `persistedSemantic` cold 延迟 P95 为 `0ms`，max `1ms`。
- MCP public tools 入参/出参 schema 未改；默认 `readPlanMaxItems=6` 未改。

本阶段修复了两个 gate 中暴露的问题：JDT LS documentSymbol 默认单次 timeout 对 lishuedu warm-required 过短；重复 reference 边会放大 application service 分数并挤掉 repository/persistence must 文件。

## 输入状态

| repo | path | git state |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, commit `994bdf5`, clean |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf`, `develop...origin/develop [ahead 1]` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `638226e`, `develop...origin/develop [ahead 5]`, dirty working tree |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da8`, `develop-v2...origin/develop-v2 [ahead 3]` |

cipherlink dirty 文件同 Phase 2 报告，均为本任务外部既有改动，未触碰。

## 本阶段实现

- `src/edge-store.ts`
  - 持久化 `reference / implementation / typeHierarchy` 语义边。
  - 以 anchor 文件 mtime 做失效判断。
  - 过滤已删除 target。
  - 写入时按 `kind + target` 去重，避免重复引用位置放大分数。

- `src/agent-router/index.ts`
  - required semantic verify 成功后写回 EdgeStore。
  - cold/fast 查询在 typeGraph 之前消费持久语义边。
  - 读取旧边表时再次按 `kind + target` 去重。
  - `persisted-reference` 作为弱 fanout 边加分；`typeHierarchy / implementation` 保留更强结构加分。

- `src/benchmark-agent-impact.ts`
  - warm-required benchmark semantic timeout 提到 `10000ms`。
  - benchmark timing 透传 `persistedSemantic`。

## 失败门禁与修复

| 问题 | 证据 | 修复 |
| --- | --- | --- |
| `warm-required` 默认失败 | `textDocument/documentSymbol after 3000ms`，进程退出 1，未生成边表 | `documentSymbolsWithRetry` 默认 attempt timeout 从 `3000ms` 调到 `10000ms`，仍受总 retry budget 控制 |
| warm 成功但 stderr 非空 | 两次 `textDocument/implementation after 1500ms` | benchmark 在 `warm-required` 下使用 `semanticTimeoutMs=10000` |
| cold-after must 回退 | lishuedu `report-reusable-zip` 的 `ReportBatchExportTaskDO` / `Mapper` 被 readPlan 挤出，`R_read_must=0.9000` | 写入/读取持久边去重；降低 `persisted-reference` fanout 分数 |

## 验证命令

基础验证：

```bash
npm run build
node --test dist/benchmark-agent-impact.test.js dist/edge-store.test.js dist/agent-router.test.js
npm test
git diff --check
```

真实仓库 gate：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p3-lishuedu-cold.json 2> /tmp/rp-p3-lishuedu-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p3-cipherlink-cold.json 2> /tmp/rp-p3-cipherlink-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p3-exam-parent-v3-cold.json 2> /tmp/rp-p3-exam-parent-v3-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 1 --verbosity diagnostic > /tmp/rp-p3-lishuedu-warm.json 2> /tmp/rp-p3-lishuedu-warm.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p3-lishuedu-cold-after.json 2> /tmp/rp-p3-lishuedu-cold-after.err
```

## 测试结果

| Check | Result |
| --- | --- |
| build | PASS: `npm run build` exited 0. |
| 定向 tests | PASS: `node --test dist/benchmark-agent-impact.test.js dist/edge-store.test.js dist/agent-router.test.js` reported 42 tests, 39 pass, 0 fail, 3 skipped. |
| 全量 tests | PASS: `npm test` reported 106 tests, 102 pass, 0 fail, 4 skipped. |
| diff hygiene | PASS: `git diff --check` exited 0. |
| benchmark stderr | PASS: five gate stderr files all 0 bytes. |
| EdgeStore status | PASS: lishuedu cache has 5 anchors and 20 de-duplicated edges after warm-required. |

## Benchmark totals

| project/run | warmState | semanticPolicy | recall | precision | P_read | R_read_must | readPlanItems | readingPayload P50 | elapsed P50/P95 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu cold-empty | cold-nolsp | fast | 0.8206 | 0.4418 | 0.8333 | 1.0000 | 6 | 9863 | 10.50 / 230.88 ms |
| lishuedu warm-build | warm-required | required | 0.8256 | 0.4139 | 0.8000 | 1.0000 | 6 | 10790 | 1450.96 / 4982.06 ms |
| lishuedu cold-after | cold-nolsp | fast | 0.8456 | 0.4509 | 0.8667 | 1.0000 | 6 | 9863 | 8.40 / 196.46 ms |
| cipherlink cold-empty | cold-nolsp | fast | 0.8357 | 0.3700 | 0.7000 | 1.0000 | 6 | 5490 | 4.62 / 211.95 ms |
| exam-parent-v3 cold-empty | cold-nolsp | fast | 0.5800 | 0.2335 | 0.4667 | 1.0000 | 6 | 5630 | 7.71 / 137.37 ms |

## persistedSemantic

| metric | value |
| --- | ---: |
| cold-after attempts | 25 |
| phase P50 | 0 ms |
| phase P95 | 0 ms |
| phase max | 1 ms |
| edgesSeen total | 100 |
| addedCandidates total | 100 |

## Attribution

统计口径：只统计 `kind=should` 且 `shouldBlocksTask=true` 的 first attempt golden attribution。

| run | must miss | should hit | should readplan-full | should absent | no-type-edge | cross-module-cold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu cold-empty | 0 | 4 | 5 | 5 | 1 | 2 |
| lishuedu cold-after | 0 | 4 | 6 | 4 | 0 | 2 |

## 判定

1. Phase 3 的最小架构反转成立。
   - warm-required 建边的 LSP 成本没有进入 cold/fast 查询路径。
   - cold-after recall 提升，`R_read_must` 不回退，elapsed P95 仍是 cold 量级。

2. EdgeStore 不应直接当作无限高权重语义真相。
   - references 是 fanout 边，重复位置必须去重。
   - `persisted-reference` 只能作为弱冷召回；否则 repository 场景会被上层 application service 挤占。

3. Phase 3 未解决 cross-module-cold。
   - lishuedu `cross-module-cold=2` 未变化。
   - 该类缺口需要后续更明确的跨模块边来源，不应在本阶段扩大扫描或提高 slot。

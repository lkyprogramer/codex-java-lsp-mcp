# JIN N4 失败 postmortem（2026-08-21）

**状态（2026-08-21）**：本文是过早套用 JIN-N4-04 二元裁决的记录（`5b6f2aa`）。2 周窗口从 2026-08-20 起算，尚未到期。neighborhood T3 为 **1/4**（lishuedu p95Ratio 1.617）。restore 收回 discovery 后 **2/4**。holdout 字段调用名（`3fb6180`）仍是 **2/4**（p95 0.335/0.143/0.161），MeQueryService / SchoolQueryService / ExcelGenerator / SignedUrl DTO 仍缺。主链停在 N4，不进 N5，不合 `main`。

## 条款（窗口到期才停主链；当前禁止 N5）

15A.6 **JIN-N4-04** 失败处置原文：

> 2 周内未全达 → 二元裁决：达标 ≥ 3/4 轴则记 PARTIAL 并进 N5（live 数据可能改判），**< 3/4 轴 → 停止 JIN 主链开发**，写 postmortem，escalate（属方案核心假设失败）。

N4 最好 T3 四轴 **2/4**（discovery：token GO、p95 GO、RangeLineRecall FAIL、holdout rReadMust FAIL）。本轮 neighborhood **1/4**（token GO，lishuedu p95Ratio 1.617 FAIL）。**2 < 3**，窗口内不得记 PARTIAL、不得开工 N5。窗口到期后若仍 < 3/4，才 escalate 0A.4(4b)：图 planner 无法在 ≥25% token 下降的同时保住 RangeLineRecall / holdout rReadMust。

## 测到的张力（不是调参没调够）

| 策略 | token | RangeLineRecall | holdout rReadMust |
|---|---|---|---|
| hop≤2 全收 + 空 discovery 路径 | 2万+ FAIL | 虚高 | pRead 崩 |
| selected-only + ratio greedy | GO ~1400 | ~0.35 | 均值 0.36 |
| hop-order 填满预算 | FAIL ~20% | 几乎不动 | 均值 0.30 |
| 证明路径 method + 预算 2000 | GO ~1600–1800 | ~0.53–0.58 | 均值 0.30–0.33 |
| 锚点邻域 discovery | GO ~1700–1800 | 0.582 / 0.850 / 0.558 | 均值 **0.300** |
| method-body callees + hop-2 field types | GO 1844/1671/2013 | 0.482 / 0.850 / 0.558 | 均值 **0.300**；lishuedu p95Ratio **1.617** FAIL |
| restore discovery | GO 1775/1671/1855 | 0.582 / 0.850 / 0.558 | 均值 **0.300**；p95 0.327/0.135/0.157 |
| hop-1 field callee names, extraNames containing-only | GO 1822/1671/1853 | 0.582 / 0.850 / 0.558 | 均值 **0.267**；p95 0.335/0.143/0.161 |
| all field-callee names + hop-2 CALLS only | GO 1730/1539/1872 | 0.582 / 0.850 / 0.558 | 均值 **0.300**；p95 0.316/0.141/0.159 |

多选文件丢掉 25% token 门，还不抬 Range（要 span 完整覆盖 golden 行）。少选文件保住 token/p95，holdout 文件（MeQueryService、SchoolQueryService、ExcelGenerator、SignedUrl DTO）仍不在选中集。这是候选闭包与预算的结构冲突，不是再跑一轮 T3 能抹平的残差。

## 已落地、可保留

- N0/N0.5 compact wire + 实体入口（token −27%，质量 identity）
- N1/N2a 知识图（RSS 512 MiB 门仍 FAIL，已记录、未放宽）
- N3 `QUERY_CONTEXT_GRAPH` 文件 mustHit 1.00 / 1.00 / 0.962
- `JAVA_LSP_ENGINE=jin` 仍只在 benchmark 读取；生产 MCP 不读
- 未合 `main`

## N5 / N6

- **N5 未开工**：`java_context` 与三臂 live A/B 不开工。N5 准入是 N4 ≥3/4 PARTIAL，或 2 周窗口到期后的二元裁决。`5b6f2aa` 的 SKIP_FAIL 过早。
- **N6 未开工**：不删旧链、不合 `main`。N6 硬门含 §16.3 全过 + 第四仓 + leave-one-repo-out。

回滚点：分支 `codex/jin-main`。N4 最好证据是 `301bf49`（token+p95 2/4）。neighborhood `4bff986` 已回退。不回滚已入库的 N0–N3 证据。

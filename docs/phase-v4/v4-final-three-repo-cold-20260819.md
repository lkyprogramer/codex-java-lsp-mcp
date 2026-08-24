# V4 最终三仓 cold 矩阵（2026-08-19）

正式配对矩阵：`scripts/run-three-repo-cold-matrix.mjs --runs 5`，轮次 AB/BA/AB（`old/new`、`new/old`、`old/new`），cold-nolsp（`JDTLS_BIN=/usr/bin/false`）。  
这是当前工作区相对 Sprint0' 分母的质量真源，不是 V4-06 当时那几棵旧 SHA。

## 身份

| 侧 | 身份 |
|---|---|
| old / 分母 | Sprint0' `63a80a2`（`docs/phase-v4/v4-sprint0-manifest.json` 的 `measuredCommit`） |
| new | `4130e3a` + 工作区 patch（V4-07…V4-13）；executableTree `a56af2f9d469f8f0e7b47dd7bbc54d3f98778159` |
| lishuedu | `db63b1a7e393edd90449eb013d7d1c4d65c366f2` |
| cipherlink | `fa433982e92e52dd610650d1e79f2d041179b1d3` |
| exam-parent-v3 | `f90a0b475f7be2ed003703feecec8195bc7eb976` |

主机：1 分钟 load **7.70 < 20**（必须执行），可用内存 11.56 GiB ≥ 4 GiB。`refuse=false`。

## 产物（checkout 外）

目录：`/tmp/codex-java-lsp-v4-final-cold-20260819-171144/`

| 文件 | SHA-256 |
|---|---|
| `matrix-summary.json` | `95aa6e0f04febeee68407f5e2954020ed5c901c2316facb24472e684367d82a2` |
| `run-manifest.json` | `ff9626a9478b1475eca9e7e20874142b8d550e22f1b07ed8470024fa8056b216` |
| `candidate.patch` | `5aeb953955619bef6d6f9cd070dd098da12e7db440d479a29c5b60e969781947` |

入库摘要副本：`docs/phase-v4/v4-final-three-repo-cold-20260819-summary.json`（同上 SHA-256）。  
18 个 raw cell 只留在 `/tmp/.../matrix/`，不入库。

候选测试：隔离 **159/159**。脚本 **exit 1** = 配对/绝对质量门槛 FAIL（分母），矩阵本身跑完了。

## 总表（new vs Sprint0' old）

| 仓 | recall old→new | pRead old→new | rReadMust new | RangeLineRecall old→new | holdout rReadMust old→new | tokens P50 old→new | p95Ratio | gate |
|---|---|---|---|---|---|---|---|---|
| lishuedu | 0.7923→**0.7986** | 0.7083→**0.7217** | 0.925 | 0.634→**0.842** | 0.500→**0.625** | 4308→4662（+354） | **1.053** | FAIL |
| cipherlink | 0.8158→**0.8390** | 0.6433→**0.6633** | 0.910 | 0.850→**0.875** | 0.550→0.550 | 3606→4422（+816） | **2.035** | FAIL |
| exam-parent-v3 | 0.7095→**0.6970** | 0.5833→**0.6000** | 0.880 | 0.553→**0.853** | 0.400→0.400 | 3395→3869（+474） | **1.777** | FAIL |

`p95Limit=1.25`。lishuedu 延迟门过了；cipherlink / exam 没过。三仓 `estimatedTokens` 相对 Sprint0' 都升了。

## 门槛拆开（`projects[].gate`）

绝对 1.0（V4 计划 §9 / V4-06 已标 residual，本轮未重开）：

- `rangeLineRecall` / `rangeCoordinateRecall`：三仓都 false（new 均值 0.842 / 0.875 / 0.853，不是 1.0）
- `rReadMust`：三仓都 false（0.925 / 0.910 / 0.880）
- `holdoutRReadMust`：三仓都 false（0.625 / 0.550 / 0.400）

相对 Sprint0' 的配对门：

- lishuedu：`p95` true；`estimatedTokens` false
- cipherlink：`p95` false（2.035）；`rTaskBlocking` false；`estimatedTokens` false
- exam-parent-v3：`recall` false（−0.0125）；`p95` false（1.777）；holdout `pRead` / `rTaskBlocking` false；`estimatedTokens` false

new 侧仍 miss 的 holdout 场景：

- lishuedu：`exam-score-export-cross-module-holdout`、`paper-task-claim-iam-holdout`
- cipherlink：`client-release-storage-presign-holdout`、`backend-operation-log-aspect-async-audit-holdout`
- exam-parent-v3：`exam-room-print-download-types-persistent-bundle`、`candidate-pay-order-cross-module-admission`

## 怎么读

1. **矩阵已跑完、可复核**，不是缺报告。
2. **exit 1 是质量门槛 FAIL**，与 V4-06 `CLOSED_WITH_RESIDUAL_STRUCTURAL_MISSES` 一致：RangeLineRecall / holdout rReadMust 仍不是 1.0。
3. 相对 Sprint0'：**range 均值明显抬升**（尤其 exam 0.55→0.85、lishuedu 0.63→0.84）；**延迟和 token 变差**（cipherlink p95 约 2×，三仓 token P50 都升）。
4. 这不能拿来宣称 V4 §9 收口。storm ≤1.10、Agent Token −10%、LOC 净下降、合 `main` 仍未满足。

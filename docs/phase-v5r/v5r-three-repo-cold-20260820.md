# V5R 三仓 cold 矩阵（2026-08-20）

正式配对矩阵：`scripts/run-three-repo-cold-matrix.mjs --runs 5`，轮次 AB/BA/AB（`old/new`、`new/old`、`old/new`），cold-nolsp（`JDTLS_BIN=/usr/bin/false`）。  
分母仍是 Sprint0' `63a80a2`。这是 V5R §15 收尾补跑的质量真源，不是身份推断。

先前 Phase 2–6 closeout 以 first-plan identity 为由 **SKIPPED**。主机 1 分钟 load **9.35 < 20**，按 `docs/phase-v4/three-repo-host-load-policy.md` **必须执行**；本轮已跑完并留下报告。

## 身份

| 侧 | 身份 |
|---|---|
| old / 分母 | Sprint0' `63a80a2a0b4e9947bbf94a454ae1d14ece64dca9`（executableTree `cb34acd5`） |
| new | `bcf547c` + 白名单未跟踪脚本 `scripts/run-v324-import-concurrency-experiment.mjs`（无 `src/` 改动）；executableTree `04b7fe5cd9a6316a681ea258a5d40beede3194cb` |
| lishuedu | `db63b1a7e393edd90449eb013d7d1c4d65c366f2` |
| cipherlink | `fa433982e92e52dd610650d1e79f2d041179b1d3` |
| exam-parent-v3 | `f90a0b475f7be2ed003703feecec8195bc7eb976` |

冻结场景 SHA-256 与 V4-final（`docs/phase-v4/v4-final-three-repo-cold-20260819.md`）逐仓相同：lishuedu `fba58bb3…`、cipherlink `e60dfebc…`、exam-parent-v3 `da84c560…`。三仓 HEAD 也相同。

主机：1 分钟 load **9.35 < 20**（必须执行），可用内存 9.95 GiB ≥ 4 GiB。`refuse=false`。开始 09:43:34 CST，结束 09:53:38 CST（约 604s）。

候选隔离测试：dist **1068/1068**、scripts **170/170**，fail 0。

## 产物（checkout 外）

目录：`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/grok-goal-a7d58b79e146/implementer/v5r-three-repo-cold-20260820/`

| 文件 | SHA-256 |
|---|---|
| `matrix-summary.json` | `db0306870e8165357923763534a43897b461146afc5211c68598e1b218b5d31d` |
| `run-manifest.json` | `47242fd3359b2f667ed77d013e536fe6975e55287ada702681079c4d1bb132a6` |
| `candidate.patch` | `5a82a8e876ca2689b98e2b063d801a9ace70ef8ee93018c05f787d454891628b` |

入库摘要副本：`docs/phase-v5r/v5r-three-repo-cold-20260820-summary.json`（同上 SHA-256）。  
18 个 raw cell 只留在上述 output 的 `matrix/`，不入库。

`matrix-summary.json.passed = false`。独立复验 `verify-three-repo-cold-matrix.mjs --expected-runs 5 --p95-limit 1.25` **exit 1**。  
（主命令包装里曾打印 `exit:0`，不可用：`echo "end $(date) exit:$?"` 中 `$(date)` 会冲掉矩阵进程的 `$?`。质量结论以 summary / verifier 为准。）

## 总表（new vs Sprint0' old）

| 仓 | recall old→new | pRead old→new | rReadMust new | RangeLineRecall old→new | holdout rReadMust old→new | tokens P50 old→new | p95Ratio | gate |
|---|---|---|---|---|---|---|---|---|
| lishuedu | 0.7923→**0.7986** | 0.7083→**0.7217** | 0.925 | 0.634→**0.842** | 0.500→**0.625** | 4308→4683（+375） | **1.095** | FAIL |
| cipherlink | 0.8158→**0.8390** | 0.6433→**0.6633** | 0.910 | 0.850→**0.875** | 0.550→0.550 | 3606→4443（+837） | **2.115** | FAIL |
| exam-parent-v3 | 0.7095→**0.6970** | 0.5833→**0.6000** | 0.880 | 0.553→**0.853** | 0.400→0.400 | 3395→3890（+495） | **1.828** | FAIL |

`p95Limit=1.25`。lishuedu 延迟门过了；cipherlink / exam 没过。三仓 `estimatedTokens` 相对 Sprint0' 都升了。

## 与 V4-final 对照（同一分母、同一冻结场景）

V4-final 真源：`docs/phase-v4/v4-final-three-repo-cold-20260819.md`，candidate `4130e3a` + V4 patch。

| 字段 | 三仓结果 |
|---|---|
| recall / pRead / rReadMust / rTaskBlocking / RangeLineRecall / holdout 全套 / `projects[].gate` / must-fail 场景 | **与 V4-final 逐位相同** |
| `readPlanBytes` / `readingPayload` P50·P95（抽查 lishuedu-r1-new） | **相同**（8597.3 / 7411 / 13372） |
| new `estimatedTokens` P50 | 三仓都比 V4-final new **+21**（4683/4443/3890 vs 4662/4422/3869） |
| old `estimatedTokens` P50 | **与 V4-final old 相同**（4308/3606/3395） |
| p95Ratio | 主机噪声（1.095/2.115/1.828 vs V4-final 1.053/2.035/1.777）；门槛真假与 V4-final 相同 |

lishuedu-r1-new 单格：`rawSearchPayload` 9448→9533（**+85 字节**），`totalAgentVisiblePayload` 16635→16720，`estimatedTokens` 4159→4180。ceil(85/4) 解释 +21 token。读计划本身没变。最可能是 V5R diagnostic（frontier shadow / cost proxy / planner shadow）进了 search/result payload，而不是选文变化。未把 85 字节拆到具体字段。

## 门槛拆开（`projects[].gate`）

绝对 1.0（V4 residual，V5R 未重开、也未放宽）：

- `rangeLineRecall` / `rangeCoordinateRecall`：三仓都 false（new 均值 0.842 / 0.875 / 0.853，不是 1.0）
- `rReadMust`：三仓都 false（0.925 / 0.910 / 0.880）
- `holdoutRReadMust`：三仓都 false（0.625 / 0.550 / 0.400）

相对 Sprint0' 的配对门：

- lishuedu：`p95` true；`estimatedTokens` false
- cipherlink：`p95` false（2.115）；`rTaskBlocking` false；`estimatedTokens` false
- exam-parent-v3：`recall` false（−0.0125）；`p95` false（1.828）；holdout `pRead` / `rTaskBlocking` false；`estimatedTokens` false

new 侧仍 miss 的 holdout 场景（与 V4-final 相同）：

- lishuedu：`exam-score-export-cross-module-holdout`、`paper-task-claim-iam-holdout`
- cipherlink：`client-release-storage-presign-holdout`、`backend-operation-log-aspect-async-audit-holdout`
- exam-parent-v3：`exam-room-print-download-types-persistent-bundle`、`candidate-pay-order-cross-module-admission`

## 怎么读

1. **矩阵已跑完、可复核**，不是身份跳过、也不是缺报告。
2. **质量门 FAIL**（exit 1 / `passed=false`），与 V4-final 同一套绝对 1.0 residual：RangeLineRecall / holdout rReadMust 仍不是 1.0。
3. 相对 Sprint0'：range 均值仍明显高于分母；延迟和 token 仍差。这是 V4 已有的形态，不是 V5R 新回归。
4. 相对 V4-final：**first-plan 质量 identity 成立**；token P50 有系统的 +21（search payload +85B），不改变 gate 真假。
5. 这不能拿来宣称 TaskSuccess，也不能合 `main`。λ 仍 `CALIBRATED_OFFLINE`；live-trace 仍 `BLOCKED_EXTERNAL`。

# V4-06 range / holdout 进展（2026-08-19）

## 主机政策

用户确认：三仓测试在 1 分钟 load < 20 时必须执行，不得因 load 阻断。已固化：

- `docs/phase-v4/three-repo-host-load-policy.md`
- `scripts/host-quiet.mjs`：`THREE_REPO_LOADAVG_PROCEED_BELOW = 20`，`refuse` 恒为 false
- `.cursor/rules/three-repo-load-gate.mdc`
- `HANDOFF.md` / 三仓 runbook / V4 计划 §7.5

唯一主机硬门仍是可用内存 ≥ 4 GiB。

## 上一轮 hydrate 矩阵（已完成，勿当本轮分母）

产物：`/tmp/codex-java-lsp-v4-06-hydrate-20260818-233402/`  
baseline `df2ca1f`，candidate `f0e2ef1`，`--runs 5`。候选测试 158/158。exit 1 = 质量绝对门槛 FAIL（分母），不是 hydrate 回归。

| 仓 | RangeLineRecall old→new | holdout rReadMust | tokens P50 |
|---|---|---|---|
| lishuedu | 0.634 → **0.734** | 0.5 | 4308 → 4496（+188） |
| cipherlink | 0.85 → 0.85 | 0.55 | 3606 不变 |
| exam-parent-v3 | 0.5525 → 0.5525 | 0.40 | 3395 不变 |

lishuedu 闭合：`storage-signed-url` 0.5→1、`report-reusable-zip` 0.5→1。

## hydrate 后的 miss 分类（已被 range 矩阵部分闭合）

Assembler `(1,1)` 与 CebOrderRequest type-header 已在 `2fb2148` 闭合。仍开放的见下方「仍 miss」。

## 本轮代码（相对 `f0e2ef1`）

1. `positionFromFacts` 增加 `typeName`：唯一引用该类型的方法取代 `(1,1)`；多方法同名类型保持 `(1,1)`。type/import graph 传入 `anchor.className`。目标：`benefit-product-code-dto` Assembler 50–54。
2. `QUERY_READ_RANGES`：无实例方法的类型读整型体（上限 80 行），不用 13 行 header。目标：`ceb-order-create-dto`。
3. `methodRangeEnd` 取 declaration/body 较大端。目标：差一行的 near-miss。
4. relationship CALLS：用已加载的 framework 方法行，不新开 hydrate。

隔离 targeted：67/67 绿（host-quiet、candidate-helpers、collectors、relationship-provider、java-index-client）。

## 本轮正式矩阵（已完成）

产物：`/tmp/codex-java-lsp-v4-06-range-20260819-002900/`
baseline `f0e2ef1`，candidate `2fb2148`，`--runs 5`（3 rounds × 5 attempts）。候选测试 159/159。exit 1 = 质量绝对门槛 FAIL（分母），不是本轮回归。

| 仓 | RangeLineRecall old→new | holdout rReadMust | tokens P50 | p95Ratio |
|---|---|---|---|---|
| lishuedu | 0.734 → **0.768** | 0.5 | 4496 → 4501（+5） | 0.995 |
| cipherlink | 0.85 → 0.85 | 0.55 | 3606 → 3617（+11） | 0.865 |
| exam-parent-v3 | 0.5525 → **0.6025** | 0.40 | 3395 → 3514（+119） | 1.109 |

闭合（r1）：`benefit-product-code-dto` 0.667→1.0（Assembler 49–54 + methodless DTO 整型）；`ceb-order-create-dto` 0.500→1.0（CebOrderRequest 10–61）。

## 仍 miss（r1-new）

**NEAR-MISS-WRONG-RANGE / 同文件第二方法**（本刀已改代码，待矩阵）：`rule-engine-execute` 缺 103–130；`apply-info-save-basic-service` 136–202 盖不住 136–226（RangeLineRecall 要求单段完整覆盖）。
**NEAR-MISS-HEADER**：`audit-order-repository-mapper-rule-type` Mapper 1–29 vs 47–155/157–254（禁止用 save 去猜 listTodo）。
**错方法**：`check-people-delete-site-guard` 选中 52–64 vs 171–189。
**holdout 预算/召回**：exam-score 0.143、paper-task 0.200、cipherlink 两 holdout、exam 两 holdout。`backend-operation-log` 77–93 vs 77–94 且缺 102–146 与 DefaultOperationLogAppService。

## 下一刀（代码已落地，待矩阵）

`QUERY_READ_RANGES`：已选方法的 1-hop 同类型 unqualified/`this` 被调方法一并读出（近 80 行、最多 6 个）。相邻窗口走现有 merge gap=3，可把 apply-info 合成 136–226。不放宽 maxFiles，不用 type-header。

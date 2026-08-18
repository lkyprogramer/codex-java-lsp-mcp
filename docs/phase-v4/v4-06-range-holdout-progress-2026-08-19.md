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

## sibling callee 矩阵（`d00a3bd` vs `2fb2148`）

产物：`/tmp/codex-java-lsp-v4-06-sibling-20260819-005042/`。候选 159/159。exit 1 = 质量门槛 FAIL。

| 仓 | RangeLineRecall | holdout rReadMust | tokens P50 |
|---|---|---|---|
| lishuedu | 0.768 → **0.746 回归** | 0.5 | 4501 → 4216（-285） |
| cipherlink | 0.85 → **0.875** | 0.55 | +294 |
| exam-parent-v3 | 0.603 → **0.753** | 0.40 | +149 |

闭合：`rule-engine-execute` 0.5→1.0，`apply-info-save-basic-service` 0→1.0。holdout 抬升：exam-score 0.143→0.429，backend-operation-log 0→0.250。

**回归**：`school-template-parser` 1.0→0.5 / rReadMust 1→0.75。`ExcelParser.parse()` 扇出 6 个相邻 helper，merge 成整文件后超 14KiB 预算被挤出。修复：`SIBLING_CALLEE_MAX` 6→2。

## sibling cap 矩阵（`ba5838f` vs `2fb2148`，已完成）

产物：`/tmp/codex-java-lsp-v4-06-sibling-cap-20260819-010421/`。候选 159/159。exit 1 = 质量门槛 FAIL（分母）。

| 仓 | RangeLineRecall old→new | holdout rReadMust | tokens P50 | p95Ratio |
|---|---|---|---|---|
| lishuedu | 0.768 → **0.782** | 0.90 | +286 | 0.996 |
| cipherlink | 0.85 → **0.875** | 0.91 | +294 | 1.005 |
| exam-parent-v3 | 0.603 → **0.753** | 0.88 | +149 | 1.009 |

`school-template-parser` 恢复 1.0 / rReadMust 1。`rule-engine-execute` / `apply-info-save-basic-service` 仍为 1.0。exam-score holdout 0.143→0.286；backend-operation-log 0→0.250。

## calleeNames 切片（`599a4d1` vs `ba5838f`，已测，零效果）

产物：`/tmp/codex-java-lsp-v4-06-impl-hint-20260819-012330/`。候选 159/159。三仓 file recall / pRead / 全部场景 RangeLineRecall **逐位相等**。`check-people-delete-site-guard` 仍 0.500，readPlan 仍是 Impl 1–43 / 52–64。无回归。

根因修正：controller 锚点不走 `collectTypeGraphCandidates`（`shouldUseTypeGraph` 只要 port/repository/service/interface）。Impl 来自 `type-reference.ts` 的 interface→implementer 查找，且 **硬编码** `positions: [{line:1,column:1}]` + `hydrate: false`。

## type-reference implementer 切片（`4d10d86` vs `599a4d1`，已完成）

产物：`/tmp/codex-java-lsp-v4-06-type-ref-20260819-013500/`。候选 159/159。exit 1 = 质量门槛 FAIL（分母）。

`check-people-delete-site-guard` **0.500→1.000**（Impl 现含 `171–189`）。`school-template-parser` 仍为 1.0。三仓 file recall / pRead 不变。cipherlink p95Ratio 1.936 是主机噪声（质量格子未动），不是回归。

副作用：`candidate-pay-order` tokens 3663→3199，range 仍 0.125——hydrate 后 WechatApplyServiceImpl 变“诚实体积”，被更小的 OrderVO 挤出，指标未变差。

## 仍 miss（相对 `4d10d86` / type-ref 矩阵 r1-new）

**Tuning**

- `current-user-service-implementer-edge`（exam，0.500）：wrapper 矩阵 `/tmp/codex-java-lsp-v4-06-wrapper-20260819-014800/` 已把 `CommonResult` 挤出 plan，空位给了 DTO，Impl 仍未进。check-people / school-template-parser 仍 1.0；cipherlink/exam pRead 微升。本刀：first-hop IMPLEMENTS 2→2.4，高于 METHOD_RELATION DTO，仍低于真实 CALLS 2.5。不放宽 maxFiles。`ExamManagementApplication` 仍需后续发现。
- `audit-order-repository-mapper-rule-type`（lishuedu，0.333）：Mapper 1–29 vs 47–155 / 157–254。Anchor 是 `save()`。禁止用 save 去猜 listTodo。

**Holdout**

- lishuedu `exam-score` 0.286；`paper-task` 0.200
- cipherlink `client-release-storage-presign` 0.500；`backend-operation-log` 0.250
- exam `exam-room-print` 0.400；`candidate-pay-order` 0.125

## 仍 miss（相对 `ba5838f` / cap 矩阵 r1-new）

**Tuning**

- `check-people-delete-site-guard`（exam，0.500）：本刀目标。
- `current-user-service-implementer-edge`（exam，0.500）：Controller 45–52 与 `CurrentUserService` 1–23 已覆盖；`ManageCurrentUserServiceImpl` 在 candidates 但不在 6 文件 readPlan（缺 42–50）；`ExamManagementApplication` 不在 candidates（缺 21–29）。属预算/选文件，不放宽 maxFiles。
- `audit-order-repository-mapper-rule-type`（lishuedu，0.333）：Impl 39–60 已命中；Mapper 1–29 vs golden 47–155 / 157–254。Anchor 是 `save()`。禁止用 save 去猜 listTodo。

**Holdout**

- lishuedu `exam-score` 0.286；`paper-task` 0.200
- cipherlink `client-release-storage-presign` 0.500；`backend-operation-log` 0.250（77–93 vs 77–94 不要用 +1 type-header；缺 DefaultOperationLogAppService）
- exam `exam-room-print` 0.400；`candidate-pay-order` 0.125

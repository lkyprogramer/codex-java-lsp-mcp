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

## Primary-keep 复测（`e9fe968` vs `84a3b69`，已完成）

产物：`/tmp/codex-java-lsp-v4-06-primary-keep-20260819-094200/`。候选 1005+159 全绿。exit 1 = 质量门槛 FAIL（分母）。

| 仓 | RangeLineRecall old→new | holdout rReadMust | 关键场景 |
|---|---|---|---|
| lishuedu | 0.7923 不变 | 0.925 | `storage-signed-url` 三轮 **1.0**（Aliyun+Stub 全留） |
| cipherlink | 0.8158→0.8265 | 0.910 | range 无回归；file recall 有互抵波动 |
| exam-parent-v3 | 0.7095→0.6970 | 0.880 | `current-user` 三轮 **0.75→1.0**；`check-people` 仍 1.0，pRead 0.5→0.667 |

exam file recall 略降是预期：无 `@Primary` 的 CurrentUser 实现不再挤核心，shouldHit 额外 Impl 离开 plan。这是反过拟合，不是回归。

## 反过拟合：剩余 miss 分类（三仓是样本，不是目标函数）

只保留对任意 Spring/DDD/多模块 Java 仓都成立的规则。禁止场景 id / 文件名 / taskKeywords 特判。

| 场景 | 分类 | 决定 |
|---|---|---|
| `audit-order` 0.333 | 错方法：anchor 是 `save()`，golden 要 Mapper `listTodo` | **DO_NOT_SPECIALIZE**。禁止用 save 猜 listTodo |
| `backend-operation-log` 77–93 vs 77–94 | near-miss-boundary | **DO_NOT** type-header +1 |
| `paper-task` AccessService 1–23 vs 32–38/64–68 | 第一跳协作类型用了 (1,1) | 通用：按 caller-site 方法定位 |
| `exam-score` / `exam-room-print` / `candidate-pay-order` / `backend-operation-log` Impl | 已选端口的实现被同级 CALLS 挤出 6 文件 | 通用：先闭合已打开的 hop |
| `paper-task` `MeQueryService` | 第二跳（AccessService.requireMe） | 无免费通用刀时记 second-hop |
| `presign` PublishAppService | 反向调用方，不是被调端口 | 不发明 caller-scan |
| `candidate-pay-order` Template/Repository | 预算 + 第二跳 | 不放宽 maxFiles |

## 本刀（相对 `e9fe968`）

产物：`/tmp/codex-java-lsp-v4-06-first-hop-20260819-101900/`（`bc5ec9f` vs `e9fe968`）。候选 159/159。

**KEEP**：`positionsFromFacts` + `findTypeDefinitions(hydrate:true)`。`paper-task` 三轮 0.4→**0.8**（AccessService 32–38 / 64–68），storage / current-user / check-people / school-template 仍 1.0。

**REJECT**：把已选端口的 IMPLEMENTS 提到 2.65。`exam-score` 0.286→0.571、`candidate-pay` 0.125→0.25，但 cipherlink `rReadMust` 0.91→0.81——`organization-create-member` 与 `auth-sms-login` 的跨模块第一跳被实现类挤出。任意 Spring 仓都会遇到同一模式，不能为抬 range 牺牲其它第一跳。排名已撤回，只留方法定位与 `candidateNodeId` 元数据。

## positions 正式矩阵（`98a0183` vs `e9fe968`，已完成）

产物：`/tmp/codex-java-lsp-v4-06-positions-20260819-105100/`。候选 159/159。exit 1 = 质量绝对门槛 FAIL（分母），不是本刀回归。

| 仓 | RangeLineRecall old→new | holdout range | holdout rReadMust | tokens P50 | p95Ratio |
|---|---|---|---|---|---|
| lishuedu | 0.8019 → **0.8419** | 0.343 → **0.543** | 0.625 | 4787 → 4662 | 0.987 |
| cipherlink | 0.875 不变 | 0.375 | 0.550 | 4390 → 4370 | 1.041 |
| exam-parent-v3 | 0.8525 不变 | 0.263 | 0.400 | 3869 不变 | 1.520（主机噪声；file recall 未动） |

**KEEP**：`paper-task` 三轮 0.4→**0.8**（AccessService `1–38/64–68` 盖住 32–38 与 64–68）。storage / current-user / check-people / school-template 仍 1.0。cipherlink `rReadMust` 0.91 未回归。file recall 三仓逐位相等。

exam `pRead` 0.6067→0.6000：更紧的 range 省出字节后多进了一个非 golden 文件。相对 pRead 门仍过，不因此撤回方法定位。

## 下一刀（相对 `98a0183`，隔离已绿，待正式矩阵）

两条对任意 Java 仓都成立的规则，**不**把 IMPLEMENTS 抬到 sibling CALLS 之上：

1. **extract-method 延续**：锚点方法的同类型 unqualified/`this` helper，其外部字段接收者记为 `CALLS` depth-1 / `callOrigin=helper`（优先级 1.75）。不递归，重载同名同 arity 跳过。
2. **闭合已 CALLS 的端口**：该端口的 IMPLEMENTS 为 2.45，其它 IMPLEMENTS 仍 2.4。低于 sibling CALLS 2.5。

禁止项不变：save 猜 Mapper、type-header +1、caller-scan、放宽 maxFiles、全量 IMPLEMENTS 2.65。

## 仍 miss（相对 positions 矩阵 r1-new）

**Tuning**

- `audit-order-repository-mapper-rule-type`（lishuedu，0.333）：Mapper 1–29 vs golden 47–155 / 157–254。Anchor 是 `save()`。**DO_NOT_SPECIALIZE**。

**Holdout**

- lishuedu `exam-score` 0.286（helper 外部接收者 + generator 实现）；`paper-task` 0.800（只剩第二跳 `MeQueryService`）
- cipherlink `client-release-storage-presign` 0.500（反向调用方，不发明 caller-scan）；`backend-operation-log` 0.250（77–93 vs 77–94 **DO_NOT** +1；缺已选端口的实现）
- exam `exam-room-print` 0.400（实现被同级 CALLS 挤出；不能再抬全量 IMPLEMENTS）；`candidate-pay-order` 0.125（同带 IMPLEMENTS 里应优先闭合已 CALLS 的端口）

# readPlan 下一阶段决策备忘 (2026-06-26)

> 收口 `docs/superpowers/plans/2026-06-26-readplan-semantic-gap-optimization.md` 本轮（Task 1/2）后的方向判断。
> 定位：决策规则 + 触发门槛，不是实现。目的是让"是否做 Task 3/4/5"由 attribution 数据判定，而不是直觉或在小样本上调参。

## 1. 状态结论

计划已在 **Task 2 收官**，主目标达成，不是被中途放弃：

- warm-required 从"recall 有效但不可采纳"（`R_read_must≈0.70`）修到 **`recall 0.8256↑ + R_read_must=1.0`**。
- 三项目 cold `strategy=impact runs=5` 全部 `R_read_must=1.0`；lishuedu cold `recall 0.7756 / precision 0.4127` 未回退。
- lishuedu 三个重点 gap 的 must 文件全部进 readPlan（StorageGateway 5/5、ReportBatchExportTaskRepository 4/4、ParentStudentBenefitItemResponse 3/3）。

缺口的真实分布（按 golden 构成核算，benchmark 按 scenario 独立评估，`goldenAll = must∪should∪side`）：

| | must | should | side |
|---|---:|---:|---:|
| lishuedu 5 场景合计 | 20 | 15 | 6 |

- **must（20）100% 进 readPlan**；cold `recall 0.7756` 的全部缺口落在 **should（15）+ side（6）**。
- side（6）= 纯 test + 1 个 SQL migration，计划三处声明非 hard gate、diagnostic-only。
- 剩余 should 缺口主要是 **cold 跨模块消费者**（S1→report service、S5→product）与 **类型引用**（ProductView），两类都是计划**有意 defer** 的方向（D-cold 的 token 反弹、type edge 需证据触发），不是没做完。

## 2. 核心决策规则

1. **Task 3/4/5 默认不做。** 它们在计划里就是条件触发；当前没有 attribution 证据证明触发条件满足。
2. **下一刀必须由 attribution 数据触发**，不靠"recall 没到 1.0 所以还有空间"的直觉。`recall < 1.0` ≠ 值得追：分母含 side，且多数缺口是有意权衡掉的。
3. **第一动作是产出 per-scenario gap attribution + 扩 golden 覆盖**，两者并行；扩 golden 是后续任何"按证据打一刀"的硬前提（理由见 §4）。
4. **evidence budget / 三层 planner / profile-aware warm 是北极星，当前不动手**（理由见 §6）。在 8 个 golden 场景上落地分桶配额，等于把"调字符串权重"换成"调桶预算"，是更精致的过拟合。

## 3. Gap Attribution 字段定义

把 Task 0 的一次性诊断脚本升级为常驻 benchmark 输出。每个 golden 文件一行：

| 字段 | 含义 | 来源 |
|---|---|---|
| `scenario` | 场景名 | golden |
| `file` | golden 文件相对路径 | golden |
| `kind` | `must` / `should` / `side` | golden |
| `inFiles` | 是否进 `result.files` | `result.files` 包含该 path |
| `inReadPlan` | 是否进 readPlan | `readPlan.fileId → pathById` |
| `source` | 召回来源 | `scoreBreakdown.source` / `verifiedBy`：`rg`/`typeGraph`/`seed`/`reference`/`typeHierarchy`/`typeReference` |
| `blockedBy` | 未进 readPlan 的归因 | 见下 |
| `profile` | anchor profile | `anchor.profile` |
| `semanticUsed` | 该场景是否启用 semantic | `result.metrics.semantic.used` |

`blockedBy` 取值，分两档落地：

**可直接从现有 `result` 派生（第一版即可跑）：**

- `hit` —— `inReadPlan=true`。
- `readplan-full` —— `inFiles=true && inReadPlan=false`。进了 files 但 readPlan slot 被占满，对应 Decision Record 第 5 条的有意取舍。
- `absent` —— `inFiles=false`。根本没召回。

**需 router 增加 diagnostic instrumentation 才能细分（第二版，仅在第一版显示缺口 material 时再加）：**

- 把 `absent` 细分为 `not-recalled-B`（应由 implementer 图召回但 cache 没有，→ class B）与 `no-type-edge-C`（应由签名类型边召回但无此 facts，→ class C）。
- 把"进 candidates 但被压低"细分为 `truncated`（被 `truncateCandidateTail` L2 裁掉）、`cross-module-penalty`（→ class D）、`profile-gate`（semantic 未对该 profile 启用）。
- 实现规格：在 `verbosity=diagnostic` 下让 router 额外输出 candidate 全集 + 每候选的 `suppressed/penalty` 明细。这是后续最小 instrumentation，不在本备忘范围内实现。

`blockedBy → 下一刀` 映射：`not-recalled-B → Task 3`；`no-type-edge-C → Task 4`；`cross-module-penalty(warm) → Task 5`；`profile-gate → profile-aware warm`（北极星，§6）；`readplan-full → 不修，是有意取舍`；`side 任何状态 → 不进 hard gate`。

## 4. Golden 扩充要求

**为什么必须先扩：** 当前 golden 仅 8 个场景（lishuedu 5 + cipherlink/exam/generic 各 1）。在 8 个点上给证据类型定预算、给 profile 定 gate，是在噪声上拟合。任何 Task 3/4/5 的"门槛是否满足"判断，在这个样本量下都不稳。

**最小扩充目标（建议，非硬性）：**

- 跨 ≥2 个独立真实 repo，每个 ≥5 个场景；覆盖 `port/repository/dto/service/controller/parser` 各 profile 至少各 2 例。
- 显式覆盖**跨模块消费者**形态（anchor 与 should 不同模块），因为这是当前剩余 should 缺口的主体，也是 D-cold/Task 5 的判据来源。
- 每场景标注 must/should/side，并标注 should 是否"卡真实任务完成"（用于 §7 停止条件判定）。

## 5. Task 3/4/5 量化触发门槛

把计划里的 `Run only if class X gaps are still material` 翻译成可判定阈值。**未达标即不做。**

- **Task 3（full implementer index）：** attribution 出现 `blockedBy=not-recalled-B`，且满足"命中 ≥1 个 must" **或** "在 ≥2 个独立项目的 repository/port 场景复现"；并且 cold 全仓扫描延迟实测可接受（计划 Task 3 Step 5 已有此 gate，`elapsedMs`/raw payload 不破线）。
  - 当前状态：**未达标**。三场景 must 已全闭合，无 B 类 must 缺口证据。
- **Task 4（signature type reference）：** attribution 出现 `blockedBy=no-type-edge-C`，profile ∈ `{dto,port,repository}`，且在 **≥2 个场景**复现；模拟 raw payload 反弹 `<5%`。
  - 当前状态：**未达标**。仅 ProductView 1 个 should 单点，跨模块且需叠加 Task 5 才进 readPlan。
- **Task 5（D-warm 跨模块豁免）：** warm path attribution 出现 `blockedBy=cross-module-penalty` 且候选 `verifiedBy` 含 `reference`/`typeHierarchy`。
  - 当前状态：**预期为空**。warm-required 已 `recall↑ + R_read_must=1.0`，说明 warm 跨模块消费者已被 references 召回。

## 6. 北极星与 deferred（当前不动手）

记录方向，标注前置条件，避免下一轮重新误读为"该立即做"：

- **Evidence-aware budget / 三层 planner**：把现有的"加性基分 + `readPriority` 分层 + protected baseline"显式化成每证据类型 slot 配额。**前置条件：golden 扩到几十个真实场景且 slot 竞争真实出现。** 当前 must=3–5/场景、`readPlanMaxItems=6`、baseline 仍有富余空位（Decision Record 第 5 条），slot 压力未到需要预算制。现状不是"总分池互相污染"，是隐式分层；该重构有价值但非当前瓶颈。
- **Profile-aware warm policy（port/repository/dto 分别开 warm semantic）**：方向认同，能让 warm-auto 获得真实语义收益。**但必须与 warm 延迟优化打包**——见下。
- **warm 延迟（决定性约束，全程不可漏）**：warm-required 的代价是 `elapsedMs 18→705ms`（39×）。这是 warm 无法默认化的真障碍。任何"给更多 profile 开 warm"的动作只算 recall 收益、不算延迟成本，都是不完整的。若要把 warm 推向默认，**先做批量 references / 超时与并发调优，再谈覆盖面**。
- **method-call token graph**：继续排除（计划 Non-goals）。噪声最高，第一版收益不可控。

## 7. 停止条件 / Falsifier

attribution + 扩 golden 后，若出现以下任一，判定为"到达当前性价比平台"，后续转向**工具交互体验 / 稳定性（含 warm 延迟）**，而非继续召回优化：

- 大多数剩余缺口为 should/side，且标注显示不卡真实任务完成；
- warm-required 在更多 repo 上 latency 或 `textDocument/implementation` timeout 不稳定（报告已记录一次 implementation timeout）；
- 窄图（Task 3/4）使 raw payload 反弹 `>5%` 而 recall 无实质提升。

注：按 §1 数据，第 1 条 Falsifier 在 lishuedu 当前矩阵上**已部分满足**；扩 golden 的目的正是验证它在更多真实 repo 上是否依然成立。

## 8. 已知限制

- `recall 0.7756` 的精确文件级反推未做（benchmark totals 聚合有自身去重逻辑，且本地 node 受 nvm shim 干扰无法直接执行）；但"must 全 hit、缺口在 should+side"由 `R_read_must=1.0` 实测 + golden 构成直接推出，结论是硬的。
- Task 1/2 落地已用真源确认（`nonLspReadPlanPaths` `index.ts:118/292`、`extraProtectedPaths:655`、protected-aware `buildReadPlan:662`），非仅采信报告。
- 未重跑 benchmark（评估非验证任务）；报告数字按其内部一致性采信。
- §3 第二档 `blockedBy` 细分依赖 router diagnostic instrumentation，本备忘只给字段语义与派生规则，不含实现。

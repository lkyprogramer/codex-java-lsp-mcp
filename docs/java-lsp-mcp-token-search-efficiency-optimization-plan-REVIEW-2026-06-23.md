# Java LSP MCP 省 Token / 检索效率优化方案 —— Review 报告

日期：2026-06-23
评审对象：`docs/java-lsp-mcp-token-search-efficiency-optimization-plan-2026-06-23.md`（279 行，下称「方案」）
代码基线：`agent-router/index.ts`、`source-index.ts`、`tools/impact.ts`、`benchmark-agent-impact.ts`、`routing-policy.ts`（工作区 commit `3fe0f8c`）
评审方法：逐节对照源码核验，所有判断标注 `源码:行号`，可复核。

---

## 1. 一句话结论

**方案可以直接进入开发，批次划分、验收门槛、风险控制都达到可执行标准。** 它在两处纠正了更早一版分析的错误结论，且都纠正得对。本 review 不推翻方案，只补充 **6 个实现级遗漏 / 验收失真点**，其中 §6.1、§6.2 属于「不修就拿不到预期收益或验收数字失真」的必修项，建议并入 Batch 1 一起做。

总体评级：

| 维度 | 评价 |
|---|---|
| 方向正确性 | 高 —— raw slimming 优先于 readPlan 边界，符合真实数据 |
| 数据可信度 | 高 —— payload 拆分与 token 总数自洽（见 §3） |
| 工程严谨性 | 高 —— 批次解耦、hard gate 明确、回滚路径清晰 |
| 实现完备性 | 中 —— 漏了 `withPhaseMs` 回写、benchmark/runtime 路径差异、Batch 3 口径联动（见 §6） |
| 验收可靠性 | 中 —— 验收只看 benchmark 会高估 metrics 瘦身收益（见 §6.2） |

---

## 2. 数据可信度核验（先确认地基）

方案 §1.2 给出三项目 payload 拆分，§1.1 给出 token 总数。两者必须满足 `estimatedTokens = totalAgentVisiblePayload / 4`（口径见 `benchmark-agent-impact.ts:200-201`）。逐一核验：

| project | §1.2 total payload | ÷4 | §1.1 标称 tokens | 自洽 |
|---|---:|---:|---:|:---:|
| lishuedu | 23,907.2 B | 5,976.8 | 5,977.0 | ✓ |
| cipherlink | 11,697.4 B | 2,924.4 | 2,924.2 | ✓ |
| exam-parent-v3 | 15,242.4 B | 3,810.6 | 3,811.0 | ✓ |

三项目全部自洽，误差在四舍五入内。**结论：方案的实测数据可信，可作为决策依据。**

> 附注：本机无法独立复现该拆分——本地 zsh 的 nvm lazy-load 进入无限递归（`_nvm_load` 刷屏、`maximum nested function level reached`），benchmark 实跑产物无法稳定落盘。因此本 review 的定量部分采信方案 §1.2 的数据（已通过上表自洽性校验），定性部分以源码为准。

---

## 3. 对方案两处「纠错」的确认

方案纠正了更早一版分析（即 review 人上一轮的口头方案）的两个结论。两处都成立：

### 3.1 「readingPayload 占 67%」不可外推 —— 方案对

- 早期结论基于 `generic-java` 单点（玩具仓库、短路径、短文件），得 reading≈67%。
- 真实三项目 raw 占 `51.3%–70.3%`（方案 §1.2）。根因在源码可解释：`files[]` 每个候选携带完整 `path`，而真实仓库是深包名（如 `modules/report/src/main/java/com/lishu/edu/report/infrastructure/persistence/repository/ReportBatchExportTaskRepositoryImpl.java` ~100B），`candidateLimit` balanced 可返回 16–26 个候选（`agent-router/index.ts:1319-1346`）→ `rawSearchPayload` 在大仓库被路径长度 × 候选数放大。
- **因此 raw slimming 作为第一杠杆是对的。**

### 3.2 warm-auto ≈1500ms 的归因 —— 方案对，早期分析错

- 早期把 1500ms 归因为 harness 的 `waitForProgressIdle`。
- 核对 `benchmark-agent-impact.ts`：`prepareWarmState()`（含 `waitForProgressIdle`）在 `:96-97` 的 attempts 循环**之前**执行；单次计时 `impactAttempt()` 的 `startedAt`（`:152`）只包住 `router.impact()`。所以等待 idle **不计入** `elapsedMs`。
- warm-auto 下 `effectiveSemanticPolicy` 为 `auto`（`:241-243`），service profile 触发 `collectSemanticSeed → session.semanticLocations(... timeout=1500)`（`agent-router/index.ts:242-254`）。P50≈1500ms 正是 `semanticTimeoutMs` 上限。
- **方案归因正确：这是语义阶段超时，不是 harness 等待。它属于 semantic latency 议题，方案把它移出 token 第一批是对的。**

---

## 4. 逐节判定

对方案各节结论的核验结果（✓ 成立 / ⚠ 成立但有补充 / ✗ 需修正）：

| 方案小节 | 核心主张 | 判定 | 依据 / 补充 |
|---|---|:---:|---|
| §0.1 baseline 省 token | 99.62/97.08/99.12% | ✓ | 与 §1.1 一致，硬门槛 `rReadMust=1.0` |
| §0.2 raw 不是小头 | 真实项目 raw 占 51.3–70.3% | ✓ | 见本 review §3.1，源码可解释 |
| §0.3 第一批做 raw 瘦身 | raw 降 26.6–30.1% | ⚠ | 方向对，但 benchmark 数字会高估真实降幅（§5.2） |
| §0.4 readPlan 边界第二批 | 收益分化、exam 明显 | ✓ | §1.4 自洽（53747/5=10749.4），保守定位正确 |
| §0.5 P2 暂不做 | 当前 golden 无 P2 readPlan 项 | ✓ | `readPriority` 下 main 源走 P0/P1（`agent-router/index.ts:1239-1253`） |
| §0.6 质量调优分开 | recall/precision 独立 | ✓ | 与省 token 反向，判断正确 |
| §0.7 warm-auto 归因 | semantic timeout 非 harness wait | ✓ | 见本 review §3.2 |
| §Batch1 standard 瘦身 | 清 `sections[].files` + metrics/gaps | ⚠ | 必修：`withPhaseMs` 回写问题（§5.1）；standard/compact 趋同（§5.3） |
| §Batch2 方法边界 | strict contains + 只缩不扩 | ✓ | 设计严谨，已规避 regex endLine 不准的截断风险（§5.4） |
| §Batch3 files[] overflow | 完整对象 + overflow 路径 | ⚠ | 必修：与 benchmark `candidatePaths` 口径联动（§5.5） |
| §Batch4 P2 path-only | 暂缓 | ✓ | 数据驱动，合理 |
| §5 验收闭环 | 每批跑三项目对比 | ⚠ | 需补 benchmark/runtime 路径差异说明（§5.2）与 warm 档验收（§7） |

## 5. 实现级补充发现（本 review 的主要增量）


## 6. 验收门槛精算

<!-- ACCEPTANCE -->

## 7. 边界与未覆盖项

方案聚焦清晰，以下是它（合理地）未展开、但实施时需心里有数的边界：

1. **warm 档 verbosity 未纳入验收**。方案验收矩阵全是 `cold-nolsp`。Batch1 的 sections/metrics 瘦身对 warm 路径（`auto/required`）同样生效，而 warm 下 `semantic.*`、`verifiedBy` 等字段对 agent 更重要，瘦身边界可能不同。建议至少补一条 `generic-java warm-required` 的 verbosity 回归，确认瘦身没误删语义证据。
2. **benchmark 是单 anchor**。`impactAttempt` 只传一个 anchor（`benchmark:153-164`），而 `java_impact` 支持 `anchors[].max=5`（`tools/impact.ts:14-19`）。多 anchor 下候选合并、`files[]` 膨胀、rg 段数 ×anchor 数，token 与延迟特性未被任何门槛覆盖。不必纳入本轮，但 §Batch3（候选膨胀）的真实收益在多 anchor 场景才最大，值得单列观测。
3. **P50 被 rgCache 命中掩盖**。`runs=5` 下，第 2–5 次命中 `rgCache`（TTL 300s，`agent-router/index.ts:57`），P50 主要反映缓存命中；真实首查成本在 **P95**（lishuedu 67ms）。方案「不优化 cold 延迟」结论成立（67ms 仍远低于预算），但若未来要看检索效率，对象是首查的 `rg` 子进程 spawn + 全模块扫描，而非 P50。
4. **方案 §1.3/§1.4 的 attribution 是离线模拟**，不是端到端跑通的 standard 输出。Batch0 的 attribution 工具应把「模拟删字段」升级为「真实切 verbosity 后测字节」，否则 §1.3 的 26.6–30.1% 仍是估算（与 §5.2 同源风险）。

<!-- BOUNDARY -->

## 8. 最终结论与建议

**结论：方案通过 review，可进入开发。** 优先级排序（raw slimming 优先于 readPlan 边界）、批次解耦、hard gate（`rReadMust=1.0`）、回滚路径均成立，数据自洽可信。无需返工重做，只需把下列必修项并入对应批次。

### 8.1 必须在动工前并入的修订

| 编号 | 修订 | 并入批次 | 不修后果 |
|---|---|---|---|
| §5.1 | `withPhaseMs` 增加 verbosity 感知，与 `applyVerbosity` 协同 | Batch1（必修） | standard 实际删不掉 `phaseMs`，收益落空 |
| §5.2 | 验收对齐 runtime 全链路，或让 benchmark 走 `javaImpact()` | Batch1 + Batch0 | benchmark 高估降幅，线上不省 |
| §5.5 | Batch3 同步改 `evaluate()` 候选口径纳入 `overflowFiles` | Batch3（必修） | precision/recall 失真，「quality 不变」不成立 |

### 8.2 建议补充（非阻塞）

- §5.3：在 T1.4 测试里固化 diagnostic/standard/compact 三档契约，避免 standard 与 compact 趋同。
- §6：在方案 §Batch1 验收里标注「exam-parent-v3 ~13.6% 为单项下限，平均门槛由 raw 占比高的项目拉动」。
- §7.1：补一条 `generic-java warm-required` verbosity 回归。
- §7.4：Batch0 attribution 工具用「真实切 verbosity 测字节」替代「离线删字段模拟」。

### 8.3 实施顺序（在方案批次上的微调）

方案的 Batch0→1→2→3→4 顺序正确。唯一微调：**把 §5.1 + §5.2 作为 Batch1 的前置子任务**（先打通「standard 瘦身在 runtime 全链路真实生效 + benchmark 能如实测量」），再做 T1.1/T1.2 的字段删减。否则会先得到一批「benchmark 达标但线上无效」的假绿。

### 8.4 一句话给决策者

地基扎实、方向正确、数据可信；**3 个必修项都是「代码路径联动」性质的小修，不是方向问题**，补齐后即可按方案批次推进。

---

### 附：本 review 的证据强度声明

- **源码类结论**（§3、§5、§7 的行号引用）：高置信，可逐行复核。
- **定量类结论**（§2、§6 的百分比）：采信方案 §1.1/§1.2 数据，已通过自洽性校验（§2）；本机因 nvm 环境问题未独立复现，建议在干净 shell 跑一遍 §Batch0 基线后再锁定数字。
- 本 review 未运行 benchmark，未修改任何运行时代码；仅产出本评审文档。

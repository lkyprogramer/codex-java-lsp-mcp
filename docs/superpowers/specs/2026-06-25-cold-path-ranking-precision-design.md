# 冷路径排序精度改造设计（方向一：precision + token）

日期：2026-06-25
适用仓库：`/Users/luo/Documents/github/codex-java-lsp-mcp`
代码基线：`main@753e947`（Batch 2 after，已合入 `origin/main`）

关联文档：
- 优化方案：`docs/java-lsp-mcp-token-search-efficiency-optimization-plan-2026-06-23.md`
- 方案 Review：`docs/java-lsp-mcp-token-search-efficiency-optimization-plan-REVIEW-2026-06-23.md`
- Benchmark 指南：`docs/java-lsp-mcp-benchmark-guide-2026-06-23.md`

本轮边界：`precision↑` + `raw token↓`；**recall 不降为不可妥协硬门槛**；零 `SourceIndex` facts 扩展、零延迟；跨模块 recall 提升单列下一轮。首轮默认只做结构加法 + L2 截尾，纯字符串权重下调后置为可选 Batch C。

## 1. 背景与目标

Batch 1（standard 瘦身）拿到了 token 主收益（三项目 total 降 12–19%），Batch 2（readPlan 方法边界）只换来 weighted total `0.63%`——这是「增量字段瘦身已到收益拐点」的信号，不是偶然。深入真源后，剩余 token 头部空间与检索质量短板合流到同一个根因：**候选选择质量**。

三条事实定住了本轮形状：

1. **reading 已触底。** `readPlanBytes` 对每个 must-read 文件只切一个窗口、无重复（`benchmark-agent-impact.ts:275-291`）；在 `rReadMust=1.0` 硬门槛下，reading ≈ agent 必须读的真实代码量，不可再压。
2. **raw 的剩余大头 = 候选数 × 单对象**，而单对象已被 Batch 1 瘦过（`formatCandidate` 在 standard 已剥离 `scoreBreakdown/confidence/verifiedBy`，`index.ts:1316-1332`）。能动的只剩**候选数量**。
3. **`precision = hitFiles / returnedFiles`（`benchmark-agent-impact.ts:361`）。** 只重排不减少返回数，precision 不变、raw token 也不降。lishuedu precision `0.3144` → 约七成候选是噪声。

**目标**：在 recall 不降、`rReadMust=1.0` 前提下，安全减少返回候选数，同时拿到 `precision↑` 与 `raw token↓`。

**关键洞察（决定方案形状）**：减少候选返回数是 precision 与 token 的**共同必要手段**；信号重权（L1）本身不直接取数，它的职责是把真候选（尤其当前已召回的 golden）用结构信号抬离尾部，让削减候选数（L2）时不伤 recall。

**非目标（本轮不做）**：提升 recall（跨模块下游召回需要 import 反向边，依赖扩 `SourceIndex`，单列下一轮）；不优化延迟；不改 verbosity 契约。

## 2. 设计总览：架构与改动边界

首轮两处改动，互相独立、可分别回滚：

| 单元 | 位置 | 职责 |
|---|---|---|
| **L1** 结构信号重权 | `finalizeScore`（`:533-561`） | 首轮只新增 4 个结构正信号（加法），改善排序，把真候选抬离尾部 |
| **L2** 结构感知断崖截断 | `finalizeRank`（`:577-594`）sort 之后 | 在 readPlan 覆盖之外的纯字符串尾部做断崖 / 动态上限截断，减少返回候选数；candidate limit 只截非 protected 候选 |

**不碰**：候选聚合主流程、rg 计划与缓存、readPlan 窗口（reading 已触底）、verbosity 与 `withPhaseMs`、benchmark 口径、`SourceIndex` facts 结构（零扩展）。

**安全边界**：L2 必须先按 `buildReadPlan` 同口径计算 `readPlanCovered`，并把这些候选放进 protected 集；最终 candidate limit 也必须在截断函数内部应用，只截非 protected 候选。这样可以避免 L2 直接切掉 readPlan 覆盖文件。L1 加分仍可能改变同优先级内排序，所以 `readingPayload` 不是结构上必然不变；若变化，必须输出 readPlan diff 并由 benchmark 门槛兜底。

## 3. L1：结构信号重权（首轮加法，减法后置）

**数据来源**：候选与 anchor 双方的结构 facts 由 `sourceIndex.factsFor(absolutePath)` 现场取（`JavaSourceFacts`，`source-index.ts:15-30`；带 mtime/size 缓存，冷路径零额外延迟），与现有 `typeRelationDelta`（`index.ts:564-575`）同法。`CandidateFile`/`ResolvedAnchor` 本身不带 annotations/package，但都有 `absolutePath`。

**现状信号（finalizeScore，作为重权基线）**：`match-count` `min(40, matchCount×2)`、`focus-module` +35、`task-keyword`（path includes）+30、`direct-collaborator` 0/140/170、`type-relation` 0/+95、`defer-test` −10、`cross-module` −20/−80、`confidence delta`。噪声根因是 `match-count` 与 `task-keyword` 这两个纯字符串信号在大仓库被同名/同关键词文件触发。

### 3.1 加法：四个结构正信号

| 信号 | 规则 | 权重（初始，内部常量） |
|---|---|---|
| **S1 注解层协作** | stereotype 白名单（`@Service/@Repository/@Mapper/@Controller/@RestController/@Component/@Configuration/@Entity/@Table` 等）下，anchor 层 × 候选层构成已知协作对 | `+50` |
| **S2 包邻近度** | `packageName` 公共前缀深度：同包最高、父子包次之、跨远包 0 | 梯度 `+30 → 0` |
| **S3 类型关系对称化** | 现有 `typeRelationDelta` 只判「候选 implements/extends anchor」；补「anchor implements/extends 候选」（候选是父接口/父类） | `+95`（复用现值） |
| **S4 kind 配对** | port profile 下 `interface × class 且 implements` 配对补强 | `+20` |

实现要点：
- **annotations 需筛选**：`source-index.ts:347-350` 是行级 `^@` 正则，混杂类注解（`@Service`）与方法/字段注解（`@Override`/`@GetMapping`/`@Autowired`）。S1 必须用 stereotype 白名单过滤，匹配不到即不加分（**缺失不惩罚**），避免对注解稀疏的 POJO/DTO 误伤。
- 所有结构信号经 `addScoreDelta(scoreBreakdown, "finalize.structural.*", delta, reason)`（`index.ts:813`）落账；`scoreBreakdown` 仅 diagnostic 输出，**不影响 standard payload**。
- `factsFor` 抛错按 0 处理（`try/catch`），不阻断打分。

### 3.2 可选 Batch C：小幅下调纯字符串权重

首轮不执行。只有当 S1-S4 加法 + L2 截尾后的 benchmark 收益不足，且 `recall/rReadMust/readPlan` 稳定时，才单独执行：

- 全局小幅下调：`match-count` 上限 `40 → 28`、系数 `×2 → ×1.6`；`task-keyword` `+30 → +22`。
- 条件打折：定义 `hasStructuralForScoring(candidate)` = S1/S2/S3/S4/focus-module/type-relation/direct-collaborator 任一 > 0。对 `!hasStructuralForScoring` 的候选，其 `match-count` 与 `task-keyword` 贡献额外 `×0.6`。精准压低「只靠名字像」的纯字符串噪声候选。

### 3.3 对硬门槛的影响与防护

下调字符串权重**改变了同优先级内的 score 排序**，理论上可能挤动 `readPlan`（`buildReadPlan` 先按 `priorityRank` 再按 score，`:600`）。因此它必须作为独立 Batch C 做，退化时只回滚这一批，不影响 S1-S4 加法和 L2 截尾。所有权重为内部常量，从本表保守值起步，benchmark 驱动微调，不暴露 public 配置。

## 4. L2：结构感知断崖截断（动态上限激进档）

在 `finalizeRank` 的 `sort` 之后插入。`candidateLimit` 不再作为末尾裸 `slice()`；必须交给 `truncateCandidateTail` 内部处理，保证 readPlan 覆盖候选和强结构候选不会被末尾 slice 截掉。

### 4.1 算法

输入：`finalizeScore` 后按 score 降序的候选 `ranked`。

1. **受保护集 `Protected`** = 优先级排序前 `maxItems`（=6，readPlan 必覆盖）∪ `hasProtectedStructuralSignal > 0` 的候选。这部分**永不截**。
2. **可丢弃区 `D`** = `ranked \ Protected`（纯字符串命中、无结构关系、readPlan 之外）。
3. **断崖检测**：在 `D`（score 降序）内找首个满足「后项 `< 前项 × θ`」的相邻 gap，记其位置为 `cliffIdx`；无断崖则 `cliffIdx = |D|`（不靠断崖约束，纯由动态上限收紧）。
4. **动态上限**（激进档，无断崖也收紧）：`structuralCount` = `hasProtectedStructuralSignal > 0` 的候选数；`dynamicBudget = min(structuralCount × 0.5, 4)`，即纯字符串候选最多保留「强结构候选数的一半」或 4 个，取小。
5. **取更激进者**：`D` 保留前 `min(dynamicBudget, cliffIdx)` 个，其余截断。
6. **floor 防过截**：`readPlanCoverage` = 进入 readPlan 的候选数；最终候选数 `≥ max(readPlanCoverage, 8)`，不足则按 score 回填 `D` 次高分候选至 floor。
7. **启用条件**：仅当 `ranked.length > 10` 时启用；否则原样返回（cipherlink 等小候选集不截）。
8. 最终候选 = `Protected ∪ D_kept`，按原 score 序；candidate limit 只限制非 protected 候选，若 protected 数量本身超过 limit，则允许短暂超过 limit，优先保证 readPlan 与强结构候选不被误截。

`hasProtectedStructuralSignal` 包含：`finalize.structural.type-symmetric`、`finalize.structural.kind`、`finalize.type-relation`、`finalize.direct-collaborator`。`finalize.structural.annotation`、`finalize.structural.package`、`finalize.focus-module` 只加分，不保护；annotation/focus 在大模块上会保护过多同层/同模块候选，不能阻止 L2 截尾。

### 4.2 参数（内部常量，不暴露 public，benchmark 驱动收敛）

| 参数 | 初始值 | 作用 |
|---|---|---|
| `θ` 断崖相对阈值 | `0.5` | 后项 < 前项 ×θ 判为断崖 |
| `dynamicBudget` | `min(structuralCount×0.5, 4)` | 纯字符串候选保留上限 |
| `floor` | `max(readPlanCoverage, 8)` | 最小保留数，防过截 |
| `minStrongStructuralEvidence` | `6` | 强结构候选少于 6 时不做尾部裁剪，只做 readPlan-aware limit |
| 启用阈值 | 候选数 `> 10` | 小候选集不启用 |

### 4.3 自适应回退

参数从上表保守值起步。benchmark 若任一项目 `recall < 基线`，按序放松：增大 `dynamicBudget` 缓冲（`4 → 6`）→ 提高 `θ`（`0.5 → 0.6`，更难判断为断崖、截得更少）→ 直至 recall 不降。「激进」是方向，recall 不降是不可妥协的收敛终点。

**预期分布**：lishuedu（结构候选少、纯字符串噪声多）截得多 → precision/token 明显改善；cipherlink/exam（噪声少、recall 已 1.0、或候选数 ≤10）几乎不截 → 不退化。

## 5. 数据流

```
候选聚合（不变）
  → finalizeScore [ +L1 加法 S1–S4 ]
  → sort（score 降序）
  → L2 [ 框定 Protected → 可丢弃区 D 断崖/动态上限截断 → floor 回填 → limit only non-protected ]
  → files[]（候选数 ↓ → raw token ↓ / precision ↑）
  → buildReadPlan（由 benchmark 验证 reading payload / rReadMust / pRead）
```

可选 Batch C 才在 `finalizeScore` 加入纯字符串权重下调 + 无结构信号 ×0.6。

## 6. 边界与错误处理

- `factsFor` 抛错 → 该结构信号按 0（`try/catch`，同 `typeRelationDelta:572`），不阻断打分主流程。
- annotations 缺失或仅含方法/字段注解 → stereotype 白名单过滤后无匹配即不加分（缺失不惩罚）。
- 候选数 `≤ 10` → L2 不启用，原样返回。
- 可丢弃区 `D` 为空（候选全有结构关系）→ 不截。
- `structuralCount < 6`（强结构证据不足）→ 不做尾部裁剪，只做 readPlan-aware candidateLimit；避免 cipherlink/exam 这类小候选集因证据不足误截 should-hit。
- `packageProximity` 为弱结构信号，只影响排序，不进入 protected 集。

## 7. 验收门槛与测试

### 7.1 硬门槛（任一不过 → 失败并按 §4.3 回退收紧）

- `npm run build && npm test` 通过。
- 三项目 `cold-nolsp strategy=impact runs=5`：
  - `rReadMust = 1.0`（所有 must-hit 进 readPlan）。
  - `recall ≥ 基线`：lishuedu `0.7756` / cipherlink `1.0` / exam-parent-v3 `1.0`。
  - `pRead ≥ 基线 − 0.02`。
  - `readingPayload` 原则上应持平；若变化，必须输出 readPlan before/after 文件集合与窗口 diff，确认 `rReadMust=1.0` 且 `pRead >= 基线 - 0.02` 后才能接受。

### 7.2 目标指标（记收益；未达不算失败但须归因）

- lishuedu `precision > 0.3144`（主要目标）。
- 三项目平均 `returnedFiles` 与 `rawSearchPayload` 下降；cipherlink/exam 允许持平（候选少、噪声少）。

### 7.3 单元测试（`agent-router.test.ts`、`source-index.test.ts`）

- **L1**：S1 注解层协作加分 / stereotype 白名单过滤方法注解 / 缺失不惩罚；S2 包邻近梯度；S3 对称类型关系（anchor 是候选父类型）；S4 kind 配对。
- **L2**：断崖截断；无断崖按动态上限收紧；受保护候选（readPlan 覆盖 / 强结构关系 / focus-module）不被截；`packageProximity` 不保护；候选数 ≤10 不启用；`floor` 回填；`structuralCount=0` 兜底保留 8；candidate limit 只截非 protected。
- **Batch C（可选）**：`!hasStructuralForScoring` 候选字符串贡献 ×0.6，必须独立 benchmark。

### 7.4 Benchmark 对比（复用 guide §5 流程）

以 `753e947`（Batch 2 after）为 before、改造后为 after，三项目 `cold-nolsp impact runs=5`。对比 `rawSearchPayload / readingPayload / totalAgentVisiblePayload / estimatedTokens / precision / recall / pRead / rReadMust / 平均 returnedFiles`，并报告**每项目平均截断候选数**与 precision/token before-after。结论写回 benchmark guide 验证快照。

## 8. 风险与回滚

| 风险 | 影响 | 控制 |
|---|---|---|
| 误截低分跨模块 `shouldHit` | recall 降 | 只截无结构关系候选 + 保守 `θ`/`dynamicBudget` + recall 硬门槛 + §4.3 自适应回退 |
| L1 加法改排序地基，must-hit 被挤出 readPlan | `rReadMust` 降 | benchmark `rReadMust=1.0` 兜底；若 readPlan 变化，输出 diff 并优先修保护/排序逻辑 |
| 可选 Batch C 减法改排序地基 | `rReadMust` 或 recall 降 | 必须独立提交与独立 benchmark；退化即只回滚 Batch C |
| L1 注解误判（混杂方法注解） | 误加分、排序偏移 | stereotype 白名单 + 缺失不惩罚 |
| annotations 稀疏（POJO/DTO） | 结构信号缺失被误判为噪声 | `floor` 兜底 + 缺失不惩罚；这类候选多为 P0/P1 受保护 |
| package proximity 保护过宽 | L2 截不动、收益不足 | `packageProximity` 只加分，不进 protected 集 |

**回滚路径**（两者独立，可单独回退，均无状态迁移）：
- **L2**：关闭截断分支，回退固定 `candidateLimit`。
- **L1 加法**：移除新增 `addScoreDelta` 项。
- **Batch C 减法**：还原 `match-count`/`task-keyword` 权重常量。

## 9. 不纳入本轮

- **跨模块 recall 提升**：需 import 反向边识别真正的下游消费者，依赖扩 `SourceIndex` 解析/缓存/快照——单列下一轮。
- **方法体引用 / 调用方向信号**：同样需扩 facts，本轮零扩展。
- **LSP 语义路径（warm，~1500ms）**：独立延迟轨道，不混入本轮。
- **readPlan 窗口进一步收紧**：reading 已触底，Batch 2 已证边际收益，不动。
- 不暴露 public 配置项；不改 verbosity 契约；不改 benchmark 口径。

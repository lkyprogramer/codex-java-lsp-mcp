# Java Intelligence V3 Sprint 4 进行中报告（V3.2-21/22/23：auto admission / persisted semantic operation-completeness / idle prewarm 实验）

来源计划：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-value-realization-optimization-development-plan-2026-08-09.md` 第 630-680 行（Sprint4，V3.2-21~25）。

本报告随 Sprint4 进展持续追加小节；截至本次提交覆盖 V3.2-21（关闭状态回顾）、V3.2-22、V3.2-23（本轮新增）。V3.2-24/25 尚未开始。

## 1. 直接结论

| 编号 | 结论 |
| --- | --- |
| V3.2-21 | `DO_NOT_IMPLEMENT`（已于 2026-08-15 关闭，详见 `docs/phase-v3/phase5-semantic-first-touch-decision.md` 追加小节） |
| V3.2-22 | `CONSERVATIVE_ALTERNATIVE_ALREADY_SATISFIED`（本轮关闭，无需代码改动） |
| V3.2-23 | `DEFERRED_PENDING_WORKLOAD_TELEMETRY`（本轮关闭为"实验前置条件缺失"，不是 PASS/FAIL，也不是 DO_NOT_IMPLEMENT） |

## 2. V3.2-21 回顾（不重复展开，仅索引）

`auto` 的 live JDT 调用在当前三仓 golden 集合上对 recall/pRead/rReadMust/rTaskBlocking 零可测量收益，P95 却暴涨 7-15.6 倍；`progress.active===0` 瞬时读数不能作为 admission gate（`waitForProgressIdle()` 自身已证明需要 sustained-idle）。完整证据：`artifacts/v3-final/sprint4-v321-admission-recheck-20260815/`。

## 3. V3.2-22：persisted semantic operation-completeness 合同

### 3.1 计划原文的事实边界与两个分支

计划原文（development-plan 630-680 行区间）：

> 事实边界：当前 `SemanticEdgeStoreV2.findFrom()` 只保存有界正向边，references 还可能排序/截断；单条 COMPLETE edge 不代表 definition/references/hierarchy 某次 operation 的结果集合完整，因此不得仅凭 edge 存在跳过 live JDT。
>
> 推荐实现：若 telemetry 证明值得减少 live verify，新增 `SemanticOperationCoverageRecord`（按 symbolId+operation 记录一次 JDT 调用是否覆盖了完整结果集），用它安全地跳过/精简后续 live verify。
>
> 保守替代：不新增 coverage record；persisted/static 只提供正向候选和置信度，不承诺 operation completeness，也不据此跳过 live JDT。

两个分支互斥，取决于两件事：(a) 当前代码是否已经在做"保守替代"要求的事（不承诺、不跳过）；(b) 是否存在 telemetry 证明"推荐实现"分支值得投入。

### 3.2 当前代码实际行为——逐路径核查

**写入路径**（`src/semantic-edge-store.ts`）：`PersistedSemanticEdge.completion` 硬编码为字面量 `"COMPLETE"`（构造时唯一取值），`confidence` 硬编码为 `1`。`load()`（第 98 行）与 `putComplete()`（第 272 行）都会 `if (edge.completion !== "COMPLETE") { rejectedWrites += 1; continue; }`——这是纯粹的**写入期防御性校验**（拒绝任何非完整写入的边），不是向外部消费者传达的"这次 operation 的结果集合是完整的"这类断言。

**读取路径**（`src/agent-router/candidate-collectors.ts:186-209`，`edgeStoreV2.findFrom()` 的唯一消费者）：循环体只读取 `edge.relation`、`edge.targetFile`、`edge.targetRanges`。**从未读取** `edge.completion` 或 `edge.confidence`。

**证据层**（`src/agent-router/providers/semantic-provider.ts:57-111`，`collectPersistedSemanticEvidence`）：产出的 `EvidenceSignal` 上的 `confidence: 0.9`、`completeness: "COMPLETE" as const`（第 84-85 行）都是**该 provider 自己的固定字面量**，与底层 edge 的 `confidence`/`completion` 字段无关——即便某个 edge 的字段是别的值，evidence 层也不会读取或传播它。

**live JDT 是否会因为 persisted 证据"完整"而跳过**：`src/agent-router/index.ts` 中，`collectPersistedSemanticEvidence`（第 271 行附近）与 `collectLiveSemanticEvidence`（第 339-346 行）是两个独立调用；`grep -n "completeness|shouldUseSemantic" src/agent-router/index.ts` 确认 `index.ts` 里既不读 `completeness` 字段，也不在此处调用 `shouldUseSemantic*`——真正的 live-JDT 准入判断在 `semantic.ts` 内部，完全由 policy/budget/anchor 状态决定，与 persisted 阶段是否命中、命中了多少、"完整"与否无关。两阶段是**无条件顺序执行**，不是"persisted 完整就跳过 live"的短路关系。

结论：当前实现在 (a) 上已经满足"保守替代"——`completion`/`confidence` 是仅供 store 内部写入校验使用的不变量，从未作为 operation-completeness 或 max-confidence 断言暴露给排序/live-JDT 决策路径；没有任何一处因为"persisted 边存在且 COMPLETE"而跳过或精简 live verify。

### 3.3 telemetry 现状（决定是否值得走"推荐实现"分支）

`src/agent-router/impact-metrics.ts` 中现有的相关字段是逐请求布尔量 `verifyUsed`/`verifySkipped`，**没有**跨请求的聚合调用量/耗时/命中率 telemetry。这意味着：**没有 telemetry 证明"减少 live verify 值得投入"**（准确表述——不是"telemetry 证明不值得"，而是压根不存在支持这个判断所需的证据）。"推荐实现"分支的入场条件（"若 telemetry 证明值得"）不成立，不是因为被证伪，而是因为其所需证据从未被采集。

补充语境（不作为本决定的主要依据，仅记录）：V3.2-21 已关闭，`auto` 的 live JDT 调用本身对当前三仓 golden 集合零可测量质量收益——即使 `SemanticOperationCoverageRecord` 建成并证明"可以安全跳过"，跳过的是一个已经证明没有收益的调用，收益上限也是零。这进一步降低了投入优先级，但即使没有这一层，3.2 节的直接代码检查已足以独立支持关闭决定。

### 3.4 决定

**`CONSERVATIVE_ALTERNATIVE_ALREADY_SATISFIED`**——不新增 `SemanticOperationCoverageRecord` 或任何 coverage-record 机制，不修改 `semantic-edge-store.ts`/`semantic-provider.ts`/`semantic.ts`。理由：现状已经是计划自己定义的"保守替代"（persisted 只提供正向候选和置信度，不承诺 operation completeness，也不据此跳过 live JDT），且"推荐实现"分支的入场条件（telemetry 证明值得）不成立。本条目视为已关闭，非待办。

### 3.5 遗留的悬空依赖——记录，不在本轮处理

- HANDOFF.md 中 V3.2-22 的依赖行写的是"依赖 V3.2-08、V3.2-21"；V3.2-21 已关闭为 `DO_NOT_IMPLEMENT`，这条依赖已经悬空（V3.2-22 关闭本身不受影响，因为 3.2/3.3 节的证据独立于 V3.2-21 是否曾经落地）。
- V3.2-25 默认化硬门的 5 项条件（P95≤800ms 等）书写时假设 `auto` 仍会发起 live JDT 调用；V3.2-21 关闭后这个前提已经不成立。是否需要重写 V3.2-25 的条件本身，留给处理 V3.2-23/24/25 的后续步骤判断，本报告不代为决定。

## 4. V3.2-23：opt-in idle JDT prewarm 实验——前置条件缺失，实验无法负责任地执行

### 4.1 延迟收益是真实且巨大的——直接引用已有证据，未新建测量

计划原文的试验门是"first-touch P95 至少下降 30%，且 peak RSS/CPU 增幅 ≤10%"。延迟这一半，不需要新测量：`artifacts/v3-phase5/task35-first-touch-20260807/`（Task 35 已有证据，真实 jdtls 1.56.0，cipherlink 仓）已经直接给出答案：

| 条件 | attempt | ensureStartedMs | requestMs | totalMs |
| --- | --- | --- | --- | --- |
| `fresh`（每次全新 session） | 1 | 8552.6 | 33715 | 42268 |
| `fresh` | 2 | 6637.3 | 25658 | 32296 |
| `fresh` | 3 | 5812.5 | 30002 | 35815 |
| `reused`（同一 session 内多次请求） | 1（仍需完整 session+import） | 6171.3 | 25253 | 31425 |
| `reused` | 2（session 已就绪） | 0 | 182 | 182 |
| `reused` | 3（session 已就绪） | 0 | 177 | 177 |

`fresh` 的 totalMs（32296-42268ms）对比"已经预热完成的 session 再收到第一个真实请求"的代理值（`reused` 第 2/3 次，177-182ms），改善幅度 >99.5%，超过 30% 门槛约 300 倍。这个量级的差距不需要三仓精确复测来确认方向——已有的单仓证据就是决定性的。

### 4.2 `required`/live JDT 在默认路径上确实可达——不是"只有显式 opt-in 才会触发"

先核查了 `auto` 已被 V3.2-21 关闭是否意味着 prewarm 的受益面为空。结果是否定的：`src/server.ts` 里 `java_symbol`（hover/definition/implementation/references）与 `java_diagnostics` 两个工具的注册都硬编码 `semanticPolicy: "required"` 且 `requireLspEnabled: true`（`server.ts:59-77`），不经过 `java_impact` 那个默认 `auto` 的 `semanticPolicy` 参数（`tools/impact.ts:32` 的 zod schema 默认值是 `"auto"`，已被 V3.2-21 证明零收益）。也就是说：任何 Agent 只要调用 `java_symbol`/`java_diagnostics`（而不是显式在 `java_impact` 上传 `semanticPolicy=required`），就无条件走 live JDT——这是这两个工具存在的目的（hover/definition/references/diagnostics 本身就需要 live 语义，JavaIndex 静态快照回答不了），不是一个边缘 opt-in 路径。因此 prewarm 的受益面不是空集：session 中第一次调用这两个工具时都要付 4.1 节里 `fresh` 那档的冷启动代价。

### 4.3 但试验门的资源安全半边无法测量——这是工作负载问题，不是采样能力问题

计划的"禁止"条款很明确："仅把几十秒成本提前发生，然后把它包装成请求提速"。这条禁令保护的场景是：**在空闲窗口主动预热了某个仓库的 JDT，但这次会话里调用方从未真正查询这个仓库**——这时候预热白白消耗的 CPU/RSS 是纯浪费，试验门用"peak RSS/CPU 增幅 ≤10%"卡住这种情况。

核查了资源采样能力：`scripts/sample-java-runtime-resources.mjs`（V3.2-05，已存在，非本轮新增）已经是一个成熟的进程树采样器，能正确通过 ppid 链识别 JDT 子进程、跟踪 peak RSS/CPU-time-delta/fd/warmup 后的 retention slope。一开始误以为资源采样能力完全空缺，手写了一个简化版 `ps` 轮询脚本（`scripts/run-idle-prewarm-experiment.mjs`，本次会话新增、未提交，调试中遇到与 prewarm 判断无关的 harness 问题——`JDTLS_BIN` 透传缺失、`validateCandidateNodeCommand` 对嵌套 isolation broker 命令要求 `node` 而非 `sh` 起手、以及 `withFreshWorkspace` 清理阶段一个预先存在的 Gradle daemon 竞态 `ENOTEMPTY`——这些问题独立于本节结论，脚本按现状保留在工作区、不纳入本轮 commit）；但即使这个新脚本或已有的 V3.2-05 采样器都工作正常，**两者在结构上都只能测量"实际发起了请求"这条路径的资源开销**（`sample-java-runtime-resources.mjs` 包裹并采样一个真实执行的 COMMAND；本会话的 fresh-vs-reused 对比同样只在两个分支的末尾都真正发起了一次 `references` 请求）。没有任何现有工具能观测"预热了但从未被查询"这条路径的资源占用，因为没有一个当前的生产或 benchmark 代码路径会"启动 JDT 然后让它闲置不用"。

真正回答"禁止条款"需要的是**工作负载/命中率遥测**：某个会话里，被空闲预热的仓库有多大比例在合理窗口内真的收到过 `java_symbol`/`java_diagnostics` 调用。`src/agent-router/impact-metrics.ts` 目前只有逐请求布尔量，没有会话级/仓库级的"这次预热是否被使用"追踪——这与 V3.2-22 关闭时发现的 telemetry 缺口是同一类问题。

### 4.4 决定

**`DEFERRED_PENDING_WORKLOAD_TELEMETRY`**——不是 PASS（资源安全半边无法评估，不能声称门槛已满足），不是 FAIL（延迟收益是真实、巨大且受益面非空的，不能说这个方向没价值），也不是 `DO_NOT_IMPLEMENT`（不同于 V3.2-21/22，这里没有证据说明收益不存在或已经被现状满足）。正确的状态是：**计划要求的试验本身，在当前 telemetry 基础上无法被负责任地执行**——建成 opt-in 预热触发器并跑一次 fresh-vs-reused 式的 A/B，只能回答"预热之后的请求变快了吗"（4.1 节已经用现有证据回答了，答案是肯定的），回答不了计划"禁止"条款真正要防的问题（未使用的预热是否白白增加资源占用）。在没有会话级预热命中率 telemetry 之前实现并默认开启这个功能，正是"仅把成本提前发生"这条禁令想要阻止的那种交付方式。

构建这类 telemetry（记录"这次预热的 JDT session 在多久之后、是否、被第一次真实请求使用"）本身是一项有实质范围的功能改动，不应该在一个号称"只是测量"的实验步骤里顺手决定并实现——留给后续会话作为一个独立、需要明确评估 LOC 成本的决策（当前 LOC ledger 只剩 4 行余量，见 §5）。

### 4.5 依赖状态核查（V3.2-04/V3.2-05）

HANDOFF.md 记录 V3.2-23 依赖 V3.2-04（JDT first-touch 分段 telemetry）、V3.2-05（进程树资源采样）。核查确认两者均已存在：`src/jdtls-session.ts` 的 `JdtFirstTouchRecorder`/`JdtFirstTouchSessionTrace`（V3.2-04 范围）与 `scripts/sample-java-runtime-resources.mjs`（V3.2-05 范围）都是已落地代码，不是本轮新增。这两项依赖本身是满足的；4.3 节的缺口不是"V3.2-04/05 没做"，而是"V3.2-04/05 提供的是逐请求/逐调用的观测能力，而试验门需要的是会话级工作负载命中率，这是一个二者都没有覆盖、计划里也没有单列条目的更高层遥测"。

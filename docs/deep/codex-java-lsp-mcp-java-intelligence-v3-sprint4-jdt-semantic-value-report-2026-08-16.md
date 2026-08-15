# Java Intelligence V3 Sprint 4 进行中报告（V3.2-21/22：auto admission / persisted semantic operation-completeness）

来源计划：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-value-realization-optimization-development-plan-2026-08-09.md` 第 630-680 行（Sprint4，V3.2-21~25）。

本报告随 Sprint4 进展持续追加小节；截至本次提交只覆盖 V3.2-21（关闭状态回顾）与 V3.2-22（本轮新增）。V3.2-23/24/25 尚未开始。

## 1. 直接结论

| 编号 | 结论 |
| --- | --- |
| V3.2-21 | `DO_NOT_IMPLEMENT`（已于 2026-08-15 关闭，详见 `docs/phase-v3/phase5-semantic-first-touch-decision.md` 追加小节） |
| V3.2-22 | `CONSERVATIVE_ALTERNATIVE_ALREADY_SATISFIED`（本轮关闭，无需代码改动） |

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

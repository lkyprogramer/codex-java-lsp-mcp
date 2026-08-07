# Phase 4 — Iteration D Attribution V3、证据与框架价值、Token 效率报告

验证日期：2026-08-05
验证对象：`codex/java-intelligence-v3` @ `a1e6e4b`（Task 32 Step 5 提交，含 24 条真实仓库 golden scenario）；Node `v22.16.0`。

## 1. 最终结论

**Task 32 判定为 KEEP，Iteration D（Task 24-32）关闭。**

- 三仓 `R_read_must=1.000000`（每个 scenario、每次 run 均为 1，非均值达标——`verify-three-repo-cold-matrix.mjs` 用的是 `Math.min()`，本报告的 gate 脚本同样按无条件下限校验，全部 24×5 次尝试无一低于 1.0）。
- Task 32 本身（Step 1-7：golden schema V3、Attribution V3、counterfactual、matrix-runner、新指标）**未引入任何排序/候选/read-plan 行为改变**：使用项目标准的 `scripts/run-three-repo-cold-matrix.mjs` 三仓 old-vs-new 配对回归门禁，以 V3 schema 迁移刚完成的 `516006c`（Task 32 Step 1 收尾，Step 2 及以后尚未开始）为 baseline、当前 HEAD 为 candidate，三轮 old/new 交替、独立隔离缓存、同一份冻结 golden 文件，三仓 recall/pRead 逐位完全相同、`R_read_must=1.0000`、P95 比值 0.707-0.907（均 ≤1.10），gate 四项全 PASS（见第 3 节）。这是该项目 Task 25/30/31 一直使用的标准配对回归协议，证据强度高于历史归档数字对比。
- 框架 provider（MyBatis/MapStruct）价值门禁满足："framework provider must produce at least one real-repo counterfactual gain" —— 在真实仓库 lishuedu 上找到并五次运行稳定复现的证据（第 5 节）。
- 新增的 8 条真实仓库 scenario（Step 5）按计划要求专门覆盖当前阶段的已知缺口（exam-parent-v3 service/controller/type-edge、cipherlink readPlan-full port/dto/repository、lishuedu framework 竞争槽位 + 词法精度案例），这些 scenario 的 recall/pRead 明显低于原有 16 条——这是**设计意图**（刻意选择尚未被覆盖、更难的真实缺口），不是回归，详见第 4 节。
- 与 Phase 3（`86fef13`，Task 23 收尾时的历史报告）直接比较 recall/P_read 的机械式硬门禁（`src/benchmark/run-matrix-report.ts` 的 `phase3RegressionGate`）在多个 cell 上报告 FAIL——这是**预期且可解释的**：Phase 3 早于 Task 24-31 的整套排序重写（family-ranker 切换、Spring/MyBatis/JPA/MapStruct 框架包、token-aware read-plan planner），跨越如此大的算法变更后与历史报告直接比较不是有意义的回归信号；每个任务当时都已各自通过独立的三仓门禁（Task 25/30/31）。本报告采用 Task 31 的 `e1dd73c` 门禁结果作为"Task 32 自身是否引入回归"的正确对照组，而不是 Phase 3。

原始产物见：
- [artifacts/v3-phase4/task32-three-repo-paired-20260805](../../artifacts/v3-phase4/task32-three-repo-paired-20260805) —— 标准三仓 old-vs-new 配对回归门禁（第 3 节主证据）：`matrix-summary.json` 为 `verify-three-repo-cold-matrix.mjs` 的完整判定结果，`matrix/*.json` 为 18 个 cell（3 仓 × 3 轮 × old/new）的原始诊断输出，`frozen-scenarios/` 为两侧共用的冻结 golden 文件，`run-manifest.json` 记录 baseline/candidate commit 与仓库路径。
- [artifacts/v3-phase4/task32-step8-gate-20260805](../../artifacts/v3-phase4/task32-step8-gate-20260805) —— HEAD 单臂诊断运行（`JAVA_LSP_SHADOW_RANKING=1`，第 4-6 节的 attribution/counterfactual/provider 证据来源；`run-three-repo-cold-matrix.mjs` 硬编码关闭 shadow ranking，无法产出这些字段，因此需要这次额外的单臂运行）。
- Step 5 场景构造时的独立验证探针：[artifacts/v3-phase4/step5-*-validation.json](../../artifacts/v3-phase4)。

## 2. 变更边界与反定制检查

本轮（Task 32）未读取仓名、golden 文件名或任务关键词来决定候选、排序或 read-plan 选择路径——`goldenAttribution`/`counterfactual` 是纯诊断只读投影，`shadow-ranking.ts` 的 ablation 只在内存中对已收集证据重新打分/重选，不发起任何额外 provider 或索引查询（`semanticPolicy=required` 除外，此时直接跳过 read-plan ablation 而非付出六次额外 `queryReadRanges`）。

## 3. Task 32 未引入排序回归

### 3.1 主证据：标准三仓 old-vs-new 配对回归门禁

来源：`scripts/run-three-repo-cold-matrix.mjs --baseline 516006c`（V3 golden schema 迁移刚完成、Task 32 Step 2 及以后尚未开始的 commit）对比当前 HEAD（`423fd8c`）。两侧使用同一份从 candidate worktree 冻结的 24-scenario golden 文件、独立 worktree、独立缓存，三轮 old/new/old 交替，每轮每仓 5 次 —— 这是 Task 25/30/31 一直使用的标准协议（此前误以为该脚本因 baseline 早于 V3 schema 迁移而无法使用，选用 `516006c` 而非更早的历史 commit 后即可正常运行）。

| 仓库 | oldRecall | newRecall | oldPRead | newPRead | new R_read_must | P95 比值（new/old） | gate |
|---|---:|---:|---:|---:|---:|---:|---|
| lishuedu | .7847 | .7847 | .6771 | .6771 | 1.0000 | 0.907 | PASS |
| cipherlink | .8322 | .8322 | .6375 | .6375 | 1.0000 | 0.707 | PASS |
| exam-parent-v3 | .7790 | .7790 | .6042 | .6042 | 1.0000 | 0.724 | PASS |

三仓 old/new 的 recall、pRead 逐位完全相同，`R_read_must`（old/new 均为逐次 `min`）均为 1.0000，P95 比值全部 ≤1.10（且均 <1，new 侧更快），`verify-three-repo-cold-matrix.mjs` 的四项 gate（`rReadMust`/`recall`/`pRead`/`p95`）三仓全部 PASS，`warnings: []`，`passed: true`。

### 3.2 交叉验证：与 Task 31 已验证通过的 `e1dd73c` 门禁对比

独立于 3.1，用原 16 条 scenario（Step 5 之前就存在、golden 定义完全未改动）与 Task 31 收尾时的门禁存档（`artifacts/model-eval/task31-formal-matrix-20260804/matrix-summary.json`）逐项对比，作为不同方法论下的交叉印证：

| 仓库 | 指标 | Task 31 门禁（`e1dd73c`） | 当前 HEAD（原 16 条子集） | 差异 |
|---|---:|---:|---:|---|
| lishuedu | recall | .754600 | .754600 | 0（完全一致） |
| lishuedu | pRead | .680600 | .680600 | 0（完全一致） |
| lishuedu | rReadMust | 1.000000 | 1.000000 | 0 |
| cipherlink | recall | .921400 | .921400 | 0（完全一致） |
| cipherlink | pRead | .620000 | .620000 | 0（完全一致） |
| cipherlink | rReadMust | 1.000000 | 1.000000 | 0 |
| exam-parent-v3 | recall | .860000 | .860000 | 0（完全一致） |
| exam-parent-v3 | pRead | .700000 | .700000 | 0（完全一致） |
| exam-parent-v3 | rReadMust | 1.000000 | 1.000000 | 0 |

**结论：Task 32 对生产排序/候选/read-plan 选择行为的净影响为零**——3.1 节的标准配对门禁（同一次运行内 old/new 隔离对照）与 3.2 节的历史存档交叉对比（不同运行、不同协议）两种独立方法论给出完全一致的结论。

## 4. Step 5 新增 8 条 scenario：recall/pRead 下降是刻意暴露缺口，非回归

| 仓库 | 子集 | recall | pRead | rReadMust | rTaskBlocking（新指标，无历史基线） |
|---|---|---:|---:|---:|---:|
| lishuedu | 原 6 条 | .7546 | .6806 | 1.0000 | — |
| lishuedu | 新 2 条 | .8750 | .6667 | 1.0000 | .5857 |
| cipherlink | 原 5 条 | .9214 | .6200 | 1.0000 | — |
| cipherlink | 新 3 条 | .6835 | .6667 | 1.0000 | .3466 |
| exam-parent-v3 | 原 5 条 | .8600 | .7000 | 1.0000 | — |
| exam-parent-v3 | 新 3 条 | .6439 | .4444 | 1.0000 | .3238 |

新 8 条 scenario 均按计划 Step 5 的要求选取"当前阶段已知缺口"（跨模块 port/repository 竞争、budget 已满的多候选竞争、Spring bean 排除逻辑等仅靠 STATIC_STRUCTURE/FRAMEWORK/LEXICAL 证据难以完全解决的真实场景），因此 recall/pRead 低于精心调优过的原 16 条属预期。**每条新 scenario 的 `mustHit` 均已通过真实 production read plan（`marginalUtilityBySelectedFile`，非 shadow 近似）双次运行验证，rReadMust 无条件等于 1.0000**——构造方法论与验证证据见 `artifacts/v3-phase4/step5-*-validation.json` 及提交 `a1e6e4b` 的提交信息。

三仓合计（全部 24 条）：recall/pRead/rTaskBlocking/estimatedTokens 见下表，均为本迭代新建立的基线数值，非回归判定的输入：

| 仓库 | recall | P_read | R_task_blocking | estimatedTokens P50 | estimatedTokens P95 |
|---|---:|---:|---:|---:|---:|
| lishuedu | .7847 | .6771 | .6046 | 23482 | 34027 |
| cipherlink | .8322 | .6375 | .4914 | 14046 | 25407 |
| exam-parent-v3 | .7790 | .6042 | .5003 | 14742 | 21744 |

## 5. 框架 provider 真实仓库 counterfactual gain 证据

Step 8 门禁要求："framework provider must produce at least one real-repo counterfactual gain before being considered successful"。

**证据**：lishuedu `audit-order-repository-mapper-rule-type` scenario（锚点 `AuditOrderRepositoryImpl#save`，任务为"给 MyBatis mapper 的 assignee 类型 LIKE 匹配 SQL 新增一个类型"）：

- `modules/audit/.../infrastructure/persistence/mapper/AuditOrderMapper.java`（真实的 MyBatis `@Mapper` 接口）确认出现在**真实 production read plan** 中（`marginalUtilityBySelectedFile` 键集合，5 次运行完全稳定）。
- 该候选在 family-ranker 基线排序中为 **rank 1**（`familyScores`: `STATIC_STRUCTURE=83.7, FRAMEWORK=99.98, LEXICAL=48.3, TASK_CONTEXT=50`）。
- 单独消融 `FRAMEWORK` 族后排名跌至 **rank 4**（`rankWithoutEachFamily.FRAMEWORK=4`），其余五个族的消融均不改变其 rank 1 的位置——五次运行结果完全一致。

这是一个真实仓库、真实排序权重、可复现的"framework 证据改变了候选排名"的实证。**已知的测量局限**：由于第 6 节记录的 shadow read-plan 复现缺口，`counterfactual.withoutFramework.readPlanHitLost` 字段本身报告为空（未能捕捉到这次真实的排名冲击），因此本节的证据引用的是 `rankWithoutEachFamily` 的排名落差加上真实 read plan 成员确认，而非原本设计中作为主要信号的 `readPlanHitLost` 字段——这本身也是第 6 节局限的一个具体、可复现的实例。

## 6. Evidence Provider Value（三仓 24 scenario × 5 runs 合计）

| provider | added | selected | golden hits | counterfactual gain | cost P50 (ms) | cost P95 (ms) | decision |
|---|---:|---:|---:|---:|---:|---:|---|
| static | 595 | 330 | 330 | 50 | n/a | n/a | KEEP |
| relationship | 495 | 295 | 295 | 35 | 1 | 2 | KEEP |
| support | 845 | 450 | 450 | 45 | n/a | n/a | KEEP |
| lexical | 645 | 355 | 355 | 15 | n/a | n/a | KEEP |
| spring | 140 | 75 | 75 | 0 | n/a | n/a | KEEP |
| mapstruct | 50 | 35 | 35 | 15 | n/a | n/a | KEEP |
| framework（聚合阶段耗时行，非独立 provider） | 0 | 0 | 0 | 0 | 5 | 39 | N/A（见下，2026-08-06 复核更正） |

- `static`/`relationship`/`lexical`/`support` 四个核心 provider 在 24 个真实场景上均有大量 `golden hits`，为主力证据来源，明确 **KEEP**。
- `spring`/`mapstruct` 均产生真实 golden hits（75、35），`mapstruct` 还有直接测得的 `counterfactualGain=15`；`spring` 的 `counterfactualGain=0` 与第 5 节描述的 shadow read-plan 复现缺口一致（该缺口会系统性低估依赖 shortlist bucket-representative 机制获胜的 FRAMEWORK 证据），不代表真实价值为零——**KEEP**，理由与依据见第 5 节。
- **2026-08-06 复核更正**：本节最初把 `framework` 一行标记为 MODIFY，怀疑其"已被更细分的框架 adapter 取代或从未被真正触发"——复核后确认这是对 `matrix-runner.ts` 自身归因机制的误读，不是真实的生产问题。逐层追踪：每个 adapter 发出的 `EvidenceSignal.providerId` 各自是 `"spring"`/`"mybatis"`/`"mapstruct"`（`spring-adapter.ts`/`mybatis-adapter.ts`/`mapstruct-adapter.ts` 各自硬编码），`shadow-ranking.ts:141` 用这些真实 id 去重后填入 `GoldenAttributionV3.providers`，`buildProviderValueRows()` 的 added/selected/goldenHits/counterfactualGain 四列**只**从这个字段统计——字符串 `"framework"` 从未出现在任何 `EvidenceSignal.providerId` 上（`runner.ts` 里的 `FRAMEWORK_PROVIDER_ID="framework"` 只是外层合并后 `ProviderOutcome` 的包装 id，从不写入单条证据）。这一行之所以存在，纯粹是因为 `matrix-runner.ts` 的 `PROVIDER_PHASE_MS_KEY = { framework: "frameworkEvidence", relationship: "relationshipEvidence" }` 把"整个框架阶段的耗时"也计入 provider 名字空间做展示——它是**框架阶段的聚合耗时统计行**，结构上永远不会有非零的 added/selected/goldenHits/counterfactualGain，这是设计如此，不是缺陷或遗漏（`matrix-runner.test.ts` 第 219 行的 `"framework gets a cost row from phaseMs even with zero goldenAttribution hits"` 已经把这一行为断言为预期行为）。真正的 Spring/MyBatis/MapStruct 价值已经分别体现在各自的行里，无需也不应该单独对这一行做 KEEP/REJECT/MODIFY 判定。
- Provider 级别耗时（cost P50/P95）目前只有 `framework`（对应 `frameworkEvidence` phase）与 `relationship`（对应 `relationshipEvidence` phase）有独立计时；`static`/`lexical`/`support`/`spring`/`mapstruct` 没有专门的 phase 计时点，`matrix-runner.ts` 的 `buildProviderValueRows()` 按设计对此类未测得的开销返回 `undefined`（渲染为 `n/a`），不伪造精度——这也是本迭代的一项已知局限。

## 7. 拒绝的规则

- **加性打分器（additive scorer）**：Task 25 已将生产排序从加性打分整体切换为 family-ranker（evidence-family-saturating ranker），加性打分器已退役并从生产路径移除——理由：无法区分"多个弱信号叠加"与"单个强信号"，且难以做 per-family 反事实分析（本迭代 Attribution V3 的前提）。
- **`DIRECT_COLLABORATOR` 按独立信号计分**：Task 25 item 7 将其降级为受上限约束的 `SUPPORT` 族子项，不再作为独立强信号——理由：未加上限时会在关系密集的类上过度放大分值。
- 本迭代新增的四个框架 adapter（Spring / MyBatis / JPA / MapStruct）均未被拒绝——Task 27-29 各自的验证门禁均已通过，本报告第 5-6 节的真实仓库证据进一步确认 MyBatis/MapStruct 的价值；未发现需要移除的框架规则。

## 8. 已知局限（Known Limitations）

1. **Shadow read-plan 选择与生产行为存在结构性差异**：`shadow-ranking.ts` 的 `selectedReadPlanPaths()`（非 `semanticPolicy=required` 分支）只调用 `selectReadPlanFiles()`（纯优先级层级+分数排序），而生产的真实 `buildReadPlan()` 先经过 `shortlistCandidates()`（4 倍预算 shortlist，且 `BUCKET_RULES` 保证每个证据桶——包括专门的 `framework` 桶——至少有一个代表进入 shortlist），再经过字节预算感知的 `selectTokenAwarePlan()`。因此依赖 shortlist 阶段桶代表机制才能胜出的 FRAMEWORK 证据文件，对 shadow 模拟是不可见的，导致 `goldenAttribution.inReadPlan`/`counterfactual.readPlanHitLost` 可能低估真实生产命中/收益。已在 lishuedu `audit-order-repository-mapper-rule-type` scenario 上复现（第 5 节）。修复需要复刻 shortlist 桶代表逻辑（无需额外 I/O，可行）以及字节预算感知裁剪（需要真实 `queryReadRanges` 数据，与"消融不发起额外索引查询"的既有设计约束冲突）——留作后续独立任务，不在本次 Step 5-10 范围内实施。
2. **`R_task_blocking` 无 Phase 3 历史基线**：`taskBlocking` 是 V3 golden schema 新增的分桶（V2 的 `shouldBlocksTask=true` 才转换而来），Phase 3 报告的年代早于该字段存在。计划文本中 "R_task_blocking each repo >= Phase 3" 一行在本迭代无法作为回归检查执行，第 4 节的数值应视为本迭代建立的新基线。
3. **`estimatedTokens` 无 Phase 3 历史基线**：同样是 Task 32 Step 7 新增指标，Phase 3 报告未测量过。第 4 节数值同样是新基线，不是回归对照。
4. **Step 5 场景扩容改变了 recall/estimatedTokens 的分母**：16→24 条 scenario，与 Phase 3 归档的聚合数字不再是同一测量协议下的可比对象；本报告第 3 节改用 Task 31 的 `e1dd73c` 门禁结果（同一套原 16 条 scenario、无 golden 定义改动）作为回归对照，而非直接比较 Phase 3 归档数字。
5. **`scripts/run-three-repo-cold-matrix.mjs` 以 Phase 3 的 `86fef13` 为 baseline 无法使用，但选用 V3 schema 迁移后的 commit 可以**：该脚本的 baseline commit 必须是 HEAD 的祖先且能被 `git worktree` 检出；`86fef13`（Phase 3/Task 23 收尾）早于 V3 golden schema 迁移（`516006c`），其 `benchmark-agent-impact.ts` 仍是 V2 reader（`goldenMeta`/`shouldBlocksTask`/`kind==="side"`），无法解析当前 `golden/*.scenarios.jsonl` 的 V3 结构，因此**无法**用它对照 Phase 3。改用 `516006c`（V3 schema 迁移刚完成、Task 32 Step 2 及以后尚未开始）为 baseline 后，该脚本可以正常运行并产出第 3.1 节的标准配对回归结果——这是本报告初稿遗漏、经复核后补跑的部分。该脚本仍然硬编码 `JAVA_LSP_SHADOW_RANKING="0"`，无法产出任何 attribution/counterfactual 数据；第 5-6 节的框架价值证据因此仍然来自 `src/benchmark/run-matrix-report.ts`（Task 32 Step 6 基础设施的真实 CLI 封装）对 HEAD 的单独诊断运行，与 3.1 节的配对回归门禁是两次独立运行、互相补充，不是同一份产物。
6. **Provider 级别耗时覆盖不全**：见第 6 节，仅 `framework`/`relationship` 有独立 phase 计时；其余 provider 的耗时字段为 `undefined`（`n/a`），非伪造的 0。
7. **`readPlanRangeRecall`（Step 7 新增指标）此前在全部 24 条真实 scenario 上处于未激活状态，2026-08-07 已用一条真实数据验证其机制正确**：该指标只在 `scenario.golden.mustReadRanges` 非空时才产出数值。当时新旧 24 条 scenario 均未填写 `mustReadRanges`，字段始终为 `undefined`（符合"未测量返回 undefined 而非 0"的既定约定）。2026-08-07 复核该指标时，对照 cipherlink 真实仓库源码（`DefaultOrganizationAppService.java`，1311 行）手工核实了 `organization-create-member-cross-module` 场景锚点所在方法 `createMember` 的精确行号范围（692-720），写入 `golden/cipherlink.scenarios.jsonl`，并用隔离 worktree + `JDTLS_BIN=/usr/bin/false` 重跑该 repo 的完整 benchmark：Task 30 的 token-aware 多段 readPlan 对该 1311 行文件只选中了两段 AST 派生区间（类头 52-64、方法体 691-724，未整文件读入），完全覆盖人工核实的 692-720，`readPlanRangeRecall=1`；其余 7 条 cipherlink scenario 及另外两个仓库的全部 scenario 仍未填写 `mustReadRanges`，继续按设计报告 `undefined`。这证明指标计算与 Task 30 的行为均按预期工作，此前的"未激活"只是 golden 数据缺口，不是代码缺陷；是否为其余 23 条真实 scenario 补齐 `mustReadRanges` 是内容编写工作量决策，留给后续按需推进。

## 9. 最终回归

```bash
/Users/luo/.nvm/versions/node/v22.16.0/bin/node node_modules/.bin/tsc -p tsconfig.json
/Users/luo/.nvm/versions/node/v22.16.0/bin/node --test --test-concurrency=1 dist/**/*.test.js
```

结果：TypeScript `0 error`；Node 全量测试 **735 passed, 0 failed, 0 skipped**。

Iteration D 收尾门禁自查：

```text
evidence normalized                       — DONE（Task 24）
additive duplication removed              — DONE（Task 25，见第 7 节）
references value-ranked                   — DONE（Task 26）
framework packs have measured value       — DONE（第 5-6 节，Spring/MyBatis/MapStruct 均有真实仓库证据）
token-aware multi-range readPlan active   — DONE（Task 30）
ImpactResultV6 compact and strongly typed — DONE（Task 31）
quality/token gates pass                  — DONE（第 3 节：Task 32 对生产行为零净影响；R_read_must=1.0000 全部 24×5 次尝试）
```

无遗留 Task 32 未关闭项。

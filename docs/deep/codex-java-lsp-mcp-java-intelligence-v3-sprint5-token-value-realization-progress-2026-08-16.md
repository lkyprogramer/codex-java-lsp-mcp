# Java Intelligence V3 Sprint 5 进展报告（V3.2-26 / V3.2-27）

来源计划：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-value-realization-optimization-development-plan-2026-08-09.md` 第 685-725 行（Sprint5，V3.2-26~30）。

本报告只覆盖本轮已关闭的两项：V3.2-26（优化默认 `standard` 输出）、V3.2-27（range-first source planning）。V3.2-28/29/30 未开始。

## 1. 直接结论

| 编号 | 结论 |
| --- | --- |
| V3.2-26 | 字节半场 `CLOSED_VIA_V3.2-02_EXIT_CONDITION`（15% vs Sprint0 baseline 的原定数值门不可测；`standardToDiagnosticBytesRatio` 已 ≪0.5，按 V3.2-02 自身退出条件转向真实 Agent trace）；Agent 使用质量半场移交 V3.2-30（已获 V3.2-07b 授权） |
| V3.2-27 | `MODIFY_REJECTED_STRUCTURAL`（本次分析的低成本修法——用 type header 位置替换 `(1,1)` fallback——被证明结构性地帮不到实际 miss 集合；真正的修法需要 `hydrate:true` 获取具体方法级位置，成本未量化，留作未来工作，本轮不实现） |

## 2. V3.2-26：优化默认 `standard` 输出

### 2.1 计划原文的目标与退出条件

计划原文（685-696 行）：目标是 "standard serialized bytes P50 相对 Sprint0 baseline 至少下降 15%，且 Agent task success、后续 reads 和 quality 不退化"；依赖 V3.2-02，其退出条件是 "如果 standard payload 已低于 diagnostic 的 50%，后续 Token 优先转向真实 Agent trace，不继续围绕 diagnostic 压缩"。

### 2.2 Sprint0 baseline 不可测——已核实

`artifacts/v3-baseline/48e665ba73dc/` 下的文件全部是 2026-07-24 生成的 0 字节 JSON（`ls -la` 直接核实），Sprint0 的真实 standard-bytes-P50 从未被实际捕获过。这意味着计划原文"相对 Sprint0 baseline 下降 15%"这一数值门本身不可评估——不是"未达到"，是没有分母。

### 2.3 V3.2-02 退出条件——已用真实数据确认，早于本轮改动即已成立

用现有 `buildImpactPayloadProjectionV3`（`src/benchmark/attribution-v3.ts`）跑 cipherlink 10 个 golden 场景，`standardToDiagnosticBytesRatio` 的 P50：

| | standard bytes P50 | ratio P50 |
| --- | --- | --- |
| 本轮改动前（baseline，`artifacts/v3-final/sprint5-v326-payload-baseline-20260816/cipherlink.json`） | 11432 | 0.338 |
| 本轮改动后（remeasure，`artifacts/v3-final/sprint5-v326-payload-remeasure-20260816/cipherlink.json`） | 11124 | 0.329 |

两者都远低于 0.5 的退出阈值——即使不做本轮的字段级修剪，V3.2-02 的退出条件也早已成立。这是本项的核心判据，不是本轮改动的功劳。

### 2.4 本轮实际改动：`readPlan[].ranges[].reason` 从 standard/compact 剥离

审计 `applyVerbosity()`（`src/agent-router/format.ts`）发现：`files[]` 侧已经在 standard/compact 剥离 `reasons`/`verifiedBy`/`scoreBreakdown`（诊断专用字段），但 `readPlan[]` 从未被 `applyVerbosity` 触碰过——`payload.readPlan` 原样透传三种 verbosity。逐字段核查 `readPlan[].reason`（文件级，来自 `readReason()`，5 个固定短语之一）与 `readPlan[].expectedEvidence`（`evidenceKeys()` 派生，standard/compact 下是 `files[].reasons`/`verifiedBy` 被剥离后唯一残留的证据信号，不能再删），只有 `ranges[].reason`（range 级，来自 `readRangeReason()`，如 "AST method range" / "fixed-radius fallback"）与 `files[].scoreBreakdown` 同属"解释内部如何推导"的诊断专用信息，无对应保留理由。

**改动**：`agent-types.ts` 把 `ReadRange.reason` 改为可选；`format.ts` 的 `applyVerbosity()` 在非 diagnostic 时剥离每个 range 的 `reason`；连带修复 `src/benchmark/attribution-v3.ts` 的 `candidateReadPlanFingerprint()`——它之前把 `payload.readPlan` 整体（含 `reason`）纳入 candidate/read-plan **身份**哈希，而这个哈希的设计意图本就是只覆盖身份（`files` 侧已经手动排除了 `reasons`/`verifiedBy`/`scoreBreakdown`），所以 `readPlan` 侧也需要排除新剥离的 `ranges[].reason`，否则会把"标准化层面的字段裁剪"误判成"candidate/read-plan 身份变了"（`benchmark-agent-impact.test.ts`/`attribution-v3.test.ts` 两个既有断言在改动后立即捕获了这个不一致，证明该断言本身是有效的正确性网）。`src/benchmark/determinism.ts` 相应加 `?? ""` 防御（其消费的是 diagnostic 原始对象，实际永远非 undefined，但类型收紧后需要满足签名）。`read-plan.test.ts` 两处断言改用 `!` 断言（同样在 diagnostic 构造路径上，值恒定存在）。`format.test.ts` 新增对 `readPlan[].ranges[].reason` 在三种 verbosity 下行为的断言。

**实测收益（cipherlink，全部 10 场景 P50，见 2.3 表）**：standard bytes 从 11432 降到 11124，**-2.69%**——一个真实但小的一致性修复，远不足以单独满足 15% 目标（该目标本身也不可测，见 2.2）。只测了 cipherlink；剥离机制对 verbosity 投影是仓库无关的（不依赖具体 repo 的候选内容），故认为量级可外推，但未对 lishuedu/exam-parent-v3 做同样测量，不作为已验证事实陈述。

**输出契约变化，需明确记录**：`readPlan[].ranges[].reason` 不再出现在默认（`standard`）MCP 响应里。已检索 `README.md`、`docs/` 下现存文档、`docs/evals/.../prompts/*.md`（agent 侧 prompt），没有任何文档把这个字段列为已承诺的输出契约，也没有正式的 output JSON schema（`scripts/measure-tool-schema.mjs` 测的是 `tools/list` 的 input schema，不是这个）。这是一个**已核实的事实**（检索过，确认没有），不是遗漏。

### 2.5 disposition

字节半场关闭为 `CLOSED_VIA_V3.2-02_EXIT_CONDITION`：不是"达到了 15% 目标"（不可测），而是"V3.2-02 自身的退出条件已经成立，按计划原文应转向真实 Agent trace，不再围绕 diagnostic-relative 压缩投入"。本轮的字段裁剪是顺手做的一致性修复，不是满足数值门的证据。计划原文"Agent 使用/补读不退化"的验收依赖 V3.2-07b——已于本会话早些时候获得用户授权（[[v32-07b-authorization]]），该半场的实际验证移交 V3.2-30。

## 3. V3.2-27：range-first source planning

### 3.1 计划原文的验收

"24+6 holdout 的 `RangeLineRecall=1`；所有 V2 坐标标注的 `RangeCoordinateRecall=1`；read bytes P50 至少下降 15%；R_must/R_task 不退化。"

### 3.2 实测 baseline（本轮首次测量，此前无 baseline）

`artifacts/v3-final/sprint5-v327-range-recall-baseline-20260816/{cipherlink,lishuedu,exam-parent-v3}.json`，各仓 10 场景：

| | RangeLineRecall | RangeCoordinateRecall |
| --- | --- | --- |
| cipherlink | 0.85 | 0.85 |
| lishuedu | 0.634 | 0.634 |
| exam-parent-v3 | 0.5525 | 0.5525 |

三仓均远低于目标 1.0——一个真实、未关闭的实现缺口（不同于 Sprint4 大部分项目"测量即关闭"）。

### 3.3 miss 根因分类（先前 fork 分析 + 本轮 golden 数据核实）

对全部 15 个 miss 场景，从 golden `mustReadCoordinateRangesV2` 提取真实 start line，归纳出至少 5 类独立失败模式：top-of-file-fallback（候选位置硬编码 `(1,1)`）、near-miss-boundary（选中范围与 golden 边界接近但不重合，根因未定）、budget/shortlist truncation（预算/候选数上限主动排除，是设计取舍不是 bug）、second-position-not-queried（同文件的第二个证据位置未被查询）、out-of-scope（候选发现阶段就没找到，属于 ranking 而非 range-planning）。

### 3.4 对 top-of-file-fallback 的低成本修法——结构性证伪，本轮不实现

`candidateFromFacts()`（`src/agent-router/candidate-helpers.ts:12-27`）给每个从 `typeGraph`/`importGraph` 收集来的候选硬编码 `positions: [{line: 1, column: 1}]`。这个位置最终传入 `javaReadRanges()`（`java-index-worker.ts`），命中 `fallbackReadRange()`：`{startLine: max(1, line-10), endLine: max(1, line+22)}`——对 `(1,1)` 就是 **lines 1–23**。

关键推论：**任何因为这个 bug 而"miss"的场景，golden 起始行按定义必然落在 ~23 行之后**——否则它早已落在 [1,23] 内被算作命中，不会出现在 miss 列表里。本轮从 golden 数据里逐一核实了这个推论：确实落在 [1,23] 内、本应是这个 bug 受益者的几个 range（`CebOrderCreateResponse{9,16}`、`ParentStudentBenefitItemView{14,15}`、`ExamRoomPrintBundleService{10,21}`、`CurrentUserService{10,10}`）**全部已经是命中，不在 15 个 miss 里**；而真正的 15 个 miss 起始行是 50、77、102、136、162、238、961 这类量级。

一个"改用 type 声明行代替 `(1,1)`"的候选修法（`typeHeaderRange()` 是声明行附近约 13 行的窗口）落点仍然在 1–40 行这个低区间，和 [1,23] 高度重叠，**帮不到任何一个实际 miss**——这不是"收益小"，是这条修法结构性地打错了区间。真正需要的是候选生成阶段就带上"命中原因所在方法/字段"的具体位置（例如 `findImplementers` 匹配到的是哪个被覆写方法），而不是整个类型的声明行。

排查 `JavaSourceFacts` 的位置数据来源（`router-facts.ts` 的 `typeFactsToSourceFacts()`）发现：`collectTypeGraphCandidates`/`collectImportGraphCandidates` 两个调用点都用 `hydrate:false`，此路径下 `methods: []`（空），真实方法级位置只有强制 `hydrate:true` 才能拿到，而这会牵动 Sprint2 已经做过的 JavaIndex 批量化优化，成本未量化。

### 3.5 disposition

`MODIFY_REJECTED_STRUCTURAL`：不做 type-header 替代修法（结构性证伪，不是"收益不够"）；真正的修法（线程具体方法位置 + `hydrate:true`）成本未量化，留作后续 sprint 的独立评估项，本轮不实现、不占用 LOC 余量。near-miss-boundary/budget-truncation/second-position/out-of-scope 四类同样留待后续，其中 near-miss-boundary 已确认不是单纯的"总是少读尾部"模式（`paper-task-claim-iam-holdout`：golden 28–44 vs 实选 19–43，起点更早、仍然 miss），根因未定。

## 4. 验证

- `src/agent-router/format.test.ts`、`src/benchmark/determinism.test.ts`、`src/agent-router/read-plan.test.ts`、`src/benchmark/attribution-v3.test.ts`、`src/benchmark-agent-impact.test.ts`：已在隔离环境（`run-isolated-validation.mjs --profile targeted`）跑过，66/66 通过。
- 全量隔离回归（`--profile full`）：921/921 单测 + 100/100 `scripts/*.test.mjs` + smoke 全绿，exit 0（`bash -lc` 需显式 `export PATH="/opt/homebrew/bin:$PATH"`，否则本机 PATH 顺序会把 `/usr/local/bin/git`——一个 2015 年的 git 2.3.1 残留符号链接——排在 `/opt/homebrew/bin/git` 2.52.0 前面，导致 worktree/sibling-seed 相关 19 个测试因为老版本 git 不支持 `-b`/`worktree` 而失败，与本轮源码改动无关；详见 `[[node-and-benchmark-env-constraints]]`）。
- LOC ledger：`33,219 / 33,219`（硬上限，`Math.floor(31638*1.05)`），恰好打满，零余量。`scripts/count-production-ts.test.mjs` 本身不断言具体上限；真正的门在 `scripts/run-v32-optimization-matrix.mjs:49`，是 `<=` 比较，33219<=33219 通过。

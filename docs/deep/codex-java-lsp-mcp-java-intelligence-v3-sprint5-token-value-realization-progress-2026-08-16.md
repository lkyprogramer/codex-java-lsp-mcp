# Java Intelligence V3 Sprint 5 进展报告（V3.2-26 / V3.2-27 / V3.2-28 / V3.2-29）

来源计划：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-value-realization-optimization-development-plan-2026-08-09.md` 第 685-725 行（Sprint5，V3.2-26~30）。

本报告覆盖 V3.2-26（优化默认 `standard` 输出）、V3.2-27（range-first source planning）、V3.2-28（task-aware budget）、V3.2-29（provider measured-or-remove）。V3.2-30 未开始，`BLOCKED_EXTERNAL`（见 §5）。

## 1. 直接结论

| 编号 | 结论 |
| --- | --- |
| V3.2-26 | 字节半场 `CLOSED_VIA_V3.2-02_EXIT_CONDITION`（15% vs Sprint0 baseline 的原定数值门不可测；`standardToDiagnosticBytesRatio` 已 ≪0.5，按 V3.2-02 自身退出条件转向真实 Agent trace）；Agent 使用质量半场移交 V3.2-30（已获 V3.2-07b 授权） |
| V3.2-27 | `MODIFY_REJECTED_STRUCTURAL`（本次分析的低成本修法——用 type header 位置替换 `(1,1)` fallback——被证明结构性地帮不到实际 miss 集合；真正的修法需要 `hydrate:true` 获取具体方法级位置，成本未量化，留作未来工作，本轮不实现） |
| V3.2-28 | `REJECTED`（两轮候选规则均被正式三仓 AB/BA/AB 矩阵证伪并回滚：第 1 轮零 LOC 的 Spring "verified" 配额调整净负收益；第 2 轮用户授权 LOC 突破后测的文件数上限放宽——三仓 token 成本上升、`pRead` 广泛下降，仅一仓一项指标 `rTaskBlocking` 有真实收益，净不划算）；未落地任何生产代码，LOC 回到 33,230 |
| V3.2-29 | 第 1 轮 source-locked on/off ablation 已测完，**三个 adapter 都不满足删除条件**：MapStruct `KEEP_CONFIRMED_GAIN`（lishuedu 真实正收益）；Spring `KEEP_MODIFY_SIGNAL`（收益方向不一致，但 NDCG 三仓一致变差，指向 read-plan 预算配额而非删 adapter）；MyBatis `KEEP_UNDERPOWERED`（三仓均无 XML mapper，adapter "激活但空跑"，golden 集合本身测不出它，不算无收益轮次）。LOC 硬上限一次性突破至 33230/33219（+11 行，已获用户授权），本轮未偿还，需要未来出现真实无收益轮次或合理删除机会才能偿还 |

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

## 4. V3.2-28：task-aware budget 只使用显式 task facts

### 4.1 计划原文与依赖检查

"按 anchor profile、taskBlocking evidence、sourceSet 和文件大小调整 file/range budget；不读取 repo 名、scenario id 或 golden。" 依赖 V3.2-27；验收 "holdout 同样通过；任何只在已调优 24 场景上改善、holdout 无收益的规则 REJECT"。

先核实了两件事，都通过 advisor 复核：(1) `read-plan-budget.ts` 的文件级配额（`classQuotas`/`evidenceClassOf`）和 V3.2-27 的 AST range 精度是两个独立层——前者决定"选哪些文件"，后者决定"每个文件读哪段"——V3.2-27 零代码落地不构成 V3.2-28 的硬阻塞。(2) holdout/tuning 分离评分基础设施已经存在且完整：`golden/*.scenarios.jsonl` 每仓 8 tuning + 2 holdout（`evaluationSplit` 字段），`scripts/run-three-repo-cold-matrix.mjs` + `scripts/verify-three-repo-cold-matrix.mjs` 已经实现正式 AB/BA/AB 矩阵并把 `holdoutRReadMust`/`holdoutRTaskBlocking`/`holdoutRecall`/`holdoutPRead` 作为独立 gate 报告——V3.2-28 的验收条件不是空中楼阁。

### 4.2 候选规则：Spring 证据移出 "verified" 配额

V3.2-29 的 ablation（§5.4）测出一个跨三仓一致的信号：Spring 证据的 `NDCG_read@6` gainDelta 三仓全部为负，同时 `read-plan-budget.ts:24` 的 `FRAMEWORK_VERIFIED_REASONS` 把 `SPRING_CALL_PATH`（Spring 已解析的 CALLS 边）和 JDT-exact/semantic-definition 证据一起放进同一个 "verified" 配额桶——这是一个具体、可归因、指向配额分类本身的假设，且修法是从一个 `Set` 字面量里删掉一个字符串，**同一行数**（去掉一个 Set 成员、同步精简注释一句，行数不变），不占用任何 LOC 余量，规避了当前超编状态下新增代码需要用户先行授权的问题。

改动：`FRAMEWORK_VERIFIED_REASONS` 从 `["SPRING_CALL_PATH", "MYBATIS_NAMESPACE", "MYBATIS_STATEMENT_METHOD"]` 变为 `["MYBATIS_NAMESPACE", "MYBATIS_STATEMENT_METHOD"]`（`SPRING_CALL_PATH` 降级为 "structural"，仍然进入候选，只是不再和 JDT-exact 证据抢同一个高优先配额）；同步更新 `src/read-plan-budget.test.ts` 里断言 `SPRING_CALL_PATH → "verified"` 的一条用例为 `"structural"`。隔离 targeted 测试（118/118，含改动后的 `read-plan-budget`/`read-plan`/`rank-candidates`/`spring-adapter`/`materialize-candidates` 相关用例）全绿。

### 4.3 正式三仓矩阵测量与一次主机噪声

用 `scripts/run-three-repo-cold-matrix.mjs`（release-gate 用的同一正式工具：baseline=candidate 各自 detached clone + 独立 build，AB/BA/AB 三轮 × 3 仓，`--runs 5` 强制，附带跑一遍完整 candidate 测试套件）比较 baseline=`869b353`（committed HEAD，未改动）vs candidate=当前 worktree（含上述一行编辑，通过 `git apply --index` 捕获未提交改动）。

第一次运行在候选测试套件阶段失败：`task36-multiprocess-smoke.test.mjs` 的 `storm_foreground_anchor` 用例（真实子进程 sweep lease 等待，带硬性超时）SIGKILL 超时。启动前 `uptime` 已显示 1 分钟负载 37.82（本机 10 核，~3.8x），该测试与 `read-plan-budget.ts` 无任何代码路径关联；单独在隔离环境重跑同一测试文件，3.7 秒内干净通过——判定为主机高负载下的瞬时抖动，非本轮改动引入的回归，重跑整个矩阵。第二次运行候选测试套件 100/100 全绿，矩阵正常跑完 18 个 cell。

### 4.4 结果：无正收益，cipherlink tuning 侧净负

| repo | split | oldRecall | newRecall | oldPRead | newPRead | oldRReadMust | newRReadMust | oldRTaskBlocking | newRTaskBlocking |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lishuedu | tuning | 0.7847 | 0.7847 | 0.6771 | 0.6771 | 1.0 | 1.0 | 0.6046 | 0.6046 |
| lishuedu | holdout | 0.8229 | 0.8229 | 0.8333 | 0.8333 | 0.5 | 0.5 | 0.4423 | 0.4423 |
| cipherlink | tuning | 0.8322 | **0.8144** | 0.6375 | 0.6375 | 1.0 | 1.0 | 0.4914 | 0.4914 |
| cipherlink | holdout | 0.75 | 0.75 | 0.6667 | 0.6667 | 0.55 | 0.55 | 0.3030 | 0.3030 |
| exam-parent-v3 | tuning | 0.7790 | 0.7790 | 0.6042 | 0.6042 | 1.0 | 1.0 | 0.5003 | 0.5003 |
| exam-parent-v3 | holdout | 0.4316 | 0.4316 | 0.5 | 0.5 | 0.4 | 0.4 | 0.25 | 0.25 |

lishuedu 和 exam-parent-v3 在 tuning、holdout 两个切分上全部四项指标（recall/pRead/rReadMust/rTaskBlocking）**逐位精确相等**——这条规则对这两仓的候选选择结果没有产生任何可测量影响。cipherlink 的 tuning 切分 recall 从 0.8322 掉到 0.8144（-0.0143，相对 -1.7%），holdout 切分不变；这是三仓三切分共 6 组数据里唯一非零的一格，方向是负的。

`run-three-repo-cold-matrix.mjs` 这套正式工具不采集 `NDCG_read@6`（它的字段是 recall/pRead/rReadMust/rTaskBlocking/estimatedTokens/rangeEvidence/p95），所以**驱动这次实验的原始信号（Spring 的 NDCG 变差）在这个工具里无法被直接验证**——既没有证据支持配额调整改善了排序质量，唯一一处可测量的效果还是负的。按 advisor 的判断标准：如果 gate 全过但 NDCG 缺失或持平，视为中性，中性不足以保留一个行为改动；这里比中性更差——cipherlink tuning 净负、其余全零——判定 REJECT。已执行 `git checkout -- src/agent-router/read-plan-budget.ts src/read-plan-budget.test.ts` 还原，未落地任何代码，LOC 不受影响。

**顺带发现、超出本轮范围的观察**：`gate.holdoutRReadMust` 三仓全部 `FALSE`（holdout rReadMust 分别是 0.5/0.55/0.4，远低于验收要求的绝对值 1.0），且 old/new 完全一致——说明这不是本轮改动造成的，是当前代码树（`869b353`）在这套正式验收口径下本来就没有通过 holdout 的 must-read 绝对门槛，和 §3 已经记录的 V3.2-27 RangeLineRecall 缺口（0.55-0.85 vs 目标 1.0）是同一类"结构性未闭合"证据的另一个角度。这不是本轮要修的问题，只是本轮测量顺带得到的、值得记录的既有事实。

### 4.5 第 1 轮 disposition

`NO_VIABLE_ZERO_COST_RULE_FOUND`（第 1 轮，零 LOC 规则）：唯一测过的零 LOC 候选规则被正式数据证伪并回滚。V3.2-28 计划原文的完整范围（anchor profile、taskBlocking evidence、sourceSet、文件大小四个维度）远大于这一次探测，继续探索意味着要往 `read-plan.ts`/`read-plan-budget.ts` 写真正的新逻辑——这在当时 LOC 已超编（33,230/33,219，V3.2-29 的一次性突破尚未偿还）的状态下，不能默认继续往上加，需要用户先明确是否愿意再授权一次 LOC 突破。

### 4.6 第 2 轮：用户授权 LOC 突破后，测了一条真正新增代码的规则

用户明确说"授权一次突破"。设计前先用第 1 轮已有的正式矩阵原始数据（`v328-spring-quota-matrix-20260816-run2/matrix/*.json`）核对了 6 个 holdout 场景（三仓各 2 个）old 臂的 `readPlanFiles`/`readPlanBytes`：**全部 6 个 holdout 场景都在 balanced 模式的文件数上限（6）打满，字节预算只用了 30%-69%**——文件数是真正 binding 的约束，不是字节数，这条候选规则（扩大文件数上限）选对了杠杆。

改动：`buildReadPlan()`（`read-plan.ts`）里已有的"anchor 数量超过预算时临时放宽 `selectionBudget.maxFiles`"机制（这是既有代码，不是本轮引入），本轮把触发条件从"只数 anchor"扩大为"数 anchor ∪ `protectedPaths`"（`protectedPaths` 是已经在流转的 JDT 精确结构证据集合，`protectedReadPlanPaths()` 产出，`selectTokenAwarePlan` 的 "core" bucket 本就无条件保留这个集合，只是保留时可能撞上外层 `maxFiles` 先天不够大），并且只在调用方没有显式传 `readPlanMaxItems`（即走 mode 默认值）时才放宽——显式预算是硬约束，不能被这条规则悄悄突破。净改动 `read-plan.ts` +13/-3（净 +10 行）。

**一次中间发现**：第一版实现（放宽不分是否显式传参）让 3 个既有测试（"...in a constrained core" 系列，命名就在说明它们故意设小预算验证约束生效）多选出一个文件——不是这些测试过期，是我的改动确实覆盖了调用方显式传入的 `readPlanMaxItems`，一个真实的合约违反；加上"仅在默认分支生效"的判断后这三个测试原样通过，不需要放松任何断言。同时把自己新增的单测从"5 个全部同属 core bucket"的构造改成"anchor(1)+core(4)=5 恰好卡在 `BUCKET_RULES.core.max`（既有常量，本轮未改）之内"，避免撞上另一个无关的既有硬上限。

**正式三仓矩阵结果**（baseline=`4eedc6b`，candidate=改动后 worktree，`--runs 5`）：不是"全零"，是三仓五项指标里**四项在两仓上出现真实、方向不一致的效果**：

| repo | split | recall Δ | pRead Δ | rTaskBlocking Δ | tokens P50 Δ |
| --- | --- | --- | --- | --- | --- |
| lishuedu | tuning | 0 | -0.031 | +0.031 | +181 |
| lishuedu | holdout | 0 | **-0.071** | **+0.154** | — |
| cipherlink | tuning | **-0.047** | **-0.133** | 0 | +251 |
| cipherlink | holdout | 0 | 0 | 0 | — |
| exam-parent-v3 | tuning | 0 | -0.065 | 0 | +486 |
| exam-parent-v3 | holdout | 0 | **-0.183** | 0 | — |

三仓 token 成本全部上升（+181~+486 P50），`pRead`（读取精度）在三仓 tuning 侧全部下降、两仓 holdout 侧也下降——机制上完全符合预期：文件数上限一放宽，更多文件被读入，其中不全是有用的，精度天然被稀释。唯一真实的正向信号是 lishuedu holdout 的 `rTaskBlocking` +0.154（0.442→0.596），但同一个仓库同一个切分的 `pRead` 同时 -0.071，且 cipherlink tuning recall/pRead 双双真实回归、exam-parent-v3 holdout pRead 回归 -0.183——净效果是花更多 token 换到广泛的精度下降，只在一仓一项指标上换到一次收益，不是"holdout 有收益"的干净结果，是"多花预算、精度普遍变差、局部换到一点召回"的不划算交易。判定 REJECT，已 `git checkout --` 还原 `read-plan.ts`/`read-plan.test.ts`，LOC 回到 33,230（V3.2-29 的授权状态，V3.2-28 两轮均未额外占用）。

### 4.7 最终 disposition

两轮候选规则（零 LOC 的 Spring 配额调整、+10 LOC 的文件数上限放宽）均被正式三仓矩阵证伪并回滚，V3.2-28 未落地任何生产代码改动。计划原文更大的范围仍然未被排除——只是这两条具体规则不成立，不代表"anchor profile/taskBlocking/sourceSet/文件大小"这个方向整体不可行——但连续两轮真实投入（含一次用户授权的 LOC 突破）都拿到净负/无收益结果，本轮到此为止，不再尝试第三条规则；如果未来要继续，需要新的、结构不同的假设，而不是这两条已经被否定的规则的变体。

## 5. V3.2-30：`BLOCKED_EXTERNAL`（缺失外部凭据，非授权范围问题）

V3.2-07b 已就 "6 任务 × old/new × AB/BA" 的调用范围获得用户授权（`[[v32-07b-authorization]]`），但 `run-agent-trace-matrix.mjs`（真实驱动一个外部模型完成 6 个冻结任务、按 `docs/evals/java-intelligence-v32-agent-trace-spec.md` 第 4/7 节精确记录 wire-level MCP request/response/tool-call/file-read 事件哈希、真实 token usage、锁定 provider/model/version/temperature/seed）目前完全不存在，构建它的前提是一个可编程调用的外部模型 API 凭据。本环境检查确认：没有 `ANTHROPIC_API_KEY` 或任何其他 provider 的 API key，只有指向本 CLI 自身的 `CLAUDE_CODE_EXECPATH`。曾评估过"用 `claude` CLI 当作被测 Agent"的替代方案，但规范本身要求的 wire-level 事件哈希、精确 usage、锁定 model 版本这几项，CLI 子进程调用方式拿不到——不是更省事的替代，是达不到验收门槛的假数据。这是缺一个具体输入（provider API key + 明确的 provider/model 选择），不是设计分叉，因此按规范第 7 节原文状态直接报 `BLOCKED_EXTERNAL`，不编造或估算 usage/TaskSuccess 数字。用户已确认暂时跳过，留待未来提供凭据后再启动。

## 6. V3.2-29：provider measured-or-remove

### 6.1 计划原文与本轮范围

"新增 benchmark-only adapter allowlist（生产默认 registry 不读取该开关）……对 Spring/MyBatis/MapStruct 做 source-locked on/off；ON/OFF 各自使用独立 process/cache、同 source tree、同 deadline，OFF 必须是不加载/不运行该 adapter，不能复用 ON 的暖态；记录 selected、readPlan、golden/task-blocking gain、独立 cost；连续两轮无真实增益的 adapter 进入删除候选。" 附带规则："MyBatis parser/resource index 与 MyBatis ranking adapter 分开决策；不得因为 adapter 无收益删除底层 XML 正确性能力。"

本轮完成的是**第 1 轮**测量，不是最终删除判定——"连续两轮无真实增益"要求至少两轮，本轮无论结果如何都不能单轮触发删除。

### 6.2 LOC ceiling：一次性小幅突破，用户已授权

测量本身需要的最小生产代码改动：`AgentRouter` 构造函数新增一个 `frameworkAdapters` 覆盖参数（`src/agent-router/index.ts`，默认值仍是完整的 `FRAMEWORK_ADAPTERS`，生产调用方从不传这个参数，行为不变）；`benchmark-agent-impact.ts` 新增 `--exclude-framework-adapter <id>` CLI 开关，过滤后传给 `AgentRouter`。这两处都在 `count-production-ts.mjs` 的统计范围内（已用其 `scope` 字段核实：`src/benchmark-agent-impact.ts`、`src/benchmark/**`——测试文件除外——都计入 ledger，只有 `scripts/*.mjs` 免于计入）。而能腾出行数的分支（删除无收益 adapter）必须先有本轮测量结果才能触发，形成真实的循环依赖，无法用"先删后测"绕开，也不应该为了凑行数去别处做无关"精简"。

用户明确授权"接受一次性小幅突破硬上限，但是还是要做好测试和验证对比"。**实际改动 +11 行**：`totalLoc` 从 Sprint4 收尾时的 33,219（硬上限本身）变为 **33,230**，超出硬上限 11 行（约 0.033%）。`scripts/run-v32-optimization-matrix.mjs:49` 的 `productionLocGatePassed` 判定（`<=` 比较）此后会返回 `false`，这是预期结果，不是需要排查的回归——下一次运行该 matrix 脚本的会话应该识别这一点，不要"修复"它。**本轮的测量结果没有让任何 adapter 达到删除标准（见 4.4），所以这 11 行目前没有被偿还**，仍然是欠账状态，需要未来一轮真实的"连续两轮无真实增益"结果，或者一次合理的独立删除机会，才能还清。

### 6.3 "不加载/不运行"的读法，改动前先写明

`AgentRouter` 的 `frameworkAdapters` 参数是一个运行时过滤后的数组；`spring-adapter.ts`/`mybatis-adapter.ts`/`mapstruct-adapter.ts` 三个模块仍然被 `framework-provider.ts` 静态 `import`（JS 模块加载层面无法避免，除非改成动态 `import()`，那是明显更重的改动，且这三个 adapter 对象本身是无状态的、`import` 不产生任何副作用或成本）。本轮采用的读法是：**"不加载/不运行"约束的是运行时行为——排除的 adapter 的 `isActive()`/`collect()` 必须一次都不被调用、不产生任何证据或副作用、不接触 `frameworkIndex`——而不是字面意义上的"JS 模块不能被 import"**。`runFrameworkAdapters(adapters, ...)`（`framework-provider.ts:47`）只会遍历传入的 `adapters` 数组，被过滤掉的 adapter 对象在整个请求生命周期内不会被引用或调用，满足这个读法。

### 6.4 ablation 结果（第 1 轮，真实数据）

**方法**：`scripts/run-v329-framework-ablation.mjs`（新增，LOC-free）对每个 adapter × 每个仓库分别发起两次完全独立的顶层两层 isolation-chain 调用（各自独立的 detached clone、独立 JavaIndex cache、独立进程）——ON 用完整 registry，OFF 用 `--exclude-framework-adapter <id>`；`warmState=cold-nolsp`（不 spawn 真实 jdtls，framework adapter 靠 JavaIndex/rg 证据工作，不依赖 live LSP）；每仓每条件 `runs=1`。全部 10 golden 场景一次跑完，取 `totals`（P50 口径的聚合字段）。

**单次运行为什么对 gain 指标够用、对 elapsedMs 不够用**：Task36 determinism gate（`determinism.ts:53-55` 自己的注释）只证明冷启动路径的**语义快照**（`candidatePaths`/`readPlan`/`familyScores`/`completion`）逐字节确定——明确排除延迟、字节计数、cache 命中和 phase timing。recall/pRead/rTaskBlocking/rReadMust/NDCG 五项 gain 指标都是候选/read-plan 选择的派生量，落在这个快照覆盖范围内，单轮可信；`readPlanBytes`/`totalAgentVisiblePayload` 是同一个确定性选择序列化后的字节数，同样可信。但 `elapsedMs`（wall-clock）明确不在快照保证范围内，本轮各 cell 的 elapsedMs 正负号不一致（例如 MyBatis 在 lishuedu 是 -6.9ms、cipherlink 是 +15.8ms，同一个"零产出"的 adapter），**这就是单轮 wall-clock 噪声的直接证据，elapsedMs 的符号不作为结论依据，只有量级（个位数到十几毫秒）用于说明 cost 处在噪声量级、不是数量级差异**。

**正对照（验证 filter 真的生效，不是没起作用）**：cipherlink 排除 Spring 后，recall/pRead/rTaskBlocking/rReadMust/NDCG_read@6 全部出现非零变化（`{"recall":0.0062,"pRead":0.0017,"rTaskBlocking":-0.0268,"rReadMust":-0.02,"NDCG_read@6":-0.0164}`）——证明 `--exclude-framework-adapter` 确实改变了 `collectFrameworkEvidence` 的行为，不是死开关。

**溯源**：18 次运行（3 adapter × 3 repo × on/off）的 `executableTree`（isolation chain 状态行里的真实 candidate 树哈希，不是 `runtimeBuild.gitSha`——后者只反映已提交的 HEAD `ec78258`，而本轮改动此时还没提交，`git apply` 补丁应用后的真实执行树是另一个哈希）**全部一致，都是 `eaaf5d39b74647e62964406800333bc21099b1b2`**，证明整轮 campaign 期间代码树没有漂移；这个值也和改动前的冒烟测试（`executableTree` 前缀 `1533d5343e7a…`）不同，说明确实是带着本轮 wiring 跑的。这个校验只证明"没漂移"，不单独构成 source-locked 证明——真正的功能证明是上一段的正对照。

**哪些 cell 有效（9 个 cell 里只有 4 个是有效测量，其余 5 个是仓库本身不用这个框架，天然零信号，不是测量失败）**：三仓源码逐一 grep 核实：Spring 三仓都在用（159/1488/445 处 `org.springframework` import），MapStruct 只有 lishuedu 用（81 处 `org.mapstruct.Mapper`，cipherlink/exam-parent-v3 均为 0），MyBatis 三仓都有 `org.apache.ibatis`/`org.mybatis` import（24/311/0 处）但**三仓全部零个 MyBatis XML mapper 文件**（多种 grep 模式核实：路径含 mapper 的 xml、含 `<mapper ` 标签的 xml，均为 0）。`mybatisAdapter.isActive()`（`mybatis-adapter.ts:82-96`）按 import/annotation 前缀判定，cipherlink/lishuedu 会被判定为激活（`collect()` 确实执行），但当前 `mybatisAdapter` 的证据产出是 XML statement/resultMap 形状的，没有 XML 文件可扫，所以"激活但空跑"——不是"未激活"，是激活了但注定拿不到证据，这是三仓 golden 集合本身的覆盖缺口，不是 adapter 没价值的证据（呼应计划自己的 MyBatis 规则）。

有效 gain 数据（gainDelta = ON − OFF，即启用该 adapter 相对禁用的差值）：

| adapter | repo | recall | pRead | rTaskBlocking | rReadMust | NDCG_read@6 |
| --- | --- | --- | --- | --- | --- | --- |
| Spring | cipherlink | +0.0062 | +0.0017 | -0.0268 | -0.02 | -0.0164 |
| Spring | lishuedu | -0.0125 | -0.0167 | -0.0143 | 0 | -0.014 |
| Spring | exam-parent-v3 | 0 | +0.0167 | +0.0083 | 0 | -0.0024 |
| MapStruct | lishuedu | +0.0536 | +0.025 | +0.0286 | +0.0333 | +0.0278 |

（`rReadMust` 这里是同一套当前 24 场景 golden 集合内部 ON vs OFF 的比较，不是像 Sprint4 V3.2-25 那样跨新旧 golden 集合口径比较，可比性成立，不受那次撤回影响的约束。）

**MapStruct（lishuedu）**：五项 gain 指标**全部正向**，且量级不小（recall+5.36%、rReadMust+3.33%）。更值得精确说明的是成本方向：`totalAgentVisiblePayload` -212.6 字节、`readPlanBytes` -375.9 字节**同时**下降——不是"多花字节换召回"，是 MapStruct 证据帮助 read-plan 选出更精准的候选集合，使得同一次读取**用更少字节拿到更高召回**（更贴合任务的候选挤掉了本来会占预算的次优候选）。这是本轮 ablation 里最干净的正结果，`KEEP_CONFIRMED_GAIN`。

**Spring（三仓）**：方向不一致，不能用一句话总结。cipherlink 是 recall/pRead 小幅提升但 rTaskBlocking/rReadMust/NDCG 明显下降；lishuedu 是五项**全部**下降（含 recall 本身）；exam-parent-v3 是 pRead/rTaskBlocking 提升、NDCG 微降。**唯一三仓一致的信号是 NDCG_read@6 全部为负**——加入 Spring 证据会持续拉低 read-plan 排序质量，即使对原始 recall 的影响方向不定、量级也小。结合 `read-plan-budget.ts` 把 `SPRING_CALL_PATH` 证据归入"verified"配额（与 JDT-exact/semantic-definition 同一优先级）这一既有设计，这更像是**预算配额层面的 MODIFY 信号**（Spring 证据在配额里可能不该和精确证据同等优先），不是删除 adapter 的信号——net 收益接近中性、且三仓都在用，不满足任何删除标准。`KEEP_MODIFY_SIGNAL`，配额调整留作独立后续项，本轮不动 `read-plan-budget.ts`。

**MyBatis（三仓）**：gain 五项在三仓全部精确为 0——但这是"golden 集合测不出"，不是"测过了、真的没用"。付出的成本是真实的（cipherlink +15.8ms/+542 字节，lishuedu -6.9ms/+554 字节，exam-parent-v3 +6.5ms/+56 字节——延迟量级在噪声附近，payload 字节的正向增量更稳定，说明 adapter 确实执行了、只是没产出可用证据）。`KEEP_UNDERPOWERED`：按计划的 MyBatis 专属规则，不能仅因为这一轮无收益就进入删除候选；真正测出结论需要一个含 MyBatis XML mapper 的 golden 仓库，当前 3 仓都不满足，这是本轮暴露的 golden 集合覆盖缺口，不是 adapter 本身的负面证据。

### 6.5 disposition

三个 adapter 本轮全部 `KEEP`，理由各不相同（MapStruct 有真实正收益；Spring 是中性/待配额调整；MyBatis 是无法用当前 golden 集合公平测量）——**没有一个进入删除候选**，"连续两轮无真实增益"的门槛本轮也无法触发（只有一轮）。11 行 LOC 欠账保留，未偿还。

## 7. 验证

- `src/agent-router/format.test.ts`、`src/benchmark/determinism.test.ts`、`src/agent-router/read-plan.test.ts`、`src/benchmark/attribution-v3.test.ts`、`src/benchmark-agent-impact.test.ts`：已在隔离环境（`run-isolated-validation.mjs --profile targeted`）跑过，66/66 通过。
- 全量隔离回归（`--profile full`，V3.2-26/27/29 全部改动落地之后，含 `index.ts`/`benchmark-agent-impact.ts` 的 V3.2-29 wiring）：921/921 单测 + 100/100 `scripts/*.test.mjs` + smoke 全绿，exit 0（`bash -lc` 需显式 `export PATH="/opt/homebrew/bin:$PATH"`，否则本机 PATH 顺序会把 `/usr/local/bin/git`——一个 2015 年的 git 2.3.1 残留符号链接——排在 `/opt/homebrew/bin/git` 2.52.0 前面，导致 worktree/sibling-seed 相关 19 个测试因为老版本 git 不支持 `-b`/`worktree` 而失败，与本轮源码改动无关；详见 `[[node-and-benchmark-env-constraints]]`）。
- LOC ledger：Sprint4 收尾时 `33,219 / 33,219`（硬上限），V3.2-26 修复不变；V3.2-29 之后变为 `33,230 / 33,219`，**用户已明确授权的一次性小幅突破**（见 §4.2），`scripts/run-v32-optimization-matrix.mjs:49` 的 `<=` 判定此后为 `false`，是预期结果，不是需要修复的回归。
- V3.2-28 第 2 轮（`read-plan.ts` +10 净行）落地期间：隔离 targeted（79/79，含新增的 2 个用例）与全量隔离回归（923/923 + 100/100 + smoke 全绿）均在正式矩阵测量前跑过；矩阵证伪后 `git checkout --` 还原，`count-production-ts.mjs` 复核 LOC 精确回到 `33,230`，未额外占用。

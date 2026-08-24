# Java Intelligence V3 Sprint 4 完成报告（V3.2-21~25：auto admission / persisted semantic operation-completeness / idle prewarm 实验 / 单变量参数实验 / 默认化硬门）

来源计划：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-value-realization-optimization-development-plan-2026-08-09.md` 第 630-680 行（Sprint4，V3.2-21~25）。

Sprint4 五项（V3.2-21~25）本次全部关闭。最终策略：**`semantic` 保持 `KEEP_EXPLICIT`**，不进入默认路径；未新增任何自动触发 live JDT 的代码路径。

## 1. 直接结论

| 编号 | 结论 |
| --- | --- |
| V3.2-21 | `DO_NOT_IMPLEMENT`（已于 2026-08-15 关闭，详见 `docs/phase-v3/phase5-semantic-first-touch-decision.md` 追加小节） |
| V3.2-22 | `CONSERVATIVE_ALTERNATIVE_ALREADY_SATISFIED`（本轮关闭，无需代码改动） |
| V3.2-23 | `DEFERRED_PENDING_WORKLOAD_TELEMETRY`（本轮关闭为"实验前置条件缺失"，不是 PASS/FAIL，也不是 DO_NOT_IMPLEMENT） |
| V3.2-24 | `KEEP_EXPLICIT`（退出条件已在现有 concurrency=2 数据上成立；import concurrency 维度因主机噪声未能复测，记为待复测的开放问题，不影响本次关闭） |
| V3.2-25 | `KEEP_EXPLICIT`（默认化硬门 5 项条件中 2 项已用 Sprint4 已有证据决定性证伪，第 3 项证据不可比已撤回，是前四项工作的直接推论） |

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

## 5. V3.2-24：JDT 单变量参数实验——退出条件已在既有数据上成立，import concurrency 维度未测（主机噪声）

计划原文（development-plan 654-661 行）范围是四个变量、一次只改一个：import concurrency、workspace/dataDir reuse、project import readiness、document prepare；证据要求"三仓 fresh/reused 各 10 次，记录完整 phase 和资源"；隔离验收另有三条关于 sibling worktree 独立性的要求；退出条件是"references first-touch P95 仍 >20s 或资源明显恶化 → 保持 `KEEP_EXPLICIT`"。

### 5.1 四个变量里，三个已经是现成开关——不需要新写实验代码

核查 `src/benchmark/semantic-first-touch.ts` 与 `src/jdtls-session.ts` 发现：

- **document prepare** 与 **project import readiness**：CLI 已有 `--prepare none|progress-idle|document-symbol`（`semantic-first-touch.ts:118`），`progress-idle` 就是"等 import 空闲信号"这条变量。
- **workspace/dataDir reuse**：CLI 已有 `--workspace-state fresh|reused`（同上）。
- **import concurrency**：`jdtls-session.ts:1786` 的 `maxConcurrentBuilds: positiveInteger(process.env.JAVA_LSP_IMPORT_CONCURRENCY, resourceDefaults().importConcurrency)`——一个未被任何现有实验用过的环境变量开关。本机（32GB/10 核）`resourceDefaults()` 给出的默认值是 2（`resource-defaults.ts:17-18`），已由 `dist/build-stamp.json` 现场核对确认（`importConcurrency: 2`）。

即：四个变量中的三个（prepare、readiness、workspace reuse）已经在 2026-08-09 Task36 remediation 的 `artifacts/v3-final/task36-remediation-20260809/first-touch-final/` 里跑过 10 runs × 3 repos × 3 种 prepare 模式（`fresh` 状态；`reused-shared` 状态另有数据）；只有 import concurrency 这一维度从未被测过。

### 5.2 退出条件复核：用现有 concurrency=2 数据就已经成立，不需要等 import concurrency 测完

对 Task36 数据按 `prepare` 分组重新计算 `fresh` + `references` 的 P95（见下表）。**用每仓最快的 prepare 分支**（而不是不加区分地取 `none`——lishuedu 的 `none` 分支 10 次里只有 8 次 `COMPLETE`，P95 是censored 幸存者上的数字，会虚高且方向不可信）：

| 仓库 | 最快 prepare 分支 | totalMs P95 | 完成数 |
| --- | --- | --- | --- |
| cipherlink | `document-symbol` | 25431ms | 10/10 |
| exam-parent-v3 | `document-symbol` | 48762ms | 10/10 |
| lishuedu | `document-symbol` | 53549ms | 10/10 |

三仓在 concurrency=2（当前机器默认值）下全部远超 20s 门槛（超出比例 27%/144%/168%）。退出条件是析取式（P95>20s **或** 资源恶化 → `KEEP_EXPLICIT`），且举证责任在"证明变量组合能达标"一侧，不在"证明达不到"一侧——现状数据已经满足退出条件的前半支，`KEEP_EXPLICIT` 在不需要任何新测量的情况下就成立。要翻盘，import concurrency=8 需要把 exam-parent-v3 削減 ≥59%、lishuedu 削減 ≥63%（cipherlink 需要 ≥21%）——这是一个具体、可证伪、但目前没有证据支持的claim。

### 5.3 尝试对 import concurrency 做单变量复测——主机噪声导致中止，不作为发现上报

新写了 `scripts/run-v324-import-concurrency-experiment.mjs`（本轮新增、未提交），沿用本 Sprint V3.2-23 已验证过的两层 isolation chain 调用方式（`run-isolated-node.sh` → `run-isolated-validation.mjs --profile compile --env JDTLS_BIN=... --env JAVA_LSP_IMPORT_CONCURRENCY=... --env JAVA_LSP_BENCH_ANCHOR_*=...` → `run-isolated-jdt-benchmark.mjs --repo-root <golden repo> -- node dist/benchmark/semantic-first-touch.js --repo-root {repo} --workspace-state fresh --prepare none --operation references`），按仓（而非跨三仓）交替跑 concurrency=2/8 两臂，每臂 5 次，避免主机漂移集中砸在某一臂上。

冒烟测试（cipherlink，各臂 1 次）暴露了一个更基础的问题：调用时 `uptime` 显示 1 分钟 load average 约 30（本机 10 逻辑核，即 3.0x），同时 Time Machine 正在跑全量备份且桌面有大量应用（Chrome/WeChat/抖音/ChatGPT/Word 等）在跑。两臂（concurrency=2 与 concurrency=8）都在 60000ms 超时后以 `PARTIAL_TIMEOUT`/`DEADLINE_EXCEEDED` 收场，0 个结果文件——对比 Task36 同一仓库/锚点/超时值在 concurrency=2 下稳定 22-26s 内 `COMPLETE` 的历史数据，这不是"两个设置都变慢了"的信号，是"当前主机状态下任何单次 fresh cold start 都测不出有效数据"的信号。**这两次超时被丢弃，不计入任何关于 import concurrency 的结论**——把它们报告为"concurrency 没有帮助"或"资源更差了"会是编造证据。

已在脚本里加一道主机静默度前置检查（`assertHostQuiet()`：1 分钟 load average / 逻辑核数 > 0.7 时拒绝启动，报错信息里说明原因），仿照脚本已有的 `assertNoStrayJdt()` 惯例——这是这次冒烟测试暴露出的一个真实方法论发现：Task35/Task36 的历史数字隐含假设了一个安静主机，但从未把这一前提写下来或做成前置检查。

脚本本身的接线已经验证有效：冒烟测试确实拉起了真实 `jdtls` 1.56.0（`-data` 指向隔离出的 fresh workspace，`ps aux` 可见完整命令行），`JAVA_LSP_IMPORT_CONCURRENCY` 环境变量确实透传到了子进程环境。留在工作区、不纳入本轮 commit（与 `scripts/run-idle-prewarm-experiment.mjs` 同样的处理方式）；在主机安静时（`assertHostQuiet()` 能通过）重跑是一条命令的事。

### 5.4 import concurrency 的效果本身仍是一个开放问题——不能用"它影响的阶段占比小"来关闭

最初尝试过一个基于阶段分解的论证（"`ensureStartedMs` 只占 totalMs 的 11%-21%，即使压到 0 也翻不了盘"），经复核后确认**这个论证依据的阶段划分是错的，必须撤回**：从冒烟测试与 Task36 数据的 `jdtTelemetry` 字段看，`ensureStartedMs` 对应的是 `initializeRoundTripMs`（LSP `initialize` 握手往返），而不是 project import；每一条样本的 `progress.projectImportMs` 都是 `UNMEASURED`（"no complete project-import progress begin/end span was observed"）——即 project import 实际发生在 `requestMs`（`textDocument/references` 请求本身阻塞期间的按需 build）内部，而 `maxConcurrentBuilds`/import concurrency 影响的正是这个按需 build 的并行度。也就是说 import concurrency 有结构性理由可能影响 `requestMs`（当前唯一的大头阶段），不能用阶段占比论证排除掉。

这条维度目前的状态是**未测，不是已否定**：5.2 节的 `KEEP_EXPLICIT` 结论不依赖 import concurrency 的答案（现有 concurrency=2 数据已经独立满足退出条件），所以不需要靠这次未完成的复测来关闭 V3.2-24；但如果未来有人想知道"更高的 import concurrency 能不能把 exam-parent-v3/lishuedu 拉到 20s 以内"，这仍然是一个真实开放、值得在主机安静时用 5.3 节的脚本回答的问题，不应被当作已经问过、已经否定。

### 5.5 隔离验收核查（读源码 + 既有测试，未新增代码）

计划的隔离验收有三条：(a) 两个 sibling worktree 同时启动时 workspace/dataDir/lease 各自独立；(b) 一侧 build change 不污染另一侧；(c) 版本或 fingerprint 不匹配时拒绝 reuse。核查方式是读源码引用，不是新跑实验（跟 5.3 节主机状态无关，属于静态正确性检查）：

- **(a) dataDir 独立——按构造成立**：`repo-layout.ts:65-67` 的 `repoCacheRoot(repoRoot)` 只对 `repoRoot`（绝对路径字符串）做 `sha1`；`worktree-identity.test.ts:28-37`（"linked worktrees share familyHash but retain distinct repoHash"）确认两个 sibling worktree 的 `repoHash` 必然不同——不同路径→不同 hash→不同 `dataDir`，无需专门的运行时判断逻辑，是路径不同这一事实的直接推论。
- **(a)/(b) JDT_WORKTREE lease 独立——按构造成立**：`cross-process-lease.ts:334-337` 的 `tryAcquireJdt()` 用 `path.join(this.root, "jdt-worktree", identity.repoHash)` 作为互斥目录，键是每个 worktree 独有的 `repoHash`，不是跨 sibling 共享的 `familyHash`（`familyHash`/`leaseFamilyKey` 只用在 `acquireRuntime()` 的 `RUNTIME` 租约和机器级 `JDT_SLOT` 固定槽位上，两者都是刻意的机器级容量节流，不是 workspace 互斥，语义上不冲突）。
- **(c) 版本/fingerprint 不匹配拒绝复用——未实现，是真实缺口**：`dataDir` 的 key（见上）只由 `repoRoot` 决定，不含 JDTLS 版本或 build/classpath fingerprint 任何成分；对 `clearCache`/`restart` 全代码库搜索确认唯一会删除磁盘 `dataDir` 的路径是显式的 `restart(clearCache: boolean)`（`jdtls-session.ts:843-846`），需要调用方主动传 `clearCache=true`；私有的 `clearCache()`（`jdtls-session.ts:2000-2007`，被 `invalidateForRepoChanges` 的 `BUILD_CHANGE` 分支触发）只清内存里的请求缓存和 `semanticGateway`，不碰磁盘上的 Eclipse workspace，而且只在"当前存活会话的文件监听器亲眼看到变更"时触发——不覆盖会话停止期间发生的 JDTLS 升级或依赖变更。全仓库对 "jdtls 版本感知的失效逻辑"关键词搜索是 0 命中。

**这一条不在本轮修复**：这是一个预先存在于当前生产代码里的缺口（跟 V3.2-24 是否采纳任何新的复用行为无关），但修复它需要先回答一个未验证的问题——JDT LS 自带的 M2E（Maven）/Buildship（Gradle）项目导入插件本身很可能已经对外部 `pom.xml`/`build.gradle` 变更有自己的过期检测和自动重新导入机制；在没有验证"这层是否已经覆盖了这个场景"之前写一个新的 fingerprint 失效层，有构建冗余失效逻辑、白白丢弃本可复用的 warm workspace 的风险。而验证这一点本身需要另一次真实 JDT 实验（修改一个已导入项目的 `pom.xml`、不重启会话、观察下一次查询的解析结果是否正确反映新依赖），跟 5.3 节一样，在当前主机状态下无法负责任地跑。留给后续会话作为独立问题：**JDT 自身的 M2E/Buildship 是否已经覆盖了这个场景？**

### 5.6 决定

**`KEEP_EXPLICIT`**——退出条件已经在现有的、干净的 Task36 concurrency=2 数据上成立（5.2 节），不依赖任何本轮新测量。Import concurrency 这一单一维度因主机噪声未能复测，记为**开放、未否定**的问题（5.4 节），不影响本次关闭结论，也不构成阻塞：即使 concurrency=8 在未来某次安静主机复测中大幅改善，也只影响 `requestMs` 这一项，5.2 节列出的差距（59%-63%）足够大，先验上不太可能靠单一参数完全翻盘，但这是一个待验证的判断，不是已经验证的结论。隔离验收三条中两条（sibling dataDir/lease 独立）按构造成立且已用源码引用核实；第三条（版本/fingerprint 拒绝复用）是真实缺口，记录但不在本轮修复，留待先回答"JDT 自身 M2E/Buildship 是否已覆盖"这一前置问题。

本轮未改动任何 `src/` 生产文件（只新增了两个未提交的 `scripts/*.mjs` 脚本与本文档），现场重跑 `scripts/count-production-ts.mjs` 确认 production TS LOC 仍是 33,215，与硬上限 33,219 的差距仍是 4 行，跟 §3 提到的余量一致，未发生变化。

## 6. V3.2-25：默认化硬门——2 项条件已用现有证据决定性不成立，第 3 项证据不可比、已撤回

计划原文（development-plan 663-668 行）："只有同时满足以下条件，才重新讨论把 semantic 设为默认"：(1) 三仓 fresh 代表 operation P95 ≤800ms；(2) 0 partial/timeout；(3) R_must=1、Recall/R_task 非劣；(4) actual Agent task success 非劣；(5) peak RSS 和机器级 JDT 数量仍受控。五项是合取（同时满足），任何一项决定性不成立就足以关闭整个硬门，不需要逐项都跑到底。

不需要新实验：Sprint4 本轮（V3.2-21 recheck + V3.2-24 复核）已经产生的证据里，2 项已经决定性不成立：

- **条件 1（P95≤800ms）不成立**：`artifacts/v3-final/sprint4-v321-admission-recheck-20260815/summary.json`——三仓 `warm-auto` 场景 `elapsedMsP95` 是 1571.0/1611.3/1571.7ms。这三个数字彼此相差不到 40ms 且都落在 1500ms 附近不是巧合：`src/benchmark-agent-impact.ts:487-489` 的 `effectiveSemanticTimeoutMs()` 给 `warm-auto`（非 `warm-required`）配置的 `semanticTimeoutMs` 硬编码就是 `1500`（development-plan 362 行的表述也印证这点——"受影响 warm-auto P95 显著低于当前 1.5s cap"）。也就是说这不是三次巧合相近的真实测量值，而是**被这个 1.5s 内部截止时间强制截断的结果**——真实的、不被截断的 live JDT 语义调用延迟未知，只知道下界已经在 1500ms 附近（截断本身就发生在门槛的将近 2 倍处），完整值大概率更高。这让条件 1 的不成立结论比"测到 1571ms"更强，不是更弱：即使把 `auto` 自己的截止时间设得比现在更宽松，也不会让它落到 800ms 以内——现有内部超时配置本身已经是 800ms 的近 2 倍。`fresh` 冷启动场景（V3.2-24 §5.2）P95 是 25431-53549ms，是门槛的 32-67 倍，不涉及这个截断问题，独立成立。
- **条件 2（0 partial/timeout）不成立**：对 Task36 `first-touch-final` 全量 242 次 attempts 现场重新统计，2 次是 `PARTIAL_TIMEOUT`（均在 `lishuedu-fresh-none-references.stdout.json`）——真实存在的、已观测到的超时，不是理论风险。

**条件 3（R_must=1）：最初判定为不成立，复核后撤回，改记为"证据不可比、未独立核实"**——不是决定性证伪。同一份 `sprint4-v321-admission-recheck-20260815` 数据里，`rReadMust` 三仓分别是 0.9100/0.8800/0.9000，`cold-nolsp` 与 `warm-auto` 两个 policy 下 bit-identical。但复核发现这个数字来自 `benchmark-agent-impact.ts` 的当前 golden-scenario 集合（Task32 之后、16→24 个场景），而 `docs/phase-v3/phase5-semantic-first-touch-decision.md` 的历史 caveat #6 明确写过：Iteration A 记录的 `R_read_must=1.0000`（旧的 16 场景集合、旧 ranking pipeline）与当前场景集合下的数字"不可比"（not comparable）——用当前 0.88-0.91 直接判定"条件 3 不成立"，犯的正是本节条件 1 曾经差点犯、后来撤回的同一类错误（拿错误的指标/口径下结论）。目前不清楚 V3.2-25 原文的"R_must=1"具体指哪一套场景集合下的哪个数字，所以这一条**不作为决定性证据使用**。同时纠正一处过度表述：0.88-0.91 在两个 policy 下 bit-identical，只能证明"live JDT 调用不改变这个值"，不能证明"这是当前 read-plan/scenario 集合本身的天花板"——`required` policy 下的类似回归已经有明确根因（`type-reference.ts:44-46`），`auto` policy 下这个数字的根因未经排查，不应类比声称"已是天花板"。

条件 4（actual Agent task success 非劣）依计划依赖 V3.2-07b（外部 Agent 模型调用），是 HANDOFF.md 记录的唯一不可绕过的用户授权边界——本轮未获得该授权，状态是 `BLOCKED_EXTERNAL`，不编造或估算数字顶替，也不需要评估：条件 1-2 已经让合取整体不成立，条件 4/5 的结果不会改变最终结论，不必为了走完形式而去申请外部调用授权。条件 5（peak RSS/机器级 JDT 数量受控）同理不再单独核查。

### 决定

**`KEEP_EXPLICIT`**（Sprint4 最终策略维持不变）——5 项条件中至少 2 项（P95、0 partial/timeout）已经用本 Sprint 已经产生、无需新实验、且经过复核站得住的证据决定性证伪，合取不可能成立，不依赖存疑的条件 3。这不是本轮的新发现，而是 V3.2-21（零质量收益 + `auto` 自身 1.5s 内部超时已经近 2 倍于 800ms 门槛）与 V3.2-24（fresh P95 远超 20s 门槛）两项已关闭结论的直接推论——**这一条基本上是 Sprint4 前四项工作的必然结果，不是一个需要独立调查的新问题**。

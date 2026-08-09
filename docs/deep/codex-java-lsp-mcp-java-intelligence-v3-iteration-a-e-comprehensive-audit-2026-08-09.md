# Java Intelligence V3 Iteration A–E 全面一致性、代码质量与效果审查

> 审查日期：2026-08-09
> 审查对象：`codex-java-lsp-mcp` 计划提交之后至 Iteration E 当前 HEAD 的全部已提交实现
> 原始计划：`docs/deep/codex-java-lsp-mcp-java-only-development-execution-plan-v3.1-2026-07-23.md`
> 改造前固定点：`48e665ba73dc332dccd4b34e71adc1c048170cf6`
> 当前审查点：`4e147560c38b76f942a15a92b34cbea69d734ef5`
> 当前分支：`codex/java-intelligence-v3`，相对同名 upstream ahead 91
> 文档性质：本报告是独立、只读审查形成的辅助证据，不替代原始执行计划，不自动改变任何 Task、gate 或发布状态。

---

## 1. 直接结论

### 1.1 总体裁决

这次改造**不是“没有效果”**。JavaIndex V2、统一 change coordinator/generation、snapshot/seeding、Evidence/Ranker/ReadPlan、framework adapter、SemanticGateway、DocumentLru 等核心生产路径都已经真实进入代码；旧 `SourceIndex V1`、旧 edge store、旧独立 references/restart/shutdown public tools 等 live path 也已实质删除。当前仓库可以构建，当前全量测试为 `782/782` 通过。

但是，基于原计划的字面约束、当前生产代码、提交历史和现存 raw evidence，不能得出“Iteration A–E 已完整验收通过”或“相对改造前整体提升了 X%”的结论。准确状态应是：

| 维度 | 审查结论 |
|---|---|
| 核心功能是否落地 | **是，大部分已落地** |
| 旧运行路径是否已删除 | **主要 live path 已删除；迁移清理和文案残留仍存在** |
| 当前 build / unit regression | **PASS：build 通过，782/782 测试通过** |
| 与 A–E 原计划逐条一致性 | **PARTIAL：多数实现一致，但若干 hard gate、实验矩阵和字面约束未闭合** |
| 端到端正确性是否无重大风险 | **否：仍有 3 个生产 P1 和 2 个验收可信度 P1** |
| 相对 `48e665b` 的整体提升 | **NOT_MEASURABLE：Task 0 三仓 baseline JSON 是 0 byte，无法计算严格 before/after** |
| 局部收益是否可证 | **部分可证：seed、R_read_must、token/read-plan 有配对收益；Phase3 V2 查询只有候选侧观察值，不能严格归因** |
| warm semantic 是否应默认开启 | **否：维持 `KEEP_EXPLICIT` 是正确决定** |
| 是否可直接宣布 V3 完成 | **否：Iteration F / Task 36 尚未实施，且 A–E 的 P1 与证据链必须先修复** |

### 1.2 最重要的判断

1. **改造方向正确，产物真实，但闭环质量不够。** 当前不是概念方案或只写了报告，而是已经形成新的运行架构；问题主要集中在跨文件 cache freshness、deadline 传播、worker RPC 失联、benchmark verifier 和 attribution 真值链。
2. **不能给出“相对改造前提升百分比”。** Task 0 的三仓 benchmark 因 `EPERM` 没有产生有效 baseline；后续数据又跨越了 scenario 数、repo commit、deadline、schema、warm policy、JDT enabled/disabled 等边界。把这些数字直接拼成总体提升会制造伪精度。
3. **局部收益与局部退化同时存在。** JavaIndex V2、seed、read-plan 强类型和 schema 收缩有真实收益；`warm-required` 在三仓都破坏 `R_read_must=1`，`warm-auto` 在两仓出现秒级延迟，说明 warm 路径目前不适合默认化。
4. **Iteration E 的 `KEEP_EXPLICIT` 本身符合 Task 35。** 原计划允许数据不足或 gate 不通过时保持显式策略；因此“不默认开启 warm-required”不是 Iteration E 失败点。失败点是实验覆盖不足、raw artifact 不完整，以及 required 分支已有质量退化尚未修复。
5. **绿灯可信度需要重新加固。** paired verifier 没有绑定 runtime/commit/scenario hash/row set，shadow attribution 又没有使用生产 `buildReadPlan()` 的实际选择，现有某些 PASS 只能说明数据文件内部自洽，不能证明正确候选构建在完整相同场景上胜出。

---

## 2. Findings：按严重度排序

本轮未发现 P0。以下 P1/P2 是当前应当在 Task 36 或任何默认化/发布判断之前处理的问题。

### 2.1 P1：生产正确性与 deadline 违约

#### [P1-01] 普通跨文件 Java 变更不会失效 SemanticGateway，可能返回最多 5 分钟旧语义结果

- 位置：
  - `src/jdtls-session.ts:402-414`
  - `src/jdtls-session.ts:561-570`
  - `src/jdtls-session.ts:623-633`
  - `src/jdtls-session.ts:1413-1442`
  - `src/semantic-gateway.ts:145-146`
- 已观察事实：
  - storm 或 `BUILD_CHANGE` 会调用 `clearCache()`，进而递增 `cacheGeneration`；
  - 普通 `JAVA_*` batch 只调用旧 `this.cache` 的 `invalidateCacheFor(files)`；
  - SemanticGateway key 只含查询文件自身 fingerprint、位置和 `cacheGeneration`，不含定义、实现、引用结果涉及的其他文件依赖；
  - COMPLETE entry 默认 TTL 为 5 分钟。
- 触发方式：先在 A.java 查询 references/definition/implementation；随后修改作为结果来源的 B.java，但 A.java 不变；再次查询 A.java。
- 实际影响：第二次查询可以命中旧 COMPLETE 结果，表现为漏引用、幽灵实现或旧定义。它直接违反 Task 9/10 的统一 generation、新鲜度和“一个变更事实源”目标。
- 为什么现有测试没挡住：现有 invalidation 测试覆盖 storm/build change，但没有覆盖“A 查询 → B 普通变更 → A 再查询”。
- 最小修复：任何 Java change batch 都递增 gateway generation；若未来要保留精细缓存，再显式记录结果依赖并按依赖失效。
- 验收标准：新增跨文件回归测试，第二次 A 查询必须重新调用 backend，且 B 的新增/删除结果立即可见。

#### [P1-02] 绝对 deadline 没有贯穿 LSP slot 与 raw JDT startup/backend

- 位置：
  - `src/repo-runtime-manager.ts:177-195`
  - `src/tools/impact.ts:53-75`
  - `src/agent-router/index.ts:304-318`
  - `src/jdtls-session.ts:310-375`
  - `src/jdtls-session.ts:572-585,633-685`
  - `src/jdtls-session.ts:1758-1806`
  - `src/semantic-gateway.ts:238-252,278-308`
- 已观察事实：
  - `prepareRequestContext()` 已构造 request budget，但 `reserveLspSlot()` 收到的是新的 `DeadlineBudget.fromTimeout(this.options.requestTimeoutMs)`，默认值为 120 秒；
  - impact tool 在 router 开始工作前就把 `budget.remainingMs(1500)` 快照成普通数字 `semanticTimeoutMs`；经过 static/framework/read-plan 前置阶段后，live semantic 才开始，却又按这个旧数字创建全新的 budget；
  - gateway 的 raw documentSymbol/hover/definition/implementation/references 在进入实际 LSP request 前调用无参数 `ensureStarted()`，从而重新得到默认 120 秒 startup budget；
  - `SemanticBackend.execute()` 虽收到 AbortSignal，但 JDT bridge 没消费该 signal；最后一个 caller timeout 后的 `controller.abort()` 不能终止 startup/backend；
  - JDT startup 本身有独立 120 秒 hard cap，实际 LSP request 也有 operation timeout/cancel，所以后台工作不是无限无界；问题是这些 cap 不是调用方唯一 absolute deadline。
- 触发方式：
  1. `maxActiveRepos` 已满且没有 idle victim，请求传入 `deadlineMs=100/500/3000` 并允许启动 LSP；或
  2. static/framework 前置阶段已经耗尽 request budget，但 semantic 仍获得早先快照的完整 1.5 秒；或
  3. JDT 尚未 READY，短 semantic caller 已结算，但共享 startup/backend 继续到自己的 cap。
- 实际影响：请求可能在 `runtime.lsp-slot` 排队远超自己的 deadline；live semantic 又可在全局预算耗尽后额外运行旧的 1.5 秒。shared caller 通常会由 gateway 的本地 race 返回，但后台工作可以继续到 startup/request cap，造成请求时钟与资源占用时钟分裂。
- 最小修复：不要把 budget 降级成提前快照的 timeout number；把同一个 `RequestContext.budget` 传给 semantic collector、gateway settlement、raw JDT startup 和 slot wait。backend 要消费 AbortSignal，并明确“共享 startup 可以继续到何种上界”和“无 waiter backend 如何结算”的会话级策略。
- 验收标准：capacity saturated、前置阶段耗尽预算、JDT slow start、caller timeout 后无 waiter四种测试，都必须按同一 absolute deadline 结算；允许继续的共享后台工作必须有明确上界、状态指标和会话保活策略。

#### [P1-03] JavaIndex worker 存活但不回包时 RPC 永久 pending，且 OPEN 位于请求 budget 之外

- 位置：
  - `src/java-index/java-index-client.ts:333-359`
  - `src/java-index/java-index-client.ts:389-417`
  - `src/repo-runtime-manager.ts:182-191`
  - `src/repo-runtime-manager.ts:481-528`
- 已观察事实：
  - `request()` 把 promise 放进 `pending` 后直接 `postMessage()`，没有 timeout、AbortSignal 或 deadline；
  - 只有 malformed response、worker `error` 或 `exit` 才会 reject 全部 pending；
  - `withContext()` 在创建 request budget 前先 `await getOrCreate()`；
  - `createEntry()` 又会等待 JavaIndex `OPEN`。
- 触发方式：worker 线程仍存活，但因死循环、协议遗漏或内部阻塞不返回 OPEN/QUERY response。
- 实际影响：单个请求越过 `java_impact.deadlineMs` 永久挂起，同 repo 的 runtime singleflight 也会被连带阻塞，pending map 持续占用内存。
- 最小修复：
  1. 在 `withContext()` 入口创建唯一 request budget；
  2. 传入 `getOrCreate/open/reconcile/query/reserveLspSlot`；
  3. RPC 超时后删除 pending、reject caller，并按策略 terminate/recreate worker；
  4. 保持失败 completion/error taxonomy 一致。
- 验收标准：fake worker 接收 message 但永不响应时，OPEN 与普通 query 都应在短 deadline 内失败，pending 清零，同 repo 后续请求可以恢复。

### 2.2 P1：验收工具会产生“假 PASS”或错误归因

#### [P1-04] 三仓 paired verifier 不验证 runtime 身份、scenario hash 或完整 row set

- 位置：
  - `scripts/verify-three-repo-cold-matrix.mjs:89-164`
  - `scripts/run-three-repo-cold-matrix.mjs:42-70`
- 已观察事实：runner 已生成 baseline/candidate、candidate patch SHA256 和 frozen scenario SHA256，但 manifest 只保存三个 repo path，没有解析并持久化各 repo `HEAD`；verifier 又只检查指标、少量 metadata、scenario 文件绝对路径，没有读取并绑定 manifest，也没有比较 old/new 的 `row.id` 集合。
- 可形成的假 PASS：
  1. 独立调用 verifier 时，old/new 实际来自同一个构建；
  2. frozen scenario 在 old/new cell 之间或运行后被同路径替换；
  3. candidate 漏掉失败 scenario，只保留容易通过的 row；
  4. 结果来自另一 repo commit 或另一 runtime build。
- 边界说明：标准 runner 的正常路径确实创建独立 baseline/candidate worktree 并按 round 执行，本 finding 不是断言该 runner 每次都跑错；它指出 verifier 可以脱离 runner 接受缺少身份/完整性的 matrix，且 runner 产物被替换后也无法发现。
- 实际影响：Task 30/32 以及最终三仓门禁的 provenance 和 completeness 都不可靠。这是验收链 P1，不等于生产排序已经错，但会导致错误发布决策。
- 最小修复：runner 解析并记录 baseline/candidate commit/tree/build stamp、每个 repo HEAD、candidate patch SHA、frozen scenario SHA、verifier version 和完整 scenario-id manifest；verifier 读取并强制绑定它们，old/new 集合必须严格相等。
- 验收标准：新增“同 commit”“同路径不同内容”“缺 row”三个反例测试，verifier 必须失败。

#### [P1-05] 非 required 策略的 attribution/counterfactual 没有投影生产 readPlan

- 位置：
  - `src/agent-router/index.ts:341-352`
  - `src/agent-router/shadow-ranking.ts:153-178`
  - `src/benchmark/attribution-v3.ts:54-81`
  - `docs/phase-v3/phase4-evidence-framework-token-report.md:115-121`
  - `docs/phase-v3/phase5-semantic-first-touch-decision.md:124-158`
- 已观察事实：生产路径总是调用 token-aware `buildReadPlan()`；shadow 在非 `required` 分支仍调用旧 `selectReadPlanFiles()`，之后把该结果发布成 `goldenAttribution.inReadPlan/blockedBy` 和 provider counterfactual。
- 实际影响：框架 provider 是否真正进入 production read plan、是否被 bytes/anchor/protected-core 挡住，可能出现假阳性或假阴性。当前 cold/auto 的 provider gain 不能作为精确生产归因。
- 最小修复：把生产 `readPlanResult.selectedPaths` 直接传入 attribution；无法在同一真实 range 数据上重算的 ablation 必须标记 `measured=false`，不得把 undefined 或 shadow selector 结果解释为“无收益”。
- 验收标准：对相同 scenario，attribution 的基础 `inReadPlan` 集合与实际 `ImpactResultV6.readPlan` 严格相等。

### 2.3 P2：资源、异常路径和计划偏差

#### [P2-01] SemanticGateway COMPLETE cache 无全表回收和容量上限

- 位置：`src/semantic-gateway.ts:195-207,326-345`。
- 已观察事实：过期 entry 只在同一个 key 再次请求时删除；每个 COMPLETE 都写入 map；generation 改变只是让旧 key 不再命中，不会释放旧 entry。
- 影响：长驻 MCP server 在不同 repo/file/position/generation 上持续查询时，JDT payload 可以无界累计，TTL 实际不是生命周期上限。
- 修复：增加惰性 sweep + hard cap/LRU；session stop、repo removal、generation clear 时提供显式 `gateway.clear()`。
- 验收：大量独立 key 过期或 stop 后，`status().completedEntries` 收敛到上限或 0。

#### [P2-02] watcher degrade 路径无法捕获 async listener rejection

- 位置：`src/repo-change-coordinator.ts:387-393,403-423`。
- 已观察事实：正常 flush 会 `await listener()` 并 catch；degrade 路径使用 `try { void listener(batch); } catch {}`，同步 try/catch 捕获不了 Promise rejection。
- 影响：watcher 已失败后，如果 JavaIndex refresh/reconcile listener 再 reject，可能形成 unhandled rejection，`lastError` 也不会记录真实第二故障。
- 修复：`void listener(batch).catch(...)`，至少更新 `lastError` 与 dirty reason；更稳妥的是集中 `Promise.allSettled`。
- 验收：rejecting async listener 的 degrade 测试不产生 unhandled rejection，并留下诊断状态。

#### [P2-03] Task 33 对 hierarchy 显式绕过 same-key singleflight

- 位置：`src/semantic-gateway.ts:149-166,195-211`；对应测试明确断言并发 hierarchy 发起两次 backend call。
- 原计划：Task 33 要求同一个 `SemanticCacheKey` 的所有 `SemanticOperation` 共享 inflight。
- 当前实现理由：hierarchy 允许每个 caller 在自身 deadline 下返回 partial edges，作者认为这一语义与共享后台调用冲突。
- 审查判断：这是有解释的实现偏差，不是静默错误；但它仍与计划字面要求不一致，也保留了最昂贵操作的重复 first-touch 风险。
- 修复方向：把 backend absolute cap 与 caller settlement 分离，backend 生成共享结果/进度，caller 按自身 budget 结算 partial；若决定不实现，应在计划 variance 中正式接受，而不是让测试单方面改写要求。

#### [P2-04] Task 35 `repoContainedFiles` 是伪 containment 指标

- 位置：`src/benchmark/semantic-first-touch.ts:137-182`。
- 已观察事实：`repoContainedFiles` 被直接赋值为 `resultFiles`；operation 只返回数量，根本没有保留 location URI 供 canonical repo containment 判断。
- 影响：该字段不能证明 `outside-repo files = 0`，也无法发现 JDK/jar/external workspace location 混入。
- 修复：operation 返回 locations/edges；按 canonical repo root 计算 contained/outside/suppressed，并加入外部 URI fake JDT 测试。

#### [P2-05] Task 35 失败日志保留与 `--output` 合约未实现

- 位置：`src/benchmark/semantic-first-touch.ts:141-167,185-202,251-252`。
- 已观察事实：`runAttempt()` 把 operation request 的异常转换成带 completion 的正常 attempt，导致 `withFreshWorkspace()` 认为 action 成功并删除 workspace；CLI 解析了 `--output`，最后却只写 stdout。`ensureStarted()` 或 `stop()` 自身若直接 throw，仍会进入保留路径，因此不是所有失败都会丢日志。
- 影响：被 `runAttempt()` 吞并分类的 operation timeout/FAILED 日志容易丢失，raw artifact 依赖 shell 重定向，不符合计划 Step 3/4 的可复现接口。
- 修复：以 `completion !== COMPLETE` 决定保留/归档 workspace；原子写 `--output`，同时可保留 stdout；覆盖 timeout、FAILED、write-error。

#### [P2-06] Task 35 最小 first-touch 矩阵没有执行完整

- 原计划：每个真实 repo，fresh/reused，至少 definition/references/type hierarchy，默认每 cell 10 次；质量矩阵为三 repo × cold/auto/required × 5。
- 现有证据：真实 first-touch 只有 cipherlink、references、fresh/reused，每 cell 3 次；quality matrix 完成三仓 × 三策略 × 5，但 runtime stamp 多处为 unknown，部分 raw artifact 未跟踪。
- 工具本身直接调用 raw session，并把 `cacheHit/shared` 硬编码为 false，没有输出计划要求的 250ms/1s/5s/never backend-settlement buckets，因此也不能衡量 SemanticGateway cache/singleflight 或取消后的真实 backend settle。
- 审查判断：现有 32–42 秒 fresh 数据已经足够支持 `KEEP_EXPLICIT`，但不能把 Task 35 的实验实施标为完整一致。
- 修复：补齐三仓/operation/preparation 组合或正式缩减计划并记录统计置信界；记录 cache/shared/backend settlement，且每个产物必须带 runtime/repo/scenario stamp。

#### [P2-07] `warm-required` 跳过静态 type-reference，已在三仓破坏 `R_read_must=1`

- 位置：`src/agent-router/type-reference.ts:42-46`；证据见 `docs/phase-v3/phase5-semantic-first-touch-decision.md:74-123`。
- 已观察事实：`semanticPolicy === "required"` 时函数直接 return；Task 35 三仓质量矩阵的 required `R_read_must` 分别为 `0.9063 / 0.8708 / 0.8854`，都低于 hard gate 1。
- 影响：更强的 semantic policy 反而删除确定性、低成本的静态证据，造成必读文件漏选。这是已测质量回归。
- 修复：required 应叠加 semantic evidence，而不是禁用 type-reference；或把对应 must-tier candidate 作为 protected core。
- 验收：冻结三仓相同 scenarios/commit，cold 与 required 均 `R_read_must=1`，且逐 scenario 最小值为 1。

#### [P2-08] Task 30 real range evidence 只有 1/24 scenario 提供真实 `mustReadRanges`

- 位置：`golden/cipherlink.scenarios.jsonl:6`；Phase 4 报告也明确记录其余 scenario 为 undefined。
- 影响：单测覆盖了 range 算法，但 real repo evidence 没有覆盖三个仓、XML、多 range、CRLF/UTF 坐标等组合。当前 report 已把 undefined 记录为未测量，未发现 verifier 将其错误计为 PASS；这里是 P2 级真实仓证据缺口，不是断言生产 range 算法或现有 gate 已失败。
- 修复：每仓至少补一个真实方法/mapper range scenario；matrix 把 undefined 明确聚合为 `UNMEASURED`，不能并入 PASS。

#### [P2-09] JPA adapter 实现存在但未注册、未测量，违反“provider 必须可归因”的原则

- 位置：`src/agent-router/providers/framework-provider.ts:21-29`，registry 只注册 Spring/MyBatis/MapStruct；Task 29 文档称 JPA 已实现但 unregistered/unmeasured。
- 影响：Task29 文档已明确把 JPA 标为 implemented-but-unregistered，这不是隐瞒；但当前仍形成有意隔离的 dead path，尚未满足最终 DoD 的 measured-or-removed，维护者要同时理解代码、注册表和隔离原因。
- 修复：若无真实 canary 价值，Task 36 直接删除 JPA dead path；若保留，则注册、加真实仓场景并通过独立 attribution gate。

#### [P2-10] Change invalidation 仍存在 RepoChangeCoordinator 与 JDT-owned watcher 双重边界

- 位置：
  - `src/repo-runtime-manager.ts:456-470`
  - `src/jdtls-session.ts:216,1289-1335`
- 已观察事实：runtime coordinator 同时驱动 router/gateway invalidation 和 JavaIndex；JdtlsSession 仍启动自有 JavaFileWatcher 并发送 LSP file-change/invalidate。
- 审查判断：其中一部分可能是给 JDTLS 的 file notification，而不是 cache truth source，不能直接认定为重复 bug；但职责边界没有在接口/文档中收敛，已经造成 P1-01 的 generation 漏接。
- 修复：明确 coordinator 是唯一 filesystem/change/generation owner；扩展 coordinator→JdtlsSession consumer，使它同时接管 `workspace/didChangeWatchedFiles` notification 与 DocumentLru modify/delete resync，再删除 session 自建 watcher。不能只删 watcher 而漏掉 JDT 文件同步；若必须保留，文档和测试要证明两个 watcher 的去重与顺序语义。

#### [P2-11] 实验 raw evidence 在干净 checkout 中不完整

- 已观察事实：`.workflow/`、`docs/evals/`、`artifacts/model-eval/`、Task 33 cutover、Task 34 LRU、Task 35 first-touch 以及部分 cipherlink quality artifact 当前未跟踪；Task 30 workflow 状态仍显示 conditional gate failed/completion ineligible。
- 影响：报告结论不能从 clean checkout 独立复算；未跟踪文件也可能在后续清理中丢失。
- 修复：不必把所有大 JSON 塞入 Git，但必须提交小型 evidence manifest，包含 base/candidate SHA/tree、repo commits、scenario/prompt/hidden-spec hash、raw artifact hash/URI、cell count、verifier version 和 gate status。

#### [P2-12] 大量 raw JSON 已跟踪，仓库体积与审阅成本显著上升

- 当前 `artifacts/` 已跟踪 507 个文件、约 122.3 MB；`48e665b..HEAD` 全范围 diff 为 812 files、`+3,234,895/-5,431`，绝大多数新增行来自 raw benchmark JSON。
- 影响：clone/fetch、diff、代码审查、Git object retention 和 IDE 索引成本持续上升；同时关键的新 raw artifact 反而仍未跟踪，形成“体积很大但证据仍不闭合”。
- 修复：Git 内保留压缩 summary、manifest、hash 和小型关键 raw；大矩阵放 immutable release/object storage；建立 artifact retention 与 schema/version 策略。

### 2.4 P3：文档与回归保护

#### [P3-01] README 的 public tool 数量和组件名称过时

- `src/README.md:19,22` 仍称 seven public tools，而 `src/server.ts:35-71` 实际注册 5 个；
- `src/tools/README.md:8` 仍称 source index，当前 ToolContext 已使用 JavaIndex；
- 根 `README.md` 仍有 SourceIndex 旧文案、15 scenarios 旧数量；
- 根 README 声称 tool schema 节约 235 tokens；本轮只能复算当前侧为约 1,291 tokens，历史 Task31 记录的旧侧为 1,495，二者推算差值为 204，但旧侧 raw schema artifact 没有保留。
- 修复：Task 36 统一 README、目录 README、注释和报告数字；若保留 204，应明确为“按历史旧侧记录推算”，不能写成本轮完整 raw paired 实测，并显式区分历史 Task 时点与当前 HEAD。

#### [P3-02] DocumentLru `didChange` 测试未断言真实 text payload

- 位置：`src/document-lru.ts:152-158`、`src/document-lru.test.ts:26-42,75-87`、`src/jdtls-session.test.ts:295-324`。
- 静态实现会发送完整文本，但测试只断言次数/version，无法阻止 payload 被置空、发旧文本或 URI 错配的回归。
- 修复：断言 URI、version、`contentChanges[0].text`；再补 watcher 修改/删除路径。

#### [P3-03] 部分历史注释/报告状态晚于代码修正，存在“报告先闭、证据后补”痕迹

- Iteration A、B、C、D、E 均出现先写 report、后因真实仓或 verifier 暴露问题再修正的提交；
- 当前 Phase 4/5 已主动披露一部分限制，这是优点，但仍有 tool count、JPA、provider attribution 等文字没有完全同步。
- 修复：最终报告必须由 verifier 输出生成核心数字，禁止手工抄写 aggregate；报告要指向 immutable manifest，而不是易变目录。

---

## 3. 审查范围、基线与方法

### 3.1 为什么选择 `48e665b` 作为改造前固定点

`48e665b` 的提交信息是 `docs(deep): add java-only architecture plans`，tree 为 `538661f26ae49c490227b760daa075dd8b6e64fe`，parent 为 `af51bc71140757ad46501c5f452b8c4475e34233`。该提交只增加 8 个计划文档、27,793 行，没有修改 `src`、`package.json` 或 scripts；因此它的生产代码与 parent 相同，是原计划进入仓库之后、实现开始之前最稳定的固定点。

`7f58fd1` 是 Task 0 的 baseline evidence freeze，其 report 也明确把 baseline commit 写成 `48e665b`。所以 `7f58fd1` 是“冻结证据提交”，不是另一个改造前代码版本。

### 3.2 固定点与 Iteration 端点

| 阶段 | Commit | Tree | 角色 |
|---|---|---|---|
| 改造前 | `48e665b...` | `538661f...` | 计划已入库，生产代码尚未改 |
| Task 0 | `7f58fd1...` | `c18bb30...` | baseline report / 空 raw artifact |
| Iteration A | `dd71542...` | `f793bab...` | correctness closeout |
| Iteration B | `957d147...` | `26f1b13...` | freshness/generation closeout |
| Iteration C | `86fef13...` | `a4ba028...` | JavaIndex V2 closeout |
| Iteration D | `09f3b03...` | `5d31262...` | evidence/framework/read-plan closeout |
| Iteration E / HEAD | `4e14756...` | `53f7757...` | warm-required decision point |

从 `48e665b` 到 HEAD 共 127 个提交。审查同时检查了：

1. 原计划每个 Task 的目标、步骤、hard gate、允许 variance 和完成定义；
2. 对应提交顺序、返工提交和报告形成时点；
3. 当前生产调用链、状态模型、缓存/deadline/worker/watcher 边界；
4. 当前测试实现及本轮实跑结果；
5. tracked 与 untracked raw artifacts、manifest、runtime stamp 和 verifier；
6. 三仓 local paired 数据、V1/V2 数据、framework canary、first-touch 与 warm policy 数据。

### 3.3 证据分级

| 等级 | 含义 | 本报告使用方式 |
|---|---|---|
| A | same machine/repo/scenario/runtime 可验证 paired raw，身份与运行次数完整 | 可做局部 before/after 结论 |
| B | 有 raw 数据，但 runtime stamp、完整 provenance 或严格配对存在缺口 | 只报告观察值，不外推总体收益 |
| C | 只有 report/commit message 或单臂结果 | 用于历史解释，不能作为发布 hard gate |
| NOT_MEASURABLE | before 缺失或两侧实验条件不可比 | 明确拒绝计算百分比 |

---

## 4. 提交历史与返工轨迹

### 4.1 Iteration 提交规模

以下 `src`、`package.json`、`scripts` 行数来自同一 scope 的 `git diff --numstat`；整体 shortstat 包含 docs/artifacts，因此两者不能混用。

| 阶段 | Commit 数 | 全范围 shortstat | `src + package.json + scripts` |
|---|---:|---:|---:|
| Task 0 | 1 | 8 files, +346 | 0 生产变更 |
| A | 10 | 59 files, +33,049/-465 | 48 files, +4,247/-465 |
| B | 12 | 116 files, +142,807/-161 | 44 files, +4,398/-161 |
| C | 13 | 114 files, +107,702/-4,063 | 82 files, +13,330/-4,063 |
| D | 69 | 332 files, +1,862,967/-1,696 | 140 files, +21,734/-1,671 |
| E | 22 | 303 files, +1,089,544/-566 | 30 files, +3,346/-562 |

### 4.2 关键返工说明

1. **Iteration A：第一次 report 不是最终 gate。** 初始三仓 run 因 sandbox `EPERM` 未完成；随后发现 benchmark 没把 request budget 传给 router，实际使用 15 秒 fallback；再之后又发现 auto 3000ms 与生产 cold-fast 2000ms 不一致。`b37d3e5`、`dd71542` 才完成修正与重跑。
2. **Iteration B：先条件通过，后补真实交错矩阵。** Phase 2 初报明确 sweep slot 与 storm 前台 P95 未闭合；`957d147` 用 A→B/B→A/A→B 交错重跑关闭三仓主 gate。当前 JavaIndex worker 已有 acquire/heartbeat/release production wiring，不能继续引用旧报告说“完全未接线”，但历史 gate 仍是条件通过。
3. **Iteration C：中途出现 51 个 TypeScript error 和 V1/V2 回摆。** `f4b814c` 发现之前的 clean build 可能是 nvm wrapper 在 tsc 前退出，且 adapter 丢 scan/limit、worker close hang；先恢复兼容路径修正，`86fef13` 才最终删除 V1 并提交 Phase 3 报告。
4. **Iteration D：真实仓持续发现 fixture 未覆盖问题。** Spring call、batch worker、endpoint unknown、snapshot pending、framework seed、MyBatis XML cap/嵌套 include 等均是在真实路径中暴露。Task 30 fresh gate 又发现 relation evidence ordering/depth 和 deferred tests 两个 P1，修复后才闭合。
5. **Phase 4 report 先于标准 paired gate。** 初始报告依据单臂/旧 16-scenario artifact；`09f3b03` 后续才加入 18-cell 标准 paired gate，之后仍有 aggregate row、readPlanRangeRecall 的更正提交。
6. **Iteration E 先出现性能回归，再增加 singleflight。** Task 33 cutover 初期两仓 P95 为旧路径 1.44–1.61 倍，原因是重复 `openDocument`/`didOpen`；后续提交才加并发 singleflight。
7. **Task 35 的初始归因被最终三仓重跑推翻。** 最终定位是 required 跳过 typeReference，同时发现 shadow selector 与 production `buildReadPlan()` 不一致。Phase 5 报告已经撤回原归因，这是诚实修正，但也证明先前 gate tooling 不足。

这些返工不是“改造失败”的证据；复杂迁移出现返工正常。真正的问题是报告/门禁有时早于标准证据，且最终 verifier 仍未强制 provenance，因此最终 closeout 必须把证据生成顺序反过来：**先冻结 manifest 和运行，再由 verifier 生成报告数字，最后才宣告 gate。**

---

## 5. 原计划 A–E 一致性矩阵

状态定义：

- **一致**：当前 production path、测试和证据基本满足任务核心要求；
- **部分一致**：核心实现存在，但有字面偏差、hard gate/真实证据/删除收敛未完成；
- **不一致**：当前实现与任务核心目标相反；
- **无法判断**：没有足够当前证据。

### 5.1 Iteration A：正确性封口

| Task | 状态 | 当前事实 | 主要缺口 / 后续 |
|---|---|---|---|
| T1 Completion、DeadlineBudget、错误分类 | 部分一致 | completion/error taxonomy 和 budget 类型已建立 | P1-02/P1-03 表明 budget 没贯穿 slot 与 JavaIndex OPEN/RPC |
| T2 可故障注入 JDT transport | 一致 | transport injection、fake backend/transport tests 已接生产构造链 | 仍需 real JDT smoke 作为发布证据 |
| T3 JDT 五态生命周期、singleflight、事务清理/backoff | 一致 | 生命周期与 restart/backoff 路径已落地 | JavaIndex worker 的失联恢复应复用相同原则 |
| T4 STARTING/READY 原子 active slot | 部分一致 | process-local reservation/slot 已落地 | 请求级 deadline 排队违约；跨进程边界由 T12a 补充 |
| T5 streaming `rg --json`、partial 禁 cache | 一致 | 流式读取和 complete-only 缓存语义存在 | 本轮未发现当前 production 反例 |
| T6 repo containment、semantic error taxonomy | 一致 | production location containment/error 分类存在 | Task35 的 benchmark containment 字段本身是假指标，需单独修复 |
| T7 hierarchy visited、显式预算、cancellation | 部分一致 | hierarchy 本身有 visited/partial-timeout 行为 | 普通 semantic raw calls 的 `ensureStarted()` 仍重建默认预算，C-07 的绝对 deadline 传播没有彻底消失；与 T33 sharing 还存在语义冲突 |
| T8 Iteration A gate/report | 部分一致 | 后续提交修正了 budget/effective policy 并有历史 TAP | Task0 before 数据缺失；初报有 EPERM/skip，不能作为完整最终 baseline |

### 5.2 Iteration B：统一新鲜度与 generation

| Task | 状态 | 当前事实 | 主要缺口 / 后续 |
|---|---|---|---|
| T9 JDT-independent RepoChangeCoordinator | 一致 | coordinator 已成为 runtime/JavaIndex change batch 主路径 | degrade async rejection P2-02 |
| T10 generation 接 rg/SourceIndex/semantic/edge | 部分一致 | generation 接入多数缓存，SourceIndex 后来被 V2 替代 | SemanticGateway 普通跨文件变更漏 bump（P1-01）；JDT-owned watcher 边界未收敛 |
| T11 delete/rename/layout refresh/dirty reconcile | 一致 | delete/rename/build change 路由和测试已落地 | 建议在最终三仓 mutation gate 复跑 |
| T12 stopped runtime 与 alias LKG | 一致 | cleanup、alias LKG 和 idle shutdown 已实现 | 无新高置信 production finding |
| T12a cross-process JDT/sweep lease | 部分一致 | current HEAD 已有 sweep acquire/heartbeat/release 与 runtime/JDT lease | JDT composite lease 暴露 `heartbeat()`，但 JdtlsSession 持有期间没有生产调用；Phase2“sweep 未接线”已过时，但 JDT heartbeat/长期持有证据仍未闭 |
| T12b watcher storm/ignore | 部分一致 | storm batch/degrade/ignore 语义已实现 | foregroundAnchorP50/P95DuringStorm 历史未测；degrade rejection 漏捕获 |
| T12c multi-process janitor | 部分一致 | active fast-only cache 以 live runtime lease 为主信号；lease store 的 heartbeat/release 按 ownerToken compare | janitor 不比较 cache metadata ownerToken，fallback 仍按 pid/JDT pid/.lock 判断；需补 PID reuse/owner replacement 多进程证据 |
| T13 Iteration B gate/report | 部分一致 | 三仓交错矩阵主质量/性能 gate 后续闭合 | sweep slot/foreground storm 证据在当时仍 partial；报告与 current wiring 有时点差异 |

### 5.3 Iteration C：JavaIndex V2

| Task | 状态 | 当前事实 | 主要缺口 / 后续 |
|---|---|---|---|
| T14 Tree-sitter compatibility spike | 一致（有文档化兼容偏差） | Node 22/macOS native binding smoke 通过，compatibility decision 明确 native UTF-16 坐标 | WASM 未评估；不能再把实现描述成 UTF-8 byte offset，但这一差异已按 spike 目标形成决策记录 |
| T15 V2 types/protocol/client | 部分一致 | protocol/client/stable IDs 已上线 | client RPC 没有 timeout/cancellation（P1-03） |
| T16 AST extractor | 一致 | core facts、incremental parser、坐标修正与 tests 存在 | 发布前仍需 corpus fuzz/invalid source soak |
| T17 import/name resolver | 一致 | FQN/import/ambiguity-safe resolver 已进入 worker/query | 当前未发现 live V1 fallback |
| T18 static edge/bounded call relation | 一致 | normalized static edges/calls 已实现 | framework 真实覆盖仍决定可见收益 |
| T19 JavaIndexStore/O(1) query | 一致 | normalized fact/edge store 与 query router 已落地 | 需要内存/长期 snapshot 容量监控 |
| T20 manifest/coverage/foreground/background | 部分一致 | current HEAD 的 background sweep lease/heartbeat/release、coverage 和 foreground refresh 已接 production | `RepoRuntimeManager` 的 `negativeLookupAllowed` 仍硬编码 false；计划中的显式 IndexJob priority/relink queue 未完全建模，历史 report 应注明后来只闭合了 sweep wiring |
| T21 atomic gzip snapshot/corruption recovery | 一致 | versioned atomic snapshot、corruption recovery 已实现 | raw startup 数据多是快速返回 BUILDING，不应表述为完整可查询时间 |
| T21a sibling snapshot seeding | 部分一致 | validated same-content seed 已实现，真实样本 629/629 reuse | 真实证据主要是零差异 worktree、n=1，不能外推大 diff |
| T22 AgentRouter cutover/delete V1 | 部分一致 | live `source-index.ts`/old edge path 已删除，V2 是唯一 production backend | Phase3 exam P50 token/bytes 约 1.254×，超过计划 <=1.05× gate；仍有迁移清理文本 |
| T23 Iteration C report | 部分一致 | Phase3 报告和三仓 raw 观察值存在；new side stamp 为 `f4b814c1ad26` | old/baseline runtime stamp 为 unknown/missing，且 new side 也不是当前 HEAD；报告遗漏局部 recall/P_read/P50 bytes 退化 |

### 5.4 Iteration D：Evidence、框架与 token

| Task | 状态 | 当前事实 | 主要缺口 / 后续 |
|---|---|---|---|
| T24 EvidenceSignal/ProviderOutcome/CandidateEvidence | 部分一致 | evidence 主链与 typed outcome 已进入 router | `ProviderOutcome.candidates` transitional 字段与 legacy candidate fold 仍存在，尚未达到计划要求的纯 evidence surface；T36 应删除 |
| T25 family saturation ranker | 部分一致 | 最终排序走 family ranker | `routing-policy`/candidate collector 中仍有旧 additive score/delta 兼容路径，需确认并删除死策略 ID |
| T26 references containment/collapse/rank/truncate | 一致 | 先 containment、按文件 collapse/价值排序再截断已实现 | P1-01 可能让输入 references 自身 stale |
| T27 Spring adapter pack | 部分一致 | Spring provider、fixture/tests 和 `7fe954e` 声明的 18/18 三仓 gate 已存在 | provider 源注释仍称 gate 未运行，关键 raw/provenance 未形成一致 clean-checkout 证据；且 production readPlan attribution 需在 P1-05 后重算 |
| T28 MyBatis adapter pack | 部分一致 | XML parser/include/mapper coverage 代码与 tests 丰富 | 三个真实仓没有可证明的 MyBatis gain，raw provider IDs 也无 mybatis；真实价值未测 |
| T29 JPA/MapStruct/Lombok completeness | 部分一致 | MapStruct canary 在 lishuedu 有局部收益；Lombok completeness 存在 | JPA unregistered/unmeasured；另外两仓 MapStruct selected/gain 为 0 |
| T30 token-aware multi-range ReadPlan | 部分一致 | production `buildReadPlan()`、range/bytes/protected-core tests 已落地 | real range 只有 1/24；paired verifier provenance 不完整 |
| T31 ImpactResultV6/schema cost | 一致 | V6 类型与默认压缩、5-tool surface 已落地；当前侧复算约 1,291 tokens，结合历史旧侧记录推算节约 204 | 旧侧 raw schema 未保留，README 的 235 与最终历史记录也不一致；需降级证据措辞并修正文档 |
| T32 Attribution V3/quality/report | 部分一致 | 24 scenarios 与 attribution schema 已存在 | non-required attribution 不等于 production readPlan；Phase4 report/paired gate曾先后补证 |

### 5.5 Iteration E：warm-required 首触治理

| Task | 状态 | 当前事实 | 主要缺口 / 后续 |
|---|---|---|---|
| T33 SemanticGateway singleflight/cache/backoff | 部分一致 | references/symbol/location 等已 cutover，complete-only TTL、lifecycle gate、edge V2 persisted read 已实现，旧 edge store 已删 | 普通 Java change stale（P1-01）；hierarchy 不共享（P2-03）；completed map 无界（P2-01） |
| T34 open-document LRU/pinning/didClose | 部分一致 | LRU、pin/deferred eviction、didOpen/didChange/didClose 功能和单测已实现 | 三仓矩阵 JDT disabled、semantic.used=0，无法归因性能收益；watcher ownership 和 text payload test 未闭 |
| T35 first-touch/default decision/min warm policy | 部分一致；决策一致 | 质量矩阵证明 required 退化；真实 first-touch 足以拒绝默认化；当前保持显式 | latency matrix 只有 cipherlink references n=3；containment/output/log 合约不完整；required typeReference 未修 |

### 5.6 Iteration F / Task 36 边界

Task 36 不在用户所说“已做到 Iteration E”的完成范围内，因此本报告不把它当作 A–E 漏做来扣分；但原计划的**最终 Definition of Done 只能在 Task 36 完成后宣告**。当前缺少：

- final dead-path/static scan；
- 旧文案、迁移 switch、README/schema/docs convergence；
- 统一 frozen 3-repo 全矩阵；
- final committed/immutable evidence manifest；
- `docs/phase-v3/final-java-intelligence-v3-report.md`。

因此，“A–E 已实现”与“V3 整体完成”必须严格区分。

---

## 6. 架构改造成果与剩余复杂度

### 6.1 已经形成的目标架构

当前生产数据流可以概括为：

```text
RepoResolver / WorktreeIdentity
        |
        v
RepoRuntimeManager ---- CrossProcessLease / active-slot
        |
        +---- RepoChangeCoordinator ---- GenerationClock
        |             |                       |
        |             +--> JavaIndex refresh/reconcile/sweep
        |             +--> Router/JDT semantic invalidation
        |
        +---- JavaIndex V2 Worker
        |       Tree-sitter facts -> normalized store -> snapshot/seed
        |
        +---- JdtlsSession -> SemanticGateway -> JDTLS
        |                       complete-only cache / inflight
        |
        +---- AgentRouter
                providers -> EvidenceSignal -> family ranker
                -> token-aware multi-range ReadPlan -> ImpactResultV6
```

相较改造前，最实质的结构收益是：

1. 同步 SourceIndex 扫描热点被 worker 化、snapshot 化、可增量 refresh 的 JavaIndex V2 取代；
2. 文件变化开始通过 coordinator/generation 统一传播，而不是各缓存自行猜测；
3. candidate 不再只依赖裸分数，而是保留 provider/evidence family/context；
4. read plan 从“选文件”升级成 token/bytes/multi-range/protected-core 的强类型结果；
5. JDT semantic 调用有统一 gateway、complete-only cache、lifecycle gate；
6. public tools 从 7 个收敛为 5 个，restart/shutdown/references 被合并到稳定 surface；
7. 旧 persisted edge store 和 V1 backend 已从 live runtime 删除。

### 6.2 旧路径删除核验

`48e665b..HEAD -- src` 明确删除：

- `src/source-index.ts`
- `src/source-index-method-relations.ts`
- `src/source-index.test.ts`
- `src/edge-store.ts`
- `src/edge-store.test.ts`
- `src/agent-router/finalize-rank.ts`
- `src/agent-router/finalize-scoring.ts`
- `src/tools/references.ts`
- `src/tools/restart.ts`
- `src/tools/shutdown.ts`

当前 `java_symbol`/`java_runtime` 只是 public compatibility surface 的合并，不是第二 backend；JDT wrappers 也最终进入 SemanticGateway。因此不能把 wrapper 存在误判成双路径。

`src/java-index/java-index-worker.ts` 中的 legacy V1 cache filename 仅用于 one-time cleanup，并有测试；这是可接受的迁移删除逻辑。但 README、测试注释和 cache cleanup 名称仍有 `SourceIndex` 文案，属于 Task 36 文档/静态收敛范围。

### 6.3 复杂度代价

| 指标 | `48e665b` | HEAD | 变化 |
|---|---:|---:|---:|
| TypeScript 文件 | 76 | 221 | +145 |
| 测试 TypeScript 文件 | 22 | 93 | +71 |
| 总 TS LOC | 13,167 | 52,299 | +39,132 / +297.2% |
| 生产 TS LOC | 9,461 | 30,738 | +21,277 / +224.9% |
| 测试 TS LOC | 3,706 | 21,561 | +17,855 / +481.8% |
| AgentRouter 文件 | 22 | 74 | +52 |
| JavaIndex 文件 | 0 | 44 | +44 |

测试增长显著快于生产代码，说明复杂状态机和边界获得了较多保护；但生产体积达到原来的约 3.25 倍，也说明维护成本已经真实上升。热点集中在：

- `java-index-worker`、protocol/store/router；
- evidence/ranker/read-plan/provider；
- JdtlsSession/runtime manager；
- benchmark/verifier/test harness。

后续不能再通过新增平行抽象解决问题，应优先删除：旧 additive ranking compatibility、重复 watcher ownership、unregistered adapter、手写报告聚合和无 provenance 的 benchmark 路径。

---

## 7. 改造效果：能证明什么，不能证明什么

### 7.1 为什么总体提升为 NOT_MEASURABLE

Task 0 的三仓 baseline benchmark JSON 是 0 byte，stderr 记录 `EPERM`；没有 recall、P_read、R_read_must、P50/P95、bytes/token 的 before 数值。因此不存在满足原计划同机器、同业务 commit、同 scenario/golden、同 deadline、同 runtime stamp 的 `48e665b -> HEAD` paired matrix。

后续数据还发生了以下口径变化：

- golden scenario 从 16 扩为 24；
- V2/V3 metric schema 变化；
- 三个业务仓 commit 多次变化；
- deadline 有 2s/3s/5s；
- cold/auto/required policy 不同；
- 部分 matrix 显式 `jdtlsDisabled=true`；
- 某些 candidate `runtimeBuild.gitSha=unknown`；
- raw artifact tracked 状态不一致。

因此不能把 Phase 1、Phase 2、Phase 3、Phase 4、Phase 5 的不同切片串成一个累计百分比。

### 7.2 A 级局部证据：Phase 2 同条件 paired

范围：`dd71542 -> 1270247`，三仓同业务 commit、`cold-nolsp`、fast/2s、AB/BA/AB、3 rounds × 5 runs。

| Repo | P95 old → new | 相对变化 | token P50 | 质量 |
|---|---:|---:|---:|---|
| lishuedu | 256.555 → 257.220 ms | +0.26% | +24 / +0.23% | recall/P_read/R_must 不变，R_must=1 |
| cipherlink | 91.181 → 98.237 ms | +7.74% | +29 / +0.29% | 不变，R_must=1 |
| exam-parent-v3 | 182.707 → 181.149 ms | -0.85% | +24 / +0.25% | 不变，R_must=1 |

正确解释：这证明 Iteration B 没有引入质量回归，延迟在 1.10× gate 内；**它不是性能提升**，因为两个仓略慢，一个仓略快。

### 7.3 A/B 级局部证据：Task 31 read plan/schema

Task 31 的 formal matrix（artifact 当前未跟踪）显示：

| Repo | ΔP_read | ΔR_read_must | Δtokens P50 | ΔP95 |
|---|---:|---:|---:|---:|
| lishuedu | +0.08333 / +13.95% | +0.08333 到 1 | -262 / -3.10% | +6.15% |
| cipherlink | +0.02000 / +3.33% | +0.21667 到 1 | -1,396 / -15.82% | +6.78% |
| exam-parent-v3 | 0 | +0.10000 到 1 | -604 / -7.54% | +2.30% |

这是 formal `matrix-summary.json` 对所有 attempts 的聚合：三仓 P95 都在 1.10× gate 内，summary 为 `passed=true`、`warnings=[]`。它证明 V6/read-plan 切片明显改善 must-read 和 token；但 artifact 当前未跟踪，仍不能替代最终 clean-checkout 发布门禁。

本轮从当前 5 个 tool schema 复算：

- 历史 Task31 记录的 before：7 tools，5,977 bytes，约 1,495 tokens；
- 当前：5 tools，5,164 bytes，约 1,291 tokens；
- 按两者推算：节约 813 bytes / 204 tokens，约 -13.6%。

按历史记录推算会达到计划 `>=200 tokens`；但旧侧 `tools/list` raw schema 没有保留，本轮只直接复算了当前侧。因此它应标为“历史基线推算已过门槛”，不是最高等级的 paired raw gate；README 中的 235 也不能直接改写成“本轮实测 204”。

### 7.4 B 级观察值：JavaIndex V1 → V2

Phase 3 raw matrix 的 new side 带有 `f4b814c1ad26` stamp，但 old/baseline side 为 `gitSha=unknown, missing=true`；而 new side 也不是当前 HEAD。因此这组数只能作为该历史候选切片的观察值，不能证明 `48e665b -> HEAD`：

| Repo | Δrecall | ΔP_read | ΔR_must | ΔP95 | Δtokens |
|---|---:|---:|---:|---:|---:|
| lishuedu | +0.03000 / +3.79% | +0.06667 / +8.70% | +0.10 | -36.16% | +3.18% |
| cipherlink | -0.01508 / -1.79% | 0 | 0 | -39.49% | -7.32% |
| exam-parent-v3 | +0.16500 / +22.45% | -0.03333 / -5.26% | 0 | -65.25% | +25.34% |

结论：`f4b814c` 候选侧 raw 样本观察到明显较低的查询延迟，lishuedu/exam recall 也较高；但 old side runtime provenance 缺失，不能把差异升级成严格的 baseline-to-candidate 归因，更不能外推到 HEAD。相同 raw 还显示 cipherlink recall、exam P_read 有退化；exam P50 bytes 为 48,705/38,835、P50 tokens 为 12,176/9,709，均约为旧侧 1.254×，超过 Task 22 的 1.05× gate。Phase 3 不能只报告正向项。

### 7.5 B 级局部证据：snapshot/seeding/framework

1. Phase 3 OPEN-return P95 约为 lishuedu 185 ms、cipherlink 74 ms、exam 80 ms；但当时 `files=0`、coverage 空、background pending，这代表“快速返回 BUILDING”，不是完整可查询时间。
2. cipherlink same-content sibling seed 重用 629/629、`deltaParsedFiles=0`，reconcile 约 2,876 → 676 ms（-76.5%）。收益真实，但样本是零差异且 n=1。
3. MapStruct lishuedu canary 的 recall 约 0.74266 → 0.82599（+11.22%），P_read/R_must 不变，P95 +3.05%；另两仓没有选中/命中，不能声称三仓都有收益。
4. MyBatis raw provider id 没有独立真实值；JPA 没注册。因此“framework pack 全部有价值”尚未被数据证明。

### 7.6 已证实的 warm 退化

Phase 5 三仓质量矩阵每仓 8 scenarios × 5：

| Repo | cold R_must | required R_must | required Δrecall | required ΔP95 | required Δtokens |
|---|---:|---:|---:|---:|---:|
| cipherlink | 1.0000 | 0.9063 | +0.04678 | +1,795 ms / +817.9% | -28.79% |
| exam-parent-v3 | 1.0000 | 0.8708 | -0.15152 | +1,882 ms / +1,239.6% | -32.67% |
| lishuedu | 1.0000 | 0.8854 | -0.04688 | +5,002 ms / +2,553.6% | -19.56% |

required 使用 5s、cold 使用 2s，延迟不能作为严格同预算 AB；但三仓 `R_read_must < 1` 是不可辩解的 hard-gate 失败。

`warm-auto` 也没有形成可接受的默认收益：

| Repo | cold P95 → auto P95 | 质量变化 | token |
|---|---:|---|---:|
| cipherlink | 219.5 → 3,482.5 ms | 主要指标不变 | +1 |
| exam-parent-v3 | 151.8 → 3,188.8 ms | recall 约 +0.58%，其余主要指标不变 | +2 |
| lishuedu | 195.9 → 287.3 ms | 不变 | +1 |

所以 `KEEP_EXPLICIT` 是当前唯一正确的默认化决定。

### 7.7 first-touch 解释

cipherlink 单锚点真实 JDT fresh references 三次约为 42.268s、32.296s、35.815s，P95 42.268s，是 800ms future-default 门槛的约 52.8 倍；reused 首次仍约 31.425s，之后才降到 182/177ms。

这足以否决默认开启，但只能证明“当前代表性 cipherlink references 的 fresh 首触不可接受”，不能推出所有 repo/operation 的完整分布。Task 34 LRU 的三仓 paired matrix 又是 `jdtlsDisabled=true`、`semantic.used=0`，因此其中 P95 改善不能归因于 DocumentLru。

---

## 8. 当前测试与验证状态

### 8.1 本轮实际运行并观察到

| 命令/检查 | 结果 |
|---|---|
| `PATH=/Users/luo/.nvm/versions/node/v22.16.0/bin:$PATH npm run build` | PASS，exit 0 |
| `npm test` | PASS，782 tests / 782 pass / 0 fail / 0 skip，约 52.34s |
| `npm run test:three-repo-matrix` | PASS，3/3，约 80.9ms |
| 当前 tool schema isolated measurement | 5 tools，5,164 bytes，约 1,291 tokens |
| Git baseline/HEAD/tree/commit/diff/LOC/artifact 统计 | 已执行并核对 |

`test:three-repo-matrix` 的 3 个测试是 verifier 自身的 fixture 测试，不是重新执行真实三仓 benchmark，也没有覆盖 P1-04 的三个反例。

### 8.2 本轮未运行

- 没有重跑真实 JDT first-touch；
- 没有重跑 48e baseline 与 HEAD 的独立 worktree paired matrix；
- 没有重跑跨进程 lease/storm soak；
- 没有重新生成所有 Phase 3/4/5 raw artifact；
- 没有执行外部远程机器、发布、commit 或 push。

未运行原因不是将其默认为通过，而是现有审查首先发现 benchmark identity/completeness verifier 本身需要修复；在修复前大规模重跑只会继续生成无法达到最终审计标准的数据。

### 8.3 当前测试覆盖的真实含义

782 个 tests 说明：大部分状态机、parser、provider、read-plan、snapshot、LRU 和 gateway 受控路径是稳定的；它不能排除：

- worker 存活但不响应；
- 普通跨文件 semantic cache stale；
- short request 在 LSP slot 排队超时；
- degrade async rejection；
- paired matrix 运行了错误构建/缺 row；
- real JDT 首触和长期内存问题。

测试数量不是 release gate，必须看是否覆盖真正的失败模式。

---

## 9. 后续优化与改造方案

### 9.1 Priority 0：先恢复正确性和 gate 可信度

#### 工作包 P0-A：统一 absolute deadline

涉及：

- `RepoRuntimeManager.withContext/getOrCreate/createEntry/reserveLspSlot`
- `JavaIndexClient.open/request/reconcile/query`
- worker pending cleanup/restart

实施原则：从 public request 入口只创建一个绝对 deadline；所有排队、runtime create、OPEN、LSP slot、JDT、JavaIndex RPC 都消费同一个剩余预算，禁止局部重新构造 120s/20s 时钟。

验收：

- saturated slot + 100ms deadline；
- live silent worker + 100ms deadline；
- same-repo concurrent create + one timeout/one recovery；
- pending/lease/refCount 全部归零。

#### 工作包 P0-B：修复 SemanticGateway freshness

第一阶段使用保守正确方案：任意 `JAVA_*` batch 都 bump gateway generation；stop/repo dispose 显式 clear。第二阶段若命中率确有问题，再引入 dependency-indexed invalidation，不要先优化。

验收：A query → B add/delete/move → A query，definition/implementation/references/type hierarchy 均重新计算；并验证 partial/failed 不写 cache。

#### 工作包 P0-C：修复 paired verifier

新增 schema：

```json
{
  "baselineCommit": "...",
  "candidateCommit": "...",
  "candidatePatchSha256": "...",
  "runtimeBuild": { "gitSha": "...", "tree": "..." },
  "repoCommit": "...",
  "scenarioSha256": "...",
  "scenarioIds": ["..."],
  "verifierVersion": "..."
}
```

verifier 必须校验 old/new 构建身份不同且符合 manifest、repo/scenario 完全相同、row set 完全相同、stderr 与 completion policy 合法。输出 summary 自带输入 hash。

#### 工作包 P0-D：修复 attribution 真值

production router 在完成 `buildReadPlan()` 后把 `selectedPaths`、range 与 blocked reason 直接交给 attribution；shadow 只计算 provider/rank ablation。任何无法用真实 range 重放的 counterfactual 标为未测量。

#### 工作包 P0-E：恢复 required 的确定性证据

删除 `semanticPolicy === required` 对 typeReference 的 early return，改为 static + semantic evidence 合并；保证 must-tier protected core 不因 semantic timeout 消失。

验收：三仓 24 scenarios × 5，逐 scenario `R_read_must=1`，并输出新增/移除 candidate 原因。

### 9.2 Priority 1：完成 Iteration E 的工程收敛

1. SemanticGateway 增加 bounded completed cache、sweep/clear、长期 status metrics；
2. 设计 hierarchy 的共享 backend + per-caller settlement，或形成正式 variance；
3. 修复 coordinator degrade async error；
4. 让 RepoChangeCoordinator 成为唯一 watcher/change truth source；
5. 实现 first-touch `--output`、失败 workspace/log retention、真实 containment；
6. 补齐三仓代表性 operation matrix，至少 definitions/references/type hierarchy；
7. DocumentLru 增加 text payload 测试和真实 JDT hit/open/close/heap 指标；
8. 将 Task 33/34/35 raw evidence 纳入 immutable manifest。

### 9.3 Priority 2：Iteration F / Task 36 最终收敛

1. 删除或注册并证明 JPA；没有真实 gain 的 MyBatis/JPA adapter 不保留“以后可能有用”的死代码；
2. 删除旧 additive ranking policy/delta/dead policy IDs；
3. 删除 JDT-owned watcher 或把它降为纯 batch consumer；
4. 清理 SourceIndex/7 tools/15 scenarios/235 tokens 等文案，并给 schema 数字标注“历史推算”或补齐 raw；
5. 建立 artifact retention：Git 中只放 manifest、summary、hash、小 raw；大 raw 放 immutable storage；
6. 由 verifier 自动生成 final report 表格，禁止手工 transcription；
7. 生成原计划要求的 `docs/phase-v3/final-java-intelligence-v3-report.md`。

### 9.4 最小、最高价值的最终数据切片

在 P0-A～P0-E 完成后：

1. 创建 `48e665b` 与 candidate HEAD 的独立 detached worktree；
2. 固定当前三个真实 repo commit；
3. 固定 24 scenarios 及 SHA256；
4. cold 对比使用相同 2s absolute deadline，AB/BA/AB，每 cell 5 runs；
5. cold、auto、required 分开报告，绝不跨 policy 混算；
6. real JDT first-touch 使用独立矩阵，不与 no-LSP quality matrix 混在一起；
7. 每个 cell 保留 runtime SHA/tree、patch hash、repo commit、scenario ids/hash、stderr、raw JSON；
8. gate 至少包含逐 scenario `R_read_must=1`、recall/P_read、P50/P95/max、bytes/tokens、timeouts、outside-repo、readPlanRangeRecall measurement coverage；
9. summary 必须由修复后的 verifier 生成。

这一次重跑才能回答用户真正关心的“相对改造开始前提升多少”。在此之前，任何整体百分比都不应进入 README、PR 或 release note。

---

## 10. 建议的发布/继续决策

### 10.1 当前决策

- **Iteration E policy decision：KEEP_EXPLICIT。** 保持现状，不把 warm-auto/warm-required 变成默认。
- **A–E implementation status：功能大部分到位，验收部分闭合。** 可以继续修复和进入 Task 36 准备，但不能把当前 HEAD 标为 release-ready。
- **V3 final status：未完成。** Task 36 尚未完成，且 P1-01～P1-05 必须先处理。

### 10.2 进入 Task 36 前的硬前置

1. P1-01、P1-02、P1-03 有回归测试并通过；
2. P1-04 verifier provenance/row-set 三个反例测试通过；
3. P1-05 attribution 与 production selectedPaths 完全一致；
4. required 恢复三仓逐 scenario `R_read_must=1`；
5. 当前 `npm run build` 与全量 `npm test` 保持通过；
6. 形成 clean-checkout 可解析的 evidence manifest。

### 10.3 最终一句话

**这次改造已经把项目从同步 SourceIndex + 分散缓存/裸排序，推进到了 JavaIndex V2 + generation + evidence/read-plan + semantic gateway 的新架构；局部 paired 数据证明 must-read、read-plan token 和 seed 有实质收益，Phase3 候选样本也观察到更低查询延迟，但后者不能严格归因。当前仍有跨文件 stale cache、deadline/RPC 失控和 benchmark/attribution 可信度漏洞，且 warm-required 已测出三仓 must-read 退化，所以应评价为“改造有效、架构已成形、尚未完成发布级闭环”，而不是“全面完成”或“整体提升 X%”。**

---

## 附录 A：主要提交映射

| Iteration | 关键提交 |
|---|---|
| Task 0 | `7f58fd1` |
| A / T1–T8 | `f64e8d7`, `1d0551f`, `3d1f7d5`, `ecc7721`, `623d8ef`, `e0d43d7`, `60ab6b1`, `4016f9a`, `b37d3e5`, `dd71542` |
| B / T9–T13 | `2ae49f0`, `4b548be`, `4f08e48`, `d4d1b59`, `e942ff7`, `f6cf0b9`, `e036a91`, `a1ec541`, `02db62d`, `f5006cb`, `1270247`, `957d147` |
| C / T14–T23 | `d2d986b`, `fd0236a`, `9b74c1e`, `5273259`, `2a03df4`, `dd4aed9`, `ced31a4`, `e80c8da`, `0c0788f`, `52adf95`, `88b94a5`, `f4b814c`, `86fef13` |
| D / T24–T32 | `c62a860` 起至 `09f3b03`，共 69 commits |
| E / T33–T35 | `85e244d` 起至 `4e14756`，共 22 commits；含 D report corrections `f08a374`, `d90f644` |

## 附录 B：可复现审查命令

```bash
git show -s --format='%H %T %P %cI %s' 48e665b 7f58fd1 dd71542 957d147 86fef13 09f3b03 HEAD
git rev-list --count 48e665b..HEAD
git diff --shortstat 48e665b HEAD
git diff --numstat 48e665b HEAD -- src package.json scripts
git diff --name-status 48e665b HEAD -- src
git ls-files artifacts | wc -l
git ls-files -z artifacts | xargs -0 stat -f '%z' | awk '{sum += $1} END {print sum}'
PATH=/Users/luo/.nvm/versions/node/v22.16.0/bin:$PATH npm run build
PATH=/Users/luo/.nvm/versions/node/v22.16.0/bin:$PATH npm test
PATH=/Users/luo/.nvm/versions/node/v22.16.0/bin:$PATH npm run test:three-repo-matrix
```

## 附录 C：审查限制

1. 本报告没有修改生产代码，也没有 commit/push；
2. 工作区原先存在大量未跟踪 benchmark/debug/eval artifact，本报告没有删除、移动或纳入这些用户文件；
3. 本轮没有重跑高成本真实三仓/JDT matrix；所有历史数字均按 raw artifact、report、commit stamp 的可验证程度分级；
4. 没有有效 Task 0 numeric baseline，因此总体 before/after 保持 `NOT_MEASURABLE`；
5. 若后续代码或 artifact 发生变化，本报告的结论只对 HEAD `4e14756` 有效。

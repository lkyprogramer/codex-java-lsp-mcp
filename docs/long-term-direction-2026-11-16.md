# codex-java-lsp-mcp 长期演进方向（独立只读评审）

> 日期：2026-11-16。基线：分支 `fix/daemon-lifecycle`，HEAD `c67faf2`。
> 方法：只读。读了 HANDOFF、AGENTS、README、审计报告、`docs/post-ilv2/`、`docs/review-2026-11-11-architecture.md`、`docs/deep/ilv2-mac-manual/` 节选、`package.json`、门禁脚本、`src/` 结构与若干模块；用 `git log` 统计了轨迹；外部项目逐个抓取了一手页面。
> 未运行：编译、测试、lint、任何产品命令（本机约 960 MB 内存）。文中的数量来自 `wc`、`git log`、`rg` 和仓库内已提交的结果 JSON。
> 证据标签：**[事实]** 直接读到；**[推断]** 由事实推出、未复现；**[假设]** 依赖我无法核实的条件。


> **所有者回复（2026-11-16）**：§7 第 1 条——日常生产仍是 2026-10-11 的旧生产版，ILV2 未上线，阶段 1 从"完成切换"开始；第 2 条——仓库公开，可以开 GitHub Actions，倾向用 GitHub 托管的 macOS runner 承担推送即触发的验证与门禁（可行范围见后续评估）。其余决策未定。

---

## 1. 结论

1. **限制这个项目的不是代码质量，而是验证回路和使用证据。** 写代码的环境不能编译；每次验证都要所有者在 Mac 上手工跑、再把结果 JSON 提交回来。同时仓库里没有任何一份"日常真实使用"的数据：部署状态只有"用户报告"，遥测在写但仓库内找不到读取它的脚本，`java_impact` 对 Agent 的收益登记为 UNMEASURED。先补这两件事，其余投入才有判断依据。
2. **ILV2 底座设计成立，但证明强度已经超出单用户工具的需要。** 单 owner、不可变 snapshot、CAS 绑定这条主干值得保留并冻结。继续往上加保证（多层租约、字节级回执、逐门 SHA-256 证据链）的边际收益很低。下一步应该是冻结加减法，不是再加固。
3. **产品定位应当收窄为"不需要构建的 Java 结构事实 + 框架关系（Spring、DTO/字段影响）"。** 仓库自己的评测显示产品在 spring、dto-impact 上领先原生搜索，在 callers、implementations、xml 上落后；S2、S3 也因证据不足关闭。这组数据本身就足以支撑收窄。外部生态是旁证：编译器级导航正在由宿主和 IDE 提供（我核实了 Claude Code 的 LSP 工具和官方 `jdtls-lsp` 插件、IntelliJ 内置 MCP、Serena；Codex 侧未能核实）。在 references / callers / implementations 上继续投入，既要赢原生搜索，又要和这些产品重叠，胜算低。
4. **JDT 路径是最大的"低使用、高成本"面。** 约 5.7k–7.3k 行生产代码（10%–13%，上限含与静态路径共用的租约和 JDK 探测模块），5 个公共工具里 2 个只服务 JDT，审计的 2 个 High 都在这里且暂缓。所有者几乎不用它。建议先隔离成可选模块，再按遥测决定去留。
5. **评测方法严谨，但样本量撑不起它要回答的问题，评测设施本身已和产品代码一样大。** `scripts/` 58k 行，对比 `src/` 生产代码 56.9k 行。Q10 只有 12 个任务组（每组每臂重复 3 次），检测不出 11 个百分点的差异。建议把常规投入转到"确定性回归集 + 日常失败案例台账 + 使用遥测"，真实 Agent 实验只在有候选改动时做。
6. **文档和证据资产已经是负债。** 跟踪的 2937 个文件里只有 460 个在 `src/`；docs 1341 个文件 37 MB，artifacts 742 个文件 193 MB。建议把历史证据整体移出主仓库，主仓库只留约 30 份现行文档。
7. **发布运维有完整机制但没有成为例行动作。** 安装器 1070 行、`daemonctl.sh` 402 行，支持 canary、签名、回滚；但 README 自己写明"兼容与回滚按用户要求不再验收"，版本号一直是 `0.1.0`，没有发布 tag，也没有 CHANGELOG。需要的是一条每次都走的短路径，而不是更多机制。
8. **"窄定位 + 维护模式"是一个正当的终局。** 路线图按投入产出排序：阶段 0 验证回路自动化 → 阶段 1 上线与可观测闭环 → 阶段 2 减法 → 阶段 3 按证据触发的框架关系深化 → 维护模式。阶段 3 可以长期为空。

---

## 2. 现状诊断

### 2.1 项目轨迹

- **[事实]** 2026-06-21 至 2026-11-16 共 901 个提交。前缀分布：feat 277、fix 265、docs 227、test 51。只改文档的提交 207 个（23%）。`HANDOFF.md` 被 123 个提交改过。
- **[事实]** 提交 scope 显示先后有 9 条以上命名的工作线：`iod` 118、`ilv2` 102、`eval` 74、`jin` 65、`v4` 32、`v5r` 17、`v32` 17、`v3` 15、`fs` 13。
- **[事实]** `src/` 历史上被改动最多的 7 个文件里有 4 个已经不存在：`java-index-worker.ts`（65 次）、`index-store.ts`（40）、`java-index-client.ts`（36）、`worker-protocol.ts`（34）。
- **[事实]** 提交高度突发：2026-09-07 一天 73 个，2026-11-16 一天 57 个。
- **[推断]** 五个月里索引层被重建了大约三次（内存索引 → 落盘索引 IOD → ILV2）。大量投入花在后来被整体替换的实现上。这本身不算错，早期探索如此；但它说明现在最需要的是停止重建，让一版底座稳定下来接受真实使用。

### 2.2 架构

- **[事实]** 主干：一个 canonical cache root 一个 owner；签名的 C launcher 持有 fd4 锁后 exec 冻结 Node；stdio 只转发到 HTTP owner；静态事实是 `mac1/` 下封存的 SQLite snapshot 加 workspace binding；builder 和查询在可杀的子进程里（HANDOFF、`docs/deep/ilv2-mac-manual/contract.md`）。
- **[事实]** 2026-11-11 的架构评审没有发现让主干失效的缺陷，14 项 finding 多数已修（`docs/review-2026-11-11-architecture.md` §9）。
- **[事实]** 评审登记但未处理的结构性问题：
  - F2：delta 与全量的语义等价没有运行期对照，只加了血缘上限 256 和手动门禁脚本。
  - F8：知识图谱 `kg_*` 每次构建都写，产品没有读取方，状态"只记录"。`cold-build.ts`、`incremental.ts`、`graph-builder.ts` 仍在引用。
  - F13：从生产入口不可达的代码约 6700 行（其中 benchmark 约 3900 行）；所有权机制四层并存（原生 fd4 锁、`RepoOwnershipManager`、`FileCrossProcessLeaseStore`、`RuntimeLifecycleGate`）。
- **[事实]** 只服务 JDT 的生产代码约 5.7k 行：`jdtls-*`（3449）、`semantic-*`（861）、`agent-router/semantic.ts`（562）、`mac-platform/gradle-domain.ts`（319）、`document-lru.ts`（211）、`jdt-*`（223）、`tools/diagnostics.ts` 与 `tools/runtime.ts`（106）。另有约 1.6k 行主要因 JDT 而存在、但静态路径也 import 的模块：`cross-process-lease.ts`（736）、`repo-ownership-lease.ts`（519）、`project-jdk.ts`（353），它们的 importer 里有 `application.ts`、`repo-runtime-manager.ts`、`worktree-cache-cleanup.ts`、`tools/status.ts`。合计上限约 7.3k 行。这些模块之外有 14 个文件 import 它们，包括 `application.ts`、`repo-runtime-manager.ts`、`tools/symbol.ts`、`tools/status.ts`、`agent-router/index.ts`、`worktree-cache-cleanup.ts`（其中 2 个是 benchmark，部分是 type-only import，我没有逐个区分）。
- **[事实]** 5 个公共工具里，`java_diagnostics` 和 `java_runtime` 只服务 JDT；`java_symbol` 的 `position`、`references` 也始终走 JDT（README 工具表）。
- **[事实]** 非测试的 `src/*.ts` 里出现的产品前缀环境变量名（`JAVA_LSP_`、`ILV2_`、`JDTLS_`、`CODEX_JAVA_LSP_`）去重后 74 个。这是名字出现数，不是读取点数；README 配置表记录了约 40 个。
- **[推断]** 架构的问题不在主干，而在"为可选路径和已退役路径付常驻成本"：JDT 把静态路径的启动、关停、租约都拖进了更复杂的状态机；`kg_*` 让 delta 的依赖闭包规则更多，而这些规则正是 F2 的风险来源。
- **[推断]** 过度设计的具体位置（单用户、单机前提下）：
  - 跨进程租约：审计 H2 指出 `claimLeaseDir` 的生产调用方只有 JDT，`acquireSweep`、`acquireBuild` 没有调用方。
  - 四层所有权：单 owner 模型下前两层职责重叠（架构评审 F13）。
  - 合同文档对 launchd 进程组、Gradle daemon 域、TCC 责任进程的逐级证明要求，是按"多方共用的服务"规格写的。
  - 这些已经建成，建议冻结而不是拆掉；拆的成本也不低。只在 JDT 去留决定之后顺带合并租约层。

### 2.3 代码

- **[事实]** 生产代码 254 个文件 56,931 行；测试 203 个文件 50,399 行。最大文件：`java-index-router.ts` 1501、`jdtls-session.ts` 1345、`incremental.ts` 1267、`repo-runtime-manager.ts` 1224、`relationship-provider.ts` 1138。
- **[事实]** 审计 §9：静态路径无高严重度缺陷，M1–M3、C-M2 及多数 Low 已修；H1、H2、C-M3、C-M4（均 JDT）暂缓。
- **[事实]** 机器门禁已到位：eslint 基线冻结 1409 处非空断言、166 处 `as unknown as`、12 处 `any`，分布在 198 个文件；卫生基线冻结 49 个无测试的生产模块、54 个未引用脚本、46 个用定时器等待的测试文件。
- **[事实]** `tsconfig.json` 只开 `strict`；`noUncheckedIndexedAccess` 实测 235 处报错后决定不做；`scripts/` 不做类型检查（审计 E3"不做"）。
- **[推断]** 代码层面已经到了"再修小问题收益递减"的位置，和所有者的判断一致。剩下值得做的是删除，不是修补。

### 2.4 测试与验证

- **[事实]** 开发机不跑 tsc、测试、eslint；分支推送后由所有者在 Mac 上跑 `npm run gate:pr`，结果提交为 JSON 后再决定合入（HANDOFF"验证"条）。仓库没有 `.github/`，没有 CI。
- **[事实]** Mac 上 `gate:pr` 约 5 分钟、1665 个测试；全量 `npm test` 约 30 分钟、2471 个测试（`docs/post-ilv2/results/S1-MAC-GATES.json` 的起止时间）。
- **[事实]** 盲写的直接代价有记录：`e789c92` 登记审计第 2 步 Mac 门 FAIL，结果 JSON 里的原因是编译错误 `seal.ts(280,9): error TS2304: Cannot find name 'writeFileAtomic'`，测试 NOT_RUN；`d964c10` 是一行 import 修复；`9e3421b` 登记重跑 PASS。一个编译器几秒能报的错误，走了一次完整的人工往返。
- **[事实]** 提交标题含"record … Mac gate"的提交有 24 个。门禁结果作为文档进了主分支历史。
- **[事实]** 203 个 `src` 测试文件里，直接引用原生或 Mac 专属原语（clonefile、fsevents、owner-lock、launchd、codesign）的只有 9 个；显式按 `process.platform` 分支的只有 1 个。
- **[事实]** 验证入口要求冻结的 `ILV2_NODE_BIN` 和 `ILV2_RUNTIME_MANIFEST`，并在隔离的 detached clone、私有 HOME 里重新编译（`scripts/run-isolated-node.sh`、README"隔离硬门禁"）。
- **[推断]** 大部分单元测试在原理上与平台无关，可以在 Linux CI 上跑；实际能跑通的比例未知，因为间接依赖原生二进制的测试 `rg` 数不出来。这是阶段 0 要先量的数。
- **[推断]** 验证回路的瓶颈是"人"，不是机器时间：5 分钟的门要等所有者有空去跑、去提交。这直接限制了迭代速度，也解释了为什么会出现"只改代码不验证、集中 review"的 D0 执行方式（`decisions.md` D0）。

### 2.5 可观测性

- **[事实]** 已有的部件：
  - `java_status` 汇总 runtime、索引 coverage、generation、lease、`index.queryCounters`（`queueFull`、被杀查询数）。
  - HTTP `/healthz`、`/readyz`。
  - `process-crash-markers.ts`：uncaughtException、unhandledRejection（带累计计数）、exit、nearHeapLimit 各写一行结构化 JSON。
  - `telemetry/impact-telemetry.ts`：每次工具调用写一行 JSONL 到 cache base 的 `telemetry/impact-YYYYMMDD.jsonl`，含工具名、耗时、ok、errorCode、repoHash；`java_impact` 另记 readPlan 条数、计划字节、估算 token、是否冷路径。保留 30 天。
  - `owner` 内部有 `lastRound`、`rounds`、`fullReason`。
  - `java-index/snapshot/owner-telemetry.ts`：每个 owner 事件（round、调度、进程池、GC、builder 存活）写一行 JSONL，并每 5 秒写一条进程样本（RSS、堆、CPU、GC 暂停、事件循环延迟）。**但它只在隔离验证下生效**：文件头注明"Isolated validation only"，只认 `JAVA_LSP_OWNER_TELEMETRY` 且要求 `JAVA_LSP_ISOLATED_VALIDATION=1`。
- **[事实]** `scripts/` 里没有找到读取工具遥测 JSONL（`impact-*.jsonl`）的汇总脚本。没找到不等于不存在，可能在仓库外。
- **[事实]** launchd 模板把输出写到固定的 `daemon.stdout.log`、`daemon.stderr.log`（`macos/com.lky.codex-java-lsp-mcp.plist.template`）；模板、安装脚本、`scripts/`、`src/` 里都没有找到轮转配置。
- **[事实]** `log.ts` 只是给 `console.error` 加时间戳前缀，日志是自由文本。`runtime/request-context.ts` 已经为每个请求生成 `requestId`（`randomUUID`），但非测试代码里没有别处用它，日志行和遥测行都不带。
- **[推断]** 现状是"有传感器、没有仪表"，而且最有用的那组传感器（owner 生命周期和事件循环延迟）在生产里是关着的。出了问题能在日志里翻到，但回答不了三个长期问题：每周每个工具被调用多少次、成功率和 p95 是多少、升级后有没有变差。架构评审里 F4、F5、F8 三项都写着"等有数据后再决定"，而数据的读取端一直没建。

### 2.6 发布与运维

- **[事实]** `install-runtime.sh` 1070 行，含安装锁、隔离测试、候选 smoke、备份、切换 `current`、写 LaunchAgent、失败恢复；`daemonctl.sh` 402 行，含 `status|start|stop|restart|wait-ready|smoke|rollback-release`。
- **[事实]** README："兼容与回滚按用户要求不再验收，有问题停用"；"首次安装没有完整前序备份时不能执行 release rollback"。
- **[事实]** `package.json` 版本 `0.1.0`；唯一的 tag 是 `v5r-evidence-baseline`；没有 CHANGELOG。
- **[事实]** 部署身份不明：`decisions.md` D1 记"USER_REPORTED_DEPLOYED / NOT_INDEPENDENTLY_VERIFIED，`installedDigest=null`"；`docs/index-lifecycle-v2/mac/status.json` 仍是 `planStatus=IN_PROGRESS`、`candidateStatus=NOT_READY`；README 称 MAC-17 是候选、"本轮不执行生产安装"；HANDOFF 说"默认 runtime 仍为历史路径"。
- **[事实]** TCC 责任进程是开放决定：业务仓在 `~/Documents` 下，launcher 被记为责任进程，首次读取会等隐私授权（`contract.md` §2.1）。
- **[假设]** 所有者日常在用的是哪个构建，仓库里判断不了。可能是 ILV2，也可能仍是 2026-10-11 的旧生产版。这一点决定路线图第一阶段是"完成切换"还是"直接做可观测"，见 §7 第 1 条。
- **[推断]** 回滚机制写了但不演练，等于没有。对单人项目更实际的保证是：每次发布都走同一条短脚本，并且每次都顺手做一次回滚演练。

### 2.7 文档与知识

- **[事实]** 审计后 HANDOFF 从 76 KB 减到 19 行，README 历史移到 `docs/archive/`，AGENTS.md 写明"真源只看 HANDOFF 开头两节"。这一步方向正确。
- **[事实]** 仍然存在的体量：`docs/` 1341 个文件 37 MB；`docs/deep` 2.0 MB（单份执行计划 343 KB）；`docs/next-stage` 4.3 MB；`docs/java-specialist-release-audit-v1.1` 326 个文件；`artifacts/` 742 个文件 193 MB，被认定为"冻结证据"留在跟踪里（审计 E1）。
- **[事实]** 现存矛盾：AGENTS.md 说 `docs/phase-*` 是历史，README 第 11 行和第 401 行却把 `docs/phase-f/production-operations.md` 标为"生产操作（IOD 现行）"。
- **[事实]** 没有一份"当前架构"的单一文档。现行设计分散在 README 的"五层架构"、`contract.md`（28 KB 的目标合同）、架构评审、HANDOFF 里。
- **[推断]** 文档是按"给 AI 执行者的合同和证据"写的（任务卡、RUN_AI、逐门结果 JSON），不是按"给维护者的知识"写的。它们的读者是当时那一轮会话。对长期维护有用的只有三类：当前设计、决策及其理由、操作手册。

### 2.8 数据与索引生命周期、性能

- **[事实]** 缓存是可重建的派生数据：ILV2 用独立的 `mac1/` 布局，不迁移旧格式，不支持双格式启动；方法键升级时旧库按版本机制重建（README）。这个策略对单人项目是对的，省掉了迁移代码。
- **[事实]** 事实版本靠手工维护的 `JAVA_FACTS_REVISION`。防漏改的 `scripts/check-facts-revision.mjs` 是"手动合入门禁"（架构评审 §9），不在 `gate:pr` 的步骤里（`scripts/run-v4-gates.mjs` 的 `GATE_PROFILES.pr` 只有卫生检查、eslint、dist 测试）。
- **[事实]** 回收有三套：owner 的 snapshot GC（按绑定和租约）、cache janitor（按 TTL、目录数、字节上限，6 小时一次）、遥测 30 天清理。janitor 在架构评审 F1 后改成了允许名单。
- **[事实]** 与使用量无关的后台成本仍在：每个活跃 workspace 每 10 分钟一次全量 hash，每次 delta 发布后做整库完整性检查加 SHA-256；pin 仓库空闲后不退役（架构评审 F5，状态"只记录"）。
- **[事实]** 已知容量形状：全局最多 2 个查询 worker、等待队列 32；大仓首次冷建 1–3 分钟（README）；`java_impact` 的 deadline 上限 15 秒。
- **[推断]** 性能方面没有"已测出的瓶颈"，只有"没被测的常驻成本"。F4、F5 都停在"先测量"，而测量的读取端没建（见 2.5）。在数据出来之前不建议做任何性能改造。
- **[推断]** 生命周期里真正的长期风险是 F2：delta 规则漏一种情况就会静默漂移，目前的防线只有血缘上限 256。

### 2.9 评测方法

- **[事实]** 数据集 `mac10-v3`：50 题（QA 45 题，implementations、callers、spring、dto-impact、xml 各 9 题；repair 5 题），3 个仓库，dev 33 / holdout 17。gold 和原始数据在私有工作根，不在仓库里。holdout 已被看过，只能当历史回归集（`decisions.md` D11）。
- **[事实]** 产品对原生搜索的分类结果（`docs/post-ilv2/results/D15-F.json` 的 `w2RecallByCategoryAndDriver`，均值为我按 `recallSum/slots` 计算）：

  | 类别 | slot 数 | product | native-rg |
  |---|---|---|---|
  | spring | 4 | 0.70 | 0.52 |
  | dto-impact | 3 | 0.81 | 0.58 |
  | callers | 4 | 0.29 | 0.44 |
  | implementations | 3 | 0.47 | 0.67 |
  | xml | 3 | 0.00 | 0.33 |
  | repair | 3 | 0.00 | 0.00 |

  总体：product 平均召回 38.9%，native 42.8%，配对 4 好 4 差 12 平（`d15-discovery-ranking.md`）。
- **[事实]** 真实 Agent 配对 Q10：72 个 slot，B0 通过 11/36，B2 通过 15/36，差 +11.1 个百分点，95% 区间跨 0，三仓方向不一致，判 INCONCLUSIVE。Q10 里模型可见的产品工具只有 `java_symbol` query，没有 `java_impact`，所以 `java_impact` 的 Agent 收益是 UNMEASURED（`decisions.md` D13 及"合入后收口"）。
- **[事实]** D15–D19 诊断链（5 份文档）的产出：S1 新命中 2 个 implementations 目标；S2、S3 关闭；13 个目标里没有产品缺陷。outline 和 evidence v2 净增 415 行生产代码，默认隐藏，2027-02-13 到期按 NO_GAIN 删除。
- **[事实]** MyBatis 是产品的卖点之一，但三个冻结语料里识别到 0 条 mapper XML 语句，MyBatis 发现验证为 NOT_RUN（`D15-MYBATIS-CENSUS.json`）。
- **[事实]** 评测与门禁设施体量：`scripts/` 286 个文件 58,109 行（含 122 个 `*.test.mjs`），其中 `ilv2-*` 122 个（`ilv2-mac-*` 90 个）、`eval-*` 18 个；评测协议在仓库里有 v1.2、v1.3、v1.4、v1.5、v1.7、v1.8 六个版本文件。
- **[事实]** Q10 的 72 个 slot 是 12 个任务 × 2 臂 × 3 次重复（`decisions.md` D9）。独立的配对单位是 12 个任务组，重复只降低单题噪声。
- **[推断]** 方法本身（预注册规则、停止规则、holdout 隔离、失败留在分母）是高质量的，负面结论也都可信。问题是功效：按配对二元结局、假设不一致对占 30% 粗算，要以 80% 功效检测 11 个百分点的差异大约需要 190 个独立配对，实际是 12 个任务组。分类表每格 3–4 个 slot，只能当方向信号。
- **[推断]** 在这个样本量下，继续做同类实验只会继续得到 INCONCLUSIVE。要么把样本扩大一个数量级（单人维护不现实），要么换一个问题：不问"是否显著更好"，只问"是否没有变差"和"真实使用里有没有人调用"。
- **[假设]** 所有者日常工作的仓库是否大量使用 MyBatis，我不知道。如果是，评测语料和真实使用不匹配；如果不是，MyBatis 这块可以降级。

---

## 3. 外部参照

以下每项我都抓取了至少一个一手页面；标"未核实"的是只见于搜索摘要或二手来源的内容。

**Serena（oraios/serena）。** 开源 MCP 工具包，自称"给 Agent 用的 IDE"。两个可互换后端：免费的语言服务器后端（40 多种语言，含 Java）和付费的 JetBrains 插件后端。页面显示约 31.4k star、3600 多个提交，已发布 v2。README 明说语言服务器后端的 find implementations"受语言服务器能力限制"，外部依赖里的声明通常解析不了，类型层级和依赖搜索只有 JetBrains 后端有。带一个本地 web dashboard，显示当前配置、进行中和历史的工具调用及用量统计、实时日志。
- 可借鉴：把"工具调用统计 + 实时日志"做成随手可看的本地页面；后端可替换的边界；承认语言服务器后端有硬限制而不是自己补。
- 不适用：多语言、符号级编辑、记忆系统、调试，都在本项目非目标内。Java 具体用哪个语言服务器，本轮抓到的页面没写，未核实。
- 链接：<https://github.com/oraios/serena>，<https://oraios.github.io/serena/02-usage/060_dashboard.html>

**IntelliJ IDEA 内置 MCP server。** 2026.3 文档列出的工具含 `analyze_calls`（IDE 调用层级，入向和出向，带 depth、maxNodes 上限）、`search_symbol`、`get_symbol_info`、`get_file_problems`、`rename_refactoring`、`build_project` 等。文档没有列出专门的 find-usages 或类型层级工具。工具可以标为"router-only"：从直接工具列表里隐藏，只经一个路由工具调用，目的是省上下文。
- 可借鉴：用路由工具压缩 schema 成本，印证本项目"固定 5 个工具、测 `tools/list` 字节"的做法；调用层级这种需要编译器的能力交给 IDE。
- 不适用：需要 IDE 开着并加载项目（文档未明说，是我的推断）；本项目的价值恰恰在不需要 IDE 和构建。
- 链接：<https://www.jetbrains.com/help/idea/2026.3/mcp-server.html>

**Claude Code 的 LSP 工具与官方 `jdtls-lsp` 插件。** 官方文档：安装代码智能插件后，Claude 得到一个只读 `LSP` 工具，可以跳定义、找引用、取类型信息、列文件符号、按名搜工作区符号、找接口实现、追调用层级，并在每次编辑后自动拿到诊断。官方市场有 Java 的 `jdtls-lsp` 插件，二进制 `jdtls` 自己装。云端会话不启动语言服务器。
- 可借鉴：这是对本项目 JDT 路径最直接的替代。宿主已经把"启动 jdtls、等导入、发 LSP 请求"做成了平台能力，本项目自己维护 5.7k 行以上同类代码的理由变弱。
- 不适用：只在 Claude Code 终端会话可用。Codex CLI 是否有内置 LSP，我只找到 2026 年 4 月的二手来源说"没有"，未核实，现状可能已变。
- 链接：<https://code.claude.com/docs/en/plugins/code-intelligence>，<https://code.claude.com/docs/en/tools-reference>

**JavaLens（pzalutski-pixel/javalens-mcp）及其他 JDT 封装。** JavaLens 直接经 OSGi 调 Eclipse JDT Core（不是 JDT LS），75 个工具，约 48 star。两点值得注意：
- 新鲜度靠查询时校验：默认 `strict` 模式下每次查询先对源文件做内容 hash、修复变更再回答，页面给的数字是 1000 个文件约 25 ms、10000 个约 180 ms。没有常驻 watcher。
- 页面承认模型偏向用原生 Grep 和 Read，建议在 CLAUDE.md 里写引导。
- 另外搜索到 sunix/jdtls-mcp、mwgreen/java-mcp-server、stephanj/lsp4j-mcp、jonmmease/jons-mcp-java 等多个 JDT LS 封装，我只看到列表摘要，未逐个核实。
- 可借鉴："查询时校验"是 FSEvents + 水位 + 周期全量 hash 之外的另一条路，复杂度低一个量级。ILV2 已经建成，不建议推倒；但它支持架构评审 F5 的建议——空闲 workspace 停掉 tracker，改为下次请求时校验。"模型偏向原生工具"说明采用率必须用遥测量，不能假设。
- 不适用：JDT Core 需要解析构建模型，等于又回到依赖构建。
- 结论性观察：**"把 JDT 包给 Agent"这个位置已经很拥挤**，本项目在这里没有差异化。
- 链接：<https://github.com/pzalutski-pixel/javalens-mcp>

**Eclipse JDT LS。** README：运行时至少需要 Java 25，可编译 Java 1.8 到 25 的代码；Maven 走 M2Eclipse，Gradle 走 Buildship；提供调用层级、类型层级。仓库活跃（2377 个提交、约 400 个未关 issue）。
- 可借鉴：它是所有 JDT 方案的共同上游，升级节奏（比如运行时 JDK 下限上调）会直接打到本项目的 JDT 路径，这是一项持续的维护税。
- 链接：<https://github.com/eclipse-jdtls/eclipse.jdt.ls>

**Sourcegraph scip-java。** Java 编译器插件，作为构建的一部分运行并产出 SCIP 索引；自动支持 Gradle、Maven、Bazel；支持 Java 17、21、25，不支持 7、8、11；默认不支持增量索引，`scip-java index` 可能清编译缓存。
- 可借鉴：精确索引的正确做法是挂在真实构建上，由编译器给事实。
- 不适用：要求能构建、不增量，适合 CI 批处理，不适合"编辑后秒级可见"的交互场景。本项目 02 号调研已经把它定为"暂不实施"，我同意。
- 链接：<https://github.com/sourcegraph/scip-java>，<https://github.com/sourcegraph/scip-java/blob/main/docs/getting-started.md>

**GitHub stack-graphs。** 仓库已于 2025-09-09 归档只读，README 写明"GitHub 不再支持或更新"。它的目标是不经编译器、只靠 tree-sitter 加图规则做精确名称解析。
- 可借鉴的是教训（推断：README 没有给出归档原因）：**连 GitHub 都没有把"无编译器的精确解析"维持下去。** 这与关闭 S2、S3 的决定方向一致，也提示本项目的静态路径应该停在"声明、结构、框架标记、显式文本关系"，不要往重载、泛型、分派解析走。
- 链接：<https://github.com/github/stack-graphs>

**Aider repo map。** 每次请求附带一张全仓地图，列出最重要的类和函数签名；用图排序选最相关部分；`--map-tokens` 默认 1k token，且不是硬上限。
- 可借鉴：预算优先、排序选择、承认地图是局部的。与本项目 readPlan 的预算思路一致。
- 不适用：每轮硬塞地图的方式，本项目是按需工具调用。
- 链接：<https://aider.chat/docs/repomap.html>

**Cline 与"不建索引"路线。** Cline 官方博客明确不做索引、embedding、向量库，理由是切块破坏代码逻辑、索引会过期、embedding 是敏感代码的第二份拷贝；做法是像开发者一样读文件、顺着 import 追。
- 可借鉴：原生的"grep + 读文件"是一个很强的基线，本项目的评测也证实了这点（native-rg 总体略高于 product）。任何新能力都应该先和它配对比较。
- 不适用：大仓库上的探索成本。本项目的结构索引正是为了省这部分。
- 链接：<https://cline.bot/blog/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing>

**Cursor。** 官方文档当前页面描述的是本地的 Instant Grep 索引（在本机构建和查询，页面称不上传路径或代码来建搜索索引）和用于大范围搜索的 Explore 子代理。早期广为流传的"Merkle 树同步 + 服务端 embedding"方案我只找到二手来源，与当前官方页面的说法有出入，未核实现状。
- 可借鉴：即使资源最多的团队，默认路径也是"快的本地精确搜索 + 子代理展开"，而不是更重的语义索引。
- 链接：<https://cursor.com/docs/context/codebase-indexing>

**综合教训。**
1. 编译器级导航（引用、调用层级、实现）正在变成宿主和 IDE 的标配，不值得自建。
2. 无编译器的精确解析，我没有找到被长期维持下来的先例（推断，样本只有 stack-graphs 一个）。
3. 原生搜索是强基线，新工具必须在配对比较里赢它才有存在理由。
4. 活下来的工具都有很薄的常驻面和很清楚的"我不做什么"。
5. 模型不一定会用你的工具，采用率要量。

---

## 4. 目标形态（1–2 年）

### 4.1 一句话定位

一个只在 Mac 上跑的本地服务：**不需要构建、不需要 IDE，秒级回答 Java 仓库的"这个符号在哪、长什么样、改它会碰到哪些 Spring 装配 / DTO 映射 / 配置"**，并给出受 token 预算约束的读取计划。调用方、实现类、精确引用交给宿主的搜索和 LSP。

### 4.2 分层与边界

| 层 | 内容 | 变更规则 |
|---|---|---|
| L0 平台内核 | native launcher、owner 锁、snapshot store、workspace tracker、builder 和查询进程池 | **冻结。** 只在有复现的缺陷时改；不再新增保证 |
| L1 事实 | tree-sitter 提取、SQLite schema、`JAVA_FACTS_REVISION` | 改动必须过 full-vs-delta 对照和 golden fixture |
| L2 检索与产品 | discovery 查询、`java_impact` 的框架关系、readPlan | 功能演进只发生在这层，每项有回归用例 |
| L3 表面 | MCP 工具、stdio relay | schema 字节有门；工具数只减不增 |
| L4 运维 | 一个 `javactl`：`install | upgrade | rollback | status | doctor | stats | logs` | 每次发布走同一条路径 |
| 可选插件 | 语义后端（JDT），经一个 `SemanticBackend` 接口接入 | 静态路径对 `jdtls-*`、`semantic-*` 零 import；不启用时不加载 |
| 仓库外 | 评测 harness、历史证据、benchmark | 不在 `src/` 内，不计入生产代码和 lint 基线 |

### 4.3 数据流

```
Agent ──MCP──> stdio relay ──HTTP(loopback)──> owner
                                                ├─ 请求：acquire snapshot view → 查询进程池 → L2 排序/预算 → 响应
                                                │        └─ 每次调用写一行遥测（工具、耗时、状态、新鲜度）
                                                └─ 后台：FSEvents → 水位 → delta/full builder → seal → 绑定
                                                         └─ 每轮 round 写一行事件（模式、原因、耗时）
javactl stats / doctor <── 读遥测 JSONL、round 事件、crash marker、launchd 状态
```

### 4.4 运行形态

- 一个 launchd job、一个 owner、一个 cache root。
- 空闲 workspace 是否停掉 tracker、改为下次请求时校验，取决于阶段 1 的数据：如果周期全量 hash 和发布后校验在空闲期的耗时占比明显，就做。这是对"L0 冻结"的唯一预留例外，也要改 `contract.md` §2.4 里"每 10 分钟一次完整 hash"的条款；数据不支持就不动。
- 版本用 semver，每个安装的 release 对应一个 git tag，`java_status` 和 `doctor` 能报出当前安装的 tag 和 digest。
- 升级是一条命令，失败自动回到前一个 release；回滚每次发布演练一次。
- 开发：推送后几分钟内自动得到编译、lint、测试结论，不需要所有者动手。

### 4.5 明确不做

- 不做多语言、跨平台、远程或多用户；不加鉴权（架构评审 F6 的结论成立）。
- 不做 embedding 或向量检索（已否决，维持）。
- 不做无编译器的调用图、重载或分派解析；S2、S3 不重开。
- 不自建第二个编译器级后端；不扩大 JDT 路径。
- 不新增常驻进程、不新增所有权或租约层、不新增"证据链"类机制。
- 不新增环境变量开关，除非同时写下删除日期。
- 不做没有候选改动的大型真实 Agent 实验；不再发布新的评测协议版本，除非有实验要跑。
- 不再把门禁结果、执行日志提交进主分支。

---

## 5. 分阶段路线图

按投入产出排序。每阶段写明在哪验证、谁来跑。"所有者动手"指需要人在 Mac 上操作。

### 阶段 0：验证回路自动化（最高优先，约 1–2 周）

**目标：** 推送后不经人手得到编译、lint、测试结论。

**关键改造：**
1. **平台无关检查上托管 CI。** 在 Linux runner 上跑 `tsc --noEmit`、eslint、`check-repo-hygiene.mjs`、`check-facts-revision.mjs`，以及能在 Linux 通过的单元测试子集。需要给 `run-isolated-node.sh` 之外加一个"非正式证据"的 CI 入口，不要求冻结 Node；它的定位和 README 里"`npm run` 是可信环境下的快捷入口"一致。
2. **先量再定范围。** 第一次 CI 运行的任务就是量出 1665 个 dist 测试里有多少在 Linux 通过，把不通过的按文件列入 `mac-only` 清单。
3. **Mac 门自动执行。** 在 Mac 上用 launchd 起一个轮询脚本（或自托管 runner）：发现约定前缀分支的新 HEAD 就跑 `gate:pr`，结果写到独立的 `gate-results` 分支或提交状态，并用现有的 `notify_mac_result` 发通知。`long-running-validation.md` 里的 `status.json` / `result.json` 约定可以直接复用。
4. **门禁结果不再进主分支。** 结果 JSON 留在 `gate-results` 分支或 CI 产物里，PR 描述引用它。

**退出标准：**
- 推送到拿到 Linux 检查结论 ≤ 10 分钟，到拿到 Mac `gate:pr` 结论 ≤ 20 分钟，全程无人工操作。
- 连续 10 个分支没有"Mac 门因编译错误失败"的情况。
- 主分支上"record … Mac gate"类提交降为 0。

**风险与回滚：**
- 自托管 runner 接在公开仓库上有被 fork PR 触发的风险。用轮询脚本、只认所有者推送的分支可以避开。
- Mac 门与在线 daemon 争资源。现有隔离 harness 和"fixture 全机最多 2 个、只用 `:38457`"的边界继续适用，轮询脚本串行执行。
- 回滚：停掉 launchd job 和 CI 配置，回到现在的手工流程，无数据影响。

**验证位置与执行者：** Linux 检查在托管 runner 上自动跑；Mac 门由 Mac 上的轮询 job 自动跑；所有者只做一次性的 job 安装。

**维护负担：** 一次性约 2–3 天；之后每个改动省掉一次人工往返。这是全表里回报最高的一项。

### 阶段 1：上线与可观测闭环（约 2–4 周，部分需所有者动手）

**目标：** ILV2 是日常在用的构建，并且有 30 天真实使用数据。

**关键改造：**
1. **澄清并完成部署。** 确认当前安装的构建；若不是 ILV2，完成切换（含 TCC 责任进程那条开放决定）。安装时写一份回执（tag、digest、时间），`java_status` 读它。
2. **`javactl stats`。** 读遥测 JSONL，输出每工具每操作的调用数、成功率、p50/p95、错误码分布、NOT_READY / INDEX_PARTIAL 占比、冷路径占比。见 §6。
3. **`javactl doctor`。** 一条命令检查常见故障面。见 §6。
4. **补齐三类记录：** 把现有 `owner-telemetry.ts` 开放到生产（见 §6.1）、日志轮转、把已有的 `requestId` 写进日志行和遥测行。
5. **版本化。** 引入 semver、CHANGELOG、发布 tag；发布脚本固定为"门通过 → 打 tag → 安装 → smoke → 回滚演练一次"。
6. **失败案例台账。** 日常使用中工具给错、给空、太慢的情况，记一行（日期、工具、现象、是否有绕过方法）。这就是 `decisions.md` 里反复提到却一直没有的"日常失败案例"。

**退出标准：**
- `doctor` 报出的安装 digest 与某个 git tag 一致。
- 有连续 30 天的遥测；`stats` 能回答"每周每工具调用几次、成功率、p95"。
- 回滚演练成功一次并有记录。
- 架构评审里"等数据再决定"的 F4、F5 两项，有数据并已给出处理或关闭结论。

**风险与回滚：** 切换生产是本阶段唯一有风险的动作，按 HANDOFF 的边界需所有者单独批准；旧 runtime、cache、state 保留，`rollback-release` 可回。可观测部分是纯新增的只读代码，可随时移除。

**验证位置与执行者：** `stats`、`doctor` 的单元测试进阶段 0 的自动门；部署切换、回滚演练、TCC 授权只能由所有者在 Mac 上做；30 天数据由日常使用自然产生。

**分支：** 如果第 1 项确认 ILV2 已经在用，本阶段直接从第 2 项开始；如果还在旧版本上，第 1 项是本阶段的全部前置，其余顺延。

**维护负担：** 新增约 500–800 行脚本和少量 `src` 改动；换来以后每个"要不要做"的问题有数据可查。

### 阶段 2：减法（约 4–8 周，可与阶段 1 交叠）

**目标：** 把常驻维护面缩到和实际使用匹配。

**关键改造（按风险从低到高）：**
1. **证据归档移出主仓库。** `artifacts/`、`docs/phase-*`、`docs/deep`（除 `ilv2-mac-manual/`）、`docs/java-specialist-*`、`docs/next-stage`、`docs/index-lifecycle-v2` 的证据文件，迁到独立归档仓库或孤儿分支并打 tag。主仓库先打 tag 再删，引用它们的验证脚本一并归档。
2. **文档收敛为三类。** `docs/architecture.md`（唯一的现行设计，由 `contract.md` 和 README"五层架构"合并精简而来）、`docs/operations.md`、`docs/decisions/`（一条决策一个短文件）。README 只留用户视角的安装、启用、工具用法、排障。修掉 README 指向 `docs/phase-f` 的"现行"链接。
3. **脚本瘦身。** 122 个 `ilv2-*` 一次性门禁脚本和卫生基线里 54 个未引用脚本归档。评测 harness 单独成目录，有自己的测试入口。
4. **删除生产不可达代码。** `sql-client.ts`、`local-builder.ts`、`local-index.ts`、`discovery/query-worker.ts`、`retrieval/` 下三个策略文件、`context-engine/compact-bridge.ts`；`src/benchmark*` 移出 `src/`。台账把其中几个文件标为 `test-only`，意思是仍有测试和离线工具 import 它们，所以删除前要先迁移或删除这些测试，工作量不只是删文件。清理前按架构评审 F13 的提醒，确认 canary 并存时还需要哪些租约。
5. **`kg_*` 定去留。** 用阶段 1 的 round 事件量出图谱在构建时间和 snapshot 体积里的占比；没有排期内的读取方就停止构建，删掉只为它服务的 delta 规则。这同时降低 F2 的风险面。需要提升 `JAVA_FACTS_REVISION` 触发全量重建。
6. **JDT 隔离。** 定义 `SemanticBackend` 接口，把 14 个直接 import 收到一个装配点；不启用时不构造 `JdtlsSession`（架构评审 F3 指出现在未启用的仓库也会构造）。若保留 JDT，在接口后面修 H1、H2。
7. **outline / evidence。** 按已定的 2027-02-13 期限执行，不延期。
8. **大文件只在功能改动触及时拆**（沿用审计建议）。

**退出标准（可度量）：**
- 跟踪文件数从 2937 降到 1000 以下；仓库检出体积下降 80% 以上。
- 生产代码从 56.9k 行降到约 45k 行以下；`src/` 内不再有 benchmark。
- `scripts/` 从 58k 行降到 25k 行以下。
- 静态路径模块对 `jdtls-*`、`semantic-*` 的 import 数为 0（可做成卫生检查）。
- eslint 非空断言基线从 1409 随删除自然下降，用 `lint:prune` 收紧。
- 全量 `npm test` 从约 30 分钟降到 15 分钟以内（目标值，归档脚本测试后实测校准）。
- `check-facts-revision.mjs` 进入自动门，不再靠手动执行。

**验证位置与执行者：** 每个删除或隔离的 PR 过阶段 0 的自动门；`kg_*` 删除和 JDT 隔离另加一次 Mac 全量 `npm test`（自动 job 的 nightly profile）；归档动作由所有者确认后执行，因为涉及仓库历史的可见范围。

**风险与回滚：**
- 归档会断开旧文档的相对链接：先打 tag，归档仓库保留原路径结构。
- 删除 `kg_*` 和死代码是行为不变的重构，但范围大：分多个小 PR，每个过全量 `npm test`；出问题 `git revert`。
- JDT 隔离会碰 `repo-runtime-manager.ts` 的生命周期，是本阶段风险最高的一项，放最后做，且必须先有阶段 0 的自动门。

**维护负担：** 一次性投入最大的阶段，但之后每次阅读、检索、AI 上下文加载的成本持续下降。

### 阶段 3：按证据触发的聚焦深化（持续，可以长期为空）

**目标：** 只在已测出领先的方向上加深，每项由真实失败案例触发。

**候选方向（都不预先承诺）：**
- Spring：装配、路由到 handler、配置属性到使用点。
- DTO / 字段影响：字段到映射、序列化声明、resultMap。
- MyBatis：仅当所有者的真实仓库有 mapper XML（见 §7 第 7 条）。
- 路由引导：在工具描述和 hook 提示里直说"找调用方、实现类用原生搜索或宿主 LSP"，减少误选。这是零代码成本的改动。

**进入规则（沿用 `attribution.md` 的口径）：** 失败案例台账里同一类问题出现在至少 2 个不同任务组；先加回归用例复现，再写实现。

**退出标准（每项）：** 回归用例通过；无模型检索评测相对改动前不变差（配对差值 95% 区间下界 ≥ −5 pp，沿用 D15 的非劣规则）；响应字节 p50 增幅 ≤ 10%。

**风险与回滚：** 每项一个开关都不加，直接改默认路径并靠回归集保护；不达标就整项 revert。

**维护负担：** 每项都增加长期负担，所以门槛要高。一年做 2–3 项是合理的量。

### 阶段 4：维护模式（定义清楚，随时可进入）

- 每月：依赖更新（tree-sitter、MCP SDK、Node LTS），跑全量门，看一次 `stats`。
- 每季度：一次升级加回滚演练；一次 full-vs-delta 对照；macOS 大版本升级后重跑受影响的门。
- 触发退出维护模式的条件只有两个：台账里出现达标的失败案例，或上游变化（MCP 协议、macOS、宿主工具）破坏了现有功能。
- 预算：每月 2–4 小时。

---

## 6. 可观测性与质量体系的具体设计

### 6.1 指标

全部本地，不外发。沿用现有"绝不记录源码文本"的规则。

| 类别 | 指标 | 来源 | 现状 |
|---|---|---|---|
| 请求 | 每工具每 operation 的调用数、ok、errorCode、耗时 | `impact-telemetry.ts` | 已有 |
| 请求 | 响应字节、`indexView.state`（FRESH/STALE/NOT_READY）、`scopeState`、排队等待毫秒、semanticPolicy 实际走向 | 同上，加字段 | 缺 |
| 索引 | 每轮 round：模式（delta/full/noop）、`fullReason`、耗时；调度、进程池、GC、builder 存活事件 | `owner-telemetry.ts` 的 owner 事件 | 已实现，仅隔离验证下开启 |
| 索引 | 变更文件数、snapshot 字节、`deltaDepth`；编辑到 FRESH 的延迟；verifier 结论和耗时；周期全量 hash 的次数和耗时 | owner 事件加字段（先核对现有事件已带哪些） | 部分或缺，未逐字段核对 |
| 进程池 | `queueFull`、`runKills`、worker 重启数 | `query-pool.ts` 的 `counters()` | 已有，只在 status |
| 进程 | 启动时间、launchd 重启次数、crash marker 按事件计数、unhandledRejection 累计 | crash markers | 已有，只在日志 |
| 进程 | RSS、堆、CPU、GC 暂停、事件循环延迟 | `owner-telemetry.ts` 的 `process` 样本（现为 5 秒一条） | 已实现，仅隔离验证下开启 |
| 磁盘 | cache base 总字节、snapshot 数、GC 回收量、janitor 的 `unrecognizedDirs` | janitor、GC | 部分 |
| 文件事件 | FSEvents drop 次数、重扫次数 | helper | 未核对 |

**最省事的一步是把 `owner-telemetry.ts` 开放到生产，而不是新写一套。** 需要的改动：
- 去掉"仅隔离验证"的门，改为默认开启、可用环境变量关闭；写到 cache base 的 `telemetry/owner-YYYYMMDD.jsonl`，沿用 30 天清理。
- 生产采样间隔从 5 秒放宽到 60 秒；CPU profile 仍保持只在显式诊断时开启（文件头已说明重启 profiler 本身会卡住 owner）。
- 只记录、不设阈值，与"不新增 heap/RSS 杀进程阈值"的现行决定一致。
- 这是对 AGENTS.md"测试或验证专用行为默认关闭"的一次有意变更：它从验证专用变成产品行为，需要所有者确认。

事件循环延迟这一项专门对应架构评审 F3 那一类问题（同步子进程阻塞 owner）。在生产里开着，这类问题会在数据里自己冒出来，不必再靠读代码找。

### 6.2 日志

- 一行一个 JSON：`ts`、`level`、`requestId`、`tool`、`repoHash`、`event`、`code`、`elapsedMs`。`requestId` 用 `request-context.ts` 已生成的那个，写进日志行和工具遥测行，并随请求传到查询子进程。
- 轮转：launchd 不轮转 `StandardErrorPath`。单文件 10 MB、保留 5 个；用 `newsyslog` 配置或让 daemon 自己写滚动文件，由安装器落地。
- owner 事件单独一个 JSONL（见 6.1），和工具遥测同目录、同 30 天保留。
- crash marker 格式不变，`stats` 负责从日志里计数。

### 6.3 诊断命令

合并现有的 `daemonctl.sh` 和 `check-codex-mcp.sh`，对外一个入口：

- **`javactl doctor`**，逐项输出 PASS / FAIL 和下一步：
  - launchd job 状态、最近一次退出码、近 24 小时重启次数。
  - launcher 签名身份、owner 锁持有者是否是当前 daemon。
  - 端口与 instance id 是否匹配；运行中的 build digest 是否等于 `current` release，是否对应一个 git tag。
  - 冻结 Node 版本、cache base 是否通过 `unsafeCacheBase` 检查、剩余磁盘。
  - `projects.json` 里登记的每个仓库：路径存在、可读（TCC）、索引状态、最近一轮 round 结果。
  - 遥测目录可写；最近一条 crash marker。
- **`javactl stats [--since 7d]`**：§6.1 的请求类和索引类指标的汇总表，另列出最慢的 10 次调用和按错误码的计数。
- **`javactl trace <requestId>`**：把一次请求在 relay、owner、查询子进程的日志行按时间拼起来。
- **`javactl bundle`**：打包脱敏后的状态、近 24 小时日志和遥测，供事后排查。

### 6.4 SLO 级自检

单用户的 SLO 不需要告警系统，需要的是 `stats` 末尾的一段"达标 / 不达标"。初值是占位，跑满 30 天后用实测分布重定。

| SLO | 口径 | 初值（待 30 天数据校准） |
|---|---|---|
| 可用 | Mac 唤醒期间 `/readyz` 就绪时间占比 | ≥ 99% |
| 静态查询延迟 | `java_symbol` query 热态 p95 | ≤ 300 ms |
| 影响分析延迟 | `java_impact`（`semanticPolicy=fast`）p95 | ≤ 2 s |
| 新鲜度 | 编辑到 FRESH 的 p95（delta） | ≤ 5 s |
| 降级率 | 冷启动 3 分钟之后 INDEX_PARTIAL + NOT_READY 占调用比例 | ≤ 2% |
| 稳定 | 每周 uncaughtException 次数 | 0 |
| 正确性 | 每周一次 pin 仓库的 full-vs-delta `logicalDigest` 对照 | 0 次不一致 |

最后一行是架构评审 F2 里"未做"的那一项的廉价版本：不放进 daemon，而是由一个每周跑一次的离线脚本做（`scripts/ilv2-mac-full-delta.mjs` 已有对照口径）。不一致时触发一次全量并记入台账。

另加一个**合成探针**：每次升级后及每天一次，对仓库自带的 fixture 仓库跑固定的几条查询，结果与 golden 比对。它用来发现"升级后悄悄变差"，现有的 `smoke` 只验证能通。

### 6.5 回归评测集的维护

三层，频率和成本递减：

| 层 | 内容 | 何时跑 | 判定 |
|---|---|---|---|
| A 确定性回归 | `fixtures/`、`golden/` 上的固定查询：给定输入，期望的 `symbolId`、readPlan 文件集合、状态标签。无模型 | 每个 PR，进 `gate:pr`，目标 < 2 分钟 | 精确匹配，失败即拦 |
| B 无模型检索评测 | `mac10-v3` 全集（含已暴露的 holdout，统一当回归集）对 native-rg 配对，按类别出表 | 发布前在 Mac 上跑 | 非劣：总体配对差值 95% 区间下界 ≥ −5 pp；记录趋势 |
| C 真实 Agent 配对 | 现有 live harness | 只在有预注册的候选改动、且样本量算过功效时 | 预注册规则 |

维护规则：
- **入库只走一条路：** 失败案例台账里的每个已修问题，在同一个 PR 里往 A 层加一条最小用例。A 层因此只增不减，且每条都有来历。
- **B 层不再扩题，除非换仓库。** 现在的 50 题来自 3 个仓库，继续在同一批仓库上加题收益很低。若所有者的日常仓库与这 3 个不同，优先把日常仓库的 10–20 个真实问题加进来。
- **数据集身份：** 保留现有的 digest 和私有工作根做法；gold 不进主仓库。
- **封存集 v2：** 维持"延后"的决定。只有当 C 层实验确定要做时才冻结新集。
- **评测协议：** 冻结在 v1.8，不再出新版本，直到有 C 层实验。

---

## 7. 需要所有者决策的问题

每条给推荐和理由。前三条决定路线图的起点。

1. **现在日常在用的是哪个构建？**
   - 推荐：阶段 1 内把 ILV2 变成日常构建；如果切换成本或 TCC 问题让它迟迟上不了线，就明确承认并回退到上一个可用版本，把 ILV2 当成未完成项。
   - 理由：仓库里部署状态是"用户报告"加 `installedDigest=null`。没有在用的构建，遥测、SLO、失败台账都无从谈起。

2. **开发与验证环境怎么配？**
   - 选项：A 维持现状；B 托管 Linux CI 加 Mac 自动门（阶段 0）；C 把写代码的会话直接搬到 Mac 或一台内存 ≥ 8 GB 的机器。
   - 推荐：B，条件允许再加 C。
   - 理由：现在一行 import 错误要走一次人工往返。B 不改变所有者的习惯，成本几天。

3. **JDT 路径的去留？**
   - 选项：A 原样保留并修 H1、H2；B 隔离为可选插件，静态路径零依赖，接口后面再修 H1、H2；C 删除，精确语义交给宿主 LSP 或 IDE。
   - 推荐：现在做 B；阶段 1 的遥测跑满 3 个月后，若 JDT 类调用每月不到个位数，转 C。
   - 理由：所有者几乎不用；10%–13% 的生产代码、两个暂缓的 High、对 JDT LS 上游升级的持续跟进。Claude Code 已有官方 `jdtls-lsp`。
   - 连带决定：选 C 会让 `java_diagnostics`、`java_runtime` 以及 `java_symbol` 的 position、references 消失，与 AGENTS.md"公共工具面固定 5 个"冲突，需要所有者明确同意把工具面降到 3 个。

4. **主要宿主是 Codex 还是 Claude Code？**
   - 推荐：把 MCP 表面当作宿主无关来维护，smoke 在两个宿主上各过一次；hook 和引导文本按宿主分开放。
   - 理由：项目名、hook、安装脚本都绑在 Codex 上；而第 3 条里 JDT 的替代方案在 Claude Code 上最现成。Codex 当前是否有内置 LSP 我没能核实，这会影响 C 选项在 Codex 下是否成立。

5. **历史证据是否移出主仓库？**
   - 推荐：移到独立归档仓库（或孤儿分支）并打 tag，主仓库删除。
   - 理由：`docs/` 与 `artifacts/` 合计占跟踪文件的 71%，是 AI 会话读到过时内容的主要来源。审计 E1 当时选了"认定为冻结证据留在原地"，那是为了不断证据链；归档仓库同样不断链。

6. **`kg_*` 知识图谱删不删？**
   - 推荐：量一次占比，然后删，除非所有者能说出一个排期内的读取方。
   - 理由：架构评审 F8 已指出没有产品读取方；schema 里有删除 `kg_summary` 的先例；它还扩大了 delta 规则的风险面。

7. **所有者真实工作的仓库用不用 MyBatis？规模多大？**
   - 推荐：用的话，把 1–2 个真实仓库的 mapper 问题加进 B 层回归集；不用的话，MyBatis 提取降级为"保持不坏"，不再投入。
   - 理由：三个冻结语料里 0 条 mapper 语句，这块能力从未被评测覆盖。

8. **是否接受"窄定位"？**
   - 推荐：接受。对外描述改成"Java 结构事实与框架关系"，并在工具描述里把调用方、实现类导向原生搜索或 LSP。
   - 理由：这是评测数据和外部生态共同指向的位置；S2、S3 的关闭已经是事实上的选择，只差说出来。

9. **评测投入上限？**
   - 推荐：常规只跑 A、B 两层；C 层每年至多一次，且事先算功效。总投入不超过项目时间的两成。
   - 理由：`scripts/` 已与生产代码等大；Q10 的样本量无法得出结论。

10. **是否打算让别人安装使用？**
    - 推荐：明确为"否"，并据此保持所有单用户简化（不做鉴权、不做跨平台、不做兼容承诺）。若为"是"，那是另一个项目规模，需要重新规划安装、文档和支持。
    - 理由：README 带着开源徽章和贡献规范，而所有运行边界都是单人单机。两种定位的文档和发布要求差别很大，现在是混着的。

---

## 附：验证状态与未覆盖

- **已做：** 文件与 git 历史的只读统计；仓库内结果 JSON 的读取；外部十余个一手页面的抓取。
- **未运行：** 编译、测试、lint、任何产品或评测命令。文中所有耗时、通过数均引自仓库内已提交的 Mac 结果。
- **未核实、已在文中标注：** 当前部署身份；Linux 上可通过的测试比例；Codex CLI 的 LSP 现状；Serena 的 Java 后端细节；Cursor 语义索引的现状；除 JavaLens 外的其他 JDT 封装项目；仓库是否公开；`owner-telemetry.ts` 现有事件逐字段带了哪些信息。
- **任务列出但未调研：** Continue 的上下文引擎；Sourcegraph SCIP 协议本身（只看了 scip-java）。
- **未深读：** `native/` 下的 C 代码、`install-runtime.sh` 的分支细节、`agent-router` 的排序算法与阈值、`jdtls-lsp-io.ts` 的协议细节。本报告关于它们的判断只到结构层面。
- **阶段工期：** 均为我的估计，没有依据历史速度校准。

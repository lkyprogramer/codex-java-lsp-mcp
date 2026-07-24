# V3 架构战略与执行计划的深度 Review 报告（含多 worktree 并发专项）

> Review 日期：2026-07-23
> Review 对象：
> - `codex-java-lsp-mcp-java-only-architecture-strategy-v3-2026-07-23.md`（下称「架构 V3」，2,559 行）
> - `codex-java-lsp-mcp-java-only-development-execution-plan-v3-2026-07-23.md`（下称「执行计划 V3」，8,725 行）
>
> 前序文档：`codex-java-lsp-mcp-deep-plan-review-2026-07-23.md`（上一轮 review，本轮验证其意见的吸收情况）
> 核查基线：`main` HEAD `af51bc7`；上一轮已完成的代码事实核查结论本轮直接引用。
> 本轮实际执行的验证：两份文档全文审阅；执行计划关键任务（Task 0/1/3/4/9/10/11/20/21/22 及第 8~11 章）精读；5 个 pin 依赖版本经 `npm view` 实测确认全部真实且为当前最新（chokidar 5.0.0、tree-sitter 0.25.0、tree-sitter-java 0.23.5、web-tree-sitter 0.26.11、fast-xml-parser 5.10.1）；当前代码的 worktree 机制（`repo-resolver.ts`、`worktree-cache-cleanup.ts`、`jdtls-session.ts` dataDir、`resource-defaults.ts`）逐段复核。

---

## 1. 结论速览

1. **两份文档整体质量高，可以作为权威路线接受。** 上一轮 review 的全部实质性意见都被正确吸收（第 2.1 节逐条核对表），且在若干处超出了我上轮的建议深度（UTF-8/UTF-16 坐标契约、内容指纹 buildFingerprint、coverage 增量 promote、edge store 收敛为 complete-only exact store）。执行计划的 TDD 纪律、追踪矩阵和依赖版本 pin 的准确性都达到了可直接交给 agent 执行的水准。
2. **最大的缺口正是你本轮新提的场景：同一 repo 多个 worktree 并发开发。** 两份文档对此几乎零覆盖——架构 V3 全文只有一句"repo/worktree identity 以 canonical root 为核心"，执行计划里的 worktree 仅指"开发本项目时用 worktree 隔离分支"。该场景下有一个**跨进程正确性问题**（每个 Codex 会话一个 MCP 进程，admission 只在进程内生效，同 worktree 双进程还会撞 JDT workspace 锁）和一个**效率乘法问题**（新 worktree 冷启动全量重建索引、N 份近乎相同的内存索引、并发 sweep 抢 CPU），需要新增一组任务（第 4 节给出 W-1~W-6 具体设计与插入位置）。
3. **文档存在约 10 处需要修订的技术细节**（第 5 节编号清单），最重要的三处：BROKEN 状态无退避会在 Iteration A~D 期间造成 JDT 重启风暴（架构 §19.6 与执行计划 Task 3/33 的时序矛盾）；watcher ready barrier 在执行计划里被无条件化，大仓库首请求会被 chokidar 初扫阻塞数秒；snapshot 的 `indexedGeneration` 与进程内从 1 起步的 GenerationClock 之间缺少 rebase 规则，导致每次进程重启后负缓存长期失效。
4. **裁决：接受两份文档为基线，按第 5 节修订清单打补丁，并把第 4 节的 worktree 任务包插入执行计划**（W-1/W-3/W-6 挂在 Iteration B 之后，W-2/W-4/W-5 融入 Iteration C）。不需要推翻任何已有 ADR。

---

## 2. 架构 V3 评审

### 2.1 对上一轮 review 意见的吸收核对

上一轮 review 第 5、6 节的每条裁决在 V3 中的落点（✓=完整吸收，✓+=吸收且深化）：

| 上轮意见 | V3 落点 | 状态 |
|---|---|---|
| 方案一废弃、方案二裁剪 | 文档关系声明 + §20 逐条裁决表 | ✓ |
| 基线过时，开发前先对齐 | 执行计划 Task 0（含 source map、P0 复核、benchmark 冻结） | ✓+ |
| 5 态状态机替代 9 态 | §11.1~11.3（lifecycle 与 readiness 分离） | ✓+ |
| STARTING 计入 active slot | 执行计划 Task 4（FIFO waiter、grant 前先记账） | ✓+ |
| partial 一律不写 cache | §7.3 Completion + Task 5 | ✓ |
| LSP location containment | §15.5（externalSemanticHits 计数替代绝对路径） | ✓+ |
| 绝对 deadline 预算 | §7.2 DeadlineBudget + Task 1 | ✓ |
| 错误分类 + stderr 降噪 | §7.4 | ✓ |
| LSP 无关 watcher + 单调 generation | §8 + Task 9/10（flushNow 前置、dirty CAS、pending 合并表） | ✓+ |
| delete/rename 驱逐、layout 重探 | §8.5 + Task 11 | ✓ |
| O-01/O-02（context 回收、config LKG） | Task 12 | ✓ |
| tree-sitter 替换 regex | §9（含 §9.2.1 四方案对比与触发条件） | ✓+ |
| FQN 解析 + coverage + COMPLETE 才负缓存 | §9.8~9.10 | ✓+ |
| 原子快照替代 JSONL、不做 SQLite | §9.12 + ADR-004（含 100MiB 重评阈值） | ✓ |
| 证据家族饱和替代裸加法 | §12.4（含 completeness/freshness 系数） | ✓+ |
| references 价值排序后截断 | §11.10（含 5000 raw location 上限） | ✓+ |
| Spring/MyBatis/JPA pack | §13（依赖/注解触发、独立 attribution） | ✓ |
| readPlan byte 预算 + 多 range | §14（greedy 边际效用、AST read window） | ✓+ |
| benchmark 裁剪至 3~5 仓 + holdout | §16.1（24~36 场景，holdout 只跑不调） | ✓ |
| 单一迁移开关 + git revert | §19.2 + Task 22 Step 7（`JAVA_LSP_INDEX_BACKEND` 仅存活一个 commit） | ✓+ |
| warm-required 数据驱动、允许不默认化 | §17 Stage 5 + Task 35（`KEEP_EXPLICIT` 是合法结论） | ✓ |
| 无兼容约束：缓存换代、强类型、死代码清理 | Task 21 Step 7 / Task 31 / Task 36 | ✓ |
| edge store 保留而非重写丢弃 | §11.6 PersistedSemanticEdgeStore（complete-only、依赖指纹、独立小快照） | ✓+ |

没有发现任何一条上轮意见被曲解或悄悄丢弃。§1.2 对"Review 基线与可见源码压缩包版本不一致"的处理（以 Review 为主证据 + Task 0 强制重对齐 + 禁止按旧路径覆盖新拆分实现）是诚实且正确的。

### 2.2 超出上轮建议的正确决策（值得点名保留）

1. **§9.5 统一坐标契约**：Tree-sitter 的 position 是 UTF-8 byte 语义，LSP 是 UTF-16 code unit，这是集成 tree-sitter 最常见的隐性 bug 源。文档在架构层就钉死了"byte 坐标只存在于 worker parser 层，经 `Utf8Source` 换算后才能出去"，并配了执行计划的测试要求。
2. **§9.12 内容指纹 buildFingerprint**：不用 mtime 拼接而用 build 文件内容 SHA-256——顺带对 worktree 场景意外友好（`git worktree add` 后所有文件 mtime 全新，mtime 方案会误判 snapshot 失效，内容指纹不会）。
3. **§9.10 coverage 增量 promote**：健康 watcher 下的增量批次可把 COMPLETE 直接推进到新 generation，避免"每次保存重跑 full sweep"——这是对负缓存可用性的关键补丁。
4. **§9.3.1 parse-tree LRU 带 25% 变更比例阈值**：增量 parse 只用于小改动，杜绝把全仓 AST 常驻内存。
5. **对比项目的源码级借鉴**（§3.1）：negative memo 只在 registry sealed 后启用、直接命中先于负缓存检查——这两条来自 codebase-memory-mcp 的 C 实现细节，正是本项目 coverage 模型的独立佐证。
6. **执行计划 §8.1 追踪矩阵**：上轮 review 的每个问题 ID 映射到任务 + 验收证据，并声明"只有测试/产物能关闭条目，代码审阅不能"。

### 2.3 架构层问题与风险

见第 5 节编号清单（A-1 ~ A-5）。没有方向性错误；全部是可以打补丁的一致性/细节问题。**结构性缺口只有一个：多 worktree 并发场景（第 4 节专项）。**

---

## 3. 执行计划 V3 评审

### 3.1 可执行性评估

**结论：可执行性是我审阅过的同类计划中最高的一档。** 依据：

- 36 个任务全部遵循「写失败测试 → 确认失败 → 最小实现 → 定向测试 → 全量测试 → commit」循环，且失败测试的断言是具体可判定的（如"两个并发 `ensureStarted` 只 spawn 一次且 initialize 前无请求越过"）。
- 关键实现直接给出参考代码形态（Task 3 的 `startTransactional`、Task 4 的 FIFO waiter、Task 9 的 flush singleflight、Task 21 的原子写含 fsync 与 hook 注入），并明确标注了最容易写错的点（`child.killed` 不等于进程已退出；waiter grant 必须先记账再 resolve；`beforeRename` hook 禁止生产使用）。
- 迁移与删除路径明确（§2.1 删除清单 + Task 22 Step 7 唯一开关 + Task 36 收敛），符合"无兼容性约束"的授权。
- 失败降级路径均有定义（真实仓库不可用时 Task 0 如何降级、reconcile 失败时 dirty 保持 + DEGRADED 输出、tree-sitter native 失败时 WASM 唯一备选）。
- 第 9 章 AI 执行规则和第 11 章 handoff（每任务一个子代理 + 门禁串行）与文档体量匹配。

**已实测验证的事实**：技术栈 5 个精确版本 pin 全部真实存在且为 npm 当前最新版（本轮 `npm view` 实测）。这消除了"AI 生成计划常见的幻觉版本号"风险。

### 3.2 执行计划问题

见第 5 节编号清单（E-1 ~ E-7）。均为可修补细节，不阻塞开始执行；其中 E-1（backoff 时序）和 E-3（ready barrier）建议在开工前先改文档。

---

## 4. 多 worktree 并发专项分析（核心新增要求）

### 4.1 场景定义与当前机制的代码事实

目标场景：同一个 Java repo 的多个 Git worktree（如 `repo/`、`repo-wt-task1/`、`repo-wt-task2/`）同时被不同的 agent 会话开发修改；要求每个 worktree 的索引/召回高质量且互不污染，同时全机资源可控。

当前代码的相关机制（HEAD `af51bc7` 复核）：

| 机制 | 位置 | 行为 |
|---|---|---|
| worktree 身份 | `repo-layout.ts` `repoCacheRoot()` | cache 目录 = `sha1(绝对路径)`，每个 worktree 完全独立的 SourceIndex/snapshot/logs |
| JDT workspace | `jdtls-session.ts:162` | `dataDir = cacheRoot/workspace`，按 worktree 独立 |
| LSP enablement 继承 | `repo-resolver.ts:71-88` | 同 Git `common-dir` 的 worktree 继承 `lspEnabled`；多 alias 冲突时显式报 conflict |
| 缓存回收 | `worktree-cache-cleanup.ts` | 启动时清理超过 TTL（默认 2 天）的 linked worktree 缓存，检查 `jdtlsPid` 活性 |
| 资源上限 | `resource-defaults.ts` | 32GB 机器 `maxActiveRepos=3`、Xmx 2g —— **仅进程内生效** |

### 4.2 V3 文档的覆盖情况

- 架构 V3：全文唯一相关表述是 §4.1 的"repo/worktree identity 以 canonical root 为核心；这些都应保留"。§0.1 的产品定义甚至写的是"**在一个 Java 仓库内**"。
- 执行计划 V3：`worktree` 三次出现全部指"开发本项目时用 worktree 隔离分支"（Task 0 Step 1/2）。
- 两份文档的 RepoRuntime、admission、snapshot、edge store、janitor 设计均以"单进程、若干独立 repo"为隐含模型，没有任何 family（同 common-dir 的 worktree 集合）级别的语义。

**判定：该场景是 V3 的结构性盲区，需要补设计，但不需要推翻 V3 的任何已有决策**——per-worktree 隔离恰好是正确性的正确起点，缺的是 family 级的资源协调和冷启动复用。

### 4.3 正确性分析

**V3 设计下天然安全的部分**（单进程内）：

- 每 worktree 独立 RepoRuntime/GenerationClock/watcher/JavaIndex worker/JDT workspace/snapshot —— 不同 worktree 的索引与缓存零共享，分支差异不会互相污染。这是隔离优先设计的直接收益，应在架构文档中明文声明为不变量。
- rg/index/semantic cache key 均含 repoHash（路径哈希），worktree 间不可能串 key。
- admission 把 STARTING+READY 计入 active（Task 4），单进程内多 worktree 争 JDT slot 是公平且有界的。

**不安全或未定义的部分**：

- **W-1（跨进程 admission 失效，严重度：高）**。每个 Codex 会话 spawn 一个独立的 MCP server 进程（stdio transport）。多 worktree 并发开发的常态就是多进程：
  - 不同 worktree、N 个进程：每个进程各自认为自己有 `maxActiveRepos=3` 的额度 → 全机 JDT LS 数量上限实际是 `3N`。4 个并发会话就可能 8+ 个 2g Xmx 的 JVM，32GB 机器直接进入 swap——admission 模型完全旁路。
  - 同一 worktree、2 个进程（同目录开两个会话，或会话 + benchmark 并行）：两个进程共享同一个 `dataDir=cacheRoot/workspace` → Eclipse workspace 有实例锁，第二个 JDT LS 启动失败或行为未定义；V3 的 5 态机会把它归为 BROKEN，但根因是身份设计而非进程故障。snapshot 原子 rename 在双进程下不会损坏但会互相覆盖（last-writer-wins，丢工作不丢正确性——generation 校验会拒绝跨进程混用，见 W-5）。
- **W-5（snapshot generation rebase 缺失，严重度：中）**。架构 §8.3 明确"generation 是进程内单调序号，不要求跨进程持久"，而 snapshot 携带 `indexedGeneration`、coverage 携带 `generation`，`canAnswerNegative` 要求 `coverage.generation === query generation`。新进程 clock 从 1 起步，加载旧 snapshot 后该等式永远不成立——**安全方向正确（不会误用陈旧负缓存），但每次进程重启/新会话都要等 full sweep 重新完成才恢复负缓存与 COMPLETE 语义**。多 worktree 多进程场景把这个成本乘以会话数。两份文档均未写加载时的 rebase 规则。

### 4.4 效率分析（资源乘法）

以"32GB 机器、一个 ~5000 Java 文件的 repo、3 个并发 worktree 会话"为参照：

| 资源 | V3 单 worktree 设计 | ×3 worktree 后 | 问题 |
|---|---|---:|---|
| JavaIndex worker 线程 | 1 | 3 | 可接受 |
| parse-tree LRU | ≤64MiB source bytes | ≤192MiB | 可接受但应随 runtime 数下调 |
| 内存 normalized index | 全仓 facts/edges | ×3 份 ~99% 相同内容 | 浪费但不致命；不建议共享（复杂度不值） |
| **冷启动 full sweep** | 全仓 parse 一次 | **每个新 worktree 从零重跑** | **最大浪费点：分支间通常只差几十个文件** |
| **JDT LS 实例** | ≤3（进程内） | **跨进程无上限** | W-1 |
| JDT workspace import | 每 workspace 一次完整 Maven/Gradle model 构建 | 每个新 worktree 重新 import（分钟级） | 无法共享（-data 唯一性），只能靠调度缓解 |
| chokidar watcher | 1 | 3 | 可接受；风暴期见 W-3 |
| 并发 background sweep | 1 | 3 个同时抢 CPU | 无全局节流 |

### 4.5 设计建议（W-1 ~ W-6）

以下建议全部遵循 V3 自己的架构原则（§5.4 不为未来规模预付复杂度；单机、个人项目），不引入 daemon、不引入共享内存索引。

#### W-1：跨进程 JDT admission lease（正确性，必须做）

在 `repoCacheBase()` 下建全局 lease 目录，JDT 启动前取文件锁槽位：

```text
~/Library/Caches/codex-java-lsp/jdt-leases/<repoHash>.json
  { pid, repoRoot, acquiredAt, heartbeatAt }
```

规则：
- 全局槽位数 = 现 `maxActiveRepos`（跨进程共享同一预算，而非每进程一份）；
- 取槽 = 原子创建 lease 文件（`wx` flag）；槽满时枚举现有 lease，`process.kill(pid, 0)` 检查活性 + heartbeat 超时（如 5 分钟）判死，可回收死 lease；
- 持有期间每次 JDT 请求顺带 touch heartbeat（复用现有 `touchRepoCache` 机制——`repo-meta.json` 已经在写 `jdtlsPid`，这是自然扩展）；
- **同 worktree 已有活 lease（其他进程持有）时，本进程不再启动第二个 JDT**：required 请求返回明确的 `JDT_BUSY_OTHER_SESSION` 降级（fast/auto 冷路径不受影响）。这同时解决 workspace 锁冲突。
- 进程退出清理自己的 lease（`exit` handler + 下次启动的死锁回收兜底）。

规模：~120 行 + 测试。不需要 daemon、不需要 IPC。

#### W-2：兄弟 worktree snapshot seeding（效率，收益最大）

现状问题：架构 §9.12 校验规则"canonical root mismatch: 拒绝加载"把最廉价的 worktree 优化明确堵死了。新 worktree 的 repoHash 是新的 → 无 snapshot → 全量 sweep，而兄弟 worktree 已有 99% 相同的索引。

建议增加显式的 **seed 模式**（与常规加载严格区分）：

1. OPEN 发现本 worktree 无 snapshot 时，经 `git rev-parse --git-common-dir` 找同 family 的兄弟 worktree（`repo-resolver.ts` 已有此逻辑），定位其 snapshot；
2. 校验 `schemaVersion / extractorVersion / buildFingerprint` 一致（buildFingerprint 是内容指纹，跨 worktree 天然可比——V3 自己的设计使 seeding 成为可能）；
3. 以 seed 模式加载：facts 按 `relativePath` 重绑到本 worktree 根；**所有 root 强制 DEGRADED/BUILDING**（负缓存自动禁用，正确性零风险）；
4. anchor 文件照常 foreground refresh（mtime/size/contentHash 校验，不符即重 parse）；
5. background reconcile 只需对账 manifest + 逐文件指纹比对，分支差异文件（通常几十个）重 parse，其余直接 promote；
6. reconcile 完成后该 worktree 获得自己的 COMPLETE coverage 和自己的 snapshot。

**前置约束（需要写进执行计划 Task 15/19）**：`fileId/typeId/methodId` 的生成必须基于 `relativePath` 而非绝对路径，否则 seed 重绑变成全量重写。这是一行设计决定，现在定成本为零，事后改成本很高。

收益：新 worktree 的首个 `java_impact` 从"结构证据几乎为零 + rg 兜底"变成"接近满血索引"；全量 sweep（数千文件 parse）变成 delta reconcile（数十文件）。这是对"多 worktree 并发任务高效索引召回"诉求的直接回答。

同理可选（优先级低）：`SemanticEdgeStoreV2` 的依赖已是 `{file, fingerprint}` 内容指纹，兄弟 worktree 的 JDT exact edge 在指纹全部匹配时理论上可 seed 采纳；建议标注为 Stage 5 之后的可选实验，第一版不做。

#### W-3：branch-switch/rebase 风暴治理（效率+稳定）

`git switch`/rebase 一次 touch 数百至数千文件。V3 现设计：watcher change 一律 priority 0（Task 20 Step 4）→ 风暴时 foreground 队列被灌满，anchor refresh 排队，请求延迟不可控。

建议：
- flush batch 大小超过阈值（如 100 文件）时，整批降级为 background reconcile，受影响 root 置 BUILDING；请求路径的 anchor 文件仍走 `ensureFresh` foreground（这条路径本来就存在，Task 22 Step 3）；
- `isIgnoredPath` 的规格必须显式覆盖：`.git`（**linked worktree 下它是一个文件**，指向 common-dir，chokidar 会对它发 change 事件）、common git dir 路径、`.gradle/build/target/out/node_modules`。执行计划目前只给了函数名没给定义，这是必须补的规格；
- 风暴期间的请求按既有 `changedDuringRequest` + DEGRADED 语义降级，无需新机制。

#### W-4：family 级后台资源节流（效率）

- 全局 background sweep 并发上限 1~2：进程内一个简单 semaphore；跨进程复用 W-1 的 lease 目录再加一个 `sweep-leases/`（同样的活性检查逻辑，~30 行增量）；
- parse-tree LRU 的 `maxSourceBytes` 按活跃 runtime 数动态折半（3 个 worktree 时每个 ~21MiB），一行策略；
- **明确不做**：跨 worktree 共享内存索引、共享 worker——复杂度与收益不成比（snapshot seeding 已消掉冷启动大头，稳态内存 3 份 facts 在数千文件规模下各 ~几十 MiB，可承受）。

#### W-5：snapshot generation rebase 规则（正确性细节）

在 Task 20/21 补一条：OPEN 校验通过后，`GenerationClock` 初始化为 `snapshot.indexedGeneration`（而非 1），coverage 保持原 generation；随后的验证 sweep（manifest 对账 + 指纹比对，非全量重 parse）通过后按 §9.10 的增量 promote 规则把 COMPLETE 推进到当前 generation。这样进程重启/新会话不再需要全量重 parse 才恢复负缓存。测试：写 snapshot → 新建 client 实例加载 → 无文件变化时 sweep 只做 stat 对账、coverage 直接 COMPLETE。

#### W-6：janitor 与多进程安全清理（工程）

- `worktree-cache-cleanup.ts` 未出现在 V3 的目标结构和删除清单中——需明确**保留**，它是 worktree 缓存膨胀的唯一回收机制（新的 `java-index-v3.snapshot.json.gz` 在同一 cacheRoot 下，天然被覆盖）；
- 现有活性检查只看 `jdtlsPid`——fast-only 会话（从不启 JDT）的 worktree 缓存可能在 TTL 内被另一进程的 janitor 误删。建议 `touchRepoCache` 增写 `ownerPid` 并在清理时做与 W-1 相同的 `kill(pid,0)` 活性检查；
- V3 生命周期重构后（Task 3），`touchRepoCache(repoRoot, { jdtlsPid })` 的调用点要迁移到新的 READY commit 处，执行计划未提及。

#### 插入执行计划的建议位置

```text
Iteration B 末尾（Task 12 之后，Task 13 报告之前）：
  Task 12a  W-1 跨进程 JDT lease + 同 worktree 二号进程降级
  Task 12b  W-3 风暴降级 + isIgnoredPath 规格（含 .git 文件形态测试）
  Task 12c  W-6 janitor 保留声明 + ownerPid 活性检查
  → Task 13 报告增加「多进程/风暴」验收段

Iteration C 内：
  Task 15/19  fileId 基于 relativePath（W-2 前置约束，零成本，必须此时定）
  Task 20/21  W-5 generation rebase + 验证 sweep promote
  Task 21a    W-2 兄弟 worktree snapshot seeding（依赖新 snapshot 格式，故放 C）
  Task 23 报告增加「新 worktree 冷启动」before/after：seeding 关/开的
            首请求质量（coverage、候选来源分布）与 sweep 成本对比

W-4 全局 sweep 节流：Task 20 顺手实现进程内 semaphore；跨进程部分与 Task 12a 合并。
```

新增验收测试（并入 §16.5 清单）：

```text
16. 两个 manager 实例（模拟两进程）共享 lease 目录，全局 JDT 槽位不超限；
    死 PID 的 lease 可被回收。
17. 同一 worktree 第二个实例请求 required：返回 JDT_BUSY_OTHER_SESSION 降级，
    不产生第二个 JDT 进程，fast 路径正常。
18. 兄弟 worktree seeding：worktree B 无 snapshot 时从 A seed；
    B 中已修改的文件不复用 A 的 facts；root 为 DEGRADED 直到 reconcile 完成；
    reconcile 后 negative lookup 恢复。
19. 500 文件 change batch：batch 被降级为 background，期间 anchor foreground
    refresh 延迟有界；风暴结束后 coverage 恢复 COMPLETE。
20. linked worktree 的 .git 文件变更不产生 JAVA_* change，不推进 generation。
21. snapshot 重载后 clock 从 indexedGeneration 续起；无变化时验证 sweep
    不重 parse 即恢复 COMPLETE。
```

---

## 5. 需要修订的细节清单

按「文档 / 编号 / 严重度」排列，可直接据此修订。

### 架构 V3

| # | 严重度 | 问题 | 建议 |
|---|---|---|---|
| A-1 | 高（与新需求冲突） | §0.1 产品定义"在**一个 Java 仓库内**"；全文无 worktree family 语义 | 定义改为覆盖"一个 repo 及其全部 worktree"；新增一节"Worktree 并发模型"收录第 4 节的不变量（per-worktree 隔离 = 正确性边界；family = 资源与 seeding 边界） |
| A-2 | 中 | §7.2 `DeadlineBudget.race(stage, operation, capMs?)` 三参签名，与执行计划 Task 3 使用的四参（含 onTimeout 回调）不一致 | 统一为四参：`race(stage, operation, capMs?, onTimeout?)`，Task 1 按此定义 |
| A-3 | 中 | §8.2 条 7"第一次 **cacheable** 请求必须等待 watcher ready barrier"，但执行计划 Task 10 Step 2 是无条件 `await entry.ready`——大仓库 chokidar 初扫秒级，首请求被阻塞 | 按架构文档口径实现：ready 前允许请求执行，但禁止写 generation-scoped cache、输出标 DEGRADED；或给 barrier 设上限（如 2s）后降级放行 |
| A-4 | 中 | §19.6 要求"连续失败简单 exponential backoff"，但执行计划把 backoff 放在 Task 33（Iteration E）；Task 3 的 `ensureStarted` 对 BROKEN 直接重启——Iteration A~D 期间 jdtls 环境性故障（如 JDK 缺失）会造成每请求重启风暴 | 把最简 backoff（连续失败计数 + 冷却窗口，~20 行）提前进 Task 3 |
| A-5 | 低 | §11.1 五态无 STOPPING；`stop()` 中 shutdown 有 3s 等待期，状态语义未写明 | 在 §11.1 注明"STOPPED 为目标态，置位先于清理等待"（执行计划 Task 3 Step 6 已如此要求，补文档即可） |

### 执行计划 V3

| # | 严重度 | 问题 | 建议 |
|---|---|---|---|
| E-1 | 中 | 同 A-4：BROKEN backoff 迟至 Task 33 | Task 3 增加最简退避 |
| E-2 | 中 | 同 A-3：Task 10 Step 2 的 barrier 无条件化 | 改为 cacheable-only 或带上限 |
| E-3 | 中 | 同 W-5：snapshot `indexedGeneration` 与新进程 clock=1 的衔接缺失，`canAnswerNegative` 的相等检查使负缓存在每次进程启动后长期失效 | Task 20/21 补 rebase + 验证 sweep promote 规则 |
| E-4 | 低 | Task 4 步骤编号乱序（Step 5 出现在 Step 4 之前） | 重排编号 |
| E-5 | 低 | Task 9 `isIgnoredPath` 只有函数名无规格；linked worktree 的 `.git` 是文件形态，chokidar 会发事件 | 给出 ignore 规格 + 专项测试（并入 W-3） |
| E-6 | 低 | Task 9 chokidar `atomic`/`awaitWriteFinish` 选项在 v5 的行为需在 spike 里确认（v4 起 API 有裁剪；glob 移除已正确用 ignored 函数规避） | Task 9 Step 1 增加一行选项行为验证 |
| E-7 | 低 | 测试代码中的 helper（`manager.sessions.get(...).startedStarting`、`queueForTest` 等）是伪代码性质 | 已有"Adapt helper syntax"声明，可接受；执行 agent 需知晓这不是可直接粘贴的代码 |

### 事实性核对结论（无需修订，供参考）

- 依赖版本 pin：5/5 与 npm 实测一致（本轮验证）。
- §1.3 引用的 phase 12 基线数字（recall 0.8456/0.8643/0.7350，P_read 0.8667/0.7000/0.6333）与仓库内 phase 12 报告一致。
- 架构 §9.12 snapshot schema 3 与执行计划 Task 21 schema 2 并非矛盾：执行计划先落 schema 2，MyBatis resource facts（Task 28）落地后进 schema 3 直接换代——两文档口径已相互说明。
- §16.5 的 15 项系统测试与上轮 review 要求的故障注入清单完全对应。

---

## 6. 综合裁决

1. **接受两份 V3 文档为权威基线**。上轮 review 的意见吸收完整，新增设计（坐标契约、内容指纹、coverage promote、edge store 收敛）质量高于我上轮给出的建议粒度。
2. **开工前先做两件事**：(a) 按第 5 节修订 A-2/A-3/A-4（三处会直接影响 Task 1/3/10 的实现形态）；(b) 把第 4 节的 worktree 任务包（Task 12a-c、15/19 的 fileId 约束、20/21 的 rebase、21a seeding）写进执行计划——其中 **fileId 基于 relativePath 是唯一必须在 Iteration C 开工前锁定的决定**，其余可以按插入位置顺序落地。
3. **多 worktree 场景的定性结论**：V3 的 per-worktree 隔离设计是正确性的正确地基，不要为共享而破坏它；需要补的是三层——跨进程资源 lease（W-1，正确性）、兄弟 snapshot seeding（W-2，效率大头）、风暴降级与节流（W-3/W-4，稳定性）。全部可以在"无 daemon、无数据库、无共享内存"的小而精悍约束内完成，估算总增量 ~400 行实现 + ~300 行测试。
4. 执行顺序维持 A→B→C→D→E→F 不变；worktree 任务包不改变任何迭代的门禁定义，只在 B/C 的 phase report 中各增加一个验收段。

## 7. 本次 review 的限制

- 执行计划 8,725 行中，Task 5/6/7/12/14/16/17/18/24~35 为结构化抽查（接口、测试断言、门禁），未逐行精读；已精读的任务（0/1/3/4/9/10/11/20/21/22 及全部总章）未发现与抽查部分矛盾的信号。
- chokidar 5 / tree-sitter 0.25 在 Node 22 worker 中的实际行为未运行验证——这正是执行计划 Task 14/Task 9 spike 的职责，版本存在性已实测。
- 多进程场景的分析基于"Codex 每会话 spawn 独立 stdio MCP server"这一部署事实与 Eclipse workspace 锁的已知行为，未实际并发起两个 MCP 进程复现锁冲突；建议 Task 12a 的失败测试先行复现。
- 三仓 benchmark 未重跑，质量基线沿用 phase 12 报告数字（与上轮 review 相同的限制）。

# 代码质量审查报告

> 日期：2026-11-16　分支：feat/s1-implementation-listing（基线 d5843ae）　修订：v2，已按独立评审（Fable 5.2 high）修正
> 范围：src/（生产代码约 56.8k 行，测试约 50k 行）、scripts/、仓库工程体系
>
> 方法：
> - 机械扫描：rg 和 git 统计。
> - 子代理分区审查（Sonnet）：A 区 = 静态查询路径，B 区 = 索引与存储，C 区 = 进程与并发。
> - 主代理复核子代理结论，再交给 Fable 5.2 独立评审；本版按评审意见修订。
>
> 证据标签：
> - **[已观察]**：读到了证明问题的代码。
> - **[推断]**：机制已确认，后果靠推理。
> - **[未验证]**：只是线索。
>
> 每条问题都标注它所在的**路径**：静态 / JDT / 共用。用户主要使用静态路径，只在 JDT 路径触发的问题优先级相应下调。
>
> 生产可达性以 `scripts/ilv2-mac-removed-paths.mjs` 为准。该台账把 `sql-client.ts`、`local-index.ts` 等标为 test-only，落在这些文件里的问题不计为生产缺陷。

## 1. 结论

**静态路径：没有高严重度缺陷。**
- **设计扎实：**
  - snapshot lease 采用"先标记、后回收"。
  - SQL 全部参数化。
  - deadline budget 从入口一路传下去。
  - 静态路径上所有 spawn/fork/Worker/WriteStream 都监听了 `error`。
- **问题集中在一致性上：**
  - 错误码在工具边界丢失（M1）。
  - 瞬时读错误被缓存（M2）。
  - rg 列号单位不对（M3）。
  - 若干重复实现。

**JDT 路径（用户很少启用）：有 2 项高严重度问题。**
- H1：JDT 子进程和它的日志流都没有 `error` 监听，一旦出错会让 daemon 崩溃。
- H2：lease 回收存在"先检查、后删除"的竞态。
- C-M3、C-M4 也只在启用 JDT 时触发。

**共用路径：有 1 项中等问题。** C-M2：`createEntry` 失败时不释放已获取的资源。

**最大短板在工程体系，不在代码本身。**
- 没有 lint、format、CI；tsconfig 只开了 `strict`。
- scripts 下 278 个文件不做类型检查。
- 742 个被 .gitignore 忽略的文件仍在 git 跟踪中。
- docs 有 1324 个文件、约 35 MB。
- 给 AI 读的入口 AGENTS.md 只有 367 B。
- 现有规范大多只写成文字，几乎没有机器门禁。这是 AI 输出质量不稳定的主要结构性原因。

基础数据（均已观察）：
- 生产代码中真正的 `any` 有 4 处，`as unknown as` 有 17 处（其中 3 处在 benchmark），没有 `@ts-ignore`。
- 裸 `catch {` 有 160 处，分布在 63 个文件；`.catch(() => undefined)` 有 60 处。

## 2. 验证状态

| 项 | 状态 |
|---|---|
| 机械扫描 | 已运行，数字已经评审逐项复核 |
| A、B、C 三区审查 | 子代理已完成；主代理复核了全部 High/Medium 的代码行；独立评审又核了一遍 |
| `tsc --noEmit` / 单测 / 运行复现 | 未运行：本机 960 MB 内存、无 swap；项目目标平台是 macOS，`npm test` 是长时 full profile |
| 推断项 | H1 的崩溃后果、H2 的竞态窗口、M4 的 SQLite 报错名，都没有实际运行复现 |

## 3. 产品代码问题（按严重度）

### High（均为 JDT 路径）

**H1　JDT 子进程和日志流都没有 `error` 监听，出错会让整个 daemon 退出**
- **标签：** 代码 [已观察]，崩溃后果 [推断]。
- **位置：**
  - `src/jdtls-transport.ts:28-41`：`JdtlsChild` 接口只声明了 `once("exit" | "close")`。
  - `src/jdtls-session.ts:1021-1028`：`attachAttemptLogging`。
  - 在 jdtls-session、jdtls-transport、jdtls-lsp-io 三个文件中搜索 `"error"`，0 处命中。
- **触发条件：**
  - `spawn` 异步失败（EACCES、EMFILE、shebang 指向的解释器缺失）。
  - `createWriteStream(this.logFile)` 打开或写入失败（目录已被 GC、ENOSPC）。
  - 在 `exit` 回调里调用了 `logStream.end()`。`exit` 可能早于 stdio 关闭，之后到达的 stderr 数据会导致 write-after-end。
- **后果：** 未监听的 `error` 成为 uncaughtException。`process-crash-markers.ts:52-58` 对它显式调用 `exit(1)`，所有 repo runtime 随之一起退出。
- **对照：** `mac-platform/fsevents.ts`、`native-exec.ts`，以及静态路径上的 rg-runner、query-pool、build-scheduler 都正确监听了 `error`。
- **修复：**
  - 在 `JdtlsChild` 接口加入 `error`，接到 `classifyJdtStartError` / BROKEN 路径。
  - 给 `logStream` 加 `on("error")`。
  - 改为在子进程 `close` 之后再调用 `end()`。

**H2　lease 回收是"检查后无条件删除"，两个进程可能同时持有同一个槽位**
- **标签：** 代码 [已观察]，"两个 owner 进程并存"这一前提 [未验证]。
- **位置：**
  - `src/cross-process-lease.ts:499-518`：`claimLeaseDir`。
  - `:542-544`：`reclaimDir` 直接 `rmSync`。
  - `:625-633`：`capacity.lock`。
- **触发时序：**
  1. 进程 A 和 B 都判断原 owner 已死亡。
  2. A 回收目录，执行 `mkdir`，再写入 metadata。
  3. B 仍按自己旧的检查结果执行 `rmSync`，删掉了 A 新建的 lease。
  4. B 执行 `mkdir` 成功。
  - 另一种情形：A 在 `mkdir` 和写 metadata 之间时被 B 删除，结果同样是双持有。
- **范围：**
  - `claimLeaseDir` 的生产调用方只有 JDT（`jdtls-session.ts:526` 的 `acquireJdt`）。
  - `acquireSweep` 和 `acquireBuild` 在 src 非测试代码里没有调用方。
  - `acquireRuntime` 使用唯一目录，不走回收路径。
  - 前提需要多个 owner 进程同时运行。ILV2 下 stdio 只做转发，何时会出现多个 owner 进程没有核实。
- **后果：** 违反"同一 workspace 不能同时跑两个 Eclipse"的不变量。持有者自己也感知不到：`heartbeat` 发现 token 不匹配时只是静默返回（`:599-604`）。
- **修复：** 单纯 rename 成 tombstone 仍有残留窗口，修复需要三部分：
  - 在 lease 目录内用 `mkdir` 抢占一个"回收标记"；抢到后重新读取 ownerToken，确认仍是检查时看到的那个，再删除。
  - 抢不到标记就按 BUSY 处理，并输出告警。
  - `heartbeat` 发现 token 不匹配时，上报为 lease 丢失，不再静默返回。

### Medium

**M1　工具边界丢弃错误码；`waitStaticIndexReady` 把带 code 的错误换成普通 Error（静态路径）**
- **标签：** [已观察]
- **根因：** `src/mcp-server-factory.ts:327-333` 的 `errorResult` 只返回 `error.message`，不带 code。
- **遥测的补救方式：** `telemetry/impact-telemetry.ts:213-223` 先取 code，取不到就用 message 正则反推，最后兜底为 `QUERY_FAILED`。这违背了 `runtime/intelligence-error.ts` 自己的约定"调用方按 code 分支，不按 message 文本分支"。
- **主要实例：** `src/tools/symbol.ts:331-343` 用 `catch { throw new Error("java_symbol static query requires ...") }` 把 `INDEX_PARTIAL`（NOT_READY）换成了没有 code 的 Error。由此带来三个后果：
  - 遥测的 `errorCode` 退化为 `QUERY_FAILED`。
  - 日志里没有 code，cause 也丢了。
  - `tools/impact.ts:94` 也调用了它，所以 java_impact 失败时显示的是 java_symbol 的文案。
- **说明：** 生产环境的 client 是 `SnapshotJavaIndexClient` 或 `NotReadyJavaIndexClient`，被吞掉的只有 NOT_READY 一种。"deadline 和取消混在一起"只发生在 test-only 的 `SqlJavaIndexClient` 里。
- **同类问题（较弱）：** `java-index-router.ts:962/1009` 的 `retryCold*` 会吞掉 deadline。不过 budget 是绝对时间，下一个检查点仍会抛出，实际后果只是"过期后多做一段工作，然后返回 fallback"；代码注释也说明这里是有意降级。
- **修复：**
  - `errorResult` 输出结构化的 code（例如 `[CODE] message`，或放进 structuredContent）。
  - `waitStaticIndexReady` 改为抛出 `JavaIntelligenceError(code, msg, cause)`，文案按调用方区分。
  - 把 `relationship-provider.ts:275` 的 `rethrowRelationshipTerminal`（目前未导出）提升为共享的 `rethrowIfTerminal`。

**M2　repository marker 缓存把非 ENOENT 的读错误记成"不存在"（静态路径）**
- **标签：** [已观察]
- **位置：** `java-index-router.ts:1306-1309`。catch 里只有 `JavaIntelligenceError`（deadline）会重新抛出，其他错误一律执行 `set(relativePath, null)`。
- **触发：** EMFILE、EACCES 等瞬时错误。
- **后果：** 在下一次 refresh 或 reconcile 之前，框架 marker 一直缺失，框架证据静默退化。
- **附带问题：** `content.length` 数的是 UTF-16 单元，却拿去和 `REPOSITORY_MARKER_MAX_BYTES` 比较。
- **修复：** 只缓存 ENOENT 和 ENOTDIR，其他错误不缓存并计数；截断按字节计算，或者把常量改名。

**M3　rg 列号是字节偏移，被原样当作列号对外输出（静态路径）**
- **标签：** [已观察]
- **位置：** `src/search/rg-runner.ts:118-119`，代码为 `column: (first?.start ?? 0) + 1`（rg JSON 的 `start` 是字节偏移）。
- **流向：** 经 `rg-plan.ts:126` 进入候选 positions，再由 `output-v6.ts:194` 写进对外的 `locations[].column`。
- **触发：** 匹配点之前有中文等非 ASCII 字符。
- **定为 Medium 的理由：** 调用方可能把 locations 里的列号原样传回 `java_symbol(file, line, column)`，此时会定位错。如果确认没有这种回填用法，可降为 Low。
- **附带问题：** `line_number ?? 1` 会把缺失的行号伪装成第 1 行。
- **修复：** 先确认索引侧列号的单位，再把字节偏移换算成相同单位；行号缺失时丢弃该位置；补一条含中文的测试。

### Medium（共用路径 / JDT 路径）

| # | 路径 | 问题 | 位置 | 标签 |
|---|---|---|---|---|
| C-M2 | 共用 | **`createEntry` 获取资源后的失败路径没有释放。** `ownership.acquire()` 之后，`probeLayoutOffThread` 或 `budget.race("runtime.lease")` 都可能抛错，函数没有 try/catch；此时 entry 还没有登记，`shutdownAll` 也够不到它。ownership、session、edge store 会一直泄漏到进程退出 | `repo-runtime-manager.ts:798-853` | 已观察；ownership 是否可重入未验证 |
| C-M3 | JDT | **`shutdownAll` 没有 try/finally。** `closeSessions` 用的是 `Promise.all`，只要一个 `session.stop()` reject（SIGKILL 后子进程仍存活，`jdtls-session.ts:740`），后续的 lease/ownership 释放、取消订阅、`owner.stop()` 全部被跳过。31 秒 failsafe 兜底 | `repo-runtime-manager.ts:727-765` | 已观察 |
| C-M4 | JDT | **正常关停时，JDT stop 不服从关停 deadline。** shutdown 请求固定等待 3000 ms，kill 也是逐个执行，`remaining()` 没有传下去。多个 JDT 卡住时，会被 31 秒的 `exit(1)` 截断 | `jdtls-session.ts:716-733` | 推断 |

### Low

| # | 路径 | 问题 | 位置 | 标签 |
|---|---|---|---|---|
| L1 | 静态 | `bindChunks` 没有把同一语句里的固定绑定参数算进去。三处中只有 BFS frontier 那一处在理论上可达；超限时 SQLite 在 prepare 阶段报 "too many SQL variables"。对照：`facts-store.ts:307` 传了 `1`，`:521` 传了 `kindIds.length` | `incremental.ts:244`（可达）、`:268`、`entity-search.ts:348` | 机制已观察，报错名为推断 |
| L2 | 静态 | `runInWriteTx`（已在事务中就加入，否则新开写事务）在 `rows.ts:112`、`search-docs.ts:10`、`entity-tokens.ts:8` 各复制了一份；`asInt` 也有 3 份（`rows.ts:106`、`knowledge-graph.ts:37`、`entity-search.ts:41`），且不检查安全整数，而 `asRowId` 检查。**注意：** `runInWriteTx` 的"加入"语义不能用无条件 BEGIN 的 `withTransaction` 替换 | 同左 | 已观察 |
| L3 | 静态 | 原子写至少有 3 份，强度不一：`seal.ts:49 writeFileAtomic`（async、`wx`、fsync）最强；`snapshot-store.ts:229` 用固定的 `.tmp` 名，不用 `wx`，也不 fsync；`publication-history.ts:49` 不 fsync。lease、ownership、edge-store 里另有几份同步实现，未逐一比对 | 同左 | 已观察 |
| L4 | 静态 | router 缓存清单写了 3 份：`reconcile` 和 `close` 各手写了相同的 6 个 clear，`refresh` 只清其中一部分。新增缓存时必须改 3 处 | `java-index-router.ts:547-575` | 已观察 |
| L5 | 静态 | 语句缓存没有淘汰机制，`inClause(n)` 每遇到一种新长度就生成一条新 SQL。缓存按连接存放在 WeakMap 中，连接关闭即释放 | `driver.ts:214` | 推断 |
| L6 | 静态 | 清理失败被 `.catch(() => undefined)` 静默吞掉，没有计数，磁盘泄漏难以追查 | `index-owner.ts:752/838/991/1093` | 已观察 |
| L7 | 静态 | 测试钩子 `testBlockMs` 有两份，`BEGIN` 和 `COMMIT` 之间都没有 finally | `snapshot/query-process.ts:105-112`、`discovery/query-worker.ts:403-410` | 已观察 |
| L8 | 共用 | 生产代码有 17 处 `as unknown as`，另有 `registerTool(..., config as any, callback as any)`；`registry-view.ts:12/15` 和 `facts-store.ts:414/417` 绕过了两套实现之间的接口一致性检查 | 另见 `tools/symbol.ts:80/242/247/256`、`mcp-server-factory.ts:265` | 已观察 |
| L9 | JDT | `cross-process-lease.ts:181 defaultIsAlive` 不校验进程启动身份，PID 复用时会把死进程误判为存活。这是 fail-safe 方向，只会泄漏容量 | 同左 | 已观察 |
| C-M1→L10 | 共用 | 缓存 janitor 会立即删除没有 metadata 的 lease 目录（`cross-process-lease` 对此有 `orphanGraceMs` 宽限，janitor 没有）；它的 `isProcessAlive` 还把 EPERM 当成死亡。由于 mkdir 和写 metadata 是连续的同步调用，竞态窗口极小 | `worktree-cache-cleanup.ts:573-589/607-614` | 已观察，概率为推断 |
| L11 | 共用 | HTTP server 开始监听后执行了 `server.off("error", reject)`，之后再没有 `error` 监听，与 H1 是同一模式 | `http-server.ts:382-389` | 代码已观察，触发条件未确认 |
| L12 | 共用 | `process-crash-markers.ts:59-63` 对 `unhandledRejection` 只打标记、不退出，与 uncaughtException 的处理不对称，daemon 会带着未知状态继续运行 | 同左 | 已观察 |
| L13 | 共用 | `listen()` 之后启动失败时，只关闭了 application，没有关闭 `nodeServer`，`main()` 也只设置 `exitCode`，进程会半死不活地留着 | `http-server.ts:118-139/458-461` | 已观察 |
| L14 | 共用 | `retireIdleEntry` 的空 `catch {}` 吞掉所有错误，没有日志 | `repo-runtime-manager.ts:1031-1043` | 已观察 |
| L15 | 共用 | telemetry 只在 `beforeExit` 时 flush，而 daemon 用 `process.exit` 退出，`beforeExit` 不会触发 | `impact-telemetry.ts:173` | 已观察，数据丢失为推断 |
| L16 | 共用 | `createEntry` 执行期间没有检查 `shuttingDown` | `repo-runtime-manager.ts:728/857` | 推断 |
| L17 | JDT | `jdt-process-tree.ts` 在事件循环上同步执行 `ps`，并且对每个 pid 都重新列一遍全表 | `:19/36-38` | 推断 |

**已撤回：**
- 原 L4（`SqlClient.close`）：所在文件按台账属于 test-only。
- 原 L6（query worker 链静默失效）：`query-process.ts:65` 在 ops 加载失败时已经 `exit(1)`。

**测试与验证用环境变量的使用约定：**
- 测试和验证专用的行为由 `JAVA_LSP_ISOLATED_VALIDATION=1` 显式开启，生产代码里有 10 处这样的门控。这是现行约定，不算缺陷。
- `ILV2_RUN_ROOT`（`incremental.ts:1241`）是 fail-closed 防护，也不算缺陷。
- `ILV2_OWNER_CACHE_ROOT` 是生产合同变量。

### 大文件职责

**确实混合了多类职责，建议在功能改动触及时顺带拆分：**
- **`java-index-router.ts`（1499 行）：** request memo、generation 管理、facts hydrate、冷启动 rg 扫描、marker 读取。
- **`incremental.ts`（1267 行）：** 依赖闭包规划、delta 执行、事务与失败策略。
- **`repo-runtime-manager.ts`（1190 行）：** 注册与 singleflight、退役、LSP 槽位、压力监控、prewarm。
- **`jdtls-session.ts`（1345 行）：** 状态机、启动事务、心跳、缓存、文档同步。

**可选拆分：** `index-owner.ts`、`jdtls-lsp-io.ts`、`worktree-cache-cleanup.ts`。

## 4. 工程体系问题

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| E1 | 被忽略的文件仍在跟踪 | `git ls-files -ci --exclude-standard` 返回 742 个，全部在 `artifacts/v3-*` 下。.gitignore 写的是 "dumps stay out of git"，但 docs/phase-v3、docs/deep 和 `scripts/verify-v4-sprint0-baseline.mjs` 都引用了这些文件 | 规则与事实相互矛盾，AI 会把它们当成可以提交的范例 |
| E2 | 没有 lint、format、CI；tsconfig 只开了 `strict` | 没有 eslint、prettier、biome、editorconfig，也没有 `.github/` | 本报告里大部分问题都只能靠人眼发现 |
| E3 | scripts 不做类型检查 | 278 个文件，0 个带 `@ts-check`，tsconfig 只 include `src`；其中 43 个脚本 import 了 `../dist/*` | 评测和门禁脚本是证据链里最弱的一环 |
| E4 | 脚本膨胀 | `ilv2-mac-*` 有 90 个；按启发式统计，18 个脚本没有被任何地方引用 | 检索噪声大，AI 容易照着过时的脚本写 |
| E5 | npm 命令重复 | 4 个 `benchmark:*` 命令逐字相同；`test` 和 `test:isolated` 相同 | 入口含义不清 |
| E6 | 文档膨胀，当前真源不清 | docs/ 有 1324 个文件（503 个是 JSON）；HANDOFF.md 76 KB，"当前"状态和历史混在一起；README 41 KB；AGENTS.md 只有 367 B；规范分散在 4 处 | AI 读进来的上下文以历史内容为主 |
| E7 | 测试依赖定时 | `query-worker.test.ts` 有 10 处 setTimeout，另有若干文件各 4–5 处 | 低配机器上可能 flaky（推断） |

另外，测试按 `<module>-<aspect>.test.ts` 命名，并没有覆盖缺口：`java-index-router` 由 `router-integration.test.ts` 覆盖，`tools/symbol` 由 `symbol-static.test.ts` 覆盖。

## 5. 值得固化的现有做法

1. **先标记、后回收。** reclaim 时加 `reclaiming` 标记阻止新 lease，所有回收操作串行执行，并支持故障注入 `faultAt`。
2. **事务原语分层。**
   - `withTransaction` 每次开启一个新的写事务。
   - `runInWriteTx` 加入已有事务，没有时才开启新事务。
   - `withReadSnapshot` 提供只读快照。
   - `driver.ts:162` 有注释约定"不要传 async 回调"，可以做成机器检查。
3. **SQL 全部参数化。**
4. **进程身份校验。** `repo-ownership-lease.ts`、`jdt-process-tree.ts` 用 pid 加 start identity 判断进程身份，并区分 ESRCH 和 EPERM。注意这还不是全仓不变量，L9 和 L10 就是反例。
5. **关停与定时器纪律。**
   - 关停时只计算一次绝对 deadline，并设有 failsafe。
   - `DeadlineBudget.race`、`waitForIdle`、`RuntimeLifecycleGate.acquire` 在所有出口都会清理 timer。
   - mac-platform 的子进程只在 `close` 时 settle，违反协议即 SIGKILL。
6. **按 code 区分终止类错误。** `relationshipTerminalCode` 和 `rethrowRelationshipTerminal` 已经实现，应该推广。
7. **门禁挂点。** `run-v4-gates.mjs` 的 `GATE_PROFILES` 和 `count-production-ts.mjs` 的清单可以作为机器门禁的挂载点。
8. **生产可达性台账。** `scripts/ilv2-mac-removed-paths.mjs` 应作为今后审查和门禁过滤 finding 的依据。

## 6. 优化建议与落地顺序（按投入产出排序，已合并原 `7.6）

**第 1 步：只加检查，不改行为。**
- 新增 hygiene 脚本，以 baseline 模式运行。
- 合并重复的 npm 命令。
- 接入 eslint，规则先设为 warn，并生成存量 baseline。
- 按 7.4 更新 AGENTS.md。

**第 2 步：修复静态路径。**
- 修 M1（工具边界输出 code，`waitStaticIndexReady` 改为保留 code 和 cause）。
- 修 M2、M3。
- 修 C-M2、L1（把 `extraBinds` 改成必填参数）。

每项都配一条回归测试。

**第 3 步：修复 JDT 路径。** 只用静态路径时，可以排在第 2 步之后。
- H1：加 error 监听。回归测试：注入一个 spawn 失败的 fake child。
- H2：先在 lease 目录内抢回收标记，再重读 token；heartbeat 发现 token 不匹配时上报。回归测试：两个进程同时回收同一个已死 owner。
- C-M3：改用 allSettled，释放逻辑放进 finally。
- C-M4：把关停 deadline 传给 stop。

**第 4 步：收敛重复实现。**
- `runInWriteTx` 和 `asInt`（合并为 `toSafeInt`）各上移一份到 `driver.ts` 导出，保留加入已有事务的语义。
- 新增 `writeFileAtomicSync`，与 async 版共享同一套规则。
- 把 `rethrowIfTerminal` 导出为共享函数。
- router 的缓存清单合并成一个 `resetCaches(scope)`。

完成后，把对应的 lint 规则从 warn 切换为 error。

**第 5 步：提高门槛。**
- tsconfig 加严，scripts 纳入类型检查。
- 加文件体量门禁。
- HANDOFF 只保留"当前"节，控制在 5 KB 以内；README 移出里程碑叙事。
- 处理 E1，二选一，需另行确认：
  - 方案一：把这些文件认定为冻结证据，在 .gitignore 里显式放行，或迁到 `docs/evidence-archive/`。
  - 方案二：迁移引用之后再取消跟踪。直接 `git rm --cached` 会破坏 docs/phase-v3 和验证脚本的证据链。

## 7. 让 AI 产出高质量代码的规范

原则：**能用机器检查的规则，就不只写成文字。** 每条规则都对应本报告里的一个问题，并有一个执行点；文字规则只留给机器判断不了的部分。

### 7.1 类型与编译（执行点：tsconfig、`gate:pr`）

| 规则 | 对应问题 | 执行方式 |
|---|---|---|
| 新增 `tsconfig.strict.json`（noEmit），开启 `noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch` | 越界、undefined | tsc 会检查所有被 import 的文件，按目录拆配置隔离不了存量。做法是按文件统计错误数并记成 baseline，之后只允许减少 |
| scripts 纳入类型检查：`tsconfig.scripts.json`（`allowJs`、`checkJs`、`noEmit`） | E3 | 前提是先 compile。43 个脚本 import 了 `dist`，需要让 dist 产出 `.d.ts`（开启 `declaration`），或者先排除这些脚本 |
| 不新增 `any`、`as unknown as`、非空断言 | L8 | `@typescript-eslint/no-explicit-any`、`@typescript-eslint/no-non-null-assertion`、`@typescript-eslint/consistent-type-assertions`，再加 `no-restricted-syntax` 匹配 `as unknown as`；存量按 baseline 冻结（非空断言的存量在 200 处以上） |

### 7.2 Lint（执行点：eslint + typescript-eslint；新增 devDependency，只在开发期使用，不影响运行时与部署）

- **异步：**
  - 开启 `@typescript-eslint/no-floating-promises`、`@typescript-eslint/no-misused-promises`（需要 typed linting）。
  - `void x.catch(() => undefined)` 只允许出现在带说明注释的位置（对应 L6，存量 60 处）。
- **catch 降级（自定义规则，对应 M1、M2、L14）：** 如果 catch 块返回降级值或吞掉异常，必须满足下面之一：
  - 先调用 `rethrowIfTerminal(e)`；
  - 带有 `// degrade: <原因>` 注释。
- **资源 error 监听（自定义规则，对应 H1、L11）：** `spawn`、`fork`、`createWriteStream`、`createServer`、`app.listen`、`new Worker` 创建的对象，必须在同一个函数内注册 `error` 监听，或者交给已登记的包装函数处理。
- **事务（对应 `driver.ts:162` 的约定）：**
  - 禁止向 `withTransaction` 传 async 回调。
  - 禁止在 `driver.ts` 之外手写 `BEGIN`。现有例外是 testBlockMs 钩子和 benchmark，用 allowlist 放行。
- **写文件：**
  - 新增"写到 tmp 再 rename"的代码时，必须复用 `writeFileAtomic`（async）或 `writeFileAtomicSync`（第 4 步新增）。
  - 目录 rename 不受此限，存量按文件记 baseline。
- **测试钩子：**
  - 新增的测试或验证专用行为必须由 `JAVA_LSP_ISOLATED_VALIDATION=1` 或显式的 `allowTestHooks` 选项门控，默认关闭。
  - lint 按变量名白名单检查，不按 `ILV2_` 前缀一刀切。
- **格式：** 交给 prettier 或 biome，一次性全仓格式化后锁定。

### 7.3 仓库门禁（执行点：新增 `scripts/check-repo-hygiene.mjs`，接入 `gate:pr`）

1. `git ls-files -ci --exclude-standard` 以当前 742 条为 baseline，不得新增（E1）。
2. 新增的生产 `.ts` 文件不超过 600 行；已超过 800 行的文件不得继续增长，baseline 取自 `count-production-ts`。
3. 新增的生产模块必须被至少一个 `*.test.ts` 直接 import。worker 入口和纯类型模块可以豁免，需在 allowlist 里写明理由。
4. 新增脚本必须被 package.json、其他脚本或新增的 `scripts/README.md` 索引引用（E4）。
5. 新增测试中不得用裸 `setTimeout` 等待（E7）。
6. 新增 finding 或门禁时，必须先对照 `ilv2-mac-removed-paths.mjs` 排除 test-only 的文件。

### 7.4 建议的 AGENTS.md（需确认后落地；原"测试与验证"条款原文保留）

```markdown
# 仓库工作约定

## 真源与边界
- 当前状态只看 HANDOFF.md 开头的"当前"两节；docs/phase-*、docs/deep 下带日期的计划和报告是历史，
  不作为实现依据；例外：docs/deep/ilv2-mac-manual/ 是现行执行合同。
- 生产可达性以 scripts/ilv2-mac-removed-paths.mjs 为准；test-only 文件的问题不按生产缺陷处理。
- 公共工具面固定 5 个；不修改目标 Java repo；JDT 是可选增强，静态路径正确性优先。

## 实现规则（现在就适用）
- 写新 helper 前先用 rg 找现有实现：
  - 写事务：driver.ts 的 withTransaction（总是开新事务）；可能被嵌套调用的写入口沿用 runInWriteTx 的"加入已有事务"语义。
  - 异步原子写文件：seal.ts 的 writeFileAtomic。
  - 分块绑定：driver.ts 的 bindChunks，必须把同一语句里的固定参数数传给 extraBinds。
- catch 先处理终止类错误：error instanceof JavaIntelligenceError 且 code 为 DEADLINE_EXCEEDED 或 CANCELLED 时重新抛出
  （参照 relationship-provider.ts 的 rethrowRelationshipTerminal）；降级处必须注释原因；
  对外错误用 JavaIntelligenceError(code, message, cause)，不得丢失 code 和 cause。
- 不新增 any、as unknown as、非空断言 !；外部输入用 zod 或类型守卫收窄。
- 新建的 child/stream/server/worker 必须监听 error；timer/fd 必须有释放点；
  close、dispose、shutdown 用 try/finally 和 Promise.allSettled 保证异常安全。
- 跨进程锁和 lease 不得"检查后直接 rm"；回收前必须在锁内重新确认 ownerToken。
- 偏移和列号必须标明单位（byte / UTF-16 / line），跨单位必须显式换算，并测试非 ASCII 输入。
- 测试或验证专用行为必须由 JAVA_LSP_ISOLATED_VALIDATION=1 或显式选项门控，默认关闭。
- 不新增被 .gitignore 忽略的跟踪文件。

## 实现规则（"重构落地后生效"，见报告第 6 节第 4 步）
- 降级统一走导出的 rethrowIfTerminal；数值转换统一走 toSafeInt；同步原子写走 writeFileAtomicSync。

## 测试
- 修缺陷先写一个会失败的回归测试；必须覆盖的边界：空、上限、上限+1、非 ASCII、取消、deadline。
- 不得削弱断言、扩大 mock、skip 测试或用 sleep 等待。

## 测试与验证
- Mac 长时间验收预计超过 5 分钟、涉及多道工程门或需要索引冷启动时，执行前阅读
  [Mac 长时间测试验证规范](docs/deep/ilv2-mac-manual/long-running-validation.md)。按规范准备后台脚本、
  阶段日志和终态交接。需要自动接续时，将 Heartbeat 绑定到当前对话。
- 迭代中运行 npm run gate:pr；提交前按 README 运行 compile 与 full 两个 profile
  （在线 runtime 并存时，npm run 不能作为正式证据，见 README）。
- 汇报时区分：已运行并通过 / 已运行但失败（附错误）/ 未运行（说明原因）。
```

### 7.5 AI 提交前自检清单（可作为 PR 模板）

- [ ] 改动能追溯到需求或缺陷，没有顺带重构或格式化
- [ ] 已用 rg 检查过同类实现，没有新增副本，也没有破坏原有语义（例如"加入已有事务"）
- [ ] 每个 catch 都已区分"终止"和"降级（写明原因）"，对外错误保留了 code 和 cause
- [ ] 新资源都有释放点和 error 监听；close/shutdown 异常安全
- [ ] 计数、偏移、bind 数、字节与字符等边界都有测试
- [ ] 跑过 gate:pr；提交前跑过 compile + full，并附上结果

## 8. 未覆盖与剩余风险

- **未深读的模块：**
  - `native/` 下的 C/ObjC 代码。
  - `jdtls-lsp-io.ts` 的协议细节。
  - `stdio-owner-proxy.ts`。
  - `install-runtime.sh` 的升级和回滚分支。
  - B 区：`edge-builder`、`name-resolver`、`mybatis-xml-extractor`、`cold-build`、`workspace-tracker`。
  - A 区：`type-reference.ts`、`plan-query.ts`、`relationship-provider.ts` 的内部逻辑。
- **前提未核实：** H2 依赖"多个 owner 进程同时运行"，这一前提没有核实。
- **M3 的定级：** 取决于调用方是否会把 locations 里的列号回填给 java_symbol。
- **启发式结果：** 孤儿脚本清单是启发式得出的，删除前需要人工确认。
- **未运行任何验证：** 编译、测试、复现都没有运行。

## 9. 处理状态（2026-11-16 收尾）

本轮审计到此收尾。每项的 Mac 门禁结果在 `docs/post-ilv2/results/AUDIT-*-MAC-GATE.json`。"暂缓"指只登记、不排期；用户主要使用静态路径，JDT 类问题按此处理。

| 编号 | 状态 | 提交 / 理由 |
|---|---|---|
| H1 | 暂缓 | JDT 路径（第 3 步） |
| H2 | 暂缓 | JDT 路径（第 3 步） |
| M1 | 已修 | `023f9ae` |
| M2 | 已修 | `c94aad4` |
| M3 | 已修 | `5fb0dbd` |
| C-M2 | 已修 | `a8beeb5` |
| C-M3、C-M4 | 暂缓 | JDT 路径（第 3 步） |
| L1 | 已修 | `fef4e04`：`extraBinds` 必填，补齐 3 处漏传 |
| L2 | 已修 | `fef4e04`：`runInWriteTx`、`toSafeInt` 收到 `driver.ts` |
| L3 | 已修 | `58fe1de`（`writeFileAtomicSync`）、`fc5ded4`（4 处同步写迁移）。`snapshot-store` observations 与 `publication-history` 故意保留固定 tmp 名：崩溃最多残留一个文件 |
| L4 | 已修 | `f9fd13c`：`resetCaches(scope)` |
| L5 | 不做 | 缓存随连接释放，未观察到增长问题 |
| L6 | 已修 | `4bb2fd2`：3 处改为记录日志；请求路径的 fence flush 和 round 等待保留原有静默处理（已有注释） |
| L7 | 不做 | 测试钩子，默认关闭 |
| L8 | 存量冻结 | eslint 基线冻结，新增即失败；改到相关文件时顺手清 |
| L9、L17 | 暂缓 | JDT 路径 |
| C-M1→L10 | 暂缓 | 竞态窗口极小，与 lease 回收（H2）一起处理 |
| L11 | 已修 | `3894ca2`：监听后保留 `error` 监听并上报 |
| L12 | 已决策 | `e6a436b`：用户选 B，`unhandledRejection` 不退出，标记行带累计计数；promise lint 规则拦新增 |
| L13 | 已修 | `3894ca2`：启动失败关闭监听，`main` 以 exit(1) 退出 |
| L14 | 已修 | `4bb2fd2`：记录日志 |
| L15 | 已修 | `4cd071a`：改为在 `exit` 时 flush |
| L16 | 暂缓 | 推断项，未复现 |
| E1 | 已修 | `bab1c75`：方案一，`artifacts/v3-*` 认定为冻结证据，卫生检查拦新增 |
| E2 | 已修 | `58a57a5`（eslint 与基线）、`e2034dd`/`b1fe31d`（类型感知 promise 规则，存量 0）。`noUncheckedIndexedAccess` 实测 235 处，不做 |
| E3 | 不做 | scripts 类型检查需改大量真实代码，投入产出不足 |
| E4 | 存量冻结 | 卫生检查拦新增未引用脚本；索引见 `scripts/README.md` |
| E5 | 已修 | `58a57a5` |
| E6 | 已修 | `6777a9f`（HANDOFF 76 KB→2.6 KB）、README 历史叙述移至 `docs/archive/` |
| E7 | 存量冻结 | 卫生检查拦测试新增 `setTimeout` |

## 附录：v2 修订记录（依据独立评审）

- 撤回原 L4、L6。
- 重写 M1：问题根因定位到工具边界丢弃 code；不能区分三种错误的分支只存在于 test-only 代码。
- 纠正原 L2 的收敛方向：`runInWriteTx` 的"加入已有事务"语义不能被替换掉。
- M3 删去 `semantic.ts` 这条流向；M4 降为 L1，并更正报错名。
- C-M1 降为 L10。
- H2 补充 JDT 范围和未验证的前提，并改进修复方案。
- 新增 L11、L12，以及 L7 的第二份副本；把 M1 的根因并入正文。
- 修正 `7.1、`7.2 中无法执行或与现行约定冲突的规则，包括 rename 禁令、`ILV2_` 前缀禁令、按目录拆分 tsconfig；补全 eslint 规则名前缀。
- 修正建议的 AGENTS.md 中 6 处与现状不符的内容。
- 所有问题加注路径；合并原 `6 和 `7.6；修正编号和交叉引用。

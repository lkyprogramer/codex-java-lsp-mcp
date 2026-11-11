# 底层设计与架构 review（2026-11-11）

基线：分支 `fix/index-lifecycle-review`，HEAD `3ae6eb2`（含 `4b84cf6`）。只读 review，未改任何代码。

## 1. 结论

ILV2 的主干设计是成立的：单 owner、不可变 snapshot、binding CAS、`(generation, epoch, seq)` 水位、查询和构建放在可杀的子进程里。本轮没有发现会让这条主干失效的缺陷。

需要优先处理的问题有三类：

1. **一处数据安全隐患**（F1）：cache janitor 对可配置目录做"排除名单式"的 `rm -rf`。配置错一次就是不可逆的误删。
2. **一个结构性的正确性缺口**（F2）：delta 索引是否等价于全量，运行期没有任何校验，血缘长度也没有上限。后台校验的全部成本花在了存储完整性上。
3. **owner 单线程上的若干放大点**（F3–F7）：同步子进程调用、全局 2 个查询 worker、每 10 分钟全量 hash、branch 切换时的二次复杂度。单仓低并发时不明显，多 worktree、多 agent 并发时会叠加。

另外，当前 HEAD 的修复提交 `4b84cf6` 没有编译和测试过，上一轮 review 定的合入门槛（F3 tracker 测试）仍未满足。这比下面任何一项都更靠前。

## 2. 验证状态

| 项目 | 状态 |
|---|---|
| 类型检查 `npm run build:isolated` | 无法运行：本机 960 MB 内存、可用约 180 MB，tsc 会被杀；产品依赖 macOS 原生组件 |
| 单元 / 集成测试 | 无法运行：原因同上 |
| Mac 实机复现 | 未运行：无 Mac |
| 生产入口可达性分析 | 已运行：从 `http-server.ts`、`server.ts`、`hooks/hook-gate.ts` 沿 import 图遍历（含 `new URL(...)` 的 worker 入口） |

下文每项都标了证据等级：
- **事实**：直接读到的代码行为。
- **推断**：由代码推出的运行期后果，没有复现。
- **假设**：依赖我没读到或无法测量的条件。

所有数量级（耗时、内存）都是推断，没有测量。

## 3. 范围

读透的部分：
- 入口与生命周期：`http-server.ts`、`application.ts`、`mcp-server-factory.ts`、`stdio-owner-proxy.ts`、`repo-runtime-manager.ts`
- 索引生命周期：`snapshot/index-owner.ts`、`snapshot-store.ts`、`seal.ts`、`seal-worker.ts`、`snapshot-verifier.ts`、`workspace-tracker.ts`、`request-view.ts`、`query-pool.ts`、`query-process.ts`
- 构建：`build-scheduler.ts`、`build-process.ts`、`incremental.ts`、`build-fingerprint.ts`、`sql/snapshot-manifest.ts`、`sql/driver.ts`
- 平台与清理：`mac-platform/owner-lock.ts`、`clonefile.ts`、`fsevents.ts`、`worktree-cache-cleanup.ts`、`repo-layout.ts`

只读了部分的：`jdtls-session.ts`（生命周期、启动、停止）、`project-jdk.ts`、`jdtls-lsp-io.ts`。

没有覆盖的见第 8 节。

## 4. Findings

按严重度排序。P1 建议在下一轮迭代前处理，P2 进入优化计划，P3 择机。

### F1（P1）cache janitor 以排除名单方式递归删除 cache base 下的目录

- **位置**：`worktree-cache-cleanup.ts:256-287`、`:392-411`、`:459-461`；`repo-layout.ts:70-94`；`application.ts:106`、`:325`。
- **事实**：
  - janitor 遍历 cache base 下的所有目录，只跳过以 `.` 开头的、`leases`、`ownership`、`telemetry`、`mac1`。
  - 其余目录只要读不到 `repo-meta.json` 且 mtime 早于 1 小时，就进入 `l1Removes`，随后直接 `rmSync(recursive, force)`，不经过 ownership 租约。
  - 目录名没有按 repoHash 的形状（12 位十六进制）校验。
  - 每个被扫描的目录还会先执行 `reclaimRetiredIndexFiles`，删除其中名为 `source-index.*` 等的文件。
  - cache base 来自 `JAVA_LSP_CACHE_BASE`，`resolveConfiguredBase` 明确支持 `~`（解析为 `$HOME`）和任意绝对路径。
  - daemon 每次启动的 `initialize()` 都会跑一次，之后每 6 小时一次。
- **触发**：`JAVA_LSP_CACHE_BASE` 被设成一个共享目录，例如 `~`、`~/Library/Caches` 或某个工作目录。
- **影响（推断）**：该目录下所有 1 小时内没动过的非隐藏子目录被递归删除，不可恢复。默认安装路径 `~/Library/Caches/codex-java-lsp-ilv2` 下不会触发。
- **次要问题**：即使配置正确，以后任何新增到 cache base 顶层的目录，只要忘了加进排除名单，1 小时后就会被删。`mac1` 当初就是这样补进名单的（`:263` 的注释）。
- **建议**：
  1. 改成允许名单：只处理名字匹配 `^[0-9a-f]{12}$` 的目录。
  2. 没有 `repo-meta.json` 的目录不删，只报告；或者要求目录内有本产品写的标记文件。
  3. 启动时拒绝危险的 base：等于 `$HOME`、`/`，或不含本产品的哨兵文件且非空。

### F2（P1，设计）delta 索引的语义正确性没有运行期校验，血缘无上限

- **位置**：`index-builder/incremental.ts`（`applyParsedRefreshRows`、`resolveClosure`、`nameDependentPaths`、`dispatchDependents`）；`snapshot/seal-worker.ts`；`snapshot/snapshot-verifier.ts`；`build-fingerprint.ts:37-45`。
- **事实**：
  - delta 构建靠一组手写的依赖规则决定重写哪些文件：`references`、`hierarchy`、`names`、`xml`、`dispatch`。这些规则必须与 resolver、edge-builder、graph-builder、search-document 实际读取的内容保持一致，代码里没有结构性保证。
  - seal 和后台 verifier 检查的是 SQLite 完整性（`quick_check`、逐表 `integrity_check`、外键）和行格式（`validateLogicalTable`）。它们不比较 delta 结果与全量结果。
  - `logicalDigest` 这个全量 / delta 对照口径只在测试和脚本里使用（`sql/index-invariants.ts` 从生产入口不可达，`scripts/ilv2-mac-full-delta.mjs`）。
  - 源码里没有"连续 N 次 delta 后强制全量"之类的血缘上限。只有 buildKey 变化、超过 `DELTA_CLOSURE_LIMIT`、verifier FAILED、delta 超时才会全量。
  - 提取器版本是手工维护的 `JAVA_FACTS_REVISION`。注释明确说不放 gitSha，以免升级时丢弃所有 snapshot。
- **推断**：
  - 任何一条依赖规则漏掉一种情况，结果就是某些文件的 edge、图行或搜索文档静默过期。这个错误会沿血缘一直带下去，直到该文件自己被编辑或触发全量。
  - 改了 resolver / edge-builder / search-document 的逻辑但没有提升 `JAVA_FACTS_REVISION` 时，旧 snapshot 继续被当作 delta base。同一个 snapshot 里会混有新旧两种逻辑写出的行，没有任何检查能发现。
  - `negativeLookupAllowed`（`repo-runtime-manager.ts:1070-1076`）在 FRESH + COMPLETE 时允许回答"不存在"。它信任的正是这份可能漂移的数据。
- **没有观察到实际漂移**。这是结构性风险，不是已复现的 bug。
- **不对称**：每次 delta publish 之后都要付一次整库完整性检查加 SHA-256（见 F5），防的是概率很低的存储损坏；而概率更高的语义漂移没有任何运行期防线。
- **建议**：
  1. 后台对照：空闲时对已绑定的 delta snapshot 做一次全量构建，比较 `logicalDigest`。不一致时用全量结果替换，并上报遥测。可以按血缘深度或时间触发，不必每次。
  2. 血缘上限：连续 N 次 delta 后下一轮直接全量。N 由对照数据决定。
  3. CI 门：改动 `src/java-index`、`src/java-knowledge`、`discovery/search-document.ts` 中影响 facts 的文件而 `JAVA_FACTS_REVISION` 或 `SCHEMA_VERSION` 没变时失败，由人显式确认"不影响 facts"。

### F3（P2）owner 事件循环上的同步子进程和同步 I/O

owner 是单线程，服务所有仓库的请求，默认请求 deadline 只有 2–3 秒（`runtime/request-context.ts:40-45`）。下面每一处都会阻塞全部仓库。

| 位置 | 事实 | 频率 |
|---|---|---|
| `mac-platform/owner-lock.ts:21` | `assertOwnerLock` 用 `execFileSync` 启动原生二进制，超时 2 s | 每次 binding 写入、每次删除、每次写 verdict（`snapshot-store.ts:484`、`:533`、`:581`、`:600`、`:700`），以及每次 fork builder / query worker / FSEvents helper（`ownerChildStdio`） |
| `jdtls-lsp-io.ts:753-756` | `findExecutable` 用 `spawnSync("sh", ["-lc", ...])`，登录 shell，**没有超时** | 未设置 `JDTLS_BIN` 时，每次构造 `JdtlsSession`（`jdtls-session.ts:300`），即每次新建 runtime entry。未启用 LSP 的仓库也会构造（`repo-runtime-manager.ts:1119`） |
| `jdtls-session.ts:674-676` | `restart(clearCache=true)` 用 `rmSync` 递归删 JDT workspace | 每次带清缓存的重启 |
| `worktree-cache-cleanup.ts:362` | 配了字节上限时对每个非 pin 目录同步递归算大小 | 启动时和每 6 小时 |
| `jdt-process-tree.ts:19`、`repo-ownership-lease.ts:387`、`:476` | `execFileSync("ps", ...)` | reap 和 ownership 判活时 |

- **推断**：
  - 一轮普通编辑（publish + 回收 + verdict）大约要 4–6 次同步 exec。
  - 用户的登录 profile 慢（nvm、sdkman 初始化）或挂住时，`findExecutable` 会冻结整个 daemon，且没有超时兜底。
  - `project-jdk.ts:266-272` 的注释记录了同类问题的一次真实事故（同步 `java -version` 冻结事件循环约 15 秒），说明这不是理论风险。
- **建议**：
  - `assertOwnerLock`：缓存验证结果若干毫秒，或改成进程内的 `fstat(4)` 加 inode 比对，只在写 binding 前做一次原生验证。
  - `findExecutable`：进程级缓存，改异步，加超时，不用登录 shell。
  - 其余改异步或挪到 worker。

### F4（P2）查询池在过载时的行为会放大延迟

- **位置**：`snapshot/query-pool.ts:82`、`:108`、`:118`、`:170-177`、`:348-362`；`snapshot/index-owner.ts:183-187`、`:865`、`:969-978`。
- **事实**：
  - 整个 daemon 只有 2 个查询 worker，FIFO 队列上限 32，所有仓库共用。
  - 队列满时立即返回 `queue_full`，owner 把它转成 `INDEX_PARTIAL`。
  - 请求到 deadline 或被取消时，如果它的查询正在跑，worker 进程被 SIGKILL。worker 缓存的最多 4 个连接和页缓存随之丢失，下一个任务要重新 fork。
  - round 的内部读取（`contentEntries`、`status`、`buildInputs`，预算 60 s）和用户请求走同一个池、同一个队列。
- **推断**：
  - 多个 agent 并发时，慢查询触发 deadline，deadline 杀 worker，重启让后续查询更慢，更多请求超时。这是正反馈。
  - 一次 `java_impact` 会并行发出多个索引读取，几个并发请求就可能撞到 32 的上限，结果被静默降级为 partial。
  - 大仓库的 `contentEntries` 要把整份 census 序列化过 IPC，会占住一个 worker，期间用户查询只剩一个 worker。
  - 反过来，队列满会让 round 失败并进入退避。
- **事实（文档不一致）**：`README.md:202` 写的是"默认使用一个共享只读 worker"，代码是 2 个。
- **建议**：
  - deadline 到达后先给 worker 一个短的协作退出窗口（worker 已经收到 `remainingMs`），超过再杀。
  - 内部读取用独立通道或独立配额，不与请求排同一队。
  - 在 MCP 请求层做并发准入，而不是让单个读取在池里失败。
  - 遥测里单独统计 `queue_full` 和被杀的 worker 数，先确认实际发生频率。

### F5（P2）与活跃度无关的后台成本：周期全量 hash 和每次 publish 的整库校验

- **位置**：`snapshot/workspace-tracker.ts:27`、`:266-271`、`:429-430`、`:566`；`snapshot/index-owner.ts:745-759`、`:655-673`；`snapshot/snapshot-verifier.ts`；`snapshot/seal.ts:175-187`；`repo-runtime-manager.ts:993-1001`。
- **事实**：
  - 每个有 tracker 的 workspace 每 10 分钟做一次 full-hash round。full-hash 模式下 `suspect()` 恒为真，不使用 stat 缓存，每个文件都要读一遍并算 SHA-256。
  - pin 仓库在 idle 后不退役（`retireIdleEntry` 对受保护仓库直接返回），tracker 一直运行。
  - 系统唤醒时每个 workspace 都登记一次 full hash（`resume()`）。每个 workspace 的并发读上限是 16，跨 workspace 没有总量限制。
  - 每次 delta publish 之后约 2 秒，verifier 对新 snapshot 做整库完整性检查并对整个文件算 SHA-256。`seal-worker.ts` 头部注释记录了真实仓库的全量检查要几十秒。
  - full hash 到期时 `requireDueFullHash` 会推进 seq，workspace 变成 STALE，直到该 round 完成。
- **推断**：
  - 笔记本上几个 pin 仓库加若干 worktree，在完全没有请求的情况下也会每 10 分钟读一遍全部源码。成本只和 workspace 数量有关，和使用无关。
  - 唤醒后所有 workspace 同时全量 hash，读操作全部经过 owner 的事件循环和 libuv 线程池，这段时间内请求延迟会上升。
  - 连续编辑时，后台校验的 CPU 和读盘量与数据库大小成正比，而不是与改动大小成正比。
  - full hash 进行期间到达的请求看到 STALE：不读写缓存，不回答负查询，并且在 `prepare` 里最多等 1 秒。`index-owner.ts:662-663` 的注释说周期 hash"不被等待"，但 `requireDueFullHash` 推进了 seq，`confirmedThrough(epoch, known)` 为假，按代码会等。这一点需要在 Mac 上确认。
- **建议**：
  - 周期 hash 改成按需：到期后不立即跑，等下一个请求到来或 workspace 有信号时再跑；长期无请求的 workspace 停掉 tracker，下次请求时由启动 round 兜底（现有机制已经支持）。
  - 周期 round 先做 full-stat，只对 stat 变了的文件 hash，再抽样 hash 一部分未变的文件。
  - 给跨 workspace 的校验读加一个全局并发上限。
  - verifier 改成按血缘深度或空闲时触发，不必每次 publish 都做。和 F2 的对照构建合并设计。

### F6（P2）准入与资源上限：workspace 数量无界，HTTP 无鉴权

- **位置**：`repo-runtime-manager.ts:751-835`、`:968-972`；`snapshot/index-owner.ts:311-331`；`http-server.ts:145-205`、`:271-280`；`README.md:269-270`。
- **事实**：
  - `README.md` 记录了 `JAVA_LSP_MAX_RUNTIME_ENTRIES`（默认 16，LRU 驱逐）和 `JAVA_LSP_RUNTIME_ENTRY_TTL_MS`。源码里没有任何地方读这两个变量。`oldestIdleEntry` 定义了但没有调用方。
  - runtime entry 只靠 idle TTL 退役，pin 仓库不退役。`IndexOwner` 对 workspace 数量没有上限。
  - 每个 workspace 对应一个原生 FSEvents helper 进程、一份 tracker 内存视图（census 在 owner 里有 tracker.view、tracker.cache、WorkspaceIndex.base、owner.contents 几份拷贝）和 F5 的周期成本。
  - HTTP daemon 监听 127.0.0.1，校验 Host 和 Origin，但没有任何凭据。不带 Origin 的请求一律放行。`repoRoot` 可以是任意绝对路径。
- **推断**：
  - agent 在 TTL 内访问很多 worktree 时，helper 进程数、内存和后台 hash 量线性增长，没有背压。
  - 本机任何进程（包括其他用户的进程）都能让 daemon 索引任意目录，并通过 `java_symbol` 的 preview 读到该目录下的源码片段。对已在 `projects.json` 启用 LSP 的仓库，还能触发 JDT 启动和 Gradle 导入。
  - 单用户 Mac 上这个暴露面可以接受，但它目前是隐含假设，没有写进设计边界。
- **建议**：
  - 实现文档里的 entry 上限，或者从 README 删掉这两个变量；给 `IndexOwner` 加 workspace 上限，超限时按 LRU 退役非 pin 的。
  - `owner-endpoint.json` 已经是 0600 文件，在里面加一个随机 token，stdio relay 带上，daemon 校验。成本很低。

### F7（P2）tracker verify 在大量目录事件下是二次复杂度，且跑在 owner 线程

- **位置**：`snapshot/workspace-tracker.ts:429-430`、`:486-493`、`:322-323`。
- **事实**：
  - `suspect()` 对每个文件执行 `[...round.subtrees.keys()].some(...)`，每次调用都复制一遍 subtree 键数组。
  - paths 模式下，对每个 subtree 前缀都执行 `for (const existing of [...entries.keys()])`，每次复制整份 census 的键。
  - 内容根下的目录事件都会登记为 subtree。父子前缀不去重，会各走一遍。
- **推断**：切分支时如果创建或删除了大量目录，设 S 个 subtree、N 个 census 成员，开销是 O(S×N) 次字符串比较加 S 次长度为 N 的数组复制。S=2000、N=50000 时约一亿次操作，全部是同步的，会阻塞 owner 事件循环秒级。
- **建议**：
  - dispatch 时把 subtree 前缀去重（去掉被祖先覆盖的），排序后用二分或前缀树判断。
  - subtree 数超过阈值时直接升级为 full-stat。
  - 删除 subtree 成员时利用 census 键有序的性质做范围删除。

### F8（P2）知识图谱每次构建都写，但没有产品读者

- **位置**：`java-index/sql/schema.ts:68-85`（`kg_node`、`kg_edge` 及 owner 表）；`index-builder/incremental.ts:543-583`、`:887-903`；`index-builder/cold-build.ts`；`java-index/sql/sql-queries.ts:1-6`；`src/context-engine/`、`src/java-knowledge/`（非测试约 3300 行）。
- **事实**：
  - 全量和 delta 构建都通过 `KnowledgeGraphBuilder` 写 `kg_*` 表。delta 的 `regraph`、`dispatch`、`xml` 等规则有相当一部分是为了保持这些行正确。
  - 这些表的读取路径是 `contextGraph`、`graphDigest`、`graphReachable` 三个 query op。它们在 `src` 里的调用方只有 `benchmark-agent-impact.ts`。`java_context` 工具在 L1 FAIL 后已经不注册（`mcp-server-factory.ts:22`）。
  - `context-engine` 只通过 `sql-queries.ts` 被引用。
  - schema 注释里有先例：v13 删除了"no product reader"的 `kg_summary`。
- **推断**：
  - 每次构建在图谱上花的时间、snapshot 体积、seal 和 verifier 的检查量，都没有对应的产品收益。
  - 更重要的是复杂度：delta 的依赖闭包规则是 F2 的风险来源，其中一部分只为图谱服务。
- **假设**：图谱可能是为后续的 Java specialist 计划保留的。如果是，这是一个已知的在途成本，应当写明。
- **建议**：先测量图谱在构建时间和文件体积里的占比。如果后续计划不在近期使用它，就停止构建并删除相关的 delta 规则；如果要用，在计划里写明读者和时间点。

### F9（P3）已校验的 snapshot 不再复查，查询期的 SQLite 错误没有上报路径

- **位置**：`snapshot/snapshot-store.ts:143-187`（open 时只核对 manifest 和文件大小）、`:290-292`；`snapshot/index-owner.ts:183-187`。
- **事实**：
  - snapshot 得到 VERIFIED 之后只在 `bindVerified`（另一个 workspace 零差异绑定它）时重新 hash。
  - 查询 worker 返回的错误一律转成 `INDEX_PARTIAL`，不触发校验或隔离。
  - `seal.ts` 头部写明不保证掉电持久性；`handle.sync()` 在 macOS 上是 `fsync`，不是 `F_FULLFSYNC`。
- **推断**：掉电或磁盘问题损坏了一个已校验的 snapshot 之后，空闲的 workspace 会一直返回查询错误，直到有编辑产生新 snapshot（新 snapshot 由 verifier 发现问题后隔离并全量重建）。
- **建议**：查询返回 SQLite 损坏类错误时，把该 snapshot 的 verdict 作废并重新入队校验。

### F10（P3）关停路径的 deadline 不是绝对时间

- **位置**：`http-server.ts:232-250`、`:421-424`。
- **事实**：`shutdownInternal` 先 `drain(deadlineMs)`，再调用 `application.shutdown(deadlineMs)`，后者内部又以完整的 `deadlineMs` drain 一次并关闭 JDT。信号处理里的强制退出定时器是 `shutdownGraceMs + 1000`。
- **推断**：请求 drain 用掉接近 30 秒时，JDT 的正常关闭和 Gradle domain 清理会被强制退出打断，进程以 1 退出。
- **建议**：整个关停共用一个 `DeadlineBudget`，各阶段从剩余时间里取。

### F11（P3）每轮 round 在 publish 后重读整份 census

- **位置**：`snapshot/index-owner.ts:920`、`:969-978`。
- **事实**：publish 成功后 `this.base = undefined`，下一轮 `baseOf` 重新通过查询池读取 `contentEntries`（全部成员的路径和 hash）。
- **推断**：每次编辑的 round 都有一个与仓库大小成正比的 IPC 和反序列化成本，还占用一个查询 worker（见 F4）。
- **建议**：publish 后用本轮的 `verification.entries` 直接构造新 base。census 分歧（`censusDiverged`）时才回退到重读。

### F12（P3）全量构建在单个事务里完成，磁盘下限没有覆盖 WAL

- **位置**：`index-builder/incremental.ts:1248-1252`（`withAsyncTransaction` 包住整个 job，含 `full()`）；`snapshot/index-owner.ts:144`。
- **推断**：全量构建期间未提交的页都在 WAL 里，峰值磁盘占用约为数据库大小的两倍。512 MiB 的下限只在建 job 前检查一次，大仓库的全量构建可能在中途写满磁盘。上一轮 review 已说明这个下限"不是容量估算"，这里补充的是峰值的来源。
- **假设**：我没有读 `cold-build.ts` 内部是否分段提交。
- **建议**：用同一 buildKey 下最近一个 snapshot 的大小乘以系数来估算，或者构建期间周期性检查剩余空间并提前失败。

### F13（P3）文档与代码漂移，以及残留的旧层

**文档（事实）**：
- `README.md:202`：查询 worker 数量与代码不符（见 F4）。
- `README.md:269-270`：两个环境变量没有实现（见 F6）。
- `README.md:211`、`:273`、`:292`：仍在描述 `index.sqlite` 由首次 `java_status` 冷建、janitor 按 TTL 删除、手工处理 WAL。这是 ILV2 之前的模型。
- `src/tools/README.md`：列出了 `java-context.ts`，该文件不存在。
- `HANDOFF.md` 74 KB，`docs/` 37 MB，`artifacts/` 193 MB。证据归档和当前设计文档混在一起，新读者很难找到权威描述。

**从生产入口不可达的代码（事实，共约 6700 行，其中 benchmark 约 3900 行）**：
- `java-index/sql/sql-client.ts`（606 行，ILV2 之前的读写客户端）
- `discovery/query-worker.ts`（434 行）
- `java-index/local-builder.ts`、`local-index.ts`
- `agent-router/retrieval/cost-scorecard.ts`、`repair-policy.ts`、`retrieval-policy.ts`
- `context-engine/compact-bridge.ts`

**仍可达但语义已空的层（事实）**：
- `JavaLspApplication` 的 `stdio` transport 模式只在测试和 benchmark 里构造。生产的 stdio 入口是纯转发。
- `JavaIndexClientApi` 上的 `refresh`、`reconcile`、`ensureFresh`、`flush`、`awaitPrewarmReady` 在 snapshot 客户端里都是空实现（`request-view.ts:291-300`）。
- 所有权机制有四层并存：原生 fd4 锁、`RepoOwnershipManager`、`FileCrossProcessLeaseStore`、`RuntimeLifecycleGate`。前两层的职责在单 owner 模型下有重叠。

**建议**：先修 README 的事实错误；旧层的清理单独排期，清理前确认 canary 与生产 daemon 并存时仍然需要哪些跨进程租约。

### F14（P3，推断，置信度低）LSP slot 预留可能被 `stopEntry` 覆盖

- **位置**：`repo-runtime-manager.ts:858-883`、`:1058-1066`。
- **推断**：`reserveLspSlot(A)` 在 `await stopEntry(B)` 期间，如果 B 收到新请求并开始重启 JDT，`stopEntry` 末尾的 `B.lspReservation = "NONE"` 会让 A 通过容量检查，随后 B 的 STARTING 事件又把自己标回占用，结果多占一个 slot。
- **限制**：跨进程 JDT slot 租约是硬上限，所以最坏情况是 B 的启动在租约上等待或失败。我没有核对 session 内部 stop 与 start 的排队顺序，这一条需要用测试确认后再决定是否处理。

## 5. 已知未决事项的优先级建议

上一轮 review 推迟的"根目录 `st_dev` 变化"（`workspace-tracker.ts:52-54`、`snapshot-store.ts:740-749`）建议提高优先级。

- **事实**：workspaceId 包含 `st_dev`；`rootState` 在 `dev` 不一致时判定为 `gone`；owner 打开时立即跑一次 sweep。
- **推断**：重启后设备号变化时，所有 binding 在第一次 sweep 里被判为 gone 并连同 snapshot 一起删除，随后所有 workspace 同时排队全量构建，而全量槽只有一个。这是一次全局性的可用性事件。
- 上一轮撤回过"保留 gone binding 的 snapshot"的方案，因为它违反 GC 合同。根治仍然需要卷 UUID。在根治之前，一个不改合同的缓解是：owner 打开后的第一次 sweep 延后到 pin 仓库的 workspace 启动之后，让旧 snapshot 有机会作为 seed 被新 workspaceId 零差异绑定。这需要确认 seed 候选是否包含已 untracked 的旧 binding（`seedCandidates` 遍历 `bindings`，按代码是包含的）。

## 6. 做得好、不建议动的部分

- binding 的 CAS 条件完整：generation、epoch、root 身份、bindingVersion、水位、content、buildKey 逐项检查（`snapshot-store.ts:506-529`）。
- 子进程的 slot 和租约只在进程真正 close 之后释放，被杀但未回收的进程会被报告而不是假定已死（scheduler 和 query pool 一致）。
- 请求只做一次 acquire，标签冻结，publish 不影响已持有的视图；NOT_READY 时拒绝回答而不是借用兄弟 workspace 的数据。
- 负查询有明确的准入条件，partial 不伪装成 complete。
- 故障注入点（`faultAt`）覆盖了 publish 和 reclaim 的每个边界。

## 7. 建议的处理顺序

1. 在 Mac 上编译并跑通 `4b84cf6` 涉及的测试，补 F3 tracker 测试（上一轮的合入门槛，仍未满足）。
2. F1：janitor 改允许名单。改动小，风险不可逆。
3. F3 中的 `findExecutable`（无超时）和 `assertOwnerLock`（频率最高）。
4. 给 F4、F5、F8 补测量：`queue_full` 和被杀 worker 的次数、周期 hash 与 verifier 的耗时占比、图谱在构建时间和体积里的占比。这三项的处理方式取决于数据。
5. F2：先加 CI 门（成本最低），再设计后台对照和血缘上限，与 F5 的 verifier 调整一起做。
6. F6、F7，以及第 5 节的 `st_dev`。
7. 其余 P3。

## 8. 未覆盖的风险

- **检索质量**：`agent-router`（58 个文件）的 ranking、readPlan 预算和证据模型只看了入口，没有评审算法和阈值。
- **JDT 层**：`jdtls-lsp-io.ts`、`semantic-gateway.ts`、`semantic-edge-store.ts`、`cross-process-lease.ts`、`repo-ownership-lease.ts` 没有逐行读。JDT 启动的状态机只读了主路径。
- **提取与解析**：`ast-extractor.ts`、`name-resolver.ts`、`edge-builder.ts`、`cold-build.ts` 的正确性没有评审。F2 只针对 delta 与全量的等价机制，不涉及全量本身是否正确。
- **原生代码**：`native/macos/` 下只读了 `ilv2-mac.c` 的 clone 部分，`fsevents.h` 和 `owner-lock.h` 没有读。
- **安装与发布**：`install-runtime.sh`（40 KB）、签名、launchd 模板、`scripts/` 下的门禁脚本都没有评审。
- **测试**：没有运行任何测试，也没有评估测试覆盖的充分性。

## 9. 处置记录（分支 `fix/architecture-review`）

本轮只改代码，**没有编译，也没有运行任何测试**。下表中的"已修"均指代码已改、未验证。重大项（F1、F2、F3 中的 `assertOwnerLock`、F6、第 5 节）各自经过一次独立 review，其余项修完后统一 review 一次。

| 项 | 处置 | 变更位置 / 理由 |
|---|---|---|
| F1 | 已修 | `worktree-cache-cleanup.ts`：<br>• 新增 `unsafeCacheBase`：cache base 解析为真实路径后，若是 `/`、`$HOME` 或其祖先、`~/Library`、`~/Library/Caches`，拒绝清理并记日志。<br>• 只处理目录名为 12 位 hex 或 meta 中带 `repoRoot` 的目录，其余归入 `unrecognizedDirs`，不扫描也不删除。<br>• 无 `repoRoot` 的目录在删除前重读一次 meta。 |
| F2 | 部分修复 | • 新增 meta 键 `deltaDepth`：cold build 写 0，每次 delta 在本次事务内写入 base+1。<br>• 自身 base 的深度达到 `JAVA_LSP_MAX_DELTA_LINEAGE`（默认 256）时，改走全量，`fullReason=lineage-limit`。<br>• 新增 `scripts/check-facts-revision.mjs` 作为手动合入门禁：相对 merge-base，提取/构建代码有改动但 facts 版本没动时失败；可用 `--ack` 放行。<br>• **未做**：后台 full-vs-delta 对照构建。它需要和 F5 的 verifier 调度一起设计，成本较高。 |
| F3 `findExecutable` | 已修 | 按名字做进程级缓存（只缓存找到的路径），`spawnSync` 加 10 s 超时，超时单独记日志；保留 login shell，因为 launchd 下的 PATH 不含用户 profile。 |
| F3 `assertOwnerLock` | 已修 | `owner-lock.ts`：<br>• 新增 `assertOwnerLockHeld`：若 fd 4 的 dev/ino/nlink 与 `.owner.lock` 路径都和上次 native 校验一致，就跳过 native 调用。<br>• commit 点仍走完整校验。 |
| F4 | 只加测量 | • query pool 新增 `counters()`，统计 `queueFull` 和 `runKills`，通过 HTTP 无选择器的 `java_status` 的 `index.queryCounters` 暴露。<br>• 协作退出窗口、内部读取独立配额、请求层准入，等有数据后再决定。 |
| F5 | 只记录 + 澄清 | • 周期 full hash 到期时，`requireDueFullHash` 会推进 seq，因此到期期间到达的请求**会**在 1 s 上限内等待。已把 `index-owner.ts` 中"不被等待"的注释改为与代码一致。<br>• 按需 hash、全局读并发上限、verifier 改为按血缘深度触发，都需要先测量。round 事件里已经带有 mode 和耗时，可以直接统计。 |
| F6 鉴权 | 不做 | daemon 只监听 loopback，浏览器侧已有 Host/Origin 校验。单用户 Mac 上，能连 loopback 的本地进程本来就以同一用户身份运行，可以直接读源码和 cache，token 挡不住它。直连 URL 注册的 `streamable_http` 客户端也带不上每次启动都会变的 token。曾实现为可选开关，经确认后撤掉。多用户共享机器时再考虑（需要持久化 token）。 |
| F6 entry 上限 | 已修 | • `JAVA_LSP_MAX_RUNTIME_ENTRIES`（默认 16）：新建 entry 后若超出上限，按 LRU 退役一个空闲且未 pin 的 entry。<br>• 选中的 victim 同步打标，防止并发 create 重复选同一个；某个 entry 转为空闲时会再检查一次。 |
| F6 workspace 数 | 只记录 | 没有给 owner 的 workspace 单独设上限。推断（未核对）：entry 退役时会停止它的 workspace tracker，因此 workspace 数受 entry 上限间接约束；需在 Mac 上确认。 |
| F7 | 已修 | • subtree 前缀先去掉被覆盖的子前缀，再按祖先路径查集合，复杂度从 O(文件 × 前缀) 降为 O(文件 × 路径深度)。<br>• 一轮的 subtree 数超过 256 时直接走 full-stat。 |
| F8 | 只记录 | 是否删除图谱取决于 post-ILV2 计划是否使用它。建议先在 Mac 上测量图谱在构建时间和文件体积中的占比。 |
| F9 | 已修 | 查询返回 SQLite 损坏类错误时，`doubtVerified` 撤销内存中的 VERIFIED 结论并重新排队校验；如果复查结果是 FAILED，走既有的隔离流程。同一 snapshot 每个进程只撤销一次，避免检测不到的损坏导致反复整文件校验。 |
| F10 | 已修 | 关停全程共用一个绝对截止时间，application drain 和 JDT 关闭使用剩余时间；强制分支的 `forceClose` 保持原来的 `min(1000, grace)`，不从剩余时间里取。 |
| F11 | 已修 | publish 成功且 census 未分歧时，下一轮的 base 直接复用本轮的 `verification.entries`，不再通过查询池重读整份 census。 |
| F12 | 已修（估算） | • 开构建前的磁盘下限改为 `max(MIN_FREE_BYTES, 基底快照大小 × (full ? 2 : 1))`；构建期间不做周期检查。<br>• 因 `lineage-limit` 触发的全量是可选的：空间不足 2× 时本轮继续走 delta，不会每轮被拒。 |
| F13 文档 | 已修 | 更新 README：<br>• 查询 worker 数（最多 2 个）；<br>• 删除未实现的 `JAVA_LSP_RUNTIME_ENTRY_TTL_MS`；<br>• 补充 `JAVA_LSP_MAX_DELTA_LINEAGE`；<br>• 去掉 ILV2 之前的 `index.sqlite` 和 WAL 描述。<br>`src/tools/README.md` 删除了不存在的 `java-context.ts`。 |
| F13 死代码 / 旧层 | 只记录 | 清理前需要确认 canary 与生产 daemon 并存时还需要哪些跨进程租约，单独排期。 |
| F14 | 只记录 | 置信度低，需要先用测试复现。跨进程 JDT 租约是硬上限，最坏情况是启动等待。 |
| 第 5 节 `st_dev` | 已修（缓解） | • owner 打开后 10 分钟内（`RENUMBERED_GRACE_MS`），若某个 binding 的根目录 ino 不变、只有 dev 变了，GC 保留它（`root-renumbered`）。<br>• 同根的旧快照在 seed 候选中排在最前，新 workspaceId 可以零差异绑定。<br>• 这是对"两个 GC 周期收敛"的有界例外，不影响删除的安全判定。<br>• 排在窗口之后才启动的 pin 仍然全量重建。根治仍需要卷 UUID。 |

**review 后仍未处理的已知问题**：
- **F1**：
  - 与 hash 同名的外部目录仍会被当作仓库目录。
  - `reapAbandonedWorkspaceJdtls` 没有 allow-list。
  - cache base 被拒绝时只记日志，不会导致启动失败。
- **F2**：
  - seed delta 不检查血缘深度（seed 很少见；下一轮回到自身 base 时会计入）。
  - 门禁脚本按目录粗粒度匹配，会有误报，用 `--ack` 处理。本分支自身需要 `--ack "deltaDepth is meta, not fact rows"`。
- **F3**：快路径察觉不到别处的 `LOCK_UN`（依赖不当行为），也没有测试。
- **F9**：撤销结论到复查完成之间，`failed()` 会顺着血缘查到父节点；若父节点恰好被判 FAILED，该 snapshot 在这段时间内也被当作 failed（不再作为 seed/base）。窗口短，结果偏保守。
- **F12**：没有 base 的首次全量构建仍只检查 512 MiB 下限；必须做的全量（no-base、input-limit 等）空间不足时仍按退避重试并保持 STALE，这是原有语义。
- **批量 review 已修**：
  - overflow 退役不再连锁多退：已选中的 victim 不计入存活数，`shutdownAll` 期间不触发。
  - seed 候选顺序的注释已修正。

**建议在 Mac 上运行**：
1. 先执行 `npm run build:isolated`。
2. 测试：
   - `src/worktree-cache-cleanup.test.ts`
   - `src/http-server.test.ts`
   - `src/stdio-owner-proxy.test.ts`
   - `src/repo-runtime-manager.test.ts`
   - `src/java-index/snapshot/*.test.ts`（含新增的 renumbered 用例）
   - `src/index-builder/*incremental*.test.ts`
   - `src/java-index/snapshot/query-pool.test.ts`
   - `scripts/owner-daemon.test.mjs`
3. 门禁脚本：`node scripts/check-facts-revision.mjs`。

# R09 — 贯通绝对 deadline 与真实物理预算（Q03 / K29）

**Status**: DONE（GREEN；SQL 导出层、真实 parser/writer 冷建库、共享只读 worker、真实 stdio MCP 运行态；三仓负载已测，性能门槛未签）
**源码基线**: `b22c0a5`（R05–R08 评审修复）；RED 在该提交上取得
**Date**: 2026-10-09

## 结论

- Q03 由 FAIL 转为 PASS。27 条反例的结果变为 23 PASS / 4 FAIL，剩余 4 条都属于 R10（D01–D04）。
- 请求入口已过期时，直接返回 `PARTIAL / deadline`，不读 status，也不执行任何 SQL。请求中途到期时，跳过还没开始的路由，只对已收集的结果做有界收尾。每个阶段都有 begin/end/remaining/visited 的 trace。
- profile 证明，主线程直接跑同步 SQLite 会超过 20ms 的 event-loop 门槛，所以按设计引入一个共享的有界只读 query worker：队列上限 32，并发 1，过期的等待者出队，超时的查询强制终止，等线程退出后才返回结果，并且不影响 writer。
- 门槛对照只是本机记录，不作签署：三个仓库的主线程 event-loop P95 都 ≤1.9ms；单并发 warm P95 都 ≤57ms；20 并发 P95 中 lishuedu 为 332ms，超过 150ms 目标，另外两个仓库为 29ms 和 105ms。

## RED / GREEN

| 轮次 | 命令 | 结果 | 证据（`java-specialist-audit-runs/`） |
|---|---|---|---|
| RED | `run_audit.py --project . --cases Q03`（`b22c0a5`） | FAIL：`remainingMs()=0` 的 exact 请求返回 `exact: "match"`，没有 stopReason | `r09-red/`、`r09-red.log` |
| GREEN | 同命令，本提交 | PASS | `r09-green/`、`r09-green-final/` |
| 全量反例 | 27 条 | 23 PASS / 4 FAIL / 0 ERROR，只有 Q03 由 FAIL 转为 PASS，剩余 D01–D04（R10） | `r09/audit-all/` |

## 根因

1. `searchDetailed` 只在 posting 行之间检查 deadline。exact 路由不扫描 postings，所以已过期的请求照样执行 exact 查找并返回 match。discovery 也没有入口检查。
2. 统计、排序、合并、locator 和 preview 都没有计入 deadline，也没有分阶段的计量。
3. 物理成本：每条 posting 都要加载实体行，外加 2 次 `symText` 点查。lishuedu 的宽泛查询在默认 20000 条 posting 预算下，主线程同步阻塞 p95 达 110–431ms（`r09/profile-main-thread.log`，before 段）。

## 机制

1. **入口与阶段 deadline**
   - `QueryWorkBudget.expired()` 是唯一的判断入口。`searchDetailed` 入口过期时不开快照、不执行 SQL，返回 `truncated: true, stopReason: "deadline", work.postings: 0, trace: []`。
   - 每条路由开始前都检查 deadline（`expiredBefore`）；exact 在每个候选之前、每一行之间也检查。
   - 中途到期时，后续路由不再执行，已持有的 top-K 照常完成 merge 和 locator。locator 最多 cap 次点查，属于有界收尾。
   - 被打断的 exact 查找不报告 outcome，避免把"没查完"说成 miss。discovery 同样不会自己补成 miss。
2. **discovery 入口**
   - `runStaticDiscovery` 入口已过期时，不调 `status()` 也不调 `querySearch()`，scope 记为 `NOT_RESOLVED`。
   - stopReason 优先级：没有读到快照的扫描（`queue_full`，或 `deadline` 且 generation 为 0）排在 `changed_during_request` 之前，因为没有 generation 可以比较；已经读到快照、中途才到期的扫描，如果 generation 变了，仍报 `changed_during_request`。
   - 入口过期和 `queue_full` 时，结果的 `generation` 为 0，表示没有读快照。这和"库的 generation 真的是 0"在协议上无法区分，只在类型注释里说明。
3. **trace**：`QueryTrace` 记录这些阶段：`status`、`query`、`sql:exact-lookup`、`sql:postings:<route>`、`sql:rank:<route>`、`sql:merge`、`sql:locators`、`preview`。每个阶段都带 begin/end/remainingMs/visited。trace 只在 `trace: true` 时返回，MCP 线上协议不携带。
4. **SQL 优化（排序结果不变）**
   - posting 扫描只取整数列（entity sym、token sym、tf、长度），token 文本由查询词的 sym 表映射回来。
   - 排序按分数档位分批解析实体 ID（`selectTop`）：截断位置所在的整个平分档都参与 ID 排序，所以结果与全量 (score desc, id asc) 排序相同。只给最终的 top-K 加载实体行和 evidence。
   - 同一查询词重复出现时只扫描一次，不再重复计入 posting 预算。
   - 改动前后 7 个代表查询的 top-3 完全相同（`r09/profile-main-thread.log`）。
5. **共享只读 query worker**（`src/discovery/query-worker.ts`，profile 证明需要才新增）
   - 整个进程只有一个线程，服务所有仓库。`SqlJavaIndexClient.querySearch` 把剩余时间换算成绝对 deadline 交给 worker；`:memory:` 库仍在进程内执行。
   - 队列上限 32，满了直接返回 `queue_full`（PARTIAL）。查询并发为 1。
   - 等待中的请求到期就出队返回 `deadline`，不会进入 worker。
   - 扫描本身在每行之间检查 deadline，正常情况下会准时返回 PARTIAL。如果查询超过 deadline + 250ms 仍没返回（卡在 JS 层），就 `terminate()` 线程，等 `exit` 之后才 resolve，此时它的读快照和连接都已释放。线程退出之前不拉起第二个线程，下一次请求再重新拉起。
   - **这个上界的限制**：Node 22 的 `node:sqlite` 没有 interrupt 或 progress handler，`Worker.terminate()` 要等当前这一步原生 SQLite 调用返回才生效。评审实测，在 worker 里执行一条 3.6s 的递归 CTE，200ms 时调用 terminate，3.4s 后才完成。因此，单步就很长的原生调用不受 deadline + grace 约束（例如带 scope 的扫描在 SQLite 内部跳过大量范围外的行）。主线程不受影响，被终止的那个请求会晚于 deadline 才 settle。
   - worker 自己开只读连接，不与 writer 共享。按 dev:ino 识别库文件，重建或替换后的新文件不会被旧连接继续读。连接空闲超过 `connIdleMs` 后关闭。
   - `SqlJavaIndexClient` 在 close、空闲回收和 reload（可能对应新的库文件）时一律调用 `release()`；没有 worker 时这个调用什么也不做。空闲回收时，要等 worker 确认关闭连接后才做 WAL 压缩。release 的确认按线程记账：一个线程退出时，只结清自己的待确认 release。
   - worker 空闲时 `unref()`，不会让进程常驻；忙碌时 `ref()`。
   - 只返回有界的结果行（≤ cap+1 个命中及 trace）。
   - 全部查询统一套用 posting 预算：原来没有预算的调用方，无论走 worker 还是 `:memory:` 进程内路径，现在默认最多扫描 `DEFAULT_QUERY_MAX_POSTINGS = 20000` 条，超出时返回 `candidate_budget`。
6. **负载工具**：`src/benchmark/measure-query-load.ts` 新增 `runStepLoad`。它走真实边界（`SqlJavaIndexClient` → `runStaticDiscovery` → worker），按并发 1/5/10/20 步进，每档 100 个样本，记录 P50/P95/P99、event-loop 延迟、队列峰值、各 stopReason 计数、RSS 和 settled 状态。另有一档在查询期间让另一个连接每 100ms 提交一次、推进 generation。`--repo` 必须配一个临时 `--db`；`--db` 落在索引缓存目录（`repoCacheBase()`）下时直接拒绝，因为带写入的那一档会修改 generation。

## Profile 与负载（本机：darwin arm64，Node v22.19.0；只作记录，不签门槛）

改动前后的同步扫描耗时，lishuedu（40,273 个实体、1,467,116 条 entity posting），warm，20 个样本，默认 posting 预算：

| 查询 | before p95（主线程） | after p95（在 worker 中） | postings |
|---|---|---|---|
| 稀有 FQN exact | 0.36ms | 0.44ms | 0 |
| `order` | 110.2ms | 17.0ms | 6,159 |
| `service` | 291.5ms | 48.1ms | 20,000（预算） |
| `user list query page` | 430.8ms | 50.8ms | 20,000（预算） |
| `get` | 207.2ms | 28.1ms | 10,398 |
| `save`（auto） | 46.7ms | 8.7ms | 2,950 |

SQLite 自身扫描约 1µs/posting（只看整数列的聚合微基准：4029 行 4.35ms）。所以 20000 条 posting 不可能在主线程 20ms 内完成，这是引入 worker 的依据（docs/03 §3）。

步进负载：每档 100 个请求，deadline 1000ms，查询组合为稀有 FQN、普通词、中文、宽泛、模糊（`r09/load-<repo>/query-load-report.json`）：

| 仓库 | c=1 P95 | c=5 P95 | c=10 P95 | c=20 P95 | event-loop P95（各档最大值） | event-loop max | 带写入（c=20）P95 / changed_during_request |
|---|---|---|---|---|---|---|---|
| lishuedu | 56.7ms | 85.0ms | 208.7ms | 331.7ms | 1.34ms | 4.35ms | 408.6ms / 78 |
| exam-parent-v3 | 22.5ms | 28.0ms | 53.5ms | 104.6ms | 1.70ms | 4.70ms | 107.8ms / 56 |
| cipherlink | 7.1ms | 9.6ms | 15.0ms | 29.4ms | 1.91ms | 2.62ms | 28.6ms / 0（只发生 1 次提交） |

- 所有步骤都 settled：没有残留的排队或运行中请求，0 次终止，0 次 `queue_full`。队列峰值等于并发数减 1，不超过 32。
- 带写入的步骤中，跨越提交的请求如实返回 `PARTIAL / changed_during_request`，没有出现把两个快照拼成 READY 的结果。
- lishuedu 20 并发的 P95 超过 150ms，因为 worker 并发为 1，请求串行排队。稀有 FQN 自身只要约 1ms，但会排在宽泛查询后面（c=20 时 P95 为 251ms），存在队头阻塞。

## 回归锁

| 用例 | 层级 | 文件 |
|---|---|---|
| 入口已过期的 exact：`stopReason=deadline`、`work.postings=0`、无 exact outcome、`trace=[]`；用已关闭的连接证明一条 SQL 都没执行（Q03） | 真实冷建库 | `src/discovery/query-deadline.test.ts` |
| discovery 入口已过期：不读 status、不发查询，结果 PARTIAL/deadline，scope 为 NOT_RESOLVED | discovery | 同上 |
| `deadline` / `queue_full` 不会被标成 `changed_during_request` | discovery | 同上 |
| 在 postings 阶段到期：后续路由跳过，merge/locators 仍执行，保留的命中仍可定位，postings 有上界 | 真实冷建库 | 同上 |
| exact 被打断时 SQL 层和 discovery 层都不报告 outcome | 同上 | 同上 |
| trace 覆盖 status→sql:*→preview 各阶段，字段齐全；`query` 阶段计入的 postings 等于各路由之和；没有 `prefetch-entire-graph`；默认不带 trace | 同上 | 同上 |
| 截断位置落在超过 cap 的平分档内时，结果仍等于全量排序 | SQL | 同上 |
| worker 与进程内执行返回相同的行（text/exact）；只有一个线程 | worker | `src/discovery/query-worker.test.ts` |
| 已过期的请求不入队、不拉起线程；同时提交 40 个：`queuePeak=32`，7 个 `queue_full`，33 个完成 | worker | 同上 |
| 等待者在自己的 deadline 出队（<250ms），没有进入 worker | worker | 同上 |
| 运行中的查询卡住时，在 deadline+grace 内被终止，线程退出后才返回；之后 writer 的 `wal_checkpoint(TRUNCATE)` 返回 busy=0；下一次请求重新拉起线程 | worker | 同上 |
| worker 内阻塞 250ms，主线程 event-loop 不受影响 | worker | 同上 |
| worker 正忙时调用 `release()`，要等连接真正关闭（lsof 看到句柄数为 0）才返回；关闭 pool 后不留句柄 | worker | 同上 |
| 正在终止一个卡住的线程时（模拟 terminate 等待 400ms），新请求排队等待，不拉起第二个线程；它在新线程上完成，release 由新线程确认 | worker | 同上 |
| 中途到期但已读到快照、且 generation 变了：报 `changed_during_request`；generation 没变：报 `deadline` | discovery | `src/discovery/query-deadline.test.ts` |
| 20 并发步进：`queuePeak<=32`，全部 settled，只出现 `none` / `candidate_budget`；写入期间出现 `changed_during_request` | 真实边界 | `src/benchmark/measure-query-load.test.ts` |
| 20 个并发 `java_symbol` 查询全部 READY、0 错误、exact 命中正确、线上不带 trace | 真实 stdio MCP | `r09/r09-runtime.mjs`；评审修复后共跑 4 次，3 次 PASS（`runtime-r09-rerun2/3.log`），1 次因冷建库 `database is locked` 失败（`runtime-r09.log`），这个失败早于 R09 就存在，见限制一节 |

调整的既有测试（意图不变）：

- R08 的 "deadline 停止源码读取" 测试，改为在查询返回之后才到期。入口就过期的情况现在根本不会走到 preview，由新测试覆盖。
- K20 测试的写入时机，改为在读快照打开之后才提交。原来是第一次调用 `remainingMs()` 时提交，而这一次调用现在变成了入口检查。

变异检查（`r09/mutations/`）共 15 个，每个都会让新测试失败：

- SQL 入口不检查 deadline
- 路由到期后仍继续执行
- 被打断的 exact 仍报告 outcome
- discovery 入口不检查 deadline
- discovery 把被打断的 exact 补成 miss
- generation 检查优先于未开始扫描的 deadline
- 中途到期的 deadline 盖掉 generation 变化
- 终止期间拉起第二个线程
- top-K 不扩展平分档
- 队列无上限
- 等待者不出队
- 不终止卡住的查询
- 终止时不等线程退出
- `release()` 不等 worker 确认
- client 绕过 worker 在进程内执行

## 回归面

| 项 | 结果 |
|---|---|
| scripts 评测 + live e2e / experiments | 77/77 / 30 + 1 SKIP |
| 原 12 个源码探针 | 12/12 |
| 冻结自检（仓库内 / 原版） | 5/5 / 5/5，summary sha `5f6f4cb1…` 未变 |
| `check_bundle.py` / kit 单测 | PASS 357 / OK |
| R07、R08 运行态脚本（真实 stdio MCP，走 worker） | 均 PASS（`r09/runtime-r07.log`、`r09/runtime-r08.log`） |
| `npm run build:isolated` / `npm test` | PASS / 1264 + 339 PASS，0 FAIL（`r09/build-isolated.log`、`r09/npm-test.log`） |

## 独立评审（提交前）

独立评审没有提出 P1。

- **P2-1**：强制终止期间会拉起第二个线程，旧线程退出时会把新线程的 release 也一并结清。评审已复现，本提交修复：终止完成前不拉起新线程，release 按线程记账；有测试和变异覆盖。
- **P2-2**：卡在原生 SQLite 单步里时，kill 上界不成立。评审已实测，平台不提供 interrupt，本提交在代码注释和本报告中写明，并把测试名改为 JS-side stall。
- **P3**：
  - 中途 deadline 盖掉 generation 变化：已修。
  - `:memory:` 路径没有默认预算：已修。
  - `dropConn` 后排队的请求重新打开的连接、以及 rename 之后旧 inode 被占用：改为 close 和 reload 时一律 release。
  - 负载工具对生产缓存的保护只是建议：改为直接拒绝。
  - `generation=0` 有歧义：只写明，不改协议。
  - reload 和异步 WAL 压缩之间的先后次序：没有修，后果只是 WAL 可能没被截断。

## 限制与剩余缺口

- **门槛没有签署**。lishuedu 20 并发的 P95 超过 150ms；稀有 exact 存在队头阻塞（后续按低并发设计：排队中的 exact 优先于宽泛查询，见 `r09-followups.md` §2）。可能的方向是按 exact/宽泛分队列或调整优先级，需要单独的设计与 profile，不在本轮范围。按 K29，这一项仍留在统一矩阵中。
- 线程被强制终止后，SQLite 连接靠线程环境清理来关闭。本轮观测到 checkpoint busy=0、lsof 句柄为 0，但没有在 Linux 上验证。原生单步耗时很长时，终止要等这一步结束（见机制 5）。
- 带 scope 的扫描中，被过滤掉的 posting 不计入预算，SQLite 内部的扫描量没有上限。这个问题早于 R09 就存在。（已在后续修复：按 keyset 分页检查 deadline，见 `r09-followups.md` §3。）
- legacy `queryEntitySearch` / `search()` 仍在主线程执行，且没有预算，不在 R09 列出的文件范围内。（更正：这条路径在生产中没有调用方，不是 java_impact 的词法回退；后续已加上 posting 上限和请求 deadline，见 `r09-followups.md` §4。）
- RSS 只记录整个进程的数值，没有把 daemon 和 worker 分开。
- 带写入的步骤用合成提交（推进 generation）模拟刷新，没有跑真实 builder 进程。
- 主线程上的单次 status 读和 preview 文件读不经过 worker：status 是元数据点查，preview 是异步 IO。
- **早于 R09 就存在的缺陷（未修，单独跟进）**：冷建库期间如果反复调用 `java_symbol`（每 500ms 一次，300 个文件），builder 子进程的 `BEGIN IMMEDIATE` 偶发 `database is locked`，冷建库失败，索引一直不能 READY。同一个脚本在 `b22c0a5` 上跑 3 次，失败 2 次，3 次都出现锁错误（`r09/runtime-r09-base1..3.log`）；在本提交上跑 4 次，失败 1 次。推测与 BUILDING 期间 `awaitPrewarmReady → dropConn → compactWalFile` 打开读写连接有关，但未验证。（后续已定位并修复：主因是只读连接关闭时执行 checkpoint，`compactWalFile` 的写提交是第二个原因；见 `r09-followups.md` §1。）

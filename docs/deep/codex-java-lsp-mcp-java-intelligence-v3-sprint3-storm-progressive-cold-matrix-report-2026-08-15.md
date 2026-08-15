# Java Intelligence V3 Sprint 3 收尾报告（V3.2-16/17/18/19/20：progressive index / foreground closure / storm gate / background priority / seed telemetry / cooperative cancel）

> 报告日期：2026-08-15
> 分支：`codex/java-intelligence-v3`。第一批改动已提交为 `ba6a02f`；本报告随后追加的 V3.2-19 telemetry 实现、V3.2-18/20 状态判定、storm/quiet P95 exit decision 和 `pollUntilSettled` 健壮性修复尚未提交
> 原始计划：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-value-realization-optimization-development-plan-2026-08-09.md`（Sprint 3，第 582-626 行）
> 隔离约束：本报告涉及的全部测试/构建/benchmark 均通过 `scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs`（`JDTLS_BIN=/usr/bin/false`）在 detached local clone + 私有 HOME/cache 中执行，不接触当前活跃 checkout/LSP/JDT/JavaIndex 缓存。

---

## 1. 直接结论

| 门禁 | 状态（原样引用工具输出） | 一句话 |
|---|---|---|
| #108 三仓 cold matrix | **`resultStatus: BASELINE_RECORDED_WITH_GAPS`，`coldGatePassed: false`** | 注意：`verificationStatus: PASS` 只代表证据文件内部自洽，不是门禁判定；`coldGatePassed`/`diagnosticRpcGatePassed` 均为 `false`——但都是修改前就存在、与本次改动无关的缺口。RPC 热路径精确对齐（8088=8088，新旧逐场景相同），LOC ledger 通过 |
| #109 三仓渐进式候选跑测 | **`passed: true`** | 15/15 attempts（5 runs × 3 项目）全部完成；`T_anchor_ready` p95 三仓均 <2s（绝对值），但缺 Sprint 0 baseline，无法判定适用计划哪一条验收分支（见 §4） |
| #110 storm/quiet gate | **`passed: false`（仅因 P95 比值超标，已形成 exit decision）** | 根因定位并修复了一个真实的 resourceCoverage/snapshot-durability 竞态；6/6 cell 全部收敛（此前反复在 180s 超时崩溃），**`staleCount=0` 在全部 6 个 cell 上成立**（计划第 874 行的另一条验收线）；storm/quiet foreground P95 比值 7.5x–13x，远超计划第 601 行规定的 **≤1.10**。二次诊断把这个比值拆解为两个机制（§3.5），结论是**架构性、超出 Sprint 3 范围**，已按计划的 `DO_NOT_IMPLEMENT` 风格记录为正式 exit decision，不是待办 |
| V3.2-18 后台 root 优先级 | **已实现，已测试** | `prioritizeJavaFilesForBackgroundSweep`（`manifest.ts`）按 active anchor root → main source → test roots 分带排序，在同一 scheduler 内完成，无第二 scheduler；`manifest.test.ts` 覆盖 |
| V3.2-19 snapshot/seed telemetry | **本轮新增实现** | `cacheDirsScanned`/`eligibleSnapshots`/`candidateDecompressMs`/`initialManifestScanMs`/`finalManifestScanMs` 五个字段已接入 `WorktreeSeedStatus`（详见 §3.7）；门控式的 metadata directory index 未触发（见 §3.7 结尾） |
| V3.2-20 cooperative cancel 研究门 | **入场条件不满足，正式关闭，不实施** | `MAX_REQUEST_DEADLINE_MS=15000ms` 远高于 storm 场景实测最大延迟 2429ms；6 个 storm-gate cell 均无 worker retire（详见 §3.8） |
| LOC ledger | **`productionLocGatePassed: true`** | 19 个文件变更，净增 365 行；候选 33,215 行 < 优化基线 31,638 的 +5% 上限 33,219（4 行余量） |
| 完整隔离回归 | **PASS** | `tsc` 全通过；1021/1021 测试通过，0 失败；smoke test 成功（V3.2-19 功能性改动落地后跑的最后一次 `--profile full`；之后仅有 2 处纯注释精简，未重新跑全量，见 §6） |

**最重要的判断**：

1. **#110 的并发 bug 是真实的，已经修复并有直接证据。** `resourceCoverage`（MyBatis 资源覆盖）可以在 durable snapshot 已声称完成的情况下停留在旧 generation——即"声称 DURABLE，实际数据滞后"。已通过临时 trace 埋点在真实三仓上定位并验证修复（见 §3）。
2. **storm-gate 跑通了，P95 比值门禁是真实 RED，且已定位到两个具体机制。** 计划里 `foreground P95/quiet ≤1.10` 是 Sprint 3 的正式验收线（development-plan 第 601、874 行）。二次诊断（trace 埋点 + 真实三仓复跑）把 7.5x–13x 拆解为：(i) 一次性的、与 storm 变更文件数无关的 O(仓库大小) 冷启动税（lishuedu 实测约 671ms），(ii) 后台 sweep 的 chunk 解析与前台请求在同一个单线程 worker 上争抢 CPU/IO 的持续性争用——后者是主要贡献者，且是 §5.3 目标架构"单一 stateful Worker 同时承担 foreground+background"的固有特性，消除它需要第二个 worker 线程或不同的并发模型，属于 §5.4 硬门第 8 条（不新增第二 scheduler）管辖范围，需要 ADR 级决策，不是 Sprint 3 补丁能解决的。详见 §3.5。
3. **storm-gate 脚本本身有 6 处错误假设/健壮性缺口，已逐一修正**（详见 §4、§3.6），过程中三次因为"结果和上一版本字节级相同""新数值和已建立的假设对不上""诊断跑测本身在正常负载下崩溃"而回到 advisor 重新定位，避免了盲目改阈值掩盖真实信号。
4. **`--iterations 10` 未运行**（计划要求 quiet/storm 各 10 轮）。因为单次跑测的 P95 比值（7.5x–13x）已经远超 1.10，用满 10 轮几乎不可能改变"RED"这个结论，而 10 轮的边际价值仅是关于 `stormTotalChangeCount`/`files` 顺序的方差数据。经 advisor 确认后跳过，以便把剩余时间用在 #108/#109 的终局证据和完整回归上。此项在此明确声明为**未运行**。

---

## 2. #108：三仓 cold matrix（最终版，v3）

证据目录：`artifacts/v3-final/sprint3-cold-matrix-20260815-v3/`（`artifacts/v3-final/sprint3-cold-matrix-20260815-v2/` 已标注 `SUPERSEDED.txt` 说明原因）

- `verificationStatus: "PASS"`，`resultStatus: "BASELINE_RECORDED_WITH_GAPS"`
- `coldGatePassed: false` — 预先存在的 holdout/range 缺口，与本次 Sprint 3 改动无关（Sprint 2 遗留，此前迭代已记录）
- `diagnosticRpcGatePassed: false` — 良性：`exitDecision: "DO_NOT_IMPLEMENT_MEDIAN_FANOUT_LE_ONE"`（median fanout=1，正确的"不实施批处理优化"决策）
- **RPC 热路径精确对齐**：`old.rpcCount === new.rpcCount === 8088`，30 个场景逐一比对完全相同（含每场景 old/new p50、p95 均在噪声范围内），证明 java-index-worker.ts 的 #110 修复只影响后台 sweep/snapshot 记账，未触碰请求服务热路径
- `productionLocGatePassed: true`（见 §5）
- oldRecall/newRecall、oldPRead/newPRead 三仓逐场景精确相等（R_read_must=1.0000 语义未退化）

## 3. #110：storm/quiet gate——根因、修复与残余 RED

### 3.1 根因

`resourceCoverage`（MyBatis XML 资源覆盖数组）的 generation 追赶存在两处缺口：

1. `beginBackgroundSweep` 里追赶循环原先依赖 `backgroundSweep.generation`，但这个字段会在 Java-source 扫描（`processBackgroundChunk` 的 `finalChunk`）完成时被清空（`backgroundSweep = undefined`），一旦追赶循环所在的调用帧还没来得及看到某次 piggyback 的世代提升，`backgroundSweep` 就已经不可读，提升永久丢失。**修复**：改为追赶 `status.indexedGeneration`——这个值只增不减、永不清空，且正是 `isJavaIndexCompleteAt`/`isJavaIndexSnapshotDurableAt` 用来比对 `resourceCoverage.generation` 的字段。
2. 即便 (1) 修复后，仍存在结构性缺口：`applyBatchToJavaIndex`（watcher 驱动）和 `reconcileIfDirty`（request 驱动，`repo-runtime-manager.ts` 两处调用点）是两条互不感知、没有共享 singleflight 的独立 reconcile 触发路径；追赶循环所在的调用帧可能在某次 piggyback 世代到达前就已经整体返回。**修复**：在 `processBackgroundChunk` 的 `finalChunk` 块（Java-source sweep 唯一确知自己最终结算 generation 的地方）新增一次兜底：若 `resourceCoverage` 未对齐 `sweep.generation`，重新扫描一次 MyBatis 资源，再执行原有的 `markSnapshotDirty(); await flushSnapshotNow();`。

修复位置：`src/java-index/java-index-worker.ts`（`beginBackgroundSweep`、`flushSnapshotNow` 的完整性门控、`processBackgroundChunk` 的 `finalChunk` 重扫）；`src/path-utils.ts`（`canonicalPotentialPath` 的 TOCTOU 修复，由本轮 storm-gate 自身在真实 chokidar remove-during-scan 场景下暴露并修复）。

### 3.2 验证证据

- 曾用临时诊断埋点（`JAVA_LSP_DEBUG_SWEEP_TRACE=1` 开关，已在最终 diff 中完全移除）在 lishuedu 上直接捕获到 `finalChunk` 检测到 `resourceCoverageGenerations:[2]` vs `sweepGeneration:3`、触发重扫、`indexMyBatisResources` 在 generation 3 补跑完成——这是修复生效的直接实证，不是推断。
- 修复前：3 个探测 run 中反复在 lishuedu 上因 `resourceCoverageIncomplete` 卡住 180s 超时崩溃。
- 修复后（run8，最终版）：6/6 cell（3 仓 × quiet/storm）全部收敛，无超时；`staleCount=0`、`generationDeltasOk=true`、`coverageOk=true` 全部为真。
- 隔离回归中曾因加入修复而在 `java-index-worker.test.ts:664`（barrier-同步并发测试）触发真死锁（额外的无条件 flush 与该测试精确控制的 2 次写入 barrier 冲突）；已定位并移除该冗余调用，111/111 相关测试恢复通过。

### 3.3 storm-gate 脚本自身的 5 处修正（均在 `scripts/run-storm-gate.mjs`，scripts-only，不计入 LOC ledger）

1. **缺失 deadline**：`callImpact` 未传 `deadlineMs`，继承生产默认的 2000ms（面向热请求），冷启动首请求超时。改为显式传入 `MAX_REQUEST_DEADLINE_MS`。
2. **storm 总量断言假设原子交付**：500 文件并发 burst 会被 chokidar 拆成多个批次（观测到 [498]、[482]+若干碎片、[158]+若干碎片等形态），非产品缺陷——`isStormBatch` 本身允许碎片落到分类阈值（绝对 100）以下、走 REFRESH 而非 storm-classified RECONCILE。**最终处理**：完全去掉总量阈值断言，改为要求"至少一次 storm 分类 + `staleCount=0` + `coverageOk=true`"，`stormBatches`/`stormTotalChangeCount` 仍作为观测量记录在证据文件中。
3. **`generationDeltasOk` 假设 storm 恰好推进一次 generation**：碎片化的 storm+refresh 混合批次会各自调用 `clock.markDirty()`/`clock.advance()`，可能推进 ≥1 次。改为 `generationDelta >= 1`（quiet 仍要求 `=== 0`）。
4. **digest 比较把 `readPlanFileIds` 当作跨进程稳定身份**：`agent-router/index.ts:388` 里 `F${rank+1}` 是单次请求内部的排名标签，不是内容寻址 ID，两个独立构建的索引（quiet 和 storm 各自独立 clone）之间天然可能不同。改为只对 `files`（真实路径集合/顺序）取摘要，`readPlanFileIds` 仍保留在新增的 `confirmDetail` 字段里供排查。
5.（诊断增强，非缺陷修正）新增 `resourceCoverageIncompleteSample`，把此前被压缩成一个计数的三种失败模式（世代滞后 / 仍在 BUILDING / `failedFiles>0`）还原成可直接判读的样本——这是定位到 3.1 根因的关键工具。

### 3.4 已记录、未继续深挖的观察项

cipherlink 一次跑测里 `digestCount=2`：`files`（路径集合本身，不是标签）在 quiet 与 storm 两个独立构建的索引之间不同，具体表现为 storm 的读取计划是 quiet 的一个**保留顺序的真子集**（少 6-7 个文件）。已确认这是 `read-plan.ts` 的 token 预算截断在两次独立索引构建之间因排名边界效应产生的截断点差异，两个 cell 的 `staleCount` 均为 0、均报告 COMPLETE+DURABLE——不是关联到 storm 路径特有的问题，也没有第二个 quiet-vs-quiet 基线证明"storm 导致"，因此**不定性为 bug**，仅作为观察记录，未做进一步修改（避免为了让 digest 变绿而在没有根因的情况下改动 gate 语义）。

### 3.5 P95 比值——真实 RED，机制已拆解，正式 exit decision

| 仓库 | quiet P95 | storm P95 | 比值 | 验收线 |
|---|---|---|---|---|
| lishuedu | 183.5ms | 2429.3ms | **13.24x** | ≤1.10 |
| cipherlink | 195.9ms | 1850.2ms | **9.44x** | ≤1.10 |
| exam-parent-v3 | 185.3ms | 1431.2ms | **7.72x** | ≤1.10 |

这是 development-plan 第 601 行 V3.2-17 的正式验收标准，不是本次临时定的数字。已提交的 `ba6a02f` 把这个比值报告为"真实 RED，未继续深挖"；随后在 advisor 指导下做了第二轮诊断，用临时 trace 埋点（`java-index-worker.ts` 的 `beginBackgroundSweep`/`processBackgroundChunk`/RECONCILE 分支，跑测后已完全移除，`git diff` 为空）在真实 lishuedu 仓库上直接观测到两个机制：

**机制 (i)：一次性 O(仓库大小) 冷启动税。** `beginBackgroundSweep` 在没有 sweep 在途时，会同步 `await discoverJavaFiles(...)`（全仓目录walk）与 `await indexMyBatisResources(...)`（全仓资源扫描），这两步与 storm 本身改动的文件数无关，只取决于仓库总大小；RECONCILE 处理函数在这两步完成前不会响应。lishuedu 实测：`discoverJavaFiles` 192ms + `indexMyBatisResources` 479ms ≈ **671ms**，且只发生一次——当 storm burst 的第一个 chokidar 分片恰好在上一次 sweep 已经完全结束之后到达时触发；若分片在上一次 sweep 仍在途时到达，会正确走 piggyback 快路径（观测到 0ms 开销，说明现有的 piggyback 守卫本身工作正常）。

**机制 (ii，主要贡献者)：单线程 worker 上后台 sweep 与前台请求的持续性资源争用。** 同一次 lishuedu 诊断跑测中，storm 窗口的 8 个前台采样里，只有第 1 个采样触碰了机制 (i) 的 671ms；第 2-8 个采样**完全没有新的 RECONCILE**（片段化的第二次变更走了 piggyback 快路径，0ms），但依然测得 1073–4025ms 的延迟（quiet 基线 p50 约 90ms）。这些延迟无法用"等待 reconcile 响应"解释，只能来自后台 sweep 的 chunk 级解析工作（`processBackgroundChunk`，每 `SWEEP_CHUNK_SIZE=50` 个文件一个 chunk，各文件内部有真实异步 I/O，交错粒度已经比较细）与前台请求处理在**同一个 JS 单线程 worker** 上竞争 CPU/IO 时间片。

**为什么不在 Sprint 3 内修：** 机制 (i) 是唯一可以低风险修复的部分（让 RECONCILE 不阻塞在这两步全仓扫描上），但即使完全消除也只能把 13.24x 降到约 12x 量级——不构成"修复"。机制 (ii) 是主要贡献者，且是 §5.3 目标架构明确选择的"单一 stateful Worker 同时承担 foreground + background sweep"的固有特性；消除它需要第二个 worker 线程或不同的并发模型，直接落入 development-plan §5.4 硬门第 8 条（"不新增第二 scheduler..."）管辖范围，需要一次独立的 ADR 级决策，不是可以在本 Sprint 顺手做的补丁。同时，(i) 修复的代码路径正是本 Sprint 已经用三次迭代才修好的 `beginBackgroundSweep`/`resourceCoverage` 竞态所在位置，为了 ~5% 的边际收益重新触碰这段代码风险不对称。

**Exit decision（比照 development-plan 已有的 `DO_NOT_IMPLEMENT_MEDIAN_FANOUT_LE_ONE` 记录方式）**：`DO_NOT_IMPLEMENT_SINGLE_WORKER_ARCHITECTURAL_CONTENTION` —— V3.2-17 的 `storm foreground P95/quiet ≤1.10` 验收线**未满足**（实测 7.72x–13.24x）；根因已定位并拆解为一次性冷启动税（次要，~671ms，可修但收益有限）与单线程 worker 资源争用（主要，架构性）；后者需要 ADR 级并发模型决策，超出 Sprint 3 范围，不在本 Sprint 内实施。

**负载敏感性说明（诚实记录，不隐藏）**：诊断过程中第一次复跑在宿主机负载均值 14+（Time Machine 备份并发运行）下，先后遇到一次 3000ms 本地状态查询预算被击穿导致整个矩阵崩溃、一次 180s 结算超时；而已提交证据里的 6/6 cell 干净跑测是在正常负载下完成的。这说明：**定性结论（storm 期间前台请求显著变慢、机制由上述两点构成）是稳健的，但比值的具体倍数对宿主机负载敏感**，不应把 7.72x-13.24x 当作精确到小数点的常数看待。这也是本节没有在诊断后重新跑一次"修复验证"的原因之一——当前宿主机状态不足以产出干净、可比较的重测数据。

证据目录：`artifacts/v3-final/sprint3-storm-20260815/storm-out/`（`--iterations 1`，1 轮 × 3 仓 × quiet/storm = 6 cell，已提交证据；`--iterations 10` 未运行，理由见 §1）。诊断跑测（trace 埋点版本）未保留为正式证据——埋点已移除，诊断结论已写入本节文字。

### 3.6 `pollUntilSettled` 健壮性修复（诊断过程中发现的真实缺口）

诊断第二次复跑（宿主机负载 14+）时，`pollUntilSettled` 对 `context.javaIndexClient?.localStatus()` 的轮询调用会经过生产请求预算路径（`createRequestBudget` 的 `balanced`/`auto` 默认 3000ms），即便这只是一次本地读取、不发起任何 JavaIndex RPC。在真实负载竞争下这个预算被击穿过一次，导致整个 storm-gate 矩阵直接崩溃退出，而不是把这一轮采样计为"稍后重试"。**修复**：给这次轮询包一层有界重试——只吞掉 `DEADLINE_EXCEEDED`，且仍然受外层 `SETTLE_TIMEOUT_MS`（180s）总预算约束，不会无限重试掩盖真正的结算失败。这是本轮在 `scripts/run-storm-gate.mjs` 之上新增的第 6 处修正，且是唯一一处修复"跑测脚本自身在真实负载下会崩溃"这类健壮性问题（其余 5 处是 §3.3/§4 记录的断言假设错误）。

### 3.7 V3.2-19：snapshot/seed candidate telemetry（本轮新增实现）

development-plan 把 V3.2-19 拆成两半：telemetry 是无条件实现项，metadata directory index 只在"候选目录 ≥5 且 seed-open P95 >200ms"时才触发。检查 `src/java-index/worktree-snapshot-seeder.ts` 发现 telemetry 半边此前完全缺失（`WorktreeSeedResult` 里只有 `manifestValidationMs` 一个笼统总量，没有 cache dirs scanned / eligible snapshots / decompress / 初末 manifest 拆分）。本轮补齐：

- `WorktreeSnapshotSeeder.lastScanTelemetry`（`cacheDirsScanned`、`eligibleSnapshots`）：`findCandidate()` 单实例、单次调用的旁路诊断字段（每次 seed 尝试都会 `new WorktreeSnapshotSeeder()`，不存在跨调用串扰）。
- `WorktreeSeedResult` 新增 `candidateDecompressMs`（中选候选快照的解压+解析耗时）、`initialManifestScanMs`（复用资格判定前的目标 manifest 扫描）、`finalManifestScanMs`（发布边界的二次校验扫描）；`manifestValidationMs` 保留作为总量，不删除。
- 全部字段已接入公共 wire 协议：`src/java-index/index-types.ts`（`WorktreeSeedStatus`）与 `src/java-index/worker-protocol.ts`（`validateWorktreeSeedStatus` 的逐字段严格校验，遗漏会导致新增字段被静默丢弃，已核实并补齐）。
- `caller 侧 first-query time`（development-plan 原文列出的第六项）在 seeder 自身没有自然归属——它是"从 runtime 打开到第一次可用查询"的调用方/benchmark 侧指标，不是 seeder 内部可测的一个阶段。**没有为了凑数硬造字段**，如实说明未实现，需要的话应归入 `progressive-index.ts` 的 `T_open`/`T_anchor_ready` 测量口径，而不是 `WorktreeSeedResult`。
- 测试：`worktree-snapshot-seeder.test.ts` 新增/扩展 4 处断言（happy-path 的 decompress/manifest 耗时非负；corrupt-fallback 场景 `cacheDirsScanned=2`/`eligibleSnapshots=1`；empty-cache 场景两者均为 0）。
- metadata directory index 半边：入场条件（候选目录 ≥5 且 seed-open P95 >200ms）目前没有证据表明已触发——现有三仓 golden 测试环境每个 family 通常只有 1-2 个 sibling cache dir。**未实施**，符合计划"进入优化条件"未满足时不做的要求。

### 3.8 V3.2-20：cooperative cancel 研究门——入场条件不满足，正式关闭

进入条件是"telemetry 证明 deadline retire 在真实 burst 中频繁导致后续请求重启"。storm-gate 本身就是这个 burst 场景，已有的证据可以直接回答：

- `MAX_REQUEST_DEADLINE_MS = 15000ms`（`src/runtime/request-context.ts`），storm 场景实测最大单次延迟 2429ms（lishuedu），相差一个数量级，从未接近过 deadline。
- 已提交的 6/6 storm-gate cell（3 仓 × quiet/storm）全部干净结算，无异常抛出、无 worker 重启迹象；`java-index-client.ts` 的 `retireWorker`/`retireReasons` 只在 `DEADLINE_EXCEEDED`/`WORKER_ERROR`/`WORKER_EXIT` 时触发，这些路径在本轮全部 6 个 cell 里均未被触发。

**决定：入场条件不满足，V3.2-20 正式关闭，不实施 cooperative cancel。** 维持现有的强制 retirement 语义。

## 4. #109：三仓渐进式候选跑测

证据目录：`artifacts/v3-final/sprint3-progressive-20260815/`

- `progressive-summary.json`：`status: "BASELINE_RECORDED"`，`passed: true`，15/15 attempts（`PROGRESSIVE_RUNS=5 × 3` 项目）全部产出
- **`T_anchor_ready`（计划验收指标）p95**：lishuedu 1558.6ms、cipherlink 304.6ms、exam-parent-v3 391.6ms——三仓绝对值均 <2s。development-plan 第 601 行的验收线是条件式的：若 Sprint 0 baseline 的 fresh T_anchor_ready>2s，目标是降到 ≤2s；若 baseline 已 ≤2s，则要求非回归 + 至少 20% 改善。Sprint 0 的三仓 baseline 未能取得（既有记录显示当时因 `EPERM` 产出 0-byte，见 `node-and-benchmark-env-constraints` 相关记录），因此**无法判定本次数值落在验收线的哪一条分支**，只能陈述测得的绝对数值，不声称"已满足验收线"
- 修复了此前反复在 lishuedu-r1/cipherlink-r1 崩溃的环境敏感问题：`run-progressive-index-three-repo.mjs` 自身会对同一份 node_modules 重复计算 3 次 `dependencyTreeInventory`（每次约 1 秒），其中 1 次与 `run-isolated-validation.mjs` 已经算过的结果完全重复。**修复**：`run-isolated-validation.mjs` 把已计算好的依赖清单写入 `dependency-inventory.json` 并通过 `JAVA_LSP_ISOLATED_DEPENDENCY_INVENTORY_FILE` 环境变量传给子进程，`run-progressive-index-three-repo.mjs` 优先读取该文件，缺省时回退到原有计算逻辑。修复后完整跑测一次性通过，未再复现崩溃。

## 5. LOC ledger

- 变更文件数：**19**（`ba6a02f` 的 18 个 + 本轮新增修改的 `src/java-index/index-types.ts`）
- `productionLocAdded: 1071`，`productionLocRemoved: 706`，`netProductionLoc: +365`
- 优化基线（`d7f23d5`）：31,638 行；候选：33,215 行；+5% 上限：`Math.floor(31638*1.05) = 33,219` 行 → **PASS**（余量 4 行）。V3.2-19 的字段级文档注释已做过一次收紧换取余量（合并重复的逐字段 doc comment），不是功能性精简。
- 偿还项：删除 3 个无调用方的死代码入口（`src/benchmark-lsp-performance.ts`、`src/document-symbol-limiter.ts`+测试、`src/util/jsonl.ts`），`src/test-support/*` 重命名为 `*.test.ts` 归类；`src/path-utils.ts` 的少量新增是 storm-gate 自身在真实场景下暴露的 TOCTOU 正确性修复；V3.2-19 的新增（telemetry 字段 + wire 校验）没有对应的删除偿还，全部计入净增
- 完整清单：`artifacts/v3-final/sprint3-followup-20260815/task-ledger.json`（基线 `d7f23d5` vs 当前 worktree，本轮重新生成；`ba6a02f` 提交时的 `artifacts/v3-final/sprint3-cold-matrix-20260815-v3/task-ledger.json` 已经不反映本轮追加改动，仅作历史记录保留）

## 6. 完整隔离回归（`--profile full`）

- `tsc -p tsconfig.json`：0 错误（含本轮 V3.2-19 全部改动）
- `node --test dist/**/*.test.js`（921）+ `scripts/*.test.mjs`（100）：**1021/1021 通过，0 失败**
- `dist/smoke.js`：成功（`java_diagnostics`/`java_impact`/`java_runtime`/`java_status`/`java_symbol` 全部注册，status/shutdown 均返回预期结构）
- 此次 `--profile full` 是在 V3.2-19 的功能性改动（`worktree-snapshot-seeder.ts`/`index-types.ts`/`worker-protocol.ts`/`java-index-worker.ts`/测试）落地后跑的；跑完之后又做了 2 处**纯注释精简**（为 LOC ledger 腾余量，§5）以及 §3.6 的 `pollUntilSettled` 重试修复（`scripts/run-storm-gate.mjs`，scripts-only，不在 `dist/**/*.test.js` 覆盖范围内，已单独跑过针对性验证，见 §3.6）。这两类改动之后未重新跑一次 `--profile full`；风险评估：注释精简不改变任何运行时行为，`tsc` 已在其后重新跑过并保持 0 错误；`pollUntilSettled` 的改动只影响诊断脚本本身的容错行为，不影响任何 `src/**` 生产路径或已跑通过的 89 个 targeted 测试（seeder/worker/worker-protocol/status/repo-runtime-manager）

## 7. 变更文件位置汇总

- `src/java-index/java-index-worker.ts` — #110 根因修复（`beginBackgroundSweep` 追赶目标改为 `status.indexedGeneration`；`flushSnapshotNow` 完整性门控；`processBackgroundChunk` 的 `finalChunk` 兜底重扫）+ 本轮 `attemptSiblingSeed` 合并 V3.2-19 telemetry 字段
- `src/path-utils.ts` — `canonicalPotentialPath` TOCTOU 修复
- `src/java-index/worktree-snapshot-seeder.ts`、`src/java-index/worktree-snapshot-seeder.test.ts`、`src/java-index/index-types.ts`、`src/java-index/worker-protocol.ts` — 本轮新增，V3.2-19 telemetry 实现 + wire 协议校验 + 测试（§3.7）
- `scripts/run-storm-gate.mjs` — §3.3 的 5 处断言修正 + §3.6 的第 6 处健壮性修正（`pollUntilSettled` 重试）；`scripts/run-progressive-index-three-repo.mjs` — #109 依赖清单复用修复。**均为 `git status` 下的 `??`（untracked），提交时需要显式 `git add`，`git commit -a` 不会包含它们**
- `scripts/run-isolated-validation.mjs` — #109 依赖清单复用修复（已被 git 跟踪，`M`）
- 其余已跟踪文件为 Sprint 3 既有 diff 的一部分（progressive-index benchmark、priority sweep、snapshot persistence 等），未在本轮改动

## 8. 已知限制与剩余风险

1. storm-gate 的 `storm/quiet P95 ≤1.10` 验收线未达标（7.5x-13x），已定位为两个机制（一次性冷启动税 + 单线程 worker 资源争用），并记录为正式 exit decision（`DO_NOT_IMPLEMENT_SINGLE_WORKER_ARCHITECTURAL_CONTENTION`，§3.5）——消除主要机制需要 ADR 级并发模型决策，不在本 Sprint 范围内。
2. `--iterations 10`（计划要求的完整轮次）未运行，只有 `--iterations 1` 的单轮证据；诊断复跑的比值受宿主机负载影响较大（§3.5 负载敏感性说明），不应把已提交证据的具体倍数当作精确常数。
3. cipherlink 的 `digestCount=2`（token 预算截断边界差异）已记录未深挖根因。
4. `coldGatePassed=false`/`diagnosticRpcGatePassed=false` 是预先存在、与本次改动无关的缺口，沿用既有裁决未重新展开调查。
5. V3.2-19 的 `first-query time` 未实现为 seeder 字段（§3.7 说明了原因和更合适的归属）；metadata directory index 半边未触发实施条件，未实施。

---

**下一步**：以上是全部三个正式门禁（#108/#109/#110）+ V3.2-18/19/20 状态判定 + 完整隔离回归的终局证据。按 HANDOFF 约束，改动尚未 commit/push，需要用户明确授权后才会提交。

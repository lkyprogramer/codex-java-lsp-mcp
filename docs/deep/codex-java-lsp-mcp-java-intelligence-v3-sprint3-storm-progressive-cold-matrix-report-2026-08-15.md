# Java Intelligence V3 Sprint 3 收尾报告（V3.2-16/17/18：progressive index / foreground closure / storm gate）

> 报告日期：2026-08-15
> 分支：`codex/java-intelligence-v3`（HEAD 仍为 `d7f23d5`，本报告完成前未 commit）
> 原始计划：`docs/deep/codex-java-lsp-mcp-java-intelligence-v3-value-realization-optimization-development-plan-2026-08-09.md`（Sprint 3，第 582-626 行）
> 隔离约束：本报告涉及的全部测试/构建/benchmark 均通过 `scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs`（`JDTLS_BIN=/usr/bin/false`）在 detached local clone + 私有 HOME/cache 中执行，不接触当前活跃 checkout/LSP/JDT/JavaIndex 缓存。

---

## 1. 直接结论

| 门禁 | 状态（原样引用工具输出） | 一句话 |
|---|---|---|
| #108 三仓 cold matrix | **`resultStatus: BASELINE_RECORDED_WITH_GAPS`，`coldGatePassed: false`** | 注意：`verificationStatus: PASS` 只代表证据文件内部自洽，不是门禁判定；`coldGatePassed`/`diagnosticRpcGatePassed` 均为 `false`——但都是修改前就存在、与本次改动无关的缺口。RPC 热路径精确对齐（8088=8088，新旧逐场景相同），LOC ledger 通过 |
| #109 三仓渐进式候选跑测 | **`passed: true`** | 15/15 attempts（5 runs × 3 项目）全部完成；`T_anchor_ready` p95 三仓均 <2s（绝对值），但缺 Sprint 0 baseline，无法判定适用计划哪一条验收分支（见 §4） |
| #110 storm/quiet gate | **`passed: false`（仅因 P95 比值超标）** | 根因定位并修复了一个真实的 resourceCoverage/snapshot-durability 竞态；6/6 cell 全部收敛（此前反复在 180s 超时崩溃），**`staleCount=0` 在全部 6 个 cell 上成立**（计划第 874 行的另一条验收线）；但 storm/quiet foreground P95 比值 7.5x–13x，远超计划第 601 行规定的 **≤1.10** |
| LOC ledger | **`productionLocGatePassed: true`** | 18 个文件变更，净增 297 行；候选 33,147 行 < 优化基线 31,638 的 +5% 上限 33,219 |
| 完整隔离回归 | **PASS** | `tsc` 全通过；1021/1021 测试通过，0 失败；smoke test 成功 |

**最重要的判断**：

1. **#110 的并发 bug 是真实的，已经修复并有直接证据。** `resourceCoverage`（MyBatis 资源覆盖）可以在 durable snapshot 已声称完成的情况下停留在旧 generation——即"声称 DURABLE，实际数据滞后"。已通过临时 trace 埋点在真实三仓上定位并验证修复（见 §3）。
2. **storm-gate 跑通了，但 P95 比值门禁是真实 RED，不是脚本问题。** 计划里 `foreground P95/quiet ≤1.10` 是 Sprint 3 的正式验收线（development-plan 第 601、874 行），不是随手写的占位值。实测 7.5x–13x 说明"500 文件并发 reconcile 期间前台请求变慢"这件事目前离验收线还很远，这是本次跑测的真实发现，未做任何放宽处理。
3. **storm-gate 脚本本身有 5 处错误假设，已逐一修正**（详见 §4），过程中两次因为"结果和上一版本字节级相同"或"新数值和已建立的假设对不上"而回到 advisor 重新定位，避免了盲目改阈值掩盖真实信号。
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

### 3.5 P95 比值——真实 RED

| 仓库 | quiet P95 | storm P95 | 比值 | 验收线 |
|---|---|---|---|---|
| lishuedu | 183.5ms | 2429.3ms | **13.24x** | ≤1.10 |
| cipherlink | 195.9ms | 1850.2ms | **9.44x** | ≤1.10 |
| exam-parent-v3 | 185.3ms | 1431.2ms | **7.72x** | ≤1.10 |

这是 development-plan 第 601 行 V3.2-17 的正式验收标准，不是本次临时定的数字。500 文件并发 reconcile 期间 foreground 请求变慢是可以解释的（后台 sweep 与前台请求竞争同一 worker 线程），但目前的幅度（7-13 倍）离 ≤1.10 的目标有数量级差距，这是需要后续迭代专门处理的真实性能缺口，不属于本次 Sprint 3 范围内可以顺手修复的问题。

证据目录：`artifacts/v3-final/sprint3-storm-20260815/storm-out/`（`--iterations 1`，1 轮 × 3 仓 × quiet/storm = 6 cell；`--iterations 10` 未运行，理由见 §1）。

## 4. #109：三仓渐进式候选跑测

证据目录：`artifacts/v3-final/sprint3-progressive-20260815/`

- `progressive-summary.json`：`status: "BASELINE_RECORDED"`，`passed: true`，15/15 attempts（`PROGRESSIVE_RUNS=5 × 3` 项目）全部产出
- **`T_anchor_ready`（计划验收指标）p95**：lishuedu 1558.6ms、cipherlink 304.6ms、exam-parent-v3 391.6ms——三仓绝对值均 <2s。development-plan 第 601 行的验收线是条件式的：若 Sprint 0 baseline 的 fresh T_anchor_ready>2s，目标是降到 ≤2s；若 baseline 已 ≤2s，则要求非回归 + 至少 20% 改善。Sprint 0 的三仓 baseline 未能取得（既有记录显示当时因 `EPERM` 产出 0-byte，见 `node-and-benchmark-env-constraints` 相关记录），因此**无法判定本次数值落在验收线的哪一条分支**，只能陈述测得的绝对数值，不声称"已满足验收线"
- 修复了此前反复在 lishuedu-r1/cipherlink-r1 崩溃的环境敏感问题：`run-progressive-index-three-repo.mjs` 自身会对同一份 node_modules 重复计算 3 次 `dependencyTreeInventory`（每次约 1 秒），其中 1 次与 `run-isolated-validation.mjs` 已经算过的结果完全重复。**修复**：`run-isolated-validation.mjs` 把已计算好的依赖清单写入 `dependency-inventory.json` 并通过 `JAVA_LSP_ISOLATED_DEPENDENCY_INVENTORY_FILE` 环境变量传给子进程，`run-progressive-index-three-repo.mjs` 优先读取该文件，缺省时回退到原有计算逻辑。修复后完整跑测一次性通过，未再复现崩溃。

## 5. LOC ledger

- 变更文件数：**18**（与修复前后保持一致，仅内容行数变化）
- `productionLocAdded: 1003`，`productionLocRemoved: 706`，`netProductionLoc: +297`
- 优化基线（`94c4ebfb`）：31,638 行；候选：33,147 行；+5% 上限：33,219 行 → **PASS**（`productionLocGatePassed: true`）
- 偿还项：删除 3 个无调用方的死代码入口（`src/benchmark-lsp-performance.ts`、`src/document-symbol-limiter.ts`+测试、`src/util/jsonl.ts`），`src/test-support/*` 重命名为 `*.test.ts` 归类；`src/path-utils.ts` 的少量新增是 storm-gate 自身在真实场景下暴露的 TOCTOU 正确性修复
- 完整清单：`artifacts/v3-final/sprint3-cold-matrix-20260815-v3/task-ledger.json`

## 6. 完整隔离回归（`--profile full`）

- `tsc -p tsconfig.json`：0 错误
- `node --test dist/**/*.test.js` + `scripts/*.test.mjs`：**1021/1021 通过，0 失败**
- `dist/smoke.js`：成功（`java_diagnostics`/`java_impact`/`java_runtime`/`java_status`/`java_symbol` 全部注册，status/shutdown 均返回预期结构）

## 7. 变更文件位置汇总

- `src/java-index/java-index-worker.ts` — #110 根因修复（`beginBackgroundSweep` 追赶目标改为 `status.indexedGeneration`；`flushSnapshotNow` 完整性门控；`processBackgroundChunk` 的 `finalChunk` 兜底重扫）
- `src/path-utils.ts` — `canonicalPotentialPath` TOCTOU 修复
- `scripts/run-storm-gate.mjs` — §3.3 的 5 处修正；`scripts/run-progressive-index-three-repo.mjs` — #109 依赖清单复用修复。**两者均为 `git status` 下的 `??`（untracked），提交时需要显式 `git add`，`git commit -a` 不会包含它们**
- `scripts/run-isolated-validation.mjs` — #109 依赖清单复用修复（已被 git 跟踪，`M`）
- 其余 14 个已跟踪文件为 Sprint 3 既有 diff 的一部分（progressive-index benchmark、priority sweep、snapshot persistence 等），未在本轮改动

## 8. 已知限制与剩余风险

1. storm-gate 的 `storm/quiet P95 ≤1.10` 验收线未达标（7.5x-13x），需要专门的性能迭代（后台 sweep 与前台请求资源争用），不在本次范围内处理。
2. `--iterations 10`（计划要求的完整轮次）未运行，只有 `--iterations 1` 的单轮证据。
3. cipherlink 的 `digestCount=2`（token 预算截断边界差异）已记录未深挖根因。
4. `coldGatePassed=false`/`diagnosticRpcGatePassed=false` 是预先存在、与本次改动无关的缺口，沿用既有裁决未重新展开调查。

---

**下一步**：以上是全部三个正式门禁（#108/#109/#110）加完整隔离回归的终局证据。按 HANDOFF 约束，改动尚未 commit/push，需要用户明确授权后才会提交。

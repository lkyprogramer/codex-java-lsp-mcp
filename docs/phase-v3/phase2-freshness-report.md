# Phase 2 — Iteration B 统一仓库新鲜度 Report

## 1. Decision

**条件通过。** Iteration B（Task 9–13）实现的 9 个提交全部完成并有定向测试覆盖，
全量测试 290 个（286 pass / 0 fail / 4 skip，与 Iteration A 起 4 个 skip 一致）。

可在当前环境完整验证的部分（全量/定向测试、跨进程 lease 真实子进程冒烟、
edit-to-visible 端到端延迟）**全部 PASS**。唯一未能在本环境执行的是 Task 13
Step 3 的三仓 benchmark（黄金仓库在本环境 EPERM，见 `docs/deep/...` 及
memory `node-and-benchmark-env-constraints.md`）——**该项必须由用户在可访问
黄金仓库的环境中运行**，本报告在 §7.2 给出准确命令与门槛，不以空表或推测值
冒充已通过。

在此前提下，Iteration B 的实现侧完成门禁已满足——除机器级 sweep 槽一项
（§9 / Known Limit #2：`acquireSweep()` 无生产调用点，"从未超出"目前真空
成立而非被验证）外；`R_read_must=1.0000` 等质量门槛需三仓 benchmark
补齐后才能最终关闭。

## 2. Baseline

| 项 | Iteration A 基线（`phase1-correctness-report.md`） | 当前验证（`02db62da2908`） |
|---|---|---|
| build | exit 0 | exit 0 |
| tests | 222 | 290 |
| pass | 218 | 286 |
| fail | 0 | 0 |
| skipped | 4 | 4 |
| duration | 42.2 s | ~40 s |

新增 68 个测试，全部属于本迭代（跨进程 lease、watcher storm、janitor 多进程
活性、alias last-known-good、runtime 保留上限等）。原始输出见
`artifacts/v3-phase2/02db62da2908/full-test-run.tap`。

## 3. Scope

### Changed

| Task | Commit | 变更 |
|---|---|---|
| 9 | `2ae49f0` | `RepoChangeCoordinator`、`GenerationClock`、`WorktreeIdentity`（JDT 无关的 chokidar watcher） |
| 10 | `4b548be` | 统一 generation 贯穿 rg cache / SourceIndex / JDT cache / EdgeStore |
| 11 | `4f08e48` | delete/rename 驱逐、`LayoutManager` 指纹缓存、BUILD_CHANGE 重配置、`SourceIndex.reconcile()` |
| 12 | `d4d1b59` | 有界 stopped-runtime 保留、`AliasRegistry` last-known-good |
| 12a | `e942ff7` | `CrossProcessLeaseStore`（`FileCrossProcessLeaseStore`）：JDT worktree 互斥、机器级 JDT/sweep 固定槽、runtime 计数、容量协商、PID 存活回收 |
| 12a follow-up | `f6cf0b9` | 补齐 `acquireRuntime()` 的真实调用点（此前实现但未接线）；扩充 lease 错误码的语义降级回归测试 |
| 12b | `e036a91` | `RepoChangeBatch.storm`/`affectedRoots`、`isStormBatch`、storm 复用 `markDirty`→`reconcileIfDirty`；JDT storm 整体 clearCache；watcher 状态首次接入 `java_status` |
| 12c | `a1ec541` | `RepoCacheMetaV2`、`touchRepoCache` 合并写、janitor 决策序（lease > ownerPid > jdtlsPid > workspace lock）、`jdtlsPid` 移至 READY commit |
| 12c follow-up | `02db62d` | 补测 janitor 从不递归删除全局 `leases/` 根目录（真实 `FileCrossProcessLeaseStore` fixture） |

### Explicitly unchanged

- 公共 MCP 工具仍为 7 个，未新增工具。
- `NoopCrossProcessLeaseStore` 仍是除 `createRuntime` 外所有测试/调用点的默认 lease store，行为与 Iteration A 前完全一致。
- Tree-sitter / JavaIndex V2（Iteration C）未引入。
- per-repo `source-index.ts` 的正则解析路径未变。

## 4. Tests

```bash
NODE=/Users/luo/.nvm/versions/node/v22.16.0/bin/node
"$NODE" node_modules/.bin/tsc -p tsconfig.json && "$NODE" scripts/write-build-stamp.mjs
"$NODE" --test "dist/**/*.test.js"
```

原始输出：`artifacts/v3-phase2/02db62da2908/full-test-run.tap`
（290 tests / 286 pass / 0 fail / 4 skipped）。

Task 13 Step 1 指定的定向 mutation pattern：

```bash
"$NODE" --test --test-name-pattern="fast path cache invalidation|rename removes|delete removes|build change|last known good|stopped idle|machine JDT slot|same worktree|large change batch|git metadata|fast-only runtime" "dist/**/*.test.js"
```

45 个匹配测试全部 PASS（`artifacts/v3-phase2/02db62da2908/mutation-pattern-run.tap`）。
计划原文的部分片段（如 `rename removes`）与实际测试标题不完全逐字匹配（例如实际标题是
`a rename evicts the old path so the router stops surfacing it`），`--test-name-pattern`
是正则子串匹配，仍然命中；未按片段直译测试名。

`npm run benchmark:edit-to-visible` / `npm run smoke:lease-subprocess` 现已注册为
`package.json` scripts。**在本环境中 `npm` 本身因 nvm shell wrapper 在非交互
shell 下损坏而不可用**（`_nvm_load`/`maximum nested function level` 递归错误，
见 memory `node-and-benchmark-env-constraints.md`）；本报告的实际调用一律
使用绝对路径直接跑 node：`/Users/luo/.nvm/versions/node/v22.16.0/bin/node
scripts/<script>.mjs`。若 `npm` 在用户环境中工作正常，两个 `npm run` 别名
同样有效。

## 5. Worktree Concurrency

### 5.1 真实多进程冒烟（非同进程模拟）

`scripts/lease-subprocess-smoke.mjs` 启动**两个独立 Node 子进程**，指向同一个
临时 lease 目录，验证 `FileCrossProcessLeaseStore` 的原子 mkdir 互斥在真实
OS 进程间成立（而不仅仅是同进程函数调用）：

| 场景 | 结果 | 结论 |
|---|---|---|
| 同一 worktree，两进程并发 `tryAcquireJdt` | 进程 A `ACQUIRED`，进程 B `BUSY_SAME_WORKTREE` | `sameWorktreeSecondSpawnCalls = 0`：PASS |
| 三个不同 worktree，`jdtSlots=2`，`tryAcquireJdt`（一次性，不重试） | 恰好 2 个 `ACQUIRED`，1 个 `NO_GLOBAL_SLOT` | `maxObservedClaimedJdtSlots(=2) <= configured(=2)`：PASS |

6 次独立运行（2 个场景 × 3 轮）结果一致。原始输出：
`artifacts/v3-phase2/02db62da2908/lease-subprocess-smoke.txt`。

**一个值得记录的真实发现**：脚本最初对三 worktree 场景使用 `acquireJdt()`
（等待重试版，2s 预算）而非 `tryAcquireJdt()`（一次性），结果 3 个进程
**全部** 报告 `ACQUIRED`。排查后确认这不是生产 bug——`acquireJdt()` 在
`NO_GLOBAL_SLOT` 时每 50ms 重试一次直到预算耗尽，而每个持有者仅持锁 300ms，
因此第三个进程在别的进程释放后于预算窗口内合法地"最终获准"。这是
semaphore-with-waiting 的预期行为，但也说明：**同一时刻并发持有 ≤ 2，但
2 秒预算内三个仓库都可能被静默接纳（等待而非快速失败）**。读
`maxObservedClaimedJdtSlots` 时必须区分一次性快照（本节主用）与重试语义
下的最终接纳数，两者都是真实事实，报告口径以一次性快照为准。

### 5.2 进程内测试覆盖（非真实子进程，但已定向验证）

| 门禁项 | 证据 | 结果 |
|---|---|---|
| `staleLeaseReclaims >= 1`（dead-owner fixture） | `src/cross-process-lease.test.ts` 多个 orphan/dead-owner 回收测试 | PASS（进程内） |
| 500-file storm 只产生 1 次 background reconcile | `a 500-file batch is delivered as one storm...`（`src/worktree-storm.test.ts`） | PASS（进程内，复用 Task 11 `markDirty→reconcileIfDirty`，非独立 priority queue） |
| `janitorLiveRuntimeSkips`（live fast-only cache 不被删除） | `janitor does not delete a stale-looking cache owned by a live fast-only runtime`（`src/worktree-cache-cleanup.test.ts`） | PASS（进程内，真实 `FileCrossProcessLeaseStore` fixture） |
| `foregroundAnchorP50/P95DuringStorm` | — | **未测量**：本迭代没有构建"storm 期间前台 anchor 请求延迟"的专项 benchmark，见 §8 |

## 6. Edit-to-Visible Benchmark

黄金仓库在本环境不可读（EPERM），改用合成 fixture（`scripts/edit-to-visible-benchmark.mjs`）：
一个最小 Maven 项目 + 固定锚点类 `AnchorService`，每轮循环写入一个新的
`CollaboratorN.java`（引用 `AnchorService`），通过**生产路径**
`RepoRuntimeManager.withContext → javaImpact`（与真实 MCP 调用相同的
freshness barrier：`awaitReadyWithin → flushNow → reconcileIfDirty`）轮询直到
新文件出现在结果中，而不是断言内部 generation 状态。

| 项 | 结果 |
|---|---|
| cycles | 30（另有 1 个热身轮丢弃，冷启动 1.4–2.0s 主要是 chokidar 初始 ready 等待） |
| stale count | 0 |
| P50 | 180–191 ms（两次独立运行） |
| P95 | 295–345 ms（两次独立运行） |
| Gate（`stale=0 且 P95<=500ms`） | **PASS** |

原始输出：`artifacts/v3-phase2/02db62da2908/edit-to-visible-benchmark.json`。

P50/P95 与 150ms 的 debounce 窗口量级一致——debounce 是被测延迟的一部分，
本次未调小它去"优化"数字。**这是本机 + 合成 fixture 的结果，不是计划要求的
"reference machine"，数字仅供参考，不作为跨机器可比较的认证值。**

## 7. 三仓 Benchmark

### 7.1 状态：未运行（NOT RUN — 需要用户在其环境执行）

本环境访问三个黄金业务仓时返回 EPERM（`node-and-benchmark-env-constraints.md`
已记录此环境限制）。以下命令摘自计划 Task 13 Step 3，未在本次报告中执行：

```bash
# 与 Iteration A 相同的 cold 矩阵，针对当前 Iteration B 运行时 build 重跑
node dist/benchmark-agent-impact.js --repo <repo> --mode impact --semantic-policy fast --runs 5 ...
```

### 7.2 门槛（供用户核对结果）

```text
R_read_must = 1.0000
recall / P_read：相对 Iteration A 基线（lishuedu 0.8456/0.8667，cipherlink 0.8421/0.7000，
                  exam-parent-v3 0.7350/0.6333）不得下降
steady cold P95 <= Iteration A P95 × 1.10
  （lishuedu 255.26ms → 上限 280.79ms；cipherlink 127.73ms → 上限 140.50ms；
    exam-parent-v3 205.71ms → 上限 226.28ms）
```

在用户完成三仓 benchmark 并将结果补充到本报告前，Iteration B 的质量/延迟门槛
**不能视为已通过**；本报告不以空表或占位值代替这一验证。

## 8. Known Limits

1. **`CompositeJdtLease.heartbeat()` 从未被调用**（Task 12a）。计划要求
   READY/STARTING 每 30s 及每次语义请求心跳一次；当前活性判定完全基于 PID
   存活（`isAlive`），不依赖心跳时间戳，因此这是死代码而非 bug，但仍是对
   计划的未完成项，记录以备将来需要基于心跳的活性判定时启用。
2. **`acquireSweep()` 已实现并有单测，但生产代码从未调用**。
   `JAVA_LSP_MAX_BACKGROUND_SWEEPS` 配置了 `sweepSlots`，`status()` 会报告
   `claimedSweepSlots`，但没有任何调用点会真正申领一个 sweep 槽。因此
   "机器级 sweep 槽从未超出" 目前是**真空成立**（没有申领者，不可能超出），
   不是一个被验证过的、有实际保护作用的机器级信号量。janitor 本身是同步的、
   `acquireSweep` 是异步的，`reconcileIfDirty` 又在请求路径上不适合等待槽位，
   因此本迭代未强行接线；留给需要真正后台 sweep 任务的未来迭代。
3. **`ownerToken` 只写不读**（Task 12c）。`refreshResource` 写入、`shutdown`
   清空，但 `hasActiveOwner` 从不做 token 交叉核对，只看 lease 树 → ownerPid
   → jdtlsPid → workspace lock。后果：SIGKILL 后如果 `ownerPid` 恰好被
   另一个无关进程复用（PID 碰撞），该 worktree 缓存会被永久保护，直至
   ownerPid 对应的真实进程也退出——只造成磁盘浪费，不会返回错误结果。修复
   需要从 lease 目录里读出 token 再比对，是新代码，本迭代未做。
4. **storm 复用 `WATCHER_DEGRADED`/dirty 语义，而非独立的 storm freshness
   mode**（Task 12b）。计划提到 `freshness.storm=true` 作为独立标记；当前
   实现里 storm 会 `markDirty`，请求侧看到的是与"watcher 降级"相同的
   `WATCHER_DEGRADED`，这是保守方向的近似（更谨慎地关闭 cache 读写，绝不会
   反向放宽），不是精确复刻计划文本。
5. **storm 下 negative-lookup gating 未实现，只是"真空成立"**。
   `negativeLookupAllowed` 目前硬编码为 `false`（Iteration C 之前的既定
   stub），因此"storm 期间禁用 negative lookup"自动为真，但这不是本迭代
   新增的门控逻辑，不应算作已满足的需求。
6. **`isStormBatch` 的 `indexedJavaFiles` 取自 `SourceIndex.status().entries`
   （内存态）**。冷启动时该值接近 0，比例阈值退化为 `max(20, 0)=20` 的下限。
   这是有意为之：索引为空时粗粒度失效本身代价也接近零，不构成问题，但
   若未来需要更精确的冷启动行为，应改用持久化的 `totalFileRecords`。
7. **计划 Task 12b Step 2 假设的 fixture API 不存在**：
   `coordinatorWithIndex`、`fixture.index.backgroundReconcileCalls`、
   `priorityZeroParseCalls` 均来自计划对一个"带优先级解析队列的 SourceIndex"
   的想象设计，当前 `SourceIndex` 是懒加载、按需 `factsFor()` 的模型，没有
   这类队列/计数器。实际实现改为复用 Task 11 已有的
   `markDirty → reconcileIfDirty` singleflight 作为"后台 reconcile"，
   **没有**构建按 root 的 BUILDING/DEGRADED 状态机，也**没有**构建
   priority-0（anchor）/priority-10（background）请求路由。
8. **`recordJdtlsPid` 是两次独立的原子 rename，不是一次联合事务**。部分
   失败由既有回滚路径处理（调用方在失败时杀子进程并释放 lease），因此这个
   非原子性本身是安全的，但接口文档不应声称"原子地记录到两处"。
9. **`foregroundAnchorP50/P95DuringStorm` 未测量**。本迭代没有构建
   "storm 进行中同时发起前台 anchor 请求"的专项 benchmark；storm 场景下
   前台请求的实际延迟表现是未知的，只能通过现有的
   `reconcileIfDirty`/`awaitReadyWithin` 单测间接推断不会无界阻塞。
10. **lease/janitor 状态放在 `server.ts` 而非 `tools/status.ts`**（Task
    12a、12c）。这是有意选择：`tools/status.ts` 的 `javaStatus()` 是单仓
    请求作用域的处理器，没有服务器级状态（lease store、janitor 启动结果）
    的自然落点；`server.ts` 的无 selector 分支已经是 `leases`/`aliasRegistry`
    等服务器级诊断的既有位置，这里保持一致而非另起炉灶。
11. **三仓 benchmark（Task 13 Step 3）未运行**，见 §7。

## 9. Iteration B 完成门禁核对

| 门禁项 | 结果 | 证据 |
|---|---|---|
| fast mode watcher active | PASS | Task 9：`RepoChangeCoordinator` 独立于 JDT 生命周期 |
| all caches use one generation | PASS | Task 10：rg cache / SourceIndex / JDT cache / EdgeStore 共享 `GenerationClock` |
| rename/delete stale rate 0 | PASS | `freshness-mutation.test.ts` 4 个测试 |
| build layout refresh verified | PASS | `a BUILD_CHANGE reconfigures the watch plan...` |
| runtime memory retention bounded | PASS | `fully stopped idle runtimes are removed...` |
| alias config failure degrades safely | PASS | `alias-registry.test.ts` 5 个 last-known-good 测试 |
| machine-level JDT/sweep slots never exceeded | **PARTIAL** | JDT 槽：真实子进程冒烟 + 进程内测试均 PASS；sweep 槽：`acquireSweep()` 无生产调用点，"从未超出"是真空成立，见 Known Limit #2 |
| same-worktree duplicate JDT spawn count 0 | PASS | 真实子进程冒烟（§5.1）+ `cross-process-lease.test.ts` |
| 500-file storm schedules one reconcile | PASS | `worktree-storm.test.ts`（进程内） |
| live fast-only worktree cache is not deleted | PASS | `worktree-cache-cleanup.test.ts`（进程内，真实 lease store fixture） |

9/10 完全 PASS，1 项（机器级槽位）PARTIAL——JDT 侧证据充分，sweep 侧目前
没有生产调用点因而没有真实验证对象。三仓 benchmark（§7）是本报告未闭合的
唯一外部依赖项。

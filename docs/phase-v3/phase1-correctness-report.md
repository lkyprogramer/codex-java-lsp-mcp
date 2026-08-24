# Phase 1 — Iteration A 正确性封口 Report

## 1. Decision

**条件通过。** Iteration A 的 7 项实现任务（Task 1–7）全部完成并有定向测试覆盖。
C-01～C-06 全部封口；**C-07 部分封口** —— rg 与 hierarchy 路径已由请求级绝对
deadline 约束，但 `semanticLocations` / `references` / `symbolContext` 仍使用
请求开始时刻捕获的 `semanticTimeoutMs` 阶段超时，且其内部 `ensureStarted()` 仍走
120 s 默认预算，因此这些路径仍可能超出请求的绝对 deadline。计划 Task 1 Step 6
明确把它定为「adapter，直到所有 JDT 调用消费 DeadlineBudget」，属既定延后项。

2026-07-24 已在当前运行时提交 `b37d3e56c863` 重跑三仓 `cold-nolsp` 矩阵：
每仓 5 个 golden 场景（golden 文件各恰好 5 条，全部纳入）、每场景 5 次。两轮
（`deadlineMs=3000` 与 15 s 对照）三仓 `R_read_must` 都为 `1.0000`，且两种预算下每仓的
recall / P_read 完全一致。完整原始 JSON 与 TAP 见 `artifacts/v3-phase1/b37d3e56c863/`。

**关于 deadline 标签的更正**：这两轮 artifacts 记录的 `deadlineMs` 分别是 3000 和 15000。
但真实 cold-nolsp 的 `java_impact` 请求预算是 **2000 ms**（`impact.ts` 把 policy 强制为
`fast` → `defaultDeadlineMs(balanced, fast)=2000`）。本次 artifacts 的 3000 ms 是因为
当时 benchmark 的 deadline 取自**原始** `--semantic-policy` 默认值 `auto`，而不是被
warm-state 强制后的 `fast`。该 bug 已在 `benchmark-agent-impact.ts` 修正为按
effective policy 推导（cold-nolsp→2000、warm-required→5000）。由于本矩阵 P95 ≤ 255 ms
远小于 2000 ms，rg 在任何一档 deadline 都不会截断，2000/3000/15000 结果必然一致，
硬门槛结论不受影响；但当前 artifacts 是 3000 ms 而非 2000 ms 的运行，标签以此为准。

Iteration A 的显式完成门禁（`R_read_must=1.0000`）已满足。Task 0 未能在真实仓上留下
可比较的原始 JSON，且当前三仓 commit 晚于 Phase 12 历史报告，故 recall / P_read 只有
当前基线，不能声称完成了同 commit before/after 的非回归证明；该限制不改变
`R_read_must=1.0000` 硬门槛已通过的事实。

## 2. Baseline

| 项 | 基线（Task 0，`48e665ba73dc`） | 当前验证（`b37d3e56c863`） |
|---|---|---|
| build | exit 0 | exit 0 |
| tests | 124 | 222 |
| pass | 120 | 218 |
| fail | 0 | 0 |
| skipped | 4 | 4 |
| duration | 37.2 s | 42.2 s |

新增 98 个测试，其中 40 个属于本迭代的正确性/故障注入定向测试。
基线环境见 `docs/phase-v3/phase0-current-baseline.md`。

## 3. Scope

### Changed

| Task | Commit | 变更 |
|---|---|---|
| 0 | `7f58fd1` | phase0 基线文档与 benchmark artifacts |
| 1 | `f64e8d7` | `src/runtime/{completion,intelligence-error,deadline-budget,request-context,source-range}.ts`；`java_impact` 改单一 `deadlineMs` |
| 2 | `1d0551f` | `src/jdtls-transport.ts`、`src/test-support/fake-jdtls.ts`；`JdtlsSession` 注入 transport |
| 3 | `3d1f7d5` | 五态生命周期、事务式启动、`src/jdt-restart-backoff.ts`、`status()` 修正 |
| 4 | `ecc7721` | `RepoRuntimeManager` reservation + FIFO slot waiters |
| 5 | `623d8ef` | `src/search/{search-types,bounded-line-decoder,rg-runner,rg-cache}.ts`；替换 router rg executor |
| 6 | `e0d43d7` | `src/semantic-location.ts`、`isPotentiallyWithin`、`classifySemanticError`、EdgeStore 边界 |
| 7 | `60ab6b1` | hierarchy visited/预算/completion 契约、`cancelBackendSettlementMs` |
| 7 follow-up | `b37d3e5` | benchmark 传入请求级 `DeadlineBudget` 并记录实际 deadline；non-COMPLETE hierarchy 不再写 cache 后重跑 |

### Explicitly unchanged

- public MCP tools 仍为 7 个，未新增工具。
- `source-index.ts` 的正则 `parseJavaSource` 与其 `spawnSync("rg")` fallback 保留
  （§2.1 规定在 Iteration C 之后才删除）。
- `worktree-cache-cleanup.ts` 保留，未改行为。
- per-worktree cacheRoot 布局、Git common-dir enablement 继承、每 worktree 独立
  JDT `-data` workspace 全部保留。
- 未引入 `RepoChangeCoordinator`、跨进程 lease、统一 generation（Iteration B）。
- 未引入 Tree-sitter（Iteration C）。

## 4. Tests

```bash
NODE=/Users/luo/.nvm/versions/node/v22.16.0/bin/node
"$NODE" node_modules/.bin/tsc -p tsconfig.json && "$NODE" scripts/write-build-stamp.mjs
"$NODE" --test "dist/**/*.test.js"
```

当前提交原始输出：`artifacts/v3-phase1/b37d3e56c863/full-test-run.tap`
（222 tests / 218 pass / 0 fail / 4 skipped）。

历史定向故障注入：`artifacts/v3-phase1/60ab6b14236b/fault-injection-run.tap`
（40 tests / 40 pass / 0 fail）。本次全量测试重新覆盖了这些断言。

## 5. Correctness/Fault Results

| invariant | test | result |
|---|---|---|
| C-01 STARTING 不得报告 started | `status reports STARTING pid separately and never as started` | PASS |
| C-01 initialize 前不 READY | `concurrent ensureStarted shares one transactional start` | PASS |
| C-02 失败启动完全清理 | `failed initialize disposes the attempt and permits a clean retry` | PASS |
| C-02 STARTING 期间 stop 取消 waiter | `stop during STARTING cancels waiters without recording a restart failure` | PASS |
| C-02 READY child 退出转 BROKEN 且可重启 | `a READY child that exits marks the session BROKEN and restartable` | PASS |
| 启动 singleflight | `a short caller deadline does not cancel a shared JDT startup` | PASS |
| restart backoff 指数退避与上限 | `backoff delay grows exponentially and is capped at 30 seconds` | PASS |
| 配置错误需显式 reset | `JDT configuration failures require explicit reset` | PASS |
| deadline/cancel 不污染 backoff | `caller deadlines and cancellation do not poison restart backoff` | PASS |
| READY 稳定窗口才清零失败 | `the ready stability window clears earlier restart failures` | PASS |
| 退避窗口内共享一次重试 | `requests inside an active retry window share exactly one delayed restart` | PASS |
| C-06 STARTING 占用 slot | `STARTING sessions count against the active repo limit` | PASS |
| C-06 FIFO 授予 | `slot waiters are granted in FIFO order` | PASS |
| C-06 超时 waiter 不被后补授予 | `a waiter that misses its deadline is removed and never granted later` | PASS |
| C-06 未使用 reservation 释放 | `a reservation taken but never used is released for the next caller` | PASS |
| C-04 partial rg 禁 cache（router 级） | `a partial rg result is never cached, so the next request runs rg again` | PASS |
| C-04 FAILED 亦禁 cache | `a failed rg result is not cached either` | PASS |
| C-04 COMPLETE 才复用 | `a complete rg result is cached and the next request reuses it` | PASS |
| rg 超时产出 PARTIAL_TIMEOUT | `rg timeout returns partial evidence but is not complete` | PASS |
| rg SIGTERM→SIGKILL 升级 | `a hung child is escalated from SIGTERM to SIGKILL` | PASS |
| rg 畸形 JSON → FAILED | `malformed JSON fails the search instead of silently losing matches` | PASS |
| rg exit 1 仍 COMPLETE | `exit status 1 with no matches is a complete search` | PASS |
| C-05 仓库外 location 拒绝 | `semantic locations outside canonical repo root are rejected` | PASS |
| C-05 符号链接逃逸拒绝 | `a nonexistent child under a symlink that escapes the repo is not contained` | PASS |
| C-05 公共输出无外部路径 | `semantic tools never emit locations from outside the repository` | PASS |
| C-05 EdgeStore 拒绝外部目标 | `EdgeStore refuses to persist a target outside the repository` | PASS |
| C-07 hierarchy 环路只请求一次 | `type hierarchy stops on cycles and does not request the same item twice` | PASS |
| C-07 超时保留已收集边 | `an expired hierarchy budget returns partial edges rather than throwing` | PASS |
| C-07 prepare 超时不遍历 | `a timed-out prepare returns an empty partial result without traversing` | PASS |
| C-07 上限 → PARTIAL_LIMIT | `the edge limit reports PARTIAL_LIMIT rather than COMPLETE` | PASS |
| JDT 故障降级而非失败请求 | `a {JDT_BACKOFF,JDT_CONFIG_ERROR,JDT_BROKEN,DEADLINE_EXCEEDED} JDT degrades the semantic stage instead of failing the request` | PASS ×4 |
| 故障不被误报为 timeout | `a JDT failure is not reported as a timeout unless it actually was one` | PASS |

**判别性验证**：`semantic-failure.test.ts` 的 5 个测试在移除 `collectSemanticSeed`
的 try/catch 后**全部失败**（实测 0 pass / 5 fail），证明它们检验的是本次修复本身，
而不是恰好通过。

## 6. Benchmark Matrix

执行环境：运行时 build `b37d3e56c863`；`cold-nolsp`、`impact`、`balanced`、
`semanticPolicy=fast`、`runs=5`。每轮共 75 次尝试，两轮总计 150 次。生产轮原始 JSON
位于 `artifacts/v3-phase1/b37d3e56c863/production/`，宽松对照位于
`artifacts/v3-phase1/b37d3e56c863/relaxed/`。

### Before/After Quality

Task 0 因当时的目录授权不足没有原始 JSON。计划 §1.4 的 Phase 12 历史值虽可作为参考，
但当前业务仓 commit 分别为 `edf5b94c70bc`、`791cd17bd794`、`08f03655003f`，均晚于
2026-07-04 的历史报告；因此不能将其当作同 commit before 值。下表将本次结果冻结为
后续 Iteration B 的可比较基线。

| project | recall | P_read | R_read_must | result |
|---|---:|---:|---:|---|
| lishuedu | 0.8456 | 0.8667 | 1.0000 | PASS |
| cipherlink | 0.8421 | 0.7000 | 1.0000 | PASS |
| exam-parent-v3 | 0.7350 | 0.6333 | 1.0000 | PASS |

Phase 12 的 cipherlink recall 是 0.8643；当前 0.8421 的差异不能归因于 Iteration A，
因为两个业务仓提交不同。后续任何质量比较必须使用本节原始 JSON 和相同业务仓 commit。

### Production Cold Latency and Cost

| project | repo commit | P50 / P95 | payload P50 | estimated tokens P50 |
|---|---|---:|---:|---:|
| lishuedu | `edf5b94c70bc` | 11.74 / 255.26 ms | 42,086 B | 10,522 |
| cipherlink | `791cd17bd794` | 4.44 / 127.73 ms | 40,205 B | 10,051 |
| exam-parent-v3 | `08f03655003f` | 5.66 / 205.71 ms | 38,616 B | 9,654 |

### Deadline A/B

跑出的两轮是 `deadlineMs=3000`（当时误记为生产预算，见 §1 更正）与
`deadlineMs=15000`。真实生产 cold-nolsp 预算是 2000 ms，未直接测到；因本矩阵 P95 ≤ 255 ms
远低于三档中最小的 2000 ms，rg 不会在任何一档截断，故此 A/B 仍充分。

| project | `deadlineMs=3000`（artifacts 标注为 production） | `deadlineMs=15000` | decision |
|---|---|---|---|
| lishuedu | recall 0.8456 / P_read 0.8667 / R_read_must 1.0000 | 相同 | PASS |
| cipherlink | recall 0.8421 / P_read 0.7000 / R_read_must 1.0000 | 相同 | PASS |
| exam-parent-v3 | recall 0.7350 / P_read 0.6333 / R_read_must 1.0000 | 相同 | PASS |

150 次尝试的 `timing.semantic.timeout` 均为 `false`（本矩阵 `semanticPolicy=fast`，
语义阶段被跳过，`semantic.used=false`；因此 `required` 模式的时间预算风险未被本矩阵覆盖，
见 §9.1）。六个 benchmark 命令均 exit 0，stderr 无新 warning。3000/15000 两档质量指标完全
一致，且真实 2000 ms 预算比二者都紧但仍远高于 P95，说明生产 deadline 不会在此矩阵造成
可观测的质量截断；该结论不泛化为所有更大仓库均无该风险。

## 7. Attribution

本迭代不改变排序与证据权重，不产出 per-provider attribution（属 Iteration D Task 32）。
新增的可观测字段：

- `metrics.semantic.externalLocationsSuppressed` — 因仓库边界被丢弃的 JDT location 数。
- `metrics.semantic.errorCode` — 最近一次语义失败的分类。
- `rgSummary.sections[].completion` — 每个 rg section 的完整性。
- `java_status.state` / `startingPid` / `restartBackoff` — JDT 生命周期与退避状态。
- `resource.reservedRepos` / `queuedRepos` — slot 占用与排队深度。
- `phaseMs.cancelBackendSettlementMs` — 取消后 JDT 实际结算耗时。
- `EdgeStore.status().rejectedOutsideRepo` — 被拒绝的越界边数。

## 8. Rejected Alternatives / 计划偏离

| # | 计划原文 | 实际做法 | 理由 |
|---|---|---|---|
| D1 | `DeadlineBudget.race` 的 timer 使用 `timer.unref?.()` | 去掉 `unref` | Task 4 的进程内 slot waiter 没有任何其他句柄维持事件循环，unref 后 Node 会直接退出而不是投递 deadline 拒绝。`finally` 始终 `clearTimeout`，生命周期仍然有界。计划自带的 `race` 测试在 unref 下本身不可运行。 |
| D2 | Task 1 Step 6 只改 schema | 同时把 warm documentSymbol 钳制到 `budget.remainingMs(configured)` | 否则「绝对 deadline」不成立：warm 可以吃掉任意长前缀并饿死其后的语义阶段。 |
| D3 | — | **可观察行为变化**：`semanticPolicy=required` 由 warm 45 s + 每 anchor 语义 1.5 s，改为单一 5 s 默认 deadline（`deadlineMs` 最大 15 s） | C-07 的直接后果，§3.4 `defaultDeadlineMs` 与 15 s 上限即此设计。见 §9。 |
| D4 | 每请求创建 `RequestContext` | `javaImpact` 直接创建 `DeadlineBudget`；`request-context.ts` 仅作为 Iteration B 的类型契约落地 | Iteration A 的 fast path 没有真实 generation 来源（那正是 C-03，由 Iteration B Task 9/10 修复）。向无人读取的 context 里塞入伪造 generation 属于投机状态。 |
| D5 | Task 3 Step 1 断言两次 `ensureStarted()` 后同步 `spawnCalls === 1` | 先等待首次 spawn 再断言恰好一次 | `startTransactional` 在 spawn 前 `await mkdir`，同步时刻 `spawnCalls` 必为 0。不变量（两个并发调用只 spawn 一次）完整保留。 |
| D6 | — | `JdtlsSession` 增加第 4 个构造参数 `now: () => number` | 计划自身的 session 级 backoff 测试需要假时钟才能确定性地跨过 `retryAfterMs`。 |
| D7 | Task 3 Step 7 只涉及 `JdtlsSession.status()` | 同时在 `java_status` 暴露 `state` / `startingPid` / `restartBackoff` | 新状态若止步于 session 边界则无法用于诊断。 |
| D8 | `drainSlotWaiters()` 仅在容量释放时授予 | 增加 `serviceSlotWaiters()`：有排队且满载时驱逐最旧的空闲 reserved entry | 否则排队者永远无法驱逐一个空闲但 READY 的 runtime，会丢失原有的 evict-idle 行为并一直阻塞到 deadline。 |
| D9 | — | `resourceStatus()` 增加 `reservedRepos` / `queuedRepos` | 这两个数字是解释 slot 等待超时的唯一依据。 |
| D10 | 原测试断言 `/active limit is 1/` | 改为断言 `JavaIntelligenceError` code `DEADLINE_EXCEEDED` @ `runtime.lsp-slot` | Task 1 已把错误分类迁移到 `JavaIntelligenceError`。 |
| D11 | Task 6 Step 2 返回 canonical `absolutePath` | containment 仍按 canonical 判定，但返回值用调用方 `repoRoot` 重建 | 返回 canonical 会让 repoRoot 位于符号链接之后时，缓存与 edge 记录落在另一个 key 命名空间（实测打断了两个既有 router 测试）。 |
| D13 | Task 5 Step 6 未指定 benchmark 预算 | benchmark 按 **effective** policy 用 `defaultDeadlineMs` 构造 budget，并新增 `--deadline-ms` | 原先 benchmark 走 router 的 15 s 兜底，无法证明生产预算下的召回。首版修复（`b37d3e5`）用了**原始** `--semantic-policy` 默认值 `auto`，对 cold-nolsp 算出 3000 ms，而真实 cold-nolsp 请求被强制 `fast`、预算 **2000 ms**；已改为按 warm-state 推导的 effective policy（cold-nolsp→2000、warm-required→5000）。`b37d3e56c863` 的 artifacts 仍是 3000 ms 的运行，见 §1/§6 更正。 |
| D14 | Task 7 未指定 hierarchy 缓存写入策略 | `cached()` 增加 `shouldCache` 断言，非 COMPLETE 直接不写 | 先前用 `cached(...) ?? compute()` 会把 `undefined` 写进缓存并在 partial 时把整趟遍历跑第二遍。 |
| D12 | Task 6 Step 6 要求输出不含外部路径 | diagnostic detail 保留 `uri` 字段 | 全局约束第 21 条限定的是「默认结果」；diagnostic 是显式选择，且 containment 之后该 uri 必定指向仓库内。保留既有可观察行为。 |

## 9. Known Limits

1. **`semanticPolicy=required` 的时间预算显著收紧**（D3）。原先 warm 阶段单独可用 45 s，
   现在整个请求默认 5 s、最大 15 s。若真实仓库上 required 模式召回下降，
   应通过 `deadlineMs` 显式提高，而不是恢复无界超时。
2. **rg 现在受请求 deadline 约束**（每 section 上限 15 s）。真实 `cold-nolsp` +
   `balanced` 的生产总预算为 **2000 ms**；本次 artifacts 因 benchmark deadline 取自原始
   policy 而记为 3000 ms（见 §1 更正，已修复）。若大仓上 rg 因此转为 `PARTIAL_TIMEOUT`，
   会同时损失召回**并且**禁用缓存（partial 不入 cache），导致每次请求重跑 rg。
   本次三仓 3000/15000 对照质量一致，且 P95 ≤ 255 ms 远低于 2000 ms，生产预算没有造成
   可观测的质量截断；仍不可泛化到未测试的大仓。benchmark 现按 effective policy 推导
   `deadlineMs`，并可用 `--deadline-ms` 覆盖。
3. **C-07 仅部分封口**（见 §1）。definition / implementation / reference 路径
   仍是请求开始时刻的阶段超时，不是活的剩余预算。计划把这条留给
   Task 33（SemanticGateway）统一。
4. **generation 仍未统一**：C-03 未修复，`rgSummary` 的 generation 仍取自
   `session.cacheStatus().invalidations`，fast path 下恒为 0。Iteration B Task 9/10 修复。
5. **active limit 仍只在进程内**：多个 stdio MCP 进程之间无协调，
   机器级 JDT 数量仍无上界。Iteration B Task 12a 引入文件 lease。
6. **`shutdownAll()` 取消排队 waiter 时**只置 settled，不会立即解除
   `reserveLspSlot` 的等待，该调用方会等到自身预算耗尽。与改造前的轮询实现同等，
   非回归；但不要新增假设「关闭会立即解阻塞」的路径。
7. **`source-index.ts` 的 `spawnSync("rg")` fallback 仍在请求路径上**，
   按 §2.1 留待 Iteration C 之后删除。

## 10. Reproduction Commands

```bash
NODE=/Users/luo/.nvm/versions/node/v22.16.0/bin/node

# 构建与全量测试
"$NODE" node_modules/.bin/tsc -p tsconfig.json && "$NODE" scripts/write-build-stamp.mjs
"$NODE" --test "dist/**/*.test.js"

# 定向故障注入
"$NODE" --test --test-name-pattern="concurrent ensureStarted|failed initialize|STARTING sessions|rg timeout|outside canonical repo|hierarchy stops|never cached|degrades the semantic stage|outside the repository" "dist/**/*.test.js"
```

三仓 cold benchmark 已于 2026-07-24 在有读取授权的终端完成；原始结果见 §6。

benchmark 现在默认使用与 `java_impact` 相同的绝对 deadline
（本次 `cold-nolsp` + `balanced` 实测 → 3000 ms），生效值写入结果的 `deadlineMs`。
**必须跑两轮做 A/B**：生产预算一轮，旧的宽松预算一轮。
若两轮 `R_read_must` 与 `recall` 一致，则 Known Limit #2 的风险以证据消解；
若生产预算这轮下降，说明 rg 被 deadline 截断，需在进入 Iteration B 前处理。

```bash
NODE=/Users/luo/.nvm/versions/node/v22.16.0/bin/node
BASE="artifacts/v3-phase1/$(git rev-parse --short=12 HEAD)"

run() {   # $1=label  $2=extra args
  mkdir -p "$BASE/$1"
  for repo in \
    "lishuedu:/Users/luo/Documents/program/lishu/lishuedu" \
    "cipherlink:/Users/luo/Documents/program/cipherlink" \
    "exam-parent-v3:/Users/luo/Documents/program/exam-parent-v3"
  do
    id="${repo%%:*}"; root="${repo#*:}"
    "$NODE" dist/benchmark-agent-impact.js --repo-root "$root" --project-id "$id" \
      --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic $2 \
      > "$BASE/$1/$id-cold.json"
  done
}

run production ""                      # 3000ms，实际写入 JSON 的生产预算
run relaxed    "--deadline-ms 15000"   # 旧的宽松预算，用于对照
```

## 11. Gate Result

| 门禁项 | 结果 |
|---|---|
| all tests pass | **PASS**（222 / 218 pass / 0 fail / 4 skipped） |
| no partial cache | **PASS**（router 级回归测试，非仅 cache 单测） |
| no outside-repo output | **PASS**（`output-shape.test.ts` + `semantic-location.test.ts` + EdgeStore） |
| no oversubscribe | **PASS**（进程内；跨进程属 Iteration B） |
| no residual child after failed initialize | **PASS** |
| `R_read_must=1.0000` | **PASS**（三仓 production / relaxed 均为 1.0000；见 `artifacts/v3-phase1/b37d3e56c863/`） |

**结论：Iteration A 的显式完成门禁通过。** 可以进入 Iteration B；后续质量比较必须使用
§6 冻结的同 commit 原始 JSON，而不是 Phase 12 的不同业务仓历史值。

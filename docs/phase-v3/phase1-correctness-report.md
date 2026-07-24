# Phase 1 — Iteration A 正确性封口 Report

## 1. Decision

**部分通过。** Iteration A 的 7 项实现任务（Task 1–7）全部完成并有定向测试覆盖。
C-01～C-06 全部封口；**C-07 部分封口** —— rg 与 hierarchy 路径已由请求级绝对
deadline 约束，但 `semanticLocations` / `references` / `symbolContext` 仍使用
请求开始时刻捕获的 `semanticTimeoutMs` 阶段超时，且其内部 `ensureStarted()` 仍走
120 s 默认预算，因此这些路径仍可能超出请求的绝对 deadline。计划 Task 1 Step 6
明确把它定为「adapter，直到所有 JDT 调用消费 DeadlineBudget」，属既定延后项。

**但 Iteration A 的完成门禁未完全满足**：门禁中的
`R_read_must=1.0000`（三仓真实 benchmark）在本会话**无法执行**，因此
recall / P_read / P50 / P95 / R_read_must **均未验证**。

不得把「222 tests / 0 fail」当作门禁通过。合并前必须由具备读取授权的终端补跑三仓
benchmark（命令见 §10），并确认 `R_read_must=1.0000`。

## 2. Baseline

| 项 | 基线（Task 0，`48e665ba73dc`） | 当前（`60ab6b1`） |
|---|---|---|
| build | exit 0 | exit 0 |
| tests | 124 | 222 |
| pass | 120 | 218 |
| fail | 0 | 0 |
| skipped | 4 | 4 |
| duration | 37.2 s | 38.5 s |

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

原始输出：`artifacts/v3-phase1/60ab6b14236b/full-test-run.tap`
（222 tests / 218 pass / 0 fail / 4 skipped）。

定向故障注入：`artifacts/v3-phase1/60ab6b14236b/fault-injection-run.tap`
（40 tests / 40 pass / 0 fail）。

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

**未执行。**

| project | recall before/after | P_read before/after | R_read_must |
|---|---|---|---|
| lishuedu | 未执行 / 未执行 | 未执行 / 未执行 | **未验证** |
| cipherlink | 未执行 / 未执行 | 未执行 / 未执行 | **未验证** |
| exam-parent-v3 | 未执行 / 未执行 | 未执行 / 未执行 | **未验证** |

| project | P50 before/after | P95 before/after |
|---|---|---|
| lishuedu | 未执行 / 未执行 | 未执行 / 未执行 |
| cipherlink | 未执行 / 未执行 | 未执行 / 未执行 |
| exam-parent-v3 | 未执行 / 未执行 | 未执行 / 未执行 |

原因：本会话进程无法读取 `/Users/luo/Documents/program/**`。实测
`cat`、`node readFileSync`、`node readdirSync` 均返回 `EPERM: operation not permitted`，
关闭命令沙箱后行为不变。Task 0 与本阶段各探测一次，结论一致。

按计划 §Task 0 Step 6：所有质量结论只基于可执行的 fixture 与单元测试；
**不得引用 §1.4 的历史数字（recall 0.8456/0.8643/0.7350、P_read 0.8667/0.7000/0.6333）
声称通过**。

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
| D13 | Task 5 Step 6 未指定 benchmark 预算 | benchmark 默认用 `defaultDeadlineMs(mode, policy)` 构造 budget，并新增 `--deadline-ms` | 原先 benchmark 走 router 的 15 s 兜底，而真实 `java_impact` 只有 2 s，跑出来的 `R_read_must` 无法证明生产预算下的召回。 |
| D14 | Task 7 未指定 hierarchy 缓存写入策略 | `cached()` 增加 `shouldCache` 断言，非 COMPLETE 直接不写 | 先前用 `cached(...) ?? compute()` 会把 `undefined` 写进缓存并在 partial 时把整趟遍历跑第二遍。 |
| D12 | Task 6 Step 6 要求输出不含外部路径 | diagnostic detail 保留 `uri` 字段 | 全局约束第 21 条限定的是「默认结果」；diagnostic 是显式选择，且 containment 之后该 uri 必定指向仓库内。保留既有可观察行为。 |

## 9. Known Limits

1. **三仓 benchmark 未验证**：`R_read_must=1.0000` 是硬门槛，本会话无法执行。
   合并前必须补跑（§10）。
2. **`semanticPolicy=required` 的时间预算显著收紧**（D3）。原先 warm 阶段单独可用 45 s，
   现在整个请求默认 5 s、最大 15 s。若真实仓库上 required 模式召回下降，
   应通过 `deadlineMs` 显式提高，而不是恢复无界超时。
3. **rg 现在受请求 deadline 约束**（每 section 上限 15 s）。fast + balanced 的默认
   总预算是 2000 ms。若大仓上 rg 因此转为 `PARTIAL_TIMEOUT`，会同时损失召回**并且**
   禁用缓存（partial 不入 cache），导致每次请求重跑 rg。
   **这是本迭代最需要用真实 benchmark 验证的一项。**
   benchmark 已改为默认使用与 `java_impact` 相同的 `defaultDeadlineMs`
   （见 D13），并把生效值写入结果的 `deadlineMs` 字段；用 `--deadline-ms`
   可显式覆盖以做 A/B 对照。
4. **C-07 仅部分封口**（见 §1）。definition / implementation / reference 路径
   仍是请求开始时刻的阶段超时，不是活的剩余预算。计划把这条留给
   Task 33（SemanticGateway）统一。
5. **generation 仍未统一**：C-03 未修复，`rgSummary` 的 generation 仍取自
   `session.cacheStatus().invalidations`，fast path 下恒为 0。Iteration B Task 9/10 修复。
6. **active limit 仍只在进程内**：多个 stdio MCP 进程之间无协调，
   机器级 JDT 数量仍无上界。Iteration B Task 12a 引入文件 lease。
7. **`shutdownAll()` 取消排队 waiter 时**只置 settled，不会立即解除
   `reserveLspSlot` 的等待，该调用方会等到自身预算耗尽。与改造前的轮询实现同等，
   非回归；但不要新增假设「关闭会立即解阻塞」的路径。
8. **`source-index.ts` 的 `spawnSync("rg")` fallback 仍在请求路径上**，
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

三仓 cold benchmark（**尚待执行**，需在有读取授权的终端运行）。

benchmark 现在默认使用与 `java_impact` 相同的绝对 deadline
（`cold-nolsp` + `balanced` → 2000 ms），生效值写入结果的 `deadlineMs`。
**必须跑两轮做 A/B**：生产预算一轮，旧的宽松预算一轮。
若两轮 `R_read_must` 与 `recall` 一致，则 Known Limit #3 的风险以证据消解；
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

run production ""                      # 2000ms，用户实际拿到的预算
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
| `R_read_must=1.0000` | **未验证** — 阻塞项 |

**结论：代码层面 Iteration A 已封口，但门禁未完全满足。**
在三仓 benchmark 通过前，不得据此进入 Iteration B。

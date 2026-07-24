# V3 Phase 0 Current Baseline

本文件是 V3.1 执行计划 Task 0 的产物，冻结改造前的源码映射、测试基线和已知缺陷复现结论。
后续所有迭代的 before/after 比较都以本文件记录的 commit 和机器为准。

## Runtime

- commit: `48e665ba73dc332dccd4b34e71adc1c048170cf6`
- branch: `codex/java-intelligence-v3`（从 `main` 切出，父 commit 同上）
- macOS: 26.5.1 (arm64)
- CPU/RAM: Apple M1 Pro，10 logical CPU，32 GB
- Node: v22.16.0
- Java: openjdk 25.0.1 2025-10-21
- JDT LS: `/opt/homebrew/bin/jdtls`
- ripgrep: 14.1.0

## Build/Test

```bash
npm run build                       # exit 0
node --test "dist/**/*.test.js"     # 见下
```

| 指标 | 值 |
|---|---|
| tests | 124 |
| pass | 120 |
| fail | 0 |
| skipped | 4 |
| duration | 37.2 s |

基线健康，符合计划 §1.1 引用的 Review 数值（124 / 120 / 4 / 0），可以开始 V3 改造。

注意：本机 `npm` / `node` 在非交互 shell 中被 nvm 的 shell function 包装破坏
（`command not found: _nvm_load` → `maximum nested function level reached`）。
所有命令必须使用绝对路径 `/Users/luo/.nvm/versions/node/v22.16.0/bin/node`。

## Current Source Map

计划 §2 的目标文件结构是**目标态**，不是当前态。当前 HEAD 已经完成 phase 4–12 的
agent-router 拆分和 routing policy 拆分，比计划正文引用的旧压缩包更新。下表每行都来自
`rg` 实测输出，后续 Task 5/6/7 中"current owner from Task 0 mapping"一律以本表为准。

| Concept | Current file | Current symbol | Line | Review status |
|---|---|---|---|---|
| JDT lifecycle | `src/jdtls-session.ts` | `JdtlsSession.ensureStarted` | 198 | 存在；无状态机，仅 `starting?: Promise<void>` |
| JDT lifecycle | `src/jdtls-session.ts` | `JdtlsSession.start` (private) | 414 | 存在；非事务式，失败不回滚 |
| JDT lifecycle | `src/jdtls-session.ts` | `initializeParams` | 509 | 存在 |
| JDT transport | `src/jdtls-session.ts` | 直接 `spawn` + `createMessageConnection` | 430 / 449 | 无抽象，不可故障注入 |
| semantic provider | `src/agent-router/semantic.ts` | `collectSemanticSeed` | 49 | 存在 |
| semantic provider | `src/agent-router/semantic.ts` | `semanticVerify` | 77 | 存在 |
| semantic provider | `src/agent-router/semantic.ts` | `locationCandidate` | 168 | 存在；**无仓库边界校验** |
| semantic provider | `src/jdtls-session.ts` | `JdtlsSession.references` | 330 | 存在；per-call `timeoutMs` |
| semantic provider | `src/tools/references.ts` | `javaReferences` | 27 | 存在 |
| rg executor | `src/agent-router/rg-execution.ts` | `runRg` | 142 | 存在；全缓冲 stdout + `maxBuffer` |
| rg executor | `src/agent-router/rg-execution.ts` | `loadRgCommandSummary` | 89 | 存在；`rg -n` 文本模式 |
| rg executor | `src/agent-router/rg-plan.ts` | `parseRgOutput` | 100 | 存在；正则解析 `path:line:text` |
| rg cache | `src/agent-router/index.ts` | `AgentRouter.rgSummary` / `rgCache` | 242 / 67 | 存在；无 completion 概念 |
| readPlan budget | `src/agent-router/read-plan.ts` | `buildReadPlan` | 28 | 存在 |
| readPlan budget | `src/agent-router/read-plan-budget.ts` | `selectWithEvidenceBudget` | 63 | 存在 |
| edge store | `src/edge-store.ts` | `EdgeStore.recordEdges` | 57 | **存在**（Task 6 Step 3 走"已有 edge store"分支） |
| import graph | `src/agent-router/candidate-collectors.ts` | `collectImportGraphCandidates` | 75 | 存在 |
| routing policy resolver | `src/routing-policy.ts` | `resolveRoutingPolicy` | — | 存在（`agent-router/index.ts:77` 注入） |
| repo watcher | `src/file-watcher.ts` | `JavaFileWatcher` | 45 | 存在；**由 `JdtlsSession` 拥有**，仅在 JDT 启动后运行 |
| repo watcher | `RepoChangeCoordinator` | — | — | `ABSENT`（`rg -n "RepoChangeCoordinator" src` 无匹配）；Iteration B 引入 |
| worktree identity | `src/repo-resolver.ts` | `--git-common-dir` 解析 | 145 | 存在 |
| worktree identity | `src/path-utils.ts` | `repoHash` / `canonicalPath` / `isWithin` | 23 / 8 / 16 | 存在 |
| worktree identity | `worktree-identity.ts` | — | — | `ABSENT`；身份逻辑分散在 `repo-resolver.ts` + `path-utils.ts` |
| worktree cleanup | `src/worktree-cache-cleanup.ts` | `cleanupStaleWorktreeCaches` / `touchRepoCache` | 44 / 27 | 存在，必须保留并升级 |
| process-local admission | `src/repo-runtime-manager.ts` | `RepoRuntimeManager.reserveLspSlot` | 144 | 存在；轮询式 check-then-act |
| process-local admission | `src/repo-runtime-manager.ts` | `hasLspSlot` / `isStarted` | 159 / 174 | 存在；只看 `status().started` |
| cross-process lease | `cross-process-lease.ts` | — | — | `ABSENT`（`rg -n "lease" src` 无匹配）；Iteration B Task 12a 引入 |

无匹配命令（用于佐证 ABSENT 行）：

```bash
rg -n "RepoChangeCoordinator" src   # no matches
rg -n "cross-process-lease|Lease"  src   # no matches
rg -n "worktree-identity|familyHash" src # no matches
```

## P0 Recheck

逐条通过源码阅读复核，全部 **confirmed**。位置引用当前 symbol，不使用旧 line number。

### C-01 initialize 前伪 READY — confirmed

`JdtlsSession.start()` 在 `await connection.sendRequest("initialize")` **之前**就赋值
`this.process = child; this.connection = connection;`。而
`status().started = Boolean(this.connection && this.process && !this.process.killed)`。
因此从 spawn 成功到 initialize 返回之间的整个窗口，`status().started === true`，
`RepoRuntimeManager.isStarted()` 和 `semantic.ts:shouldUseSemanticVerify` 都会把一个
尚未 initialize 的会话当作可用。

### C-02 start failure 残留 process/connection — confirmed

`start()` 内没有 try/catch。若 `initialize` 超时/失败，或 `!initializeResult` 抛错：

- `this.process` / `this.connection` 仍指向失败的 attempt；
- child 未被 kill，connection 未 dispose；
- `ensureStarted()` 的 `finally` 只清 `this.starting`。

后果比"泄漏"更严重：下一次 `ensureStarted()` 命中
`if (this.connection && this.process && !this.process.killed) return;`，
**直接返回一个永远不会响应的会话**。

### C-03 fast path 无统一 generation — confirmed

`AgentRouter.rgSummary()` 的 generation 取自 `this.session.cacheStatus().invalidations`，
而该计数器只由 `JdtlsSession.invalidateCacheFor()` 递增，后者只被 `JavaFileWatcher` 回调触发，
而 watcher 只在 `JdtlsSession.start()` 成功后才启动。

因此在 fast path（`lspEnabled=false`，JDT 从不启动）下 generation 恒为 `0`，
rg cache 只受 300 s TTL 约束，文件改动不会驱逐。`SourceIndex` 另有独立的新鲜度判定，
两者不共享 generation。

### C-04 timeout partial 被 cache — confirmed

两条独立路径：

1. `loadRgCommandSummary()` 对 `ETIMEDOUT` 显式放行
   （`if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;`），
   随后把超时前收集到的**部分** stdout 交给 `parseRgOutput`，返回一个与完整结果
   形状完全相同的 summary；`AgentRouter.rgSummary()` 无条件写入 `rgCache`。
   partial 结果在 TTL 内被当作完整结果反复复用。
2. `JdtlsSession.cached()` 无条件缓存 `compute()` 的返回值。`semanticLocations` 内部用
   `requestSettled()`，超时返回 `undefined` → 归一化为 `{definitions: [], implementations: []}`，
   与"确实没有定义"不可区分，同样进入 5 分钟 TTL 缓存。

### C-05 outside-repo location 输出 — confirmed

`agent-router/semantic.ts:locationCandidate()` 直接 `fromFileUri(uri)` 后调用
`classifyPath(repoRoot, filePath)`，**没有任何 containment 检查**。
`classifyPath` 对仓库外路径只是让 `relativePath` 保持 `undefined`，仍然返回
`{ absolutePath: <仓库外绝对路径> }`。该 candidate 被 `mergeCandidate` 收入结果集，
`absolutePath` 可携带 `~/.m2/repository/...`、JDK 源码等外部路径。
`tools/symbol.ts`、`tools/references.ts` 同样直接消费原始 LSP location。

### C-06 STARTING 不计 active slot — confirmed

`RepoRuntimeManager.reserveLspSlot()` 是轮询式 check-then-act：

```
while (!this.hasLspSlot(current)) { evict-or-sleep(100) }
```

`hasLspSlot` 只统计 `status().started` 为真的 entry。真正的 JDT 启动发生在
`reserveLspSlot` 返回**之后**的 handler 内部，两者之间没有原子占位。
同 tick 到达的多个请求会同时通过 `hasLspSlot`，随后各自启动 JDT，超出
`maxActiveRepos`。（C-01 使 `started` 提前变真，掩盖但并未修复该竞争。）

### C-07 子阶段独立 timeout，无绝对 deadline — confirmed

当前所有超时都是各自独立的阶段超时，没有请求级绝对 deadline：

| 位置 | 超时 |
|---|---|
| `impactSchema.semanticTimeoutMs` | 默认 1500，public 可调，max 10000 |
| `documentSymbols` | 默认 2000 |
| `documentSymbolsWithRetry` | 默认 20000（内含 10000 单次 attempt） |
| `start()` 的 `initialize` | 硬编码 120000 |
| `DEFAULT_LSP_REQUEST_TIMEOUT_MS` | 120000 |
| `loadRgCommandSummary` | 硬编码 15000 |
| `RuntimeManagerOptions.requestTimeoutMs` | 120000 |

单个 `java_impact` 请求的最坏耗时是这些值的**累加**，不是任何一个上界。
`callHierarchy` / `typeHierarchy` 的递归展开完全不带 timeout 参数，
每个内部 `requestSettled` 各自用 120000 默认值。

### W-BASE — confirmed（三项分别结论）

- **cache/JDT workspace 按 worktree root 隔离：已满足。**
  `repoCacheRoot(repoRoot)` 用 canonical `repoRoot` 的 sha1 前 12 位分目录，
  `dataDir = <cacheRoot>/workspace`、`logDir = <cacheRoot>/logs` 均在其下。
  兄弟 worktree 天然隔离。此项是既有正确行为，V3 必须保留。
- **active limit 只在进程内：confirmed（限制）。**
  `RepoRuntimeManager` 是 MCP 进程内单例，`maxActiveRepos` 只约束本进程。
  多个 stdio MCP 进程（每个 Codex 会话一个）之间没有任何协调，
  机器级 JDT 数量无上界。Task 4 是 process-local 修复，机器级 lease 属 Iteration B Task 12a。
- **janitor 只看 jdtlsPid：confirmed（限制）。**
  `hasActiveJdtls()` 只检查 `meta.jdtlsPid` 存活或 `workspace/.metadata/.lock` 存在。
  fast-only（从不启动 JDT）的活跃 runtime 没有 `jdtlsPid` 也没有 `.lock`，
  仅靠 `touchRepoCache()` 刷新的 `updatedAt` 落在 2 天 TTL 内被间接保护。
  一旦 runtime 存活超过 TTL 且期间无新请求，其 cache 可被删除。缺少显式 owner 活性标记。

## Cold Benchmark

**未执行 — 被环境权限阻塞。**

用户提供的三仓路径均存在（`ls` 可见）：

```text
/Users/luo/Documents/program/lishu/lishuedu
/Users/luo/Documents/program/cipherlink
/Users/luo/Documents/program/exam-parent-v3
```

但本会话的 shell 无法读取项目目录之外的文件内容。实测：

```bash
cat /Users/luo/Documents/program/lishu/lishuedu/.sdkmanrc
# cat: ... Operation not permitted (os error 1)

node -e 'require("fs").readdirSync("/Users/luo/Documents/program/lishu/lishuedu")'
# Error: EPERM: operation not permitted, scandir ...
```

`ls -la`（stat）可以成功，`open` / `scandir` 被拒绝，且关闭命令沙箱后行为不变，
说明是会话进程本身缺少对该目录树的读取授权，不是可以绕过的工具层限制。
三条 benchmark 命令因此在 `new JdtlsSession()` 构造阶段即以 EPERM 退出，
`artifacts/v3-baseline/48e665ba73dc/*.json` 为空文件，`*.stderr` 保留了原始失败栈。

按计划 §Task 0 Step 6 的规定：**后续所有质量 gate 只基于可执行的 fixture 与单元测试；
不得引用 §1.4 的历史数字（recall 0.8456/0.8643/0.7350、P_read 0.8667/0.7000/0.6333）
声称通过。**

需要在具备读取授权的终端中由用户执行，命令如下（`R_read_must=1.0000` 是硬门槛）：

```bash
NODE=/Users/luo/.nvm/versions/node/v22.16.0/bin/node
OUT="artifacts/v3-baseline/$(git rev-parse --short=12 HEAD)"
mkdir -p "$OUT"
"$NODE" dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu \
  --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 \
  --verbosity diagnostic > "$OUT/lishuedu-cold.json"
"$NODE" dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink \
  --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 \
  --verbosity diagnostic > "$OUT/cipherlink-cold.json"
"$NODE" dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 \
  --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 \
  --verbosity diagnostic > "$OUT/exam-cold.json"
```

| project | recall | P_read | R_read_must | payload | P50 | P95 |
|---|---|---|---|---|---|---|
| lishuedu | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 |
| cipherlink | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 |
| exam-parent-v3 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 | 未执行 |

## Existing Phase 4-12 Capabilities

当前 HEAD 已具备、V3 改造不得回退的能力：

- **agent-router 拆分**：`agent-router/` 下 20 个模块（anchor、candidate-collectors、
  evidence-gaps、finalize-rank、finalize-scoring、format、impact-metrics、naming-recall、
  ranking-signals、read-plan、read-plan-budget、rg-execution、rg-plan、rg-roots、rg-terms、
  runtime、semantic、type-reference 等），`index.ts` 仅 275 行编排。
- **routing policy 拆分**：`routing-policy.ts` 的 `resolveRoutingPolicy` 从 repo 解析评分策略，
  由构造函数注入 `AgentRouter`。
- **持久化 edge store**：`edge-store.ts` 的 `EdgeStore.recordEdges`，
  由 `semanticVerify` 写入、`collectPersistedSemanticCandidates` 读取。
- **import graph**：`collectImportGraphCandidates` 正向与 `importGraph:reverse` 反向候选。
- **evidence budget readPlan**：`read-plan-budget.ts` 的 `selectWithEvidenceBudget`
  与 `protectedReadPlanPaths` 保护路径机制。
- **type reference / type graph**：`type-reference.ts`、`collectTypeGraphCandidates`。
- **benchmark harness**：`benchmark-agent-impact.ts` + 四个 golden 场景集
  （lishuedu / cipherlink / exam-parent-v3 / generic-java），支持
  per-golden attribution、warm phase timing 和 build metadata。
- **worktree cache janitor**：`worktree-cache-cleanup.ts`，启动时清理超 TTL 的非活跃
  linked worktree cache，不动主 checkout。
- **resource defaults**：`resource-defaults.ts` 按本机内存保守推导
  `maxActiveRepos` / `jdtlsXmx` / `importConcurrency`。

## Baseline Limitations

1. **正确性**：C-01 ~ C-07 全部成立，见上。其中 C-02 会让失败启动后的会话永久不可用，
   是最高优先级。
2. **新鲜度**：fast path 下没有任何 generation 来源（C-03），rg cache 与 SourceIndex
   各自为政；`JavaFileWatcher` 的生命周期绑定在 JDT 上，JDT 不启动就完全不工作。
3. **跨进程**：无 machine-level JDT 数量约束，无文件 lease，多 Codex 会话并行时
   JDT 进程数无上界（W-BASE）。
4. **结构事实**：`source-index.ts` 仍是 899 行的正则 `parseJavaSource`，
   不是 AST；`source-index-method-relations.ts` 227 行同源。Iteration C 替换。
5. **可测试性**：`JdtlsSession` 直接 `spawn`，无 transport 抽象，
   生命周期分支（并发启动、initialize 失败、child 退出）**无任何单元测试覆盖**。
   `jdtls-session.test.ts` 当前只覆盖 `filterGeneratedCodeDiagnostics` 等纯函数。
6. **环境**：三仓真实 benchmark 在本会话不可执行（见 Cold Benchmark）。
   所有 Iteration A 的质量结论只能基于单元测试与 fixture。
7. **工具链**：nvm shell function 在非交互 shell 下损坏，所有 npm script
   必须以绝对 node 路径调用，`npm test` / `npm run build` 之外的封装不可直接使用。

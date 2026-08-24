# Java Intelligence V3 Final Report

> Java-only 改造最终审查、修复闭环与发布级证据报告
> 日期：2026-08-09
> 计划依据：`docs/deep/codex-java-lsp-mcp-java-only-development-execution-plan-v3.1-2026-07-23.md`
> 最终决策：`ACCEPT_WITH_DOCUMENTED_EXCEPTION`
> 默认语义策略：`KEEP_EXPLICIT`

## 0. Executive Summary

本轮不是只对 Iteration E 做一次补丁式收尾，而是以原 V3.1 计划、历史提交、A–E 审计 findings 和当前实际代码为共同真源，完成了以下闭环：

1. 修复审计发现的 deadline、JavaIndex liveness、跨文件语义缓存、singleflight、watcher ownership、LRU、lease heartbeat、janitor owner token、evidence/ranking 双路径、verifier 身份和 attribution 等问题。
2. 删除不再可达的 V1/legacy/JPA/file-watcher 路径及无用直接依赖，统一到 JavaIndex V2、EvidenceSignal/family ranker、SemanticGateway 和 RepoChangeCoordinator。
3. 建立 source-locked V4 三仓 paired matrix，绑定 old/new commit tree、candidate patch、16 个未跟踪运行时输入、业务仓 HEAD、场景 SHA/row set 和 18 个 raw cell。
4. 完成 clean dependency install、build、836 项 TypeScript 测试、25 项脚本测试、smoke、fast check、13 项 fault、9 项 mutation、10 类 multiprocess/worktree、480 次 determinism 与三仓 cold/warm/first-touch 验证。
5. 生成本报告和 canonical evidence manifest；所有保留的缺口以 `UNMEASURED`、`UNBOUND` 或 documented exception 表达，不用零值、PASS 或推算值替代。

权威 cold 结论是：相对用户批准的最新可执行文档基线 `7df1a0e`，三仓质量指标完全不退化，`R_read_must=1.0000`，standard token P50 分别下降 `632 / 1005 / 855`，P95 比为 `0.970 / 0.976 / 1.007`，所有 hard gate 通过。

这不等于“从改造前 `48e665b` 到最终版本的整体收益百分比”。Phase 0 三仓 raw JSON 是 0 byte，报告明确禁止补写或推算一条不存在的严格 Phase0 paired baseline。

## 1. Scope and Non-goals（范围与非目标）

### 1.1 本报告覆盖

- 原计划 Task 0–36 的实现一致性和最终状态。
- Iteration A–E 后的审计问题及修复结果。
- Java-only runtime、JavaIndex V2、JDT exact semantic、Evidence/Ranker/ReadPlan V6、worktree freshness 和工具输出边界。
- 当前候选相对最新可执行报告基线的严格 paired cold 非回归与 token 收益。
- warm/default policy、真实 JDT first-touch、determinism、fault、mutation、multiprocess 和依赖审计。
- 仍然无法测量或无法归因的内容。

### 1.2 非目标

- 不把历史 Phase 1–5 不同 deadline、机器状态或 schema 的结果拼成同一 AB。
- 不把 benchmark 的 `spawnSync("rg")` 离线 fallback 当成 MCP 请求路径。
- 不把 warm-required 的个别 P_read/R_taskBlocking 增益包装成总体质量升级。
- 不用 synthetic fixture 替代所有真实仓 attribution，也不把 shadow attribution 当 production readPlan 真相。
- 不执行 push、发布或安装覆盖；验证完成后仅将与 executable tree 完全一致的本地源码固化为 commit `94c4ebf`，本报告仍只覆盖该不可变源码树和已绑定证据。

## 2. Exact Commit and Environment（精确提交、候选身份与证据等级）

### 2.1 基线选择

| 身份 | SHA / tree | 用途 |
|---|---|---|
| 改造前代码固定点 | `48e665ba73dc332dccd4b34e71adc1c048170cf6` / tree `538661f26ae49c490227b760daa075dd8b6e64fe` | 架构历史和代码规模参考；没有可用三仓数值 baseline |
| Task 0 evidence freeze | `7f58fd186108a08466e3a84591a65607407a3b1c` | Phase0 文档冻结，不是新的生产实现 |
| 本轮 approved executable baseline | `7df1a0eef98d709ef4307c2f66184746c0d95720` / tree `b096e87a952aa01c1d0a8b15092ac21e7e6b1929` | 用户批准的最新 docs 报告可执行基线；权威 cold old side |
| candidate base commit | `4e147560c38b76f942a15a92b34cbea69d734ef5` / commit tree `53f77574738178a8c4a126fabea8a69fe1996495` | 当前 tracked 基点 |
| candidate executable tree | `60ae785e8af9ac06012452ea41c6b1fe2d3606fd` | `4e14756` + 当前 candidate patch + 16 个绑定的 untracked runtime inputs |
| immutable remediation baseline | `94c4ebf` / tree `60ae785e8af9ac06012452ea41c6b1fe2d3606fd` | 验证后固化的同一 executable tree；V3.2 各 Sprint 的首个 old side |

`git diff --quiet 7df1a0e 4e14756 -- src scripts package.json package-lock.json README.md install-runtime.sh` 返回 0；这两个提交之间没有生产/脚本/依赖实现差异。因此 `7df1a0e` 是 Phase5 最新文档状态对应的可执行代码基线，而不是为了放宽 gate 临时挑选的弱基线。

### 2.2 Candidate patch

- patch：`artifacts/v3-final/task36-remediation-20260809/cold-matrix-final-source-locked-v4-pass3/candidate.patch`
- SHA-256：`dee1f4464adb670772c67f7e9eee3d644dc1b508ff3988bde7f2a04a00cb5638`
- bytes：`704902`
- pass2 与 pass3 patch 逐字节一致。
- pass3 manifest SHA-256：`cfe9024849b3a7df55b82cea8704a6ac02924967e3a23560528b2b63701b5ff5`
- pass3 summary SHA-256：`4f66d5cd06834d5905f728d957c379bd3afaffc42254a0255fb74a261823fb60`

### 2.3 证据等级

| 等级 | 定义 | 本报告使用 |
|---|---|---|
| A / BOUND | commit/tree/patch/repo/scenario/row set/raw hash 与 verifier 同时绑定 | cold V4 pass3 |
| B / POST-BUILD RECEIPT | 在最终 clean build 后执行，命令与 stdout/stderr 有 hash receipt，但没有独立 Git tree worktree | build/test/smoke、fault v4、mutation v4、multiprocess v4、determinism v3 |
| C / POLICY EVIDENCE | artifact 自洽，可支撑策略判断，但未绑定 candidate executable tree | warm-final-v2、first-touch-final |
| D / HISTORICAL | 历史阶段报告，只用于 lineage、返工原因或架构背景 | Phase0–5 旧报告和 superseded matrix |

只有 A 级证据用于 strict old/new cold 结论；不同等级不合并 P95。

### 2.4 Canonical evidence ledger

- canonical manifest：`artifacts/v3-final/task36-remediation-20260809/final-evidence-manifest.json`
- 独立 validation receipt：`artifacts/v3-final/task36-remediation-20260809/validation-receipt-final-v1.json`
- receipt generator/verifier：`artifacts/v3-final/task36-remediation-20260809/validation-final-v1/generate-final-evidence.mjs`

manifest 不把自身或 receipt 纳入 inventory，避免自哈希循环；receipt 在 manifest 写定后独立绑定 `manifestSha256`、`inventorySha256`、validator SHA 和逐文件校验结果。报告自身属于 manifest inventory，因此本节只给稳定路径，不把会随报告内容变化的 manifest hash 反写进报告。

## 3. Exact Environment（精确环境）

| 项 | 值 |
|---|---|
| OS | macOS `26.5.1` build `25F80`, arm64 |
| Node | `v22.16.0` |
| npm | `10.9.2` |
| JDK | OpenJDK `25.0.1+8-27` |
| JDT LS | Homebrew `jdtls 1.56.0` |
| ripgrep | `14.1.0` |
| Tree-sitter | native `tree-sitter 0.25.0` + `tree-sitter-java 0.23.5` |
| cold policy | `cold-nolsp`, `fast`, `deadlineMs=2000`, JDT disabled |
| warm-auto policy | `balanced`, semantic `auto`, `deadlineMs=3000`, JDT enabled |
| warm-required policy | `balanced`, semantic `required`, `deadlineMs=5000`, JDT enabled |
| first-touch | raw JDT session API, `timeoutMs=60000` |

环境原始输出：`artifacts/v3-final/task36-remediation-20260809/validation-final-v1/environment.stdout`。

## 4. Architecture Delivered（最终架构）

### 4.1 Runtime 与 request budget

- `DeadlineBudget` 是请求绝对截止时间的唯一真源。
- `RepoRuntimeManager.withContext()` 在 repo resolve / runtime create 之前创建 budget，并把同一个 budget 传到 LSP slot、RequestContext、JavaIndex status 和 AgentRouter。
- `RouterJavaIndex.withRequestOptions()` 使用 AsyncLocalStorage 绑定 request-scoped JavaIndex controls，不把 deadline 写入共享 mutable state。
- JavaIndex OPEN、STATUS、query、refresh/reconcile 和维护 RPC 均有 budget；silent worker 会清理 pending、retire worker，并让后续请求恢复。
- `JavaIndexClient.close()` 使用 bounded grace 后强制 terminate，shutdown 不再无限挂住。
- JDT startup/backend 使用稳定 operation cap；短 caller 只结束自己的等待，不把首个 caller 的短 budget 继承成共享 backend lifetime。

关键实现：`src/runtime/deadline-budget.ts`、`src/repo-runtime-manager.ts`、`src/java-index/router-java-index.ts`、`src/java-index/java-index-client.ts`、`src/jdtls-session.ts`。

### 4.2 Freshness 与唯一 watcher owner

- `RepoChangeCoordinator` 是唯一 filesystem watcher / generation owner。
- `JdtlsSession` 不再构造自己的 JavaFileWatcher；只消费 `applyRepoChangeBatch()`。
- 同一个 normalized batch 同步驱动 Router invalidation、SemanticGateway generation、JDT `workspace/didChangeWatchedFiles`、DocumentLru open-document resync 和 JavaIndex refresh/reconcile。
- 任意 ordinary `JAVA_*` batch 都会使跨文件 semantic result 失效，覆盖 `A query → B change → A query`。
- async degrade listener rejection 被显式捕获并记录，不再形成 unhandled rejection。

关键实现：`src/repo-change-coordinator.ts`、`src/repo-generation.ts`、`src/repo-runtime-manager.ts`、`src/jdtls-session.ts`、`src/document-lru.ts`。

### 4.3 JavaIndex V2

- native Tree-sitter Java incremental facts；坐标采用经过验证的 UTF-16 binding 语义，LSP boundary 统一转换。
- typed worker protocol、stable IDs、name/import resolution、calls/edges、facts/reverse indexes、coverage/manifest。
- foreground queue 与 chunked background sweep；sweep 有 cross-process slot、heartbeat 和 release。
- atomic gzip snapshot、schema/build validation、corruption recovery、sibling worktree seed 和 post-seed reconcile。
- negative answer 只在同 generation、coverage COMPLETE、无 failed/recovered/pending 且 snapshot verification 完成时允许。
- V1 source-index JSONL、legacy edge store、dual read/write、runtime backend flag 已删除。

### 4.4 Evidence、family ranker 与 ReadPlan V6

- ProviderOutcome 只携带 typed evidence；旧 `candidates` transitional side channel 已删除。
- candidate metadata 作为 EvidenceSignal 的显式 projection，最终排序只走 family ranker。
- 旧 additive `scoreWithPolicy` / ScoreRule 最终路径已删除，不再通过重复 provider 分数全量叠加。
- production readPlan selected paths 直接进入 attribution；shadow 不再自行运行不同 planner。
- required policy 保留 type-reference 和 deterministic must evidence。
- ReadPlan 使用一次 batched range query、byte/range/file hard budget、protected core 与 marginal utility。

### 4.5 Bounded JDT semantics

- SemanticGateway 对所有 SemanticOperation 执行 same-key singleflight，包括 type/call hierarchy。
- caller deadline 独立投影，最后 waiter 离开会 abort transport；PARTIAL/FAILED 不进入 COMPLETE cache。
- completed cache 有 TTL sweep、容量上限和 clear，stop/generation change 会真正释放旧 payload。
- JDT lease 在 STARTING、READY 和 semantic request 前 heartbeat；persistent heartbeat failure 阻止 false READY。
- DocumentLru 默认上限 64，支持 pin/inflight、didChange、didClose、delete、closeAll 和 eviction diagnostics。

### 4.6 公共工具面

当前只有 5 个工具：

1. `java_diagnostics`
2. `java_impact`
3. `java_runtime`
4. `java_status`
5. `java_symbol`

旧 references/restart/shutdown 被折叠到 `java_symbol` / `java_runtime`，没有双注册兼容面。

## 5. Audit Findings and Remediation（审计问题闭环）

| ID | 原问题 | 风险 | 最终修复 | 回归证据 | 状态 |
|---|---|---|---|---|---|
| P1-01 | ordinary JAVA_CHANGE 只清本文件 cache，未 bump semantic generation | A 未变、B 变更时 references/definition/implementation 最多陈旧 5 分钟 | batch consumer 对任意 JAVA_* bump gateway generation；跨文件回归 | `jdtls-session.test.ts` A→B→A；mutation 9/9 | CLOSED |
| P1-02 | LSP slot/startup/semantic 使用新 timeout 或旧 timeout number | 单请求绝对 deadline 失效 | 从 withContext 入点创建 budget，贯穿 slot、router、JavaIndex、JDT；维护操作单独 hard cap | request-budget、runtime manager、JDT raw deadline tests | CLOSED |
| P1-03 | JavaIndex live worker 不回包时 pending 永久挂住 | 请求/创建 singleflight/shutdown 卡死 | RPC deadline/cancel、worker retirement、OPEN budget、bounded CLOSE | java-index-client silent worker/close tests | CLOSED |
| P1-04 | paired verifier 未绑定完整 runtime/repo/scenario/row identity | old/new 可跑错构建仍显示 PASS | manifest/verifier V4：commitTree、executableTree、patch replay tree、repo HEAD、scenario SHA、row set、cell hash | verifier 25/25；pass3 BOUND | CLOSED |
| P1-05 | shadow attribution 使用独立 read-plan selector | `inReadPlan/blockedBy` 不代表生产行为 | production `buildReadPlan().selectedPaths` 直接传入 attribution | attribution/shadow tests | CLOSED |
| P1-06 | required 跳过 typeReference | must-read/recall 在三仓退化 | required 保留 type-reference deterministic evidence | required typeReference test；cold `R_read_must=1` | CLOSED |
| P1-07 | hierarchy 被排除在 singleflight 外 | 同 key 并发重复 JDT backend | 所有 operation 统一 shared backend，每 caller 独立 deadline | SemanticGateway hierarchy tests | CLOSED |
| P2-01 | SemanticGateway completed map 只按重访 key 删除 | 长驻 server 内存无界 | TTL sweep + max entries + clear/stop release | completed-entry convergence tests | CLOSED |
| P2-02 | watcher degraded async listener rejection 未捕获 | unhandled rejection/进程退出 | await/catch promise rejection 并记录 lastError | repo coordinator degraded listener test | CLOSED |
| P2-03 | JDT 自有 watcher 与 coordinator 双 ownership | generation/LSP/document cache 边界分裂 | 删除 JavaFileWatcher，session 只消费 normalized batch | applyRepoChangeBatch integration tests | CLOSED |
| P2-04 | lease heartbeat/ownerToken/janitor 证据不闭 | stale lease、PID reuse、cache 泄漏 | STARTING/READY heartbeat；release/heartbeat token compare；janitor token-aware | multiprocess v4 + cleanup tests | CLOSED |
| P2-05 | ProviderOutcome candidates 与 EvidenceSignal 双主链 | metadata/score 漂移、维护成本 | evidence-only ProviderOutcome、统一 materialize projection | rank/materialize/provider 241+ targeted coverage included in full suite | CLOSED |
| P2-06 | JPA adapter 实现但永不注册、无 real value | dead production-adjacent code | measured-or-remove：删除 adapter、annotations、fixture、tests | static scan / build | CLOSED_WITH_VARIANCE |
| P2-07 | first-touch 将不可观测 cache/shared 硬编码 false | 产生伪指标 | 明确输出 `unavailable` / `UNMEASURED_RAW_SESSION_API` | first-touch 21 cells | CLOSED |
| P2-08 | TAP selector 只看 Subtest 名，SKIP/TODO 可能假 PASS | Task36 fault/multiprocess gate 失真 | 解析 selected result status/directive，要求 passed 且无 directive | script tests 25/25；v4 suites exact count | CLOSED |
| P2-09 | verifier 只检查 finite，不检查合法域 | recall=2、负 token/latency 可绕过 | 比例 `[0,1]`、token/latency `>=0` | verifier mutation tests | CLOSED |
| P3-01 | README 仍写 SourceIndex、7 tools、旧 token 宣称 | 运维/调用面误导 | README/src/tools/install 文案统一为 JavaIndex V2/5 tools | dead-text scan | CLOSED |
| P3-02 | 未使用直接依赖 `vscode-languageserver-protocol` | 供应链和维护噪声 | 从 package/package-lock 删除 | npm ci / npm ls | CLOSED |

## 6. Task 0–36 Traceability（原计划一致性）

状态定义：

- `CLOSED`：实现与本轮证据闭环。
- `CLOSED / UNMEASURED`：实现闭环，但计划中的观察性/归因性指标没有可靠 raw，不伪造 PASS。
- `DOCUMENTED_EXCEPTION`：历史输入不可恢复，任务本身没有可执行实现可闭环。
- `CLOSED_WITH_EXCEPTION` / `CLOSED_WITH_DOCUMENTED_EXCEPTION`：实现和当前可执行门禁已闭环，但采用了本报告明确批准的基线替代，或仍保留不参与 hard gate 的历史/观察性缺口。
- `CLOSED_WITH_VARIANCE`：计划目标通过经过验证的等价实现、坐标语义修正或 measured-or-remove 删除完成；不是保留双路径。

| Task | 最终状态 | 主要证据 / 说明 |
|---|---|---|
| T0 | DOCUMENTED_EXCEPTION | `48e665b` 固定；Phase0 三仓 raw 为 0 byte，数值不可恢复 |
| T1 | CLOSED | DeadlineBudget / completion / error mapping |
| T2 | CLOSED | injectable JDT transport |
| T3 | CLOSED | transactional lifecycle / restart backoff |
| T4 | CLOSED | atomic slot reservation + caller budget |
| T5 | CLOSED | streaming rg、partial 不缓存、caps |
| T6 | CLOSED | repo containment / stable error codes |
| T7 | CLOSED | hierarchy visited/deadline/cancel/singleflight |
| T8 | CLOSED_WITH_EXCEPTION | correctness closure；相对 Phase0 数值不可比 |
| T9 | CLOSED | coordinator/generation；mutation 9/9 |
| T10 | CLOSED | single change owner + cross-file semantic invalidation |
| T11 | CLOSED | delete/rename/build/layout reconcile |
| T12 | CLOSED | stopped contexts、alias LKG、cleanup |
| T12a | CLOSED | machine JDT/sweep lease + heartbeat/reclaim |
| T12b | CLOSED / UNMEASURED | 500-file storm 和 foreground non-blocking 已测；真实 foreground-anchor 相对参考 P95 未测 |
| T12c | CLOSED | janitor active-cache ownerToken protection |
| T13 | CLOSED_WITH_EXCEPTION | Iteration B correctness/multiprocess closure；storm P95 保留 UNMEASURED |
| T14 | CLOSED_WITH_VARIANCE | native Tree-sitter；UTF-16 binding 偏差已文档化验证 |
| T15 | CLOSED | typed protocol/stable IDs + RPC deadline/cancel |
| T16 | CLOSED | AST facts/incremental parser/ranges |
| T17 | CLOSED | import/name resolver |
| T18 | CLOSED | calls/edges/ambiguity bounds |
| T19 | CLOSED | normalized store/reverse indexes |
| T20 | CLOSED | sweep/coverage/foreground/negative gating |
| T21 | CLOSED | atomic versioned snapshot/corruption recovery |
| T21a | CLOSED | sibling snapshot seed/revalidation/reconcile |
| T22 | CLOSED | V1/V2 migration完成，V1 runtime 删除 |
| T23 | CLOSED | JavaIndex V2 report + current final regression |
| T24 | CLOSED | evidence-only ProviderOutcome |
| T25 | CLOSED | family ranker 唯一最终排序主链 |
| T26 | CLOSED | reference containment/rank-before-truncate |
| T27 | CLOSED | Spring adapter + fixture/real matrix non-regression |
| T28 | CLOSED | MyBatis parser/index/adapter；真实独立 provider attribution 仍有限 |
| T29 | CLOSED_WITH_VARIANCE | MapStruct/Lombok 保留；unmeasured JPA 按 measured-or-remove 删除 |
| T30 | CLOSED / UNMEASURED | planner 实现闭环；range evidence 仅 15/120 measured |
| T31 | CLOSED | ImpactResultV6、5 tools、schema measurement |
| T32 | CLOSED / UNMEASURED | production attribution 修复；全部 provider 独立 cost/counterfactual 未覆盖 |
| T33 | CLOSED | all-op SemanticGateway + persisted SemanticEdgeStoreV2 |
| T34 | CLOSED / UNMEASURED | DocumentLru 功能闭环；cold JDT-disabled，不能把 P95 归因给 LRU |
| T35 | CLOSED | full policy matrix 支持 `KEEP_EXPLICIT` |
| T36 | CLOSED_WITH_DOCUMENTED_EXCEPTION | 所有实现 gate 完成；Phase0/agent trace/部分观察性指标单列 |

## 7. Files Added/Deleted and Complexity（文件与复杂度）

### 7.1 本轮 remediation 相对 `4e14756`

- 完整 tracked diff：103 paths，`+4969 / -2644`，其中 94 modified、9 deleted。
- 加上 16 个由 pass3 manifest hash 绑定的 untracked runtime inputs，source-locked executable patch 共覆盖 119 paths，`+7783 / -2644`。
- 当前 `src`：224 个 TS 文件、95 个 test TS 文件、55,252 TS LOC，其中 test 23,614 LOC；生产约 31,638 LOC。

### 7.2 相对 pre-V3 复杂度

历史固定点约 9,461 production TS LOC；当前约 31,638，约 3.34 倍。增加主要来自 JavaIndex V2、framework evidence、rank/read-plan、runtime/lease、benchmark 和测试，而不是保留旧 V1 双路径。

这是改造的主要长期成本：系统能力显著增强，但维护面更大。最终接受依赖于以下约束继续成立：单一 watcher owner、单一 final ranker、单一 JavaIndex/edge store、bounded cache/worker/document/lease、machine-verifiable gates。

### 7.3 删除的 live 路径

- `src/source-index.ts`、`src/source-index-method-relations.ts`、旧 source-index tests。
- `src/edge-store.ts` 及 tests。
- old finalize-rank/finalize-scoring。
- standalone references/restart/shutdown tools。
- session-owned `src/file-watcher.ts` 及 test。
- JPA adapter/annotations/test/fixture。
- abandoned direct dependency `vscode-languageserver-protocol`。

### 7.4 Static dead-path scan

计划原始扫描只有一个匹配：

```text
src/benchmark-agent-impact.ts:734 spawnSync("rg")
```

分类：`KEEP_NON_REQUEST_PATH_WITH_REASON`。它只属于离线 `cold-nolsp` benchmark fallback；MCP 请求路径使用 bounded streaming RgRunner。没有未分类 match。

## 8. Full Local Verification Receipt（本地全量验证）

| 验证 | 结果 | 原始证据 |
|---|---|---|
| `npm ci` | PASS；112 packages audited，0 vulnerabilities | `validation-final-v1/npm-ci.*` |
| `npm run build` | PASS；clean + tsc + build stamp | `validation-final-v1/npm-build.*` |
| `npm test` | PASS；836/836，0 fail/skip/todo | `validation-final-v1/npm-test.*` |
| script tests | PASS；25/25 | `validation-final-v1/script-tests.*` |
| `npm run smoke` | PASS；5 public tools | `validation-final-v1/npm-smoke.*` |
| `./check-codex-mcp.sh --fast` | PASS；0 warnings | `validation-final-v1/check-fast.*` |
| `npm ls --all` | PASS | `validation-final-v1/npm-ls-all.*` |
| `npm audit --omit=dev` | PASS；0 vulnerabilities | `validation-final-v1/npm-audit-prod.*` |
| `npm outdated` | informational | `@types/node/tree-sitter/typescript/vscode-jsonrpc` 有新版本；本轮不做无关升级 |
| `git diff --check` | PASS；0 output | `validation-final-v1/git-diff-check.*` |
| static dead scan | PASS；1 classified match | `validation-final-v1/dead-path-scan.*` |

smoke 第一次发现本地残留的空 `fixtures/framework-jpa/` 目录仍被 layout scanner 识别；目录无文件且不受 Git 跟踪，已精确删除并重跑 smoke。最终 smoke 不再报告 JPA root。

## 9. Correctness and Fault-Injection Results

### 9.1 Fault suite v4

- 13/13 required cases PASS。
- 每个 test-name pattern 必须实际选中恰好一个目标测试；selected result 必须 `passed` 且无 `SKIP/TODO` directive。
- stderr：0 byte。

覆盖：

1. concurrent JDT start；
2. initialize timeout；
3. child exit during initialize；
4. child exit after READY；
5. rg partial timeout；
6. rg limit seam；
7. JavaIndex crash；
8. snapshot corruption；
9. watcher error；
10. dirty reconcile；
11. outside-repo result；
12. semantic timeout while another waiter remains；
13. all waiters cancel。

`rg-partial-limit` 证明 bounded limit 行为，不伪称真实 OS `ENOBUFS` 注入。

### 9.2 关键不变量

- no false READY。
- incomplete result 不写 COMPLETE cache。
- outside-repo path 不序列化。
- deadline/cancel 后 pending 被清理；指定路径下 next request 可恢复。
- degraded state 在 diagnostic status 中可见。
- last waiter 离开后 backend transport 被 abort；late completion 不回填 cache。

## 10. Freshness Mutation Results

最终 mutation v4：

- 9/9 cases；
- stale count `0`；
- old renamed/deleted facts absent；
- watcher ready；
- 13 个 normalized batches；
- overlap probe：request generation `14`、indexed generation `15`、`changedDuringRequest=true`。

精确 9 类：method body、package-private method、nested record、rename Java type/file、delete Java file、duplicate simple-name import switch、pom module、MyBatis XML statement、malformed Java then repair。

该 suite 通过 RepoChangeCoordinator/Runtime/AgentRouter 路径，不是只对 worker 直接调用 refresh 的伪 watcher gate。

## 11. JavaIndex Coverage and Snapshot Results

- warm 六个 cell 的 Java coverage 全为 COMPLETE，failedFiles=0。
- negative lookup 的 runtime gate要求同 generation、COMPLETE、无 failed/recovered/pending、watcher ready、snapshot verified。
- corruption、schema/build identity mismatch 会丢弃并 rebuild，不保留旧 schema reader。
- seed target 在 COMPLETE 前不允许 negative answer。
- snapshot publish 原子化，失败不产生半文件。
- JavaIndex quiescence 同时检查 pending work 与 coverage，不再在最后 chunk splice 后过早认为 idle。

## 12. Worktree Lease, Storm, Janitor and Snapshot Seed Results

最终 multiprocess v4：

| Gate | 结果 |
|---|---|
| configured JDT slots / observed max | `2 / 2` |
| configured sweep slots / observed max | `2 / 2` |
| same-worktree duplicate JDT spawn | `0` |
| dead lease reclaimed | `true` |
| stale lease reclaims | `2` |
| live PID stolen | `false` |
| subprocess cases | PASS |
| exact selected behavior cases | PASS |

还覆盖 active fast-only cache janitor、linked `.git/common-dir` ignore、500-file storm、foreground query 不等 sweep、snapshot generation rebase、sibling seed matching/changed/concurrent 和 seed reconcile equivalence。

保留的观察性缺口：没有在最终 suite 中产出“storm 时 foreground anchor P95 相对安静参考”的真实毫秒值；当前证据证明不阻塞和一次 generation/reconcile，不证明特定 P95 比例。

## 13. Determinism

最终 determinism v3 在 clean build 后执行：

| 仓库 | 场景 | runs/场景 | attempts | 结果 |
|---|---:|---:|---:|---|
| lishuedu | 8 | 20 | 160 | PASS / stable=true |
| cipherlink | 8 | 20 | 160 | PASS / stable=true |
| exam-parent-v3 | 8 | 20 | 160 | PASS / stable=true |

合计 480 attempts；candidate path order、readPlan file/range order、serialized family scores、completion/freshness 一致；latency/cache counters 不参与 drift gate。全部 stderr 为 0。

## 14. Per-Provider Quality/Cost Attribution

### 14.1 已闭环

- production selected readPlan paths 是 attribution 的唯一 readPlan truth。
- required type-reference 进入生产结果，不再被 policy 跳过。
- provider evidence 会记录 family/provenance/completeness/candidate metadata。
- framework aggregate timer 不再冒充单 adapter ID。
- MapStruct real canary 的历史保留只作为 adapter 选择背景；最终 cold matrix证明总体不退化。

### 14.2 未完整测量

- 最终 source-locked cold run关闭 shadow，因此不是每个 provider 都有独立 counterfactual cost/value 行。
- MyBatis 真实 XML 场景数量有限；不能把 aggregate framework time 解释为 MyBatis 独立收益。
- `readPlanRangeRecall` 每个 project/variant 只有 15 measured / 105 unmeasured attempts；已测 mean/min=1，但状态必须是 `PARTIAL`。
- JPA 没有真实价值证据，已删除而不是保留 unreachable implementation。

## 15. Three-Repo Cold Matrix（权威 old/new 对比）

### 15.1 身份与执行

- canonical：`cold-matrix-final-source-locked-v4-pass3`
- verifier：V4
- 3 repos × 3 rounds × old/new = 18 cells
- 8 scenarios/repo × 5 runs/cell
- 120 attempts / variant / repo；共 720 attempts
- round order：AB / BA / AB
- JDT disabled；`cold-nolsp` / fast / `deadlineMs=2000`
- raw stderr：18/18 为 0
- warnings：`[]`

业务仓：

| repo | HEAD | tree | scenario SHA-256 |
|---|---|---|---|
| lishuedu | `db63b1a7e393edd90449eb013d7d1c4d65c366f2` | `22f0ce444e4cac484de85c8a0bf02240ad70d712` | `579178746bb123822a2908025fc60aa26a8c79958079dc3043dfa936fd4ba916` |
| cipherlink | `fa433982e92e52dd610650d1e79f2d041179b1d3` | `21a1075c7b211932a4cdb2abf2742521b1eba31f` | `47850fd6ac88804ecec0d1d0abb42ff1369a6fc1e42ad447abc334417ab084ca` |
| exam-parent-v3 | `f90a0b475f7be2ed003703feecec8195bc7eb976` | `dcdb2024879686451859c64260c7e1f3a4721fa7` | `83cfde7858cb3d24906c69808f321f525451afbd2b90b3f3805b2d65c62d0769` |

### 15.2 质量、token 与延迟

| 仓库 | quality old→new | token P50 old→new | P50 ms old→new | P95 ms old→new | P95 ratio | gate |
|---|---|---:|---:|---:|---:|---|
| lishuedu | recall `0.784673`、P_read `0.677083`、R_must `1`、R_task `0.604563`，完全相同 | `8186→7554` (`-632`, `-7.72%`) | `22.144→23.212` | `171.935→166.793` | `0.9701` | PASS |
| cipherlink | recall `0.832223`、P_read `0.637500`、R_must `1`、R_task `0.491419`，完全相同 | `8171→7166` (`-1005`, `-12.30%`) | `56.954→56.942` | `161.095→157.245` | `0.9761` | PASS |
| exam-parent-v3 | recall `0.778977`、P_read `0.604167`、R_must `1`、R_task `0.500298`，完全相同 | `7299→6444` (`-855`, `-11.71%`) | `34.680→36.798` | `135.175→136.118` | `1.0070` | PASS |

### 15.3 Gate receipt

每仓以下六项全为 true：

1. `min(R_read_must)=1.0000`；
2. `R_task_blocking(new) >= old`；
3. `recall(new) >= old`；
4. `P_read(new) >= old - 0.02`；
5. `estimatedTokensP50(new) <= old`；
6. `P95(new) <= max(old × 1.25, old + 50ms)`。

P95 允许门槛分别为 `221.935 / 211.095 / 185.175ms`；实际均有充分余量。`mustFailureScenarios=[]`。

### 15.4 “提升多大”的准确回答

严格可证明的提升是：在质量完全持平的前提下，三仓 standard estimated-token P50 下降 `7.7%–12.3%`；cold P95 两仓下降约 `3.0% / 2.4%`，exam 增加约 `0.7%`，整体表现为延迟中性、无质量回归。

不能证明的是 `48e665b→final` 的总体百分比，因为 Phase0 paired raw 不存在。报告不使用历史不同 schema/candidate 的 36–66% 等数字。

### 15.5 Superseded runs

- 较早 Phase5 final 曾出现 exam P95 ratio `1.465`，同 cell 有 724ms 多阶段 host stall；隔离重跑未复现。
- pass1 是修正 source identity 后的首次正式 PASS。
- pass2 source identity 与 pass3 相同且 PASS，但中段曾有约 10 秒孤立 JDT 环境探测干扰，标记 `SUPERSEDED_ENVIRONMENT_INTERFERENCE`。
- pass3 全程独占，是唯一 canonical cold。

不删除失败/被替代 artifact；它们保留用于审计 lineage，但不得和 pass3 池化。

## 16. Warm Decision（warm 与默认策略）

warm-final-v2 每个 cell 8 场景 × 5 runs = 40 attempts，六份 stderr 都为 0，coverage COMPLETE、failedFiles=0。

| 项目 | policy | recall | P_read | R_read_must | R_task_blocking | token P50 | P50 / P95 ms |
|---|---|---:|---:|---:|---:|---:|---:|
| cipherlink | auto | 0.832223 | 0.637500 | 1.000000 | 0.491419 | 7167 | 62.604 / 1696.229 |
| cipherlink | required | 0.832223 | 0.677083 | 1.000000 | 0.516419 | 7162 | 62.822 / 1687.585 |
| exam-parent-v3 | auto | 0.778977 | 0.604167 | 1.000000 | 0.500298 | 6444 | 67.472 / 1619.941 |
| exam-parent-v3 | required | 0.751989 | 0.656250 | 1.000000 | 0.543155 | 6740 | 69.024 / 4516.712 |
| lishuedu | auto | 0.784673 | 0.677083 | 1.000000 | 0.604563 | 7555 | 33.956 / 180.262 |
| lishuedu | required | 0.770387 | 0.725000 | **0.956250** | 0.587421 | 7208 | 110.244 / 4530.133 |

结论：`KEEP_EXPLICIT`。

- required 在 lishuedu 破坏 must-read hard floor，单 attempt 最低 `0.5`。
- exam required recall 下降约 `0.027` 且 token 增加 296。
- auto 是 3s、required 是 5s，不把 P95 当成同 deadline AB。
- required 仍可作为显式用户选择；不得变成默认。

## 17. Real-JDT First Touch

first-touch-final：

- official cells `21/21`；
- 10 attempts/cell；
- failed attempts `0`；
- partial timeout `2`；
- outside-repo max `0`；
- `freshP95Under800ms=false`；
- reused cache-hit P50：`UNMEASURED_RAW_SESSION_API`。

fresh / no prepare / references P95：

| repo | P95 | completion |
|---|---:|---|
| cipherlink | `25.821s` | 10 COMPLETE |
| exam-parent-v3 | `50.615s` | 10 COMPLETE |
| lishuedu | `65.787s` | 8 COMPLETE + 2 PARTIAL_TIMEOUT |

这组是 raw JDT session + 60s timeout，不与 cold 2s 或 warm 3s/5s P95 比较。cacheHit/shared 在 raw API 不可观测，正确值是 `unavailable`，不是 false。

## 18. Token and Agent Trace Results

### 18.1 工具 schema

当前实测：5 tools、5164 JSON bytes、约 1291 tokens。

逐工具：diagnostics 148、impact 537、runtime 162、status 132、symbol 312 estimated tokens。

历史 7-tool 值只能用于文档推算，不能称为本轮 paired measurement。

### 18.2 java_impact / readPlan token

权威 cold 表明 standard estimatedTokens P50 在三仓下降 632/1005/855；这是本轮最强、最稳定的可量化收益。

### 18.3 六个 end-to-end Agent trace

状态：`UNMEASURED_OBSERVATIONAL`。

当前没有固定 model/client、相同 prompt、Task0 同客户端 replay 的 agent trace harness。benchmark 记录了 readPlan/token/taskBlocking，但不记录真实 Agent 的 MCP 调用序列、follow-up file reads 和 first useful context；不能把 benchmark rows 改名为 Agent trace。

该项是计划明确的 observational evidence，不参与 deterministic hard gate。本报告接受实现，但不宣称 Agent 行为层的 before/after 百分比。

## 19. Rejected Designs（明确拒绝）

- 拒绝继续保留 V1 source-index / legacy edge-store / dual read-write。
- 拒绝 session-owned second watcher。
- 拒绝把 caller 的短 deadline 作为 shared backend hard cap。
- 拒绝 hierarchy 绕过 singleflight。
- 拒绝旧 additive candidate score 继续参与 final rank。
- 拒绝 shadow planner 代替 production readPlan attribution。
- 拒绝未测 JPA adapter 留在仓库“以后再说”。
- 拒绝 repository/application/service filename heuristics 等项目定制 overfit。
- 拒绝同时发布 native/WASM Tree-sitter；保留已验证 native binding。
- 拒绝把 required 设成默认。
- 拒绝用空 Phase0 artifact、zero default 或手抄报告补齐缺失证据。

## 20. Remaining Known Limits and Follow-up（已知限制与后续）

### 20.1 必须保留的 exception / unmeasured

1. Phase0 真实三仓 baseline 为 0-byte artifact；整体 pre-V3 数值不可比。
2. range evidence 每 variant 仅 15/120 measured，不能声称全量 range recall。
3. storm foreground anchor 的真实相对 P95 未测；只有 non-blocking correctness。
4. final source-locked provider-by-provider counterfactual/cost 未全覆盖。
5. first-touch raw API 不暴露 SemanticGateway cache/shared 完整观测。
6. LRU 性能收益不能从 JDT-disabled cold matrix 归因。
7. 六个真实 Agent traces 未测。
8. 大体积 raw evidence 仍保留在本地 artifact 目录并由 canonical manifest/receipt 哈希绑定；源码已固化为 `94c4ebf`，报告与小型 receipt 随后单独提交，但未配置远端不可变对象存储。

### 20.2 后续优化优先级

P0（策略安全）：

- 保持 `KEEP_EXPLICIT`；required 只有在 lishuedu must floor 恢复到 1 且 fresh first-touch gate 达标后才重新评估。

P1（证据完整度）：

- 给所有 24 个真实场景补 representative `mustReadRanges`，把 rangeEvidence 从 PARTIAL 提升为全量 measured。
- 建立固定 client/model/prompt 的六任务 Agent trace harness；与同客户端可执行基线配对。
- 增加真实 500-file storm foreground anchor 的安静/风暴 paired P50/P95。

P2（性能与资源）：

- 为 JavaIndex RPC 增加 worker queue/processing 分层 telemetry，区分 caller wait、IPC queue 与 worker execution。
- 评估可合作取消的 query，减少一个请求 deadline 触发整 worker retire 的 blast radius；必须保留 silent-worker recovery。
- 为 first-touch 分离 JDT process startup、workspace import、prepare 与 operation，优先减少 25–66s 首触，而不是调整默认 timeout 掩盖。

P3（维护成本）：

- 持续用单 owner / 单 path 静态扫描防止旧兼容分支回流。
- 将 canonical manifest verifier 纳入 CI；artifact 缺 hash、row、stderr 或 source identity 时硬失败。
- 逐步降低 31k+ production LOC 的模块耦合，但禁止为了 LOC 重新合并语义不同的状态机。

## 21. Reproduction Commands

### 21.1 Clean local verification

```bash
npm ci
npm run build
npm test
npm run smoke
./check-codex-mcp.sh --fast

node --test \
  scripts/run-three-repo-cold-matrix.test.mjs \
  scripts/verify-three-repo-cold-matrix.test.mjs \
  scripts/task36-fault-suite.test.mjs \
  scripts/task36-multiprocess-smoke.test.mjs \
  scripts/task36-tap-evidence.test.mjs
```

### 21.2 Fault / mutation / multiprocess

```bash
node scripts/task36-fault-suite.mjs --output artifacts/v3-final/task36-remediation-20260809/fault-suite-final-v4.json
node dist/benchmark/task36-mutation-matrix.js --output artifacts/v3-final/task36-remediation-20260809/mutation-matrix-final-v4.json
node scripts/task36-multiprocess-smoke.mjs
```

### 21.3 Canonical cold matrix

```bash
node scripts/run-three-repo-cold-matrix.mjs \
  --baseline 7df1a0eef98d709ef4307c2f66184746c0d95720 \
  --lishuedu /tmp/codex-java-v3-golden-20260809/lishuedu \
  --cipherlink /tmp/codex-java-v3-golden-20260809/cipherlink \
  --exam-parent-v3 /tmp/codex-java-v3-golden-20260809/exam-parent-v3 \
  --output-dir artifacts/v3-final/task36-remediation-20260809/cold-matrix-final-source-locked-v4-pass3
```

### 21.4 Static dead scan

```bash
rg -n 'parseJavaSource|source-index\.files\.jsonl|source-index\.symbols\.jsonl|appendFileSync|spawnSync\("rg"|AGENT_RG_CACHE_TTL_MS|routingVersion:\s*5|ImpactResultV5|INDEX_V2|legacy edge' src scripts package.json
```

## 22. Final Gate Receipt

| Gate | Final |
|---|---|
| build/test/smoke | PASS |
| real repo `R_read_must=1` cold | PASS 3/3 |
| recall / P_read / R_taskBlocking non-regression | PASS 3/3 |
| standard token P50 <= baseline | PASS 3/3 |
| cold P95 threshold | PASS 3/3 |
| outside repo | PASS / 0 |
| mutation stale | PASS / 0 of 9 |
| partial COMPLETE cache writes | PASS / 0 reproductions |
| false READY | PASS / 0 reproductions |
| open document bound | PASS / default max 64 |
| negative cache only COMPLETE | PASS |
| machine JDT/sweep slots | PASS / 2 configured, 2 observed |
| same-worktree duplicate child | PASS / 0 |
| seed stale leak | PASS / 0 in selected gates |
| seed reconcile equivalence | PASS |
| determinism | PASS / 480 attempts |
| default required | REJECTED; KEEP_EXPLICIT |
| Phase0 overall numeric uplift | UNMEASURED |
| full range coverage | UNMEASURED/PARTIAL |
| six Agent trace comparison | UNMEASURED_OBSERVATIONAL |

## 23. Final Decision

`ACCEPT_WITH_DOCUMENTED_EXCEPTION`

接受内容：

- 当前 Java-only V3 运行架构和 Task36 remediation candidate；
- 相对用户批准的最新可执行 docs baseline `7df1a0e` 的 source-locked cold 非回归与 token 收益；
- `KEEP_EXPLICIT` 作为最终语义策略；
- measured-or-remove、single owner、bounded resources 和 machine-verifiable evidence 作为后续维护边界。

documented exceptions：

- Phase0 三仓 baseline 原始失败，不能给出 `48e665b→final` 总体提升百分比；
- range/storm/provider attribution/LRU attribution/raw cache metrics/Agent trace 的明确 UNMEASURED 项；
- supplemental suites 通过 validation receipt 绑定到本轮 clean build，但只有 cold pass3 具备完整 executable-tree paired identity。

本决策不是发布/commit/push 动作。若后续要形成不可变发布证据，下一步是由用户明确授权提交代码、报告与 canonical manifest；提交前不得修改任何 runtime source，否则必须重新生成 source-locked cold manifest。

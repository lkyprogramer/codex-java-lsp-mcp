# codex-java-lsp-mcp 索引生命周期 v2（ILV2）AI 执行手册

| 项 | 值 |
|---|---|
| 日期 | 2026-10-13 |
| 状态 | IN_PROGRESS：P0-T0 已完成，下一项 P0-T1 |
| 代码基线 | `SHA_BASE` = `ad412ceb51bc616df3700feca7d3c14ea6dc5ee0`，即已部署 release `83aa814049e5` 的源码，位于分支 `codex/java-specialist-release-audit-v1.1`（父提交 `04058e4`）。ILV2 在分支 `codex/index-lifecycle-v2` 上进行 |
| 生产现状 | daemon 已停：launchd 服务未加载，并已 `launchctl disable`，登录时不会自动启动（见 §1.6）。生产索引已全部删除 |
| 总目标 | 在大仓（lishu-v2 等）加并行 worktree 的场景下做到四点：请求永不超过截止时间；新 worktree 秒级可答；构建不再活锁；每个 worktree 只为自己的差量付成本 |
| 读者 | 执行 AI（实现者、评审者、门禁执行者）；审批人 lky |
| 标注约定 | 【实测】本机实际观察到的数据；【代码】读源码确认（附文件和行号）；【推断】基于证据的推理，尚未复现；【目标】验收指标；【待测】由指定 Task 测出 |

> 本手册是 ILV2 的执行真源，与旧计划文档冲突时以本手册为准。仓库规则（`.cursor/rules/*`、`docs/phase-v4/three-repo-host-load-policy.md`）和用户规则优先于本手册。

## 目录

- [0 执行者必读](#0-执行者必读)
- [1 现状基线](#1-现状基线)
- [2 v2 目标规格](#2-v2-目标规格)
- [3 Phase 与 Task 总表](#3-phase-与-task-总表)
- [4 Phase 0：止血与可测量](#4-phase-0止血与可测量)
- [5 Phase 1A：快照生命周期 v2](#5-phase-1a快照生命周期-v2)
- [6 Phase 1B：schema v10 存储压缩](#6-phase-1bschema-v10-存储压缩)
- [7 生产切换、观察与回滚](#7-生产切换观察与回滚)
- [8 Phase 2：真实负载评测与 Tool API v2](#8-phase-2真实负载评测与-tool-api-v2)
- [9 Phase 3：精度层（实验决定）](#9-phase-3精度层实验决定)
- [10 Phase 4：收敛](#10-phase-4收敛)
- [11 验证工具规格](#11-验证工具规格)
- [12 风险与止损](#12-风险与止损)
- [附录 A 代码锚点](#附录-a-代码锚点)
- [附录 B JSON 模板](#附录-b-json-模板)
- [附录 C 清理记录与证据归档](#附录-c-清理记录与证据归档)

---

## 0 执行者必读

### 0.0 需要用户确认的决策

下表中的决策未确认前，不得越过对应步骤。确认内容和时间记入对应 task-result 的 `approvals` 字段。

**2026-10-13 用户决定**：
- U1、U2、U3 按建议同意。
- U4 选择不部署：P0-T3b、P0-T4、P0-T5 记 NOT_RUN，P0-G3、P0-G4 不跑，P0 不执行 §7，closeout 后直接进入 P1A。
- 用户同时要求把 U1 基线和本手册提交并 push 到 `origin`。此后的 push 仍须用户逐次明确要求（§0.2 第 4 条不变）。
- U5–U9 未决定。

| ID | 决策 | 阻塞的步骤 | 建议 |
|---|---|---|---|
| U1 | 把当前 95 条未提交改动固化为一个本地 commit，作为基线 `SHA_BASE`。这些改动就是已部署 release `83aa814049e5` 的源码，目前只存在于工作区。前置：附录 C.3 的仓库内证据提炼已完成 | P0-T0 及之后全部 | 同意。message 用 `chore: snapshot deployed 83aa814049e5 sources` |
| U2 | 执行期间允许在本地分支 commit、打本地 tag `ilv2/*`；不 push | 每个 Task 收尾 | 同意 |
| U3 | 允许在 :38457 启动隔离 canary daemon，使用隔离缓存和 `JDTLS_BIN=/usr/bin/false` | P0-T8、P1A 门、§7 | 同意 |
| U4 | Phase 0 是否部署到生产。这决定 P0-T3b、P0-T4、P0-T5 是否执行 | P0-T3 之后 | 想在 P1A 落地前恢复使用 LSP 就部署；否则不部署，直接进 P1A |
| U5 | Phase 2 的付费模型 A/B | P2-T3 | 按次确认预算 |
| U6 | 读取 `~/.codex/sessions`，只抽取 `java_*` 调用的结构化元数据 | P2-T1 的可选步骤 | 可以不做 |
| U7 | 每一次生产安装（`./install-runtime.sh`），需同时确认 SHA 和回滚方式 | §7 | 每次单独确认 |
| U8 | 修改全局 `~/.codex/AGENTS.md` 或 hook | P2-T5 | 执行者只出 diff，由用户落地 |
| U9 | 删除生产缓存里的旧格式数据（legacy `index.sqlite*`、`.v2/` 回滚残留） | §7.5、§10 | 稳定运行 7 天后再确认 |

### 0.1 角色与模型档位

- **实现者**：每个 Task 一个会话，只改 Task 卡「范围」内的文件。
- **评审者**：与实现者不是同一会话，只读，只评审不可变的 commit SHA。
- **门禁执行者**：只跑命令、收集证据，不改代码。
- 正式评审、架构裁决和门禁结论不得使用 fast 档模型。实际档位低于要求时，停止并报告，不得静默降级重试。
- 并行子代理只用于只读探索或互不重叠的文件写入；主会话负责整合和最终验证。

### 0.2 硬禁止

违反任何一条都必须立即停止，并在 task-result 里记录。

1. **不写生产。** 生产缓存 `~/Library/Caches/codex-java-lsp/`（`telemetry/` 只读）、release 和 state 目录 `~/Library/Application Support/codex-java-lsp-mcp/`、LaunchAgent plist 都不得写入；不调用生产 :38456 上的工具（§7 获批后的 smoke 除外）。
2. **输入仓库只读。** `/Users/luo/Documents/program/**` 下的业务仓库及其 worktree 不得写入任何文件，包括 `.git/`。因此不得对这些仓库执行 `git worktree add/remove/prune`、`fetch`、`gc`、`checkout`。需要的 git 读命令一律加 `--no-optional-locks`。需要可写副本时，用 §4 P0-T0 建立的 `/tmp/frozen-java-repos/*` 克隆。
3. **不碰全局配置和凭据。** 不改 `~/.codex/AGENTS.md`、hooks、`config.toml`；不复制 auth 文件；不读取 `.env` 或凭据；日志、证据、commit 中不得出现令牌。
4. 不 `git push`，不建 PR，不打远程 tag，不改写共享历史。本地 commit 和 tag 以 U2 为准。
5. 不使用 `--activate-http`；不设置 `JAVA_LSP_ENGINE`。常驻 HTTP daemon 只允许生产 :38456 和 canary :38457 两个。测试内临时启动的 server 用随机端口，测试结束即关闭。
6. 不加 heap/RSS 守护阈值，无论作为门禁还是运行时 kill 条件（现行约定）。
7. 不把 fat-service 加进 pins，不改生产 `projects.json`。
8. 不新增生产依赖（`package.json` 的 `dependencies`），不引入第二种存储引擎。
9. 不用削弱断言、删除有效覆盖、扩大 mock、跳过测试、吞异常的方式过门；BLOCKED_ENV 不得写成 PASS。
10. **三仓矩阵按 load 政策执行**（workspace rule）：1 分钟 load < 20 时必须跑；load 永远不是拒绝门，≥ 20 时只记录；唯一的主机硬门是可用内存 ≥ 4 GiB。
11. 不删除或改写 `docs/evidence-archive/` 下的记录和本机归档根 `/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/`，也不删除历史文档引用的证据文件（附录 C）。只能删除本手册产生、且已在 task-result 的 `artifacts` 里登记的测试数据（§0.9）。
12. 不得用 Node 的 `fs.copyFile*(…, COPYFILE_FICLONE)` 作为克隆原语：它在本机实测是全量复制（§1.5）。克隆只用 `/bin/cp -c`。
13. 不得用 `immutable=1` 打开任何可能被写入的文件（作业的 tmp 库、legacy 库）。

### 0.3 分支、提交与证据

- **分支**：`codex/index-lifecycle-v2`，从 `SHA_BASE` 切出。
- **commit**：每个 Task 一个或少量本地 commit，message 前缀 `ilv2(<TaskId>): `，例如 `ilv2(P0-T6): bound request path waits`。
- **tag**：每个 Phase 结束打本地 tag，依次为 `ilv2/P0`、`ilv2/P1A`、`ilv2/P1B`、`ilv2/P2`、`ilv2/P3`、`ilv2/P4`。
- **入库证据**（只放小文件）：放在 `docs/index-lifecycle-v2/<phase>/` 下：
  - `task-results/<TaskId>.json`（附录 B.1）；
  - `gate-raw/`：单文件 ≤ 1 MiB 的摘要 JSON 或文本；
  - `review-round-<n>.md`；
  - `closeout.json`（附录 B.2）。
  - `<phase>` 取值：`p0`、`p1a`、`p1b`、`p2`、`p3`、`p4`。入库体积受 §0.9 的预算约束。仓库是公开仓库，只放结论和必要证据。
- **本机归档**：需要长期保留的原始记录压缩为 `/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/ilv2/<phase>/<TaskId>-<run-id>.tar.xz`，附逐文件 sha256 清单，不进入仓库。
- **不入库的测试数据**：放在 `/tmp/ilv2-runs/<phase>/<run-id>/`，在 task-result 的 `artifacts` 里登记（附录 B.1），按 §0.9 的时机删除。`<run-id>` 用 `date -u +%Y%m%dT%H%M%SZ`。
- **冻结输入**：`/tmp/frozen-java-repos/<name>`，在 P0-T0 建立。
- **新增脚本**一律放在 `scripts/ilv2-*.mjs`，测试放在 `scripts/ilv2-*.test.mjs`。原因：全量验证只收 `scripts/*.test.mjs`，子目录里的测试不会被执行【代码】`scripts/run-isolated-validation.mjs:163-165`。
- **新增源码**：daemon 侧放 `src/java-index/snapshot/`，builder 子进程侧放 `src/index-builder/`。
- 隔离验证会把 `src/`、`scripts/`、`fixtures/`、`golden/` 下的未跟踪文件一并带入候选【代码】`scripts/run-three-repo-cold-matrix.mjs:594-633`；`docs/` 下的未跟踪文件不会带入。

### 0.4 Task 标准流程

1. 读 Task 卡列出的锚点（附录 A），以及它们的直接调用方、被调用方和现有测试。
2. **RED**：先写测试，运行并确认按预期失败。失败原因必须是行为不符；编译错误或缺依赖不算 RED。缺陷修复类 Task 必须有 RED 证据。
3. 实现最小且完整的补丁，不顺手重构无关代码。单个 Task 非测试改动超过约 600 行时，先拆分并在 task-result 里记录拆分情况。
4. **GREEN**：跑 compile profile，加上 Task 卡列出的定向测试（targeted profile）。
5. 如 Task 卡要求实测，执行实测并保存原始产物。
6. 按 §0.9 处置本 Task 的测试数据：删除 `RUN_END` 条目，其余登记 consumer 和删除时机。
7. 写 `task-results/<TaskId>.json`，然后 commit。
8. Task 卡标注「评审：单独」时，必须在开始下一个 Task 前完成对该 commit 的评审（§0.6 的单 Task 版本）。

### 0.5 命令速查

```bash
cd /Users/luo/Documents/github/codex-java-lsp-mcp

# 编译（含 build stamp）
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile compile

# 定向：在隔离 clone 里先编译，再运行 -- 后的命令（cwd = 候选根）
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- \
  node --test --test-concurrency=1 dist/java-index/builder-supervisor.test.js

# 全量：dist/**/*.test.js + scripts/*.test.mjs + smoke
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile full

# PR 门
sh scripts/run-isolated-node.sh scripts/run-v4-gates.mjs --profile pr

# K01–K32（产物目录必须在候选 checkout 之外）
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- \
  node scripts/run-release-contracts.mjs --isolated --output /tmp/ilv2-runs/<phase>/k32-<run-id>

# 三仓 cold-nolsp 矩阵：baseline 必须是候选 HEAD 的祖先；output 目录必须不存在
sh scripts/run-isolated-node.sh scripts/run-three-repo-cold-matrix.mjs \
  --baseline <BASELINE_SHA> \
  --lishuedu /tmp/frozen-java-repos/lishuedu \
  --cipherlink /tmp/frozen-java-repos/cipherlink \
  --exam-parent-v3 /tmp/frozen-java-repos/exam-parent-v3 \
  --output-dir /tmp/ilv2-runs/<phase>/matrix-<run-id>
sh scripts/run-isolated-node.sh scripts/verify-three-repo-cold-matrix.mjs \
  --matrix-dir /tmp/ilv2-runs/<phase>/matrix-<run-id> --expected-runs 5 --p95-limit 1.25
# 退出码 1 = 质量或 P95 门失败；2 = 前置条件、构建或产物失败。两者都阻断 PASS。

# 主机记录（每次实测前后各一次，写入 task-result.host）
uptime; sysctl -n hw.ncpu hw.memsize; vm_stat | head -5; df -k /; tmutil listlocalsnapshots / | wc -l
```

各 Phase 的 `<BASELINE_SHA>`：P0 用 `SHA_BASE`；P1A 用 tag `ilv2/P0` 指向的 commit；P1B 用 `ilv2/P1A`；后续 Phase 依此类推。

### 0.6 Phase 结束评审协议

#### 0.6.1 三个评审角色

三个角色各开一个只读会话，都评审 Phase 末的 tip SHA，并与实现者分离。

| 角色 | 输入 | 必查内容 | 产物 |
|---|---|---|---|
| Code Reviewer | `git diff <BASELINE_SHA>..<tip>` | 正确性、并发与竞态、崩溃一致性、资源泄漏、错误传播、§2 不变量是否被破坏、测试是否真的覆盖了 Task 卡里的断言 | findings，按严重度排序，每条含位置、触发条件、影响、证据、建议 |
| Doc-Consistency Auditor | 本手册、diff、task-results | Task 卡的完成标准是否逐条有证据；数字是否和原始产物一致；有没有"声称运行但没有产物"的情况；§0.6.3 契约变更是否登记 | 不一致清单 |
| Gate Runner | tip SHA | 重新执行该 Phase 门表里的全部命令（不复用实现者的结果），记录退出码和产物 sha256 | `gate-raw/` 与门表结论 |

#### 0.6.2 流程

1. 三个角色并行执行。BLOCKER 或 MAJOR 级 finding 必须修复。修复后由新的 Gate Runner 重跑受影响的门。
2. 最多 2 轮。第 2 轮后仍有 BLOCKER，则该 Phase 状态为 REOPEN，向用户报告，不得打 tag。
3. 按 §0.9 完成 Phase 级处置：RAW 的摘要写入 `gate-raw/`，需要长期保留的压缩到本机归档（§0.3），然后删除原件；核对残留和入库预算。
4. 写 `closeout.json`（附录 B.2），打本地 tag。

#### 0.6.3 K 契约变更登记

K01–K32 的现行定义见 `docs/java-specialist-release-audit-v1.1/docs/09-runtime-contract-matrix.md`。v2 改变了生命周期机制，下列契约的**场景搭建方式**或 **oracle** 需要调整。调整必须在实现对应 Task 时同步修改 `scripts/run-release-contracts.mjs` 的映射和相关测试，并在这里登记。只要下表未登记，就不允许修改任何 K 的 oracle。

| K | 现行要点 | v2 变化 | v2 oracle |
|---|---|---|---|
| K05 / K11 / K15 / K19 | 等待"实际变更代次完成"后断言 | 代次推进的方式变为"快照发布" | oracle 不变。等待对象改为：包含该变更的快照发布（有界等待，不 sleep） |
| K06 | 两个 linked worktree 同路径不同内容；无兄弟内容串入 | seed 改为克隆兄弟快照再应用差量 | oracle 不变。新增两条：差量后每个结果的 sourceHash 必须匹配本 worktree；本 worktree 尚无快照时返回 NOT_READY，绝不返回兄弟内容 |
| K12 | 零剩余时间或预算不足时返回明确错误或 PARTIAL，不无限等待 | 新增 MCP 硬截止 | oracle 不变。新增：任何调用耗时 ≤ deadline + 1000 ms |
| K20 | 请求中途注入 G+1 变更，结果要么全是同一 snapshot 的证据，要么显式标 PARTIAL | 读者在整个请求期间固定持有一个快照 | oracle 不变。注入点改为"在 hits 之后、coverage 之前发布新快照"。预期返回旧快照的全部证据，并带上该快照 ID |
| K21 | 兄弟 DB 拷贝后只改目标 worktree 的 XML，READY 之前 XML 证据必须已刷新 | 搭建方式由 VACUUM INTO 改为克隆加差量 | XML 证据的 sourceHash 必须匹配目标 worktree；快照发布前已完成 |
| K29 | 20 并发 broad query；P95 ≤ 150 ms，event loop P95 ≤ 20 ms | 读者改用 immutable 连接 | oracle 和阈值都不变 |
| K30 | 写库期间持有只读连接；WAL 在 idle TTL 加有界 grace 内收敛；不得以删库作为收敛 | 被服务的快照不再有 WAL，写入只发生在作业的 tmp 库 | sealed 快照旁不存在 `-wal`/`-shm`；作业结束或下次 GC 后 tmp 目录为空；读连接 idle 后关闭；CURRENT 指向的快照不得被删除 |

### 0.7 状态词

| 状态 | 含义 |
|---|---|
| PASS | 全部完成标准有证据 |
| FAIL | 已运行但未达标（必须附带关键失败信息） |
| BLOCKED_ENV | 环境原因无法运行，例如缺 JDT 或磁盘不足。必须写明下一步最佳检查 |
| BLOCKED_AUTH | 缺少用户授权或凭据 |
| NOT_RUN | 按条件跳过，例如 U4 选择不部署。必须写明原因 |
| NOT_REPRODUCED | 复现型 Task 未能复现。后续依赖它的修复必须停下 |
| INVALID_EXPERIMENT | 实验条件被破坏，例如输入被改动或计时被干扰。必须重跑 |

### 0.8 全局停止条件

出现以下任一情况，立即停止并报告。报告内容包括：已完成内容、精确阻塞、缺失的证据或权限、下一项最佳动作。

- 需要写入 §0.2 禁止的位置才能继续。
- 复现型 Task 的结论是 NOT_REPRODUCED，而后续 Task 依赖它。
- 可用内存 < 4 GiB（三仓矩阵的唯一硬门）。
- 磁盘剩余 < 30 GiB，且按 §0.9 删除到期数据后仍不足。此时只停止三仓矩阵以外的实测：三仓矩阵不以磁盘余量为拒绝门，只记录 `df`，运行中真实出现 ENOSPC 时记 BLOCKED_ENV。
- 同一个门修复后连续 2 次 FAIL，且失败原因没有新证据。
- 发现本手册 §1 的事实与现场不符，且会改变 §2 的设计。此时先更新本手册（以独立 commit 记录差异），再继续。

### 0.9 测试数据生命周期

测试和实测产生的数据只为得出结论服务。结论写定后，按本节提炼或删除，不保留"以防万一"的完整副本。附录 C.2 是反例：`$TMPDIR` 里积累的 12,432.9 MiB 测试数据中，独有的记录只有 67.8 MiB。

**类别与删除时机**

| 类别 | 内容 | 删除时机 | 删除前必须留下 |
|---|---|---|---|
| `BULK` 可再生大件 | SQLite 库与快照（含 `.v2/`、`mcp-cache/`）、clone 与 worktree、评测 attempt 工作区、隔离验证根、`node_modules` 与 `dist` 副本、JDT workspace、Gradle/Maven 缓存、canary 缓存 | 本次运行取完数据后立即删除（`RUN_END`）。后续步骤还要用时登记 consumer，最后一个 consumer 结束时删除（`LAST_CONSUMER`） | 生成命令和输入身份：源码 SHA、冻结仓库 SHA、dist 的 build stamp。凭这些可以重新生成 |
| `RAW` 原始记录 | 时间线 CSV、`calls.jsonl`、`verdict.json`、stdout/stderr、telemetry 片段、profile、模型请求与响应、judge 输出，以及 K runner、三仓矩阵的输出目录 | Phase 评审通过后、写 closeout 之前删除（`PHASE_CLOSEOUT`，§0.6.2 第 3 步）。Phase 评审要用它们核对数字，不得提前删除 | 摘要进 `gate-raw/`。需要付费、或单次运行超过 1 h 才能重新获得的，压缩到本机归档（§0.3），附逐文件 sha256 清单 |
| `INPUT` 冻结输入 | `/tmp/frozen-java-repos/*`；`/tmp/ilv2-runs/p0/base-release` | 冻结仓库在 P4 closeout 或止损时删除（`PROGRAM_END`）；base-release 在 P0 closeout 时删除 | `p0/frozen-repos.json`；release 目录名 |
| `REPO` 入库证据 | task-result、`gate-raw/`、review、closeout | 不删除 | — |
| `LOCAL` 本机归档 | 本机归档根下的压缩包与清单 | 不删除（§0.2 第 11 条） | — |

常见产物的入库摘要（存入 `gate-raw/` 时文件名加 `-<run-id>` 后缀）：K runner 留 `k-contract-results.json`，三仓矩阵留 `matrix-summary.json`，burst replay 留 `verdict.json`，SLO 报告留 `slo.json`。

**失败的运行**：FAIL、NOT_REPRODUCED、INVALID_EXPERIMENT 同样按上表处置。复现失败所需的最小材料（例如出错的那个库和相关日志）可以多留，consumer 登记为负责诊断的 Task，诊断结论写定后删除。不得以"以后可能还要看"为由整体保留。

**位置**

- 运行产生的测试数据只写在 `/tmp/ilv2-runs/<phase>/` 下，不写进仓库工作区。入库的只有 `docs/index-lifecycle-v2/` 下的证据，以及 Task 卡列为交付物的测试资产（测试代码、fixture、P2-T1 的 `golden/real-workload/*.tasks.json`）。
- 不经隔离验证、直接在仓库里运行测试时，设置 `TMPDIR=/tmp/ilv2-runs/<phase>/tmp-<run-id>`，运行后删除该目录。
- 工具自建的随机目录只有两种，默认在运行结束时删除：
  - `run-isolated-validation.mjs` 的 `$TMPDIR/codex-java-lsp-isolated-validation-*`。它把 `TMPDIR`、`HOME`、JDT 数据目录和 `GRADLE_USER_HOME` 都指向根目录内部，不加 `--keep` 时在 `finally` 中整体删除【代码】`scripts/run-isolated-validation.mjs:54-64`、`:113`、`:183-185`；
  - `run-three-repo-cold-matrix.mjs` 的 `$TMPDIR/codex-java-lsp-mcp-three-repo-*`，存放 clone 和索引缓存，不加 `--keep-worktrees` 时删除【代码】`scripts/run-three-repo-cold-matrix.mjs:117`、`:354-359`。
- 只有加了 `--keep`、`--keep-worktrees`，或进程被强杀导致 `finally` 未执行时，这两种目录才会留下。附录 C.2 删除的 12 个隔离验证根（每个约 286 MiB）就是这样留下的。因此：
  - 只在后续步骤要用该目录时才加 `--keep`；
  - 加了就从输出行 `preserved isolated validation root: <path>` 或 `preserved isolated local clones/cache: <path>` 取得路径，按 `BULK` 登记 consumer；同一用途构建新根时，先删旧根；
  - 进程被强杀后：隔离验证的根是启动时打印的 `candidateRoot` 的上级目录；三仓矩阵启动时不打印根目录，用 `ls -d` 列出后，按创建时间（`stat -f %SB`）落在该次运行的时间窗内确认归属。确认后先登记再删除；无法确认归属的不删，写入 task-result 的 `remainingGaps`。
- `evaluate-java-task.mjs` 不清理 `--output`：每个 attempt 都把 fixture 整体复制到 `candidates/`，在 `mcp-cache/` 留下索引库，`source-snapshots/` 也保留【代码】`scripts/eval-native-tools.mjs:207-221`、`scripts/evaluate-java-task.mjs:720`、`:727`、`:738`。P2 必须按 P2-T2 的规定分批运行、逐批删除。

**入库预算**

- 单文件 ≤ 1 MiB（§0.3）；每个 Phase 目录合计 ≤ 5 MiB。
- 不得入库：原始记录（无论是否压缩）、SQLite 库与快照、git 对象与 bundle、`node_modules`、`dist`、源码树副本、JDT/Gradle/Maven 缓存，以及任何含输入业务仓库源码正文的文件（模型请求与响应、agent 会话记录通常含有）。
- 提交前扫描待提交文件：业务源码标记（`package`/`import com.lishu|hhtele|limou`、Mapper `namespace`）和密钥特征都必须为 0（附录 C.3）。
- 超出预算时先删可再生部分；仍然超出，就在 closeout 列出明细并请用户确认，确认前不打 tag。

**登记与核对**

- 产生测试数据的每一步，都在 task-result 的 `artifacts` 里登记一条（附录 B.1）：路径、类别、字节数、consumer、删除时机。删除后填写 `disposition` 和 `deletedAt`。
- Task 收尾（§0.4 第 6 步）时：`RUN_END` 条目已全部删除；`ls -d "$TMPDIR"/codex-java-lsp-isolated-validation-* "$TMPDIR"/codex-java-lsp-mcp-three-repo-* 2>/dev/null` 只能列出已登记、且仍有 consumer 的目录。
- Phase 收尾（§0.6.2 第 3 步）时：RAW 已提炼并删除；`du -sk /tmp/ilv2-runs/<phase>` 只剩登记为跨 Phase 携带的条目；入库字节数在预算内。结果写入 closeout 的 `testData`（附录 B.2）。不满足就不得写 `decision=CLOSED`。
- 只删除登记过的精确路径，不对 `$TMPDIR` 或 `/tmp` 做通配删除。生产缓存、release、输入仓库和 `docs/evidence-archive/` 永不在删除范围内（§0.2 第 1、2、11 条）。
- 磁盘紧张时先删已到期的登记数据。磁盘余量不是三仓矩阵的拒绝门（§0.2 第 10 条、§0.8）。

---

## 1 现状基线

### 1.1 部署形态（停止前）【实测】

- **服务与 release**：launchd 服务 `com.lky.codex-java-lsp-mcp`，HTTP 端口 :38456（canary :38457）。plist 设置 `RunAtLoad=true`、`KeepAlive={SuccessfulExit=false}`。当前 release 是 `83aa814049e5`，于 2026-10-11 15:20Z 安装。
- **plist 环境变量**：
  - `NODE_BIN=/Users/luo/.nvm/versions/node/v22.16.0/bin/node`
  - `JDTLS_BIN=/opt/homebrew/bin/jdtls`
  - `JAVA_HOME=~/.sdkman/candidates/java/current`
  - `JAVA_LSP_CACHE_BASE=/Users/luo/Library/Caches/codex-java-lsp`
  - `JAVA_LSP_OWNERSHIP_BASE=…/.ownership`
  - `JAVA_LSP_HTTP_PORT=38456`
  - `JAVA_LSP_IDLE_TTL_MS=900000`
- **启动方式**：`run-daemon.sh` 先执行 `ulimit -n 65536`，再以 `node --max-old-space-size=768 current/dist/http-server.js` 启动。
- **pins**：lishuedu、lishu-v2、exam-parent-v3、cipherlink（见 `docs/phase-f/production-operations.md`）。
- **工具**：`java_status`、`java_impact`、`java_symbol`、`java_diagnostics`、`java_runtime`。
- **版本常量**【代码】：
  - `SCHEMA_VERSION=9`（`src/java-index/sql/schema.ts:13`）
  - `STABLE_ID_VERSION=2`（`src/java-index/stable-id.ts:7`）
  - `JAVA_FACTS_REVISION=5`（`src/java-index/build-fingerprint.ts:34`）
- **存储**：SQLite（`node:sqlite`），WAL 模式。
- **开发机 Node**：`/usr/local/bin/node` v22.17.0。生产用 v22.16.0。

### 1.2 调用与失败【实测】

83aa 安装后共 128 次调用：

| 工具 | 结果 |
|---|---|
| `java_status` | 72% 成功；15 次超时，其中两次分别跑了 804 s 和 840 s，报错都是 `Deadline exceeded before runtime.reconcile` |
| `java_symbol` | 74% 成功；6 次 `index not ready`，有一次耗时 509 s；成功调用 p50 54 ms、p90 209 ms |
| `java_impact` | 全部记为成功，但 p90 456 s、最长 812 s |

- 22 次调用连 repoHash 都没拿到，其中只有 2 次成功。
- READY 的仓库耗时 155–2009 ms。慢请求和失败几乎都落在 lishu-v2 的 worktree 上。
- **日志**：09-30 起共 58 条失败：
  - 38 条是生命周期问题：`runtime.create` 或 reconcile 超时、index not ready；
  - 17 条是 `java_impact` 缺少 anchors 的误用，最后一次在 10-11 03:34Z；
  - 3 条其他。
- **运行时类失败的日变化**：10-11 之前每天最多 3 次；10-11 当天 6 次，10-12 19 次，10-13 截至 03:00Z 已 7 次。起点和 facts revision 5 强制全部重建的时间吻合。
- 生产调用量约每天 85 次。

### 1.3 缺陷机制

| ID | 机制 | 证据 |
|---|---|---|
| D1 | builder watchdog 只看已提交的 `buildProgress` 指纹 `phase:done:total`，读取走一条独立的只读连接；120 s 没有变化就 SIGKILL。`runServe` 共尝试 3 次 | 【代码】`builder-supervisor.ts:9-10`（`DEFAULT_WATCHDOG_INTERVAL_MS=30_000`、`DEFAULT_STALL_MS=120_000`）、`:51-63`、`:177-191`、`:256-276` |
| D1a | 冷建 resolve 第一遍提交的 `done` 是常量，整个第一遍期间指纹不变 | 【代码】`cold-build.ts:223-235` |
| D1b | `writeKnowledgeAndEntities`（KG、实体、search-doc）完全不写进度 | 【代码】`cold-build.ts:274-310` |
| D1c | 恢复态 reconcile：只要 `buildState≠READY` 或 `coverageRevision≠1`，就把全部文件标为变更（`incremental.ts:581-589`）；`parseChanged` 单线程逐文件解析（`:244-271`）；`applyParsedRefresh` 先做事务前准备（`:281-302`），再在一个巨型事务里完成全部工作（`:304-325`），事务内进度对 watchdog 不可见 | 【代码】同左 |
| D1 结论 | 被杀后事务回滚，buildState 仍不是 READY，下一个请求再触发同一流程，形成活锁。生产主库最后提交的进度是 `declare 5877/5877`，WAL 379 MB，与 D1c 被杀的形态吻合 | 【推断】未复现，由 P0-T1 复现 |
| D2 | open 时保留已有的 BUILDING 库，不会安排冷建，之后的 reconcile 必然是恢复态 | 【代码】`sql-client.ts:551-556`（`existingSchemaMatches`） |
| D3 | sibling 选择只看 mtime 最新，不检查状态，因此会复制 BUILDING 库：先 VACUUM INTO 全量复制，再在 `open()` 内等待一次 reconcile | 【代码】`repo-runtime-manager.ts:1076-1094`、`repo-layout.ts:68-99`、`sql-client.ts:120-140`、`:526-548`、`:572-582` |
| D4 | 同一 family 的 runtime 创建串行（`familyGates`），而 `createEntry` 会 await `open()` 链，所以并行 agent 的后续请求全部排队，等满 15 s 后报 runtime.create 超时 | 【代码】`repo-runtime-manager.ts:736-749`、`:842`；【实测】日志中的 `Deadline exceeded during runtime.create` |
| D5 | 请求路径在等待 builder：<br>① 预算在 resolve 之后才创建（`repo-runtime-manager.ts:268-270`）；<br>② 两次不受预算约束的 `flushNow()`（`:371-374`），而 `flushNow` 会逐个 await 监听器（`repo-change-coordinator.ts:389-395`、`:451-453`）；<br>③ `ensureFresh` 和 `reconcile` 忽略请求选项（`sql-client.ts:229`、`:238`）；<br>④ MCP 入口只和客户端 abort 竞速，没有硬截止（`mcp-server-factory.ts:197-251`） | 【代码】同左；【实测】840 s、804 s、812 s 的调用 |
| D6 | 每个 runtime 一个 `BuilderSupervisor`，N 个 worktree 最多 N 个 builder 子进程，没有全局并发上限 | 【代码】`repo-runtime-manager.ts:1209` |
| D7 | 存储过重：每个 worktree 一份 490–650 MB 的全量拷贝；`sym` 字符串驻留表连同 UNIQUE 索引占 205 MB | 【实测】dbstat |
| D8 | tree-sitter 解析在 builder 主线程同步执行；冷建的 `mapPool` 只并行 I/O | 【代码】；CPU 利用率由 P0-T1【待测】 |

### 1.4 真实负载【实测】

| 仓库 | Java 文件 | XML | 已注册 worktree | 其中 prunable | 当前 HEAD |
|---|---|---|---|---|---|
| lishu-v2 `/Users/luo/Documents/program/lishu-v2` | 6156 | 89 | 933 | 732 | `develop-w10` 分支，`8bc0fb96b` |
| lishuedu `/Users/luo/Documents/program/lishu/lishuedu` | 6744 | — | 122 | 34 | `develop` 分支，`98e1f388c` |
| exam-parent-v3 `/Users/luo/Documents/program/exam-parent-v3` | 1434 | 26 | 11 | 1 | `23f8b702` |
| cipherlink `/Users/luo/Documents/program/cipherlink` | 633 | — | 5 | 1 | `fa43398` |

- lishu-v2 磁盘上实际存在 201 个 checkout（含主 checkout）：`Documents/program` 下 147 个、`~/.codex/worktrees` 下 45 个、`~/.codex/tmp` 下 7 个、其他 2 个。
- 10-12 当天新建了 16 个 lishu-v2 worktree，常见 3–6 个在几分钟内同时创建，也就是并行 agent。
- **差量**：抽样 9 个 worktree。
  - 相对各自的 merge-base，改动 0–10 个 Java 文件，只有一个是 91 个；
  - 相对主 checkout 的 HEAD 差 21–180 个文件，不到 3%；
  - 有一个落后 962 个提交，差 5618 个文件。
- **清理前的存储**：
  - lishu-v2 主库处于 BUILDING：559 MB 加 379 MB WAL；
  - 14 个 worktree 库也都是 BUILDING，每个 490–650 MB；
  - 主库 dbstat（MiB）：sym 的 autoindex 109.9，sym 95.1，method 89.4，field 31.5，edge 24.4，entity_token 16.6，edge autoindex 15.4，entity_token_lookup 15.2，type 12.1，kg_summary 11.3；
  - 行数：sym 393,214 行（平均 232 B），method 67,620 行（facts 平均 1057 B），edge 501,652 行。
- **三仓 golden 的冻结 SHA**【代码】`docs/phase-v4/v4-sprint0-runbook.md:29-31`，在源仓库中均已确认存在：

  | 仓库 | 冻结 SHA | 该 SHA 的 Java 文件数 |
  |---|---|---|
  | lishuedu | `db63b1a7e393edd90449eb013d7d1c4d65c366f2` | 5312 |
  | cipherlink | `fa433982e92e52dd610650d1e79f2d041179b1d3` | 633 |
  | exam-parent-v3 | `f90a0b475f7be2ed003703feecec8195bc7eb976` | 1370 |

  `/tmp/frozen-java-repos` 当前不存在。

### 1.5 本轮已验证的技术事实【实测，2026-10-13】

| # | 事实 | 对设计的影响 |
|---|---|---|
| F1 | `node:sqlite` 在 v22.16.0 和 v22.17.0 上都支持 `new DatabaseSync("file:<abs>?immutable=1", { readOnly: true })`，传字符串或 `URL` 对象均可。库经过 `wal_checkpoint(TRUNCATE)` 和 `journal_mode=DELETE` 封存后不再有 `-wal`/`-shm`，读者打开后也不会生成 | 读者可以零锁、零 WAL 地读 sealed 快照 |
| F2 | APFS 上，Node `fs.copyFileSync(src, dst, COPYFILE_FICLONE)` 复制 256 MiB 用时 383 ms，磁盘可用空间减少 262,420 KiB，即全量复制；`/bin/cp -c` 只减少 36 KiB，是真克隆，两份内容 `cmp` 一致；`COPYFILE_FICLONE_FORCE` 返回 ENOSYS | 克隆只能 spawn `/bin/cp -c` |
| F3 | tree-sitter 0.25 原生 addon 能在 4 个 worker_threads 中并发加载并解析（4 × 200 次），正常退出 | 并行解析可行（只是 smoke；规模化正确性和加速比由 P1-T1 S3 测） |
| F4 | lishu-v2 主 checkout 上，`git --no-optional-locks ls-files -s -z -- '*.java' '*.xml'` 列出 6249 条，92 ms；`status --porcelain=v2 -z --untracked-files=all` 135–325 ms；某个 worktree 上 97 ms | 留作参考。v2 的变更检测不依赖 git，见 §2.4 |
| F5 | v9 的 `file.content_hash` 是文件 UTF-8 文本的 sha256，`resource_scan` 记录 XML 的 `content_hash`、`size`、`mtime_ms`；现有 reconcile 先比 stat、再比哈希【代码】`schema.ts:18-19,52`、`incremental.ts:432-460,496-538` | 快照本身就是内容清单，不需要另建 manifest |
| F6 | 主机：10 CPU、32 GiB 内存，1 分钟 load 7.9–11；清理后磁盘可用 119 GiB | 并发和磁盘预算的依据 |

### 1.6 清理后的当前状态【实测】

- 生产缓存 `~/Library/Caches/codex-java-lsp/` 只剩 `telemetry/`（约 100 KiB）。30 个 repoHash 目录以及 `leases/`、`.ownership/` 已全部删除。
- launchd 服务未加载（`launchctl print` 返回 "Could not find service"）。用户确认后已执行 `launchctl disable gui/$(id -u)/com.lky.codex-java-lsp-mcp`，`print-disabled` 显示 `disabled`，因此登录时不会自动启动。plist 仍在 `~/Library/LaunchAgents/`。
- 恢复方法：先 `launchctl enable gui/$(id -u)/com.lky.codex-java-lsp-mcp`，再执行 `daemonctl.sh start`。§7 的生产安装开始前必须先恢复 enable。
- release `48bad915c854…` 和 `83aa814049e5…`、`state/`、daemon 日志都保留。
- `$TMPDIR` 中被文档引用的 20 个证据目录（约 12.6 GiB）已提炼，原目录已删除；仓库内未跟踪证据也已精简。结论记录在 `docs/evidence-archive/`，原始记录只在本机归档 `/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/`，见附录 C。

---

## 2 v2 目标规格

### 2.1 不变量

每个 Phase 1A 的 Task 都必须保持下列不变量；评审逐条检查。

| ID | 不变量 |
|---|---|
| I1 读不等写 | 请求路径上不存在对 builder 作业、监听器、子进程、文件复制的无界等待。所有等待都受请求预算约束，等待新鲜度的上限是 1000 ms。MCP 入口强制 deadline + 1000 ms 的硬截止 |
| I2 只读已发布快照 | daemon 只用 `immutable=1` 打开 CURRENT 指向的 sealed 快照。BUILDING 不再是读者可见的状态 |
| I3 快照不可变 | 快照发布后字节永不改变；所有写入都发生在作业私有的 tmp 克隆上 |
| I4 原子发布 | CURRENT 通过"写临时文件、fsync、rename"更新。进程在任何时刻崩溃，CURRENT 都指向一个完整快照（旧的或新的） |
| I5 内容身份 | 变更以文件内容的 sha256（与现有 `content_hash` 定义相同）为准；stat 只用来跳过未变化的文件；不依赖 mtime 判定内容，也不依赖 git |
| I6 worktree 隔离（K06） | 快照内容只来自本 worktree 的文件内容：从其他 worktree 的快照克隆后，所有内容不同的文件都按本 worktree 重新解析；快照里不得出现其他 worktree 的绝对路径；本 worktree 没有快照时返回 NOT_READY，不拿兄弟快照服务 |
| I7 可观测、可杀 | 作业至少每 2 s 发一次心跳（目标）。同步段目标 ≤ 1 s，硬上限 30 s（作为门）。watchdog 以心跳判活（120 s），并按作业类型设墙钟上限 |
| I8 并发有界 | 全局 builder 子进程最多 2 个：一个通用槽，一个只给前台和 seed 用的保留槽。同一 workspace 同时最多一个作业 |
| I9 失败不降级服务 | 作业失败时保留 CURRENT 继续服务，并标记 BUILD_FAILING 或 STALE，按退避重试。永远不因构建失败删除已发布的快照 |
| I10 等价 | 对同一棵源码树，full 和 delta（任意合格的 base）产出的逻辑内容完全相同。允许不同的只有 §11.4 登记的元数据列 |

### 2.2 缓存布局

```text
<repoCacheBase()>/                      # 解析顺序不变：JAVA_LSP_CACHE_BASE > JAVA_LSP_CACHE_ROOT > ~/Library/Caches/codex-java-lsp
  telemetry/                            # 不变；新增 builder-YYYYMMDD.jsonl
  leases/  .ownership/                  # 不变
  <repoHash12>/                         # legacy：v2 只在这里放 JDT 的 workspace/ 和 repo-meta.json，不再写 index.sqlite
  .v2/                                  # v2 根。以点开头，legacy janitor 会跳过（worktree-cache-cleanup.ts:259-266）
    format.json                         # {"format":"ilv2-cache/1","createdAt":"..."}
    ws/<repoHash12>/
      ws.json                           # 附录 B.4
      CURRENT                           # 附录 B.3
      snap/<snapshotId>.sqlite          # sealed，只读
    tmp/<jobId>.sqlite[-wal|-shm]       # 作业私有；作业结束删除，孤儿由 GC 清理
```

- `.v2/tmp` 和 `.v2/ws` 在同一个卷上，因此 rename 是原子的。
- `JAVA_LSP_INDEX_DIR` 在 v2 中被删除（P1-T7）。它会让所有 root 共用一个 `index.sqlite`【代码】`repo-runtime-manager.ts:1191-1194`，同时还要更新 README。
- `snapshotId` 的格式是 `<Date.now() 的 base36>-<4 字节随机 hex>`，按时间可排序。

### 2.3 快照格式、发布与读取

**格式**：
- 文件是 SQLite。Phase 1A 沿用 v9 的表结构，Phase 1B 换成 v10。
- 文件头：`journal_mode=DELETE`；页大小沿用 v9 的现值。全量构建产出的是全新文件；热路径上禁止 `VACUUM`，因为它会重写整个文件、破坏克隆共享。
- 新增 meta 键：
  - `snapshotFormat=1`、`snapshotId`、`repoHash`、`familyKey`、`repoRoot`（目标 worktree 的绝对路径）；
  - `layoutDigest`：`probeLayout` 结果的稳定 JSON 的 sha256；
  - `buildKind`（`full` 或 `delta`）、`baseSnapshotId`；
  - `deltaChanged`、`deltaDeleted`、`deltaTouched`；
  - `builderBuildSha`、`createdAt`。
- 下列 meta 键保持现有语义：`buildState=READY`、`coverageRevision=1`、版本三元组、`indexedGeneration`。
- **兼容判定**：`snapshotFormat`、`SCHEMA_VERSION`、`STABLE_ID_VERSION`、`JAVA_FACTS_REVISION` 四项必须全部等于代码常量，否则该快照不可读，也不能作为 base，需安排 full。

**封存**（由 builder 子进程执行）：
1. `PRAGMA wal_checkpoint(TRUNCATE)`，要求 `busy=0`，此时 tmp 库只有这一个连接。
2. `PRAGMA journal_mode=DELETE`，要求返回 `delete`。
3. 关闭连接，fsync tmp 文件。
4. 断言 `-wal`/`-shm` 不存在，然后上报 `{ sealedPath, bytes }`。

**发布**（由父进程的 `SnapshotStore.publish` 执行；子进程永远不碰 CURRENT）：
1. 用 `immutable=1` 只读打开 sealed 文件做校验：版本四项等于常量；`buildState=READY`；`snapshotId` 与作业一致；然后关闭。
2. 把 `.v2/tmp/<jobId>.sqlite` rename 为 `.v2/ws/<h>/snap/<snapshotId>.sqlite`。
3. 写 `CURRENT.tmp-<jobId>`，fsync 后 rename 为 `CURRENT`。
4. 在进程内发出 `published(ws, snapshotId)` 事件，更新 `ws.json.lastPublishAt`。
5. 旧快照记入 `retired`（内存中，同时写进 `ws.json.retired[]`），由 GC 回收（§2.8）。

只要求"进程崩溃一致"：rename 加 fsync 即可。断电持久性尽力而为，不要求 `F_FULLFSYNC`。

| 崩溃点 | 结果 | 由谁清理 |
|---|---|---|
| 封存前 | tmp 成为孤儿，CURRENT 不变 | GC：tmp 文件存在超过 1 h，且没有运行中的作业使用这个 jobId |
| rename 之后、写 CURRENT 之前 | snap 目录里多一个没被引用的文件，CURRENT 不变 | GC：该文件不在 CURRENT 中、也不在 retired 中，且存在超过 1 h |
| `CURRENT.tmp-*` 写到一半 | 没有发生 rename，CURRENT 不变 | GC |
| CURRENT rename 之后 | 新快照生效 | — |

**读取**（daemon）：
1. 读 `CURRENT` 并解析 JSON。解析失败按 NOT_READY 处理，同时安排 full，并写日志。
2. 打开：`new DatabaseSync(pathToFileURL(abs).href + "?immutable=1", { readOnly: true })`。路径中的空格和特殊字符由 `pathToFileURL` 负责编码。
3. 校验 `meta.snapshotId` 与指针一致。不一致时报错，并安排 full。
4. 按快照文件做读者引用计数：请求开始时 `acquire()`，结束时 `release()`；同一个请求的全部查询都用同一个快照（K20）。
5. 收到 `published` 后，后续的 `acquire()` 打开新快照。旧快照的读者引用计数归零后关闭。
6. query worker 按请求接收 `snapshotPath`。每个路径最多保持 2 个连接，idle 60 s 后关闭；若沿用 `JAVA_LSP_CONN_IDLE_MS`，则以它为准。

### 2.4 变更检测（内容扫描）

快照的 `file` 和 `resource_scan` 两张表本身就是内容清单（F5），因此不新增 manifest 表。

- **扫描范围**：与现有发现函数完全一致，即 `discoverJavaFiles` 和 `discoverMyBatisResourceFiles`（`src/java-index/manifest.ts:15`、`:62`），沿用同一文件 `:5` 定义的 `IGNORED_DIRECTORY_NAMES`。扫描在 builder 子进程中执行。
- **stat 扫描**：对全部发现的文件执行 `stat`。与快照行比较 `size` 和 `mtime_ms`，不同的、新增的、被删除的路径进入候选集。
- **哈希**：对候选集读取内容并计算 sha256（定义与 `contentHashOf` 相同）。哈希不同才算 changed；哈希相同只重戳 stat（现有 `mtimeStamps` 逻辑）。
- **全量哈希扫描**用于跨 worktree 的 seed，以及 stat 候选集超过阈值的情况：对全部文件计算哈希。lishu-v2 约 54 MB 源码，预计 0.3–1 s【待测】P1-T1 S4。
- **与某个 base 的差异**：`SELECT path, content_hash FROM file` 和 `SELECT path, content_hash FROM resource_scan` 的结果与目标哈希表求差，得到 `changed`、`added`、`deleted` 三类，Java 和 XML 分开。
- **触达集**：`touched = changed ∪ added ∪ deleted ∪ dependents(changed ∪ deleted)`。依赖扩展沿用 `applyParsedRefresh` 的现有语义。

### 2.5 Builder 作业

**进程模型**：
- 每个作业一个子进程，入口为 `dist/index-builder/job-main.js`（新增）；作业完成即退出。
- 父进程通过 IPC 下发一次 `{ type: "job", job }`。
- 子进程上报的消息：
  - `{ type: "heartbeat", seq, phase, done, total, atMs }`：至少每 2 s 一次，节流到每秒最多一次；
  - `{ type: "phase", phase, atMs }`；
  - 成功时 `{ type: "result", ok: true, sealedPath | noop: true, stats }`，失败时 `{ type: "result", ok: false, error: { code, message } }`。
- 现有 `builder-main.ts` 的长驻 serve 模式在 v2 路径中不再使用，P4 删除。

**作业规格** `BuildJobSpec`：

```ts
type BuildJobSpec = {
  jobId: string;                      // 同时是 tmp 文件名
  snapshotId: string;                 // 由 scheduler 生成（格式见 §2.2），子进程写入 meta，发布时校验
  kind: "full" | "delta";
  workspace: { repoRoot: string; repoHash: string; familyKey: string };
  tmpPath: string;                    // <v2>/tmp/<jobId>.sqlite
  candidates: Array<{                 // 仅 delta；顺序：自身 CURRENT、family 主 checkout、其余按 lastPublishAt 降序，最多 5 个
    snapshotPath: string; snapshotId: string; repoHash: string; isOwn: boolean; isMainCheckout: boolean;
  }>;
  hints: string[];                    // watcher 提示路径（相对），只用于加速，不影响正确性
  limits: { wallMs: number; deltaMaxTouched: number; deltaMaxChangedRatio: number };
  parallelism: number;                // 解析 worker 数（S3 通过时生效）
  faultAt?: string;                   // 仅测试：在指定阶段 process.exit(137)
};
```

**full 流程**：
1. `probeLayout`，计算 `layoutDigest`。
2. 创建 tmp 库：WAL 模式，`synchronous=OFF`。tmp 是私有的，崩溃即丢弃，所以可以关闭同步。
3. 走现有冷建逻辑（`runSqlColdBuild` 的各阶段），但做三处修改：
   - 解析阶段分块，每块 ≤ 200 个文件（`COLD_BUILD_BATCH_SIZE`）；S3 通过时使用 worker 池；
   - resolve 第一遍、edges、KG/实体/search-doc 各阶段，每 200 个文件（KG 阶段每 50 个）发一次心跳，提交真实递增的进度；
   - 块与块之间 `await setImmediate()`。
4. 写入 XML 资源、coverage 和 §2.3 的 meta，然后封存。

**delta 流程**：
1. `probeLayout`，计算 `layoutDigest`。只有 `layoutDigest` 和版本四项都匹配的候选才合格。
2. **选 base**：
   - 有 `isOwn` 候选时，先做 stat 扫描。如果哈希后的 changed 数量 ≤ `deltaMaxTouched`，直接选自身为 base；changed 为 0 时结果是 `noop`，不克隆，不发布。
   - 否则做全量哈希扫描，与每个合格候选求差，选 `changed ∪ added ∪ deleted` 最小的那个。
3. **转 full 的条件**：没有合格候选；或最小差异 > `max(1500, deltaMaxChangedRatio × 文件数)`；或计算出的 `touched` > `deltaMaxTouched`。转 full 时在结果里写 `convertedToFull: <原因>`。
4. **克隆**：`/bin/cp -c <base> <tmp>`。失败（非 APFS）时回退为 `/bin/cp <base> <tmp>`，并记 `cloned:false`。然后以 WAL、`synchronous=OFF` 打开 tmp，设置 `meta.repoRoot=<target>`、`buildState=BUILDING`（tmp 私有，读者不可见）。
5. **应用差量**：复用现有非恢复态的 `applyJavaReconcile` 和 `applyResources` 逻辑（`parseChanged`、`applyParsedRefresh` 的非 `recovering` 分支）。
   - 由于 `touched ≤ deltaMaxTouched`，单个事务有界：默认上限 400，由 S5 校准到事务耗时 p95 ≤ 10 s。
   - `recovering` 分支在 v2 中不可达，用断言保证。
6. **重戳 stat**：
   - base 是其他 worktree 时，对全部 `file` 和 `resource_scan` 行写入目标 worktree 的 `size`、`mtime_ms`、`ctime_ms`，每块 1000 行，base 的 stat 值不得保留在新快照里；
   - base 是自身时，只重戳 stat 有变化的文件（现有的 `stampFileTimes`）。
7. 写 meta，然后封存。

**墙钟上限**：
- full：`max(10 min, 3 × T_full)`，`T_full` 由 P1-T1 冻结；
- delta：10 min；
- 超时由父进程 SIGKILL，记为 `outcome=timeout`。

### 2.6 BuildScheduler

- **单例**：在 `src/java-index/snapshot/build-scheduler.ts` 中实现，由 application 创建；stdio 模式和 HTTP 模式共用。
- **ownership**：只有持有 ownership lease 的进程才调度作业、写 CURRENT。不持有 lease 的进程只读 CURRENT，并报告 `VERIFYING`。
- **槽位**：共 2 个。
  - 槽 A 接受任何优先级；
  - 槽 B 只接受 P0 和 P1；
  - 同一 workspace 同时最多一个作业。
- **优先级**：

  | 优先级 | 场景 |
  |---|---|
  | P0 | 前台请求等待锚点新鲜度 |
  | P1 | 新 workspace 的 seed |
  | P2 | watcher 增量和启动校验 |
  | P3 | pin 预热、维护性 full、失败重试 |

- **合并**：同一 workspace 已有作业在排队时，新请求合并进去：hints 取并集，优先级取较高者。已有作业在运行时，新请求记为一个 pending，等运行结束、发布之后再判断要不要再跑一次。
- **watchdog**：
  - 以心跳判活：120 s 没有收到心跳就 SIGKILL，记 `outcome=stalled`；
  - 墙钟上限见 §2.5；
  - 子进程退出码非 0 且没有发出 result，记 `outcome=failed`。
- **退避**：同一 workspace 连续失败后，分别等 30 s、2 min、10 min，之后每 30 min 重试一次。连续失败 ≥ 3 次进入 `BUILD_FAILING`。新的 watcher 事件不会让下次重试早于"上次失败 + 30 s"。
- **发布**：作业成功后，scheduler 调用 `SnapshotStore.publish`，然后发 `published` 事件，并清除 suspect 集合里 `seq < job.startSeq` 的条目（§2.7）。
- **维护性 full**：快照文件大于"该 workspace 最近一次 full 的大小 × 1.3"时，安排一次 P3 full，以回收 delta 积累的碎片。
- **事件**：`queued`、`started`、`heartbeat`、`published`、`noop`、`failed`。每个作业结束写一行 builder 遥测（附录 B.5）。

### 2.7 请求路径与新鲜度

```text
MCP register callback
  └─ Promise.race(operation, hardCap(deadlineMs + 1000))     # 超时返回 DEADLINE_EXCEEDED；后台操作继续，并在 finally 中释放
       └─ withContext
            1 budget = createRequestBudget(deadlineMs)         # 在 resolve 之前创建
            2 resolved = budget.race("runtime.repo-resolve", resolver.resolve(selector))
            3 entry = getOrCreate(resolved)                    # 只做三件事：new RuntimeEntry、读 CURRENT、打开快照（目标 ≤ 20 ms）；不等任何作业
                 └─ 新 entry：scheduler.request(ws, delta, P1 或 P2)   # 有 CURRENT 时是 P2 启动校验，没有时是 P1 seed
            4 view = entry.index.acquire()                     # 固定一个快照；没有快照时 view = NOT_READY
            5 freshness = entry.freshness()                    # 读 suspect 集合与状态，不等待
            6 handler(ctx{ view, freshness, budget })
                 └─ ensureFresh(anchorFiles)：锚点在 suspect 中时，scheduler.request(P0, hints)，
                    再等待 ≤ min(1000, remaining)，直到发布了一个 startSeq > 该文件 suspect seq 的快照；
                    超时返回 { fresh: false, staleFiles }
            7 finally view.release()
```

- **suspect 集合**：`Map<relativePath, { seq, kind: "change" | "delete" }>`。coordinator 的监听器只做两件事：写入集合（`seq` 单调递增），然后 `scheduler.request(ws, delta, P2, hints)`，立即返回。BUILD_CHANGE 事件也走同一路径：layout 变化后 `layoutDigest` 不匹配，子进程会自动转 full。
- **新鲜度状态**：
  - `FRESH`：suspect 为空，且启动校验已完成；
  - `STALE_KNOWN`：suspect 非空，附带数量和最多 10 个样例；
  - `VERIFYING`：daemon 启动后尚未完成首次校验，或 watcher 未就绪；
  - `NOT_READY`：没有快照；
  - `BUILD_FAILING`：最近连续失败 ≥ 3 次；有快照时继续用旧快照服务。
- **否定回答**（例如"没有调用方"或负缓存写入）只有在 `FRESH` 时才允许，对应现有的 `negativeLookupAllowed` 和 `cacheWriteAllowed`。
- **工具输出**：Phase 1 只做加法，在各工具现有的输出对象里新增 `indexFreshness`：

  ```json
  {
    "state": "FRESH",
    "snapshotId": "lzx81k2-9f3a1c2e",
    "snapshotAgeMs": 1234,
    "staleFiles": 0,
    "staleSample": [],
    "pendingJob": null,
    "negativeAnswers": true
  }
  ```

  字段名在 P1-T7 中与现有输出核对，避免冲突。
- **JDT**：JDT session 的监听器保留，但 `flushNow` 的等待上限是 500 ms，超时就降级继续。JDT 本身的行为在 Phase 1 不变。
- **`java_status(start=false)`** 是纯读操作：返回 resolve 结果、快照与新鲜度、JDT 状态，不启动任何东西，也不等待。
- **`prewarmRepo`**（pin 预热）：用 P3 安排 full 或 delta，并等待发布。这是后台语义，不在请求路径上。

### 2.8 GC

- **执行时机**：daemon 启动 5 min 后执行一次，之后每 6 h 一次，每次发布后再做一次轻量回收（只处理本 workspace 的 retired 快照）。只有 ownership 持有者执行 GC。
- **回收规则**：

  | 对象 | 删除条件 |
  |---|---|
  | retired 快照 | 读者引用计数为 0，且 retire 已满 10 min |
  | snap 目录里未被引用的文件 | 不在 CURRENT 中，不在 retired 中，且存在超过 1 h |
  | tmp 孤儿 | 存在超过 1 h，且没有运行中的作业使用 |
  | 整个 `ws/<h>/` | 满足任一：① `ws.json.repoRoot` 已不存在且已过 1 h；② 非 pin，`lastRequestAt` 早于 14 天前，且不是任何运行中作业的 base |

- **绝不删除**：任何 CURRENT 指向的快照（除非整个 ws 被回收），以及 pin 的 ws。
- legacy janitor 保持不变，继续负责 `<repoHash12>/`（JDT workspace）。v2 用测试证明它会跳过 `.v2`。

### 2.9 遥测

- **tool 行**（现有 `impact-YYYYMMDD.jsonl`）新增字段：`deadlineMs`、`hardCapHit`、`stage`（失败所在阶段）、`phaseMs{ resolve, create, freshness, handler }`、`indexFreshness{ state, snapshotId, staleFiles }`。写入失败不影响请求（fail-open），这一点保持不变。
- **builder 行**：新文件 `builder-YYYYMMDD.jsonl`，字段见附录 B.5。现有的 `gcOldFiles` 要覆盖这个新前缀。
- 遥测里不写源码内容、不写凭据；路径只写 repoHash 和相对路径。

### 2.10 schema v10（Phase 1B）

| 改动 | 内容 | 预期收益 |
|---|---|---|
| sym 主键 | `sym` 表从"文本 UNIQUE + 整数 PK"改为 `sym(hash INTEGER PRIMARY KEY, text TEXT NOT NULL)`。`hash` 取身份文本 sha256 的前 8 字节，作为有符号 int64。插入时若 hash 已存在但文本不同，立即抛 `SYM_HASH_COLLISION`，构建失败（不静默）。去掉 109.9 MiB 的 autoindex | 约 −100 MiB 以上【推断】 |
| facts 字典化 | 对 `method`、`field`、`type`、`file` 的 facts BLOB 中重复出现的字符串（注解名、类型名、修饰符等）建立 `facts_dict(id, text)`，BLOB 内改存 id。编码格式在 P1B-T2 定稿，必须可逆，并有往返测试 | 约 −40 至 −80 MiB【推断】 |
| 身份串缩短（可选） | 身份文本里的 URL 编码路径前缀改为 `file_id` 引用；对外输出时再拼回现有格式，对外字符串保持不变 | 只在前两项之后仍不达标时做 |

- **目标**：lishu-v2 sealed 快照 ≤ 350 MiB（预期 250–300 MiB）。
- **兼容**：`SCHEMA_VERSION` 改为 10。旧快照判为不兼容，触发 full。对外 JSON 输出必须与 P1A 逐字段相同（P1B-G1）。

### 2.11 已否决的方案

| 方案 | 否决理由 |
|---|---|
| 查询时叠加（trunk 快照 + worktree overlay 合并） | 每类查询都要写合并逻辑，K20 一致性难以保证，复杂度不值 |
| 新 worktree 先用兄弟或 family 快照回答 | 违反 K06（无兄弟内容串入），改为返回 NOT_READY 并尽快 seed |
| 跨 worktree 的逐文件 CAS facts 缓存 | 差量很小，克隆加差量已经足够；只有 P1A-G4 因解析成本不达标时才重议 |
| 换语言（Rust/Go）或换存储（LMDB/RocksDB） | 没有证据；瓶颈是生命周期设计。P1A 的 CPU profile 若显示 full 构建受提取器限制且超出目标，再重议 |
| 用 git 清单做变更检测 | 内容哈希扫描已足够快，且与现有 `content_hash` 语义一致；git 还会引入 autocrlf/attributes 导致的字节差异、`.git/index` 写入、daemon 侧 EBADF 等风险（F4、F5） |
| Node `COPYFILE_FICLONE` | 实测是全量复制（F2） |
| 保留"在被服务的库上跑长事务"，只加心跳 | 能修 kill，但修不了读者可见的半成品状态。只作为 P0 过渡方案 |

---

## 3 Phase 与 Task 总表

| Phase | Task | 名称 | 依赖 | 评审 |
|---|---|---|---|---|
| P0 | T0 | 启动、基线、冻结仓库 | U1、U2 | — |
| P0 | T1 | 复现：builder 停滞窗口与恢复态活锁 | T0 | 单独 |
| P0 | T2 | 请求路径 RED 测试 | T0 | — |
| P0 | T3a | 心跳模块与同步段送达测试 | T0 | — |
| P0 | T3b | v9 supervisor 心跳 watchdog、真实进度、生命周期日志（仅部署路径） | T3a、U4 | 单独 |
| P0 | T4 | 恢复态 reconcile 改走分批冷建（仅部署路径） | T1、T3b | 单独 |
| P0 | T5 | sibling 只选健康库（仅部署路径） | T0 | — |
| P0 | T6 | 请求路径端到端限时 | T2 | 单独 |
| P0 | T7 | 遥测字段与 SLO 报告 | T0 | — |
| P0 | T8 | burst replay harness | T6、T7、U3 | — |
| P0 | G | Phase 0 门、评审、closeout | 全部 | §0.6 |
| P1A | T1 | 技术验证 S1–S6，冻结目标 | P0 | 单独 |
| P1A | T2 | SnapshotStore 与克隆原语 | T1 | 单独 |
| P1A | T3 | 内容扫描模块 | T1 | — |
| P1A | T4a/b/c | 作业进程与 full / delta / 并行解析 | T2、T3 | 每个子项单独 |
| P1A | T5 | BuildScheduler | T4a | 单独 |
| P1A | T6 | base 候选与 seed 策略 | T5 | — |
| P1A | T7a/b/c | SnapshotIndexClient / 请求路径接入 / benchmark 兼容 | T5、T6 | 每个子项单独 |
| P1A | T8 | GC v2 | T7b | — |
| P1A | T9 | 验证工具与 Phase 1A 实测 | T1–T8 | — |
| P1A | G | Phase 1A 门、评审、closeout，然后 §7 切换 | 全部 | §0.6 |
| P1B | T1–T3 | sym hash 主键 / facts 字典 / 可选身份串缩短 | P1A | 单独 |
| P1B | G | Phase 1B 门，然后 §7 | 全部 | §0.6 |
| P2 | T1–T6 | 数据集 / 确定性评测 / 模型 A/B / Tool API v2 / guidance / 复测决策 | P1A | 单独 |
| P3 | T0–T3 | 必要性判定 / 候选 A / 候选 B / 选型 | P2 | 单独 |
| P4 | T1–T4 | 删除旧路径 / benchmark 迁出（可选）/ 文档 / SLO 日报 | P1B、P2 | §0.6 |

**执行路径**：
- U4 = 部署：P0 全部 Task，P0 门，§7，然后进 P1A。
- U4 = 不部署：P0-T3b、T4、T5 记为 NOT_RUN，P0-G3 和 P0-G4 也记为 NOT_RUN，P0 门之后直接进 P1A。

---

## 4 Phase 0：止血与可测量

Phase 0 的目的：
- 用证据确认或推翻 §1.3 的推断；
- 让请求路径不再无界等待；
- 建立后续 Phase 都会复用的测量工具；
- 若选择部署，同时修好 v9 的 builder 活锁。

### P0-T0 启动、基线与冻结仓库

- **依赖**：U1、U2、附录 C.3。
- **步骤**：
  1. 执行 `git status --short`。除本手册和 `docs/evidence-archive/` 外，其余条目只能来自 U1 的 95 条部署源码改动，以及附录 C.3 保留的 110 个证据文件；以 C.3 本机 `manifest.json` 之外的保留清单为准，出现清单外的条目、二进制文件或业务源码标记就停止。按 U1 提交这些条目，排除本手册和归档目录：

     ```bash
     git add -A -- . ':!docs/deep/codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md' ':!docs/evidence-archive'
     git commit -m "chore: snapshot deployed 83aa814049e5 sources"
     SHA_BASE=$(git rev-parse HEAD)
     ```

  2. 执行 `git switch -c codex/index-lifecycle-v2 "$SHA_BASE"`，然后单独提交本手册和归档目录：`git add docs/deep/codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md docs/evidence-archive`，message 为 `docs: add ILV2 execution manual and evidence distillation records`。之后 `git status --short` 应为空。
  3. 冻结输入仓库：用本地克隆，不写源仓库；三仓 golden 固定到 §1.4 的 SHA，lishu-v2 固定到当前 HEAD：

     ```bash
     mkdir -p /tmp/frozen-java-repos
     freeze() { # name src sha
       git clone --quiet --no-checkout --local "$2" "/tmp/frozen-java-repos/$1"
       git -C "/tmp/frozen-java-repos/$1" checkout --quiet --detach "$3"
       echo "$1 $(git -C /tmp/frozen-java-repos/$1 rev-parse HEAD) java=$(git -C /tmp/frozen-java-repos/$1 ls-files '*.java' | wc -l | tr -d ' ')"
     }
     freeze lishuedu       /Users/luo/Documents/program/lishu/lishuedu  db63b1a7e393edd90449eb013d7d1c4d65c366f2
     freeze cipherlink     /Users/luo/Documents/program/cipherlink      fa433982e92e52dd610650d1e79f2d041179b1d3
     freeze exam-parent-v3 /Users/luo/Documents/program/exam-parent-v3  f90a0b475f7be2ed003703feecec8195bc7eb976
     freeze lishu-v2       /Users/luo/Documents/program/lishu-v2        "$(git --no-optional-locks -C /Users/luo/Documents/program/lishu-v2 rev-parse HEAD)"
     ```

  4. 写 `docs/index-lifecycle-v2/p0/frozen-repos.json`，每个仓库记录 `name`、`path`、`sha`、`javaFiles`、`xmlFiles`。
  5. 记录主机信息（§0.5 最后一条命令），以及开发和生产两个 Node 的版本、`git --version`。
- **完成标准**：分支建立；四个冻结仓库的 HEAD 等于目标 SHA，且 `git status --porcelain` 为空；task-result 已写。
- **停止**：U1 未确认；任何一个冻结 SHA 不存在。

### P0-T1 复现：builder 停滞窗口与恢复态活锁（隔离）

- **依赖**：P0-T0。评审：单独。
- **新增文件**：`scripts/ilv2-repro-builder-stall.mjs` 及其测试 `scripts/ilv2-repro-builder-stall.test.mjs`。测试覆盖纯函数：时间线解析、`maxFlatMs` 计算、判定规则。
- **CLI**：`node scripts/ilv2-repro-builder-stall.mjs --dist <candidate>/dist --repo /tmp/frozen-java-repos/lishu-v2 --work /tmp/ilv2-runs/p0/stall-<run-id> --step A|B|C|D`
  - 复现用的 dist 优先取生产 release 的副本，它与 `SHA_BASE` 字节一致：`cp -R "$HOME/Library/Application Support/codex-java-lsp-mcp/releases/83aa814049e5-20261011T152040Z" /tmp/ilv2-runs/p0/base-release`。复制后从副本运行，release 目录本身只读。修复后的 dist 用 compile profile 加 `--keep` 生成，路径为输出里打印的 `<root>/candidate/dist`。
  - 按 §0.9 登记：base-release 是 `INPUT`，consumer 为 P0-T1、P0-T8，P0 closeout 时删除；`--keep` 留下的隔离根是 `BULK`，consumer 为 P0-T8 的 tip 运行、P0-G3、P0-G4，代码变动后重建时先删旧根。
- **实现要求**：
  - 先读 `src/index-builder/builder-main.ts` 和 `src/java-index/builder-supervisor.ts`，确认冷建作业和 reconcile 作业的真实入口和参数。不得臆造入口。
  - 全部 DB 都放在 `--work` 下，不设置也不读取生产缓存。
- **步骤**：
  - **A 冷建自然时长**（不经过 watchdog）：
    - 直接驱动 builder 子进程对新库 `A.sqlite` 做冷建，用 `/usr/bin/time -l` 包裹以拿到峰值 RSS；
    - 每 1 s 用只读连接读取 `buildProgress` 和 `buildState`，每 1 s 采样子进程 `%cpu`；
    - 产出四项：各阶段时长（declare、resolve 第一遍、edges、KG/实体）、`maxFlatMs`（指纹保持不变的最长窗口）、总时长、峰值 RSS。
  - **B 受监督冷建**：用 dist 里的 `BuilderSupervisor`（默认 `stallMs=120000`）对新库 `B.sqlite` 冷建，记录是否出现 stall kill、重试次数、最终状态。
  - **C 恢复态 reconcile**：
    - 把 A 的产物 checkpoint(TRUNCATE) 后复制为 `C.sqlite`，然后把 `meta.buildState` 改为 `BUILDING`；
    - 用默认 `BuilderSupervisor` 提交 `{ kind: "reconcile", changed: [], deleted: [] }`，generation 用 A 的值加 1；
    - 按 A 的方式记录时间线，并加采每 1 s 的 `-wal` 字节数。
  - **D 对照**：与 C 相同，但 `stallMs=3_600_000`。记录能否完成、`applyParsedRefresh` 事务的时长、WAL 峰值。
- **判定**（写入 task-result）：
  - `STALL_WINDOW_CONFIRMED`：A 中任一阶段 `maxFlatMs ≥ 120000`，或 B 中出现 stall kill。
  - `RECOVERY_LIVELOCK_REPRODUCED`：C 中 3 次尝试都在指纹不变的窗口里被杀，最终 `ok:false` 且 `buildState≠READY`，同时 D 能完成。
  - 两者都不成立时记为 `NOT_REPRODUCED`：停止 P0-T3b 和 P0-T4，写 `p0/blocked.md` 附原始时间线，重新诊断，不得按假设修复。
- **产物**：`p0/gate-raw/P0-T1-timeline.json`（原始时间线的摘要）。
- **数据处置**（§0.9）：
  - 原始 CSV 是 `RAW`，留在 `/tmp/ilv2-runs/p0/stall-<run-id>/`，P0 closeout 时删除；
  - `A.sqlite` 的 consumer 为本 Task 的 C 和 D、P0-G4、P1-T1（S1 必用，S2、S5 可复用），P1-T1 结束时删除；
  - `B.sqlite`、`C.sqlite`、`D.sqlite` 在各自步骤取完数据后立即删除（`RUN_END`）；P0-G3、P0-G4 重跑产生的库同样处理。
- **完成标准**：A–D 都有原始时间线；判定有依据；记录了主机 load 和内存。T_full 的基线（A 的总时长）供 P1-T1 使用。

### P0-T2 请求路径 RED 测试

- **依赖**：P0-T0。
- **新增文件**：`src/runtime/request-path-deadline.test.ts`。复用 `src/repo-runtime-manager.test.ts` 和 `src/mcp-server-factory.test.ts` 里已有的 fake；需要共享时，先 `rg --files src | rg -i 'fake|test-support'` 找到现有的辅助位置。
- **用例**：每个用例先标 `{ todo: "P0-T6" }`。

  | 用例 | 搭建 | 必需断言 |
  |---|---|---|
  | R1 flushNow 卡住 | coordinator 监听器返回永不 resolve 的 promise；请求 `deadlineMs=2000` | 3000 ms 内返回结果或结构化错误；handler 收到 `freshnessMode="WATCHER_DEGRADED"`，且否定回答被禁用 |
  | R2 reconcile 卡住 | generation 为 dirty，`javaIndexClient.reconcile` 永不 resolve | 3000 ms 内返回；不抛 DEADLINE（降级继续） |
  | R3 ensureFresh 卡住 | 底层 `refresh` 永不 resolve | `ensureFresh` 在 `min(1000, remaining) + 100` ms 内返回 `{ fresh: false }` |
  | R4 family 串行 | 同 family 两个 root；A 的 `open()` 永不 resolve | 对 B 的请求在 3000 ms 内返回，index 状态是 BUILDING 或 NOT_READY，错误不是 `Deadline exceeded during runtime.create` |
  | R5 MCP 硬截止 | 测试用工厂构造参数注入较小上限（不用 env）；handler 永不 resolve | 在上限 + 1000 ms 内返回 `isError: true`，文本以 `DEADLINE_EXCEEDED` 开头；后台 handler 结束后引用计数归零 |
  | R6 预算在 resolve 之前 | `resolver.resolve` 耗时 3 s，`deadlineMs=2000` | 返回 DEADLINE 错误，`stage="runtime.repo-resolve"`，总耗时 ≤ 3000 ms |

- **RED**：在本地临时去掉 todo 运行一次，把每个用例的失败形态（超时或报错阶段）记入 `p0/gate-raw/P0-T2-red.txt`。提交时保留 todo。
- **完成标准**：6 个用例都有 RED 证据；带 todo 时全量测试仍然绿。

### P0-T3a 心跳模块与同步段送达测试

- **依赖**：P0-T0。心跳是 v2 也要用的基础设施，所以不受 P0-T1 判定结果影响。
- **新增文件**：`src/index-builder/heartbeat.ts`，导出 `beat(phase, done, total)`：
  - 节流到每秒最多一次；
  - 用 `process.send?.({ type: "heartbeat", seq, phase, done, total, atMs })` 发出；
  - 没有 IPC 通道时什么都不做。
- **测试**：`src/index-builder/heartbeat.test.ts`。fork 一个子进程，在 3 s 的同步忙循环里每 500 ms 调用一次 `beat()`，父进程统计相邻心跳的到达间隔。
  - 必需断言：最大间隔 ≤ 1500 ms，到达次数 ≥ 5。
  - 若断言失败，说明同步段里的心跳无法送达：在 task-result 里写结论 `SYNC_BEAT_UNDELIVERABLE`。此时 P0-T3b 只修进度指纹；v2 依靠 §2.5 的有界事务（`deltaMaxTouched`）满足 I7。
- **完成标准**：测试有明确结论（PASS 或上述结论）。

### P0-T3b v9 supervisor 心跳 watchdog、真实进度、生命周期日志（仅 U4 = 部署）

- **依赖**：P0-T3a、U4。评审：单独。
- **范围**：`src/java-index/builder-supervisor.ts`、`src/index-builder/builder-main.ts`、`src/index-builder/cold-build.ts`、`src/index-builder/incremental.ts`。
- **改动**：
  1. 在冷建的每个批次、resolve 第一遍的每个块、KG 阶段每 50 个文件、`parseChanged` 的每个文件，以及 `applyParsedRefresh` 的内部循环（写 bundle、`resolveTouched`、重写图和实体）里调用 `beat()`。
  2. resolve 第一遍改为提交真实递增的 `done`；KG 阶段每 200 个文件用一个独立小事务提交一次 `{ phase: "graph", done, total }`。
  3. `watchStall`：心跳或 DB 指纹任一有变化都算有进展；`stallMs` 仍是 120 s。
  4. stderr 单行日志，只含 jobId、repoHash、数字，不含源码：
     - `[codex-java-lsp] builder job start id=<n> kind=<k> repoHash=<h>`
     - `… end id=<n> ok=<b> ms=<n> error=<msg>`
     - `… stalled id=<n> lastPhase=<p> lastBeatAgoMs=<n> attempt=<a>`
     - `… exit pid=<p> code=<c> signal=<s>`
- **测试**：
  - `builder-supervisor.test.ts`：fake child 持续心跳、DB 指纹 300 s 不变，用短 `stallMs` 加可注入时钟，断言不被杀；fake child 停止心跳，断言在 `stallMs` 后被杀，并记录 stalled 日志。
  - `src/index-builder/integrity.test.ts`：冷建 fixture 时心跳次数 ≥ 批次数；改前改后 facts digest 相同（用 `scripts/facts-digest.mjs`）。
- **实测**：重跑 P0-T1 的 B 和 C。
- **完成标准**：B 和 C 都是 0 次 stall kill。C 若超过墙钟仍未 READY，记下时长交给 P0-T4。

### P0-T4 恢复态 reconcile 改走分批冷建（仅 U4 = 部署）

- **依赖**：P0-T1 的判定为 `RECOVERY_LIVELOCK_REPRODUCED`，且 P0-T3b 完成。评审：单独。
- **改动**：`applyJavaReconcile` 在 `recovering` 为真时，不再走 `parseChanged` 加 `applyParsedRefresh`，改为调用 `runSqlColdBuild`。冷建已支持：断点续建、每 200 个文件提交一次、按 content_hash 跳过未变文件。
- **测试**：`integrity.test.ts` 新增用例：把 READY 库置为 BUILDING，执行 reconcile 后应变为 READY；facts digest 与冷建一致；进度提交次数 ≥ ceil(N/200)。
- **实测**：在 lishu-v2 上重跑 P0-T1 的 C。
- **完成标准**：C 完成且 READY，时长 ≤ P0-T1 A 总时长 × 1.2，0 次 stall kill。

### P0-T5 sibling 只选健康库（仅 U4 = 部署）

- **范围**：`findSiblingDb`（`repo-runtime-manager.ts:1076-1094`）、`scanFamilySiblingIndex`（`repo-layout.ts:68-99`）。
- **改动**：
  - 候选库必须同时满足：`buildState=READY`、`coverageRevision=1`、版本三元组匹配、`indexedGeneration>0`；
  - 用现有的 `openIndexDb(path, { readOnly: true })` 只读打开做检查（与 `progressFingerprint` 相同），打开失败就跳过。legacy 库可能正在被写，所以禁止用 `immutable=1`（§0.2 第 13 条）；
  - 选择顺序：先 family 主 checkout（非 linked worktree），再按 mtime 从新到旧。
- **测试**：三个候选，分别是"最新但 BUILDING"、"较旧但 READY"、"schema 不符"，断言选中 READY 那个；全部不健康时返回 `undefined`，走冷建。
- **完成标准**：测试绿。

### P0-T6 请求路径端到端限时

- **依赖**：P0-T2。评审：单独。
- **范围**：
  - `src/mcp-server-factory.ts`
  - `src/repo-runtime-manager.ts`
  - `src/java-index/sql/sql-client.ts`
  - `src/java-index/java-index-client-api.ts`
  - `ensureFresh` 的调用方：先执行 `rg -n "ensureFresh\(" src` 列出全部调用点。
- **改动**：
  1. **MCP 硬截止**：`register` 回调里执行 `Promise.race([operation, hardCap])`，其中 `hardCap = deadlineMs + HARD_DEADLINE_GRACE_MS`，常量值 1000，测试可通过构造参数覆盖。
     - 超时返回 `errorResult`，文本为 `DEADLINE_EXCEEDED: hard cap <n>ms exceeded (stage=<最后阶段>)`；遥测记 `hardCapHit=true`。
     - 后台操作继续执行，并在自己的 finally 中正常释放。
  2. **预算前移**：`withContext` 先按 `requestOptions.deadlineMs ?? MAX_REQUEST_DEADLINE_MS` 创建预算，再执行 `budget.race("runtime.repo-resolve", …)`。之后 `requestOptionsForRuntime` 只能收紧截止时间，不能放宽。
  3. **新鲜度屏障不阻塞**：
     - 两处 `flushNow()` 都改为 `budget.race("runtime.flush", flushNow(), 500)`。超时后设置 `freshnessMode="WATCHER_DEGRADED"`，关闭缓存写入和否定回答，然后继续。
     - `reconcileIfDirty` 超时也降级继续，不再抛错。singleflight 和后台完成逻辑保留。
  4. **ensureFresh 受预算约束**：签名改为 `ensureFresh(files, generation, requestOptions): Promise<{ fresh: boolean; staleFiles: string[] }>`。
     - 实现：`budget.race("java-index.ensure-fresh", refresh(...), 1000)`，超时返回 `fresh: false`。
     - 调用方在 `fresh: false` 时要做两件事：在 `evidenceGaps` 里加上 `anchor file changed after the index snapshot; results may be stale`，并关闭否定回答。
  5. **runtime 创建不等 open**：
     - `createEntry` 不再 await `javaIndexClient.open(...)` 那条链，而是把 promise 存进 `entry.indexOpen`；
     - `familyGates` 只串行后台的 open，不阻塞 `getOrCreate` 返回；
     - 请求通过 `status()` 拿到 BUILDING 或 NOT_READY 后，走现有的降级逻辑；
     - `prewarmRepo` 仍然等待 READY。
- **测试**：
  - P0-T2 的 R1–R6 全部去掉 todo，并且全绿。
  - 回归测试：`repo-runtime-manager.test.ts`、`mcp-server-factory.test.ts`、`sql-client-lifecycle.test.ts`、`src/tools/status.test.ts`，以及 `ensureFresh` 调用方各自的测试。
- **完成标准**：上述测试全绿；全量测试绿。

### P0-T7 遥测字段与 SLO 报告

- **范围**：`src/telemetry/impact-telemetry.ts`（及其测试）、`src/java-index/builder-supervisor.ts`（写 builder 行），以及新增的 `scripts/ilv2-slo-report.mjs` 和测试。
- **改动**：
  - tool 行新增 §2.9 的字段：P0 先写 `deadlineMs`、`hardCapHit`、`stage`、`phaseMs`；`indexFreshness` 在 P1-T7 补上。
  - 新增 builder 行（附录 B.5）。P0 先写这些字段：`jobId`、`repoHash`、`kind`、`trigger`、`queuedMs`、`runMs`、`outcome`、`error`、`attempts`、`maxBeatGapMs`。
  - `gcOldFiles` 覆盖 `builder-` 前缀。
- **SLO 报告**：规格见 §11.1。
- **基线**：对生产 telemetry 只读运行一次：

  ```bash
  node scripts/ilv2-slo-report.mjs --telemetry "$HOME/Library/Caches/codex-java-lsp/telemetry" \
    --since 2026-10-11T15:20:00Z --until 2026-10-13T03:00:00Z --out /tmp/ilv2-runs/p0/slo-baseline
  ```

  结果摘要存为 `p0/gate-raw/P0-T7-baseline-slo.json`，并与 §1.2 的数字对账；不一致时写明原因。
- **完成标准**：单测绿；基线报告已生成并完成对账。

### P0-T8 burst replay harness

- **依赖**：P0-T6、P0-T7、U3。
- **新增文件**：`scripts/ilv2-burst-replay.mjs` 和测试。测试覆盖：worktree 计划生成、锚点选取、判定函数、拒绝条件。规格见 §11.2。
- **实测**：
  - 在 `SHA_BASE` 的构建上跑一次 `--profile p0`，作为基线，预期 FAIL。`--dist` 用 P0-T1 复制出的 `/tmp/ilv2-runs/p0/base-release/dist`；
  - 在 P0 tip 上再跑一次，预期 PASS。
  - 两次的 verdict 都存入 `gate-raw/`。
- **完成标准**：harness 单测绿；两次运行都有 verdict。

### P0 门

| ID | 目标 | 测法 |
|---|---|---|
| P0-G1 | 全量测试绿、PR 门绿 | §0.5 |
| P0-G2 | R1–R6 绿（无 todo） | 定向测试 |
| P0-G3 | lishu-v2 受监督冷建：0 次 stall kill，到达 READY（仅部署路径） | 重跑 P0-T1 B |
| P0-G4 | 恢复态 reconcile：0 次 stall kill，到达 READY，时长 ≤ 冷建 × 1.2（仅部署路径） | 重跑 P0-T1 C |
| P0-G5 | burst replay（p0）PASS | P0-T8 |
| P0-G6 | 三仓矩阵退出码 0 | §0.5，baseline = `SHA_BASE` |
| P0-G7 | K01–K32 全部 PASS。K26/K28 若没有真实 JDT 证据，可记 BLOCKED_ENV，前提是本 Phase 未改 JDT 代码 | §0.5 |
| P0-G8 | SLO 基线报告已完成对账 | P0-T7 |

通过后按 §0.6 评审，写 closeout，打 tag `ilv2/P0`。U4 = 部署时，按 §7 执行切换。

---

## 5 Phase 1A：快照生命周期 v2

### P1-T1 技术验证 S1–S6 与目标冻结

- **依赖**：P0 closeout。评审：单独。
- **新增文件**：`scripts/ilv2-spikes.mjs`，用 `--spike s1|…|s6` 选择子实验；测试 `scripts/ilv2-spikes.test.mjs` 只覆盖参数解析和判定函数。所有实验只写 `/tmp/ilv2-runs/p1a/spikes/`。
- **数据处置**（§0.9）：每个 spike 结束时删除它建的库、克隆和 worktree。worktree 先 `git worktree remove --force` 再 `worktree prune`，冻结仓库的 `git status --porcelain` 保持为空。结果文件是 `RAW`，保留到 P1A closeout。P0-T1 的 `A.sqlite` 在本 Task 结束时删除。

| Spike | 内容 | PASS 条件 | FAIL 时的处理 |
|---|---|---|---|
| S1 immutable 读 | 用 P0-T1 A 的库（先封存）比较三种读法：`immutable=1`、`mode=ro`、WAL 连接。跑 K29 同款查询各 100 次，两个 Node 版本各一轮 | 两个版本都能打开；`immutable=1` 的 P95 ≤ WAL 读 × 1.05 | 读者改用 `mode=ro`。DELETE 模式下没有 WAL，仍然安全 |
| S2 克隆成本 | 对 lishu-v2 的 sealed 库执行 `cp -c`：测耗时、df 增量、源文件 sha256 是否不变；克隆后用 WAL writer 应用一次 200 文件的差量再封存，测 df 增量；用 stub 让 `cp -c` 失败，测回退路径 | 克隆 ≤ 200 ms；克隆时 df 增量 ≤ 1 MiB；200 文件差量后增量 ≤ 100 MiB；源文件不变 | 改为全量复制，磁盘目标作废。停下问用户是否继续 |
| S3 worker 解析 | lishu-v2 全量，N ∈ {1, 2, 4, 6, 8} 个 worker。每个文件的 bundle 用 `scripts/facts-digest.mjs` 规范化后求 sha256，与主线程解析结果逐一比较；记录墙钟、CPU、峰值 RSS；重复 3 次 | 全部文件 digest 相同；无崩溃；最佳 N 的加速比 ≥ 2 | 改用单线程解析；T_full 改用下面的 0.8 规则 |
| S4 内容扫描 | lishu-v2 上分别测 stat-only 全扫、全量哈希；另在刚执行 `git worktree add` 的冻结 worktree 上测首次全量哈希，这正是 seed 的真实场景。不单独测冷缓存：`purge` 需要 sudo，而新 worktree 的文件刚被 checkout 写入，通常就在页缓存里 | 全量哈希 ≤ 1.5 s，stat-only ≤ 300 ms | 记录实际值，按比例调整 P1A-G4 和 G5 的分解预算（不放宽门） |
| S5 差量分布 | 在冻结的 lishu-v2 上，取 HEAD~k，k ∈ {5, 10, 20, 50, 100, 180, 400}，与 HEAD 比较内容差异文件数和依赖扩展后的 touched 数（用 v9 库离线计算），并测非恢复态 `applyParsedRefresh` 的事务耗时 | 得到 touched 与事务耗时的关系 | 用于校准 `deltaMaxTouched`，使事务耗时 p95 ≤ 10 s |
| S6 封存与克隆协议 | 依次执行：WAL 库、checkpoint、DELETE、close、`cp -c`、在克隆上 WAL 写入、封存。在每一步 kill -9 writer | 源文件 sha256 始终不变；封存后的克隆能用 immutable 打开且 `quick_check` 返回 ok；任一步被杀后，源文件和 CURRENT 都不受影响 | 停下，修订 §2.3 |

**目标冻结**：写 `p1a/targets.json`，包含：
- `T_full`：S3 PASS 时为 `max(120 s, 0.5 × P0-T1 A 总时长)`，否则为 `0.8 × P0-T1 A 总时长`；
- `deltaMaxTouched`；
- `deltaMaxChangedRatio`，默认 0.25；
- 解析并行度 N。

P1A 门表的阈值只能因 spike 数据收紧，不得放宽。

### P1-T2 SnapshotStore 与克隆原语

- **依赖**：P1-T1。评审：单独。
- **新增文件**：
  - `src/java-index/snapshot/snapshot-layout.ts`：路径函数，根目录为 `path.join(repoCacheBase(), ".v2")`；
  - `src/java-index/snapshot/clone-file.ts`：`cloneFile(src, dst): Promise<{ cloned: boolean; ms: number }>`。用 `execFile("/bin/cp", ["-c", src, dst])` 实现，失败时回退到 `/bin/cp`；
  - `src/java-index/snapshot/snapshot-store.ts`。
- **接口**（签名可以调整，但语义必须保持）：

  ```ts
  interface SnapshotStore {
    readCurrent(repoHash: string): Promise<CurrentPointer | undefined>;
    publish(input: { repoHash: string; jobId: string; sealedPath: string; meta: PublishMeta }): Promise<CurrentPointer>;
    openReader(pointer: CurrentPointer): SnapshotReader;            // immutable=1；包含 meta 校验
    acquire(repoHash: string): SnapshotLease | undefined;           // 引用计数
    retire(repoHash: string, snapshotId: string): void;
    readWsMeta(repoHash: string): Promise<WsMeta | undefined>;
    touchWs(repoHash: string, patch: Partial<WsMeta>): Promise<void>; // lastRequestAt 每分钟最多写一次
  }
  ```

- **故障注入**：仅测试使用的构造参数 `faults?: { at: "afterRename" | "afterCurrentTmp" | "beforeCurrentRename"; action: "throw" | "exit" }`。
- **测试**：
  - I2、I3、I4 三条不变量；
  - 每个崩溃点（用子进程 `process.exit` 模拟）之后 CURRENT 都有效；
  - 正在被读者使用的快照不会被删除；
  - 打开 tmp 库时 `openReader` 拒绝（§0.2 第 13 条）；
  - legacy janitor 遇到 `.v2` 时跳过，可以用 `worktree-cache-cleanup.test.ts` 的现有夹具构造。
- **完成标准**：上述测试绿；没有任何地方使用 Node 的 `COPYFILE_FICLONE`（用 `rg -n "COPYFILE_FICLONE" src` 确认结果为空）。

### P1-T3 内容扫描模块

- **依赖**：P1-T1。
- **范围**：
  - 新增 `src/index-builder/content-scan.ts`，从 `incremental.ts` 抽出 stat 扫描、哈希和与 base 求差的逻辑，写成纯函数加 I/O 两层；
  - `incremental.ts` 改为调用它，行为不变。
- **接口**：
  - `scanStat(repoRoot, layout, previous)` 返回 `{ candidates, unchanged, deleted }`；
  - `hashAll(repoRoot, layout)` 返回 `Map<path, { hash, size, mtimeMs, kind }>`；
  - `diffAgainst(db, hashes)` 返回 `{ changed, added, deleted }`，Java 和 XML 分开。
- **测试**：新增/修改/删除/改名/CRLF/中文与空格路径/空文件/非 UTF-8 字节；`hashAll` 与现有 `contentHashOf` 结果相同。`sql-client-incremental.test.ts` 和 `integrity.test.ts` 回归绿。
- **完成标准**：v9 行为不变（全量测试绿）；新模块单测绿。

### P1-T4 作业进程与流水线

评审：T4a、T4b、T4c 每个子项单独评审。

**T4a 作业进程与 full**：
- 新增 `src/index-builder/job-main.ts`，实现 §2.5 的进程模型和 IPC 协议。
- full 复用冷建逻辑，在 tmp 上执行，完成 §2.5 列出的心跳和进度修正（若 P0-T3b 已做，直接复用），然后封存。
- 测试：
  - fixture（`fixtures/java-index-v2`）上，v2 full 与 v9 冷建的逻辑导出完全相同（用 P1-T9 的导出器核心，先在测试里引入它的模块）；
  - `faultAt` 设在每个阶段时，tmp 都留下、父进程收到失败、没有 CURRENT 被写入；
  - 心跳最大间隔 ≤ 2 s（fixture 规模）。

**T4b delta**：
- 实现 §2.5 delta 流程的第 1–7 步，包括选 base、转 full 的三个条件、全量重戳 stat、`recovering` 不可达的断言。
- 测试在临时 git 仓库里完成：用 fixture 文件做多次提交，模拟 worktree A 和 B：
  - `delta(S(A) → B)` 与 `full(B)` 的逻辑导出完全相同；
  - B 的快照里不出现 A 的绝对路径；
  - 只有 XML 变化时 XML 证据被刷新（K21 形态）；
  - 差量超阈值时转 full；
  - 无差异时返回 noop。

**T4c 并行解析**（仅 S3 PASS 时执行；否则记 NOT_RUN）：
- 新增 `src/index-builder/parse-pool.ts`。每个 worker 有自己的 Parser，结果通过 `postMessage` 回传；按路径排序后写入，保证确定性。
- 测试：N=1 与 N=4 时 full 的导出相同；worker 崩溃时作业失败（不挂起）。

**完成标准**：T4a、T4b、T4c 各自的测试绿；全量测试绿。

### P1-T5 BuildScheduler

- **依赖**：P1-T4a。评审：单独。
- **新增文件**：`src/java-index/snapshot/build-scheduler.ts`，实现 §2.6 的全部规则。子进程启动通过可注入的 `spawnJob` 完成，便于测试替换。
- **测试**（全部用 fake child）：
  - 槽位：同时提交 5 个作业，运行中的子进程始终 ≤ 2，槽 B 从不运行 P2 或 P3；
  - 同一 workspace 不会并发；
  - 合并：排队中的作业合并 hints、提升优先级；运行中的作业到来新请求时，结束后补跑一次；
  - 心跳停止 120 s 后被杀（用可注入时钟）；超过墙钟上限后被杀；
  - 退避序列正确，连续 3 次失败后进入 BUILD_FAILING；
  - 只有 ownership 持有者调度；
  - 发布后清除 suspect 中 `seq < startSeq` 的条目。
- **完成标准**：测试绿。

### P1-T6 base 候选与 seed 策略

- **依赖**：P1-T5。
- **新增文件**：`src/java-index/snapshot/seed-policy.ts`，提供 `baseCandidates(ws)`：
  - 来源：同 `familyKey` 的各 ws 的 CURRENT，且 `snapshotFormat` 与版本四项都兼容；
  - 排序：自身最前，然后是主 checkout，其余按 `lastPublishAt` 降序；
  - 最多 5 个；排除正在被 GC 回收的 ws。
- **测试**：排序、上限、不兼容版本被排除、没有候选时返回空（由调用方安排 full）、自身优先。
- **完成标准**：测试绿。

### P1-T7 读侧与请求路径接入

评审：T7a、T7b、T7c 每个子项单独评审。

**T7a SnapshotIndexClient**：
- 新增 `src/java-index/snapshot/snapshot-index-client.ts`，实现 `JavaIndexClientApi`（`src/java-index/java-index-client-api.ts:102`）。
- 查询方法委托给现有的 `SqlFactsStore`、`SqlKnowledgeGraph` 和实体检索，使用当前请求持有的快照。
- 生命周期方法：
  - `open`：读 CURRENT；
  - `status`：基于指针和 scheduler 状态，返回 §2.7 的新鲜度状态；
  - `ensureFresh`：按 §2.7 的语义实现；
  - `reconcile` 和 `flush`：改为提交 P2 请求，立即返回；
  - `awaitPrewarmReady`：等待发布，只供预热使用。
- query worker 改为按 `snapshotPath` 打开连接（§2.3 读取第 6 步）。

**T7b 接入 runtime**：
- 改 `repo-runtime-manager.ts` 和 application：
  - scheduler、store、GC 都是单例；
  - `createEntry` 使用 SnapshotIndexClient；
  - coordinator 监听器写 suspect 集合后立即 request；
  - 删除 v2 路径上的 `familyGates` 等待、`findSiblingDb` 和 `JAVA_LSP_INDEX_DIR`（同时更新 README）；
  - `java_status(start=false)` 改为纯读；
  - 各工具输出 `indexFreshness`。
- 测试：
  - R1–R6 仍然绿；
  - 同一 ws 正在跑 full 时发起请求，能用旧快照立即返回，并带 STALE 标记；
  - 新 worktree 没有快照时，200 ms 内返回 NOT_READY，同时已安排 P1 seed；
  - daemon 重启后先是 VERIFYING，校验完成后变为 FRESH；
  - K06 变体：新 worktree 绝不返回兄弟内容；
  - K20 变体：持有快照期间发布新快照，结果全部来自旧快照。

**T7c benchmark 与矩阵兼容**：
- `src/benchmark-agent-impact.ts:170` 和 `src/benchmark/progressive-index.ts:70` 改用 v2：`--index-cache-dir <dir>` 解释为本次运行私有的 cache base，即 `<dir>/.v2/...`，流程是 full、发布、打开、查询。
- CLI 参数名不变，以保证矩阵脚本（`scripts/run-three-repo-cold-matrix.mjs:522`）能同时驱动新旧两个版本。
- 测试：benchmark 的现有测试绿；用 fixture 跑一次 `cold-nolsp`，结果 JSON 结构与 v9 相同。

**完成标准**：每个子项的测试绿；全量测试绿；K runner 映射按 §0.6.3 更新完毕，并跑通一次。

### P1-T8 GC v2

- **依赖**：P1-T7b。
- **新增文件**：`src/java-index/snapshot/snapshot-gc.ts`，实现 §2.8；挂到 application 的定时器上。
- **测试**：
  - 按 §2.8 的表格逐行覆盖；
  - CURRENT 永不被删除；
  - 有读者的快照不被删除；
  - pin 的 ws 永不被删除；
  - 正在运行的作业的 tmp 不被删除；
  - legacy janitor 与 v2 GC 互不干扰。
- **完成标准**：测试绿。

### P1-T9 验证工具与 Phase 1A 实测

- **新增脚本**：
  - `scripts/ilv2-snapshot-equivalence.mjs`（§11.4）
  - `scripts/ilv2-lifecycle-bench.mjs`（§11.3）
  - `scripts/ilv2-fault-matrix.mjs`（§11.5）
  - 以及它们的测试。
- **实测**：门禁执行者在 P1A tip 上按门表逐项执行。

### P1A 门

| ID | 目标 | 测法 |
|---|---|---|
| P1A-G1 | 4 个冻结仓库上，v2 full 与 v9 冷建逻辑等价，0 差异 | equivalence：v9 用 `ilv2/P0` 的 dist 冷建 |
| P1A-G2 | delta 与 full 逻辑等价：≥ 10 对 0 差异，且 0 处 base 绝对路径泄漏。<br>lishu-v2 至少 6 对：HEAD~20、~50、~100、~180 到 HEAD，以及 HEAD 加 3 个、加 30 个脏文件；lishuedu 至少 2 对；exam-parent-v3 至少 2 对 | equivalence |
| P1A-G3 | lishu-v2 full：0 次 stall kill；`maxBeatGapMs ≤ 30000`（目标 ≤ 2000）；墙钟 ≤ `T_full` | lifecycle-bench full，跑 3 次 |
| P1A-G4 | seed 延迟（从请求到 CURRENT 发布）：差异 ≤ 20 个文件时 p95 ≤ 5 s；21–200 个文件时 p95 ≤ 15 s | lifecycle-bench seed，每档 ≥ 10 个样本 |
| P1A-G5 | 单文件编辑：作业 runMs p95 ≤ 2 s；从编辑到查询可见 p95 ≤ 3 s | lifecycle-bench incremental，≥ 20 个样本 |
| P1A-G6 | 磁盘：每次 seed（差异 ≤ 200）的物理增长中位数 ≤ 100 MiB；sealed 快照旁没有 `-wal`/`-shm`；作业结束后 tmp 为空 | lifecycle-bench `--disk` |
| P1A-G7 | 故障矩阵全部 PASS | fault-matrix |
| P1A-G8 | burst replay（p1）PASS | §11.2 |
| P1A-G9 | burst 中 `java_status(start=false)` p99 ≤ 200 ms；有效路径的调用里，缺 repoHash 的遥测行数为 0 | burst verdict 与遥测 |
| P1A-G10 | 全量测试和 PR 门绿；K01–K32（含 §0.6.3 的变更）PASS；K29 P95 ≤ 150 ms，event loop P95 ≤ 20 ms | §0.5 |
| P1A-G11 | 三仓矩阵退出码 0 | §0.5，baseline = `ilv2/P0` |
| P1A-G12 | canary 浸泡 2 h：0 崩溃、0 次触发硬截止、0 次 stall kill；SLO 报告在 §11.1 的 p1 阈值内 | §7.2 |

通过后按 §0.6 评审，写 closeout，打 tag `ilv2/P1A`，再按 §7 切换（需 U7）。

---

## 6 Phase 1B：schema v10 存储压缩

### P1B-T1 sym hash 主键

- **范围**：`src/java-index/sql/schema.ts`、`rows.ts`、`facts-store.ts`、`stable-id.ts`（只改身份存储，不改身份文本），以及所有 `sym` 读写点（先 `rg -n "\bsym\b" src/java-index/sql` 盘点）。
- **测试**：
  - 碰撞注入：用测试替换 hash 函数，制造两个文本相同 hash 的情况，断言构建失败并报 `SYM_HASH_COLLISION`；
  - 往返：文本到 hash 再到文本保持一致；
  - 现有 `sql-client*.test.ts`、`facts-store.test.ts`、`rows.test.ts`、`driver.test.ts` 绿。

### P1B-T2 facts 字典化

- **范围**：facts 的编码和解码（`rows.ts` 或现有 BLOB 编解码处）。
- **实施**：编码格式先写成 `docs/index-lifecycle-v2/p1b/facts-encoding.md`，评审通过后再实现。
- **测试**：
  - 对 4 个冻结仓库的全部 facts 做往返（decode(encode(x)) 深度相等）；
  - 新编码比旧编码的总字节数小。

### P1B-T3 身份串缩短（条件执行）

- **条件**：完成 T1 和 T2 后，lishu-v2 快照仍 > 350 MiB 才做，否则记 NOT_RUN。
- **测试**：所有对外输出的身份字符串与 P1A 逐字相同。

### P1B 门

| ID | 目标 | 测法 |
|---|---|---|
| P1B-G1 | API 级差分：每个仓库 ≥ 300 个查询（`java_symbol` 的 query、exact、evidence，`java_impact` 的 fast），JSON 输出与 P1A 逐字段相同；排除字段只能是 `snapshotId`、耗时类字段 | §11.6 |
| P1B-G2 | lishu-v2 sealed 快照 ≤ 350 MiB | `ls -l` |
| P1B-G3 | K29 和三仓的 P95 不劣于 P1A × 1.1 | K runner、矩阵 |
| P1B-G4 | P1A-G2 到 G11 在 v10 上复跑全部 PASS。G1 改为"两次 v10 full 的逻辑导出相同"（确定性） | 同 P1A |

通过后按 §0.6 评审，写 closeout，打 tag `ilv2/P1B`，再按 §7 切换。

---

## 7 生产切换、观察与回滚

适用于 P0（U4 = 部署时）、P1A、P1B、P2（工具面改动）。

### 7.1 前置

- 该 Phase 的 closeout 结论为 CLOSED。
- `git status --short` 为空。
- 用户已按 U7 确认，确认内容包括候选 SHA、安装命令、回滚命令和观察期。

### 7.2 canary 浸泡（U3）

- 在 :38457 启动候选 dist。环境变量与 `install-runtime.sh:439-470` 的候选 smoke 相同：
  - `JAVA_LSP_HTTP_PORT=38457`、`JAVA_LSP_HTTP_INSTANCE_ID=ilv2-canary-<run-id>`；
  - `JAVA_LSP_CACHE_BASE` 和 `JAVA_LSP_OWNERSHIP_BASE` 指向 `/tmp/ilv2-runs/<phase>/canary-<run-id>/`；
  - `JAVA_LSP_PROJECTS_JSON`：pin 指向 `/tmp/frozen-java-repos/*`；
  - `XDG_CONFIG_HOME`、`CODEX_HOME`、`HOME` 都指向临时目录；
  - `JDTLS_BIN=/usr/bin/false`。
- 浸泡 2 h：每 30 min 跑一轮 burst replay（p1），期间在冻结的 lishu-v2 上持续创建和删除 worktree（每 10 min 一次）。
- 结束时跑 SLO 报告。
- 完成后停止 canary，删除 canary 缓存（`BULK`）；冻结的 lishu-v2 上 `git worktree list` 只剩主 checkout。日志和 verdict 是 `RAW`，保留到 §7.4 结束。

### 7.3 安装

```bash
cd /Users/luo/Documents/github/codex-java-lsp-mcp
./install-runtime.sh                       # 不加 --activate-http
"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" smoke
"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" status
```

服务当前处于 disabled 且未加载（§1.6）。安装前先执行 `launchctl enable gui/$(id -u)/com.lky.codex-java-lsp-mcp`；如果安装器不负责 bootstrap，再执行 `daemonctl.sh start`。

### 7.4 观察（24 h，或用户指定）

每 6 h 对生产 telemetry 跑一次 SLO 报告。任一条件成立就立即回滚：
- 出现任何一次触发硬截止的调用；
- 同一 ws 连续 3 次 `outcome=stalled`；
- `java_status` p99 > 1 s；
- daemon 崩溃；
- 出现 worktree 隔离错误（兄弟内容串入）。

观察结束或回滚后，把 canary 的 verdict、各次 SLO 报告和最终决定提炼为当期 Phase 的 `gate-raw/cutover-<run-id>.json`，然后删除原件（§0.9）。

### 7.5 回滚

```bash
"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" rollback-release
```

- 回滚到 legacy release 后，它使用 `<repoHash>/index.sqlite`，会重新冷建。若回滚目标是 `83aa…`，D1 活锁风险依旧存在。
- `.v2/` 目录会保留。legacy janitor 跳过点开头的目录，所以它不会影响旧版本；是否删除由 U9 决定。

---

## 8 Phase 2：真实负载评测与 Tool API v2

**前提**：P1A 已在生产稳定运行 ≥ 3 天，主场景已经可测。

### P2-T1 数据集

- 用 `scripts/generate-commit-tasks.mjs --repo <frozen> --project <name> --output <dir> --holdout-ratio 0.3`，从冻结的 lishu-v2、lishuedu、exam-parent-v3 中生成候选任务。
- 人工筛选出 40–60 个任务，覆盖：跨模块调用方、实现类、Mapper XML 映射、Spring 注入、DTO 变更影响面、编译修复。
- 冻结为 `golden/real-workload/<repo>.tasks.json`，并记录 sha256。holdout 部分在 P2-T6 之前不得查看结果。
- 从生产 telemetry 统计工具调用的组合和顺序，只取计数。
- 可选（U6）：从 `~/.codex/sessions` 抽取 `java_*` 调用的名称、相对路径参数、耗时和结果状态，只产出聚合模式。抽取出的原始记录不入库，聚合结果写定后立即删除，不等 Phase closeout。

### P2-T2 确定性评测

- 用 `scripts/evaluate-java-task.mjs` 和冻结 harness（`eval-frozen-adapter.mjs`、`eval-native-tools.mjs`）跑不调用模型的检索指标：gold 文件在 read plan 中的 recall、precision、payload 字节数、耗时。
- **基线**：P1A 的工具面。
- **数据处置**（§0.9，也适用于 P2-T3 和 P2-T6）：
  - harness 每个 attempt 都复制整个 fixture，product 臂还会留下一份索引库，且自身不清理（§0.9）。冻结的 lishu-v2 仅跟踪文件就有 336 MiB【实测】。
  - 运行前估算单批峰值：attempt 数 × fixture 大小 + product 臂 attempt 数 × 索引库大小。索引库大小取 P0-T1 task-result 里登记的 `A.sqlite` 字节数。估算写入 task-result；单批峰值不得超过 20 GiB，也不得超过运行前可用磁盘减 30 GiB。
  - 按任务分批运行（`--filter <id,id..>`），每批一个输出目录 `/tmp/ilv2-runs/p2/eval-<run-id>/batch-<n>/`。评分在同一次调用内完成【代码】`scripts/evaluate-java-task.mjs:1093`、`:1153-1154`。调用结束后立即删除该批的 `candidates/` 和 `mcp-cache/`，再开始下一批。
  - repair 类 attempt 在删除前导出相对 fixture 的差异：`diff -ruN -x .git <fixture> <attempt>`，差异文件按 `RAW` 处理。

### P2-T3 模型 A/B（U5）

- **预登记**：在任何运行之前，提交 `p2/preregistration.json`，写明臂、指标、阈值、每臂运行次数（≥ 3）、scorer 版本。
- **两臂**：Product（原生工具加 MCP）对 Control（只有原生工具）。复用 `eval-pilot-compare.mjs`、`eval-answer-contract.mjs`、`live-model-profiles.mjs`。
- **指标**：成功率、输入 token、墙钟、拿到首个正确证据的时间。
- **原始记录**：模型请求与响应、judge 输出重新获得需要付费，P2 closeout 前必须压缩到本机归档 `ilv2/p2/<TaskId>-<run-id>.tar.xz`（§0.3），附逐文件 sha256 清单。它们含输入仓库源码正文，不得入库（§0.9）。`source-snapshots/` 里与冻结仓库对应 SHA 下内容相同的文件只记清单（路径、sha256），其余（attempt 中途被修改过的版本）一并压缩。

### P2-T4 Tool API v2（不兼容）

1. 每个工具输出 `indexFreshness`，从 P1 的可选字段改为必有字段。
2. `java_impact` 接受 `symbol` 参数，格式可以是 `com.x.Foo`、`com.x.Foo#bar` 或 `Foo#bar(String)`，由静态索引定位。有歧义时返回 `AMBIGUOUS` 和候选列表，不猜测。
3. 参数校验失败时，错误信息里带一个合法示例。
4. 删除"先调用 `java_status`"的要求。
5. 删除 `IDLE_WARMING_BEFORE` 相关逻辑。
6. 是否合并 `java_symbol` 和 `java_impact`，由 P2-T6 的数据决定。

### P2-T5 guidance（U8）

根据 P2-T4 的变化，写出 `~/.codex/AGENTS.md` 和 hook 的建议 diff，存为 `p2/guidance.diff`，由用户落地。

### P2-T6 复测与决策

在 P2-T4 加 T5 的版本上重跑 T2 和 T3，按预登记的门判断。

**P2 门**（默认值，可在预登记中收紧）：
- 确定性 recall 相比 P1A 不下降超过 2 个百分点；
- 模型 A/B 至少满足一项：成功率持平（±1 题）且输入 token 减少 ≥ 20%；或成功率提高 ≥ 10 个百分点。
- 达不到的能力（例如 read plan 启发式）进入 P4 的删除或重做清单，不再往上堆功能。

---

## 9 Phase 3：精度层（实验决定）

- **P3-T0 必要性判定**：如果 P2 的数据显示语义精度不影响任务成功，Phase 3 整体取消，记 NOT_RUN 并给出数据依据。
- **P3-T1 候选 A**：每个 family 共享一个 JDT，worktree 的差量文件用 didOpen 覆盖，结果路径映射回 worktree；构建文件不同时回退到专用 JDT。
- **P3-T2 候选 B**：为主 checkout 快照离线生成编译器级的引用和实现（ECJ 批处理或 javac 插件），写入快照；live JDT 只负责 diagnostics。
- **P3-T3 选型**：
  - 在冻结的 lishu-v2 上分层抽 200 个符号（类、带实现的接口、带调用方的方法）；
  - 真值是隔离环境里每 worktree 一个的 live JDT，只在冻结副本上导入；
  - 一致率 ≥ 98%，且后台成本可接受（记录 CPU 时间、RSS 峰值、磁盘），才采用；否则两个候选都不采用。

---

## 10 Phase 4：收敛

### P4-T1 删除旧路径

- **删除对象**：
  - `src/java-index/sql/vacuum-into.ts`；
  - `SqlJavaIndexClient` 中的 `copySibling`、`retargetCopiedDb`、`copiedSchemaMatches`、恢复态相关逻辑；若已没有使用者，删除整个类；
  - `RepoRuntimeManager` 中的 `findSiblingDb`、`familyGates`、`startFamilyCreate`；
  - `repo-layout.ts` 中的 `scanFamilySiblingIndex`；
  - `incremental.ts` 的 `recovering` 分支；
  - `builder-supervisor.ts` 和 `builder-main.ts` 的长驻 serve 模式；
  - `mcp-server-factory.ts` 中的 `IDLE_WARMING_BEFORE` 和 `rethrowUnlessIdleWarming`；
  - 不再使用的环境变量，例如 `JAVA_LSP_BUILDER_IDLE_MS`。
- **验证**：`rg -n "<symbol>" src scripts` 对每个已删除符号都返回空。

### P4-T2 benchmark 迁出（可选）

- **前提**：三仓矩阵脚本能同时驱动新旧两种路径。不满足就保留现状并记录原因。

### P4-T3 文档

- 更新 `docs/phase-f/production-operations.md`（v2 缓存布局、哪些能删、GC 规则）、README、HANDOFF。
- 本手册状态改为 LANDED。

### P4-T4 SLO 日报

`scripts/ilv2-slo-report.mjs --daily`，按工具和仓库输出 p50、p95、p99，以及超限比例、新 worktree 首次成功时间、builder 结果分布。

**P4 门**：全量测试、PR 门、K01–K32、三仓矩阵全部 PASS；删除核查结果为空；文档已更新。

---

## 11 验证工具规格

所有脚本的共同要求：
- 输出目录必须不存在（证据不可覆盖），且位于仓库之外；
- 拒绝把生产缓存路径作为输入或输出；
- 只读冻结仓库；需要写 worktree 时，只在冻结克隆里执行 `git worktree add`；
- 中间产物（数据库、快照、worktree、缓存）只放在输出目录或 `--work` 之下，不另建临时目录。成功结束时默认删除中间产物，只留结果文件；失败时保留，并在 JSON 摘要里列出路径。Task 卡指明要留给后续步骤的产物（例如 P0-T1 的 `A.sqlite`）不删。留下的路径由执行者按 §0.9 登记；
- 结束时打印一行 JSON 摘要；
- 退出码：0 表示 PASS，1 表示门失败，2 表示前置条件或运行失败。

### 11.1 `ilv2-slo-report.mjs`

- **CLI**：`--telemetry <dir> --since <ISO> --until <ISO> --out <dir> [--profile p0|p1] [--daily]`
- **输出**：`slo.json`、`slo.md`。
- **统计项**：
  - 按工具和 repoHash：调用数、成功率、elapsedMs 的 p50/p95/p99、硬截止触发次数、错误码分布；
  - builder：按 kind 和 outcome 计数，runMs 的 p50/p95，queuedMs 的 p95，stall 次数；
  - 每个 repoHash 从首次调用到首次成功的时间。
- **阈值**：

  | profile | 条件 |
  |---|---|
  | p0 | 硬截止触发 0 次；`java_status` p95 ≤ 1000 ms |
  | p1 | 在 p0 基础上：`java_status` p99 ≤ 200 ms；stall 0 次；新 worktree 首次成功 p95 ≤ 60 s |

### 11.2 `ilv2-burst-replay.mjs`

- **CLI**：`--dist <abs dist> --frozen /tmp/frozen-java-repos/lishu-v2 --out <dir> --profile p0|p1 [--worktrees 6] [--duration-s 300] [--port 38457]`
- **拒绝条件**：端口已被占用；`--out` 已存在；冻结仓库 `git status --porcelain` 非空；解析出的缓存路径落在生产路径下。
- **启动 daemon**：使用 §7.2 的环境变量（缓存放在 `<out>/cache`，`JDTLS_BIN=/usr/bin/false`），通过 `/bin/sh -c 'ulimit -n 65536; exec node --disable-warning=ExperimentalWarning --max-old-space-size=768 <dist>/http-server.js'` 启动，然后等待 `/readyz`。
- **步骤**：
  1. **主库就绪**：对冻结主 checkout 调用 `java_status(start=false)`，轮询直到 READY 或 FRESH，记录 `timeToReadyMs.main`。
  2. **worktree 计划**：从 first-parent 历史中取偏移 20、50、100、180 的提交，再加两个 HEAD 上的脏改动（分别改 3 个和 30 个文件：在第一个源码根下按路径排序取前 N 个 `.java` 文件，末尾追加一行注释）。用 `Promise.all` 并发执行 `git -C <frozen> worktree add --detach`。
  3. **锚点**：在每个 worktree 里，取按路径排序的第一个 `*ServiceImpl.java`，用它的简单名作为 `java_symbol` 的 query；用它 `class` 声明所在行作为 `java_impact` 的锚点，`semanticPolicy=fast`。工具参数的形状以 `src/tools/*.ts` 的 zod schema 为准。
  4. **调用序列**：每个 worktree 并发执行 `java_status(start=false)`、`java_symbol`、`java_impact`，之后每 10 s 循环一次，持续 `--duration-s`。
  5. **编辑可见性**（仅 p1）：第 60 s 时，在 wt-1 和 wt-2 的锚点文件里各追加一个新方法，测量 `java_symbol` 能查到它的时间。
  6. **采样**：每 1 s 统计 daemon 的 builder 子进程数（`ps -o pid=,ppid=,command=`）。
- **输出**：`calls.jsonl`、`children.jsonl`、`daemon.stderr.log`、`telemetry/`、`verdict.json`（附录 B.6）。
- **判定**：

  | profile | 条件 |
  |---|---|
  | p0 | `elapsedMs > deadlineMs + 1000` 的调用数为 0；`java_status` p95 ≤ 1000 ms；全部响应都可解析为结构化结果 |
  | p1 | 在 p0 基础上：`java_status` p99 ≤ 200 ms；每个 worktree 在创建后 60 s 内达到 READY 或 FRESH；builder 子进程数最大值 ≤ 2；stall kill 0 次；编辑可见 p95 ≤ 3 s |

- **清理**：先 SIGTERM daemon，10 s 后仍未退出就 SIGKILL；对每个 worktree 执行 `git -C <frozen> worktree remove --force`，再 `worktree prune`；断言冻结仓库 `git status --porcelain` 为空；删除 `<out>/cache`（日志和 verdict 保留）。

### 11.3 `ilv2-lifecycle-bench.mjs`

不经过 MCP，在进程内直接驱动 scheduler 和作业，排除 MCP 开销。

- **CLI**：`--dist <abs> --repo <frozen> --out <dir> --mode full|seed|incremental [--samples N] [--disk]`
- **full**：跑 N 次 full，记录 runMs、各阶段 phaseMs、`maxBeatGapMs`、峰值 RSS（用 `/usr/bin/time -l` 包裹子进程）、快照字节数。
- **seed**：
  - 先对冻结主 checkout 做一次 full 并发布；
  - 然后按差异档位（≤ 20 个文件、21–200 个文件）各创建 N 个 worktree（偏移从 S5 的结果中选）；
  - 每个 worktree 测量从 request 到 published 的时间，并核对实际差异数。
- **incremental**：在一个已发布的 ws 上做 N 次单文件编辑，每次编辑一个不同的文件，测作业 runMs 和"编辑到 published 事件"的时间。
- **`--disk`**：
  - 每个样本前后记录 `df -k /` 的可用空间和 `tmutil listlocalsnapshots /` 的数量；
  - 若期间 Time Machine 快照数变化，该样本作废并重测；
  - 每个样本的物理增长 = 前后可用空间之差；
  - 同时检查 sealed 快照旁没有 `-wal`/`-shm`，且 tmp 为空。

### 11.4 `ilv2-snapshot-equivalence.mjs`

- **CLI**：`--a <db> --b <db> --out <json> [--leak-root <abs base root>]`
- **逻辑导出**：
  - 所有整数 sym id 都映射回文本；
  - 所有 facts BLOB 都解码后规范化（复用 `scripts/facts-digest.mjs`）；
  - 覆盖的表：`file`、`type`、`method`、`field`、`edge`、`kg_node`、`kg_edge`、`entity`、`entity_token`、search-doc 及其 token 表、`mybatis_resource`、`resource_scan`、`source_root_coverage`、`meta`。
  - 每张表按业务键排序后计算 digest；完全相同的行允许重复的表按多重集合比较。
- **排除的字段**（只有这些允许不同）：
  - 列：`file.mtime_ms`、`file.ctime_ms`、`file.generation`、`resource_scan.mtime_ms`、`source_root_coverage.generation`，以及其他表里的 `generation` 列；
  - meta 键：`snapshotId`、`createdAt`、`baseSnapshotId`、`buildKind`、`delta*`、`builderBuildSha`、`buildProgress`、`indexedGeneration`、`graphGeneration`。
  - `repoRoot` 单独检查，必须等于目标 worktree。
- **泄漏检查**：给出 `--leak-root` 时，在 b 的全部 TEXT 列和解码后的 BLOB 中搜索该绝对路径前缀，计数必须为 0。
- **输出**：`{ equal, tables: { <name>: { countA, countB, digestA, digestB, diffSamples: [≤5] } }, leakage: { count, samples } }`

### 11.5 `ilv2-fault-matrix.mjs`

- **CLI**：`--dist <abs> --repo /tmp/frozen-java-repos/cipherlink --out <dir>`。另需在 lishu-v2 上跑一次，只覆盖封存相关的故障点。
- **故障点**：
  - 子进程通过 `faultAt` 在以下阶段以 137 退出：`scan`、`clone`、`parse`、`write`、`resolve`、`graph`、`sealCheckpoint`、`sealJournal`、`sealClose`；
  - 父进程侧的 SnapshotStore：`afterRename`、`afterCurrentTmp`、`beforeCurrentRename`；
  - 真实进程层面：子进程已封存后，`kill -9` canary daemon。
- **每个故障点的断言**：
  - CURRENT 要么不变、要么是新的且有效：`immutable` 能打开，`quick_check` 返回 ok，`snapshotId` 一致；
  - 一个并发读者循环（每秒 100 次查询）全程 0 错误；
  - 下一次作业能成功发布；
  - 下一次 GC 后 tmp 为空，未被引用的快照被清理。

### 11.6 API 级差分（P1B-G1）

- **脚本**：`scripts/ilv2-api-differential.mjs --dist-a <P1A dist> --dist-b <P1B dist> --repo <frozen> --queries <n> --out <dir>`
- **查询集**：从 a 的快照中确定性抽样（按 sym 文本排序后等距取样）：类型 FQN、`owner#method`、常见词。
- **执行方式**：两边各自做 full，然后分别调用工具层的函数（不经过 MCP），比较 JSON 输出。排除字段只能是 `snapshotId` 和耗时类字段。

---

## 12 风险与止损

| 风险 | 早期信号 | 处置 |
|---|---|---|
| P0-T1 未复现活锁 | 判定为 NOT_REPRODUCED | 停止 T3b 和 T4，带原始时间线重新诊断（可能是 sibling 传染或请求路径问题） |
| 同步段心跳无法送达 | P0-T3a 的结论是 `SYNC_BEAT_UNDELIVERABLE` | v9 只修进度指纹；v2 依靠有界事务（`deltaMaxTouched`） |
| worker 解析结果不一致 | S3 中 digest 不同 | 单线程解析，T_full 用 0.8 规则 |
| 克隆不可用或成本超预期 | S2 FAIL | 改为全量复制；磁盘目标作废，向用户报告是否继续 |
| delta 与 full 不等价 | P1A-G2 出现差异 | 按差异样本定位；修复前 seed 一律转 full（正确性优先），并重新评估 G4 |
| 依赖扩展过大 | S5 显示 touched 普遍 > 400 | 下调转 full 的阈值；考虑把 delta 事务分块（需新增 Task 并评审） |
| 磁盘 | 可用 < 30 GiB | 先按 §0.9 删除已到期的登记数据；仍不足时按 §0.8 停止三仓矩阵以外的实测，三仓矩阵只记录 `df` |
| 矩阵退化 | 质量门或 P95 门失败 | 用 equivalence 和 API 差分定位，确认是否为生命周期副作用；不放宽门 |
| Tool API v2 改变 agent 行为 | P2 A/B 未达门 | 回退到 P1 工具面，只保留新鲜度字段 |
| 回滚到 83aa 后活锁依旧 | 回滚后 stall 循环 | 回滚目标优先选 `ilv2/P0` 的部署版本；没有这个版本时，提示用户停用自动启动 |

**止损（kill criteria）**：P1A 在两轮评审后仍有 BLOCKER，或 G1/G2 的等价问题连续两次修复无果时，停止 v2。保留 P0 成果，向用户报告并请求决策。

---

## 附录 A 代码锚点

| 位置 | 内容 |
|---|---|
| `src/java-index/builder-supervisor.ts:9-10` | `DEFAULT_WATCHDOG_INTERVAL_MS=30_000`、`DEFAULT_STALL_MS=120_000` |
| `src/java-index/builder-supervisor.ts:51-63` | 进度指纹 `phase:done:total` |
| `src/java-index/builder-supervisor.ts:177-191`、`:256-276` | 3 次尝试；`watchStall` |
| `src/index-builder/cold-build.ts:43`、`:61`、`:104` | `COLD_BUILD_BATCH_SIZE=200`；`builderParallelism`；`runSqlColdBuild` |
| `src/index-builder/cold-build.ts:223-235` | resolve 第一遍提交常量 `done` |
| `src/index-builder/cold-build.ts:274-310` | `writeKnowledgeAndEntities`，不写进度 |
| `src/index-builder/incremental.ts:244-271` | `parseChanged`，单线程 |
| `src/index-builder/incremental.ts:273-326` | `applyParsedRefresh`；事务在 304-325 |
| `src/index-builder/incremental.ts:432-460`、`:496-538` | XML 和 Java 的 content_hash 与 stat 比较 |
| `src/index-builder/incremental.ts:418`、`:501`、`:515` | `applyResources`、`stampFileTimes`、`changedResources` |
| `src/index-builder/incremental.ts:566`、`:581-589` | `applyJavaReconcile`；恢复态把全部文件标为变更 |
| `src/java-index/manifest.ts:5`、`:15`、`:62` | `IGNORED_DIRECTORY_NAMES`、`discoverMyBatisResourceFiles`、`discoverJavaFiles` |
| `src/java-index/sql/schema.ts:13`、`:18-19`、`:52` | `SCHEMA_VERSION`、`file` 表、`resource_scan` 表 |
| `src/java-index/sql/driver.ts:56` | `openIndexDb(path, options)` |
| `src/java-index/sql/sql-client.ts:120-140` | sibling 复制后在 `open()` 内等待 reconcile |
| `src/java-index/sql/sql-client.ts:229`、`:238` | `ensureFresh` 和 `reconcile` 忽略请求选项 |
| `src/java-index/sql/sql-client.ts:526-548`、`:551-556`、`:572-582` | `copySibling`（VACUUM INTO）、`existingSchemaMatches`、`retargetCopiedDb` |
| `src/java-index/java-index-client-api.ts:102` | `JavaIndexClientApi` |
| `src/repo-runtime-manager.ts:60`、`:62` | `WATCHER_READY_CAP_MS`、`PREWARM_INDEX_MS` |
| `src/repo-runtime-manager.ts:268-270` | 预算在 resolve 之后创建 |
| `src/repo-runtime-manager.ts:371-374` | 两次无界的 `flushNow` 和 `reconcileIfDirty` |
| `src/repo-runtime-manager.ts:554-582` | `reconcileIfDirty` |
| `src/repo-runtime-manager.ts:736-749`、`:842` | `startFamilyCreate`；`createEntry` 内 await `open` |
| `src/repo-runtime-manager.ts:1076-1094` | `findSiblingDb` |
| `src/repo-runtime-manager.ts:1191-1194` | `indexDbPath` 与 `JAVA_LSP_INDEX_DIR` |
| `src/repo-runtime-manager.ts:1209` | 每个 runtime 一个 `BuilderSupervisor` |
| `src/repo-change-coordinator.ts:389-395`、`:451-453` | `flushNow` 逐个 await 监听器 |
| `src/mcp-server-factory.ts:197-251` | `register` 与 `raceRequestAbort`，没有硬截止 |
| `src/runtime/request-context.ts:38` | `MAX_REQUEST_DEADLINE_MS=15000` |
| `src/repo-layout.ts:68-99` | `scanFamilySiblingIndex` |
| `src/worktree-cache-cleanup.ts:259-289` | legacy janitor，跳过点开头的目录 |
| `src/benchmark-agent-impact.ts:170`、`:263-265` | benchmark 直接使用 `SqlJavaIndexClient`；`--index-cache-dir` |
| `src/benchmark/progressive-index.ts:70` | 同上 |
| `scripts/run-isolated-validation.mjs:163-165` | full profile 只收 `scripts/*.test.mjs` |
| `scripts/run-three-repo-cold-matrix.mjs:522`、`:594-633` | 矩阵传 `--index-cache-dir`；候选会带入未跟踪文件的白名单 |
| `install-runtime.sh:439-470` | 候选 smoke 的隔离环境变量模板 |
| `daemonctl.sh:417-424` | `status`、`start`、`stop`、`restart`、`wait-ready`、`smoke`、`rollback-release`、`rollback-stdio` |
| `docs/phase-v4/v4-sprint0-runbook.md:29-31` | 三仓 golden 的冻结 SHA |

## 附录 B JSON 模板

### B.1 task-result

```json
{
  "schema": "ilv2-task-result/v1",
  "taskId": "P0-T1",
  "state": "PASS",
  "source": { "baseSha": "", "candidateSha": "", "dirty": false },
  "approvals": [{ "id": "U1", "at": "", "note": "" }],
  "red": { "status": "OBSERVED", "commands": [], "evidence": [] },
  "green": { "commands": [], "evidence": [] },
  "measurements": [{ "name": "", "value": 0, "unit": "ms", "n": 0, "evidence": "" }],
  "gates": [{ "id": "", "target": "", "observed": "", "status": "PASS" }],
  "verdict": "STALL_WINDOW_CONFIRMED",
  "changedFiles": [],
  "artifacts": [{
    "path": "/tmp/ilv2-runs/p0/stall-<run-id>/A.sqlite",
    "class": "BULK",
    "bytes": 0,
    "sha256": null,
    "consumers": ["P0-T1", "P0-G4", "P1-T1"],
    "deleteAt": "LAST_CONSUMER",
    "keptAs": [],
    "disposition": "PENDING",
    "deletedAt": null
  }],
  "host": { "load1Before": 0, "load1After": 0, "availMemGiB": 0, "freeDiskGiB": 0 },
  "remainingGaps": [],
  "deploymentPerformed": false
}
```

字段取值：
- `state`：§0.7 的状态词之一。
- `red.status`：`OBSERVED` 或 `NOT_APPLICABLE`。
- `gates[].status`：`PASS`、`FAIL` 或 `NOT_RUN`。
- `verdict`：只有复现型或判定型 Task 填写，例如 `STALL_WINDOW_CONFIRMED`、`RECOVERY_LIVELOCK_REPRODUCED`、`SYNC_BEAT_UNDELIVERABLE`；其他 Task 填 `null`。
- `artifacts[]`：本 Task 产生的每一份测试数据一条（§0.9）。
  - `class`：`BULK`、`RAW`、`INPUT` 或 `REPO`。
  - `sha256`：文件填写；目录填 `null`，`bytes` 写目录总字节数。
  - `deleteAt`：`RUN_END`、`LAST_CONSUMER`、`PHASE_CLOSEOUT`、`PROGRAM_END`；`REPO` 填 `NEVER`。
  - `keptAs`：由它提炼出的入库文件路径。
  - `disposition`：`PENDING`、`DELETED`、`ARCHIVED`（已压缩入库、原件已删）或 `COMMITTED`。由后续 Task 或 Phase 收尾删除时，回到原 task-result 更新 `disposition`、`deletedAt` 和 `keptAs`，随删除者的 commit 一起提交。

### B.2 Phase closeout

```json
{
  "schema": "ilv2-phase-closeout/v1",
  "phase": "P0",
  "baselineSha": "",
  "candidateSha": "",
  "tasks": { "P0-T0": "PASS" },
  "gates": [{ "id": "P0-G1", "status": "PASS", "evidence": "" }],
  "review": { "rounds": 1, "blocking": 0, "files": ["review-round-1.md"] },
  "kContracts": { "pass": 32, "blockedEnv": [], "delta": [] },
  "matrix": { "dir": "", "exit": 0, "summarySha256": "" },
  "testData": {
    "residualBytes": 0,
    "carriedOver": [{ "path": "/tmp/ilv2-runs/p0/stall-<run-id>/A.sqlite", "consumers": ["P1-T1"], "deleteAt": "LAST_CONSUMER" }],
    "repoEvidenceBytes": 0,
    "budgetBytes": 5242880,
    "overBudgetApproval": null
  },
  "decision": "CLOSED",
  "deploy": { "requested": false, "approval": null, "installedRelease": null }
}
```

`decision` 取 `CLOSED` 或 `REOPEN`。

- `matrix.dir` 是原始输出目录，closeout 后按 §0.9 删除；`matrix.summarySha256` 对应入库的 `gate-raw/matrix-summary-<run-id>.json`。
- `testData.residualBytes`：`/tmp/ilv2-runs/<phase>` 中不属于 `carriedOver` 的字节数，必须为 0 才能写 `CLOSED`。
- `testData.repoEvidenceBytes`：`docs/index-lifecycle-v2/<phase>/` 的总字节数。超过 `budgetBytes`（各 Phase 均为 5242880）时，`overBudgetApproval` 记录用户确认（§0.9）。

### B.3 CURRENT

```json
{
  "format": "ilv2-current/1",
  "snapshotId": "lzx81k2-9f3a1c2e",
  "file": "snap/lzx81k2-9f3a1c2e.sqlite",
  "bytes": 0,
  "buildKind": "full",
  "baseSnapshotId": null,
  "jobId": "",
  "publishedAt": "2026-10-13T00:00:00.000Z"
}
```

`buildKind` 取 `full` 或 `delta`。`delta` 时 `baseSnapshotId` 必填。

### B.4 ws.json

```json
{
  "format": "ilv2-ws/1",
  "repoRoot": "/abs/path",
  "repoHash": "",
  "familyKey": "",
  "isMainCheckout": true,
  "pinned": true,
  "createdAt": "",
  "lastRequestAt": "",
  "lastPublishAt": "",
  "lastVerifiedAt": "",
  "lastFullBytes": 0,
  "retired": [{ "snapshotId": "", "retiredAt": "" }],
  "consecutiveFailures": 0
}
```

### B.5 builder 遥测行

```json
{
  "schema": "ilv2-builder-row/v1",
  "ts": "",
  "jobId": "",
  "repoHash": "",
  "familyKey": "",
  "kind": "delta",
  "trigger": "watcher",
  "priority": 2,
  "queuedMs": 0,
  "runMs": 0,
  "phaseMs": { "scan": 0, "clone": 0, "parse": 0, "write": 0, "resolve": 0, "graph": 0, "seal": 0, "publish": 0 },
  "files": { "total": 0, "changed": 0, "added": 0, "deleted": 0, "touched": 0 },
  "baseSnapshotId": null,
  "convertedToFull": null,
  "cloned": true,
  "outcome": "published",
  "error": null,
  "attempts": 1,
  "maxBeatGapMs": 0,
  "snapshotBytes": 0
}
```

字段取值：
- `kind`：`full` 或 `delta`。
- `trigger`：`request`、`watcher`、`startup`、`prewarm`、`retry`、`maintenance` 之一。
- `outcome`：`published`、`noop`、`failed`、`stalled`、`timeout`、`cancelled` 之一。

### B.6 burst verdict

```json
{
  "schema": "ilv2-burst-verdict/v1",
  "profile": "p1",
  "distBuild": "",
  "calls": 0,
  "hardCapViolations": 0,
  "latencyMs": {
    "java_status": { "p50": 0, "p95": 0, "p99": 0 },
    "java_symbol": { "p50": 0, "p95": 0, "p99": 0 },
    "java_impact": { "p50": 0, "p95": 0, "p99": 0 }
  },
  "timeToReadyMs": { "main": 0, "worktrees": [] },
  "maxBuilderChildren": 0,
  "stallKills": 0,
  "editToVisibleMs": { "p95": 0, "n": 0 },
  "verdict": "PASS",
  "failures": []
}
```

`verdict` 取 `PASS` 或 `FAIL`。

## 附录 C 清理记录与证据归档

### C.1 2026-10-13 已删除【实测】

- 生产缓存下的 30 个 repoHash 目录，以及 `leases/`、`.ownership/`；只保留 `telemetry/`。
- `$TMPDIR`（`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/`）里 503 个没有被文档引用的临时目录。
- `/tmp/java-lsp-assessment-04058e4-*`。
- 删除前后，可用空间从 114.90 GiB 增加到 118.58 GiB，其余空间被 Time Machine 本地快照占用；当时 `df` 显示可用 119 GiB。

**其他保留项**：`/tmp/spring-head/`；release `48bad915c854-20261011T135529Z` 和 `83aa814049e5-20261011T152040Z`；`state/`；daemon 日志。

### C.2 2026-10-13 已提炼并删除：`$TMPDIR` 中被文档引用的 20 个证据目录【实测】

- 涉及 `codex-java-jdt-readiness-ua9mfgpr`、`java-lsp-runtime-integrity-cs6vd1k0`、`java-lsp-qa-release-t14dzuaq`、`java-lsp-k29-remediation-uHvCvY`、`codex-java-agent-guidance-i7fjv7b9`、`java-lsp-evidence-experiment-xsnbz3zg`、`java-lsp-k29-round2-analysis-agnt6_vn`、`java-lsp-k29-agent-analysis-f2g_mk_r`，以及 12 个 `codex-java-lsp-isolated-validation-*`。
- 原有 12,432.9 MiB、194,217 个文件，du 口径约 12.6 GiB。按 sha256 判定去向：
  - 8,126.8 MiB 是可再生的缓存和副本，包括 JDT/Gradle 私有缓存、14 份 `node_modules` 和候选 clone 的 `.git`；
  - 3,891.5 MiB 在仓库内已有逐字节相同副本；
  - 346.8 MiB 是运行期索引缓存、编译产物和测试临时文件，直接丢弃；
  - 只有 3,473 个文件（67.8 MiB）是独有的，进入归档。
- 结论记录在仓库的 [`docs/evidence-archive/tmp-distill-2026-10-13/README.md`](../evidence-archive/tmp-distill-2026-10-13/README.md)，写明各工作流的结论文档，以及历史 `$TMPDIR/...` 引用的解析规则。历史文档本身不改写。
- 原始记录只保存在本机归档根 `/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/` 的 `tmp-distill-2026-10-13/` 下，不进入仓库（其中 agent 会话记录含输入业务仓库的源码片段）：
  - `unique-raw.tar.xz`：2.6 MiB，sha256 `562c69219065d2aacc1022363eb960299f450356af17278cc32732fce31d3373`；
  - `manifest.json`：记录每个原目录全部字节的去向，以及被删除源码副本的 HEAD 和树摘要。
- 删除前做了三项核对：
  - 文档引用、但仓库里没有的 83 个文件全部进入归档；
  - 解包后 3,473 个文件逐个重算 sha256，全部一致；
  - 20 个原目录的文件数和字节数与 manifest 一致，之后才删除。
- 释放的空间暂时仍被 Time Machine 本地快照（2026-10-12 16:43 至 2026-10-13 16:43）占用，快照过期后由系统回收。

### C.3 2026-10-13 已完成：提炼仓库内未跟踪证据【实测】

用户要求提交只含结论和必要证据，GitHub 上不留原始数据。仓库是公开仓库。

- **规则**：仓库只保留两类文件：
  - 各阶段的结论 Markdown，不含 `run/` 下的逐 attempt 明细和副本目录里的文件；
  - 被仓库内 Markdown 直接链接、且不超过 1 MiB 的证据文件。原始压缩包、git bundle 和 SQLite 库即使被链接，也不保留。
- **结果**：
  - `docs/next-stage/*-evidence/` 保留 110 个文件、2.87 MiB。
  - 其余 19,621 个文件（193.2 MiB）移入本机归档 `inrepo-distill-2026-10-13/inrepo-raw.tar.xz`（29.1 MiB，sha256 `2b93265b7bb5a297d66d7ea0162f8a8de4aabd7dbb60c12a6c238c96f6906c31`）。另有 1,072 个被 `.gitignore` 隐藏的文件（10.3 MiB）移入 `inrepo-ignored-leftover.tar.xz`（0.7 MiB）。
  - 两个包都保留原仓库相对路径，同目录的 `manifest.json` 逐文件记录字节数、sha256、移出原因和引用方。
  - 两个包都已解包，并逐个重算 sha256，全部一致后才删除原件。
- **核对**：提交前扫描了全部待提交文件：
  - 没有业务仓库源码标记（`package`/`import com.lishu|hhtele|limou` 和 Mapper `namespace`）；
  - 没有密钥特征，邮箱只有 `@example.invalid`；
  - 没有二进制文件。
- **记录**：[`docs/evidence-archive/inrepo-distill-2026-10-13/README.md`](../evidence-archive/inrepo-distill-2026-10-13/README.md)。U1 的基线提交为 `ad412ceb51bc616df3700feca7d3c14ea6dc5ee0`。

# Java Intelligence V3.2 Sprint 0 测量基线与可观测性报告

> 日期：2026-08-10
> 决策：`BASELINE_RECORDED_WITH_GAPS`
> 适用范围：V3.2-01～V3.2-07b
> 正式证据：`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-lobNkQ/formal`
> Git 内收据：`docs/phase-v3/v32-sprint0-evidence-receipt.json`
> LOC 台账：`docs/phase-v3/v32-sprint0-loc-ledger.json`

## 1. 结论

Sprint 0 已经建立后续优化所需的 source-locked、三仓、标准输出、路径级 LOC 和强隔离测量底座，但它不是一次“Token 优化完成”提交。

本轮可以确认：

1. 候选代码在 detached local clone 中完成编译，并通过 `857/857` 个 dist tests 与 `71/71` 个 script tests；两份原始 TAP 与空 stderr 均由 manifest 绑定并由 verifier 复核摘要计数；
2. 三仓 18-cell、AB/BA/AB、每场景 5 次的 cold matrix 完整执行，所有 cell stderr 为 0；
3. 三仓 P95 门均通过；相对 old side，lishuedu 上升 `1.62%`、cipherlink 下降 `2.39%`、exam-parent-v3 下降 `3.00%`，均未越过 `max(old×1.25, old+50ms)` 门限；
4. standard estimatedTokens、Recall、P_read、R_taskBlocking 与 old side完全一致，没有因新增 telemetry 或投影逻辑造成可见质量回退；
5. 新的 holdout/range 门暴露了此前报告未覆盖的真实缺口：三仓 aggregate `R_read_must` 均低于 1，六个 holdout 均存在 must-read 丢失，RangeLineRecall/RangeCoordinateRecall 也均未达到 1；
6. production TypeScript 从 `31,638` 增至 `33,208 LOC`，净增 `1,570 LOC`，只比 `+5%` Sprint 上限少 11 行；所有新增规模已经逐路径归属并绑定 Sprint 6 偿还门；
7. JDT first-touch、资源、字段级 payload attribution 和真实六任务 trace 的实现与测试已经落地，但本次正式 cold matrix 禁用了 JDT，也没有生成对应的三仓 raw artifact，因此这些能力只能判定为“合同已实现并经测试”，不能声称真实收益已测量；
8. 外部 Agent 模型调用未获得费用、代码外发与 usage API 授权，V3.2-07b 保持 `BLOCKED_EXTERNAL`，实际模型 Token 与 TaskSuccess 仍为 `UNMEASURED`。

因此本轮的正确解读是：**测量体系和安全边界已建立，三仓 P95 都在硬门内，cipherlink 与 exam-parent-v3 下降而 lishuedu 上升 1.62%；standard Token 和质量结果相对 old side 没有提升，新质量门仍真实失败。Sprint 1–5 必须以这些失败为优化对象，不能把局部时延改善或测试通过包装成总体价值 PASS。**

## 2. 正式源码与运行身份

### 2.1 old/new 身份

| 字段 | old | new |
|---|---|---|
| base commit | `f85b9e56f640c7928c7ec99afaf2ddc6204751bd` | `f85b9e56f640c7928c7ec99afaf2ddc6204751bd` |
| commit tree | `9b6645deb7c306db2744f1268af1c64c7e567432` | `9b6645deb7c306db2744f1268af1c64c7e567432` |
| executable tree | `9b6645deb7c306db2744f1268af1c64c7e567432` | `e5521c2e5f226b24a163ac7e60f44da673b7258c` |
| candidate patch | — | SHA-256 `9d8458d3cc1336442c4978d99a2f77066a5cefa7ada27855ecd7d4c8a0e315fe`，550,656 bytes，59 paths |
| nested runtime inputs | — | 0；外层 detached-clone wrapper 已先把本轮选择的工作树输入物化进 candidate patch |

这里的 new 是在同一个 immutable base commit 上应用 candidate patch 后得到的 source-locked executable tree。不能只写 `f85b9e5` 并把它误称为 new 的完整身份。

### 2.2 三仓身份

| 仓库 | commit | tree | scenario SHA-256 | rows |
|---|---|---|---|---:|
| lishuedu | `db63b1a7e393edd90449eb013d7d1c4d65c366f2` | `22f0ce444e4cac484de85c8a0bf02240ad70d712` | `fba58bb3e3e77dfb37f7ded03fb2a9ff02612658b08ca48b15927d102c434c65` | 8 tuning + 2 holdout |
| cipherlink | `fa433982e92e52dd610650d1e79f2d041179b1d3` | `21a1075c7b211932a4cdb2abf2742521b1eba31f` | `e60dfebcc6cd764e6488c647793db72e098b7cf66385f8012e023fedcaf535d5` | 8 tuning + 2 holdout |
| exam-parent-v3 | `f90a0b475f7be2ed003703feecec8195bc7eb976` | `dcdb2024879686451859c64260c7e1f3a4721fa7` | `da84c560c46c7c90d6dbabea38b43b5695a7a23dcd2f608e8c6dcd63cae4f69e` | 8 tuning + 2 holdout |

三个正式输入仓库均由 runner 从只读 source repo 创建 detached local clone；manifest 记录 `clean=true` 和空 status SHA-256。

### 2.3 机器证据摘要

| Artifact | SHA-256 | Bytes |
|---|---|---:|
| `optimization-manifest.json` | `aabed32b0576b4ee1daccf2da7c1a678931b534abf110d69494764aec4ab54d6` | 107,451 |
| manifest payload | `43d6a6923c5c9f5fe684bdfccaaf39d4f9ce1d7d15b82a39e0d4e2b12f30c7e5` | — |
| `cold/run-manifest.json` | `1ebe2565cb03c13fc52a4a8801878af70b8950b161779c234b85fd897850a09f` | 9,193 |
| `cold/matrix-summary.json` | `584ddd208499bb968f65e73e5a37392b7584409fff3d4b09721a9e58001f425d` | 44,016 |
| summary input | `220394064d8ccc0a239fe41693a4b6f9be8824df8b926d78f40cbf4dcb4e491c` | — |
| `task-ledger.json` | `350e6abf5089d4b1e5c3826f249baa4676c60ce697dc919661b0b97dd5065784` | 5,053 |
| dist TAP | `5cefe7c035a0c76275263d03840f6e0513711c3e9253a92c327de70092db02eb` | 199,271 |
| scripts TAP | `fc2fcf0200f05ac81d5ae04e1ce69fea6312903f14548d0e2c6feb2c5e7876f4` | 16,125 |
| Git verification receipt | `c24453fab6381ff132b55ee9e2cfdf6cc57b73b314a238a07ee0a8b8b8ba64ee` | 1,974 |

optimization manifest 绑定 44 个 artifact；Git 内的 receipt 保存关键 hash，但临时 raw 仍是本机临时保留，不等价于不可变对象存储。最终 release 前必须把大型 raw 移入不可变存储并在 final manifest 中写 URI、SHA-256、schema 和 retention，或在 Git 内保留足以独立复验的小型 raw。

执行依赖没有链接在线 checkout 的 `node_modules`：runner 私有复制并在运行前后核对 `4,086 files / 660 directories / 7 symlinks / 58,951,103 bytes`，依赖摘要为 `0362908244299e2d61f87cb5d1037d9609abd11f8d0afae2cc89c3569ce13bc6`。该摘要证明正式执行所使用副本的字节身份，不等价于重新安装依赖。

独立复验结果另存为 `docs/phase-v3/v32-sprint0-verification-receipt.json`：它绑定被验 manifest 的 file/payload SHA、source-locked candidate tree、ledger、TAP、依赖摘要和 verifier 三态结果。该复验是 artifact/manifest integrity replay，不重跑 candidate tests 或 18-cell matrix；测试和矩阵已在正式隔离执行中完成，原始 TAP 与 raw cell 再由 replay 校验哈希和语义摘要。

运行环境固定为 Node `v22.16.0`（`/Users/luo/.nvm/versions/node/v22.16.0/bin/node`）、darwin/arm64、TypeScript `5.9.3`、tree-sitter `0.25.0`、tree-sitter-java `0.23.5`；`package.json` / `package-lock.json` SHA-256 分别为 `838eb208b19c8e672336074286c5c1739d91454ac5fce26c82f0b06014e9de02` / `5a4135dc47b8ad14e27bfff700f16ef4094dccbaf262c4fd0c51688a678f3cf7`。cold JDT 版本按合同为 `UNMEASURED`。

## 3. 强隔离合同及实际执行

### 3.1 已执行的边界

正式验证满足以下隔离约束：

- baseline/candidate code 均在临时 detached local clone 中构建；
- `node_modules` 先复制到临时私有依赖树，clone 只链接该私有副本，不链接或写回 source checkout 的依赖目录；
- 三个 Java repo 均在另一层 detached local clone 中执行；
- `HOME`、XDG cache/config/data/state、`TMPDIR`、`JAVA_LSP_CACHE_ROOT`、JDT data/log、projects config 全部指向临时私有目录；
- cold matrix 强制 `JDTLS_BIN=/usr/bin/false` 和 `JAVA_LSP_SHADOW_RANKING=0`；
- 不读取、复用、清理或关闭当前在线 MCP/LSP/JDT/JavaIndex 的 workspace、lease、cache、log 或进程；
- 不在当前 checkout 运行 `npm run build`、`npm run clean` 或裸 `node dist/...`；
- wrapper 只接受 candidate-relative Node scripts，拒绝 inline eval、require/import/loader/env-file/snapshot 注入，并从候选与真实 JDT 子进程环境移除 `NODE_OPTIONS`、`NODE_PATH`、coverage/compile-cache/warning 输出选择器；
- 输出目录位于 source checkout 外，runner 使用 canonical realpath containment 拒绝 symlink 回写；
- candidate test、matrix cell 和 artifact verifier 都在同一 source-locked candidate patch 上运行。

wrapper 不是任意命令的通用 OS sandbox：调用者仍必须使用 candidate-relative executable/script，
并把持久化输出放在 source checkout 和在线 runtime state 之外。本报告列出的正式命令满足该约定；
任何显式指向活动 checkout/cache/workspace 的自定义命令不属于有效验证。

### 3.2 一次已披露的执行偏差

正式 v5 matrix 完成后，为读取安装版本曾误执行一次隔离 wrapper 外的 `jdtls --version`。该 launcher 实际启动了带唯一 `--version` 参数的 PID 1900，并自动选择宿主 cache。只读核对后，仅向这个可精确归因的误启动 PID 发送 SIGTERM并确认退出；没有操作其他 JDT/LSP 进程，也没有删除其自动创建的 cache。该调用不参与历史 v5-v7 或本次最终 source-locked run 的任何正式 artifact、指标或 PASS 结论；本次 run 全程通过隔离 runner 执行且 cold JDT 固定为 `/usr/bin/false`。

后续规定：JDT 版本从安装 receipt/路径元数据读取；任何会执行 launcher 的验证只能通过 `run-isolated-validation.mjs` 与 `run-isolated-jdt-benchmark.mjs` 双层 wrapper。

## 4. 测试与构建结果

| Suite | 发现 | 通过 | 失败 | 运行位置 |
|---|---:|---:|---:|---|
| compiled `dist/**/*.test.js` | 857 | 857 | 0 | detached candidate clone，串行 |
| `scripts/*.test.mjs` | 71 | 71 | 0 | detached candidate clone，串行 |
| artifact/manifest integrity replay | 1 | 1 | 0 | 另一次 detached candidate clone；校验 source/ledger/TAP/dependency/raw artifact，未重跑测试或矩阵；业务结果仍为 `BASELINE_RECORDED_WITH_GAPS` |

正式 runner 会解析 TAP 中真正的 behavior subtest 数；0 个 pattern match、wrapper 自身 PASS、SKIP/TODO 都不能计为成功。

## 5. 三仓 standard cold 对比

### 5.1 性能和 Token

每仓每侧 150 attempts；deadline 为 cold-fast 2,000ms；JDT 禁用；输出为 `standard`。

| 仓库 | P50 old → new | P50 变化 | P95 old → new | P95 变化 | estimatedTokens P50 old → new |
|---|---:|---:|---:|---:|---:|
| lishuedu | 38.186 → 36.867ms | -3.46% | 254.008 → 258.128ms | +1.62% | 4,382 → 4,382 |
| cipherlink | 41.215 → 41.414ms | +0.48% | 176.245 → 172.038ms | -2.39% | 3,682 → 3,682 |
| exam-parent-v3 | 66.937 → 67.611ms | +1.01% | 187.133 → 181.519ms | -3.00% | 3,466 → 3,466 |

三仓 P95 都在门限内；Sprint 0 没有引入面向请求结果的性能算法，因此这些时延变化只作为“没有观测到 P95 门禁回退”的证据，不归因成已实现的业务性能收益。lishuedu 的 `+1.62%` P95 上升也保留披露，不用另外两仓的改善或平均值掩盖。

estimatedTokens 完全不变符合预期：Sprint 0 的主要产物是测量合同，而不是 standard payload 字段删除。真实模型 input/cached/output Token 未测，不能用 estimatedTokens 替代。

### 5.2 质量

| 仓库 | Recall old/new | P_read old/new | tuning R_read_must | holdout R_read_must | aggregate R_read_must | candidate RangeCoordinate mean/min |
|---|---:|---:|---:|---:|---:|---:|
| lishuedu | 0.7923 / 0.7923 | 0.7083 / 0.7083 | 1.0000 | 0.5000 | 0.9000 | 0.6343 / 0.1429 |
| cipherlink | 0.8158 / 0.8158 | 0.6433 / 0.6433 | 1.0000 | 0.5500 | 0.9100 | 0.8500 / 0.0000 |
| exam-parent-v3 | 0.7095 / 0.7095 | 0.5833 / 0.5833 | 1.0000 | 0.4000 | 0.8800 | 0.5525 / 0.0000 |

旧侧不支持 V2 coordinate metric，因此 old coordinate 状态是 `UNMEASURED`；候选侧 450/450 attempts 都产生了 coordinate metric。候选 coordinate 与 line 值一致，证明新坐标度量没有虚构数据，但同时证明当前 read plan 真实覆盖不足。

### 5.3 失败门和具体场景

三仓共同通过：

- `recall`
- `pRead`
- `rTaskBlocking`
- `estimatedTokens`
- `p95`
- `holdoutRecall`
- `holdoutPRead`
- `holdoutRTaskBlocking`

三仓共同失败：

- `rReadMust`
- `rangeLineRecall`
- `rangeCoordinateRecall`
- `holdoutRReadMust`

must-read failure 场景：

| 仓库 | 场景 |
|---|---|
| lishuedu | `exam-score-export-cross-module-holdout`; `paper-task-claim-iam-holdout` |
| cipherlink | `client-release-storage-presign-holdout`; `backend-operation-log-aspect-async-audit-holdout` |
| exam-parent-v3 | `exam-room-print-download-types-persistent-bundle`; `candidate-pay-order-cross-module-admission` |

这六个 holdout 没有参与既有调权，因此其失败比 tuning PASS 更能说明当前系统的泛化缺口。后续修复必须同时满足：

1. 不降低现有 tuning `R_read_must=1`；
2. 六个 holdout 的 must path 全部进入 read plan；
3. 完整覆盖精确 range，而不是通过整文件读取制造 RangeRecall=1；
4. candidate/readPlan 顺序保持 deterministic；
5. standard estimatedTokens 不增加，或通过明确的质量—成本决策获得接受。

## 6. Sprint 0 子任务状态

| Task | 状态 | 已完成证据 | 尚缺证据 |
|---|---|---|---|
| V3.2-01 immutable baseline | PARTIAL | patch/tree/repo/scenario/tests/TAP/dependency/artifact/LOC manifest 全绑定并可 replay；本轮 59 个候选路径全部进入 candidate patch | JDT version 为 `UNMEASURED`，raw 仍只在本机临时目录，最终 immutable retention 未完成 |
| V3.2-02 payload projection | PARTIAL | 单次 canonical execution 的 compact/standard/diagnostic 纯投影与字段 attribution tests | 未生成三仓 hash-bound payload attribution raw；不能报告字段级收益 |
| V3.2-03 JavaIndex RPC telemetry | PARTIAL | protocol/client/worker/router request-scoped telemetry 与 fault/deadline tests | 正式 standard cold 不保留详细 telemetry；尚无三仓 operation/fanout 热点表 |
| V3.2-04 JDT first-touch telemetry | PARTIAL | spawn/init/config/import/document/backend/caller/backend settlement 合同和单测 | cold 禁用 JDT；没有本轮 source-locked fresh/reused × 3 operations raw |
| V3.2-05 process-tree resources | PARTIAL | external sampler、in-process observer、missing-value 合同和测试 | 无三仓 hash-bound RSS/CPU/fd/retention artifact；GC/queue/event-loop 不得写 0 |
| V3.2-06 ranges/holdouts | PARTIAL | 30 rows、8+2 split、V2 1-based UTF-16 end-exclusive schema、candidate 450/450 measured | 缺真实 XML/emoji holdout与双人/双方法 attestation；所有仓 range gate 仍失败 |
| V3.2-07a local trace | PARTIAL | source blob/request/response/tool/read/replay tamper tests | 未录制三仓六个真实 source-locked任务的 hash-bound trace raw |
| V3.2-07b external Agent eval | BLOCKED_EXTERNAL | preflight/授权边界已写入 spec | 未获模型、费用、外发、usage API、seed/temperature、盲评授权 |

Sprint 0 工程底座允许进入 Sprint 1 的正确性修复，但上述 `PARTIAL` 不能在最终报告中自动升级为 PASS；它们必须在对应优化 Sprint 或 release gate 中补真实 evidence，未补则最终决策为 `MODIFY/REMOVE/BLOCKED_EXTERNAL`。

## 7. Production LOC 与偿还义务

### 7.1 总量

| 指标 | baseline | candidate | delta |
|---|---:|---:|---:|
| files | 129 | 130 | +1 |
| bytes | 1,273,211 | 1,338,710 | +65,499 |
| physical LOC | 31,638 | 33,208 | +1,570 |

- Sprint 上限：33,219；当前只剩 11 LOC 余量；
- V3.2 最终目标：≤31,638；Sprint 6 前至少需要净删除/合并 1,570 LOC，且后续业务优化新增 LOC 也必须同步偿还；
- manifest 现在要求所有 old/new 内容 hash 变化路径恰好被 ledger 覆盖一次，包括 LOC 不变的等行替换；并校验 old/new/added/removed/net 与 source inventory 一致。空 ledger、重复路径、错误总数或缺偿还门都会失败。

### 7.2 task ledger

| Task | 净增 LOC | 主要内容 | 偿还门 |
|---|---:|---|---|
| V3.2-01 | +34 | in-process isolated repo guard | V3.2-35 |
| V3.2-02 | +235 | canonical payload projection/attribution | V3.2-33 |
| V3.2-03 | +394 | JavaIndex RPC telemetry | V3.2-35 |
| V3.2-04 | +606 | JDT first-touch telemetry | V3.2-35 |
| V3.2-05 | +136 | process resource observer | V3.2-35 |
| V3.2-06 | +165 | coordinate range schema/metrics | V3.2-35 |

具体文件、old/new LOC 与删除/合并决策以 `v32-sprint0-loc-ledger.json` 为唯一台账。

## 8. 本轮真正获得的价值

Sprint 0 没有减少 Token，但获得了此前大规模改造缺少的四个底层能力：

1. **比较结果可归因。** old/new executable tree、candidate patch、runtime inputs、repo identity、scenario row set、stderr 和 artifact hash 被绑定，不能再用同一构建、漂移场景或手抄表格制造“提升”。
2. **失败不可被平均数吞掉。** tuning/holdout、aggregate/min、line/coordinate、quality/latency/Token 分门判断；六个泛化失败已成为机器门，而不是文档注脚。
3. **在线服务与验证解耦。** 后续高成本优化可以反复构建、启动真实 JDT、清理私有 cache，而不触碰用户正在使用的 LSP 服务。
4. **复杂度开始有成本。** 观测代码不再免费增长；1,570 LOC 已绑定偿还任务，最终无法证明价值的 telemetry/shadow/compat 路径必须删除。

这些能力不会直接显示在 Token P50 表里，但它们决定后续的 10%～20% 优化是否真实、是否可复现、是否以质量回退换来的。

## 9. 下一 Sprint 的硬目标

Sprint 1 必须先修公共多 anchor 合约，再做 EvidenceLedger/FrameworkPreflight：

1. relationship、persisted/live semantic、support、framework、rg、rank、read-plan 都必须按真实 `anchorId` 工作，不能把 A2+ 冒充为 A1；
2. candidate 对任一 anchor 同模块即可免 cross-module penalty；cap 采用确定性 multi-anchor 规则；
3. A1/A2 交换后，除 public V6 `target` 外，candidate/readPlan 集合与排序必须不变；
4. A2 provider failure 只降级 A2，不得丢失 A1；
5. A2 的 must/protected evidence 在紧 budget 下仍进入 read plan；
6. 单 anchor output、reasons、score、phase key、JavaIndex RPC count 保持 parity；
7. 每个实现提交继续运行三仓 isolated matrix，六个 holdout/range failure 只能改善，不能再恶化。

## 10. 复验命令

正式命令：

```bash
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --keep --profile targeted -- \
  node scripts/run-v32-optimization-matrix.mjs \
    --baseline f85b9e5 \
    --output-dir '{state}/formal' \
    --lishuedu /tmp/codex-java-v3-golden-20260809/lishuedu \
    --cipherlink /tmp/codex-java-v3-golden-20260809/cipherlink \
    --exam-parent-v3 /tmp/codex-java-v3-golden-20260809/exam-parent-v3 \
    --task-ledger /Users/luo/Documents/github/codex-java-lsp-mcp/docs/phase-v3/v32-sprint0-loc-ledger.json \
    --allow-gate-failure
```

对既有 raw 的独立复验：

```bash
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- \
  node scripts/run-v32-optimization-matrix.mjs \
    --verify /var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/codex-java-lsp-isolated-validation-lobNkQ/formal/optimization-manifest.json
```

注意：`--keep` 是为了保留正式 raw；runner 最终输出的 preserved root 才是本机证据路径。复验会在新的临时 detached clone 重放 candidate patch，并验证 hash-bound 证据；不得改成当前 checkout 的裸 build/dist 命令。

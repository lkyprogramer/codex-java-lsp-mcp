# MAC-08C / G08C

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。G08A、G08B、G08C 均 PASS，父门 G08 由此关闭。

## 源码变更

| 提交 | 内容 |
|---|---|
| `aeb6f517` | prepare 只等进入时已知的 hint（`WorkspaceTracker.confirmedThrough(epoch, seq)`）；owner 发出 `prepare` 事件；K29 driver 升到 `k29-request-path-v2`，用 AsyncLocalStorage 把每次 prepare 等待归到对应请求 |
| `eef29f20` | 三仓 runner 在删除前把 sealed tmp 改为可写；owner-window/jdt 测试改用 `ILV2_EVIDENCE_ROOT` |
| `22421aa0`、`fa645541` | 三仓 cell driver 改走 owner snapshot 路径（`indexBackend: mac1-owner`）；每个 attempt 拒绝非 FRESH 视图或另一个 snapshot，并记录视图标签 |
| `5d7b0c3a` | `SnapshotJavaIndexClient` 增加按 snapshot 的 file bundle LRU（上限 16,384 facts，约 45 MiB） |
| `5c5904d7` | 验证命令记录改为原子写 |
| `61dcbe89` | 修评审 P1：缓存命中在 fetch await 之前取出 |

`5d7b0c3a` 的起因：`fa645541` 上的严格比例 FAIL（cipherlink 1.373，exam-parent-v3 1.397）。原因是 `queryFiles` 把整份 bundle 经 query-worker IPC 结构化克隆，单份最大 3.9 MiB，而 baseline 在进程内直接读取。

## 判定口径（用户决定“拆分判定”，2026-10-18）

K29 with-updates 行的判定方式：

- 按服务时间判：总延迟扣除该请求自己的 prepare 等待后，p95 ≤ 150 ms。
- prepare 等待单独判：p95 ≤ 1000 ms。
- 静态步骤仍按请求 p95 ≤ 150 ms，所有步骤 event-loop p95 ≤ 20 ms。

注意：

- 按 v1 口径（整请求 p95 ≤ 150 ms），本源码 with-updates 为 857.8 ms，不通过。K29 PASS 不代表编辑期间请求在 150 ms 内。
- prepare ≤ 1000 ms 实际由 cap 保证，真正的证据是 100/100 outcome 为 `covered`。

## 验证（源码 `0d952afc…` = HEAD `61dcbe89`）

| 项 | 结果 |
|---|---|
| env-probe | READY |
| final-g08c | 136/136 |
| regression-g08c-dist | 1508/1508 |
| regression-g08c-scripts | 570/570 |
| mutation 矩阵（dev 档） | 15/15 |
| 独立评审 | PASS，无 open finding |
| 资源与归档 closeout | PASS（归档 484 个文件），并经独立 closeout 评审 PASS |

以上无 fail、skip、cancel。

第一次 `--finish` 已归档并删除 raw/，之后在 tmp 下 5 个 0555 的 sealed snapshot 目录上报 EACCES（MAC-03B 遇到过同样问题）。处理方式：从刚通过物理校验的归档恢复 raw/，把这 5 个目录改为可写，再重跑 `--finish`。独立 closeout 评审对照 closeout 前写成的 validation-index，核对了恢复内容中 87 个能独立钉住的文件（stdout/stderr、命令记录、result 身份），全部一致；另外 397 个文件只由恢复后的 manifest 和运行窗口内的 mtime 约束。

K29（`k29-request-path-v2`）结果如下，均 PASS：

| 步骤 | 请求 p95 | 其他 |
|---|---|---|
| 静态 c=1 / 5 / 20 | 14.4 / 29.1 / 79.8 ms | event-loop p95 ≤ 2.19 ms，errors 0 |
| with-updates c=20 | 857.8 ms | service p95 77.6 ms，prepare p95 797.8 ms，100/100 covered |

三仓严格矩阵（run root `runs/mac-08/20261018T162753Z`，摘要见 run root 的 `g08c-three-repo.json`）：

- **基线：** `9b3a1104`。
- **采样：** 3 轮 × 5 次，每仓每侧 150 个 attempt。
- **候选全套件：** dist 1508/1508，scripts 570/570。
- **严格比例**（`ilv2-p95-strict-ratio-v1`，无 +50 ms 宽限）：

  | 仓库 | p95 old → new | 比值 |
  |---|---|---|
  | lishuedu | 271.9 → 296.0 ms | 1.089 |
  | cipherlink | 217.2 → 206.7 ms | 0.952 |
  | exam-parent-v3 | 286.5 → 324.2 ms | 1.132 |

- **配对质量：** delta 全为 0。
- **视图：** 450/450 个 new attempt 都在 FRESH 视图上，每个 cell 只用一个 snapshot。

## 必须同时知道的

**verifier 输出 FAIL、exit 1。**
- 原因只有绝对 1.0 地板：rReadMust、holdoutRReadMust（minReadMust === 1）以及 RangeLine/CoordinateRecall。
- baseline 在这几项上逐位相同地失败：minReadMust 0.5/0.5/0.4，must-failure 场景相同。
- G08C 依据卡片的“三仓质量无回退”（配对门）加严格比例判 PASS，这是独立评审的裁定。
- 这偏离了 runbook “非零退出阻塞通过”的规则，与 v5r 先例相同。G14 及以后不豁免这些地板。

**首次 attempt 的表现**（只看首次，每侧 n=30）：

| 仓库 | p95 比 | p50 比 |
|---|---|---|
| lishuedu | 1.123 | 1.062 |
| cipherlink | 1.263 | 1.143 |
| exam-parent-v3 | 1.023 | 1.217 |

- 合并 p95 能过，部分是因为同一 snapshot 上的重复请求复用了已缓存的 bundle。
- 每次 publish 都会换新的 snapshot client，所以编辑期间的请求看到的是首次 attempt 的表现。

**其他：**
- **缓存上限：** 按 fact 计数而不是字节，owner 最坏约 360 MiB（MAC-11 在 G11 测 RSS）。
- **publish 停顿：** 期间 event-loop max 376 ms（P2，MAC-11）。
- **并发淘汰测试的不足：** 没有证明淘汰方在首个调用完成前就已结束（P3，MAC-14）。
- **矩阵执行偏差：** 按 §6.3 模板执行，额外 export 了 `ILV2_TOOLCHAINS`（§5.1 的可选行）。

## 父门 G08 的继承项

前序门留给 MAC-08 的 6 项，独立评审在 `61dcbe89` 上逐项判为 CLOSED：
- G03B：tracker → builder 接线；
- G06C：调用链切换与 BuilderSupervisor 删除；
- G07：生产集成；
- G07：readSnapshotContent 无 lease；
- G07：acquireBound 未跟踪分支；
- G07：BuildPlan 携带 builder capture id。

tracker 与 builder census 不交叉核对，这一点仍是 G08B 记录的 P3（MAC-11）。

## 历史 run root

以下 run root 均有 `not-composed.json`，不参与组合：

| run root | 原因 |
|---|---|
| `mac-08/20261018T022250Z` | K29 v1 FAIL |
| `mac-08c/20261018T100737Z` | task-id 错误 |
| `101145Z` | 候选测试 ENOENT，fixture 挂起 3 小时 |
| `133838Z`、`140516Z` | 全部通过，但被后续 harness 修复取代 |
| `135045Z` | 缺 `ILV2_TOOLCHAINS` |
| `141730Z` | cell driver 还在旧 reconcile 路径 |
| `143602Z` | 主动停止 |
| `143815Z` | 严格比例 FAIL |
| `152419Z` | 命令记录被截断 |
| `153735Z`、`160405Z` | 在 `5c5904d7` 上通过，但独立评审 FAIL（缓存 P1） |

除注明外，以上 run root 都在 `mac-08/` 下。

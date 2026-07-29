# Phase 3 — Iteration C JavaIndex V2 性能、质量和快照验证报告

验证日期：2026-07-29
验证对象：可执行的 `f4b814c1ad26` V1 基线与 Task 22/23 最终工作树；Node `v22.16.0`。

## 1. 最终结论

**Task 23 已关闭，Iteration C 判定为通过。**

- `lishuedu` 的 repository read-plan 回归已修复，两个 persistence must 均进入计划，三仓 `R_read_must=1.000000`。
- 三个真实仓已按 old/new 交错顺序完成三轮、每轮五次的同提交 steady-P95 矩阵；三仓中位数均满足 `P95_new ≤ 1.10 × P95_old`。
- own-snapshot OPEN 已把完整 manifest 内容验证移出同步启动路径；三仓独立进程 startup P95 均低于 `500ms`。
- sibling seed 只解析实际 diff；合成与真实 A/B 的解析占比分别为 `.39%` 与 `.00%`，均低于 `20%`。
- lishuedu candidate recall 已恢复到 Iteration A/Task 22 V2 基线 `.821984`，没有以降低召回换取 P95。

所有最终原始产物位于 [task23-final](../../artifacts/v3-phase3/task23-final)。此前失败或中间试跑产物仅保留在本地审计，不参与本结论。

## 2. 变更边界与反定制检查

本轮没有读取仓名、golden 文件名或任务关键词来决定候选、排序或性能路径。

- repository read-plan 只根据 repository anchor 的类型族、焦点模块、来源集和实体/mapper/持久化路径保护 must；并以 lishuedu 回归覆盖其语义。
- deferred-test 候选仅以 `sourceSet=test` 与 JavaIndex 已验证的 `typeReference` 静态证据保护；它仍不占 foreground read-plan 槽位。
- 多类型查询合批只保留调用方给出的类型顺序、去重和文件身份；import 图的轻量查询只传输类型摘要，结构评分仍按需加载完整事实。
- snapshot 状态仅反映真实的后台持久化是否仍在进行，防止 benchmark 将 full sweep 的快照写入误计入 steady 请求。

因此，质量和 P95 改善来自通用的索引查询、候选证据和快照生命周期修正；三仓均以相同可执行程序、独立缓存和同一测量协议验证。

## 3. 三仓质量门禁

来源：[最终交错矩阵](../../artifacts/v3-phase3/task23-final/interleaved-matrix-final)。新侧每轮均为 `cold-nolsp`、balanced、五次请求样本。

| 仓库（业务提交） | recall | `P_read` | `R_read_must` | 判定 |
|---|---:|---:|---:|---|
| lishuedu (`73971f05b895`) | .821984 | .833333 | **1.000000** | 等于 V2 基线 |
| cipherlink (`fa433982e92e`) | .826984 | .700000 | **1.000000** | 等于 V2 基线 |
| exam-parent-v3 (`380c05fad9d3`) | .900000 | .600000 | **1.000000** | 等于 V2 基线 |

lishuedu 的 `report-reusable-zip` 已读取 `ReportBatchExportTaskDO` 与 `ReportBatchExportTaskMapper` 两个 persistence must；候选质量回归不存在。

## 4. Full re-link 后的 P95 配对矩阵

来源：[最终 18 份矩阵产物](../../artifacts/v3-phase3/task23-final/interleaved-matrix-final)。每轮使用独立缓存和同一业务仓提交；轮次顺序为 old/new、new/old、old/new。旧侧是 `f4b814c1ad26` V1 可执行基线，包含仅用于隔离缓存与 full-relink preflight 的 benchmark harness seam，不改变 router 产品行为。

| 仓库 | 旧侧三轮 P95 (ms) | 新侧三轮 P95 (ms) | 旧 → 新中位 P95 (ms) | 比值 | `≤1.10×` |
|---|---:|---:|---:|---:|---|
| lishuedu | 270.644, 241.648, 246.198 | 155.293, 157.173, 165.134 | 246.198 → 157.173 | .6384× | PASS |
| cipherlink | 89.267, 90.901, 110.560 | 55.001, 50.017, 56.727 | 90.901 → 55.001 | .6051× | PASS |
| exam-parent-v3 | 187.109, 182.078, 226.018 | 62.002, 64.062, 63.272 | 187.109 → 63.272 | .3382× | PASS |

## 5. 快照启动与持久化验证

独立进程样本见 [snapshot-startup-final.jsonl](../../artifacts/v3-phase3/task23-final/snapshot-startup-final.jsonl)。每仓五次；只计 OPEN 返回时间。安全语义是先以 `BUILDING`、零事实覆盖返回，后台完成增量 manifest 验证后再提升覆盖状态。

| 仓库 | 5 次 startup 样本 (ms) | P95 (ms) | 门禁 `≤500ms` |
|---|---:|---:|---|
| lishuedu | 185.149, 101.160, 96.676, 96.532, 103.084 | 185.149 | PASS |
| cipherlink | 66.256, 67.867, 70.077, 74.224, 66.801 | 74.224 | PASS |
| exam-parent-v3 | 74.316, 70.638, 80.466, 72.492, 73.575 | 80.466 | PASS |

三仓 snapshot-hit 复验见 [lishuedu](../../artifacts/v3-phase3/task23-final/lishuedu/snapshot-hit-final.json)、[cipherlink](../../artifacts/v3-phase3/task23-final/cipherlink/snapshot-hit-final.json) 和 [exam-parent-v3](../../artifacts/v3-phase3/task23-final/exam-parent-v3/snapshot-hit-final.json)：验证完成后均为 `COMPLETE`，且质量门禁保持通过。

## 6. Sibling seed 与 JavaIndex 微基准

来源：[java-index-microbenchmark-final.json](../../artifacts/v3-phase3/task23-final/java-index-microbenchmark-final.json)。

| 场景 | full parsed | reused | diff parsed | diff / full | 事实等价 |
|---|---:|---:|---:|---:|---|
| 512 文件合成（2 个 target diff） | 512 | 510 | 2 | .39% | PASS |
| cipherlink 真实同内容 worktree | 629 | 629 | 0 | .00% | PASS |

同一微基准还验证：snapshot load P95 `85.999ms`（`≤500ms`）、full / incremental refresh P95 `6.217 / 7.224ms`（各 `≤50ms`）、type / implementer / caller lookup P95 `0.131 / 0.139 / 0.966ms`（各 `≤5ms`）、sweep event-loop P99 `3.453ms`（`≤20ms`）；`incrementalEqualsFull=true`，六项 mutation 的 `staleCount=0`。

## 7. 最终回归

使用直接 Node 二进制执行 TypeScript 编译和串行 Node 全量回归：

```bash
/Users/luo/.nvm/versions/node/v22.16.0/bin/node node_modules/typescript/bin/tsc -p tsconfig.json
/Users/luo/.nvm/versions/node/v22.16.0/bin/node --test --test-concurrency=1 dist/**/*.test.js
```

结果：TypeScript `0 error`；Node 全量测试 **367 passed, 0 failed, 0 skipped**（51.652s）。

没有未关闭的 Task 23 项。

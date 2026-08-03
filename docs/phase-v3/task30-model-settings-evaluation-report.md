# Task 30 模型设置评测与最终交付报告

日期：2026-08-02  
评测：`task30-model-comparison-20260802`  
冻结 seed：`b6270c52372a6a3962e5972114bd6ba6b38392e4`  
分支：`codex/java-intelligence-v3`

## 当前结论：conditional/failed

Task 30 当前不能标记完成。两次重复分类共 24 个 completed run，另有 2 个完整集成 run；没有用 `started` 或 `interrupted` 充数。最终实现仍保留在当前工作树，未提交、未推送，但首轮 seed-vs-finalist 矩阵只通过了绝对 `300 ms` P95 门，未通过要求的 paired quality/latency 门，因此当前状态为 `conditional/failed`，必须修复后重新跑全量与 AB/BA/AB 矩阵。

分类阶段 Luna 的加权平均分较高，但两模型的分类质量没有达到等价门：Terra−Luna 的 12 个配对质量差为 `-8.25`，精确 bootstrap 95% 区间为 `[-21.75, 2.00]`，未完全落在 `[-5, +5]`。Terra 仍是当前候选实现，但不得在 paired matrix 修复前宣告最终完成。

## 冻结与评测完整性

- public prompt SHA-256：`cb3d8428f500204160036a10b881f2fee2bb8ac2fe8433163ea6a1640d45c4f8`
- hidden spec SHA-256：`823e0ee29696787537653b0e624928e229d447c1148265029c6e1082385f8d68`
- 评测 profile：Luna `gpt-5.6-luna/max`；Terra `gpt-5.6-terra/xhigh`。
- 分类顺序：t1=AB、t2=BA；独立 worktree、`fork_turns=none`，候选之间未共享产物。
- 全程 `JDTLS_BIN=/usr/bin/false`、`JAVA_LSP_FILE_WATCH=0`；JPA 未注册，Task 31/32 未改生产实现。

## 分类评分

分数按冻结 rubric 的质量 70、效率 30 复核；最终集成的真实 P1 缺陷按 hard-failure cap 记录。

| 类别 | 权重 | Luna 平均分 | Terra 平均分 | Luna 质量 | Terra 质量 |
|---|---:|---:|---:|---:|---:|
| exploration | 8% | 85.0 | 84.5 | 90.0 | 90.0 |
| design | 10% | 87.0 | 70.0 | 92.0 | 71.0 |
| diagnosis | 12% | 86.5 | 84.0 | 94.0 | 89.0 |
| planner-core | 20% | 83.5 | 87.5 | 87.5 | 91.5 |
| index-ranges | 20% | 88.0 | 90.0 | 91.5 | 93.0 |
| review-evidence | 10% | 84.0 | 61.0 | 89.0 | 60.0 |
| final-integration | 20% | 49.0 | 49.0 | 45.0 | 55.0 |

按上述原始分数计算的 rubric 加权总分为 Luna `78.38`、Terra `75.24`。该数字不能替代完整实现选择：两次集成都曾触发 hard-failure cap，Terra 的越界问题已修复，而 Luna 的 CRLF/终止换行 byte undercount 未被选用。

## 复现缺陷与 TDD 修复

1. Terra 集成候选的 `RouterJavaIndex.queryReadRanges()` 会把仓库外路径转发给 worker。修复在 `src/java-index/router-java-index.ts` 统一先做仓库路径规范化，仓库外请求在 forwarding 前拒绝；`src/java-index/java-index-client.test.ts` 增加了“拒绝且不转发”的回归测试。
2. 最终三仓 smoke 暴露 repository 场景中精确实现被多 range mapper/DO 竞争者挤出 6 文件读预算。根因是 protected-core 内 evidence tier 只按低幅度 utility/byte 比值排序，粗粒度 mapper 可在 byte 竞争中压过 type-graph implementation。修复把 resolved implementation 提升到独立保护层级，并增加“bounded mapper tiers 不得驱逐 resolved implementation”的红绿回归；同时保留 protected core、bucket quota release、reverse-import、focused type-reference 和 repository persistence family 规则。
3. 集成实现还覆盖 worker 侧原始 UTF-8 source slice 计数、CRLF/终止换行、Java/XML/fallback range、极端方法首尾窗口、`maxFiles×4` shortlist、单次批量 IPC、anchor overflow evidence gap 及 benchmark bytes/utilization 指标。

## 最终验证

### 本地测试

已运行并通过：

- `JDTLS_BIN=/usr/bin/false JAVA_LSP_FILE_WATCH=0 node node_modules/.bin/tsc -p tsconfig.json`
- read-plan 定向测试：最终修复后 `14/14`
- 全量直接 Node 测试：`622/622`，0 failed、0 skipped
- `git diff --check`

此前路由边界修复的定向集合为 `25/25`；最终全量结果以当前工作树的 622 项为准。

### 三仓 cold-nolsp 交错矩阵

首轮矩阵共 18 格、每格 5 次、合计 480 个 scenario attempts，执行顺序严格为 AB/BA/AB。原始 JSON 和 stderr 保存在 [`matrix-final`](../../artifacts/model-eval/task30-20260802/matrix-final/README.md)。该轮证据已明确写回失败状态，原因是之前错误地只检查了绝对 `300 ms` P95：

- 18/18 格、480/480 attempts 有完整 JSON；18 个 stderr 全空。
- 所有 cell、所有 attempt 的 `R_read_must=1.0000`。
- paired gate 失败：cipherlink 的 `P_read` 为 `0.6667 → 0.6333`，lishuedu 为 `0.7222 → 0.6667`，exam-parent-v3 为 `0.6667 → 0.4667`，均低于 `seed - 0.02`；lishuedu recall 为 `0.8260 → 0.7843`；lishuedu worst P95 为 `207.67 → 240.34 ms`，比值 `1.157x > 1.10x`。
- 每次 attempt 的 read-plan 文件数最大 6、读取 byte 最大 12,279，配置上限 14,336；selected 最大 per-attempt budget utilization `0.8565`（cell-total 最大 `0.5323`），无 anchor overflow。
- aggregate request P95 最大 `240.34 ms`，虽低于绝对 cold-nolsp `300 ms` 门，但不能替代 paired `1.10x` 门；estimated-token P95 最大 `11,120`。
- 详细 precision/recall/P_read/P95 对照见 matrix-final README 和 raw JSON；下一步必须在修复后重新生成完整矩阵。

## 交付物与状态

- 结构化台账：[`run-index.json`](../../artifacts/model-eval/task30-20260802/run-index.json)
- 24 分类答卷与评分：[`classification-runs.md`](../../artifacts/model-eval/task30-20260802/classification-runs.md)
- 两个完整集成记录：[`final-integration-a-luna.md`](../../artifacts/model-eval/task30-20260802/final-integration-a-luna.md)、[`final-integration-b-terra.md`](../../artifacts/model-eval/task30-20260802/final-integration-b-terra.md)
- 最终矩阵摘要：[`matrix-final/README.md`](../../artifacts/model-eval/task30-20260802/matrix-final/README.md)、[`matrix-final/summary.json`](../../artifacts/model-eval/task30-20260802/matrix-final/summary.json)
- workflow state 已改为 paired-gate failure/conditional；当前 HEAD 仍为冻结 seed，Task 30 变更保持未提交。

已知限制：本报告不声称通过未提供的隐藏测试；矩阵是 cold-nolsp 真实仓三仓门，不替代 warm-required 或生产 JDTLS 性能评测。

# V5R 战役 P：`JAVA_LSP_SPAN_PACKING=on`（2026-08-20）

同树 env A/B：`--comparison-policy env-locked-same-tree --candidate-env JAVA_LSP_SPAN_PACKING=on --runs 5`。bundle 保持 off。

## 判定

| 轴 | 结果 |
|---|---|
| 文件集 / recall / pRead / rReadMust | **GO**（逐位相同） |
| `readPlanBytes` / ranges / readingP50 | **相同**（没有可观测的 overlap 合并） |
| RangeLineRecall | 相同（含 holdout；`backend-operation-log` 近邻 +1 **未出现**） |
| 配对 p95 | **GO**（1.025 / 1.034 / 1.013） |
| 作为「压字节」优化 | **HOLD**（三仓 first-plan 上 packing 是空操作） |

**战役结论：identity-safe，无回归；不改默认。** 冻结 golden 的 first-plan 没有可合并的重叠/相邻 span，所以 `on` 与 `off` 在正式矩阵上看不见收益。保持 `JAVA_LSP_SPAN_PACKING=off`。

绝对 1.0 residual 仍 FAIL（不是本场杀死条件）。`passed=false` 只剩 rReadMust / holdoutRReadMust / RangeLineRecall。

## 身份

树 `06f1bf3`，executableTree `645add299482…`（两边相同）。load **9.69 < 20**。

## 产物

目录：`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/grok-goal-a7d58b79e146/implementer/v5r-flag-campaign-p-20260820/`

| 文件 | SHA-256 |
|---|---|
| `matrix-summary.json` | `5c436bb2a1e9a23bff53f37d43c569b80222e34b7c231221321ed13280bd0afd` |
| `run-manifest.json` | `cd81cda6e1cfd3654aa45965f7dd7f4623365265f0fad5220d8903235b0affc2` |
| `candidate.patch` | `5a82a8e876ca2689b98e2b063d801a9ace70ef8ee93018c05f787d454891628b` |

入库摘要：`docs/phase-v5r/v5r-flag-campaign-p-20260820-summary.json`。

## 总表（r1 totals 抽查）

| 仓 | recall | RangeLineRecall | readPlanBytes | ranges | tokens P50 | p95Ratio |
|---|---|---|---|---|---|---|
| lishuedu | 0.7986 = | 0.842 = | 8597.3 = | 8 = | 4683 = | 1.025 |
| cipherlink | 0.8390 = | 0.875 = | 7235.5 = | 8.6 = | 4443 = | 1.034 |
| exam-parent-v3 | 0.6970 = | 0.853 = | 7428.7 = | 8.7 = | 3890 = | 1.013 |

## 怎么读

1. packing `on` **没有打坏** first-plan。
2. 也 **没有** 在这套 golden 上压字节或抬 range。优化若存在，不在 first-plan 三仓，而在有 overlap 的续读 / 别的仓库。
3. 下一场：**战役 C** `@2calls` continuation（`--candidate-continue in-pool-fifo`）。这是 V5R 唯一还没在正式三仓上量过的质量上限。

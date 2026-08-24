# V5R 战役 B：`JAVA_LSP_RELATIONSHIP_BUNDLE=on`（2026-08-20）

同树 env A/B：`--comparison-policy env-locked-same-tree --candidate-env JAVA_LSP_RELATIONSHIP_BUNDLE=on --diagnostic-rpc-sidecar --runs 5`。  
old = 默认 off；new = bundle on。cold-nolsp。

## 判定

| 轴 | 结果 |
|---|---|
| first-plan 质量 identity | **GO**（三仓 recall/pRead/rReadMust/range/holdout/tokens 逐位相同） |
| 配对 p95 ≤ 1.25 | **FAIL**（exam-parent-v3 **1.349**，阈值 1.25 / 293.7ms，new 317ms） |
| RPC sidecar（≥30% RPC 下降且受影响 P95 ≥20% 改善） | **RPC_FAIL**（`REJECT_RPC_COUNT_AND_P95`） |
| 绝对 1.0 residual | 仍 FAIL（不是本场杀死条件） |

**战役结论：FAIL。保持 `JAVA_LSP_RELATIONSHIP_BUNDLE=off`。不叠刀、不改默认。**  
质量没回退，但延迟优化没兑现：RPC 数没降（10632→10662，**−0.28%**），diagnostic P95 还变差（275→331ms，improvement **−20.3%**）。

## 身份

| 侧 | 身份 |
|---|---|
| 树 | `6cd5b6a`；executableTree `e4aaf9660e28…`（两边相同） |
| old env | 默认 |
| new env | `JAVA_LSP_RELATIONSHIP_BUNDLE=on` |
| 三仓 golden | 与战役 T / 20260820 相同 HEAD |

主机 load **11.99 < 20**。候选测试 1071+176 fail 0。sidecar payload SHA-256 `e1dea6f956b708c9c71a409b89bcf3f3756b37998b86e81dc7ad7895f90df2e4`。

## 产物

目录：`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/grok-goal-a7d58b79e146/implementer/v5r-flag-campaign-b-20260820/`

| 文件 | SHA-256 |
|---|---|
| `matrix-summary.json` | `38e94ecc5b7517cb4b3af1d473f24d1dd457c62154b9d759a43cf2581fd3d589` |
| `run-manifest.json` | `626abf7292a6599fa56110d25e71ec0affc820aa081d6e28a3a64be6f977a427` |
| `candidate.patch` | `5a82a8e876ca2689b98e2b063d801a9ace70ef8ee93018c05f787d454891628b` |

入库摘要：`docs/phase-v5r/v5r-flag-campaign-b-20260820-summary.json`。raw cells 与 sidecar 不入库。

## 总表

| 仓 | recall | pRead | rReadMust | tokens P50 | p95 old→new | p95Ratio | 配对 p95 |
|---|---|---|---|---|---|---|---|
| lishuedu | 0.7986 = | 0.7217 = | 0.925 | 4683 = | 226→261 | 1.156 | PASS |
| cipherlink | 0.8390 = | 0.6633 = | 0.910 | 4443 = | 196→233 | 1.189 | PASS |
| exam-parent-v3 | 0.6970 = | 0.6000 = | 0.880 | 3890 = | 235→317 | **1.349** | **FAIL** |

RangeLineRecall / holdout rReadMust / must-fail 场景与默认完全相同。

## 怎么读

1. bundle `on` 与 legacy `factsForFiles` 在正式三仓 first-plan 上 **选择 identity 成立**——作为正确性没把排名打坏。
2. 作为延迟/RPC 优化 **未兑现**：RPC 几乎没少，exam 标准门 p95 超 1.25，sidecar 门双杀。
3. 保持 off。战役 P（span packing）仍对 **默认路径** 单独打，不叠 bundle。

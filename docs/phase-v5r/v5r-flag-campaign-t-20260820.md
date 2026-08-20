# V5R 战役 T：`JAVA_LSP_FRONTIER_SHADOW=off`（2026-08-20）

同树 env A/B：`scripts/run-three-repo-cold-matrix.mjs --runs 5 --comparison-policy env-locked-same-tree`。  
old = 当前可执行树、默认 shadow；new = 同一棵树、`JAVA_LSP_FRONTIER_SHADOW=off`。cold-nolsp，`JDTLS_BIN=/usr/bin/false`。

## 判定

| 轴 | 结果 |
|---|---|
| 测量链 | **GO**（env-locked-same-tree 第一次正式跑通） |
| first-plan 质量 identity | **GO**（三仓 recall/pRead/rReadMust/range/holdout/tokens **逐位相同**） |
| 「+21 token 来自 frontier shadow」 | **HOLD / 证伪**（standard  verbosity 下 `rawSearchPayload` 不变；`frontierShadow` 本来就不进 standard 载荷） |
| 绝对 1.0 residual | 仍 FAIL（不是本场杀死条件） |

配对质量门（相对默认 old）：recall / pRead / rTaskBlocking / estimatedTokens / p95 / holdout 同名指标全过。`passed=false` 只剩 rReadMust / holdoutRReadMust / RangeLineRecall = 1.0 residual。独立 verifier **exit 1**。

## 身份

| 侧 | 身份 |
|---|---|
| old / new 树 | `4c913f7` + Wave 0 工作区 patch；executableTree `7b4dd27127c344c56c1d6f6633572678cd9c6089`（两边相同） |
| old env | 默认（fingerprint `e824adc3…`） |
| new env | `JAVA_LSP_FRONTIER_SHADOW=off`（fingerprint `c9e7c4a6…`） |
| 三仓 golden | 与 20260820 默认矩阵相同 HEAD / 冻结场景 |

主机：1 分钟 load **13.70 < 20**（必须执行）。候选隔离测试 dist **1071/1071**、scripts **176/176**。

## 产物（checkout 外）

目录：`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/grok-goal-a7d58b79e146/implementer/v5r-flag-campaign-t-20260820/`

| 文件 | SHA-256 |
|---|---|
| `matrix-summary.json` | `3e5dae599f8a4d91b55c2efe71ad788ad40fd96a95d1a3bbaa31ca086428912c` |
| `run-manifest.json` | `adfe53710d5332fa49f835c87e0ffc0804a53d9ed88dedd8d6922e54947fa6dc` |
| `candidate.patch` | `78a6bec540b645b39bb6dbcadde108ae494bb813acae799579abe89b5a3b8a2a` |

入库摘要副本：`docs/phase-v5r/v5r-flag-campaign-t-20260820-summary.json`（同上 SHA-256）。18 raw cell 不入库。

## 总表（new=shadow off vs old=默认 shadow）

| 仓 | recall | pRead | rReadMust | RangeLineRecall | holdout rReadMust | tokens P50 | p95Ratio |
|---|---|---|---|---|---|---|---|
| lishuedu | 0.7986 = 0.7986 | 0.7217 = 0.7217 | 0.925 | 0.842 = 0.842 | 0.625 = 0.625 | 4683 = 4683 | 1.134 |
| cipherlink | 0.8390 = 0.8390 | 0.6633 = 0.6633 | 0.910 | 0.875 = 0.875 | 0.550 = 0.550 | 4443 = 4443 | 1.047 |
| exam-parent-v3 | 0.6970 = 0.6970 | 0.6000 = 0.6000 | 0.880 | 0.853 = 0.853 | 0.400 = 0.400 | 3890 = 3890 | 0.991 |

lishuedu-r1 attempt[0]：`rawSearchPayload` old=new=9533，`readingPayload`=7187，`estimatedTokens`=4180。与 20260820 默认矩阵 new 格相同，**没有**相对 V4-final 的 −21。

## 怎么读

1. 默认 `JAVA_LSP_FRONTIER_SHADOW=shadow` **不改 first-plan 选择**。关掉它，三仓质量与 token 都不动。这是 identity 的正式证据，不是「优化没效果」的反证。
2. V4-final → V5R 默认的 **+21 token / +85B search payload 不是 frontier shadow**。standard 路径不序列化 `metrics.readPlan.frontierShadow`（见 `frontier.test.ts`）。+85B 来源未定位；战役 B/P 的成本真源继续用 `readPlanBytes` / `readingPayload`，不要用与 V4-final 的 estimatedTokens 差当 packing 收益。
3. 下一场：**战役 B** `JAVA_LSP_RELATIONSHIP_BUNDLE=on` + `--diagnostic-rpc-sidecar`。不叠 packing / continue。

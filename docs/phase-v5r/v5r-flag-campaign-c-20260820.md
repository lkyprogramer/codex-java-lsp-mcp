# V5R 战役 C：`@2calls` in-pool-fifo continuation（2026-08-20）

同树 treatment A/B：`--comparison-policy env-locked-same-tree --candidate-continue in-pool-fifo --runs 5`。  
old = 单枪 analyze；new = analyze + 按 frontier 顺序消费 in-pool 单元（8KiB 帽）。质量字段是 **union**。

## 判定

| 轴 | 结果 |
|---|---|
| continue 是否真打了 | **是**（cipherlink/exam 150/150 consumed；lishuedu 120/150，30 次 `NO_CONSUMABLE_FRONTIER`） |
| call1 / union `rReadMust` | **相同**（0.925 / 0.910 / 0.880） |
| holdout `rReadMust` | **不变**（0.625 / 0.550 / 0.400） |
| must-fail 场景 | **不变** |
| 配对 pRead | **FAIL**（0.722→0.599 / 0.663→0.589 / 0.600→0.484） |
| `rTaskBlocking` | 升（0.572→0.611 / 0.452→0.583 / 0.482→0.573）——fifo 吃到了 blocking 文件，不是 must |
| tokens P50 | 升 +244 / +732 / +869（两枪，预期） |
| 绝对 1.0 | 仍 FAIL |

**战役结论：FAIL。** 续读跑通了，但 fifo 先吃的 in-pool 单元 **不是** holdout 缺口文件。Phase 4 oracle（0.525→0.825）假设能点到被预算挤出的 **golden**；通用 fifo 在 8KiB 帽内把预算花在别的 frontier 项上。pRead 被稀释。不改默认、不开放 `QUERY_CALLERS`、不按 scene-id 特判。禁止战役 S。

## 身份

树 `27a79fa`。new benchArgs `--retrieval-enabled --continue-policy in-pool-fifo`。load **8.52 < 20**。

## 产物

目录：`/var/folders/yt/10k_hqkn30x18d7lbn28_gnc0000gn/T/grok-goal-a7d58b79e146/implementer/v5r-flag-campaign-c-20260820/`

| 文件 | SHA-256 |
|---|---|
| `matrix-summary.json` | `f3e000b65d9145b9324c3f6389159030035ef06ed3499ed4de4e1d031c60ebfb` |
| `run-manifest.json` | `ab418d17c46c0539109c8b824569b25cd695e4c592b3c9a610edcf02aa6bcfb5` |
| `candidate.patch` | `5a82a8e876ca2689b98e2b063d801a9ace70ef8ee93018c05f787d454891628b` |

入库摘要：`docs/phase-v5r/v5r-flag-campaign-c-20260820-summary.json`。

## 总表（union vs 单枪 old）

| 仓 | recall | pRead | rReadMust | holdout rReadMust | rTaskBlocking | tokens P50 | p95Ratio |
|---|---|---|---|---|---|---|---|
| lishuedu | 0.7986 = | 0.722→**0.599** | 0.925 = | 0.625 = | 0.572→0.611 | +244 | 0.934 |
| cipherlink | 0.8390 = | 0.663→**0.589** | 0.910 = | 0.550 = | 0.452→0.583 | +732 | 0.983 |
| exam-parent-v3 | 0.6970 = | 0.600→**0.484** | 0.880 = | 0.400 = | 0.482→0.573 | +869 | 0.997 |

抽查：`paper-task-claim-iam-holdout` call1 rReadMust=0.75，consumed `C1,C2,C4`，union 仍 0.75（`MeQueryService` 仍不在）。`backend-operation-log…` consumed `C1–C3`，rReadMust 仍 0.6。

## 怎么读

1. continuation **协议可用**（session、in-pool 消费、不发明 discovery-gap）。
2. **默认 fifo 选错了要续的单元**，所以三仓 holdout 缺口纹丝不动，pRead 变差。这不是「没开发」，是选择策略还没接到 oracle 假设的那批 BUDGET_EVICTED golden 上。
3. 若还要挖续读收益：换通用策略（按 required-group 缺口 / 关系类型优先级），**禁止** scene-id 特判。那是新战役，不是本场 GO。
4. 战役 S 不做。开关默认全部保持关。

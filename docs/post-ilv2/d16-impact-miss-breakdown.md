# D16 java_impact 未命中拆表（2026-11-13，Mac 运行之前提交）

用户于 2026-11-13 批准。离线、无模型、不调用产品：只重读 D15 步骤 F 已经落盘的私有产物。

## 1. 背景与要回答的问题

D15-F 在 C0 下，implementations 命中 8/21，callers 7/16（[D15-F.json](results/D15-F.json) `dev.C0.creditedByCategory`）；C3 加大预算后 implementations 仍为 8。F 的标签（`UNSELECTED`、`POOL_ABSENT` 等）不足以判断原因，有三个混杂：

1. 锚点是 driver 第一个 java_symbol 候选，56 次调用中 25 次锚在 ambiguous 或 text 结果上（`callsByAnchorExact`）。锚点错了，候选池自然没有目标。
2. F 全部用 `semanticPolicy: "fast"`（`scripts/ilv2-impact-budget-diagnosis.mjs`），产品默认是 `auto`。
3. F 的 `unselectedByRole` 用的是输出角色。`output-v6.ts` 的 `roleOf` 没有收录 `IMPLEMENTATION`、`implementation`、`typeGraph:implementation-lookup`，这些文件在输出里是 `related`，但 `read-plan.ts` 选择时把它们当受保护核心。所以 `related` 不等于"弱关系"。

要回答：implementations/callers 的未命中，是关系缺失、选择策略、锚点伪影，还是本来就是弱关系？

## 2. 方法（`scripts/ilv2-impact-miss-breakdown.mjs`）

输入是 F 的 `responses.jsonl`、`rows.jsonl`（sha256 必须等于 D15-F.json `rawEvidence` 记录的值）和 dev gold。对 C0、C3 下每个未命中的 Java 目标，按下列顺序取第一个成立的原因：

| 原因 | 条件 |
|---|---|
| `NO_IMPACT_CALL` | 该题没有 impact 调用 |
| `SELECTED_RANGE_MISS` | 文件已进读取计划，行范围没覆盖 |
| `ANCHOR_CONFOUND` | 文件不在任何调用的候选池里，且该题没有一次调用锚在 exact `match` 上：不能归因于产品 |
| `RELATION_MISSING` | 文件不在候选池里，但至少一次调用锚在 exact `match` 上 |
| `CORE_CAPPED` | 在池中未选中，带受保护核心 reason，该调用有 "Protected core exceeded" 缺口 |
| `PROTECTED_UNSELECTED` | 在池中未选中，带受保护核心 reason，无核心超限 |
| `WEAK_RELATION` | 在池中未选中，没有受保护核心 reason |

"在池中"的判断沿用 F 的口径：取第一个池中有该文件的调用。受保护核心按 reasons 近似；产品还看 `plannerEvidence`（例如 CALLS 只有 `callDepth ≤ 1` 才受保护），F 没有保留这一字段，这是已知偏差。另做角色审计：C0 所有池中文件里，输出角色为 `related` 但带受保护 reason 的数量。

## 3. 判读规则（看数字之前固定）

范围：C0 下 implementations + callers 的未命中 Java 目标（称"焦点未命中"）。门槛 5 与 W3 的实现门一致。

| 规则 | 条件 | 结论 |
|---|---|---|
| R1 重放 | `RELATION_MISSING` + `ANCHOR_CONFOUND` ≥ 5 | 预注册一次定向重放（仍无模型）：只对这些题，用题面 `anchors` 经 exact 查询解析出的唯一声明作锚点（解析不唯一的题记为不可判定），分别以 `semanticPolicy` = `fast`、`auto`、`required` 调 `java_impact`，区分"锚点错"、"fast 策略漏"、"静态关系确实缺"。不满足则不重放 |
| R2 选择候选 | `CORE_CAPPED` + `PROTECTED_UNSELECTED` ≥ 5，且其中至少一半在 C3 下仍未命中 | 选择策略是有证据的候选改动：写设计卡（不实现），先冻结评估指标与数据 |
| R3 弱关系 | `WEAK_RELATION` ≥ 焦点未命中的一半 | 主要是弱关系文件落选，不改产品，F 的 C0 结论维持 |
| R4 范围 | `SELECTED_RANGE_MISS` ≥ 3 | 记为读取范围问题，交 Q07/ReadUnit 方向，不在本轮处理 |
| 角色审计 | `relatedWithProtectedReason` > 0 | 登记为输出角色标注不一致（只影响输出，不影响选择）；是否修复另行决定 |

多条同时成立时都报告；R1 与 R2 同时成立时，先做 R1，重放结果可能改写 R2 的分母。全部不成立时，结论是"未命中分散，没有单一可改的原因"，implementations 方向收尾。

## 4. Mac 执行

`F_RUN` 指 D15-F 的运行目录 `post-ilv2-d15-f-projection.AutSUN/d15-f-dev`（在 Mac 运行根下）。若目录或文件哈希对不上，停下报告，不要重跑 F。

```bash
node --test scripts/ilv2-impact-miss-breakdown.test.mjs
node scripts/ilv2-impact-miss-breakdown.mjs --dataset "$ILV2_MAC10_DATASET" --gold "$DS/private/gold-dev.jsonl" \
  --responses "$F_RUN/responses.jsonl" --rows "$F_RUN/rows.jsonl" \
  --expect-responses-sha256 206fe3e0e403e4c586b23310793ff80d3469df29bc0e211af5324fe0afc18a5b \
  --expect-rows-sha256 37c8967368fb4414583f21229aefdb979dd929d99491e59b6c0419765f281d7a \
  --out "$RUN/d16-impact-miss-breakdown"
```

回传：新建 `results/D16-MISS.json`，包含 `summary.json` 全文和定向测试 TAP 计数；按 §3 写判读，不改 §2、§3。

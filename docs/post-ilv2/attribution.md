# 失败归因（Q02）

**状态：BLOCKED_ENV。** 私有 mac10-v3 开发集和三仓原始结果不在本仓库，本轮也没有运行任何评测，因此没有 ledger 行，不给出任何业务结论。

## 已交付的工具

`scripts/ilv2-quality-attribution.mjs`（测试 `scripts/ilv2-quality-attribution.test.mjs`，**未运行**）：

- `classifyFailure(stage)`：按 06 §6.3 的 8 级顺序取最早的 `false`；在它之前出现 `null` 即 `UNMEASURED`，不猜下游原因；全部为 `true` 时为 `PASSED`。
- `buildLedger(rows)`：只接受 `split` 为 `dev` 或 `regression`（已暴露的 holdout）的行，holdout 直接拒绝；planner 0 查询记 `NOT_PLANNED`，与真实搜索未命中分开。
- 条件卡触发：`NOT_DISCOVERED→Q06`、`RELATION_MISSING→Q05`、`CANDIDATE_EVICTED/RANGE_MISS→Q07`、`WRONG_DECLARATION→Q08`；至少 2 个不同任务组或 1 个登记的关键确定性缺陷才 `TRIGGERED`。Q09 由实测等待触发，不来自本 ledger。

## 在 Mac 上产生 ledger 的步骤

1. 用现有 `scripts/ilv2-mac-retrieval-eval.mjs` 在 dev 与已暴露 regression 上运行，保存每题的阶段观察（发现、声明、关系、选择、范围、序列化、送达、任务结果），未测阶段填 `null`。
2. 选最多 20 个不同任务组，整理为 `[{taskId, taskGroup, split, stage, plannerQueries, criticalDefect?}]`。
3. `node scripts/ilv2-quality-attribution.mjs rows.json docs/post-ilv2/attribution-ledger.json`，把结果和每张条件卡的触发状态写回本文件。

在这之前，Q05–Q08 一律 `NOT_TRIGGERED`（理由：没有触发证据）。Q09 的触发来自 Mac 上实测的重复等待，本轮没有计时数据，同样 `NOT_TRIGGERED`。见 [decisions.md](decisions.md)。

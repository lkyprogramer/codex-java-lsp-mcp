# 失败归因（Q02）

Mac 已生成 20 个 dev 任务组的 ledger。40 个本地检索 slot 全部完成。阶段归因仍有 14 个任务组未测到足以定因的证据。运行身份、汇总和原始文件哈希见 [Q02 结果](results/Q02.json)。

## 已交付的工具

`scripts/ilv2-quality-attribution.mjs` 的定向测试已在本次 Mac 运行通过。

- `classifyFailure(stage)`：按 06 §6.3 的 8 级顺序取最早的 `false`；在它之前出现 `null` 即 `UNMEASURED`，不猜下游原因；全部为 `true` 时为 `PASSED`。
- `buildLedger(rows)`：只接受 `split` 为 `dev` 或 `regression`（已暴露的 holdout）的行，holdout 直接拒绝；planner 0 查询记 `NOT_PLANNED`，与真实搜索未命中分开。
- 条件卡触发：`NOT_DISCOVERED→Q06`、`RELATION_MISSING→Q05`、`CANDIDATE_EVICTED/RANGE_MISS→Q07`、`WRONG_DECLARATION→Q08`；至少 2 个不同任务组或 1 个登记的关键确定性缺陷才 `TRIGGERED`。Q09 由实测等待触发，不来自本 ledger。

## 在 Mac 上产生 ledger 的步骤

1. 在观察结果前，从 dev 与已暴露 regression 冻结最多 20 个不同任务组和检索 schedule。
2. 用 `scripts/ilv2-mac-retrieval-eval.mjs` 执行检索，记录发现、声明、关系、选择、范围、序列化、送达和任务结果。未测阶段填 `null`。整理为 `[{taskId, taskGroup, split, stage, plannerQueries, criticalDefect?}]`。
3. `node scripts/ilv2-quality-attribution.mjs rows.json docs/post-ilv2/attribution-ledger.json`，把结果和每张条件卡的触发状态写回本文件。

## Mac 实测

在 `d7a295e4` 的同一编译候选上，用 seed `20261105` 按仓库和类别冻结 17 道 QA、3 道 repair。每组用 `native-rg/v1` 和 `product-mcp/v1` 各跑一次，单 slot deadline 120 秒。检索阶段只读取公开题面和语料，评分阶段再读 gold。没有使用 holdout 做归因或选题。

| 离线检索 | 完成 | 必需证据范围平均召回 | 全范围命中 | 零查询 |
|---|---:|---:|---:|---:|
| native | 20/20 | 42.83% | 4/20 | 3 |
| product | 20/20 | 36.25% | 3/20 | 3 |

召回沿用检索 runner 的必需范围口径，分母含零查询任务。两臂均未观察到命中范围的哈希错误。这里的检索对照与 Q10 的 B0/B2 任务评分是独立测量。

对 product 中有查询但未覆盖全部必需范围的 14 组，用原查询在 FRESH 视图回放。账本有 2 组 `CANDIDATE_EVICTED`、1 组 `NOT_DISCOVERED`、3 组 `NOT_PLANNED` 和 14 组 `UNMEASURED`。两组截断证据均为路径、文件哈希和声明行与冻结证据一致的方法。每对 Top 3 和 Top 20 使用相同索引视图，前三项一致。目标排在第 8 至 11 位，原 slot 没有读到相应文件。归因针对已核实的直接声明，同组其他证据仍按实际观测记录。

- Q07 达到两组调查阈值。在相同的 balanced 6 文件、14 KiB 预算下复测了 4 个证据范围。原 Top 3 路径覆盖 0/4，分别用目标声明作为锚点后覆盖 4/4。当前损失位于查询候选上限，未观察到固定预算 ReadUnit 复现该损失。见 [Q07 结果](results/Q07.json)。
- Q06 有一组完整查询无候选，低于两组阈值。Q05 和 Q08 的关系与绑定阶段仍有未判定项，触发证据不足。
- Q09 本轮记录了三仓的首次 FRESH 等待，约 13、53、143 秒。这些是新副本的冷启动样本，尚未取得日常重复等待或源码 I/O 分段数据。

私有 ledger、阶段行和工具回放保存在本机运行目录。离线检索未测模型送达或任务结果，这两级保留 `null`。

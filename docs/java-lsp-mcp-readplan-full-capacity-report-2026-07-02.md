# readPlan-full 容量与优先级验证报告

日期：2026-07-02

## 结论

本轮按 `docs/java-lsp-mcp-readplan-task4-type-reference-report-2026-07-01.md` 的 Do Next 继续处理 `readPlan-full`。结论是：

- `shouldBlocksTask && blockedBy=readplan-full` 是真实瓶颈，不是 attribution 噪声。
- 直接在 6 个 readPlan slot 内重排 P1 结构文件会造成 must 回退，不能上默认路由。
- 纯 `typeReference` 从 P2 提到 P1 在三仓上没有净收益，不能作为优化补丁。
- 扩大 readPlan 容量能减少部分 readPlan-full，但收益高度集中在 `cipherlink`，同时 `P_read` 和 reading payload 明显变差；因此本轮不改默认 `readPlanMaxItems=6`。
- 已新增 benchmark-only 实验入口 `--read-plan-max-items` / `JAVA_LSP_BENCH_READ_PLAN_MAX_ITEMS`，用于后续容量和优先级方案的可复现验证；MCP public tools 和 router 默认行为不变。

## 本轮实现

- `src/benchmark-agent-impact.ts`
  - 新增 `--read-plan-max-items <n>` CLI 参数。
  - 新增 `JAVA_LSP_BENCH_READ_PLAN_MAX_ITEMS` 环境变量。
  - 将实验预算写入 benchmark `metadata.readPlanMaxItems`。
  - 仅当显式传入时把 `readPlanMaxItems` 传给 `AgentRouter.impact`。

- `src/benchmark-agent-impact.test.ts`
  - 在 impact benchmark fixture 中验证 `--read-plan-max-items 1` 会让 `attempt.readPlanItems=1`、`roundTrips=2`。

默认路径不传该参数，所以默认 benchmark 与 MCP runtime 行为不变。

## 被实测否决的方案

| 方案 | 实测结果 | 结论 |
| --- | --- | --- |
| 在 P1 内按结构文件强重排 | 能减少部分 shouldBlocksTask full，但会把 lishuedu/cipherlink/exam 的已命中 must 文件挤出 readPlan | 不实施 |
| 纯 `typeReference` 候选从 P2 提到 P1 | 三仓 `recall / must / shouldBlocksTask full` 没有净变化，只是局部替换命中文件 | 不实施 |
| 默认扩到 8 个 readPlan slot | `cipherlink` full 从 12 降到 9，但 lishuedu/exam 不变；`P_read` 和 payload 变差 | 不改默认 |
| 默认扩到 10 个 readPlan slot | `cipherlink` full 从 12 降到 6，lishuedu/exam 只小幅改善；payload 明显上升 | 暂不默认化 |

## Benchmark 命令

基础验证：

```bash
npm run build
npm test
```

容量实验：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 8
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 8
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 8

node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 10
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 10
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 10
```

六条容量实验命令均退出 0，stderr 均为空。

## Benchmark 结果

`shouldBlocksTask` 的 `hit/full/absent` 按每个 scenario 的首个 attempt 去重统计；payload 和 elapsed 为 25 次 attempt 的 P50/P95。

| project | readPlan slots | recall | precision | R_read_must | P_read | readingPayload P50/P95 | elapsed P50/P95 | shouldBlocksTask hit/full/absent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 6 | 0.7756 | 0.4127 | 1.0000 | 0.8000 | 10790 / 12450 | 8.33 / 178.66 ms | 4 / 3 / 7 |
| lishuedu | 8 | 0.7756 | 0.4054 | 1.0000 | 0.6000 | 15342 / 17729 | 13.58 / 365.91 ms | 4 / 3 / 7 |
| lishuedu | 10 | 0.7756 | 0.3775 | 1.0000 | 0.5000 | 18301 / 21758 | 10.93 / 519.05 ms | 5 / 2 / 7 |
| cipherlink | 6 | 0.8357 | 0.4411 | 1.0000 | 0.5333 | 6182 / 9049 | 4.80 / 120.05 ms | 3 / 12 / 3 |
| cipherlink | 8 | 0.8357 | 0.4320 | 1.0000 | 0.5000 | 6930 / 13351 | 4.24 / 191.91 ms | 6 / 9 / 3 |
| cipherlink | 10 | 0.8643 | 0.4334 | 1.0000 | 0.4800 | 9715 / 15768 | 4.35 / 186.10 ms | 10 / 6 / 2 |
| exam-parent-v3 | 6 | 0.6300 | 0.2977 | 1.0000 | 0.4000 | 8136 / 12795 | 4.04 / 131.56 ms | 1 / 7 / 10 |
| exam-parent-v3 | 8 | 0.6300 | 0.2977 | 1.0000 | 0.3167 | 10290 / 16019 | 5.70 / 211.78 ms | 1 / 7 / 10 |
| exam-parent-v3 | 10 | 0.6300 | 0.2977 | 1.0000 | 0.2933 | 12199 / 17573 | 7.51 / 159.27 ms | 2 / 6 / 10 |

## 判定

1. `readPlan-full` 的确存在，但当前不是“默认扩容”能优雅解决的问题。
   - `cipherlink` 对 slot 数敏感。
   - `lishuedu` 和 `exam-parent-v3` 对 slot 数不敏感，说明仍有排序、候选质量或 absent 机制问题。

2. `R_read_must=1.0000` 是硬门槛，任何优先级重排都不能牺牲它。
   - 本轮模拟中，结构文件强重排已经触发 must 回退，因此不进入代码。

3. 后续优化应继续走 evidence-aware priority，而不是扩大候选源。
   - 第一候选方向：只在 benchmark attribution 证明某类文件反复 `readplan-full` 且不会挤掉 must 时，再设计局部 read priority。
   - 不做全局字符串权重调整。
   - 不做默认 readPlan 容量扩张。

## 下一步

1. 用新增 `--read-plan-max-items` 作为固定实验入口，后续所有 readPlan priority patch 都必须和 slot=6/8/10 对照。
2. 对 `cipherlink` 的 `port/dto/repository` 场景单独分析被 8/10 slot 命中的文件，提取不会伤害 must 的局部 priority 信号。
3. 对 `exam-parent-v3` 保持 Task 4 后续方向：优先处理 remaining absent / no-type-edge，不要用 readPlan 容量解决 absent。

## Final Test Report

| Check | Result |
| --- | --- |
| Build | PASS: `npm run build` exited 0. |
| Unit tests | PASS: `npm test` reported 77 tests, 73 pass, 0 fail, 4 skipped. |
| Benchmark CLI experiment flag | PASS: test fixture confirmed `--read-plan-max-items 1` limits impact readPlan to 1 item. |
| Real repo capacity benchmark | PASS: six cold diagnostic benchmark commands for slot 8/10 exited 0. |
| Benchmark stderr | PASS: all six stderr files were empty. |
| Cold must gate | PASS: all slot 6/8/10 runs kept `R_read_must=1.0000` for lishuedu, cipherlink, and exam-parent-v3. |
| Default behavior | PASS by construction: default `readPlanMaxItems` is unchanged unless benchmark CLI/env explicitly sets it. |

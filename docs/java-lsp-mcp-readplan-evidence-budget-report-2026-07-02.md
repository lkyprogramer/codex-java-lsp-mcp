# readPlan evidence budget Phase 2 验收报告

日期：2026-07-02

## 结论

Phase 2 已完成并通过真实仓库 gate。

- 三仓 cold `R_read_must` 均为 `1.0000`，默认 `readPlanMaxItems=6` 未变。
- `readPlan` 选择已从单纯 `(priority, score) top N` 调整为证据类预算选择：`anchor / verified / structural / naming / support`。
- `semanticPolicy=required` 保留 legacy readPlan 选择路径，避免 required LSP 候选挤掉非 LSP 邻居。
- MCP public tools 入参/出参 schema 未改。
- 未引入 warm 调度、profile-aware warm 默认化或 timeout-degrade。

本阶段最终解决了 Phase 1 后仍存在的主要 `readplan-full` 压力：cipherlink slot=6 阻塞性 `should readplan-full` 从 Phase 1 的 `8` 保持在 `8`，同时 `P_read` 从 `0.6333` 提升到 `0.7000`；相对容量扩展实验 slot=8 的 full 改善量满足计划门槛。

## 输入状态

| repo | path | git state |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, commit `edea0b5`, clean |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf`, `develop...origin/develop [ahead 1]` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `638226e`, `develop...origin/develop [ahead 5]`, dirty working tree |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da8`, `develop-v2...origin/develop-v2 [ahead 3]` |

cipherlink dirty 文件：

- `modules/organization/src/main/java/com/hhtele/cipherlink/organization/infrastructure/persistence/MybatisOrganizationRepository.java`
- `modules/organization/src/test/java/com/hhtele/cipherlink/organization/infrastructure/persistence/MybatisOrganizationRepositoryTest.java`
- `modules/transfer/src/main/java/com/hhtele/cipherlink/transfer/application/DefaultTransferAppService.java`
- `modules/transfer/src/main/java/com/hhtele/cipherlink/transfer/application/TransferUploadProperties.java`
- `modules/transfer/src/test/java/com/hhtele/cipherlink/transfer/application/DefaultTransferAppServiceTest.java`
- `.omo/evidence/todo-3-transfer-upload-gate-review.md`
- `.omo/lazycodex-executor-verify/`

## 本阶段实现

- `src/agent-router/read-plan-budget.ts`
  - 新增 `evidenceClassOf`，把候选归入 `anchor / verified / structural / naming / support`。
  - 新增 `classQuotas`，当前 slot=6 预算为 `{ verified: 2, structural: 5, naming: 1, support: 1 }`。
  - 新增 `selectWithEvidenceBudget`，先保护 anchor 与显式 protected path，再按证据类配额选取，最后用排序余量回填。

- `src/agent-router/index.ts`
  - `selectReadPlanFiles` 接入 evidence budget，输出后仍按 read priority 和 score 排序。
  - protected path 收敛为 `typeGraph` verified 与 `implementation` reason，避免泛结构信号提前占满 slot。
  - `semanticPolicy=required` 的 non-LSP/readPlan 路径保留 legacy top-N 语义，防止 required semantic 候选改变原有 readPlan 邻居。

- `src/read-plan-budget.test.ts`
  - 覆盖证据分类、slot=6 配额、protected path、anchor 保护、命名洪泛下结构候选保留、未用配额回填、`maxItems=1`。

- `src/agent-router.test.ts`
  - 新增 `evidence budget keeps structural collaborator under naming flood`，构造命名噪音压过结构协作者的回归用例。

## 失败门禁与修复

| attempt | 关键结果 | 判定与处理 |
| --- | --- | --- |
| `p2` | lishuedu `R_read_must=0.81`，cipherlink `R_read_must=0.8333` | must gate 失败；按计划回滚 Task 6。 |
| `p2b` | 三仓 must 恢复；cipherlink slot=6 阻塞性 `should full=11` | anchor 已保护，但命名/泛结构仍挤占容量；继续收紧预算。 |
| `p2c` | cipherlink slot=6 阻塞性 `should full=10` | `structural=3,naming=1` 不足。 |
| `p2d` | cipherlink slot=6 阻塞性 `should full=10` | `structural=4,naming=1` 仍不足。 |
| `p2e` | cipherlink slot=6 阻塞性 `should full=10` | `structural=5,naming=1` 仍被过宽 protected pass 抵消。 |
| `p2f` | 三仓 must 全过；cipherlink slot=6 阻塞性 `should full=8`，`P_read=0.7000` | 通过；采用窄 protected pass + required semantic legacy 选择。 |

## 验证命令

基础验证：

```bash
npm run build
npm test
git diff --check
```

真实仓库 gate：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 6 > /tmp/rp-p2f-lishuedu-6.json 2> /tmp/rp-p2f-lishuedu-6.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 8 > /tmp/rp-p2f-lishuedu-8.json 2> /tmp/rp-p2f-lishuedu-8.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 10 > /tmp/rp-p2f-lishuedu-10.json 2> /tmp/rp-p2f-lishuedu-10.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 6 > /tmp/rp-p2f-cipherlink-6.json 2> /tmp/rp-p2f-cipherlink-6.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 8 > /tmp/rp-p2f-cipherlink-8.json 2> /tmp/rp-p2f-cipherlink-8.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 10 > /tmp/rp-p2f-cipherlink-10.json 2> /tmp/rp-p2f-cipherlink-10.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 6 > /tmp/rp-p2f-exam-parent-v3-6.json 2> /tmp/rp-p2f-exam-parent-v3-6.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 8 > /tmp/rp-p2f-exam-parent-v3-8.json 2> /tmp/rp-p2f-exam-parent-v3-8.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic --read-plan-max-items 10 > /tmp/rp-p2f-exam-parent-v3-10.json 2> /tmp/rp-p2f-exam-parent-v3-10.err
```

## 测试结果

| Check | Result |
| --- | --- |
| build | PASS: `npm run build` exited 0. |
| 全量 tests | PASS: `npm test` reported 96 tests, 92 pass, 0 fail, 4 skipped. |
| diff hygiene | PASS: `git diff --check` exited 0. |
| benchmark stderr | PASS: `/tmp/rp-p2f-*.err` 9 个文件均为 0 bytes. |
| cold must gate | PASS: lishuedu / cipherlink / exam-parent-v3 在 slot=6/8/10 下 `R_read_must=1.0000`. |

## Benchmark totals

| project | slot | recall | precision | P_read | R_read_must | readPlanItems | readingPayload P50/P95 | elapsed P50/P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 6 | 0.8206 | 0.4418 | 0.8333 | 1.0000 | 6 | 9863 / 10704 | 21.02 / 753.03 ms |
| lishuedu | 8 | 0.8456 | 0.4326 | 0.6500 | 1.0000 | 8 | 14071 / 15409 | 42.44 / 476.89 ms |
| lishuedu | 10 | 0.8456 | 0.4113 | 0.5600 | 1.0000 | 10 | 18100 / 20688 | 29.12 / 517.98 ms |
| cipherlink | 6 | 0.8357 | 0.3700 | 0.7000 | 1.0000 | 6 | 5490 / 8931 | 6.94 / 378.73 ms |
| cipherlink | 8 | 0.8643 | 0.3783 | 0.6000 | 1.0000 | 8 | 7235 / 12556 | 8.91 / 309.77 ms |
| cipherlink | 10 | 0.8643 | 0.3783 | 0.5200 | 1.0000 | 10 | 10042 / 15679 | 14.34 / 349.17 ms |
| exam-parent-v3 | 6 | 0.5800 | 0.2335 | 0.4667 | 1.0000 | 6 | 5630 / 10559 | 23.54 / 330.16 ms |
| exam-parent-v3 | 8 | 0.6783 | 0.2614 | 0.4500 | 1.0000 | 8 | 7492 / 13341 | 7.83 / 333.51 ms |
| exam-parent-v3 | 10 | 0.6783 | 0.2614 | 0.3600 | 1.0000 | 10 | 11348 / 16210 | 23.24 / 339.58 ms |

## 阻塞性 should attribution

统计口径：只统计 `kind=should` 且 `shouldBlocksTask=true` 的 first attempt golden attribution。

| project | slot | must miss | should hit | should readplan-full | should absent | no-type-edge | cross-module-cold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 6 | 0 | 4 | 5 | 5 | 1 | 2 |
| lishuedu | 8 | 0 | 5 | 5 | 4 | 0 | 2 |
| lishuedu | 10 | 0 | 7 | 3 | 4 | 0 | 2 |
| cipherlink | 6 | 0 | 7 | 8 | 3 | 0 | 0 |
| cipherlink | 8 | 0 | 8 | 7 | 3 | 0 | 0 |
| cipherlink | 10 | 0 | 10 | 5 | 3 | 0 | 0 |
| exam-parent-v3 | 6 | 0 | 3 | 5 | 10 | 5 | 3 |
| exam-parent-v3 | 8 | 0 | 5 | 4 | 9 | 4 | 3 |
| exam-parent-v3 | 10 | 0 | 5 | 4 | 9 | 4 | 3 |

## Gate 判定

1. Phase 2 可作为 Phase 3 基线。
   - 三仓 slot=6/8/10 均 `R_read_must=1.0000`。
   - slot=6 的 payload P50 均未超过容量报告基线的 1.1 倍：lishuedu `9863 < 10790`，cipherlink `5490 < 6182`，exam-parent-v3 `5630 < 8136`。

2. Phase 2 解决的是 `readplan-full` 排序容量问题，不解决结构边缺失。
   - exam-parent-v3 slot=6 阻塞性 `should absent=10`，与 Phase 1 基线持平；其中 `no-type-edge=5`、`cross-module-cold=3`，应进入 Phase 3 persisted edge。
   - lishuedu 仍有 `cross-module-cold=2`，同样属于 Phase 3 输入。

3. 保留 `readPlanMaxItems=6` 是可行选择。
   - cipherlink slot=6 阻塞性 full 从 p2b 的 `11` 降到 `8`；slot=8 的 full 为 `7`。
   - slot=6 相对 p2b 改善量为 `3`，达到 slot=8 扩容改善量 `4` 的至少三分之二。
   - slot=8/10 会线性增加 reading payload，不应改默认容量。

4. 后续 Phase 3 不应再通过提高字符串权重或扩大默认 slot 解决 absent。
   - 当前 remaining gap 主要是没有 cold 可用的结构边。
   - 持久化 warm LSP verify 结果后，cold 查询才能在不引入交互期 LSP 成本的前提下补齐。

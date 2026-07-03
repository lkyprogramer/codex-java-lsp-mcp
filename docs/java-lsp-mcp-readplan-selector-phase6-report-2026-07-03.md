# ReadPlan Selector Phase 6 Report - 2026-07-03

## 结论

Phase 6 验证了上一轮格局判断：当前收益点在 readPlan selector，而不是继续扩大候选池。

- exam-parent-v3 的 `P_read` 从 `0.5000` 提升到 `0.5333`。
- exam-parent-v3 的 `should readplan-full` 从 `5` 降到 `4`，`PositionService.java` 从 readplan-full 变成 readPlan hit。
- lishuedu / cipherlink macro 指标保持 Phase 5 水平。
- 三仓 hard gate 继续保持：`R_read_must=1.0000`，`mustMiss=0`。

本轮没有增加候选召回边，没有扩大 readPlan slot，没有调整字符串权重；只在 selector 内部处理同证据类、同 score 的候选平局。

## 改动范围

代码改动：

- `src/agent-router/read-plan-budget.ts`
  - 在 `selectWithEvidenceBudget()` 内增加 `readPlanOrder()`。
  - 只当候选属于同一 evidence class 且 `score` 完全相同时，使用已有 `scoreBreakdown` 中的读入效用破平局。
  - 读入效用来源限于现有 finalize 信号：`finalize.task-keyword`、`finalize.direct-collaborator`、`finalize.type-relation`、`finalize.structural.kind`。
- `src/read-plan-budget.test.ts`
  - 新增红绿测试：同分 structural 候选中，带 task utility 的 `PositionService.java` 应优先于通用包装 `CommonsResult.java`。

## 为什么这样改

Phase 5 的代表场景显示：

- `candidate-position-select` 中，`PositionService.java` 已经被 `typeReference` 召回，但和 `CommonsResult.java` 同为 structural、同分，最终被 path 字母序挤出 readPlan。
- 这不是召回问题，也不是 slot 不够的第一性问题，而是 selector 在同分结构候选中没有使用已有读入效用。

本轮只复用既有 `scoreBreakdown`，没有新增项目词表或业务专有规则。

## 验证命令

```bash
npm run build && node --test --test-name-pattern "task utility breaks structural score ties" dist/read-plan-budget.test.js
node --test dist/read-plan-budget.test.js
npm run build && node --test dist/source-index.test.js dist/agent-router.test.js dist/read-plan-budget.test.js dist/routing-policy.test.js
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p6-lishuedu.json 2> /tmp/rp-p6-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p6-cipherlink.json 2> /tmp/rp-p6-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p6-exam.json 2> /tmp/rp-p6-exam.err
```

测试结果：

- Red test: 修改前失败，实际选中 `CommonsResult.java`；修改后通过，选中 `PositionService.java`。
- `node --test dist/read-plan-budget.test.js`: `8` tests, `8` pass。
- Full targeted suite: `67` tests, `63` pass, `4` skipped, `0` fail。
- 三仓 benchmark stderr：全部为空。
- Pure LOC check: `src/agent-router/read-plan-budget.ts=110`, `src/read-plan-budget.test.ts=97`。

## 仓库快照

| Repo | Path | Snapshot |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, base HEAD `4cdada22c497`, report created before final commit |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf903` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `638226ee50d3`, dirty working tree from external changes |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da826b4e` |

## 指标对照

Phase 5 基线采用 `docs/java-lsp-mcp-readplan-structural-phase5-report-2026-07-03.md`。

| Project | Phase 5 recall | Phase 6 recall | Phase 5 precision | Phase 6 precision | Phase 5 P_read | Phase 6 P_read | R_read_must | payload P50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0.8456 | 0.8456 | 0.4509 | 0.4509 | 0.8667 | 0.8667 | 1.0000 | 9863 |
| cipherlink | 0.8357 | 0.8357 | 0.3700 | 0.3700 | 0.7000 | 0.7000 | 1.0000 | 5109 |
| exam-parent-v3 | 0.6200 | 0.6200 | 0.2460 | 0.2460 | 0.5000 | 0.5333 | 1.0000 | 5733 |

Timing:

| Project | elapsed P50 | elapsed P95 | reading payload P95 |
| --- | ---: | ---: | ---: |
| lishuedu | 10.26ms | 249.51ms | 10492 |
| cipherlink | 7.64ms | 225.16ms | 8932 |
| exam-parent-v3 | 9.08ms | 167.72ms | 9387 |

## Attribution

| Project | must miss | should hit | should readplan-full | should absent |
| --- | ---: | ---: | ---: | ---: |
| lishuedu | 0 | 4 | 6 | 5 |
| cipherlink | 0 | 8 | 8 | 4 |
| exam-parent-v3 | 0 | 5 | 4 | 9 |

exam 变化点：

- `candidate-position-select`: `PositionService.java` 从 `readplan-full` 变成 hit。
- `PositionPageDTO.java` 保持 hit。
- `PositionServiceImpl.java` 仍是 absent，说明它不是 selector 问题，而是真实实现类边来源问题。

## 已知限制

- 本轮只处理同 evidence class、同 score 的平局；不会解决 score 差距较大的 readplan-full。
- `rule-engine-execute` 的 `StringRuleExecutor.java` / `NumberRuleExecute.java` 仍是 naming quota/readplan-full 问题，不能靠 structural tie-break 解决。
- `apply-info-save-basic-service` 仍有 `ApplyInfo.java`、`PositionTemplate.java` readplan-full，以及多个 repository/template absent。
- exam 的 candidate recall / precision 没变；本轮只提升 readPlan utility。

## 后续建议

1. Phase 7 继续沿 selector 方向，但要单独处理 naming family：识别同一接口/抽象类下的 implementation siblings，避免只读到一个 abstract/base executor。
2. 对 absent backlog 单独开结构边任务：`PositionServiceImpl`、`ApplyInfoRepository`、`CebPayService` 这类需要 implementation lookup / receiver usage / repository usage，不应混进 selector patch。
3. 保持 lishuedu legacy 不动；这轮 selector 已证明 generic readPlan 层可以小步收益，不需要碰 legacy policy。

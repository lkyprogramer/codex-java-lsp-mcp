# ReadPlan Selector Phase 7 Report - 2026-07-03

## 结论

Phase 7 验证了 Phase 6 报告里的 naming family 建议，但同时证伪了“只靠 family selector 就能继续拉高 macro 指标”的假设。

- 行为修复成立：当 readPlan 的 naming quota 只剩一个同族候选槽时，具体实现类优先于 `Abstract*` / `Base*` 基类。
- `rule-engine-execute` 代表场景从只读 `AbstractRuleExecutor.java` 改为读入 concrete sibling `DateRuleExecutor.java`。
- 三仓 macro 指标相对 Phase 6 持平，没有 hard regression。
- 三仓 hard gate 继续保持：`R_read_must=1.0000`，`mustMiss=0`。

这说明 family-aware selector 是低风险修复，但它不能判断业务上应该读 `StringRuleExecutor` 还是 `NumberRuleExecute`。后续不应继续在 family 内猜具体变体，应转向真实边来源或 golden 质量审计。

## 改动范围

代码改动：

- `src/agent-router/read-plan-budget.ts`
  - 在 `readPlanOrder()` 的 naming evidence class 内增加 concrete-family tie-break。
  - 只当一方是 `Abstract*` / `Base*`，另一方是同后缀 concrete Java type 时触发。
  - 不改变候选分数、不改变 readPlan slot、不扩大候选池。
- `src/read-plan-budget.test.ts`
  - 新增红绿测试：`AbstractRuleExecutor.java` 与 `StringRuleExecutor.java` 在同一 saturated naming slot 中竞争时，应选择 concrete sibling。

## 验证命令

```bash
npm run build && node --test --test-name-pattern "concrete naming family member" dist/read-plan-budget.test.js
node --test dist/read-plan-budget.test.js
npm run build && node --test dist/source-index.test.js dist/agent-router.test.js dist/read-plan-budget.test.js dist/routing-policy.test.js
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p7-lishuedu.json 2> /tmp/rp-p7-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p7-cipherlink.json 2> /tmp/rp-p7-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p7-exam.json 2> /tmp/rp-p7-exam.err
```

测试结果：

- Red test: 修改前选中 `AbstractRuleExecutor.java`；修改后选中 `StringRuleExecutor.java`。
- `node --test dist/read-plan-budget.test.js`: `9` tests, `9` pass。
- Full targeted suite: `68` tests, `64` pass, `4` skipped, `0` fail。
- 三仓 benchmark stderr：全部为空。
- Pure LOC check: `src/agent-router/read-plan-budget.ts=150`, `src/read-plan-budget.test.ts=107`。

## 仓库快照

| Repo | Path | Snapshot |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, base HEAD `bc1cd6cac811`, report created before final commit |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf903` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `638226ee50d3` |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da826b4e` |

## 指标对照

Phase 6 基线采用 `docs/java-lsp-mcp-readplan-selector-phase6-report-2026-07-03.md`。

| Project | Phase 6 recall | Phase 7 recall | Phase 6 precision | Phase 7 precision | Phase 6 P_read | Phase 7 P_read | R_read_must | payload P50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0.8456 | 0.8456 | 0.4509 | 0.4509 | 0.8667 | 0.8667 | 1.0000 | 9863 |
| cipherlink | 0.8357 | 0.8357 | 0.3700 | 0.3700 | 0.7000 | 0.7000 | 1.0000 | 5109 |
| exam-parent-v3 | 0.6200 | 0.6200 | 0.2460 | 0.2460 | 0.5333 | 0.5333 | 1.0000 | 5733 |

Timing:

| Project | elapsed P50 | elapsed P95 | reading payload P95 |
| --- | ---: | ---: | ---: |
| lishuedu | 10.30ms | 236.86ms | 10492 |
| cipherlink | 7.39ms | 200.82ms | 8932 |
| exam-parent-v3 | 9.11ms | 299.28ms | 9387 |

## Attribution

| Project | must miss | should hit | should readplan-full | should absent |
| --- | ---: | ---: | ---: | ---: |
| lishuedu | 0 | 4 | 6 | 5 |
| cipherlink | 0 | 8 | 8 | 4 |
| exam-parent-v3 | 0 | 5 | 4 | 9 |

代表场景变化：

- `rule-engine-execute`: readPlan 从 `AbstractRuleExecutor.java` 切换为 concrete sibling `DateRuleExecutor.java`。
- `StringRuleExecutor.java` / `NumberRuleExecute.java` 仍是 readplan-full，因为当前 generic family selector 无法知道具体业务变体。

## 已知限制

- 本轮是行为修复，不是 macro 指标提升；Phase 7 指标与 Phase 6 持平。
- path/name family 只能避免抽象基类独占 naming slot，不能替代真实 type hierarchy / reflection registry 边。
- `NumberRuleExecute.java` 当前文件主体是注释代码，golden 中仍标为 should。这个场景需要单独审计 golden 是否仍有效。

## 后续建议

1. 不再继续增强 naming family 猜测；下一步应补真实边来源：reflection registry、method receiver usage、repository/service implementation lookup。
2. 对 `rule-engine-execute` 单独审计 golden：确认 `NumberRuleExecute.java` 是否仍是有效 should，避免用 stale golden 驱动错误优化。
3. 对 `apply-info-save-basic-service` 的 absent/readplan-full 做 receiver/repository usage 结构边，优先处理 `ApplyInfoRepository`、`ApplyInfo.java`、`PositionTemplate.java`。

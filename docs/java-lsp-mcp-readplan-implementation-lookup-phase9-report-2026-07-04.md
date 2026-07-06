# ReadPlan Implementation Lookup Phase 9 Report - 2026-07-04

## 结论

Phase 9 按 Phase 8 后续建议补了第二条窄结构边：当 anchor 直接引用的 `Service` / `Gateway` / `Port` interface 已经是候选时，补充其 focus 范围内的实现类为候选级 `typeGraph` evidence。

- `candidate-position-select` 中 `PositionServiceImpl.java` 从 absent 变为 hit。
- `PositionService.java` 与 `PositionPageDTO.java` 继续保持 readPlan hit，没有重演 DTO/response 泛保护导致的 controller 退化。
- exam-parent-v3 macro 指标继续提升：recall `0.6700 -> 0.7100`，precision `0.2724 -> 0.2849`，P_read `0.5667 -> 0.6000`。
- lishuedu 保持 Phase 8 水平；cipherlink 本轮在当前快照下 recall/precision 小幅提升，P_read 不变。
- 三仓 hard gate 继续保持：`R_read_must=1.0000`，stderr 全空。

本轮没有扩大 readPlan slot，没有扩大 candidate limit，没有把 `Executor` 纳入 implementation lookup。`rule-engine-execute` 仍应按 golden/registry edge 单独处理。

## 改动范围

代码改动：

- `src/agent-router/index.ts`
  - 在 `collectTypeReferenceCandidates()` 的 existing referenced type 分支中，针对已命中的 service-like interface 补 `findImplementers()`。
  - implementation lookup 仅对 `Service` / `Gateway` / `Port` 后缀 interface 生效，且 interface 名必须命中 `taskKeywords`；无 taskKeywords 的局部 fixture 仍允许。
  - scope 限定为同 module 或 focus module；兼容 Maven reactor nested module：`exam-service/exam-service-candidate` 可由 focus leaf `exam-service-candidate` 命中。
  - 新增实现类候选仍标记 `verifiedBy=["typeGraph"]`，但 reason 使用 `typeGraph:implementation-lookup`，不走普通 `typeGraph` 强 readPlan 保护。
- `src/agent-router/read-plan-budget.ts`
  - `typeGraph:implementation-lookup` 在 readPlan evidence budget 中按候选级处理，避免实现类抢占原本已命中的 interface/DTO structural slot。
- `src/agent-router-implementation-lookup.test.ts`
  - 新增红绿测试：nested Maven module + leaf focusModules + DTO 噪声下，`PositionServiceImpl` 必须进入候选，`PositionService` / `PositionPageDTO` 必须保持 readPlan hit。

## 验证命令

```bash
npm run build && node --test --test-name-pattern "referenced interface implementers are added when the interface is already a candidate" dist/agent-router-implementation-lookup.test.js
npm run build && node --test dist/source-index.test.js dist/agent-router.test.js dist/agent-router-direct-reference.test.js dist/agent-router-implementation-lookup.test.js dist/read-plan-budget.test.js dist/routing-policy.test.js
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p9-final-lishuedu.json 2> /tmp/rp-p9-final-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p9-final-cipherlink.json 2> /tmp/rp-p9-final-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p9-final-exam.json 2> /tmp/rp-p9-final-exam.err
NODE_PATH=/Users/luo/Documents/github/codex-java-lsp-mcp/node_modules bun run /Users/luo/.codex/plugins/cache/sisyphuslabs/omo/4.15.1/skills/programming/scripts/typescript/check-no-excuse-rules.ts src/agent-router/index.ts src/agent-router/read-plan-budget.ts src/agent-router-implementation-lookup.test.ts
git diff --check
```

测试结果：

- Red test 1: 初版用例在生产实现前失败，`PositionServiceImpl.java` 未进入 `typeGraph`，断言 `false !== true`。
- Red test 2: nested module + leaf focusModules 复现真实失败，生产修复前断言 `false !== true`。
- Green test: implementation lookup 用例通过。
- Full targeted suite: `70` tests, `66` pass, `4` skipped, `0` fail。
- 三仓 benchmark stderr：全部为空。
- no-excuse scan: `No violations in 3 file(s).`
- `git diff --check`：通过。
- Pure LOC: `src/agent-router/index.ts=1948`、`src/agent-router/read-plan-budget.ts=153`、`src/agent-router-implementation-lookup.test.ts=90`。`agent-router/index.ts` 是既有超大文件，本轮只做局部接线。

## 仓库快照

| Repo | Path | Snapshot |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, base HEAD `d35fc07861ee`, report created before final commit |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf903` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `84f0eb0fc94c` |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da826b4e` |

## 指标对照

Phase 8 基线采用 `docs/java-lsp-mcp-readplan-direct-reference-phase8-report-2026-07-03.md`。注意 cipherlink 被测仓快照本轮为 `84f0eb0fc94c`，不同于 Phase 8 报告中的 `638226ee50d3`。

| Project | Phase 8 recall | Phase 9 recall | Phase 8 precision | Phase 9 precision | Phase 8 P_read | Phase 9 P_read | R_read_must |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0.8456 | 0.8456 | 0.4509 | 0.4509 | 0.8667 | 0.8667 | 1.0000 |
| cipherlink | 0.8357 | 0.8643 | 0.3700 | 0.3783 | 0.7000 | 0.7000 | 1.0000 |
| exam-parent-v3 | 0.6700 | 0.7100 | 0.2724 | 0.2849 | 0.5667 | 0.6000 | 1.0000 |

Timing / payload:

| Project | reading payload avg | total payload avg | elapsed P50 | elapsed P95 |
| --- | ---: | ---: | ---: | ---: |
| lishuedu | 9070.4 | 41339.44 | 11.79ms | 301.24ms |
| cipherlink | 6239.8 | 39171.88 | 8.62ms | 166.60ms |
| exam-parent-v3 | 6512.2 | 37995.72 | 5.25ms | 194.89ms |

## Attribution

| Project | must miss | should hit | should readplan-full | should absent |
| --- | ---: | ---: | ---: | ---: |
| lishuedu | 0 | 4 | 6 | 5 |
| cipherlink | 0 | 8 | 9 | 3 |
| exam-parent-v3 | 0 | 7 | 5 | 6 |

exam 关键场景：

| Scenario | File | Phase 8 | Phase 9 |
| --- | --- | --- | --- |
| `candidate-position-select` | `PositionService.java` | hit / typeReference | hit / typeReference |
| `candidate-position-select` | `PositionPageDTO.java` | hit / typeReference | hit / typeReference |
| `candidate-position-select` | `PositionServiceImpl.java` | absent / cross-module-cold | hit / implementation lookup |

## 已知限制

- `typeGraph:implementation-lookup` 是候选级 evidence，不作为普通 `typeGraph` 强保护项；这是为了不挤掉 `PositionService.java` / `PositionPageDTO.java` 这类既有 readPlan hit。
- `Executor` 未纳入本轮 lookup。`rule-engine-execute` 的 concrete executor 仍应先做 golden 审计，再决定是否补 registry/reflection edge。
- `ApplyInfoUpdateDTO.java` 仍不通过 DTO 泛保护解决；后续若处理，应走 method-parameter/readPlan selector 小任务，并继续以 `candidate-position-select` 不退化为硬门槛。
- `src/agent-router/index.ts` 仍是既有大文件。后续继续加 edge 前，建议先拆出 typeReference/finalize scoring helper，避免主路由器继续膨胀。

## 后续建议

1. 对 `rule-engine-execute` 做 golden 审计，确认 `StringRuleExecutor.java` / `NumberRuleExecute.java` 是否应由 registry/reflection edge 召回。
2. 单独开 method-parameter DTO selector 任务处理 `ApplyInfoUpdateDTO.java`，禁止 DTO/response 全量保护。
3. 在继续加结构边前拆分 `src/agent-router/index.ts` 中的 typeReference / finalize helper，保持每条 edge 可独立测试和回滚。

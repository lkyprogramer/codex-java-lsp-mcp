# Agent Router Scheduler Split Phase 12 Report - 2026-07-04

## 结论

Phase 12 继续做 behavior-preserving refactor，目标是把 `src/agent-router/index.ts` 收缩为调度器。

- `src/agent-router/index.ts` 从 Phase 11 报告中的 `1688` 行降到 `275` 行，有效代码约 `258` 行。
- Router 类现在只保留构造依赖、rg cache 状态、`impact()` 主流程、薄的 rg cache loader。
- readPlan、rg plan、rg execution、format/payload、semantic、candidate collectors、finalize rank、metrics、runtime helper 已拆出独立模块。
- 三仓 cold-nolsp benchmark 与 Phase 11 指标一致：recall、precision、P_read、R_read_must 均无行为漂移。
- hard gate 保持：三仓 `R_read_must=1.0000`，benchmark stderr 全空。

本轮没有新增仓库专有规则，没有新增打分信号，没有扩大 readPlan slot，没有改变 source-index schema。

## 改动范围

代码改动：

- `src/agent-router/index.ts`
  - 收缩为调度器：依赖构造、rg cache 状态、`impact()` 阶段编排、缓存化 rg summary loader。
  - 删除旧的 inline semantic、readPlan、rg 聚合、payload formatting、finalize rank、evidence gap、metrics delta、runtime helper 实现。
- `src/agent-router/read-plan.ts`
  - 提取 `buildReadPlan()`、read priority、read window、legacy readPlan、protected paths。
- `src/agent-router/format.ts`
  - 提取 candidate/anchor formatting、verbosity 裁剪、payload byte update。
  - 新增 `buildImpactResult()`，集中组装最终 `ImpactResult`。
- `src/agent-router/rg-plan.ts`
  - 保留 rg plan 构造和 rg output parser。
- `src/agent-router/rg-roots.ts`
  - 提取 rg roots / persistence roots 选择。
- `src/agent-router/rg-terms.ts`
  - 提取 service/controller/dto/parser/repository 等 term 构造。
- `src/agent-router/rg-execution.ts`
  - 提取 rg plan 执行聚合、section summary 构造、rg subprocess runner、rg command summary loader。
- `src/agent-router/anchor.ts`
  - 提取 anchor resolve、profile inference、annotation tie-break。
- `src/agent-router/candidate-collectors.ts`
  - 提取 anchor candidate、type graph、import graph、persisted semantic edge candidate 收集。
- `src/agent-router/semantic.ts`
  - 提取 semantic seed、semantic verify、implementation/reference/typeHierarchy candidate 转换。
- `src/agent-router/finalize-rank.ts`
  - 提取 candidate final ranking、tail truncation 前 readPlan coverage、non-LSP protected readPlan paths。
- `src/agent-router/evidence-gaps.ts`
  - 提取 evidence gap 规则。
- `src/agent-router/impact-metrics.ts`
  - 提取 semantic/typeReference/importGraph/persistedSemantic metrics 初始化和 cache/source delta 计算。
- `src/agent-router/naming-recall.ts`
  - 提取 rg naming recall 阶段调用。
- `src/agent-router/runtime.ts`
  - 提取 `timed()` 和 `positiveInteger()`。

拆分后关键文件体量：

| File | Lines | Effective lines |
| --- | ---: | ---: |
| `src/agent-router/index.ts` | 275 | 258 |
| `src/agent-router/read-plan.ts` | 224 | 205 |
| `src/agent-router/format.ts` | 193 | 184 |
| `src/agent-router/rg-execution.ts` | 209 | 201 |
| `src/agent-router/semantic.ts` | 234 | 216 |
| `src/agent-router/impact-metrics.ts` | 153 | 139 |
| `src/agent-router/finalize-rank.ts` | 85 | 80 |
| `src/agent-router/naming-recall.ts` | 41 | 39 |
| `src/agent-router/runtime.ts` | 16 | 15 |

## 验证命令

```bash
npm run build
node --test dist/agent-router-direct-reference.test.js dist/agent-router-implementation-lookup.test.js dist/agent-router.test.js dist/agent-router-read-plan-budget.test.js dist/ranking-signals.test.js
NODE_PATH=/Users/luo/Documents/github/codex-java-lsp-mcp/node_modules bun run /Users/luo/.codex/plugins/cache/sisyphuslabs/omo/4.15.1/skills/programming/scripts/typescript/check-no-excuse-rules.ts src/agent-router/index.ts src/agent-router/anchor.ts src/agent-router/candidate-collectors.ts src/agent-router/read-plan.ts src/agent-router/format.ts src/agent-router/rg-plan.ts src/agent-router/rg-roots.ts src/agent-router/rg-terms.ts src/agent-router/semantic.ts src/agent-router/candidate-helpers.ts src/agent-router/name-helpers.ts src/agent-router/type-reference.ts src/agent-router/finalize-scoring.ts src/agent-router/finalize-rank.ts src/agent-router/rg-execution.ts src/agent-router/impact-metrics.ts src/agent-router/naming-recall.ts src/agent-router/runtime.ts
git diff --check
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-scheduler-agent-router-lishuedu.json 2> /tmp/rp-scheduler-agent-router-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-scheduler-agent-router-cipherlink.json 2> /tmp/rp-scheduler-agent-router-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-scheduler-agent-router-exam.json 2> /tmp/rp-scheduler-agent-router-exam.err
node scripts/summarize-impact-benchmark.mjs /tmp/rp-scheduler-agent-router-lishuedu.json /tmp/rp-scheduler-agent-router-cipherlink.json /tmp/rp-scheduler-agent-router-exam.json
```

测试结果：

- Build: PASS。
- Targeted suite: `52` tests, `49` pass, `3` skipped, `0` fail。
- no-excuse scan: `No violations in 18 file(s).`
- `git diff --check`: PASS。
- 三仓 benchmark 命令：全部 exit `0`。
- 三仓 benchmark stderr：全部 `0` bytes。

## 指标对照

Phase 11 基线采用 `docs/java-lsp-mcp-agent-router-refactor-phase11-report-2026-07-04.md`。

| Project | Phase 11 recall | Phase 12 recall | Phase 11 precision | Phase 12 precision | Phase 11 P_read | Phase 12 P_read | Phase 12 R_read_must |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0.8456 | 0.8456 | 0.4509 | 0.4509 | 0.8667 | 0.8667 | 1.0000 |
| cipherlink | 0.8643 | 0.8643 | 0.3783 | 0.3783 | 0.7000 | 0.7000 | 1.0000 |
| exam-parent-v3 | 0.7350 | 0.7350 | 0.2944 | 0.2944 | 0.6333 | 0.6333 | 1.0000 |

Timing / payload:

| Project | reading payload avg | total payload avg | elapsed P50 | elapsed P95 |
| --- | ---: | ---: | ---: | ---: |
| lishuedu | 9070.4 | 42774.44 | 8.60ms | 198.07ms |
| cipherlink | 6239.8 | 40703.28 | 4.04ms | 102.87ms |
| exam-parent-v3 | 6596.2 | 39684.48 | 5.37ms | 185.42ms |

## 回归判断

无行为回归证据。

- 候选级指标：三仓 recall / precision 与 Phase 11 完全一致。
- readPlan 指标：三仓 P_read / R_read_must 与 Phase 11 完全一致。
- payload：reading payload 与 Phase 11 口径一致，total payload 只有运行时 JSON 统计波动。
- runtime：benchmark stderr 全空，没有场景加载异常或运行时 warning。
- structure：`src/agent-router/index.ts` 已不再直接包含 semantic verify、finalize scoring、readPlan selection、rg plan/parser、format/payload 组装、metrics delta、rg execution aggregation。

## 已知限制

- 本轮是结构拆分，不解决 exam remaining readplan-full、lishuedu cross-module-cold、registry/reflection edge。
- rg cache 状态仍在 `AgentRouter` 内，这是本轮目标要求；缓存键和命中计数逻辑仍属于调度器边界。
- 未运行全仓未知测试矩阵；本轮运行的是 agent-router/readPlan/ranking 定向 suite 和三仓 benchmark。

## 后续建议

1. 新增结构边前保持同一 hard gate：三仓 `R_read_must=1.0000`，exam `P_read >= 0.6333`，cipherlink recall 不低于 `0.8643`。
2. 后续优化重点回到更底层的 evidence graph：registry/reflection edge、method-scope cross-module edge，而不是再调 slot 或项目规则。
3. 若继续清理结构，可把 rg cache loader 从 `AgentRouter` 移到专门 cache adapter，但当前状态已经满足调度器主目标。

# Agent Router Refactor Phase 11 Report - 2026-07-04

## 结论

Phase 11 只做结构性重构，不改变 readPlan 行为、排序常量、candidate 生成策略或 benchmark 场景。

- `src/agent-router/index.ts` 从 `2109` 行降到 `1688` 行，先拆出 typeReference 候选收集、finalize scoring、候选 helper 和名称 helper。
- 三仓 cold-nolsp benchmark 与 Phase 10 基线一致：lishuedu / cipherlink / exam-parent-v3 的 recall、precision、P_read、R_read_must 均无变化。
- hard gate 保持：三仓 `R_read_must=1.0000`，benchmark stderr 全空。
- 定向测试保持：`52` tests，`49` pass，`3` skipped，`0` fail。

本轮没有新增仓库专有规则，没有新增打分信号，没有扩大 readPlan slot，也没有改 source-index schema。

## 改动范围

代码改动：

- `src/agent-router/candidate-helpers.ts`
  - 提取 `candidateFromFacts()`、`mergeCandidate()`、`breakdown()`、`scoreBase()`、`simpleTypeName()`、`matchesAny()`、`unique()` 等候选级共享工具。
- `src/agent-router/name-helpers.ts`
  - 提取 `classStem()`、`taskKeywordStems()`、`actionTailRaw()`、`capitalize()`。
  - rg plan 和 finalize scoring 共享同一套命名拆分规则，避免拆文件后复制规则。
- `src/agent-router/type-reference.ts`
  - 提取 `collectTypeReferenceCandidates()` 和 `TypeReferenceMetrics`。
  - 保持原 typeReference metrics 字段、计数口径、实现 lookup gating 不变。
- `src/agent-router/finalize-scoring.ts`
  - 提取 `finalizeScore()`、structural deltas、direct collaborator、method relation scoring helper。
  - 保持 `finalize.*` scoreBreakdown id、分数常量、suppressed 计数口径不变。
- `src/agent-router/index.ts`
  - Router 类保留流程编排、rg plan、readPlan、format、runtime IO。
  - typeReference 和 finalize scoring 改为调用纯函数模块。

## 验证命令

```bash
npm run build
node --test dist/agent-router-direct-reference.test.js dist/agent-router-implementation-lookup.test.js dist/agent-router.test.js dist/agent-router-read-plan-budget.test.js dist/ranking-signals.test.js
NODE_PATH=/Users/luo/Documents/github/codex-java-lsp-mcp/node_modules bun run /Users/luo/.codex/plugins/cache/sisyphuslabs/omo/4.15.1/skills/programming/scripts/typescript/check-no-excuse-rules.ts src/agent-router/index.ts src/agent-router/candidate-helpers.ts src/agent-router/name-helpers.ts src/agent-router/type-reference.ts src/agent-router/finalize-scoring.ts
git diff --check
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-refactor-agent-router-lishuedu.json 2> /tmp/rp-refactor-agent-router-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-refactor-agent-router-cipherlink.json 2> /tmp/rp-refactor-agent-router-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-refactor-agent-router-exam.json 2> /tmp/rp-refactor-agent-router-exam.err
node scripts/summarize-impact-benchmark.mjs /tmp/rp-refactor-agent-router-lishuedu.json /tmp/rp-refactor-agent-router-cipherlink.json /tmp/rp-refactor-agent-router-exam.json
```

测试结果：

- Build: PASS。
- Targeted suite: `52` tests, `49` pass, `3` skipped, `0` fail。
- no-excuse scan: `No violations in 5 file(s).`
- `git diff --check`: PASS。
- 三仓 benchmark stderr：全部 `0` bytes。

## 指标对照

Phase 10 基线采用 `docs/java-lsp-mcp-readplan-method-relation-phase10-report-2026-07-04.md`。

| Project | Phase 10 recall | Phase 11 recall | Phase 10 precision | Phase 11 precision | Phase 10 P_read | Phase 11 P_read | Phase 11 R_read_must |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0.8456 | 0.8456 | 0.4509 | 0.4509 | 0.8667 | 0.8667 | 1.0000 |
| cipherlink | 0.8643 | 0.8643 | 0.3783 | 0.3783 | 0.7000 | 0.7000 | 1.0000 |
| exam-parent-v3 | 0.7350 | 0.7350 | 0.2944 | 0.2944 | 0.6333 | 0.6333 | 1.0000 |

Timing / payload:

| Project | reading payload avg | total payload avg | elapsed P50 | elapsed P95 |
| --- | ---: | ---: | ---: | ---: |
| lishuedu | 9070.4 | 42800.92 | 10.63ms | 340.15ms |
| cipherlink | 6239.8 | 40726.12 | 9.93ms | 284.77ms |
| exam-parent-v3 | 6596.2 | 39716.52 | 8.16ms | 264.35ms |

## 回归判断

无行为回归证据。

- 候选级指标：三仓 recall / precision 与 Phase 10 完全一致。
- readPlan 指标：三仓 P_read / R_read_must 与 Phase 10 完全一致。
- payload：reading payload 与 Phase 10 口径一致，total payload 只有运行时 JSON 统计波动。
- runtime：benchmark stderr 全空，没有场景加载异常或运行时 warning。

## 已知限制

- `src/agent-router/index.ts` 仍有 `1688` 行，尚未拆 rg plan、readPlan、semantic verify、formatting。
- 本轮是 behavior-preserving refactor，不解决 exam remaining readplan-full、lishuedu cross-module-cold、registry/reflection edge。
- `candidate-helpers.ts` 当前聚合了候选合并和若干字符串小工具；如果后续继续拆 rg plan，可再把纯字符串 helper 从候选 helper 中细分。

## 后续建议

1. 先继续拆 `index.ts` 的 rg plan builder 和 readPlan builder，目标是让 Router 类只保留 orchestration。
2. 再做 registry/reflection edge proof，重点验证 `RuleEngine` 到 concrete executor 的非后缀事实边。
3. 新增结构边前保持同一 hard gate：三仓 `R_read_must=1.0000`，exam `P_read >= 0.6333`，cipherlink recall 不低于 `0.8643`。

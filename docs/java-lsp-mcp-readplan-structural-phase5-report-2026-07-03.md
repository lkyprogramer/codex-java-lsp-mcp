# ReadPlan Structural Evolution Phase 5 Report - 2026-07-03

## 结论

Phase 5 采用窄补强：补 method-scope referenced types，并在 generic policy 下为方法级接口引用补一跳实现类候选。

- 三仓 hard gate 均保持：`R_read_must=1.0000`，没有 must 读入退化。
- 三仓 macro 指标与 Phase 4 持平：本轮没有把新的结构边转化为总体 recall / precision / P_read 提升。
- 新增能力由单测证明：当前方法签名/方法体内的类型协作者不会被类级字段噪声挤掉；方法引用接口时，可召回其实现类作为 `typeGraph` 候选。
- 代价可观测：接口二跳扫描会让诊断 fixture 的 `typeReference.cacheMisses` 从 `2` 增至 `3`。这是候选补强成本，不是 hard regression。

本轮结论很明确：继续只扩候选池已经触到边际收益，下一阶段应转向 readPlan 排序/预算内选择，尤其处理 `should readplan-full`，而不是继续加 slot 或字符串权重。

## 改动范围

代码改动：

- `src/source-index.ts`
  - `JavaMethodFact` 增加 `referencedTypes`。
  - regex source facts 为每个方法提取方法级 referenced types。
  - `documentSymbol` 替换 method ranges 时保留 regex 提取出的 method referenced types。
  - snapshot schema 升至 `3`，避免复用缺少 method referenced types 的旧快照。
  - `findImplementers(typeName, scan)` 支持按需扫描未缓存实现类。
- `src/agent-router/index.ts`
  - typeReference expansion 优先使用 anchor 当前方法的 referenced types，再回退类级 referenced types。
  - generic policy 下，接口类型定义被加入候选后，额外补充其实现类为 `typeGraph` 候选。
  - lishuedu legacy policy 不启用本轮 generic 强化，避免扰动已守住的 legacy 排序。
- `src/agent-router.test.ts`
  - 新增方法级类型协作者测试：24 个类级噪声字段存在时，当前方法参数 DTO 仍以 `typeReference` 进入候选。
  - 新增方法级接口实现类测试：方法参数引用接口时，实现类以 `typeGraph` 进入候选。
  - 更新 typeReference 诊断指标期望，记录接口二跳新增一次 cache miss。

## 验证命令

```bash
npm run build && node --test dist/source-index.test.js dist/agent-router.test.js dist/read-plan-budget.test.js dist/routing-policy.test.js
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p5-final-lishuedu.json 2> /tmp/rp-p5-final-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p5-final-cipherlink.json 2> /tmp/rp-p5-final-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p5-final-exam.json 2> /tmp/rp-p5-final-exam.err
```

测试结果：

- Node tests: `66` tests, `62` pass, `4` skipped, `0` fail。
- 三仓 benchmark stderr：全部为空。
- Pure LOC check: `src/agent-router.test.ts=1013`, `src/agent-router/index.ts=1909`, `src/source-index.ts=828`。这些是既有大文件，本轮按最小变更落在现有边界内，未混入拆分重构。

## 仓库快照

| Repo | Path | Snapshot |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, base HEAD `fc76488198bd`, report created before final commit |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf903` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `638226ee50d3`, dirty working tree from external changes |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da826b4e` |

## 指标对照

Phase 4 基线采用 `docs/java-lsp-mcp-readplan-structural-phase4-report-2026-07-02.md`。

| Project | Phase 4 recall | Phase 5 recall | Phase 4 precision | Phase 5 precision | Phase 4 P_read | Phase 5 P_read | R_read_must | payload P50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0.8456 | 0.8456 | 0.4509 | 0.4509 | 0.8667 | 0.8667 | 1.0000 | 9863 |
| cipherlink | 0.8357 | 0.8357 | 0.3700 | 0.3700 | 0.7000 | 0.7000 | 1.0000 | 5109 |
| exam-parent-v3 | 0.6200 | 0.6200 | 0.2460 | 0.2460 | 0.5000 | 0.5000 | 1.0000 | 5610 |

Timing:

| Project | elapsed P50 | elapsed P95 | reading payload P95 |
| --- | ---: | ---: | ---: |
| lishuedu | 10.58ms | 461.51ms | 10492 |
| cipherlink | 7.58ms | 150.20ms | 8931 |
| exam-parent-v3 | 7.30ms | 238.29ms | 9387 |

## Attribution

基于最终 benchmark 每个场景最后一次 attempt 的 diagnostic attribution：

| Project | must miss | should hit | should readplan-full | should absent |
| --- | ---: | ---: | ---: | ---: |
| lishuedu | 0 | 4 | 6 | 5 |
| cipherlink | 0 | 8 | 8 | 4 |
| exam-parent-v3 | 0 | 4 | 5 | 9 |

解读：

- `must miss=0` 说明本轮没有破坏硬读入门槛。
- exam 的核心剩余问题不是 must，而是 `should absent=9` 与 `should readplan-full=5`。其中 `PositionService.java` 已是 `typeReference` 但仍可能被 `readplan-full` 挡住，`PositionServiceImpl.java` 仍是 absent。
- lishuedu / cipherlink 也主要受 `should readplan-full` 与 absent 影响，继续加候选边不一定进入 readPlan。

## 已知限制

- Phase 5 对当前 golden macro 指标没有净提升，只是补齐平台结构能力。
- 接口二跳目前只在 typeReference 已命中接口定义后触发；如果接口本身没有进入候选，二跳仍不会启动。
- `findImplementers(..., scan=true)` 会带来额外 rg/cache miss 成本，当前用 generic policy 和最多 8 个实现类限制影响面。
- lishuedu legacy policy 仍不能删除；parser/dto 场景还需要独立结构证据。

## 后续建议

1. 下一阶段从 readPlan selector 下手：对 `typeReference` / `typeGraph` / `importGraph` 中已经命中的 should 候选建立预算内排序规则，目标是降低 `should readplan-full`，不增加 readPlan slot。
2. 对 exam 的 `PositionServiceImpl` 做专门链路验证：先确认接口实现类为什么没有从当前真实场景触发二跳，再决定是 anchor 方法级类型未命中，还是实现类扫描根范围不足。
3. 对 absent 类问题补真实边来源：字段接收者、方法调用 receiver、构造器返回类型、repository/service implementation lookup，而不是继续调字符串权重。

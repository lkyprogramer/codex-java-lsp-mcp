# routing policy split 验收报告

日期：2026-07-02

## 结论

Task 11 已完成并通过 gate。

- `lishueduLegacyPolicy` 保留 lishuedu 专有字符串规则，`legacyRoutingPolicy` 作为兼容别名继续指向它。
- `genericJavaPolicy` 只保留通用 Java 结构规则，不包含 `ProductView / ParentBenefit / SignedUrl / ParsedTemplate / DiffBuilder / ExcelParserTest / BenefitEntitlementAssemblerTest` 等 lishuedu 专有 token。
- `AgentRouter` 构造时按 repo root 选择 policy：`lishuedu` 默认 legacy，其余 repo 默认 generic；`JAVA_LSP_ROUTING_POLICY` 可强制覆盖。
- 三仓真实 gate 通过：`R_read_must=1.0000` 均保持，cipherlink/exam 切到 generic 后 recall/precision 没有回退。
- lishuedu 强制 generic 的诊断出现明显回退，说明 legacy policy 仍承载 DTO/parser 场景的项目特定债务；本任务不新增字符串规则补洞。

## 输入状态

| repo | path | git state |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, commit `3e5a20b2b5f1` |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf903`, `develop...origin/develop [ahead 1]` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `638226ee50d3`, `develop...origin/develop [ahead 5]`, dirty working tree |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da826b4e`, `develop-v2...origin/develop-v2 [ahead 3]` |

cipherlink 的 dirty 文件为本任务外部既有改动，benchmark 只读，未触碰外部仓库文件。

## 本阶段实现

- `src/routing-policy.ts`
  - 抽出 `sharedCategoryBase`、`sharedConfidenceDeltas`、`sharedScoreRules`。
  - 新增 `lishueduLegacyPolicy`，保留原 legacy 规则集合。
  - 新增 `genericJavaPolicy`，移除 lishuedu 专有 token。
  - 新增 `resolveRoutingPolicy(repoRoot)`，优先尊重 `JAVA_LSP_ROUTING_POLICY`，否则按 repo basename 选择。

- `src/agent-router/index.ts`
  - `AgentRouter` 构造函数注入 `RoutingPolicy`。
  - 所有 `scoreBase` 调用、`parseRgOutput`、`finalizeScore` 都改为使用实例级 policy。

- `src/routing-policy.test.ts`
  - 覆盖 generic token 泄漏检查。
  - 覆盖 legacy 专有 rule id 保留。
  - 覆盖 env override 与 repo basename 选择逻辑。

## 验证命令

```bash
npm run build && npm test
git diff --check
npm run build
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-g1-lishuedu.json 2> /tmp/rp-g1-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-g1-cipherlink.json 2> /tmp/rp-g1-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-g1-exam.json 2> /tmp/rp-g1-exam.err
JAVA_LSP_ROUTING_POLICY=generic-java node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-g1-lishuedu-generic.json 2> /tmp/rp-g1-lishuedu-generic.err
```

## 测试结果

| Check | Result |
| --- | --- |
| build + unit tests | PASS: `npm run build && npm test` exited 0; 109 tests, 105 pass, 0 fail, 4 skipped. |
| diff hygiene | PASS: `git diff --check` exited 0. |
| benchmark build | PASS: `npm run build` exited 0 before real repo gate. |
| benchmark stderr | PASS: four gate stderr files all 0 bytes. |

## Benchmark gate

| project/run | default policy | baseline | recall | precision | P_read | R_read_must | readPlanItems | readingPayload P50 | elapsed P50/P95 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | lishuedu-legacy | Phase 3 cold-after | 0.8456 | 0.4509 | 0.8667 | 1.0000 | 6 | 9863 | 8.58 / 202.57 ms |
| cipherlink | generic-java | Phase 3 cold-empty | 0.8357 | 0.3700 | 0.7000 | 1.0000 | 6 | 5490 | 3.36 / 75.06 ms |
| exam-parent-v3 | generic-java | Phase 3 cold-empty | 0.5800 | 0.2335 | 0.4667 | 1.0000 | 6 | 5630 | 3.95 / 88.56 ms |

判定：

- lishuedu 默认 legacy 与 Phase 3 cold-after 基线一致，`R_read_must=1.0000`。
- cipherlink 默认 generic 与 Phase 3 cold-empty 基线一致，recall/precision 均无回退，`R_read_must=1.0000`。
- exam-parent-v3 默认 generic 与 Phase 3 cold-empty 基线一致，recall/precision 均无回退，`R_read_must=1.0000`。

## lishuedu generic 诊断

| run | recall | precision | P_read | R_read_must | readPlanItems | readingPayload P50 | elapsed P50/P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu legacy | 0.8456 | 0.4509 | 0.8667 | 1.0000 | 6 | 9863 | 8.58 / 202.57 ms |
| lishuedu forced generic | 0.7948 | 0.4314 | 0.8333 | 0.9333 | 6 | 9863 | 8.40 / 216.20 ms |
| delta generic - legacy | -0.0508 | -0.0194 | -0.0333 | -0.0667 | 0 | 0 | -0.18 / +13.63 ms |

回退场景：

| scenario | profile | regression |
| --- | --- | --- |
| `school-template-parser` / `SchoolTemplateImportParser#parse` | parser | recall `1.0000 -> 0.8571`; generic 下 `SchoolTemplateImportDiffBuilderTest.java` 从候选集中缺失，legacy 可召回但仍被 `readplan-full` 阻挡。 |
| `benefit-product-code-dto` / `ParentStudentBenefitItemResponse.productCode` | dto | `R_read_must 1.0000 -> 0.6667`; generic 下 `ParentStudentBenefitItemView.java` 被 `readplan-full` 阻挡，`ParentBenefitQueryAppServiceTest.java` 从候选集中缺失。 |

诊断结论：

- lishuedu 专有规则仍在 DTO/parser 场景承担真实排序作用，不能在本任务内删除 `lishueduLegacyPolicy`。
- 未把任何 lishuedu-only token 升回 shared。
- `Report` 未升回 shared：cipherlink/exam generic gate 无回退，当前没有证据证明它是跨 repo 通用概念。
- 后续要删除 legacy policy，应优先用 import graph 或 persisted semantic edge 真实补齐上述 DTO/parser 依赖，而不是继续扩展字符串规则。

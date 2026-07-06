# ReadPlan Method Relation Phase 10 Report - 2026-07-04

## 结论

Phase 10 按 `Bold Takes / First Proof Point` 做了第一条 Java method relation 纵切：从 regex source index 中抽取方法级 parameter / return / local receiver / field receiver 关系，并在最终排序中给当前方法关系候选一个可解释的 `finalize.method-relation` 结构分。

- exam-parent-v3 继续提升：recall `0.7100 -> 0.7350`，precision `0.2849 -> 0.2944`，P_read `0.6000 -> 0.6333`。
- `apply-info-save-basic-service` 中 `ApplyInfoUpdateDTO.java` 从 absent 变为 `readplan-full / typeReference`，达到“先召回候选池”的 proof point。
- `RuleEngine#execute` 当前方法能解析出 `RuleExecutor` local receiver relation；`RuleExecutor.java` 保持 readPlan hit / typeReference。
- `candidate-position-select` 三项继续全 hit：`PositionService.java`、`PositionPageDTO.java`、`PositionServiceImpl.java` 均在 readPlan。
- lishuedu / cipherlink hard gate 保持：三仓最终 `R_read_must=1.0000`，stderr 全空。

本轮没有新增仓库专有规则，没有扩大 readPlan slot，也没有把 `Executor` 后缀纳入实现类猜测。

## 改动范围

代码改动：

- `src/source-index-method-relations.ts`
  - 新增 `MethodRelationFact` 与 `parseMethodRelations()`。
  - 抽取方法参数、返回值、本地变量 receiver、字段 receiver。
  - 过滤常见 Java/JDK 容器和标量类型，降低非业务类型噪声。
- `src/source-index.ts`
  - `JavaMethodFact` 增加 `relations`。
  - source-index schema 从 `3` 升为 `4`，避免旧快照静默丢失 relation。
  - documentSymbol 覆盖方法名/范围时保留 regex relation；旧 v4 method symbol 缺字段时归一化为空数组。
- `src/agent-router/index.ts`
  - `collectTypeReferenceCandidates()` 将当前方法 relation type 放在普通 method referencedTypes 之前。
  - `finalizeScore()` 增加 `finalize.method-relation`：parameter/return `+160`，receiver `+120`。
  - 未把 `finalize.method-relation` 纳入 tail-truncation 强保护；中间验证证明纳入后会造成 cipherlink 候选级 recall 回退。
- `src/agent-router/read-plan-budget.ts`
  - readPlan utility score 纳入 `finalize.method-relation`，用于同分/同类候选排序。
- `src/agent-router-direct-reference.test.ts`
  - 覆盖 field receiver 被类字段噪声挤掉的场景。
  - 覆盖 method parameter relation 必须出现在 scoreBreakdown 的场景。
- `src/source-index.test.ts`
  - 覆盖 MethodRelationFact 解析。
  - 覆盖 v4 文件记录 + 旧 method symbol 缺 relation 字段的兼容读入。

## 红绿记录

- Red 1: `parseJavaSource extracts method relation facts` 初始编译失败，`JavaMethodFact.relations` 不存在。
- Green 1: 新增 method relation parser 后，`source-index.test.js` 通过。
- Red 2: `method receiver relations outrank noisy class fields` 初始失败，`CriticalRepository.java` 未被 typeReference 召回。
- Green 2: router 将 method relation type 放到 method referencedTypes 前后，该用例通过。
- Red 3: cipherlink benchmark 暴露旧 method symbol 快照缺 `referencedTypes`，运行时 `TypeError: methodFact.referencedTypes is not iterable`。
- Green 3: v4 symbol 兼容测试先失败为 `undefined !== []`，归一化后通过。
- Red 4: `method parameter relations survive persistence score noise` 初始失败，DTO 没有 `finalize.method-relation` scoreBreakdown。
- Green 4: finalize scoring 接入 method relation 后通过。

## 验证命令

```bash
npm run build && node --test dist/source-index.test.js dist/agent-router-direct-reference.test.js dist/agent-router-implementation-lookup.test.js dist/agent-router.test.js dist/agent-router-read-plan-budget.test.js dist/ranking-signals.test.js
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p10-method-rel-no-tail-lishuedu.json 2> /tmp/rp-p10-method-rel-no-tail-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p10-method-rel-no-tail-cipherlink.json 2> /tmp/rp-p10-method-rel-no-tail-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p10-method-rel-no-tail-exam.json 2> /tmp/rp-p10-method-rel-no-tail-exam.err
NODE_PATH=/Users/luo/Documents/github/codex-java-lsp-mcp/node_modules bun run /Users/luo/.codex/plugins/cache/sisyphuslabs/omo/4.15.1/skills/programming/scripts/typescript/check-no-excuse-rules.ts src/source-index-method-relations.ts src/source-index.ts src/source-index.test.ts src/agent-router/index.ts src/agent-router-direct-reference.test.ts src/agent-router/read-plan-budget.ts src/agent-router/ranking-signals.ts
git diff --check
```

测试结果：

- Targeted suite: `72` tests, `68` pass, `4` skipped, `0` fail。
- 三仓 benchmark stderr：全部为空。
- no-excuse scan: `No violations in 7 file(s).`
- `git diff --check`：通过。

## 仓库快照

| Repo | Path | Snapshot |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, base HEAD `d35fc07861ee` |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf903` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `84f0eb0fc94c` |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da826b4e` |

## 指标对照

Phase 9 基线采用 `docs/java-lsp-mcp-readplan-implementation-lookup-phase9-report-2026-07-04.md`。

| Project | Phase 9 recall | Phase 10 recall | Phase 9 precision | Phase 10 precision | Phase 9 P_read | Phase 10 P_read | Phase 10 R_read_must |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0.8456 | 0.8456 | 0.4509 | 0.4509 | 0.8667 | 0.8667 | 1.0000 |
| cipherlink | 0.8643 | 0.8643 | 0.3783 | 0.3783 | 0.7000 | 0.7000 | 1.0000 |
| exam-parent-v3 | 0.7100 | 0.7350 | 0.2849 | 0.2944 | 0.6000 | 0.6333 | 1.0000 |

Timing / payload:

| Project | reading payload avg | total payload avg | elapsed P50 | elapsed P95 |
| --- | ---: | ---: | ---: | ---: |
| lishuedu | 9070.4 | 42792.52 | 15.06ms | 338.53ms |
| cipherlink | 6239.8 | 40725.28 | 8.78ms | 202.09ms |
| exam-parent-v3 | 6596.2 | 39709.60 | 9.72ms | 319.83ms |

## Attribution

| Project | must miss | should hit | should readplan-full | should absent |
| --- | ---: | ---: | ---: | ---: |
| lishuedu | 0 | 4 | 6 | 5 |
| cipherlink | 0 | 8 | 9 | 3 |
| exam-parent-v3 | 0 | 8 | 5 | 5 |

exam 关键场景：

| Scenario | File | Phase 9 | Phase 10 |
| --- | --- | --- | --- |
| `candidate-position-select` | `PositionService.java` | hit / typeReference | hit / typeReference |
| `candidate-position-select` | `PositionPageDTO.java` | hit / typeReference | hit / typeReference |
| `candidate-position-select` | `PositionServiceImpl.java` | hit / implementation lookup | hit / seed |
| `apply-info-save-basic-service` | `ApplyInfoUpdateDTO.java` | absent / no-type-edge | readplan-full / typeReference |
| `apply-info-save-basic-service` | `PositionTemplate.java` | readplan-full / typeReference | hit / typeReference |
| `rule-engine-execute` | `RuleExecutor.java` | hit / typeReference | hit / typeReference |
| `rule-engine-execute` | `StringRuleExecutor.java` | readplan-full / rg | readplan-full / rg |
| `rule-engine-execute` | `NumberRuleExecute.java` | readplan-full / rg | readplan-full / rg |

## 中间失败与取舍

- 只升级 parser 但不升级 schema 时，外部仓库旧 v3 source-index 快照会让真实方法 `relations=[]`，benchmark 看不到新能力；因此 schema 升到 v4。
- 把 `finalize.method-relation` 纳入 tail-truncation 强保护时，exam 指标提升但 cipherlink recall 从 `0.8643` 掉到 `0.7726`；最终方案保留分数，不纳入 tail-protection，cipherlink 恢复 Phase 9 水平。
- `ApplyInfoUpdateDTO.java` 本轮只进入候选池，没有进入 readPlan；这是从 absent 到 readplan-full 的进步，但还不是最终读入解决。

## 已知限制

- Method relation 仍是 regex-fallback，不是完整 AST/LSP relation graph；泛型内部类型、链式调用返回类型、registry/reflection 映射仍未解析。
- `StringRuleExecutor.java` / `NumberRuleExecute.java` 仍未由 registry edge 召回进 readPlan；本轮只证明 `RuleExecutor` receiver relation，不猜 concrete executor 后缀。
- `src/agent-router/index.ts` 仍是既有超大文件，当前为 `1969` pure LOC；本轮为降低风险只做局部接线，后续继续加 edge 前应拆出 typeReference/finalize helper。
- `src/source-index.test.ts` 已超过 250 pure LOC，属于既有测试聚合问题；本轮新增测试沿用现有测试文件以减少新 harness。

## 后续建议

1. 做 registry/reflection edge proof：从 `RuleEngine` 到 `StringRuleExecutor` / `NumberRuleExecute` 不走后缀猜测，而走注册表、Spring bean 或策略 map 事实。
2. 做 readPlan selector 小步优化：让 method-parameter DTO 在不扩大 slot 的前提下从 readplan-full 进入 readPlan；硬门槛继续保留 `candidate-position-select` 三项 hit、exam `P_read >= 0.6000`、三仓 `R_read_must=1.0000`。
3. 拆分 `AgentRouter` 的 typeReference/finalize scoring 辅助模块，再继续添加新的结构边。

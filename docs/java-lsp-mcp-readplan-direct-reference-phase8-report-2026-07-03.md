# ReadPlan Direct Reference Phase 8 Report - 2026-07-03

## 结论

Phase 8 按 Phase 7 后续建议补了第一条真实结构边：service anchor 中已经被 `typeReference` 召回、且类型名出现在 anchor 源码 facts 里的 persistence direct reference，会获得 `finalize.direct-collaborator` 保护。

- exam-parent-v3 macro 指标提升：recall `0.6200 -> 0.6700`，precision `0.2460 -> 0.2724`，P_read `0.5333 -> 0.5667`。
- `apply-info-save-basic-service` 中 `ApplyInfo.java` 从 readplan-full 进入 readPlan hit。
- `ApplyInfoRepository.java`、`ExaminationTemplate.java` 从 absent 变成 typeReference/readplan-full。
- lishuedu / cipherlink macro 指标保持 Phase 7 水平。
- 三仓 hard gate 继续保持：`R_read_must=1.0000`，stderr 全空。

本轮没有扩大 readPlan slot，没有扩大 candidate limit，没有改变 controller 场景；中间验证过普通 DTO/response 全量保护会挤掉已有命中，最终收窄到 service + repository/template/entity。

## 改动范围

代码改动：

- `src/agent-router/index.ts`
  - `finalizeScore()` 中把直接协作者分数改为旧的 stem-based direct collaborator 与新的 direct referenced persistence type 二者取最大值。
  - 新增 `directReferencedTypeDelta()`：仅 service anchor 调用；候选必须已由 `typeReference` 召回；候选类型必须是 `Repository`、`Template`、`Entity` 后缀或位于 `/repository/`、`/entity/` 路径。
  - 复用现有 `finalize.direct-collaborator` 保护信号，不新增 readPlan slot。
- `src/agent-router-direct-reference.test.ts`
  - 新增红绿测试：在大量 cross-module import 噪声下，service anchor 明确字段引用的 `CriticalRepository.java` 不应从 `result.files` 尾部截断中消失。

## 验证命令

```bash
npm run build && node --test --test-name-pattern "direct type references survive noisy cross-module tail truncation" dist/agent-router-direct-reference.test.js
npm run build && node --test dist/source-index.test.js dist/agent-router.test.js dist/agent-router-direct-reference.test.js dist/read-plan-budget.test.js dist/routing-policy.test.js
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p8-lishuedu.json 2> /tmp/rp-p8-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p8-cipherlink.json 2> /tmp/rp-p8-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p8-exam.json 2> /tmp/rp-p8-exam.err
```

测试结果：

- Red test: 修改前 `CriticalRepository.java` 不在 `result.files`，断言 `false !== true`。
- Green test: 修改后该用例通过。
- Full targeted suite: `69` tests, `65` pass, `4` skipped, `0` fail。
- 三仓 benchmark stderr：全部为空。
- `git diff --check`：通过。
- Pure LOC: `src/agent-router-direct-reference.test.ts=61`；`src/agent-router/index.ts=1930` 为既有超大文件，本轮只做局部接线，未混入拆分重构。

## 仓库快照

| Repo | Path | Snapshot |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, base HEAD `e3ad81128c74`, report created before final commit |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf903` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `638226ee50d3` |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da826b4e` |

## 指标对照

Phase 7 基线采用 `docs/java-lsp-mcp-readplan-selector-phase7-report-2026-07-03.md`。

| Project | Phase 7 recall | Phase 8 recall | Phase 7 precision | Phase 8 precision | Phase 7 P_read | Phase 8 P_read | R_read_must | payload P50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0.8456 | 0.8456 | 0.4509 | 0.4509 | 0.8667 | 0.8667 | 1.0000 | 9863 |
| cipherlink | 0.8357 | 0.8357 | 0.3700 | 0.3700 | 0.7000 | 0.7000 | 1.0000 | 5109 |
| exam-parent-v3 | 0.6200 | 0.6700 | 0.2460 | 0.2724 | 0.5333 | 0.5667 | 1.0000 | 5733 |

Timing:

| Project | elapsed P50 | elapsed P95 | reading payload P95 |
| --- | ---: | ---: | ---: |
| lishuedu | 10.61ms | 203.32ms | 10492 |
| cipherlink | 5.94ms | 93.24ms | 8932 |
| exam-parent-v3 | 6.34ms | 133.24ms | 9647 |

## Attribution

| Project | must miss | should hit | should readplan-full | should absent |
| --- | ---: | ---: | ---: | ---: |
| lishuedu | 0 | 4 | 6 | 5 |
| cipherlink | 0 | 8 | 8 | 4 |
| exam-parent-v3 | 0 | 6 | 5 | 7 |

exam 代表场景变化：

| Scenario | File | Phase 7 | Phase 8 |
| --- | --- | --- | --- |
| `apply-info-save-basic-service` | `ApplyInfo.java` | readplan-full / typeReference | hit / typeReference |
| `apply-info-save-basic-service` | `ApplyInfoRepository.java` | absent | readplan-full / typeReference |
| `apply-info-save-basic-service` | `ExaminationTemplate.java` | absent | readplan-full / typeReference |
| `apply-info-save-basic-service` | `PositionTemplate.java` | readplan-full / typeReference | readplan-full / typeReference |
| `candidate-position-select` | `PositionService.java` | hit / typeReference | hit / typeReference |
| `candidate-position-select` | `PositionPageDTO.java` | hit / typeReference | hit / typeReference |

## 已知限制

- `ApplyInfoUpdateDTO.java` 仍是 absent。本轮刻意不保护普通 DTO/response，因为中间验证显示这会挤掉 controller 场景已有 readPlan hit。
- `PositionServiceImpl.java` 仍是 cross-module-cold，需要 implementation lookup，不属于本轮 direct reference 范围。
- `rule-engine-execute` 的 concrete executor 仍是 readplan-full；需要 golden 审计或 registry edge，不应继续加 naming 猜测。
- `src/agent-router/index.ts` 仍是既有大文件；后续如果继续加结构边，应优先拆出 finalize scoring helpers，而不是继续把逻辑堆进去。

## 后续建议

1. 下一轮做 implementation lookup：接口/抽象服务进入候选后，把同模块或 focus module 下的实现类作为 `typeGraph` 保护候选，目标是 `PositionServiceImpl.java`。
2. DTO/response 不进入本轮保护名单；如果要修 `ApplyInfoUpdateDTO.java`，应另开 method-parameter/readPlan selector 小任务，并以 `candidate-position-select` 不退化为硬门槛。
3. 对 `rule-engine-execute` 先审计 golden，再决定是否做 reflection/registry edge。

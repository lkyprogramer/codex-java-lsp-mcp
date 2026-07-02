# ReadPlan Structural Evolution Phase 4 Report - 2026-07-02

## 结论

Phase 4 采用窄修复：只把新的 typeReference 强化能力用于 generic policy，避免扰动 lishuedu legacy policy。

- exam-parent-v3 的候选级软退化得到部分修复：recall `0.5800 -> 0.6200`，precision `0.2335 -> 0.2460`，P_read `0.4667 -> 0.5000`。
- cipherlink 保持 Phase 3 水平：recall / precision / P_read / R_read_must 均无实质回退，reading payload P50 下降 `5490 -> 5109`。
- lishuedu 作为 legacy 守门仓保持 Phase 3 水平：R_read_must `1.0000`，recall/precision/P_read 只有四舍五入误差级差异。
- 本轮没有扩大 readPlan slot，没有新增 lishuedu 专有字符串规则，也没有把 legacy policy 默认删除。

## 改动范围

代码改动：

- `src/source-index.ts`
  - snapshot schema 升到 `2`，旧 schema 记录不再复用，避免旧索引缺少新结构字段造成候选顺序污染。
  - `referencedTypes` 保留源码出现顺序，不再字母排序。
  - `findTypeDefinitions()` 按请求类型顺序返回定义，再按 path 排序，避免源码前段关键协作者被 wildcard/path 噪声挤掉。
- `src/agent-router/index.ts`
  - `controller` 纳入 typeReference 扫描。
  - 对 generic policy，把 typeReference 证据合并回已有候选，而不是因为 rg/importGraph 已命中就跳过结构证据。
  - 只对 generic controller 的前段 referenced type 加源码顺序 bonus；lishuedu legacy 不启用该强化，避免已调稳的 legacy 排序回退。
- `src/agent-router.test.ts`
  - 新增源码顺序防回归：wildcard 噪声下，前段结构协作者仍进入候选。
  - 新增 controller 字段协作者防回归：`ExaminationController` 下 `PositionService` 不因 DTO 噪声被挤出。

## 中途失败与修正

本轮曾出现一次不可接受的 lishuedu hard gate 回退：

| 中间结果 | 问题 | 处理 |
| --- | --- | --- |
| `/tmp/rp-p4-lishuedu-after.json` | `R_read_must=0.9840`，`StorageGateway#getSignedUrl` 的 `AliyunOssGateway` / `StubStorageGateway` 进入候选但被挤出 readPlan | 将新增 typeReference 强化逻辑限制到非 `lishuedu-legacy` policy，最终恢复 `R_read_must=1.0000` |

这个失败说明：typeReference 强化是有效信号，但不能直接施加到 lishuedu legacy policy；legacy 仍是兼容层，不是继续泛化的实验场。

## 验证命令

```bash
npm run build && node --test dist/source-index.test.js dist/agent-router.test.js dist/read-plan-budget.test.js dist/routing-policy.test.js
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p4c-lishuedu-after.json 2> /tmp/rp-p4c-lishuedu-after.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p4c-cipherlink-after.json 2> /tmp/rp-p4c-cipherlink-after.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p4c-exam-after.json 2> /tmp/rp-p4c-exam-after.err
```

测试结果：

- Node tests: `64` tests, `60` pass, `4` skipped, `0` fail。
- 三仓 benchmark stderr：全部 `0` bytes。

## 仓库快照

| Repo | Path | Snapshot |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, base HEAD `f0c7873bc686`, report created before final commit |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf903`, `develop...origin/develop [ahead 1]` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `638226ee50d3`, `develop...origin/develop [ahead 5]`, dirty working tree |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da826b4e`, `develop-v2...origin/develop-v2 [ahead 3]` |

cipherlink dirty tree 是本任务外部既有改动，benchmark 只读，未修改外部仓库。

## 指标对照

Phase 3 基线采用 `docs/java-lsp-mcp-routing-policy-split-report-2026-07-02.md` / 用户总结中的 cold-after 指标。

| Project | Baseline recall | Phase 4 recall | Baseline precision | Phase 4 precision | Baseline P_read | Phase 4 P_read | R_read_must | payload P50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0.8456 | 0.8456 | 0.4509 | 0.4509 | 0.8667 | 0.8667 | 1.0000 | 9863 |
| cipherlink | 0.8357 | 0.8357 | 0.3700 | 0.3700 | 0.7000 | 0.7000 | 1.0000 | 5109 |
| exam-parent-v3 | 0.5800 | 0.6200 | 0.2335 | 0.2460 | 0.4667 | 0.5000 | 1.0000 | 5800 |

## Attribution

| Project | must miss | should hit | should readplan-full | should absent | no-type-edge | cross-module-cold | stale/low-value |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0 | 4 | 6 | 4 | 0 | 2 | 2 |
| cipherlink | 0 | 8 | 7 | 3 | 0 | 0 | 3 |
| exam-parent-v3 | 0 | 4 | 5 | 9 | 4 | 3 | 2 |

exam 的核心修复点：

- `candidate-position-select`: `PositionService.java` 从 absent/no-type-edge 变为 `source=typeReference`，且进入 readPlan。
- `PositionPageDTO.java` 仍是 `readplan-full`。
- `ApplyInfoUpdateDTO.java`、`ExamProgressServiceImpl.java` 仍是 `no-type-edge` absent，本轮未解决。

## 剩余限制

- exam 的候选级 recall 尚未完全恢复到改造前 `0.6300`，当前为 `0.6200`；本轮是部分修复。
- exam 仍有 `no-type-edge=4` 与 `cross-module-cold=3`。这些需要 method/field usage 或真实跨模块边来源，不能靠扩大 readPlan slot 解决。
- lishuedu `cross-module-cold=2` 仍存在，且 legacy policy 仍不能删除。
- cipherlink precision 仍停在 `0.3700`；本轮没有针对 cipherlink precision 做新收敛。

## 后续建议

1. 针对 exam `ApplyInfoServiceImpl#saveApplyBasicInfo` 做 method-scope type extraction：只提升当前方法签名、局部变量、字段接收者实际使用到的类型，避免类级 referencedTypes 噪声。
2. 针对 `PositionServiceImpl` / `CebPayService` 这类 cross-module-cold，补 interface-to-implementation 的二跳结构边，并用 readPlan quota 验证不挤掉 must。
3. lishuedu legacy 不继续叠加 generic 实验信号；后续若要删除 legacy，先补 parser/dto 的结构证据，而不是把专有词升回 shared。

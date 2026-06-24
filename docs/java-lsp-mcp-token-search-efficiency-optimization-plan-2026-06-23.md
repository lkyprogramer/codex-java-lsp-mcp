# Java LSP MCP 省 Token 与检索效率优化改造方案

生成时间：2026-06-23
适用仓库：`/Users/luo/Documents/github/codex-java-lsp-mcp`

## 0. 直接结论

这份反馈的大方向成立：当前 `java_impact` 相比 raw `rg` / no-LSP baseline 已经显著省 token，`cold-nolsp` 下 `rReadMust=1.0` 是可发布地基。但结合当前三套真实项目和源码真源后，优化优先级需要修正：

1. **已证实：** `lishuedu / cipherlink / exam-parent-v3` 相对 no-LSP baseline 省 token 分别为 `99.62% / 97.08% / 99.12%`，且 impact 路径 `rReadMust=1.0`。
2. **需要纠偏：** “readingPayload 占 67%，rawSearchPayload 只占 33%”不能作为三项目优先级依据。当前真实项目中 `rawSearchPayload` 占 impact 可见 payload 的 `51.3% - 70.3%`，不是小头。
3. **第一批应先做 standard payload 瘦身。** 清空 `rgSummary.sections[].files`、瘦身 standard `metrics/evidenceGaps` 的样本验证显示 raw JSON 可降约 `26.6% - 30.1%`，折算 total payload 预计三项目平均可降 `15%+`，且不改变候选、排序、readPlan。
4. **readPlan 方法边界优化要做，但不是当前最大杠杆。** `SourceIndex.methodAt()` 已有 `line/endLine`，但当前 golden 场景中很多 `positions[0]` 是类级/头部命中或短文件，保守方法边界估算对 lishuedu/cipherlink 收益很小，对 exam 明显。落地时应先修正 read position 选择，再严格方法边界裁剪。
5. **P2 path-only 暂不进第一批。** 当前三项目 golden 的 `testReadMode=defer` 下 readPlan 没有 P2 项，先做会增加语义风险但没有当前证据收益。
6. **检索质量调优与省 token 分开。** lishuedu precision/recall 的问题主要是跨模块召回策略和 `crossModulePolicy=auto` 的取舍；扩大召回会增加 payload，应作为独立质量目标。
7. **warm-auto 1500ms 归因需修正。** `prepareWarmState()` 的 `waitForProgressIdle()` 在 attempt 计时前执行，不应计入单次 `elapsedMs`。`warm-auto` 约 1500ms 更像 `semanticTimeoutMs=1500` 的语义阶段超时，不是 benchmark harness 等待。
8. **Batch 1 必须先打通 runtime 全链路口径。** `benchmark-agent-impact` 直调 `router.impact()`，真实 MCP 工具还会经过 `javaImpact()` 的 `withPhaseMs()` 回写；如果不让 `withPhaseMs()` 感知 verbosity，standard 可能在 benchmark 里变小、在线上又被 phase/output 字段加胖。

## 1. 核实依据

### 1.1 impact vs no-LSP token 对照

数据来自当前 `/tmp/java-lsp-bench-*-impact-runs5.json` 与 `/tmp/java-lsp-bench-*-nolsp-runs5.json`，均为 `cold-nolsp runs=5`。

| project | impact tokens | no-LSP tokens | saved % | impact rReadMust | no-LSP rReadMust | impact P_read | no-LSP P_read | impact P50 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| lishuedu | 5,977.0 | 1,572,293.5 | 99.62% | 1.00 | 0.26 | 0.77 | 0.17 | 7.13ms |
| cipherlink | 2,924.2 | 100,070.0 | 97.08% | 1.00 | 0.25 | 0.83 | 0.17 | 0.98ms |
| exam-parent-v3 | 3,811.0 | 431,472.4 | 99.12% | 1.00 | 0.50 | 0.67 | 0.43 | 1.04ms |

结论：省 token 的 baseline 结论成立；硬门槛 `rReadMust=1.0` 成立。

### 1.2 三项目 payload 真实拆分

| project | rawSearchPayload | readingPayload | totalAgentVisiblePayload | raw 占比 | reading 占比 |
|---|---:|---:|---:|---:|---:|
| lishuedu | 13,157.8 B | 10,749.4 B | 23,907.2 B | 55.0% | 45.0% |
| cipherlink | 8,220.4 B | 3,477.0 B | 11,697.4 B | 70.3% | 29.7% |
| exam-parent-v3 | 7,817.4 B | 7,425.0 B | 15,242.4 B | 51.3% | 48.7% |

结论：generic-java 的 `readingPayload=67%` 不能外推到真实三项目。当前最稳妥的第一杠杆反而是 raw JSON 瘦身。

### 1.3 standard raw payload attribution 样本

直接调用当前构建后的 router，对三项目现有 scenario 做字段删减模拟：

| project | scenario 数 | 原始 raw 均值 | 清空 `sections[].files` 后 | 仅 section files 降幅 | 再瘦身 metrics/gaps 后 | 总 raw 降幅 |
|---|---:|---:|---:|---:|---:|---:|
| lishuedu | 5 | 13,153.2 B | 10,247.8 B | 2,905.4 B | 9,322.4 B | 29.1% |
| cipherlink | 1 | 8,241.0 B | 6,664.0 B | 1,577.0 B | 5,757.0 B | 30.1% |
| exam-parent-v3 | 1 | 7,813.0 B | 6,638.0 B | 1,175.0 B | 5,733.0 B | 26.6% |

结论：`rgSummary.sections[].files` 与诊断型 metrics 在 standard 输出里确实有明显冗余，且这类改动不影响检索结果。

边界：这组 attribution 是 router 直调后的离线删字段模拟，不是 MCP `javaImpact()` runtime 全链路。Batch 0 必须补真实 verbosity 测量，避免 benchmark 高估 standard 瘦身收益。

### 1.4 readPlan 方法边界收益估算

当前源码 `buildReadPlan()` 使用固定窗口：P0 `24+44`、P1 `16+32`、P2 `10+22`。`SourceIndex.methodAt()` 已能返回 `line/endLine`，但当前 `methodAt()` 对不在方法内的行会 fallback 到“前一个方法”，落地时必须做 strict contains 校验。

按“优先选择落在方法体内的 position，再用方法边界裁剪”的估算：

| project | readPlan items | current reading bytes | 保守 padding 估算降幅 | 紧凑 padding 估算降幅 |
|---|---:|---:|---:|---:|
| lishuedu | 30 | 53,747 B | 1.2% | 7.4% |
| cipherlink | 6 | 3,868 B | 0.0% | 0.0% |
| exam-parent-v3 | 6 | 7,425 B | 14.6% | 23.9% |

结论：方法边界优化有价值，但要作为第二批，以 `rReadMust=1.0` 为硬门槛；不能按 20%-40% reading 降幅承诺三项目收益。

## 2. 源码事实

| 事实 | 真源 |
|---|---|
| `rawSearchPayload` 是 `JSON.stringify(result)`，`readingPayload` 是 readPlan 切片字节数，`estimatedTokens = total / 4` | `src/benchmark-agent-impact.ts:151-172`、`src/benchmark-agent-impact.ts:271-287` |
| `buildReadPlan()` 当前只用固定行窗口 | `src/agent-router/index.ts:596-612` |
| `SourceIndex.methodAt()` 有 `line/endLine`，但带前向 fallback | `src/source-index.ts:142-148` |
| regex 方法边界通过 `{}` 匹配推导，失败时最多兜底 80 行 | `src/source-index.ts:411-459` |
| `standard` 目前保留 `rgSummary.sections[].files`，只有 `compact` 清空 | `src/agent-router/index.ts:1382-1393` |
| 真实 MCP 工具会在 router 返回后通过 `withPhaseMs()` 合并 phaseMs 并写入 `metrics.outputBytes` | `src/tools/impact.ts:131-146` |
| `candidateLimit` balanced 默认可返回 16-26 个完整候选对象，readPlan 默认只读 6 个 | `src/agent-router/index.ts:1320-1346` |
| `waitForProgressIdle()` 在 benchmark attempts 前的 `prepareWarmState()` 执行 | `src/benchmark-agent-impact.ts:93-103`、`src/benchmark-agent-impact.ts:245-269` |

## 3. 反馈逐项判定

| 反馈点 | 判定 | 处理 |
|---|---|---|
| 当前相对 raw rg baseline 省 97%-99.6% token | 成立 | 保留为发布报告核心结论 |
| cold P50 1-4ms | 大体成立；本次 lishuedu P50 为 7.13ms，仍不是瓶颈 | 不做冷延迟优化 |
| `rReadMust=1.0` 达标 | 成立 | 所有后续改造必须保持 |
| Token 杠杆主要在 readingPayload 67% | 对 generic 样本成立，三真实项目不成立 | 优先级调整为 raw slimming 第一，readPlan 第二 |
| standard 默认清空 `sections[].files` | 成立且收益明确 | 第一批实施 |
| files[] 分层为完整对象 + overflow paths | 有收益，但会改变返回契约 | 第二阶段后置，先评估下游兼容 |
| metrics/evidenceGaps 默认瘦身 | 成立 | 第一批实施 |
| `withPhaseMs` 会把瘦身字段写回 | 成立 | Batch 1 前置修复；verbosity 必须覆盖 runtime 全链路 |
| P2 默认 path-only | 当前 golden 无 P2 readPlan 项 | 后置，等 P2 场景证据 |
| recall/precision 调优不要混入省 token | 成立 | 独立质量路线 |
| warm-auto 1501ms 是 harness wait | 不成立 | 单列为 semantic timeout 归因，不纳入 token 第一批 |

## 4. 可开发改造计划

### Batch 0 - Benchmark 报告可观测性补齐

目标：让每次优化能自测，不靠人工翻 JSON。

改造点：

| 任务 | 文件 | 开发要点 | 验收 |
|---|---|---|---|
| B0.1 增加 benchmark summary 脚本 | `scripts/` 或 `src/benchmark-agent-impact.ts` 附属脚本 | 读取 impact/no-LSP JSON，输出 raw/reading/total/tokens/saved%/quality 表 | 一条命令能复现 §1.1 与 §1.2 表格 |
| B0.2 增加真实 verbosity attribution | 可做成 `scripts/attribute-impact-payload.mjs` | 分别按 `standard/diagnostic/compact` 真实执行，优先覆盖 MCP `javaImpact()` 路径；不要只做离线删字段模拟 | 能给出每项目 raw JSON 组件占比，且 runtime 与 benchmark 口径一致 |
| B0.3 更新 benchmark guide | `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md` | 增加 payload split 表格和优化前后对比口径 | 报告能直接说明 token 降幅来自 raw 还是 reading |
| B0.4 benchmark/runtime 口径对齐 | `src/benchmark-agent-impact.ts`、`src/tools/impact.ts` 或脚本 | 要么让 benchmark 走 `javaImpact()`，要么增加等价 runtime smoke，至少验证 `withPhaseMs()` 不把 standard 字段写回 | 避免 benchmark 达标但 MCP 真实输出不省 token |

不改变 runtime 行为。该批可以和 Batch 1 同一 PR 做，但测试报告必须先有 baseline。

### Batch 1 - Standard 输出瘦身（P0）

目标：先拿确定收益，不改变候选集、排序、readPlan。

改造点：

| 任务 | 文件 | 开发要点 | 验收 |
|---|---|---|---|
| T1.0 runtime verbosity 前置修复 | `src/tools/impact.ts`、`src/agent-router/index.ts` | `withPhaseMs()` 必须尊重 `payload.options.verbosity`；standard 不回写已被瘦身的诊断型 `phaseMs/cache/rgCache/sourceFacts`，diagnostic 保持完整 | MCP 工具路径与 benchmark 路径 rawSearchPayload 同向下降 |
| T1.1 standard 清空 `rgSummary.sections[].files` | `src/agent-router/index.ts` | `diagnostic` 保留明细；`standard/compact` 只保留 `matchedFiles/totalMatches/rawBytes/cacheHits` 等计数 | `standard` rawSearchPayload 下降；`diagnostic` 与现状等价 |
| T1.2 standard metrics 瘦身 | `src/agent-router/index.ts` | standard 保留 `routingVersion/elapsedMs/semantic.skipped/semantic.timeout` 等决策字段；`phaseMs/cache/rgCache/sourceFacts` 仅 diagnostic | `standard` 不再输出诊断型缓存细节；`diagnostic` 仍可排障 |
| T1.3 evidenceGaps 短文本化 | `src/agent-router/index.ts` | standard 使用短句或短码；diagnostic 保留完整解释 | 字段仍可读，不输出 5 条固定长句 |
| T1.4 verbosity 单测 | `src/agent-router.test.ts`、`src/tools/impact.ts` 测试或新增测试 | 断言 diagnostic/standard/compact 三档契约，并覆盖 `withPhaseMs()` 回写后仍不破坏 standard | 保护 public 行为边界 |

建议实现语义：

```text
diagnostic: 当前完整输出，用于排障和调权
standard: 默认 agent 输出，保留决策必要字段，删除重复文件明细和诊断 metrics
compact: 在 standard 基础上继续截断 evidenceGaps，保持已有轻量模式
```

验收门槛：

- `npm run build && npm test` 通过。
- 三项目 `cold-nolsp strategy=impact runs=5` 的 `rReadMust=1.0`。
- Batch 1 不允许改变 `files[].path` 顺序和 `readPlan` 文件集合。
- 三项目 `totalAgentVisiblePayload` 每项目下降 `>=10%`，平均下降 `>=15%`；如未达标，payload attribution 必须说明差距来源。
- Batch 1 的 token 降幅必须同时在 benchmark 路径和 MCP `javaImpact()` runtime 路径成立；只跑 `router.impact()` 不算完整验收。
- 至少补一条 `generic-java warm-required` verbosity 回归，确认 warm 语义字段没有被 standard 误删。
- `diagnostic` 输出保留 `rgSummary.sections[].files`、`phaseMs/cache/rgCache/sourceFacts`，用于回滚排查。

### Batch 2 - readPlan 位置选择与方法边界裁剪（P1）

目标：降低 readingPayload，同时守住 `rReadMust=1.0`。

改造点：

| 任务 | 文件 | 开发要点 | 验收 |
|---|---|---|---|
| T2.1 read position 选择 | `src/agent-router/index.ts` | 不再无条件用 `positions[0]`；优先选落在真实方法体内的 position，target 文件优先 anchor 行 | 方法内命中的场景切片更接近目标代码 |
| T2.2 strict method window | `src/agent-router/index.ts`、`src/source-index.ts` 可选 helper | 仅当 `method.line <= position.line <= method.endLine` 时使用 `[method.line, method.endLine] + padding`；否则回退固定窗口 | 不会把类级命中错裁到前一个方法 |
| T2.3 只缩不扩 | `src/agent-router/index.ts` | 方法窗口只有比固定窗口更小时才采用；P2 暂不变 | readingPayload 不因方法窗口变大 |
| T2.4 边界测试 | `src/source-index.test.ts`、`src/agent-router.test.ts` | 覆盖短方法、长方法、类级命中、注解/多行签名、无方法命中 fallback | `rReadMust` 不回退 |

建议初始 padding：

```text
P0: method line - 12, endLine + 8
P1: method line - 8, endLine + 8
P2: 暂不使用方法边界
```

这是保守值，优先保护上下文；如果 benchmark 显示收益不足，再在独立小步中收紧到 P0 `4/4`、P1 `2/4`。不要暴露新 public 配置项，先用内部常量。

验收门槛：

- `rReadMust=1.0` 必须保持。
- `pRead >= baseline - 0.02`。
- `readingPayload` 不得上升；exam-parent-v3 应有可见下降。
- 如 lishuedu/cipherlink 降幅不明显，不判失败，但报告必须列出 strict method hit 覆盖率。

### Batch 3 - files[] overflow 分层（P2，条件执行）

目标：Batch 1 后如果 rawSearchPayload 仍明显偏高，再减少完整候选对象数量。

改造点：

| 任务 | 文件 | 开发要点 | 验收 |
|---|---|---|---|
| T3.1 定义兼容 schema | `src/agent-types.ts` | `files[]` 保留 readPlan 覆盖文件 + top 10 完整对象；新增 `overflowFiles: string[]` 只放路径 | schema 文档明确，diagnostic 可保留 full candidates |
| T3.2 下游风险检查 | README/docs/tests | 确认 MCP agent 主要依赖 `files[].id/path` 与 readPlan；诊断场景可切 `verbosity=diagnostic` | 不破坏默认 agent 阅读链路 |
| T3.3 benchmark 口径联动 | `src/benchmark-agent-impact.ts` | `evaluate()` 的 candidate coverage 必须把 `overflowFiles` 纳入候选集；readPlan 仍只按可读文件算 | rawSearchPayload 继续下降，precision/recall 不因隐藏 overflow 明细而失真 |

该批改变返回契约，必须单独 PR，不和 Batch 1 混在一起。

### Batch 4 - P2 path-only（P3，暂缓）

当前三项目 golden 下 readPlan P2 项为 0，不具备优先级。只有当新增 test/config/SQL 场景后，才考虑：

- `testReadMode=defer` 下 P2 默认只返回 path + hitLine，不计入 readingPayload。
- `testReadMode=include/priority` 仍保留切片。
- 验收必须覆盖测试优先任务，否则容易误伤验证计划。

## 5. 自测验证闭环

### 5.1 基线采集

```bash
npm run build
npm test

node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/java-lsp-bench-lishuedu-impact-before.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/java-lsp-bench-cipherlink-impact-before.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/java-lsp-bench-exam-impact-before.json
```

no-LSP 对照不需要每批都跑；发布报告和 benchmark guide 更新时再跑：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy no-lsp --runs 5 > /tmp/java-lsp-bench-lishuedu-nolsp.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy no-lsp --runs 5 > /tmp/java-lsp-bench-cipherlink-nolsp.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy no-lsp --runs 5 > /tmp/java-lsp-bench-exam-nolsp.json
```

### 5.2 每批改造后必须跑

```bash
npm run build
npm test

node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/java-lsp-bench-lishuedu-impact-after.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/java-lsp-bench-cipherlink-impact-after.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/java-lsp-bench-exam-impact-after.json
```

对比字段：

```text
rawSearchPayload
readingPayload
totalAgentVisiblePayload
estimatedTokens
precision
recall
pRead
rReadMust
elapsedMsP50
elapsedMsP95
```

Batch 1 还必须跑一个 warm verbosity 回归，确认 warm 语义字段没有被 standard 误删：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/github/codex-java-lsp-mcp/fixtures/generic-java --project-id generic-java --warm-state warm-required --strategy impact --runs 5 > /tmp/java-lsp-bench-generic-warm-required-after.json
```

runtime 全链路验证不能只靠上面的 benchmark。Batch 0/1 必须通过独立 attribution 脚本或 `javaImpact()` handler 测试输出 `standard/diagnostic/compact` 三档 raw 字节对比，并把 MCP runtime 路径结果写进最终报告。

### 5.3 发布判定

通过：

- `npm run build && npm test` 无失败。
- 三项目 `rReadMust=1.0`。
- Batch 1 不改变候选排序和 readPlan 文件集合。
- Batch 1 后三项目 total token 平均下降 `>=15%`，单项目下降 `>=10%`。
- Batch 1 后 MCP runtime path 与 benchmark path 的 standard payload 都下降；`withPhaseMs()` 不得重新引入 standard 已删除的诊断字段。
- `generic-java warm-required` verbosity 回归通过。
- Batch 2 后 `readingPayload` 不上升，且所有 readPlan hard gate 不变。
- `diagnostic` verbosity 能恢复完整排障信息。

失败：

- 任一项目 `rReadMust < 1.0`。
- `standard` 输出删除了 agent 决策必要字段，导致 readPlan 无法解释。
- benchmark path 通过但 MCP runtime path 未省 token。
- `elapsedMsP50` 增加超过 `10%` 且不能用 benchmark 噪声解释。
- 用 recall 扩张掩盖 token 优化效果。

## 6. 风险与回滚

| 风险 | 影响 | 控制 |
|---|---|---|
| standard payload 瘦身误删诊断字段 | 排障变难 | `diagnostic` 保留完整输出；测试断言 |
| `withPhaseMs()` 回写导致假绿 | benchmark 变小但 MCP runtime 不省 token | Batch 1 前置修复 runtime verbosity；增加 runtime attribution/smoke |
| 方法边界误裁剪 | `rReadMust` 或 agent 阅读质量下降 | strict contains 校验；只缩不扩；保守 padding；benchmark hard gate |
| files[] overflow 改契约 | 下游 agent 依赖完整候选对象 | 单独批次；默认不做；diagnostic full output |
| warm-auto 延迟误判 | 把语义 timeout 当 token 优化问题 | 单独开 semantic latency 任务，不混入本方案 |

回滚路径：

- Batch 1：把 `verbosity=standard` 的瘦身逻辑切回 diagnostic 等价即可，候选和 readPlan 无状态迁移。
- Batch 2：关闭 method-window 分支，回退固定 radius。
- Batch 3：保留 `overflowFiles` 但让 `files[]` 恢复完整对象，兼容回滚。

## 7. 不纳入本轮

- 不优化 cold 延迟；当前不是瓶颈。
- 不默认扩大 cross-module recall；质量调优另开方案。
- 不新增 public MCP tools。
- 不新增外部配置 DSL。
- 不安装替换 runtime；等 Batch 1/2 实施并通过上述验证后再执行重新安装。

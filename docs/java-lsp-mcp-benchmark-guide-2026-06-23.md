# Java LSP MCP Benchmark Guide

日期：2026-06-23

适用仓库：`/Users/luo/Documents/github/codex-java-lsp-mcp`

## 1. 目的

这套 benchmark 用来验证 `java_impact` 的效果质量，而不是只验证工具能返回结果。核心判断是：

- 候选集是否覆盖 golden 文件。
- `readPlan` 是否把 must-hit 文件放进 agent 实际会读的文件里。
- cold / warm 不同状态下是否能稳定运行。
- payload、估算 token、P50/P95 延迟是否可比较。
- 与不使用 LSP/MCP routing 的 raw `rg` baseline 相比，token 是否实际下降。

硬门槛是 `R_read_must = 1.0`：每个场景的 `golden.mustHit` 必须全部进入 `readPlan`。

## 2. 资产

场景文件：

- `golden/lishuedu.scenarios.jsonl`
- `golden/cipherlink.scenarios.jsonl`
- `golden/exam-parent-v3.scenarios.jsonl`
- `golden/generic-java.scenarios.jsonl`

通用 fixture：

- `fixtures/generic-java`

runner：

- `src/benchmark-agent-impact.ts`
- 构建后入口：`dist/benchmark-agent-impact.js`
- 汇总脚本：`scripts/summarize-impact-benchmark.mjs`
- MCP runtime payload attribution：`scripts/attribute-impact-payload.mjs`

## 3. 场景格式

每行是一个 JSON scenario：

```json
{
  "id": "rule-engine-execute",
  "name": "RuleEngine#execute",
  "projectId": "exam-parent-v3",
  "layoutProfile": "maven-reactor",
  "scenarioVersion": 1,
  "warmState": "cold-nolsp",
  "anchor": {
    "file": "exam-checkRule/src/main/java/com/hhtele/exam/check/rule/execute/RuleEngine.java",
    "line": 54,
    "column": 29,
    "profile": "service",
    "focusModules": ["exam-checkRule"],
    "taskKeywords": ["rule", "execute", "check"]
  },
  "golden": {
    "mustHit": [],
    "shouldHit": [],
    "side": []
  }
}
```

字段含义：

- `anchor`：传给 `java_impact` 的锚点。
- `golden.mustHit`：直接语义邻居，必须进入 `readPlan`。
- `golden.shouldHit`：一跳协作者，参与 precision/recall，但不是 hard gate。
- `golden.side`：测试、SQL、配置等旁路证据，按场景显式声明。
- `goldenMeta[path].shouldBlocksTask`：仅解释 `shouldHit` 缺口是否会卡真实任务完成，不参与 precision/recall 或 hard gate。

`mustHit` 只承载当前任务的硬邻居；DTO 细节、实现消费者、跨模块服务和测试证据优先放入 `shouldHit` / `side`，再用 `shouldBlocksTask` 标注是否影响真实排查。`side` 仍是 diagnostic-only，不进入 hard gate。

### 3.1 Golden 覆盖快照（2026-06-27）

本轮 readPlan attribution 扩充后，三个真实项目共 15 个场景：

| project | scenarios | profiles |
|---|---:|---|
| lishuedu | 5 | port, parser, repository, controller, dto |
| cipherlink | 5 | controller x2, repository, port, dto |
| exam-parent-v3 | 5 | service x2, controller, repository, dto |

跨三项目 profile 分布：

| profile | count | note |
|---|---:|---|
| controller | 4 | 覆盖管理/客户端入口与上传接口 |
| service | 2 | 覆盖规则引擎与报名保存主服务 |
| repository | 3 | 覆盖 MyBatis、Mongo Repository 与导出任务仓储 |
| dto | 3 | 覆盖响应 DTO、支付 DTO 与权益 DTO |
| port | 2 | 覆盖 storage 与 SMS gateway |
| parser | 1 | 仅 lishuedu 有高价值 parser 样本；不为覆盖指标虚构低价值 parser |

## 4. 指标

候选集：

```text
precision = hitFiles / returnedFiles
recall    = hitFiles / goldenAll
pCandAt5  = cand[:5] 命中率
pCandAt10 = cand[:10] 命中率
```

阅读计划：

```text
pRead      = readPlan 命中文件数 / readPlan 文件数
rReadMust  = readPlan 命中 mustHit 数 / mustHit 数
```

成本：

```text
rawSearchPayload
readingPayload
totalAgentVisiblePayload
estimatedTokens = totalAgentVisiblePayload / 4
rgRawBytesExposed      # no-lsp baseline 暴露给 agent 的 raw rg 输出
rgRawBytesSuppressed   # impact strategy 内部吸收但未暴露的 raw rg 输出
elapsedMs P50/P95
```

## 5. Warm State

| warmState | 语义策略 | 行为 |
|---|---|---|
| `cold-nolsp` | `fast` | 不启动 JDT LS，只测 SourceIndex + rg + routing |
| `cold-lsp` | `auto` | 启动 JDT LS，不等待 import idle |
| `warm-auto` | `auto` | 启动并等待 progress idle，允许轻量 semantic verify |
| `warm-required` | `required` | 预热 anchor document symbols，启用 required 语义路径 |

## 6. 常用命令

先构建：

```bash
npm run build
```

列出场景：

```bash
node dist/benchmark-agent-impact.js \
  --repo-root /Users/luo/Documents/github/codex-java-lsp-mcp/fixtures/generic-java \
  --project-id generic-java \
  --list-scenarios
```

四项目 cold 正式矩阵：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/java-lsp-bench-lishuedu-impact-runs5.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/java-lsp-bench-cipherlink-impact-runs5.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/java-lsp-bench-exam-impact-runs5.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/github/codex-java-lsp-mcp/fixtures/generic-java --project-id generic-java --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/java-lsp-bench-generic-impact-runs5.json
```

按 verbosity 对比 benchmark payload：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/java-lsp-bench-cipherlink-diagnostic.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity standard > /tmp/java-lsp-bench-cipherlink-standard.json
node scripts/summarize-impact-benchmark.mjs /tmp/java-lsp-bench-cipherlink-diagnostic.json /tmp/java-lsp-bench-cipherlink-standard.json
```

验证真实 MCP handler 路径，而不是只测 `router.impact()`：

```bash
npm run benchmark:impact-attribution -- --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink > /tmp/java-lsp-bench-cipherlink-attribution.json
```

三项目 no-LSP token baseline：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy no-lsp --runs 5 > /tmp/java-lsp-bench-lishuedu-nolsp-runs5.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy no-lsp --runs 5 > /tmp/java-lsp-bench-cipherlink-nolsp-runs5.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy no-lsp --runs 5 > /tmp/java-lsp-bench-exam-nolsp-runs5.json
```

generic warm 矩阵：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/github/codex-java-lsp-mcp/fixtures/generic-java --project-id generic-java --warm-state warm-auto --runs 5 > /tmp/java-lsp-bench-generic-warm-auto-runs5.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/github/codex-java-lsp-mcp/fixtures/generic-java --project-id generic-java --warm-state warm-required --runs 5 > /tmp/java-lsp-bench-generic-warm-required-runs5.json
```

汇总 JSON：

```bash
node - <<'NODE'
const fs = require("fs");
for (const [name, file] of [
  ["lishuedu", "/tmp/java-lsp-bench-lishuedu-impact-runs5.json"],
  ["cipherlink", "/tmp/java-lsp-bench-cipherlink-impact-runs5.json"],
  ["exam", "/tmp/java-lsp-bench-exam-impact-runs5.json"],
  ["generic", "/tmp/java-lsp-bench-generic-impact-runs5.json"]
]) {
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(name, JSON.stringify({
    projectId: p.metadata.projectId,
    warmState: p.metadata.warmState,
    runs: p.metadata.runs,
    precision: p.totals.precision,
    recall: p.totals.recall,
    rReadMust: p.totals.rReadMust,
    pRead: p.totals.pRead,
    elapsedMsP50: p.totals.elapsedMsP50,
    elapsedMsP95: p.totals.elapsedMsP95
  }));
}
NODE
```

汇总 impact vs no-LSP：

```bash
node - <<'NODE'
const fs = require("fs");
for (const [name, impactFile, noLspFile] of [
  ["lishuedu", "/tmp/java-lsp-bench-lishuedu-impact-runs5.json", "/tmp/java-lsp-bench-lishuedu-nolsp-runs5.json"],
  ["cipherlink", "/tmp/java-lsp-bench-cipherlink-impact-runs5.json", "/tmp/java-lsp-bench-cipherlink-nolsp-runs5.json"],
  ["exam-parent-v3", "/tmp/java-lsp-bench-exam-impact-runs5.json", "/tmp/java-lsp-bench-exam-nolsp-runs5.json"]
]) {
  const impact = JSON.parse(fs.readFileSync(impactFile, "utf8")).totals;
  const noLsp = JSON.parse(fs.readFileSync(noLspFile, "utf8")).totals;
  const savedTokens = noLsp.estimatedTokens - impact.estimatedTokens;
  console.log(name, JSON.stringify({
    impactTokens: impact.estimatedTokens,
    noLspTokens: noLsp.estimatedTokens,
    savedTokens,
    savedPct: savedTokens / noLsp.estimatedTokens,
    impactRReadMust: impact.rReadMust,
    noLspRReadMust: noLsp.rReadMust
  }));
}
NODE
```

## 7. 本轮验证快照（2026-06-24）

命令：

```bash
npm run build && npm test
```

结果：

```text
48 tests
44 pass
4 skip
0 fail
```

本轮未重跑 no-LSP baseline；token 优化验收使用本地 `main` 临时 worktree 作为 before，对当前分支作为 after，均为 `cold-nolsp strategy=impact runs=5`。

| project | before total | after total | total drop | raw drop | R_read_must | P_read | precision | recall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| lishuedu | 23,870.88 B | 20,281.04 B | 15.04% | 27.36% | 1.0000 | 0.7667 | 0.3144 | 0.7756 |
| cipherlink | 12,110.40 B | 9,835.20 B | 18.79% | 27.60% | 1.0000 | 0.8333 | 0.5455 | 1.0000 |
| exam-parent-v3 | 15,235.40 B | 13,368.20 B | 12.26% | 23.91% | 1.0000 | 0.6667 | 0.5833 | 1.0000 |

汇总：

```text
weighted total drop: 15.10%
average project drop: 15.36%
all project R_read_must: 1.0
```

MCP handler runtime attribution 验证了 `withPhaseMs()` 不会把 standard 加胖：

| project | standard bytes | diagnostic bytes | standard phase/cache/sourceFacts | diagnostic phase/cache/sourceFacts |
|---|---:|---:|---|---|
| lishuedu | 9,532.80 B | 29,303.40 B | absent | present |
| cipherlink | 5,968.00 B | 16,734.00 B | absent | present |
| exam-parent-v3 | 5,944.00 B | 16,690.00 B | absent | present |

`generic-java warm-required runs=5` 使用临时 clean `JDTLS_DATA_DIR/JDTLS_LOG_DIR` 重跑通过：

| warmState | semanticPolicy | precision | recall | R_read_must | P_read | total payload | estimatedTokens |
|---|---|---:|---:|---:|---:|---:|---:|
| warm-required | required | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 3,426.40 B | 857 |

备注：一次普通 workspace 重跑出现过 `initialize` 120s 超时；检查日志后使用 clean JDT LS workspace 重跑通过，判定为 JDT LS workspace/runtime 临时状态，不是 payload 改造退化。

Batch 2 strict method window 追加验证，使用 Batch 1 after 结果作为 before，均为 `cold-nolsp strategy=impact runs=5`：

| project | reading before | reading after | reading drop | total drop | R_read_must | P_read |
|---|---:|---:|---:|---:|---:|---:|
| lishuedu | 10,749.40 B | 10,475.00 B | 2.55% | 1.35% | 1.0000 | 0.7667 |
| cipherlink | 3,868.00 B | 3,867.00 B | 0.03% | 0.01% | 1.0000 | 0.8333 |
| exam-parent-v3 | 7,425.00 B | 7,425.00 B | 0.00% | 0.00% | 1.0000 | 0.6667 |

汇总：

```text
weighted reading drop: 1.25%
weighted total drop: 0.63%
all project R_read_must: 1.0
```

Batch 3 cold-path ranking precision 验证（2026-06-26），before = `753e947`（Batch 2 after），after = `codex/cold-path-ranking-precision` 当前实现，均为 `cold-nolsp strategy=impact runs=5`：

```bash
npm run build
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/bench-lishuedu-before.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/bench-cipherlink-before.json
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 > /tmp/bench-exam-parent-v3-before.json
# after 使用当前分支同参数输出到 /tmp/bench-*-after.json
node scripts/summarize-impact-benchmark.mjs /tmp/bench-lishuedu-before.json /tmp/bench-lishuedu-after.json
node scripts/summarize-impact-benchmark.mjs /tmp/bench-cipherlink-before.json /tmp/bench-cipherlink-after.json
node scripts/summarize-impact-benchmark.mjs /tmp/bench-exam-parent-v3-before.json /tmp/bench-exam-parent-v3-after.json
```

结果：

| project | raw before | raw after | raw drop | returnedFiles before | after | precision before | after | recall before | after | P_read before | after | R_read_must |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| lishuedu | 9,531.92 B | 7,745.64 B | 18.74% | 20.80 | 15.80 | 0.3144 | 0.4127 | 0.7756 | 0.7756 | 0.7667 | 0.8000 | 1.0000 |
| cipherlink | 5,967.20 B | 5,967.20 B | 0.00% | 11.00 | 11.00 | 0.5455 | 0.5455 | 1.0000 | 1.0000 | 0.8333 | 0.8333 | 1.0000 |
| exam-parent-v3 | 5,943.20 B | 5,943.20 B | 0.00% | 12.00 | 12.00 | 0.5833 | 0.5833 | 1.0000 | 1.0000 | 0.6667 | 0.6667 | 1.0000 |

汇总：

```text
weighted raw drop: 8.33%
weighted total drop: 3.64%
weighted estimated token drop: 3.64%
all project recall: no regression
all project R_read_must: 1.0
```

最终 L2 参数与口径：

- `cliff ratio = 0.5`。
- `dynamicBudget = min(floor(strongStructuralCount * 0.5), 4)`。
- `floor = max(readPlanCovered.size, 8)`。
- `minStrongStructuralEvidence = 6`；强结构证据少于 6 时不做尾部裁剪，只做 readPlan-aware candidateLimit。
- L2 protected 只包含 readPlan 覆盖候选和强结构信号：`finalize.direct-collaborator`、`finalize.type-relation`、`finalize.structural.type-symmetric`、`finalize.structural.kind`。
- `finalize.structural.annotation`、`finalize.structural.package`、`finalize.focus-module` 只加分，不保护。实测证明 annotation/focus 在 lishuedu 大模块上会保护过多同层/同模块候选，使 raw payload 反增。
- Batch C（字符串权重下调）未执行；Batch A+B 已达到 lishuedu precision/raw 目标，并且三项目 recall/readPlan hard gate 稳定。

lishuedu per-scenario 变化：

| scenario | returnedFiles | raw payload | precision | recall | readingPayload | P_read | R_read_must |
|---|---:|---:|---:|---:|---:|---:|---:|
| StorageGateway#getSignedUrl | 20 -> 11 | 9,165.4 -> 6,084.4 | 0.3000 -> 0.5455 | 0.6000 -> 0.6000 | 7,726 -> 7,726 | 1.0000 -> 1.0000 | 1.0000 |
| SchoolTemplateImportParser#parse | 18 -> 18 | 8,272.2 -> 8,272.2 | 0.3889 -> 0.3889 | 1.0000 -> 1.0000 | 12,450 -> 12,450 | 0.8333 -> 0.8333 | 1.0000 |
| ReportBatchExportTaskRepository#findReusableReadyZip | 26 -> 10 | 12,074.6 -> 6,202.2 | 0.1538 -> 0.4000 | 0.5000 -> 0.5000 | 9,864 -> 9,864 | 0.6667 -> 0.6667 | 1.0000 |
| SchoolTemplateImportController#confirm | 16 -> 16 | 7,770.2 -> 7,792.2 | 0.4375 -> 0.4375 | 1.0000 -> 1.0000 | 11,715 -> 12,603 | 0.6667 -> 0.8333 | 1.0000 |
| ParentStudentBenefitItemResponse.productCode | 24 -> 24 | 10,377.2 -> 10,377.2 | 0.2917 -> 0.2917 | 0.7778 -> 0.7778 | 10,620 -> 10,742 | 0.6667 -> 0.6667 | 1.0000 |

readPlan diff 结论：

- 只有 lishuedu 的 `SchoolTemplateImportController#confirm` 与 `ParentStudentBenefitItemResponse.productCode` 出现 readPlan 排序变化；三项目 `R_read_must` 均保持 `1.0`。
- `SchoolTemplateImportController#confirm`：新增 `SchoolTemplateImportAppService` 进入 readPlan，替换原第 6 位 `SchoolResponse`；`P_read` 从 `0.6667` 提升到 `0.8333`，reading 增加 888 B。
- `ParentStudentBenefitItemResponse.productCode`：`BenefitEntitlementAssembler` 提前，`BenefitAdminAssembler` 替换 `CmccProductSubjectMappingQueryAppService`；`P_read` 持平 `0.6667`，reading 增加 122 B。
- 这两个 readPlan 变化均由 L1 结构加分引起，不是 L2 截断误删；候选 recall 不降，must-hit 全部仍在 readPlan。

### 历史验证快照（2026-06-23）

命令：

```bash
npm run build && npm test
```

结果：

```text
47 tests
43 pass
4 skip
0 fail
```

四项目 `cold-nolsp strategy=impact runs=5`：

| project | precision | recall | R_read_must | P_read | elapsed P50 | elapsed P95 |
|---|---:|---:|---:|---:|---:|---:|
| lishuedu | 0.3144 | 0.7756 | 1.0000 | 0.7667 | 3.72ms | 67.29ms |
| cipherlink | 0.5455 | 1.0000 | 1.0000 | 0.8333 | 1.58ms | 20.46ms |
| exam-parent-v3 | 0.5833 | 1.0000 | 1.0000 | 0.6667 | 1.11ms | 21.40ms |
| generic-java | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.88ms | 38.83ms |

三项目 `impact` vs `no-lsp` token 对照，均为 `cold-nolsp runs=5`：

| project | impact tokens | no-LSP tokens | saved tokens | saved % | impact R_read_must | no-LSP R_read_must |
|---|---:|---:|---:|---:|---:|---:|
| lishuedu | 5,976.96 | 1,572,293.48 | 1,566,316.52 | 99.62% | 1.0000 | 0.2567 |
| cipherlink | 2,924.20 | 100,070.00 | 97,145.80 | 97.08% | 1.0000 | 0.2500 |
| exam-parent-v3 | 3,811.00 | 431,472.40 | 427,661.40 | 99.12% | 1.0000 | 0.5000 |

对应 raw `rg` 暴露/吸收：

| project | impact rgRawBytesSuppressed | no-LSP rgRawBytesExposed |
|---|---:|---:|
| lishuedu | 192,321.80 | 6,279,131.00 |
| cipherlink | 12,923.00 | 393,778.00 |
| exam-parent-v3 | 23,352.00 | 1,718,893.00 |

`generic-java runs=5` warm：

| warmState | semanticPolicy | precision | recall | R_read_must | P_read | elapsed P50 | elapsed P95 |
|---|---|---:|---:|---:|---:|---:|---:|
| warm-auto | auto | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1501.53ms | 1586.83ms |
| warm-required | required | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 0.80ms | 892.48ms |

### readPlan semantic overflow 修复验证（2026-06-26）

本轮验证目标：确认 `semanticPolicy=required` 引入 semanticLocations/references/typeHierarchy 候选后，不再挤出 non-LSP readPlan 邻居。

| project | warmState | recall | precision | P_read | R_read_must | elapsedMs | total payload | estimatedTokens |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| lishuedu | cold-nolsp | 0.7756 | 0.4127 | 0.8000 | 1.0000 | 19.88 ms | 18432.24 B | 4608 |
| lishuedu | warm-required | 0.8256 | 0.4030 | 0.8000 | 1.0000 | 603.26 ms | 19077.96 B | 4770 |

结论：接受 `warm-required` 作为 precision/recall mode 的可选增强；它将 lishuedu recall 从 `0.7756` 提升到 `0.8256`，同时 `R_read_must` 从修复前的 `0.7000` 恢复到 `1.0000`。默认 `warm-auto` 启用范围本轮不扩大。

## 8. 判定规则

通过：

- `npm run build && npm test` 无失败。
- 每个项目 cold matrix 的 `R_read_must = 1.0`。
- 三项目 no-LSP baseline 已输出 `rgRawBytesExposed`、`estimatedTokens`、`R_read_must`，可与 `impact` strategy A/B。
- benchmark JSON 包含 `metadata.runtimeBuild`、`repoCommit`、`projectId`、`layoutProfile`、`warmState`、`runs`。
- `runs >= 5` 的报告必须使用 P50/P95，不看单次耗时下结论。

失败：

- 任一 scenario 的 `R_read_must < 1.0`。
- runner 因 JDT LS timeout 直接退出。
- golden 文件缺失或 scenario 与 `projectId` 不匹配。
- 只看候选集 precision，未检查 `readPlan`。

## 9. 已知边界

- 真实项目的 warm-auto / warm-required 矩阵未作为本轮固定门槛；当前只用 `generic-java` 验证 warm harness。
- no-LSP baseline 是固定 raw `rg` + 前 6 个命中文件片段的可复现代理，不代表人类或模型手工多轮搜索的最优策略。
- golden 是人工标注资产；业务代码大幅变化后，应更新 `repoCommit` 或重新确认 must/should/side。
- `precision` 仍受 golden 覆盖范围影响，发布门槛以 `R_read_must` 为硬指标。

# readPlan platform proof report (2026-07-01)

## Summary

本轮验证的结论不是“readPlan 已到绝对天花板”，而是：

- 默认 cold `impact` 路径继续成立：三个真实项目 `R_read_must=1.0000`，没有 must 文件缺失。
- `warm-auto` 的 no-seed 固定成本已经消失：lishuedu `warm-auto` P95 为 `76.41ms`，`semantic.used=false` 且 `semantic.verifyUsed=false`。
- `warm-required` 仍不能默认化：三项目 P95 仍为 `1735.60ms / 1524.66ms / 1506.33ms`，top session phase 均为 `textDocument/references`，超过 `800ms` first-touch SLO。
- 继续做 warm 调度、profile-aware warm 或 Task 3/4/5 图扩张仍不是第一刀。
- 但 `exam-parent-v3` 暴露了 material `shouldBlocksTask` 缺口：cold 下 14 个 `shouldBlocksTask=true` 文件为 `absent`，warm-required 仍有 12 个 `absent`。下一步应做 attribution v2，把 `absent` 细分为 type-edge、implementer、cross-module 或 golden 质量问题，再决定是否触发 Task 3/4/5。

## Scope

- MCP public tools：未改。
- Router 行为：未改。
- Benchmark schema：未改。
- Golden：仅同步 `cipherlink` 当前 controller 包迁移后的路径，从 `interfaces/` 改为 `interfaces/web/`。
- 新增产物：本报告。

## Snapshot

| item | value |
|---|---|
| codex-java-lsp-mcp runtime build | `d3fa358605a4` |
| lishuedu repoCommit | `1f556efdf903` |
| cipherlink repoCommit | `c4ddf3be4858` |
| exam-parent-v3 repoCommit | `1e08da826b4e` |
| golden scenarios | 15 real scenarios: lishuedu 5, cipherlink 5, exam-parent-v3 5 |
| profile distribution | controller 4, service 2, repository 3, dto 3, port 2, parser 1 |

## Verification Matrix

| project | warmState | precision | recall | R_read_must | P_read | elapsed P50 | elapsed P95 | top session phase | semantic.used | semantic.timeout | timeout log |
|---|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| lishuedu | cold-nolsp | 0.4127 | 0.7756 | 1.0000 | 0.8000 | 6.99 | 70.95 | `N/A` | false | false | false |
| cipherlink | cold-nolsp | 0.4230 | 0.7885 | 1.0000 | 0.5333 | 2.20 | 31.46 | `N/A` | false | false | false |
| exam-parent-v3 | cold-nolsp | 0.3333 | 0.5217 | 1.0000 | 0.4000 | 1.54 | 39.76 | `N/A` | false | false | false |
| lishuedu | warm-auto | 0.4127 | 0.7756 | 1.0000 | 0.8000 | 7.09 | 76.41 | `N/A` | false | false | false |
| lishuedu | warm-required | 0.4272 | 0.8256 | 1.0000 | 0.8000 | 8.91 | 1735.60 | `textDocument/references 10445.00ms` | true | true | false |
| cipherlink | warm-required | 0.4316 | 0.8171 | 1.0000 | 0.5333 | 4.80 | 1524.66 | `textDocument/references 12725.00ms` | true | true | false |
| exam-parent-v3 | warm-required | 0.3473 | 0.5883 | 1.0000 | 0.4000 | 2.30 | 1506.33 | `textDocument/references 8180.00ms` | true | true | false |

## Attribution Audit

每行按 scenario 首个 attempt 去重统计，避免 `runs=5` 放大缺口数量。

| project | warmState | must hit | must missing | shouldBlocksTask hit | shouldBlocksTask readplan-full | shouldBlocksTask absent |
|---|---|---:|---:|---:|---:|---:|
| lishuedu | cold-nolsp | 20 | 0 | 4 | 3 | 7 |
| cipherlink | cold-nolsp | 13 | 0 | 3 | 10 | 5 |
| exam-parent-v3 | cold-nolsp | 10 | 0 | 1 | 3 | 14 |
| lishuedu | warm-auto | 20 | 0 | 4 | 3 | 7 |
| lishuedu | warm-required | 20 | 0 | 4 | 5 | 5 |
| cipherlink | warm-required | 13 | 0 | 3 | 10 | 5 |
| exam-parent-v3 | warm-required | 10 | 0 | 1 | 5 | 12 |

### exam-parent-v3 material gaps

`exam-parent-v3` 的低 recall 不能再简单归类为 side 或无关 should。以下 `shouldBlocksTask=true` 文件在 cold 下未进入候选或未进入 readPlan：

| scenario | blockedBy | files |
|---|---|---|
| `RuleEngine#execute` | `readplan-full` | `StringRuleExecutor`, `NumberRuleExecute` |
| `ExaminationController#selectApplySite` | `absent` | `PositionService`, `PositionPageDTO`, `PositionServiceImpl` |
| `ApplyInfoServiceImpl#saveApplyBasicInfo` | `absent` | `ApplyInfoUpdateDTO`, `ApplyInfo`, `ApplyInfoRepository`, `ExaminationTemplate`, `PositionTemplate` |
| `PositionRepository#existsByExamId` | `readplan-full` / `absent` | `Position`, `ExamProgressServiceImpl`, `ApplyFormRepository`, `ExamPrepareVO` |
| `CebOrderRequest/CebOrderCreateResponse` | `absent` | `CebPayServiceImpl`, `CebPayService`, `CebCommonRequest` |

warm-required 能把少量 `absent` 变成 `readplan-full`，但没有把这个项目的 material gap 消掉，同时 P95 仍超过 `1500ms`。因此它不是默认化解法。

## Decision

### Keep

- 继续把 cold `impact` 作为默认路径。
- 继续把 `R_read_must=1.0000` 作为 hard gate。
- `warm-required` 保留为显式 precision/recall mode，不默认化。
- `warm-auto` 不扩大 profile 覆盖；当前 no-seed 路径已经不应触发 semantic verify。

### Do Next

下一刀是 attribution v2，不是 router 召回扩张：

1. 在 diagnostic benchmark 中把 `absent` 进一步细分为 `not-recalled-implementer`、`no-type-edge`、`cross-module-cold`、`profile-gate`、`golden-stale-or-low-value`。
2. 优先对 `exam-parent-v3` 的 `shouldBlocksTask absent` 做分类，因为它是当前平台判断最强的反例。
3. 只有分类后满足门槛，才触发对应实现：
   - implementer 缺口重复出现，才做 Task 3。
   - dto/port/repository 类型边缺口重复出现，才做 Task 4。
   - warm reference 命中但被跨模块策略压低，才做 Task 5。

### Do Not Do Now

- 不做 warm references 并发/批量调度。
- 不做 profile-aware warm 默认化。
- 不做 timeout-degrade。
- 不做 Task 3/4/5 的无条件实现。
- 不继续调字符串权重或扩大 readPlan 容量来掩盖 attribution 不清的问题。

## Commands

```bash
npm run build
npm test
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/readplan-platform-proof-lishuedu-cold.json 2> /tmp/readplan-platform-proof-lishuedu-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/readplan-platform-proof-cipherlink-cold.json 2> /tmp/readplan-platform-proof-cipherlink-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/readplan-platform-proof-exam-cold.json 2> /tmp/readplan-platform-proof-exam-cold.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-auto --strategy impact --runs 5 --verbosity diagnostic > /tmp/readplan-platform-proof-lishuedu-warm-auto.json 2> /tmp/readplan-platform-proof-lishuedu-warm-auto.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic > /tmp/readplan-platform-proof-lishuedu-warm-required.json 2> /tmp/readplan-platform-proof-lishuedu-warm-required.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic > /tmp/readplan-platform-proof-cipherlink-warm-required.json 2> /tmp/readplan-platform-proof-cipherlink-warm-required.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state warm-required --strategy impact --runs 5 --verbosity diagnostic > /tmp/readplan-platform-proof-exam-warm-required.json 2> /tmp/readplan-platform-proof-exam-warm-required.err
```

## Final Test Report

| Check | Result |
|---|---|
| Build | PASS: `npm run build` exited 0. |
| Unit tests | PASS: `npm test` reported 65 tests, 61 pass, 4 skip, 0 fail. |
| Golden path existence | PASS: all lishuedu/cipherlink/exam golden anchor, must, should, and side files exist in the measured repo snapshots. |
| Cold hard gate | PASS: all three real projects reported `R_read_must=1.0000`; no must file was missing. |
| warm-auto no-seed latency | PASS: lishuedu `warm-auto` P95 `76.41ms`, below `300ms`; semantic verify did not run. |
| warm-required defaultability | FAIL by design: P95 remains above `800ms` in all three real projects. |
| timeout logs | PASS: stderr files were empty for all benchmark commands. |

## Known Limits

- Benchmark snapshots are tied to the repo commits listed above. If external business repos move again, rerun this matrix before using the numbers as release evidence.
- v1 attribution cannot explain why an `absent` file was absent; it only proves absence from `result.files`. The next implementation should add attribution v2 classification before any graph expansion.

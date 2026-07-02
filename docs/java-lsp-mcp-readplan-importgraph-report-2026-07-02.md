# readPlan importGraph Phase 1 验收报告

日期：2026-07-02

## 结论

Phase 1 已完成并通过真实仓库 gate。

- 三仓 cold `R_read_must` 均为 `1.0000`。
- 默认 `readPlanMaxItems=6` 未变，benchmark totals 中 `readPlanItems=6`。
- MCP public tools 入参/出参 schema 未改。
- 未引入 warm 调度、profile-aware warm 默认化或 timeout-degrade。
- `importGraph` 已能补齐方法体局部类型、同包/跨包 import 类型、wildcard importer 等 cold 结构召回。

本阶段同时修复了初始 gate 暴露出的污染问题：FQN import 现在只命中精确包名定义，反向 importer 作为弱结构补充，不再挤掉 typeGraph / persistence rg 的 must 文件。

## 输入状态

| repo | path | git state |
| --- | --- | --- |
| codex-java-lsp-mcp | `/Users/luo/Documents/github/codex-java-lsp-mcp` | branch `codex/readplan-structural-evolution`, commit `3f2e9d2`, clean |
| lishuedu | `/Users/luo/Documents/program/lishu/lishuedu` | `1f556efdf`, `develop...origin/develop [ahead 1]` |
| cipherlink | `/Users/luo/Documents/program/cipherlink` | `638226e`, `develop...origin/develop [ahead 5]`, dirty working tree |
| exam-parent-v3 | `/Users/luo/Documents/program/exam-parent-v3` | `1e08da8`, `develop-v2...origin/develop-v2 [ahead 3]` |

cipherlink dirty 文件：

- `modules/organization/src/main/java/com/hhtele/cipherlink/organization/infrastructure/persistence/MybatisOrganizationRepository.java`
- `modules/organization/src/test/java/com/hhtele/cipherlink/organization/infrastructure/persistence/MybatisOrganizationRepositoryTest.java`
- `modules/transfer/src/main/java/com/hhtele/cipherlink/transfer/application/DefaultTransferAppService.java`
- `modules/transfer/src/main/java/com/hhtele/cipherlink/transfer/application/TransferUploadProperties.java`
- `modules/transfer/src/test/java/com/hhtele/cipherlink/transfer/application/DefaultTransferAppServiceTest.java`
- `.omo/evidence/todo-3-transfer-upload-gate-review.md`
- `.omo/lazycodex-executor-verify/`

## 本阶段实现

- `src/source-index.ts`
  - `JavaSourceFacts` 增加 `imports`、`wildcardImports`。
  - `parseJavaSource` 解析普通 import、static import 和 wildcard import。
  - SourceIndex 增加 `importedTypeIndex`、`wildcardImportIndex`。
  - 新增 `findImporters(typeName)`，支持已索引命中和 rg fallback。
  - `findTypeDefinitions` 请求上限从 16 提到 64，并对 FQN 请求做精确包名匹配，避免同名类污染。
  - snapshot 兼容校验扩展到 `imports`、`wildcardImports`。

- `src/agent-router/index.ts`
  - 新增 `importGraph` cold 召回 phase。
  - forward import 通过 `findTypeDefinitions(localImports)` 召回方法体不可见的 import 类型。
  - reverse import 通过 FQN `findImporters` 召回 importer，reason 标记为 `importGraph:reverse`。
  - `semanticPolicy=required` 跳过 importGraph，保持 required LSP 语义路径独立。
  - 纯 index recall 仍为 P2；反向 importer 分数下调为弱结构补充，避免挤掉 must。

- `src/benchmark-agent-impact.ts`
  - `goldenSource` 支持 `importGraph` 归因。
  - timing payload 透传 `metrics.importGraph`。

## 失败门禁与修复

初始 Phase 1 gate 暴露两个 lishuedu `readplan-full` must miss：

| scenario | miss | 原因 |
| --- | --- | --- |
| `storage-signed-url` | `AliyunOssGateway.java`, `StubStorageGateway.java` | simple type lookup 把同名 application DTO 当成 importGraph 候选，挤掉 typeGraph implementation |
| `report-reusable-zip` | `ReportBatchExportTaskDO.java`, `ReportBatchExportTaskMapper.java` | reverse importer 分数过高，多个 service importer 挤掉 persistence rg must |

修复后单场景复核：

| scenario | readPlan must result |
| --- | --- |
| `storage-signed-url` | 5/5 must 全部 READ |
| `report-reusable-zip` | 4/4 must 全部 READ |

## 验证命令

基础验证：

```bash
npm run build && node --test dist/source-index.test.js dist/agent-router.test.js
npm test
git diff --check
```

真实仓库 gate：

```bash
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p1d-lishuedu.json 2> /tmp/rp-p1d-lishuedu.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p1d-cipherlink.json 2> /tmp/rp-p1d-cipherlink.err
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic > /tmp/rp-p1d-exam-parent-v3.json 2> /tmp/rp-p1d-exam-parent-v3.err
```

## 测试结果

| Check | Result |
| --- | --- |
| 定向 build + tests | PASS: `npm run build && node --test dist/source-index.test.js dist/agent-router.test.js` reported 46 tests, 42 pass, 0 fail, 4 skipped. |
| 全量 tests | PASS: `npm test` reported 88 tests, 84 pass, 0 fail, 4 skipped. |
| diff hygiene | PASS: `git diff --check` exited 0. |
| benchmark stderr | PASS: `/tmp/rp-p1d-lishuedu.err`, `/tmp/rp-p1d-cipherlink.err`, `/tmp/rp-p1d-exam-parent-v3.err` all 0 bytes. |
| cold must gate | PASS: lishuedu / cipherlink / exam-parent-v3 all `R_read_must=1.0000`. |

## Benchmark 结果

| project | recall | precision | P_read | R_read_must | readPlanItems | readingPayload P50 | elapsed P50/P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0.8206 | 0.4418 | 0.8000 | 1.0000 | 6 | 9863 | 9.88 / 257.58 ms |
| cipherlink | 0.8357 | 0.3700 | 0.6333 | 1.0000 | 6 | 4539 | 4.09 / 184.39 ms |
| exam-parent-v3 | 0.5800 | 0.2335 | 0.4000 | 1.0000 | 6 | 7469 | 4.88 / 123.93 ms |

首个 attempt 的 attribution 统计：

| project | must miss | should hit | should full | should absent | no-type-edge | cross-module-cold |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | 0 | 4 | 5 | 6 | 1 | 2 |
| cipherlink | 0 | 6 | 10 | 4 | 0 | 0 |
| exam-parent-v3 | 0 | 2 | 6 | 10 | 5 | 3 |

## importGraph attribution

| project | scenario | addedCandidates | importGraph elapsed | R_read_must |
| --- | --- | ---: | ---: | ---: |
| lishuedu | `storage-signed-url` | 12 | 1 ms | 1.0000 |
| lishuedu | `school-template-parser` | 6 | 0 ms | 1.0000 |
| lishuedu | `report-reusable-zip` | 16 | 0 ms | 1.0000 |
| lishuedu | `school-confirm-controller` | 12 | 146 ms | 1.0000 |
| lishuedu | `benefit-product-code-dto` | 3 | 0 ms | 1.0000 |
| cipherlink | `client-update-check` | 9 | 0 ms | 1.0000 |
| cipherlink | `transfer-upload-init` | 18 | 0 ms | 1.0000 |
| cipherlink | `transfer-upload-session-repository` | 0 | 0 ms | 1.0000 |
| cipherlink | `aliyun-sms-gateway-send` | 4 | 52 ms | 1.0000 |
| cipherlink | `operation-log-response-dto` | 4 | 0 ms | 1.0000 |
| exam-parent-v3 | `rule-engine-execute` | 8 | 1 ms | 1.0000 |
| exam-parent-v3 | `candidate-position-select` | 37 | 57 ms | 1.0000 |
| exam-parent-v3 | `apply-info-save-basic-service` | 29 | 87 ms | 1.0000 |
| exam-parent-v3 | `position-repository-exists` | 6 | 0 ms | 1.0000 |
| exam-parent-v3 | `ceb-order-create-dto` | 1 | 0 ms | 1.0000 |

## 判定

1. Phase 1 可以作为后续 Phase 2 基线。
   - must 硬门槛已恢复到三仓 `1.0000`。
   - importGraph timing 已进入 benchmark 输出，可继续做 slot 6/8/10 对照。

2. Phase 1 不解决所有 should 问题。
   - lishuedu / cipherlink / exam-parent-v3 仍有 `should full`。
   - exam-parent-v3 仍有 `should absent` 和 `no-type-edge`。
   - 这些是 Phase 2 evidence-budget 和 Phase 3 persisted edge 的后续输入，不应在 Phase 1 用容量扩张或字符串权重处理。

3. 后续 Phase 2 的验收基线应使用本报告的 `/tmp/rp-p1d-*` 输出。
   - slot 固定 6 时 must 不允许回退。
   - should full 的改善必须同时观察 P_read、payload 和 elapsed。

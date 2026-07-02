# readPlan Task 4 Type Reference 验证报告

日期：2026-07-01

## 结论

本轮按 platform proof 的 Do Next 推进了 attribution-triggered Task 4：用 SourceIndex 的类型引用事实补足 cold/no-LSP 下的 `no-type-edge` 候选召回。

结论是：Task 4 对 `exam-parent-v3` 和 `cipherlink` 有真实候选召回收益，三仓 cold hard gate 全部保持通过；但新增本地扫描成本明显，且 lishuedu 本轮没有 typeReference 命中。因此 Task 4 当前只能算“可用但需继续收敛成本”，不能继续扩大到 method body / method-call graph，也不能作为 warm-required 的默认增强。

## 实现范围

- `SourceIndex`
  - 解析 Java 顶层字段和方法签名中的引用类型，跳过 `static final` 常量声明。
  - 增加 `findTypeReferences(typeName)` 和 `findTypeDefinitions(typeNames)`。
  - 跳过缺少 `referencedTypes` 的旧 snapshot，避免旧缓存把新事实默认为空。
  - 合并多类型 definition 扫描，避免每个类型单独 `rg`。
  - 为 type reference/definition 的 `rg -l` 文件列表增加 5s 进程内 TTL 缓存，可用 `JAVA_LSP_SOURCE_INDEX_SCAN_CACHE_TTL_MS=0` 关闭。
  - 在 `SourceIndex.status()` 暴露 `scanCacheHits / scanCacheMisses / scanCacheEntries`，用于判断缓存是否生效。
  - 维护已加载 facts 的 `typeName -> file` 与 `referencedType -> file` 索引；索引命中直接返回，未命中保留原 `rg` fallback。
  - 在 `SourceIndex.status()` 暴露 `typeLookupIndexHits / typeLookupIndexMisses / typeLookupIndexEntries`，用于区分 index 快路和 scan fallback。

- `AgentRouter`
  - 新增 `typeReference` phase，位置在 `typeGraph` 和 `rg` 之后。
  - 仅在 `semanticPolicy !== "required"` 且 profile 为 `service/repository/dto/port` 时启用。
  - 已被 `rg/typeGraph/reference` 召回的文件不再叠加 typeReference 分数。
  - 纯 `typeReference` 候选降为 P2，避免挤掉 readPlan 中已有主链路候选。
  - diagnostic metrics 增加 `typeReference.scannedPatterns / addedCandidates / skippedExisting / elapsedMs / indexHits / indexMisses / cacheHits / cacheMisses / cacheMissElapsedMs`。

- `benchmark`
  - attribution v2 已能输出 `absentReason`，本轮用它验证 Task 4 是否真正减少 `no-type-edge`。
  - `rows[].attempts[].timing.typeReference` 透传 Router 的 typeReference 诊断指标，报告不再只能看 phaseMs。

## 单元测试

已运行：

```bash
npm test
```

结果：

```text
tests 77
pass 73
fail 0
skipped 4
```

新增覆盖：

- `SourceIndex` 解析字段/签名引用类型，不把方法体局部变量和 `static final` 常量当类型。
- `SourceIndex` 跳过缺少 `referencedTypes` 的 legacy snapshot。
- `AgentRouter` 在 fast 路径用 typeReference 召回 typed collaborator。
- `AgentRouter` 在 `semanticPolicy=required` 跳过 typeReference。
- 纯 typeReference 不挤占 typeGraph/rg 候选的 readPlan 预算。
- `AgentRouter` 输出 typeReference scanned/added/skipped/elapsed 诊断指标。
- `benchmark-agent-impact` 在 diagnostic timing 中保留 `typeReference` 指标。
- `SourceIndex` 复用 type reference 查询缓存，并通过 status 记录 hit/miss。
- `SourceIndex` 已加载 facts 的 type lookup 索引命中时不触发 `rg` scan；缺失类型仍覆盖 `rg` fallback cache。

## Benchmark 结果

命令口径：`runs=5 --verbosity diagnostic`。

### Cold impact

| project | commit | recall | precision | rReadMust | must absent | elapsed P50/P95 | typeReference P50/P95 | shouldBlocksTask absent |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| lishuedu | `1f556efdf903` | 0.7756 | 0.4127 | 1.0000 | 0 | 125.61 / 463.40 ms | 110 / 350 ms | no-type-edge 3, cross-module-cold 2, golden-stale-or-low-value 2 |
| cipherlink | `c4ddf3be4858` | 0.8357 | 0.4411 | 1.0000 | 0 | 80.82 / 221.83 ms | 71 / 160 ms | no-type-edge 1, golden-stale-or-low-value 2 |
| exam-parent-v3 | `1e08da826b4e` | 0.6300 | 0.2977 | 1.0000 | 0 | 137.55 / 194.15 ms | 129 / 162 ms | no-type-edge 5, cross-module-cold 3, golden-stale-or-low-value 2 |

exam cold 相对 attribution v2 基线：

| metric | attribution v2 baseline | Task 4 final |
| --- | ---: | ---: |
| recall | 0.5217 | 0.6300 |
| rReadMust | 1.0000 | 1.0000 |
| no-type-edge absent | 9 | 5 |
| elapsed P50/P95 | 1.58 / 28.56 ms | 137.55 / 194.15 ms |

### Warm

| project | warmState | recall | rReadMust | elapsed P50/P95 | typeReference P50/P95 | semantic timeouts |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| exam-parent-v3 | warm-required | 0.5883 | 1.0000 | 3.07 / 2104.25 ms | 0 / 0 ms | 5 |
| lishuedu | warm-auto | 0.7756 | 1.0000 | 122.87 / 371.97 ms | 115 / 239 ms | 0 |

warm-required 已确认不走 typeReference；延迟仍由 semantic/LSP 首触和 timeout 主导。warm-auto 会走 typeReference，本轮未带来 lishuedu 命中但增加约 115 ms P50 本地成本。

### Do Next 成本治理续跑

命令口径：

```bash
npm test
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/cipherlink --project-id cipherlink --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/exam-parent-v3 --project-id exam-parent-v3 --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic
node dist/benchmark-agent-impact.js --repo-root /Users/luo/Documents/program/lishu/lishuedu --project-id lishuedu --warm-state warm-auto --strategy impact --runs 5 --verbosity diagnostic
```

结果：四条 benchmark 命令均退出 0，stderr 均为空。

| project | warmState | recall | precision | rReadMust | elapsed P50/P95 | typeReference P50/P95 before cache | typeReference P50/P95 after cache | scanned / added / skipped | zero-added attempts | golden typeReference rows |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | cold-nolsp | 0.7756 | 0.4127 | 1.0000 | 9.80 / 277.04 ms | 110 / 353 ms | 1 / 213 ms | 25 / 70 / 100 | 20 / 25 | 0 |
| cipherlink | cold-nolsp | 0.8357 | 0.4411 | 1.0000 | 2.75 / 112.77 ms | 94 / 148 ms | 0 / 79 ms | 30 / 15 / 50 | 15 / 25 | 10 |
| exam-parent-v3 | cold-nolsp | 0.6300 | 0.2977 | 1.0000 | 3.10 / 157.73 ms | 117 / 170 ms | 1 / 132 ms | 40 / 110 / 20 | 10 / 25 | 20 |
| lishuedu | warm-auto | 0.7756 | 0.4127 | 1.0000 | 10.21 / 306.67 ms | 104 / 220 ms | 1 / 229 ms | 25 / 70 / 100 | 20 / 25 | 0 |

场景级证据：

| project | scenario | profile | typeReference P50/P95 | added/run | skipped/run | golden typeReference rows | 判定 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| lishuedu | `storage-signed-url` | port | 2 / 276 ms | 14 | 4 | 0 | 有候选但无 golden 命中，下一步看 precision/priority，不做 profile 禁用 |
| lishuedu | `report-reusable-zip` | repository | 2 / 213 ms | 0 | 16 | 0 | zero-added 高成本，适合 snapshot index/negative cache |
| lishuedu | `benefit-product-code-dto` | dto | 1 / 100 ms | 0 | 0 | 0 | zero-added，但 dto 在 cipherlink 有真实命中，不能按 profile 禁用 |
| cipherlink | `transfer-upload-session-repository` | repository | 0 / 141 ms | 0 | 4 | 0 | repository 不能全禁，因为 exam repository 有真实命中 |
| cipherlink | `aliyun-sms-gateway-send` | port | 0 / 78 ms | 2 | 6 | 5 | port 有真实收益 |
| cipherlink | `operation-log-response-dto` | dto | 0 / 79 ms | 1 | 0 | 5 | dto 有真实收益 |
| exam-parent-v3 | `apply-info-save-basic-service` | service | 2 / 134 ms | 16 | 1 | 15 | service 有真实收益 |
| exam-parent-v3 | `position-repository-exists` | repository | 1 / 83 ms | 3 | 0 | 5 | repository 有真实收益 |
| exam-parent-v3 | `ceb-order-create-dto` | dto | 0 / 80 ms | 0 | 0 | 0 | zero-added，仍应先做首触 miss 治理 |

判定：

- TTL 缓存显著压低重复调用 P50：三仓 cold 的 typeReference P50 从 94-117 ms 降到 0-1 ms；lishuedu warm-auto 从 104 ms 降到 1 ms。
- P95 仍被每个场景首次 `rg -l` miss 支配，不能把缓存当成首触延迟治理完成。
- 不能按 profile 直接 skip：`dto/repository/port/service` 都至少有一个真实 repo 的 golden typeReference 命中。
- 下一刀应针对首触 miss 做 snapshot/typeName index 与 negative cache，而不是扩大 method-body 或 method-call graph。

### Indexed fast path 续跑

本轮继续做首触 miss 治理的最小实现：不新增全仓 warm 流程，只给 `SourceIndex` 已加载 facts 建 type lookup 索引。索引命中时跳过 `rg -l`；索引未命中时仍走原 fallback，因此 public tool 行为不变。

命令口径同上，四条 benchmark 命令均退出 0，stderr 均为空；`npm test` 结果为 `77 tests / 73 pass / 0 fail / 4 skipped`。

| project | warmState | recall | precision | rReadMust | typeReference P95 after TTL cache | typeReference P95 after indexed path | P95 change | golden typeReference rows | indexHits / indexMisses | cacheHits / cacheMisses |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lishuedu | cold-nolsp | 0.7756 | 0.4127 | 1.0000 | 213 ms | 135 ms | -36.6% | 0 | 45 / 50 | 12 / 3 |
| cipherlink | cold-nolsp | 0.8357 | 0.4411 | 1.0000 | 79 ms | 50 ms | -36.7% | 10 | 20 / 100 | 16 / 4 |
| exam-parent-v3 | cold-nolsp | 0.6300 | 0.2977 | 1.0000 | 132 ms | 85 ms | -35.6% | 20 | 105 / 40 | 16 / 4 |
| lishuedu | warm-auto | 0.7756 | 0.4127 | 1.0000 | 229 ms | 114 ms | -50.2% | 0 | 45 / 50 | 12 / 3 |

场景级观察：

- `exam-parent-v3/apply-info-save-basic-service` 已变成纯 index 命中：`typeReference P50/P95 = 0 / 1 ms`，golden typeReference rows 保持 15。
- `cipherlink/operation-log-response-dto` 降到 `0 / 21 ms`，golden typeReference rows 保持 5。
- `lishuedu/report-reusable-zip` 仍是 zero-added 高成本场景：`1 / 135 ms`，说明 index 快路只能减少已加载事实成本，不能替代后续 readPlan-full/precision 治理。

限制：

- 当前不是“全仓 snapshot coverage”证明，只是“已加载 facts index”快路；完整 coverage metadata 仍未实现。
- 因为没有全仓 coverage 标记，不能把索引快路解释成完全替代 `rg`。本轮只说明：在当前 golden 覆盖下，索引快路没有造成 golden 回退，并且显著降低了 typeReference P95。

## 保留问题

1. `exam-parent-v3` 仍有 5 个 `no-type-edge` shouldBlocksTask absent。
   - `CebPayServiceImpl` 这类 DTO 使用在方法体 builder 局部变量里，当前 Task 4 不扫描方法体。
   - controller 到 service/DTO 的部分边仍需要 method-call 或更强语义引用，不应靠继续扩大字段/签名扫描硬凑。

2. lishuedu cold/warm-auto 没有 golden typeReference 命中，但仍承担扫描成本。
   - hard gate 已通过，但成本不应被忽略。
   - metrics、TTL 缓存、indexed fast path 已经落地；剩余问题是 zero-added 场景的 precision/priority，而不是继续加候选源。

3. readPlan-full 仍是主要后续瓶颈。
   - 本轮把缺失文件拉进 `files` 候选，但多数仍是 `readplan-full`。
   - 下一步需要基于 attribution 判断是否调整 readPlan 预算/优先级，而不是继续增加候选源。

## Do Next

2026-07-02 续跑结果见 `docs/java-lsp-mcp-readplan-full-capacity-report-2026-07-02.md`：readPlan-full 已完成容量/优先级实验验证，默认 readPlan 容量保持不变，仅新增 benchmark-only `--read-plan-max-items` 实验入口。

1. 做 TypeReference coverage hardening，不做 Task 5。
   - 只有出现显式 full warm-index 或全仓 snapshot 构建时，才写入 repo-level coverage metadata；不要为了 coverage 在普通 cold impact 里全仓预扫。
   - 继续保留 `rg` fallback；indexed fast path 只能在已加载 facts 上生效。
   - 下一轮验收重点从 P95 转为安全性：扩充 golden 后 cipherlink/exam 的 golden typeReference rows 不下降，且 `typeReference.indexHits` 上升不能伴随 `shouldBlocksTask absent` 上升。

2. 再处理 readPlan-full。
   - 用现有 attribution 输出统计 `shouldBlocksTask && blockedBy=readplan-full`。
   - 只对 must 或 shouldBlocksTask 的结构证据文件提升 read priority。
   - 保持 side 不进 hard gate。

3. 最后再评估 method-body / method-call graph。
   - 触发条件：扩展后的 golden 上，`no-type-edge` 仍是最大 absent reason，且 typeReference 成本 P95 已稳定在可接受预算内。
   - 初始范围只允许 DTO exact type token 或 method call target，不做全量方法体扫描。

## 判定

本轮可以保留 Task 4 最小实现，但不能宣布已到天花板，也不能继续扩大 warm/profile-aware 行为。平台期的判断仍成立：cold recall 还能通过结构边小幅补齐，但每一分召回都开始换取明显本地成本；后续主线应转为成本治理和 readPlan-full attribution，而不是盲目增加召回源。

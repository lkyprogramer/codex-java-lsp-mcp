# Java Intelligence V3.2 本地 MCP Trace 与外部 Agent Eval 合同

日期：2026-08-09
状态：`LOCAL_TRACE_READY / BLOCKED_EXTERNAL`
适用计划：V3.2-07a、V3.2-07b

## 1. 结论与边界

本阶段只建立可重放的本地 MCP trace。它记录 MCP request/response、tool call/result、后续文件读取、completion、freshness 和单调 wall time，并从冻结任务上下文确定性计算 TTFUC。

它不调用模型，不发送代码到外部，不产生费用，也不把 benchmark 推断成 Agent 效果。以下字段必须保持 `UNMEASURED`：

- actual input/cached/output Token；
- TaskSuccess；
- 人工修正次数；
- 盲评结果。

外部 Agent eval 尚未获得 provider、模型、费用和代码外发授权，因此 V3.2-07b 的当前状态是 `BLOCKED_EXTERNAL`。本仓库不得在该状态下新增或运行 `run-agent-trace-matrix.mjs`，也不得把未知 usage 写成 `0`。

所有 record/replay 必须通过 `run-isolated-validation.mjs`；若执行真实仓任务，还必须先把 Java 仓库 clone 到私有 detached local clone。禁止读取或写入在线 LSP 的 cache、workspace、log、配置与 repo checkout。

## 2. 六个 source-locked 任务

任务来自三仓各 2 个 `evaluationSplit=holdout` 场景；recorder 会重新读取 golden、校验每仓 `8 tuning + 2 holdout`，并将 golden 文件 SHA-256 写入 trace。

| taskId | repo commit | 任务链 |
|---|---|---|
| `lishuedu:exam-score-export-cross-module-holdout` | `db63b1a7e393edd90449eb013d7d1c4d65c366f2` | exam → school → workbook export |
| `lishuedu:paper-task-claim-iam-holdout` | `db63b1a7e393edd90449eb013d7d1c4d65c366f2` | paper → IAM → atomic claim |
| `cipherlink:client-release-storage-presign-holdout` | `fa433982e92e52dd610650d1e79f2d041179b1d3` | client release → storage → presign/rollback |
| `cipherlink:backend-operation-log-aspect-async-audit-holdout` | `fa433982e92e52dd610650d1e79f2d041179b1d3` | backend aspect → audit async persistence |
| `exam-parent-v3:exam-room-print-download-types-persistent-bundle` | `f90a0b475f7be2ed003703feecec8195bc7eb976` | controller → print bundle → persistent job |
| `exam-parent-v3:candidate-pay-order-cross-module-admission` | `f90a0b475f7be2ed003703feecec8195bc7eb976` | candidate → order → payment admission |

任务集合、repo commit、anchor、`mustHit + taskBlocking` 上下文以及三个 golden SHA 都属于 source lock。record/replay 还必须接收三个隔离 Java clone，校验 clean `HEAD/tree` 与这里的 commit 一致，并把 repo identity 写入 replay hash。holdout 一旦用于调参，必须在后续报告中降级为 tuning，不能继续声称未见样本。

## 3. tools/list 冻结

`--tool-schema` 输入必须是实际 MCP `tools/list` 的完整 JSON payload（`{ "tools": [...] }` 或其 `tools` 数组），不能只给工具数量或估算字节。recorder 会：

1. 按工具名稳定排序；
2. 要求每个工具有 `name` 和 `inputSchema`；
3. 保存完整 canonical schema、工具名和 SHA-256；
4. replay 时重新计算并要求完全相同。

正式捕获 tools/list 时必须在隔离 candidate clone 内启动 server；不得连接在线 MCP。

## 4. 事件协议

输入是 JSONL。每条事件都包含：

```json
{
  "schemaVersion": "java-intelligence-v32-mcp-trace-events/v2",
  "taskId": "lishuedu:exam-score-export-cross-module-holdout",
  "sequence": 1,
  "wallTimeMs": 0,
  "type": "mcp_request"
}
```

同一 task 的 `sequence` 必须从 1 连续递增，`wallTimeMs` 必须非负、单调。允许事件如下。

| type | 必填证据 | 语义 |
|---|---|---|
| `mcp_request` | `requestId`、`method=tools/call`、`toolName`、`argumentsArtifact`、`argumentsSha256`、`argumentsBytes` | MCP 请求边界；artifact 必须位于私有 artifact root 且 hash/bytes 匹配 |
| `tool_call` | `requestId`、`toolName` | server 工具 handler 开始；工具必须存在于冻结 tools/list |
| `tool_result` | `requestId`、`completion`、`freshness`、`contextFiles[]` | 工具内部结果边界；每个 context record 必须含 repo-relative `file/contentSha256/bytes`，并与冻结 commit 的 Git blob 一致 |
| `mcp_response` | `requestId`、`isError`、`responseArtifact`、`responseSha256`、`serializedBytes` | MCP 响应结算；保存并校验真实序列化响应 artifact |
| `file_read` | `requestId`、`file`、`contentSha256`、`bytes` | 对应 MCP response 已结算后的真实读取；hash/bytes 必须与冻结 Git blob 一致 |

每个 request 必须严格按 `mcp_request → tool_call → tool_result → mcp_response` 结算；`file_read` 只能发生在其 `requestId` 的 response 之后。缺响应、重复 request、越权路径、错误 repo tree、伪造源码 hash、请求/响应 artifact 漂移、工具 schema 漂移、非法 completion、freshness 自相矛盾都会拒绝生成正式 trace。

Freshness 合同：

```json
{
  "startGeneration": 12,
  "endGeneration": 13,
  "changedDuringRequest": true
}
```

`changedDuringRequest` 必须等价于 `startGeneration !== endGeneration`。Completion 只允许 `COMPLETE`、`PARTIAL`、`FAILED`。

## 5. TTFUC 定义

TTFUC（Time To First Useful Context）不是“首个返回字节”。对每个冻结任务：

1. required context 固定为该 scenario 的 `mustHit ∪ taskBlocking`；
2. `tool_result.contextFiles[]` 只在对应 `mcp_response` 结算后变为可用上下文，随后 `file_read.file` 继续按事件顺序累积；
3. 第一次完整覆盖 required context 的 response/read 事件，其 `wallTimeMs` 即 TTFUC；
4. 未覆盖时写 `UNREACHED`，不得写 0，也不得从 token benchmark 推测。

该定义是确定性本地代理指标。它证明“上下文何时可用”，不证明模型已正确使用上下文，因此不能替代 TaskSuccess。

## 6. Record 与 Replay

以下命令只允许在隔离 wrapper 内执行。调用前先把 events、tool schema 与三个 Java 仓库冻结到调用者专用的临时输入目录；写路径必须使用 `{state}`，并用 `--keep` 保留 wrapper 输出。禁止把在线 checkout、在线 LSP cache/workspace 或正在被 JDT 使用的 Java 仓库路径作为输入：

```bash
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --keep --profile targeted -- \
  node scripts/record-mcp-trace-matrix.mjs record \
  --events /tmp/v32-trace-inputs/events.jsonl \
  --artifact-root '{state}/trace-artifacts' \
  --tool-schema /tmp/v32-trace-inputs/tools-list.json \
  --lishuedu /tmp/v32-trace-inputs/repos/lishuedu \
  --cipherlink /tmp/v32-trace-inputs/repos/cipherlink \
  --exam-parent-v3 /tmp/v32-trace-inputs/repos/exam-parent-v3 \
  --output '{state}/local-trace.json'

```

wrapper 约束所有输出路径；调用者仍负责保证只读输入本身是冻结的私有副本。跨 session replay 需要先由正式 runner 把 record bundle 复制并校验到新一轮 `{state}`，再调用 `replay`；当前通用 wrapper 不接受把上一轮绝对 artifact 路径作为新一轮 `--artifact-root`，因此这里不提供可绕过该边界的手工 replay 命令。真实六任务 replay runner 尚未落地，Sprint 0 仍按 `PARTIAL` 报告。

`replaySha256` 绑定 runtime commit/executable tree、tools/list、三个 golden hash、三仓 commit/tree、六个任务、全部事件、源码 blob 记录、请求/响应 artifact hash、TTFUC、completion 和 freshness。任一输入变化必须使 replay 失败。`generatedAt`、clone 绝对路径等非语义字段不进入 replay hash。

## 7. 外部 Agent eval 授权门

只有用户明确授权外部调用、费用和代码外发后，才能实现并运行 V3.2-07b。执行前必须把以下字段写入不可变 manifest：

- provider、model、精确 version、client/version；
- system prompt SHA-256、tools/list SHA-256、六任务/golden SHA-256；
- temperature、seed 或“不支持 seed”的明确状态；
- input/cached/output usage 字段的原始可用性；
- rate limit、重试策略、单次及总预算上限；
- 哪些代码/路径会外发、脱敏策略与批准人；
- AB/BA、每侧 5 次、盲评 rubric、评审者与争议裁决规则。

授权前的机器状态固定为：

```json
{
  "status": "BLOCKED_EXTERNAL",
  "modelUsage": { "status": "UNMEASURED" },
  "taskSuccess": { "status": "UNMEASURED" },
  "blindReview": { "status": "UNMEASURED" }
}
```

后续即使获授权，样本不足也只能声明 scoped evidence；不能外推为所有 Java 仓或所有 Agent 的总体收益。

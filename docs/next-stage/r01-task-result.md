# R01 — 修复最终 tool 消息的载荷边界（W01–W05）

**Status**: GREEN（机制层）；真实 SDK 往返留 R12
**源码 SHA**: 工作树 HEAD `b0614097acf813c402cb6f8b83a097e83c1c2b24`（本提交之前）；RED 基线 = b9c3cc3 干净 worktree
**日志 SHA-256**:
- `r01-red/run.json` = `a163270e1b5174f983fabba57fba88c0bfa701e9b579d5e28738f7a1c510dcb4`（b9，5/5 FAIL，exit 0 但行内全 FAIL）
- `r01-green/run.json` = `8da1df8ee79bc527766f633297b42c2a39024b26480e313951a472ba0e10a2e8`（5/5 PASS）
- `r01-green-remaining/run.json` = `7156515ea7dad4917a06d386a9048bc739c007e8d20baf511b4eac3b886544a9`（E01–E06：1/6，属 R02）
- 冻结自检 `r01-selfcheck/summary.json` = `5f6f4cb1412546249221239568a57fa3dbb176a8a209d266967e466d56dcbc02`（5/5 exit 0）
**Commit**: 见 git log（fix(eval): preserve tool payloads at the model boundary）
**Date**: 2026-09-30（原文误写为 2026-07-17，2026-10-09 按提交时间更正）

## RED / GREEN 证据（不可复签）

| 轮次 | 命令 | 结果 | 输出目录 |
|---|---|---|---|
| RED (b9) | `run_audit.py --project $RUNS/r01-b9 --output $RUNS/r01-red --cases W01..W05` | 5/5 FAIL（b9c3cc3 干净 worktree，TYPESCRIPT_JS 指向开发环境锁定版） | `java-specialist-audit-runs/r01-red` |
| GREEN | `run_audit.py --project $PROJECT --output $RUNS/r01-green --cases W01..W05` | **5/5 PASS** | `java-specialist-audit-runs/r01-green` |
| 剩余审计 | `--cases E01..E06` | 1/6 PASS（E02 顺带修复：原 String() 弱评分器对 `"true"` 的宽容在 E02 断言上意外成立；E01/E03/E04/E05/E06 仍 FAIL）——**属 R02 严格评分器范围，本任务不收** | `r01-green-remaining` |

- 仓库定向测试：`scripts/eval-tool-wire.test.mjs` 8/8 PASS（W01–W05 等价断言 + CRLF/emoji/空内容/错误路径/预算边界 + fake 与 wrapper 两级 transport）
- 回归：`run-agent-trace-live.test.mjs` 27/27；`evaluate-java-task.test.mjs` 10/10
- 全量隔离验证：1199 + 304 PASS，0 FAIL

## 根因（b9）

`run-agent-trace-live.mjs` 工具循环对所有工具结果统一套 `compactImpactForModel`
（java_impact 形状的投影模板）：`read` 的源文本被投影成
`{"files":[],"readPlan":[],"evidenceGaps":[]}`，`java_symbol` 的 candidates 被丢弃，
`write_file` 回执同样丢失。模型最后一跳收到的 tool 消息与工具实际返回完全无关。

## 修复机制（单机制：最终 model tool 消息边界序列化）

1. **`serializeModelToolResult(toolName, raw, {maxBytes})`**（新增，`run-agent-trace-live.mjs`）：
   按工具类型解码——`read` 保留 `{path,startLine,endLine,text}`（超预算按整行尾裁，
   `truncated:true` + `slices` 记录保留切片）；`java_symbol` 保留
   `{schemaVersion,mode,query,candidates[declaration+preview]}`；`write_file` 保留
   `{path,written,bytes}`；`java_impact`/`java_context` 才走原有
   `compact*ForModel`；**未知工具返回有界原样 JSON（`{raw}`），绝不落入 impact 投影**。
   预算裁剪只切结构化片段/整行后重新 JSON 编码，任何情况下 `content` 都是合法 JSON。
2. **工具循环接线**：`messages.push({role:"tool",...})` 的 content 改为
   `serializeModelToolResult(name, raw, {maxBytes: toolResultMaxBytes}).content`；
   每个 tool 消息同步产出一条 `toolReceipts`：`{callId, toolName, contentHash
   (model payload sha256), payloadBytes, slices}`。
3. **chat 请求边界回执**（`onChat` 钩子）：每次 `chat()` 调用前触发，携带
   `{round, messages(structuredClone), receipts, payloadHash(整个 messages 的 sha256)}`。
   `evaluate-java-task.mjs` 的评测主循环把回执经 `recorder.recordModelDelivery`
   落成 `MODEL_TOOL_DELIVERED` 事件——**回执只在真实请求边界铸造**；它证明模型载荷
   含该内容（payload-attached），不证明模型注意/使用了它（模型有效性仍归 R12/R13）。
4. **W05**：`EVAL_SYSTEM_PROMPT` 不再继承 legacy `java_impact tool only` 分支提示词，
   只引用本次会话实际提供的工具。
5. **`scripts/eval-tool-wire.mjs`（新增）**：wire 机制单一驱动入口
   （`runEvalToolWire` + `fakeChat`）。离线反例用它；R12 必须用真实 SDK transport
   走同一驱动再验一次，两级证据分开记录。

## raw vs model hash 分界

- `SOURCE_RECEIVED` 事件：hash **工具实际返回的源文本**（raw）。
- `MODEL_TOOL_DELIVERED` 回执 / `payloadHash`：hash **模型实际收到的序列化载荷**。
- 载荷有损（`truncated`/`slices` 非全量）时两者必然不等——此时不得把 raw 的
  SOURCE_RECEIVED 直接记为"模型已收到"（W04 断言即锁此语义）。

## 范围外（明确留给后续任务）

- E01–E06 严格评分器：R02（`scoreQaAnswer` 的 String() 宽容、extra/dup key、
  required_evidence 门、完整分母）
- 候选树/多候选 scoped：R03；对称工具+可携带 judge：R04
- 真实 SDK 往返的 `MODEL_PAYLOAD_ATTACHED`：R12；付费/授权再确认：R11
- `experiments/semantic-discovery/agent-ab.mjs` 复用本 wire 机制的实验接线：
  实验类任务（R10/R12）接入时统一走 `runEvalToolWire` 同一驱动，避免分叉序列化。

## 边界与已知限制

- 本任务的 GREEN 全部基于 **fake/包装 transport**：通过只证明 wire 机制，
  不证明任何模型有效性（与 S0 对 572 次历史运行 INVALID_EXPERIMENT 的口径一致）。
- `toolResultMaxBytes` 默认 16000 字节；评测主流程未传参（用默认），
  R10+ 四臂实验应按设计 delta 统一显式传值。
- b9 基线 RED 使用了开发环境 `node_modules` 的 TypeScript 作 `TYPESCRIPT_JS`
  （项目锁定版 5.x，transpile 仅做类型剥除，不影响 W 用例的被测边界）。
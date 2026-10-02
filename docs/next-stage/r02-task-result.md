# R02 — 唯一冻结评分器、严格答案与完整分母（E01–E06）

**Status**: DONE（GREEN）
**源码 SHA**: 提交前工作树 HEAD `321bde0`（R01）
**日志 SHA-256**:
- `r02-red/run.json`（b9c3cc3 干净 worktree）= `30543f222278f8e7bda04f132b7f41e2a00506b486c51bad5c32cb942d3d1f40`（E01–E05 FAIL / E06 正对照 PASS）
- `r02-green/run.json` = `fb140084ac4b44ac5e159f716ae2224410bfd356f7b8df49e4ae0a56ea2f1386`（6/6 PASS）
- `r02-green-w/run.json`（R01 无回归）= `f40f11494f96c28ab8dd52fa1be98c5301f7ccedf2ae676e2116585e7237f2b7`（W01–W05 5/5 PASS）
- 冻结自检 `r02-selfcheck/summary.json` = `5f6f4cb1412546249221239568a57fa3dbb176a8a209d266967e466d56dcbc02`（5/5 exit 0）

## 机制（单机制：canonical outcome + scheduled denominator）

1. **严格 QA 评分器**（`evaluate-java-task.mjs`）：删除 `extractStrictJson`/String() 弱比较器。
   `scoreQaAnswer` = JSON.parse + `findDuplicateJsonKeys` 状态机（等价 Python
   `object_pairs_hook`：任意嵌套层重复键拒绝；`:`/`,` 状态转移保证值内引号不误判为键）
   + 键集精确相等（extra 与 missing 都失败）+ 类型一致深比较 + 输入长度上限
   262144 字符；NaN/Infinity 字面量被 JSON 文法拒绝；**markdown fence 不再剥除**
   → `INVALID_ANSWER`（协议文件已记录：本审计轮按严格 JSON 拒绝）。
2. **E04 证据门**：`scoreRunOutcome` qa 路径在答案正确后还要求
   `gold.required_evidence` 非空且逐行被本 attempt 的 `SOURCE_RECEIVED` 行覆盖
   （`receivedLineCoverage`，行集语义与 kit 的 `line_set` 一致）；live 流程现在
   把该 repeat 的真实 received 事件传入评分。gold 缺失 → `UNMEASURED`（协议缺口，
   不是测量出的失败）。
3. **repair 严格化**：`verdict.passed === true` 才算成功（Promise/真值对象不行）；
   无冻结 judge → `UNMEASURED`。
4. **完整分母**（`assemblePack`）：新增 `planned` 参数——完整计划
   task×arm×repeat 行，缺失行合成 `MISSING_RESULT`；`taskSuccessRate =
   成功数/计划数`（E05：2 计划 1 成功 1 FAILED_RUNTIME → 0.5）；
   `conditionalAccuracy = 成功数/实际评分数` 只作上下文，永不替代 gate 指标；
   重复计划行直接抛错（协议错误不静默去重）。live 与 blocked 两条路径都传完整计划。
5. **usage**（`openai-compatible-chat.mjs`）：`usageFromCompletion` 捕获
   cached/reasoning 明细、`rawUsage`（provider 原样对象，凭据只存在于请求头，
   从不进入 usage）+ `rawUsageHash`；`mergeUsage` 按字段合并（缺失字段保持 null
   永不为 0）；pack 行经 `usageOrNull` 输出（UNMEASURED → 整行 null）。
6. **`eval-frozen-adapter.mjs`（新增）**：将计划行 + AttemptOutcome 映射为原
   `java-specialist-results/v1` pack（状态映射表、read_events 来自
   SOURCE_RECEIVED、kit 侧 provider usage 行、0-based repeat、缺行合成 MISSING、
   重复抛错、arm 不匹配抛错）+ `scheduledDenominatorSummary`（成功/计划）。
   **端到端测试**：adapter 形状的 pack 被原冻结 kit scorer（`cli.score_pack`，
   即 `python -m harness score` 的同一函数）直接复算，正确且证据齐全的行
   `qa_contract_pass=true`，未尝试行留在 split 分母里。
7. **`evaluation-protocol.json`（新增，docs/next-stage/）**：固化分母规则、严格
   JSON 规则、QA/repair 成功条件、usage null 语义、回执语义、scorer 调用方式。

## 既有测试的语义更新（不是掩盖）

- `evaluate-java-task.test.mjs`：fence→`INVALID_ANSWER`、extra key→失败、
  `taskSuccessRate` 改按 成功/计划（3 行 1 成功 → 1/3，conditional 0.5）、
  usage 字段名 input/output、qaGood 补 required_evidence + sourceReceived。
- `run-agent-trace-live.test.mjs` 无断言改动；`liveV1Fields` 的 v1 兼容视图现在
  把新增 usage 字段投影回精确 v1 形状（测试意图就是"v1 字段保持不变"）。
- kit 锚点 fixture（`docs/phase-e/…anchor.json`）与历史报告**未改动**。

## 回归面

| 项 | 结果 |
|---|---|
| E01–E06 定向审计 | 6/6 PASS（r02-green） |
| W01–W05（R01 无回归） | 5/5 PASS（r02-green-w） |
| 新/定向单测（adapter 13 + eval 10 + trace 27 + wire 8） | 58/58 |
| 源码 probe | 12/12 |
| 冻结 kit 自检 | 5/5 |
| 全量隔离验证 | 1199 + 317 PASS，0 FAIL |

## 限制与剩余缺口

- Node 侧 `scoreQaAnswer` 与 Python 冻结 scorer 的语义由测试锁定，但 JS 无法区分
  int/float（单 number 类型）——已写入协议文件的已知限制；kit scorer 仍是唯一权威。
- 四臂真实实验（R10）与真实 SDK 往返（R12）未跑：本任务全部为机制层证据，
  不产生任何模型有效性结论。
- b9 RED 使用开发环境 `node_modules` TypeScript 作 `TYPESCRIPT_JS`（同 R01）。
# 报告、原始证据与历史结论更正

## 1. 状态不是一个布尔值

| 维度 | 合法状态/含义 |
|---|---|
| 验证步骤 | PASS / FAIL / BLOCKED_ENV / BLOCKED_AUTH / NOT_RUN |
| 旧实验有效性 | VALID / INVALID_EXPERIMENT / SOURCE_REPORTED_ONLY |
| 功能任务 | NOT_STARTED / IN_PROGRESS / BLOCKED_ENV / BLOCKED_AUTH / DONE |
| 发布资格 | NO_GO / ELIGIBLE_FOR_MANUAL_REVIEW |
| 部署授权 | 独立true/false，不能由测试自动赋true |
| 数据覆盖 | dev、locked、scoped、external-full分别列出 |

测试次数不替代上述任何维度。PASS必须包含验证层级：source-export、parser-fixture、MCP blackbox、runtime-JDT、live-model。未做类型检查的转译probe不能写build PASS。

## 2. 每次run的最小目录

```text
run-id/
  manifest.json            source tree/dirty hash、dataset/scorer/protocol/renderer hashes
  schedule.jsonl           事先冻结的全部attempt keys
  outcome.jsonl            每个计划key一条，失败/超时/缺失不删除
  tool-schema.json
  prompt.txt
  model-payloads.jsonl     脱敏后的最终请求，不记录认证头
  receipts.jsonl           requestId/callId/path/source range/sliceHash/payloadHash
  usage.jsonl              provider原始字段与映射、缺失原因
  candidates/              每个repair的diff/hash或可恢复bundle
  judge/                   compile/test/receipt/timeout/output limit
  resource/                cold/warm/queue/RSS/CPU/event-loop/WAL原始样本
  score.json               canonical evaluator输出
  verdict.json             决策和限制
  SHA256SUMS
```

可压缩大raw，manifest记录压缩文件hash与schema。不能只写一个 `/Users/...` 路径当可交付证据。既往未随附件提供的run，可由用户补充后做trace重核；在此之前不补造或推算逐run结果。

## 3. 必须冻结的身份

candidate源码完整SHA、dirty diff hash、编译文件hash、实际runtime release、Node/JDK/JDT版本、项目JDK、SQLite/native依赖、OS/硬件、gitworktree/root scope、corpus内容hash、dataset版本、scorer hash、source表示/renderer版本、model/provider endpoint/revision/dim、prompt/tools、maxRounds/deadline/token budget、cache状态/建库成本。

model ID只是一个字段，不等于全部实验身份。同名provider endpoint变了不能共享cache；corpus名称不是内容hash。收到的实际模型名可能为网关alias，需要保存返回model字段与resolved configuration，不能把别名当确认的底层模型。

## 4. 成功/成本计算

预先冻结 N 个attempt，所有N行都进入任务分母。`SuccessRate=validatedSuccessCount/N`，`measuredOnlyAccuracy`另外给分子分母。transport错误与尚未获得网络权限的计划要区分：前者是已经执行失败，后者整轮BLOCKED而非性能数字。

`CostPerSuccess=sum(all attempted costs)/validatedSuccessCount`；零成功→不可计算，不输出无穷优势。提供商usage缺失→UNMEASURED，不补0；output/reasoning/cached分别用原字段。wire bytes和源码计划bytes只作为工程指标，不当计费token。两臂provider usage不完整时不发布省token百分比。

同task不同语言/repeat属于相关组；同corpus任务也相关，分别给task-level/corpus-level区间和case表。样本小导致区间宽就INCONCLUSIVE；统计不显著不是无伤害证据。future模型校验需独立选择protocol，不能用模型自评结论充当独立judge。

## 5. 旧结果更正规范

保留旧M2/M3数字/文件，新增：affected source SHA、错误数据流/协议、哪些结论撤回、哪些仍可用（例如冻结judge当时确实得到失败或API计数若有raw）、新协议hash、重跑状态。不要把历史错误改名成“纯检索实验本来如此”来掩盖原live目的。

当前可更正为：“LIVE loop在工具返回与最终chat消息之间丢失payload；SOURCE_RECEIVED为预处理观测，不支持模型已见证据；repair0的归因未成立。A3为不等预算union覆盖，旧cache键存在同文件覆盖风险。KEEP_EXTERNAL作为隔离政策保留，vector效果结论待新实验。”

## 6. 每任务报告模板

`templates/task-result.json`记录 id/sourceSha/RED/GREEN/commands/exit/evidence hashes/contract IDs/remaining gaps。没有raw时不得填MEASURED。发布review检查的是完整链，不只阅读里程碑最后一段。

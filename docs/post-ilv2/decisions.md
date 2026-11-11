# Post-ILV2 决策与进度

当前状态的唯一入口（Q00 起）。各 result.json 的 `identity.sourceHead` 统一记计划基线 `665d66e`，代码本身在本分支上。计划见 [docs/java-specialist-post-ilv2-v1](../java-specialist-post-ilv2-v1/README.md)（1.2）；ILV2 历史账本保留在 `docs/index-lifecycle-v2/`，不再更新。

## D0 执行方式偏离（2026-11-11）

用户要求本轮**只改代码，不编译、不测试、不做任何验证**；每阶段集中 review 一次，修复后提交。任务卡要求的“先 RED、定向 GREEN、raw 哈希”因此不执行：

- 测试文件按卡片写入，但**未运行**；每张卡的 result.json 中验证项一律 `NOT_RUN`。
- `commands.jsonl` 不生成：本轮除 git 外没有执行产品命令。
- 任何“通过”只指独立代码 review 结论，不是运行结果。

## D1 基线身份（Q00）

见 [baseline.json](baseline.json)。

- 源码：`main@665d66e`。两轮底座修复（`cc5db6b..665d66e`）由用户报告已在本机 Mac 验证，本仓库无原始日志。
- 部署：USER_REPORTED_DEPLOYED / NOT_INDEPENDENTLY_VERIFIED；没有读取安装回执，`installedDigest=null`。
- JDT 时间合同：导入 120 s（`JDTLS_START_TIMEOUT_MS`）+ 导入后索引屏障 600 s（`JDTLS_INDEX_TIMEOUT_MS`，`07c6ccf`），均为源码默认值；安装环境是否覆盖未知。产品 README 的两处 120 秒描述已改正，历史验收原文保留并加注。

## D2 ILV2 状态账本收口（Q00，**待用户确认**）

`docs/index-lifecycle-v2/mac/status.json` 仍为 `planStatus=IN_PROGRESS`、`candidateStatus=NOT_READY`，G17 历史 FAIL，G18/G19 PLAN。提议：

- 账本冻结为历史记录，不改其中任何 FAIL/PLAN；
- “是否已上线”以用户报告为准（USER_REPORTED），不由账本判断；
- G18/G19 不在 post-ILV2 路线中继续，如需重开由用户单独决定。

这是用户的决定，本轮只记录提议，未修改 status.json。

## D3 冻结项（Q00）

数据集、分母、预算（readPlan minimal 4/6KiB、balanced 6/14KiB、precision 8/20KiB、recall 12/32KiB；evidence 8 units / 80 lines / 16000 bytes；outline 默认 8、最多 20、wire 4096 B）、gold 与 fixture 不变。模型调用、生产安装/重启、源码外发均未授权。

## D4 测量与 repair 判定（Q01）

- 最终请求 receipt：`scripts/ilv2-mac-delivery-receipt.mjs`，语义对齐计划包 `tools/check_delivery.py`；`openai-compatible-chat.mjs` 新增 `onSerializedBody`，receipt 绑定实际发送的同一串字节。
- MAC-10 repair oracle：加入评测方自带的 `OracleCompletionWrapper`，测试 main 正常返回才写完成凭据；PASS 需要 `COMPLETE` 且仍有 `ORACLE PASS` 行。凭据只防偶然误判，不是对同权限恶意代码的沙箱。
- `eval-repair-adapter.mjs` 调用仓库外的 Python 冻结判定器，本轮不改，局限记入 Q01 结果。
- 前提：oracle 测试必须以 main 正常返回表示成功。若私有 mac10-v3 的 oracle 在成功时调用 `System.exit(0)`，新判定会把正确修复判为 TEST_FAILED。上 Mac 后先跑一次 `checkOracles`，known-good 不是 PASS 就停下来登记，不能放宽判定。
- receipt 里的 oracleHash 取实际编译的测试源码的 sha256，不取冻结声明值；冻结值与源码是否一致仍由 `checkOracles` 判断。
- Q01 卡中本轮**未做**的步骤：evaluate-java-task 的 strict QA 适配（拒绝 false/string、额外键、重复键、未读源码）；用假模型走一遍 query/evidence/read/write 回执；06 §6.2 第 3 条（编辑评测测试或非允许文件即拒绝）；baseline.md（内容并入本文件和 baseline.json）。

## D5 归因（Q02）

工具已交付；私有数据不可用，ledger 为 BLOCKED_ENV（[attribution.md](attribution.md)）。因此 Q05–Q08 为 NOT_TRIGGERED（无 ledger 证据）。Q09 由实测等待触发，本轮没有 Mac 计时数据，也是 NOT_TRIGGERED。

## D6 outline（Q03）

- 默认 8 条、最多 20 条、wire 4096 B 按冻结合同执行。字节分布实测未做（NOT_RUN），超预算时先省略签名，再省略离 nearLine 最远的条目，标 `SOURCE_BUDGET`，身份字段不删。
- 签名由结构化事实拼出（方法为 `name(参数类型)`，字段为 `类型 名称`，类型为 `kind 名称`），不读源码，不含初始化表达式。字段事实没有名字范围，selection 取声明起点。
- reason 全部复用已有名称，没有新造，因此不需要同步 05。

## D7 evidence v2（Q04）

- `java-evidence-unit/v2`，scope 为 `java-declaration-and-indexed-resource-links`，不做双返回。Java 声明片段先计费，XML 关联在剩余预算内交付。
- 方法放得下就整段给（role=anchor）；放不下就给签名头（role=signature）加请求行附近的窗口，并标 `BODY_PARTIAL`。类型只给声明头。所有片段都是 `proof=SOURCE_FACT`。
- 评测脚本同时读 v1 和 v2，保证旧 trace 能回放。产品只输出 v2。
- 整段交付的方法最多 40 行 / 8000 字节（全局预算的一半）。签名头加窗口的分支里，窗口只按剩余行数选，字节和签名头本身只受全局 80 行 / 16000 字节约束，所以 Java 在极端情况下仍可能占掉一半以上。与 v1 相比，XML 最多少 40 行；SQL 端仍按 8 个 source 封顶，所以 XML 链接达到 7–8 个时可能新出 `UNIT_CAP`。
- 偏离：Java 事实来自 anchor 解析之后的另一次 `queryFiles`，不在 `queryEvidenceSources` 的同一个 read snapshot 里。靠 bundle hash 等于 anchor hash、末尾的 generation 复核和 anchor 字节复核来兜底。
- 新 reason：`SOURCE_NOT_UTF8`（共享读取器先比 hash 再严格解码）、`BODY_PARTIAL`（大方法只给签名头加窗口）。05 已封存，名称登记在这里。
- 局限：构造器和字段的 symbolId 传给 evidence 时，`queryEvidenceSources` 只接受 TYPE/METHOD 锚点，结果是 `ANCHOR_UNRESOLVED`。用 symbolId 定位大方法时，请求行落在签名头里，只会得到签名加 `BODY_PARTIAL`；要看正文，需要传 file/line。
- outline 的 generation 取 `status.indexedGeneration`，不取 file 行的 generation。增量发布不改写未变文件的行，取后者会把正常文件误判为 PARTIAL（review P1，已修，并补了回归用例）。
- 内容放不进 4096 B 时（连空条目的信封都放不下），报现有的 `INVALID_INPUT` 结构化错误，不截断 JSON。

## D8 条件卡（P2）

Q05–Q08：没有 Q02 ledger，记 NOT_TRIGGERED。trigger.state 为 UNASSESSED，意思是没测，不是测出来为零。Q09：没有 Mac 上实测的重复等待，同样 NOT_TRIGGERED。都没有实现代码。上 Mac 跑出 ledger 和计时后再逐卡评估。

## D9 真实 Agent 配对（Q10）

G0 未满足（Q01 控制和 Q02 ledger 都没运行），本轮只交付无费用部分：

- 在 `run-agent-trace-live.mjs` 里加了 `summarizeSchedule`：
  - 分母是全部 slot，出错、超时也留在分母里。
  - 有未运行的 slot（missing）或未判定的 slot（unjudged）时，成功率为 null，不当作失败。
  - 只有每个 attempted slot 的 usage 都是 MEASURED 才求和，否则为 null，不填 0；另外用 `usageCoverage` 给出实际看到的覆盖。
  - 目前还没有任何 runner 调用它。
- dry-run 身份校验（task/dataset/split/corpus/工具，缺项即拒绝）不花钱，但依赖 Q02 冻结的 schedule，本轮未做（NOT_DONE）。
- 外部调用门控复用 `run-agent-trace-matrix.mjs` 现有的 `--authorize-external` 和 BLOCKED_EXTERNAL，不新建 `ilv2-quality-pilot.mjs`。
- live runner 的 MCP session 已经封装了 java_symbol 的 query 和 evidence，但暴露给模型的工具只有 java_impact/java_context。把 java_symbol query/outline/evidence 和原生 read 接成两臂留到 LIVE 之前做（NOT_DONE）。收益记 UNMEASURED。

## D10 资格与收口（P4）

- Q11：[acceptance.md](acceptance.md) 按实际 diff 列出受影响的门，以及要在 Mac 上跑的命令。engineeringEligibility 为 NOT_ASSESSED，benefit 为 UNMEASURED，deployAuthorized 为 false。
- Q12：[decision-log.md](decision-log.md) 列出各方向结论。生产代码净增 +415 行（git numstat）。公共工具仍是 5 个，没有 embedding，没有新 daemon。

## 阶段进度

| 阶段 | 卡 | 状态 |
|---|---|---|
| P0 | Q00、Q01、Q02 | 已 review、已修复、已提交（代码未运行） |
| P1 | Q03、Q04 | 已 review、已修复、已提交（代码未运行） |
| P2 | Q05–Q09 | NOT_TRIGGERED，无代码 |
| P3 | Q10 | 已 review、已修复、已提交（代码未运行） |
| P4 | Q11、Q12 | Q11 BLOCKED_ENV（acceptance.md），Q12 决策日志（decision-log.md）；已 review、已修复、已提交 |

待用户决定：D2 的 ILV2 账本收口；Q10 的 LIVE 授权；在 Mac 上按 acceptance.md 运行受影响的门。

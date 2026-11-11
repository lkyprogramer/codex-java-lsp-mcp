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

## D2 ILV2 状态账本收口（Q00，用户 2026-11-11 已确认）

`docs/index-lifecycle-v2/mac/status.json` 仍为 `planStatus=IN_PROGRESS`、`candidateStatus=NOT_READY`，G17 历史 FAIL，G18/G19 PLAN。提议：

- 账本冻结为历史记录，不改其中任何 FAIL/PLAN；
- “是否已上线”以用户报告为准（USER_REPORTED），不由账本判断；
- G18/G19 不在 post-ILV2 路线中继续，如需重开由用户单独决定。

用户已同意上述三点。账本按原样冻结，`status.json` 不做任何修改。

## D3 冻结项（Q00）

数据集、分母、预算（readPlan minimal 4/6KiB、balanced 6/14KiB、precision 8/20KiB、recall 12/32KiB；evidence 8 units / 80 lines / 16000 bytes；outline 默认 8、最多 20、wire 4096 B）、gold 与 fixture 不变。模型调用、生产安装/重启、源码外发均未授权。

## D4 测量与 repair 判定（Q01）

- 最终请求 receipt：`scripts/ilv2-mac-delivery-receipt.mjs`，语义对齐计划包 `tools/check_delivery.py`；`openai-compatible-chat.mjs` 新增 `onSerializedBody`，receipt 绑定实际发送的同一串字节。
- MAC-10 repair oracle：加入评测方自带的 `OracleCompletionWrapper`，测试 main 正常返回才写完成凭据；PASS 需要 `COMPLETE` 且仍有 `ORACLE PASS` 行。凭据只防偶然误判，不是对同权限恶意代码的沙箱。
- `eval-repair-adapter.mjs` 调用仓库外的 Python 冻结判定器，本轮不改，局限记入 Q01 结果。
- 前提：oracle 测试必须以 main 正常返回表示成功。若私有 mac10-v3 的 oracle 在成功时调用 `System.exit(0)`，新判定会把正确修复判为 TEST_FAILED。上 Mac 后先跑一次 `checkOracles`，known-good 不是 PASS 就停下来登记，不能放宽判定。
- receipt 里的 oracleHash 取实际编译的测试源码的 sha256，不取冻结声明值；冻结值与源码是否一致仍由 `checkOracles` 判断。
- Q01 卡中首轮未做的步骤已在补缺轮写完（均 NOT_RUN）：strict QA 沿用现有 `scoreQaAnswer`/`scoreRunOutcome`，只补控制用例（false/"false"、2/"2"、null、重复键、额外键、缺一行必需证据）；假模型全链经 `runLiveEvalRun` → `openaiCompatibleChat`（假 fetch）→ `receiptUnitsFromEvents` 从最后发送的 body 生成并验证 receipt，含"只留路径"、发送早于工具结果、写后重读三类拒绝；06 §6.2 第 3 条由新增 `eval-repair-adapter.test` 固定现有 allowed_edits 策略；新增 [baseline.md](baseline.md)。

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
- 整段交付的方法最多 40 行 / 8000 字节（全局预算的一半）。签名头加窗口的分支按剩余行数和实际 UTF-8 字节收窄窗口。签名头与请求行无法同时容纳时优先交付可容纳的请求行。Java 片段与 XML 共享全局 80 行 / 16000 字节上限，Java 片段仍可能占掉一半以上。SQL 端仍按 8 个 source 封顶，所以 XML 链接达到 7–8 个时可能新出 `UNIT_CAP`。
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
  - 补缺轮起由 `assemblePack` 调用（`pack.schedule`）。
- dry-run 身份校验（补缺轮已写，NOT_RUN）：`checkRunIdentity` 加 `--require-identity`，在冻结 schedule 之前对未知任务、未知或重复的臂、未命名的 dataset/split、找不到的 corpus、缺少的产品 server 一律拒绝（exit 2）；不加该参数时只把结果记进 `pack.identity.identityCheck`。12×2×3 的具体 schedule 仍要等 Q02 冻结任务。
- 外部调用门控复用 `run-agent-trace-matrix.mjs` 现有的 `--authorize-external` 和 BLOCKED_EXTERNAL，不新建 `ilv2-quality-pilot.mjs`。
- 两臂 runner（补缺轮已写，NOT_RUN）：不新建 runner，扩展 `evaluate-java-task.mjs` 的 `runLiveEvalRun`（底层就是 `runLiveAgentTask`，每臂原生工具相同：list/rg/read，repair 另有 write/replace/test；每次尝试独立候选副本，同一冻结 schedule）。臂 `b0/b1/b2` 对应同一 server 上的 profile `broad` / `outline` / `outline-evidence`；模型看到的 `java_outline` 映射到 `java_symbol operation=outline`，不消耗源码预算，也不计为已收到源码。`summarizeSchedule` 已接进 `assemblePack`（`pack.schedule` 及 byArm）。进入模型之前（候选副本、product session）的失败记为 BLOCKED_SETUP，不算任务失败。`pack.schedule` 的成功率在有未运行/阻塞/未判定 slot 时为 null，而沿用的 `pack.taskSuccessRate`/`byArm` 把缺失算失败，引用时须说明口径。outline 不占源码预算却提供额外结构信息，与 06 §6.4"同预算"有张力，报告结果时须披露。局限：同一 server 上只能比较"是否提供 outline / evidence 工具"，不能比较 evidence v2 与 Q04 之前的 server；Python 冻结 scorer 未核对 product/control 以外的臂名；receipt 仍是事后生成。收益记 UNMEASURED。

## D10 资格与收口（P4）

- Q11：[acceptance.md](acceptance.md) 按实际 diff 列出受影响的门，以及要在 Mac 上跑的命令。首次交付时 engineeringEligibility 为 NOT_ASSESSED；`b96a9c1` 在 Mac 上跑完全部门后登记为 ENGINEERING_ELIGIBLE（构建为 `71e5ce8` 加未提交 diff，见 Q11.json）。benefit 仍为 UNMEASURED，deployAuthorized 为 false。
- Q12：[decision-log.md](decision-log.md) 列出各方向结论。生产代码净增 +415 行（git numstat）。公共工具仍是 5 个，没有 embedding，没有新 daemon。

## D11 MAC-10 LIVE 适配与评测协议 v1.7（Q10，2026-11-11）

协议版本：`b96a9c1` 把 `EVAL_PROTOCOL_VERSION` 从 v1.5 直接改到 v1.7，并重写了各臂共用的系统提示词和 `java_evidence` 工具描述。git 历史里没有 v1.6，提示词改写的依据也没有记录。[evaluation-protocol-v1.7.json](../next-stage/evaluation-protocol-v1.7.json) 按 v1.5 加增量的方式登记，并写明 provenance 为 NOT RECORDED。凡是用旧协议跑过的题都视为已暴露；v1.7 结果不与 v1.5 及更早结果比较。

MAC-10 LIVE 适配（新文件 `scripts/eval-mac10-live.mjs`，`evaluate-java-task.mjs` 接入）：

- 入口：`--dataset` 加 `--inputs` 时启用。必须显式给 `--source-budget none|LINES:BYTES`。repair 题的 JDK 只取 `ILV2_TOOLCHAINS`，不提供覆盖参数，javaHome 下所有冻结文件逐个核对 hash，漂移即拒绝。以下情况都 exit 2：与 `--repo-roots`、`--kit-root`、`--public-answer-contract` 同时出现；非 MAC-10 行带 `--inputs` 或 `--source-budget`；MAC-10 LIVE 没有 `--inputs`。dry-run 保持原行为。
- 语料：输入 checkout 必须停在冻结 head，并且没有未跟踪、被忽略或已修改的文件，否则拒绝。原因是 `materializeCorpus` 复制的是工作区，构建产物（修复后或隐藏测试的 .class）会泄漏给 agent。语料用检索 runner 的 `materializeCorpus` 生成：冻结树、repair 前态覆盖、删除隐藏测试，并校验 overlay、hidden 和 evidence 的 hash。绝不直接用原始仓库。
- 答案合同：取自数据集自己的 answer-contract 部分，hash 由 manifest 固定。`string-set` 对外是字符串数组，按集合评分：排序后比较，有重复即失败。
- QA 成功：答案正确，且每一行 required evidence 都必须在实际发出的请求里收到，并且来自策展人核验时的那个文件版本（`file_sha256` 等于 `fileContentHash`）。同时有预算时不超预算。每行另记 `answerCorrect` 和 `requiredEvidenceCovered`（06 §6.5）。
- repair 成功：只允许改 oracle 的那一个文件，其他改动在运行 oracle 之前就判为 `REJECTED_DISALLOWED_EDIT`。oracle 文件变成 symlink 或目录时判为 `REJECTED_NOT_REGULAR_FILE`。之后用 MAC-10 oracle（冻结 JDK 的 javac/java，加完成回执）判定。judge 自身出现任何异常都记为 `JUDGE_ERROR`，该 slot 不计分，不算 agent 失败。oracle 测试源码不进入候选副本。
- 冷启动：MAC-10 适配运行中，每个 product session 在使用前等待 `java_status` 报告 FRESH，默认上限 900 s；包括 repair 写入后重开的 session，这次等待发生在那次工具调用之内。用时记入 `indexReadyMs`，也计入 `elapsedMs`，比较延迟时要扣除。首次就绪失败记为 BLOCKED_SETUP。原因是 `b96a9c1` 之后 outline 在冷视图下会立即返回 NOT_READY，不等待的话 B1/B2 测到的是冷启动而不是工具本身。kit 运行默认不等待（0，保持 v1.5 的计时口径），可用 `--index-ready-timeout-ms` 打开。control 臂没有 product session，不等待。
- 选题：`--pilot N --pilot-seed S` 按 (corpus, category) 分层，用 seed 哈希排序、轮转取题，全程不读 gold，规则和选中的 id 写入 identity。06 §6.6 的 12 题 pilot 用它冻结，不再等 Q02 选题。
- 待用户决定（LIVE 前必须定）：`--source-budget` 取值；用哪个 split（mac10-v3 的 dev 和已看过的 holdout 都只是历史回归集，见 06 §6.1）；pilot seed；模型与费用授权。
- 局限：语料按冻结树物化，同一 corpus 的所有 repair 前态都会叠加在每道题的语料里（与检索 runner 相同）；QA 的 evidence 不会落在被覆盖的文件上（数据集转换时已校验）。原生 `test` 工具对 Gradle 多模块等构建只报告不支持，各臂相同。每次尝试都完整复制一次语料，大仓会占用磁盘和时间。

验证：新增 `scripts/eval-mac10-live.test.mjs`（6 项：fixture 数据集、可移植复制、假 JDK 清单、oracle 桩、假模型；覆盖 JDK 漂移、输入不干净、judge 异常、kit 行误带 MAC-10 参数）。另有 Mac 专用的 `eval-mac10-live-chain.test.mjs`，含 b2 臂 repair 用例：写入前后两次就绪等待，并断言候选里只改了 oracle 文件。独立 review 没有 P1；4 个 P2 均已修复：JDK 未 fail-closed、product 臂 repair 无覆盖、物化可能带入构建产物、judge 异常被算成 agent 失败。P3 中的 symlink、就绪默认值、文档措辞、合同 rules 未传、测试缺口也已修复。在 Linux 开发机上，它与 evaluate-java-task、evaluate-java-task-arms、eval-frozen-adapter、run-agent-trace-live、ilv2-mac-delivery-receipt、eval-evidence-e2e 这几个脚本套件一起运行通过（没有构建 dist，eval-evidence-e2e 跳过 1 项）。Mac 上未运行；真实 APFS 物化和 javac oracle 只在 Mac 上覆盖。

## 阶段进度

| 阶段 | 卡 | 状态 |
|---|---|---|
| P0 | Q00、Q01、Q02 | 已 review、已修复、已提交（代码未运行） |
| P1 | Q03、Q04 | 已 review、已修复、已提交（代码未运行） |
| P2 | Q05–Q09 | NOT_TRIGGERED，无代码 |
| P3 | Q10 | 已 review、已修复、已提交（代码未运行） |
| P4 | Q11、Q12 | Q11 已在 Mac 上验收为 ENGINEERING_ELIGIBLE（`b96a9c1`），Q12 决策日志（decision-log.md） |
| P3+ | Q10 MAC-10 LIVE 适配（D11） | 代码已写，Linux 上定向脚本测试通过，Mac 未运行 |

待用户决定：在 Mac 上按 acceptance.md 重跑脚本套件和 MAC-10 前置检查；Q02 ledger；Q10 LIVE 的预算、split、seed 和费用授权。

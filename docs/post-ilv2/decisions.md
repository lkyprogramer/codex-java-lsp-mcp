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

## D12 本地 MAC-10 验收与 Q02 ledger

在 `d7a295e4` 执行 D11 无模型验收，定向脚本、两条真实 Mac 链路和严格 dry-run 均通过。B2 的真实工具输出在假 transport 的最终请求中完成逐字节校验。72 个 slot 已冻结，实际模型请求为 0。见 [Q10 结果](results/Q10.json)。

Q02 完成 20 个 dev 任务组的 ledger。两个直接声明在离线 Top 3 中被截断，Q07 达到调查阈值。确认产品 ReadUnit 在固定预算下复现相同损失后，才决定是否实施。Q06 仅有一组发现缺口，Q05、Q08、Q09 仍缺充分证据。见 [Q02 结果](results/Q02.json)。

## D13 Q10 正式配对与 Q07 定向复查

Q10 用自部署 `openclaw/Qwen3.8-next` 串行完成 72 个 slot。B0 通过 11/36，B2 通过 15/36。B2 在 6 个 slot 调用 outline、在 6 个 slot 调用 evidence，evidence 在 4 个 slot 提供了通过最终请求校验的源码。按任务组配对的成功率差为 +11.1 个百分点，95% bootstrap 区间覆盖 0，三仓的变化方向不一致。按 G3 判定 `INCONCLUSIVE`，本轮维持现有默认配置。见 [Q10 结果](results/Q10.json)。

Q07 在固定预算下复查两组任务。查询 Top 3 漏掉的 4 个证据范围，在提供对应声明锚点后均由 ReadUnit 覆盖。本轮归因落在查询截断，ReadUnit 维持现状。见 [Q07 结果](results/Q07.json)。

## D14 最终候选工程门与发布判断

`13f9dc9a` 的全量测试、PR 门和工具 schema 测量已通过。后台汇总的记录计数误报已用现有日志离线复核。evidence v2 保留了实测旧 XML 内容及调用方式，版本与 scope 字段变化需要明确发布合同。见 [最终候选验收](acceptance.md#最终候选无模型验收d14)。

Q07 的四个目标在 `limit=3/8/20` 下分别有 0/2/4 个可见，默认查询与显式 `8` 一致。三种上限下首选锚点均覆盖 0/4。先明确 v2 合同和候选选取策略，当前评测维持 `INCONCLUSIVE`。见 [Q07 复测](results/Q07.json)。

## D15 发现与排序阶段（2026-11-12 收尾）

用户于 2026-11-12 批准 D15。outline 和 evidence 的独立模型验证维持 D14 后的状态，发布合同与去留仍由各自决策处理。D15 用 Mac dev 实测完成 W1、W2、步骤 F 和 W6。[D15 W6](d15-discovery-ranking.md#10-w6-收尾决策2026-11-12)

- **W3 停止。** W1 有 78/104 个目标未返回。步骤 B 在响应字节 p50 增幅 ≤10% 的约束下最多新增 3 个 hit@8，低于进入实现所需的 5 个。[D15-W1.json](results/D15-W1.json)
- **F 保持 C0。** Q02 校准通过。C3 在全量 dev 上提升平均召回 3.79 pp，但每题接收源码字节 p50 增加 45.82%，超出 20% 门槛。C1、C2 未达到召回门槛。用户确认按 O2 保持默认 6 个文件、14 KiB，保留投影一致性修复 `828f8a3d`。[D15-F.json](results/D15-F.json)
- **封存集延后。** v1 规则和工具保留供追溯，v2 尚未冻结。本阶段 W4、W5 与正式采纳判定均为 `NOT_RUN`。有新的候选改动时再确定指标和预算，并冻结新规则与数据。[D15 W6](d15-discovery-ranking.md#10-w6-收尾决策2026-11-12)
- **XML-3 已收尾。** 6 道 dev 题的 16 个证据范围包含 15 个 XML 和 1 个 YAML，MyBatis 语句目标为 0。现有样本无法验证 MyBatis 发现。[D15-XML3.json](results/D15-XML3.json)
- **MyBatis 发现方向归档。** 三个冻结语料识别到 0 条 mapper XML 语句，达到 §11.6 的归档条件。MyBatis 发现验证仍为 `NOT_RUN`。[普查报告](results/D15-MYBATIS-CENSUS.json)

## 分支收尾：outline/evidence 默认隐藏（O2，2026-11-13）

用户于 2026-11-13 选择 O2：两个 impact 修复（`828f8a3`、`504a5d6`）照常合入；outline 和 evidence v2 的代码保留，默认不注册。

- 开关：owner 环境变量 `JAVA_LSP_EXPERIMENTAL_SYMBOL_OPS=1`，只认字面值 `1`，作用于整个 owner。stdio 入口只转发，不读这个变量。
- 关闭时（默认）：`java_symbol` 的 operation 枚举只有 query/position/references，没有 `nearLine`，描述里没有 outline/evidence。调用被隐藏的操作会在输入校验阶段被拒绝，handler 不变。main 上原有的 evidence v1 实验操作也不再默认暴露，因为 v2 无法廉价投影回 v1（用户确认）。
- 开启时：描述文本已离线核对，与 D14 候选 `13f9dc9a` 一致；tools/list 字节数待 Mac 测量确认。
- 评测：`openImpactSession` 启动的 owner 一律开启。模型可见工具仍由 `productTools()` 决定，b0 不受影响。MAC11 系统回路测试同样开启。
- 测量：`measure-tool-schema.mjs` 默认测关闭状态，加 `--experimental-symbol-ops` 测开启状态。

Mac 验收（精简）：一次 targeted 隔离运行，编译并跑受影响的测试：`dist/mcp-server-factory.test.js`、`dist/tools/symbol-static.test.js`、`dist/tools/output-shape.test.js`、`scripts/eval-evidence-e2e.test.mjs`、`scripts/run-agent-trace-live.test.mjs`。`measure:tool-schema` 两种状态各测一次。全量 `npm test`（含 stdio smoke）和 `npm run gate:pr` 在合入 main 前跑一次。硬门是开启状态：5 个工具、9,086 B，`java_symbol` 3,532 B，与 D14 一致。关闭状态只记录不设门；预期 `java_symbol` 小于 main 的 2,883 B，粗估约 2,670 B（main 减去 evidence 说明、枚举项和 `symbolId` 描述里的 evidence 字样）。

## 开关保留：维护预算的例外（2026-11-13）

用户选择 A：保留 `JAVA_LSP_EXPERIMENTAL_SYMBOL_OPS` 开关及 outline/evidence v2 代码。这是对 [15 维护预算](../java-specialist-post-ilv2-v1/docs/15-java-workflow-priorities.md)"新开关若只用于对照，试验结束后删除一边"的例外。

- 理由：开关不只用于对照。评测 b1/b2 臂、`eval-evidence-e2e`、MAC11/MAC13 测试和 D15 §12 诊断（outline 作 oracle）都依赖它；删除约 +415 行生产代码，且与 `b96a9c1` 的修复交织。
- 成本：两套注册面（关闭/开启）都要测。`mcp-server-factory.test` 覆盖两种状态，`measure-tool-schema` 两种状态各测一次。
- 复查条件：下一次真实 Agent 评测中，outline 或 evidence 仍为 INCONCLUSIVE 或 NO_GAIN 时，删除对应代码和开关。

## 合入前代码评审（2026-11-13）

`/code-review high` 覆盖 `origin/main...HEAD` 下的生产代码，结论：默认路径无阻断缺陷。用户选择将实验功能的问题登记为已知问题，直接开 PR。

- 默认路径：`format.ts` 在读取计划文件缺少 ID 时 throw，当前不可达（`java_impact` anchors 最多 5 个，候选输出上限最少 16 个；`readPlanMaxItems` 已被 `boundReadPlanMaxItems` 限制），作为断言保留。main 原有的 evidence v1 默认下线是 O2 的有意变更。
- 已知问题（仅在 `JAVA_LSP_EXPERIMENTAL_SYMBOL_OPS=1` 时生效，决定保留 outline/evidence 时再修）：
  1. `evidence-unit.ts`：`queryFiles` 的非超时异常被吞掉，报成 `ANCHOR_UNRESOLVED`；outline 对同类错误会重新抛出，两者不一致。
  2. `outline.ts`：为校验哈希整文件读取并严格按 UTF-8 解码，非 UTF-8 或超过 2 MB 的文件拿不到声明。
  3. `outline.ts`：用 `realpath(repoRoot)` 解析绝对路径，macOS `/var` 与 `/private/var` 两种写法会被误判为仓库外。
  4. `evidence-unit.ts`：Java 片段的签名头行数不封顶、窗口字节按全局上限计算，极端情况下 XML 关联被挤掉（README 已写明字节和签名头只受全局上限约束）。
  5. `evidence-unit.ts`：类型声明头 8 行内找不到 `{` 时只保留名字行，extends/implements 丢失。
  6. `evidence-unit.ts`：请求行落在过长签名头内时，该行重复发送、重复计入预算。
  7. `symbol.ts`：outline 空信封超过 4096 B 时返回 `INVALID_INPUT`，应为带预算原因的 PARTIAL。
  8. `outline.ts` 与 `evidence-unit.ts`：覆盖范围查找和路径包含逻辑重复，应移入 `evidence-source-reader.ts`。

## 阶段进度

| 阶段 | 卡 | 状态 |
|---|---|---|
| P0 | Q00、Q01、Q02 | Mac 控制已跑，Q02 ledger 已生成 |
| P1 | Q03、Q04 | Mac 定向回归通过，模型收益未测 |
| P2 | Q05–Q09 | Q07 调查完成，损失定位到查询截断 |
| P3 | Q10 | 72 个正式 slot 完成，收益判定 INCONCLUSIVE |
| P4 | Q11、Q12 | `b96a9c1` 的 Q11 工程资格已确认，`13f9dc9a` 的工程门已通过，Q12 决策见 decision-log.md |
| P3+ | Q10 MAC-10 LIVE 适配（D11） | Mac 无模型验收及 72-slot dry-run 通过 |
| P5 | D15 发现与排序 | W6 已收尾。W3 停止，F 判为 O2 并保持 C0，封存集延后。XML-3 已对账，MyBatis 发现方向按普查结果归档。见 [D15 收尾决策](decision-log.md#d15-收尾) |
| P6 | 分支收尾 | O2 已在 Mac 定向验证通过（[P6-O2](results/P6-O2.json)）。D15 §12 发现层诊断已收尾，无产品缺陷。开关按 A 保留。Mac 全量 `npm test`（2405 通过、0 失败、10 个白名单跳过，含 stdio smoke）与 `gate:pr`（1658 通过、0 失败、1 个既有跳过）已通过，见 [P6-GATES](results/P6-GATES.json)。合入前评审无默认路径阻断缺陷，实验功能问题已登记（见上）；走 PR 合入 |

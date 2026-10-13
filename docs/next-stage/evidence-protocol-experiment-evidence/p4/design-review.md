# P4 模型对照预注册评审

2026-10-11。状态：只读设计评审完成，建议按以下方案冻结。未运行模型、未修改仓库、未改原始任务/gold/scorer。P3 完成实施评审、相关测试与实际容量实验记录后，根代理再冻结 integrated executable candidate、实际 model/config 与本设计，然后执行模型实验。容量结果允许 FAIL，历史 FAIL 必须保留；实验性 reader 配置必须独立记录，不让双 reader 干预混入工具 profile 效果。

## 冻结方案与决策边界

完整对照：原 36 题（28 QA + 8 repair）× native control / product broad × repeat=1，共 72 个计划 slot。两臂均使用 eval-protocol/v1.4、相同公开 submit/budget prompt、seed=1984、maxRounds=16、completion cap=2048、配置的 openclaw/Qwen3.8-next、reasoning none、enable_thinking=false。实际 provider 是否遵守参数不能由请求配置推断。QA 保留原 160 行/16000 字节及其余任务预算；严格 QA 原门槛 80% 与冻结 scorer 不改。QA 与 repair 分列，不能用全部36题成功率替换28题QA门槛。完整运行 product_profile 固定 broad。

有界诊断：下列 4 题 × product broad/evidence/exact-evidence × repeat=2，共 24 slot。完整两臂与诊断分开存档，合计 96 次计划尝试，smoke 若有则另表。不得从 smoke 或完整结果择题、改 profile 顺序、替换失败、用诊断回填完整运行。所有题已经暴露；这批数据只能判断既有题上的可复现行为和成本，不能证明泛化或发布通过。

24 次足以做机制诊断与发现直接退化，不足以估计总体质量优势或稳定费用节约。最小改进是同题配对、反向执行、冻结指标、原始 payload 审计及成本分解，不增加题数或重试。根代理已确认不新增 method→XML 模型题；该能力在模型层明确未测，仅引用 P2 真实 Java parser/SQL/XML 离线验证。不能把离线证明换成模型成功。

## 能力选题（依据公开问题与源码形状，未按 gold 答案挑题）

| 固定 ID | 能力与选择依据 | 能回答的诊断问题 |
| --- | --- | --- |
| JSB-PAYMENTS-02 | 题目要求收据字段→XML列及组装方法；源码是 Java Receipt / ReceiptAssembler 与一个 resultMap XML，没有 Java Mapper 方法。强制保留的 resultMap 案例。 | 显式 TYPE evidence 能否真正送达 XML，并在同预算内满足跨 Java/XML 证据；“答案正确而XML未送达”必须失败。 |
| JSB-HIKARI-01 | 公开题直接给出 FastList.remove(Object)，已知 Java 入口；源码存在 remove(Object)、remove(int)、removeLast 等，仍需区分重载并读取实现。 | 有 exact 定位条件时 broad 是否产生额外调用/重传；evidence 工具存在但无 XML 可用时是否诱发无效探索。 |
| JSB-NOTIFICATIONS-01 | 公开题是中文“频道接收人数”，未给方法名；源码 DispatchBus.recipients 与 subscription 计数，中文词与英文标识符不天然同词。 | 未知入口 lexical broad 的收益/词汇缺口，exact profile 回退 native rg/read 的实际代价；不根据 gold 补英文提示。 |
| JSB-MYBATIS-02 | 题目给 List/array 参数封装行为，未给负责方法；上游 ParamNameResolver 多分支及 helper 跨源码窗口。尽管项目名 MyBatis，实际任务是 Java 参数封装。 | 在有限预算内完成依赖链、多证据窗与精确值推演的压力；不得将该题误归类为 Mapper method→XML。 |

只读枚举 baseline-kit/dataset/corpora：业务 Mapper XML 仅 payments/ReceiptMapper.xml（POM 不算业务 XML），不存在可映射 Java Mapper 方法的原36题。因此无法在不改任务集的前提下同时覆盖 method→XML。contracts/fixtures/resource 有 demo.UserMapper 与 UserMapper.xml，但没有原计划任务 ID；本轮不把这个 fixture 偷换成原题。第四题用于 Java 多窗压力，保留这项缺口。

## 四个工具配置的实际语义

| 配置 | 真实提供能力 | 必须保留的限制 |
| --- | --- | --- |
| native control | list/rg/read/submit_answer；repair 另有 write_file/replace_file/test | native 文本和文件工具，不是全 Java LSP/JDT 语义基线。 |
| product broad | native + evaluation java_symbol，auto/exact/text，terms，opt-in previews | 词法静态声明搜索；缺词可空。v1.4 省略 preview 为 none，不能称原 public preview 默认。 |
| product evidence | broad + evaluation java_evidence | 既有 indexed MyBatis 完整 FQN TYPE/resultMap 和 METHOD/XML 关联、显式有界 source unit；不提供任意 XML 语义。 |
| product exact-evidence | native + exact-only java_symbol + 相同 java_evidence | terms/text 不可用，query 只接受确切符号/FQN/owner#method；native rg/read 仍能广泛搜索。 |

源码 productTools / invoke 表明 evidence 与 exact-evidence 使用同一 java_evidence schema、session.evidence→java_symbol(operation=evidence) 路径。exact-evidence 修改 java_symbol 描述/schema并强制 searchMode=exact。所以 evidence−broad 衡量“可用显式 evidence 工具包”的干预，exact-evidence−evidence 衡量“移除 broad product discovery 并改变其说明/schema”的干预；不是纯底层搜索算法差异，也不是取消一切 broad discovery。模型可选择完全不调用新增工具，不能强制一次使用来救结果。

四配置不等于 native/full Java/JDT 能力等价。当前 session 只向模型暴露评测所列工具；impact/context 虽存在于 session 实现，未提供给本轮模型。openImpactSession 使用 isolated validation、JDTLS_BIN 默认 /usr/bin/false；本实验不证明 references、implementations、类型解析等完整 JDT 能力优劣。

## 24 slot 执行顺序

B=broad，E=evidence，X=exact-evidence。所有 slot 串行执行；每个 slot 新 workspace/session/cache，禁止提前预热/建索引。repeat 是任务的重复索引，不把 profile 当 scorer 的新 arm 偷改原协议；建议每 slot 独立目录，汇总用 experimentId/taskId/profile/repeat 全键，避免现有 taskId/arm/repeat 去重碰撞。

| 顺序 | task | repeat | profile |
| ---: | --- | ---: | --- |
| 1 | JSB-PAYMENTS-02 | 1 | broad |
| 2 | JSB-PAYMENTS-02 | 1 | evidence |
| 3 | JSB-PAYMENTS-02 | 1 | exact-evidence |
| 4 | JSB-HIKARI-01 | 1 | evidence |
| 5 | JSB-HIKARI-01 | 1 | exact-evidence |
| 6 | JSB-HIKARI-01 | 1 | broad |
| 7 | JSB-NOTIFICATIONS-01 | 1 | exact-evidence |
| 8 | JSB-NOTIFICATIONS-01 | 1 | broad |
| 9 | JSB-NOTIFICATIONS-01 | 1 | evidence |
| 10 | JSB-MYBATIS-02 | 1 | broad |
| 11 | JSB-MYBATIS-02 | 1 | evidence |
| 12 | JSB-MYBATIS-02 | 1 | exact-evidence |
| 13 | JSB-MYBATIS-02 | 2 | exact-evidence |
| 14 | JSB-MYBATIS-02 | 2 | evidence |
| 15 | JSB-MYBATIS-02 | 2 | broad |
| 16 | JSB-NOTIFICATIONS-01 | 2 | evidence |
| 17 | JSB-NOTIFICATIONS-01 | 2 | broad |
| 18 | JSB-NOTIFICATIONS-01 | 2 | exact-evidence |
| 19 | JSB-HIKARI-01 | 2 | broad |
| 20 | JSB-HIKARI-01 | 2 | exact-evidence |
| 21 | JSB-HIKARI-01 | 2 | evidence |
| 22 | JSB-PAYMENTS-02 | 2 | exact-evidence |
| 23 | JSB-PAYMENTS-02 | 2 | evidence |
| 24 | JSB-PAYMENTS-02 | 2 | broad |

每题第二次反向；每对 profile 在8个 task/repeat block 中各有4次先行。8个block不能均分3个位置：E在中间4次，B/X各2次，位置效应仍有残余。任务顺序也反向，使每题两次落在对称时间段；不能消除 provider drift/cache effects。实际首次请求时间另派生 actual-execution-order，不把计划表冒充执行。

## 预注册指标和解释

1. **主结果**：每个 slot 的 frozen qa_contract_pass / repair validatedSuccess 与状态。完整对照按 task 配对列双方成功、仅product、仅control、双方失败；QA 分母28/arm，全部任务36/arm。诊断每profile分母8，逐题两次分别列出，不把24次当24个独立问题。
2. **失败分解**：accepted/rejected/missing typed submission，是否经一次public-contract recovery，原stop reason；strict value match、format/contract valid、required evidence complete、budget pass 分开保留。可以并列多失败标记，避免强行单一原因遮盖信息。来源送达仅 SOURCE_RECEIVED / dispatched receipt，发现路径、raw fetched、unit complete均不等于 required evidence complete；不宣称注意力。
3. **来源用量**：逐slot收到source行/UTF-8字节、重复source切片、XML evidence调用/实际送达/遗漏或截断。原 scorer source计费不变；累计历史重传payload费用是独立指标，不再充抵源码预算。
4. **provider usage**：逐请求input/output/cached input的原始usage、hash及逐slot总和；missing为null，不能以0或bytes/4估算。input−cached仅在两字段都有实测且cached<=input时报告，标为uncached input，并非全部计费token或美元费用。
5. **累计payload重传**：从每次实际provider request.messages中对role=tool消息content的UTF-8字节求和，包括恢复请求和相同历史消息重发。报告sum、首次唯一tool-message量及重复部分（按attempt内tool_call_id + exact content hash识别）；同时报告全request payload bytes，注明是否含system/tool schemas。缓存token与字节重传不是同一计量。不能用raw-tool-results体积替代实际发送体积。
6. **工具调用**：provider尝试调用数、实际invoke数按工具分列；拒绝或mixed submit不调用工具时单列，不能只用现有toolCallCount冒充全部provider请求动作。
7. **时间**：monotonic total attempt wall（从workspace准备开始直到session关闭结束，含失败路径）、candidate准备、session connect、每次symbol/evidence（含首次）、model-request耗时、judge耗时、close耗时；一轮总wall另测。不提前调用工具来“测ready”。

完整对照报告每arm总量与逐task配对差值；repair与QA分开列。诊断只给逐题两rep和同task/rep配对差值，少量样本不给可靠P95或显著性保证。实测unknown/null字段同时报告coverage分母。可以报原28 QA的描述性区间，但暴露/固定题相关性使区间不代表生产总体抽样；无需为形式完整添加不成立的独立同分布检验。

## 索引成本只读核查

runLiveEvalRun 的 elapsedMs 从创建workspace之前开始，到agent和repair judge完成之后取值，包含session connect，却不包含finally.close；FAILED_RUNTIME catch不写elapsedMs。assemblePack还会省略elapsedMs，因此必须保留live runs和launcher独立计时，不能从最终pack补猜。

openImpactSession只await client.connect，未显式等待索引READY。首次symbol/evidence可能包含延迟建索引、查询、进程/IPC和序列化；包装openSessionImpl记录connect与各次调用是最小可测路径。该数据应称 sessionConnectMs / firstProductQueryMs（混合），不能称indexBuildDuration。

src/index-builder/progress.ts的BuildProgress为phase/done/total，meta有buildState/indexedGeneration/counts/sourceRootCounts，未发现持久化build开始/结束时间或duration。事后read-only SQLite snapshot只能验证最终状态/覆盖，不足以恢复独立建索引时长；filesystem mtime也不是建索引时钟。独立indexBuildDuration本轮明确 UNMEASURED。launcher只包已有exports，不增加prebuild/prewarm，不改变模型可用工具或source路径。

## 保留历史、复用证据与结论规则

历史k29-remediation-review：v1.3完整72次/458次provider，product严格17/28、control19/28，仍未过80%；PAYMENTS-02 product答案正确但缺XML，control格式失败。用于说明机制与审计字段，不用于本轮择优换题，不把v1.3→v1.4差值归因单项修复（typed submit、locator默认等共同变化）。P2 core-report证明resultMap和METHOD真实parser/SQL离线路径；不等于模型已使用它们。

本轮历史失败、预算失败、blocked、runtime、timeout和missing都保留在预注册分母，不删历史、不覆写v1.3、不做gold归一化。修复后的retry若必要必须追加标明，不能替换已执行slot；这次不自动扩大样本。若模型批次无授权，则BLOCKED_AUTH，不编造零分benchmark。

只有同题两rep都观察到对应XML送达/严格成功改善，才能称“该题上的重复机制支持”；若工具未用或source仍缺，不能宣称evidence解决问题。exact-evidence即使四题不输也不足以删除公共broad。本轮最高可做实验配置保留/放弃的决定；缺乏稳定收益时保持公共broad，不能为了救实验添加gold词汇、任意intent handler或扩大XML语义。

## 冻结摘要（本次只读实测）

- ROOTold/tasks.jsonl：36 rows，SHA256 `dec9129e685b12510ab3f116e1245be549b6c468bfb820d157a2030542dc6eee`。
- ROOTold/gold.jsonl：36 rows，SHA256 `6774d9d48879c199bda6307e4ddc896c075ee06b6a9a7ba0dce39c86eacacf78`。
- docs/next-stage/evaluation-protocol.json：`a2f06a1cfa3ce2c9457495d49d0dc7e5a7fdc5ba66fd9696a14a8ed66e71f5c5`。
- scripts/evaluate-java-task.mjs：`207ab365e9d82a53361ddc226664974a0f1ec29d157ce6b82909921b9b6f3246`。
- 实际productTools的schema+description：按 broad,evidence,exact-evidence 顺序组成对象，JSON.stringify UTF-8无换行 SHA256 `c01268d809f0e1653200d45018f0218f1a0ee9edc82229f2bf5a3dfbdc765332`。
- EVAL_SYSTEM_PROMPT 原始UTF-8 SHA256 `ddea5b9889178ff38decd6bcbd9b7bd19b02c6be24ac764d96e8b84b4205482f`。

上述是设计读取时摘要，最终integrated freeze再核对。建议launcher冻结并归档原protocol bytes、productTools原JSON、实际每task submit schema、native tools schemas、公开prompt与24slot计划，以及原149文件dataset/harness/corpus manifest、scorer/source digest、reader配置、argv与model request参数。schema/description有漂移先记录并重新审阅，不静默继承摘要。不要读取或归档凭据。

置信度：工具边界、题集覆盖缺口和持久化计时缺口为当前源码/文件直接证据，高；四题能显示机制方向为设计推断，中；效果大小、费用收益、总体优势未测。最佳下一证据是冻结后96次原始request/response/source审计，不是再扩大样本。

只读来源：docs/next-stage/evidence-protocol-experiment-plan.md；docs/next-stage/evaluation-protocol.json；docs/next-stage/k29-remediation-review.md；scripts/evaluate-java-task.mjs；scripts/run-agent-trace-live.mjs；src/index-builder/progress.ts；ROOTold/tasks.jsonl与gold.jsonl；baseline-kit/dataset/corpora源码及contracts/fixtures/resource；ROOT/p2/core-report.md。定向Nowledge查询未找到可替代当前源码的P4证据；未使用历史记忆推定现状。

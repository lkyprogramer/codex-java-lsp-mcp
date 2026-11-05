# P4 最终独立数据与决策评审

2026-10-11。结论：本轮数据完整性与结果映射评审 PASS，无剩余阻断 finding；原严格 QA 门槛 FAIL。公共 broad 暂不收缩；exact-evidence 仅保留实验 profile，不替代公共 query，不扩大 XML 语义，生产默认 reader=1 不变。

## 证据范围与独立检查

full 72/72 与 diagnostic 24/24 均 COMPLETE，合计96计划尝试。审计owner最终 `audit-model.mjs --final` 记录11026项检查、0错误。独立评审先检查脚本，再一次直接读取full72原live/冻结report/slotpack/aggregate/terminal与56次QA来源数据；诊断齐全后仅做24次增量直接核查，没有重跑模型、重评分、修改scorer、扩样或替换历史结果。

独立检查已执行并观察PASS：

- full28 QA + 8 repair / arm，72全键唯一；诊断24个profile/blockRepeat计划键、冻结执行顺序与最终六组×4均一致。slot、aggregate、terminal成功值与原frozen QA或外部repair judge对应一致。
- QA slot frozenScore的strict/valid/budget/evidence/lines/bytes与原Python报告一致；gold required_evidence逐行覆盖独立重算，与原报告相符。所有QA source文本及整文件snapshot SHA256、真实行窗独立验证，源码预算仍160行/16000字节；没有把rg导航文本算源码。
- 从保存的原始provider响应独立汇总input/output/cache，全部实测整数非负，cached<=input；从每次实际messages中独立计算tool历史重传字节。full323、diagnostic97，共420请求对应420响应，完整usage/cache覆盖，没有provider缺失请求。
- summary数值与上述直接读取相符；审计补充核对raw response→实际invoke→payload→receipt，以及已接受typed submission的公开合同、独占调用和已dispatch来源边界。

审计初读时发现缺少slot→原QA评分、最终terminal键/评分/usage及缓存范围直接断言，已由owner补齐并通过FINAL。整数/array格式使用候选原 `validateSubmission` 和实际公开合同；新增整数、array等正反self-check，避免typeof把integer或array误判为格式失败。

## 完整两臂实测

| 指标 | native control | product broad |
| --- | ---: | ---: |
| 严格QA | 12/28（42.86%） | 12/28（42.86%） |
| 外部冻结repair judge | 8/8 | 8/8 |
| 全36题成功 | 20/36 | 20/36 |
| QA typed公开格式通过 | 28/28 | 28/28 |
| QA答案值精确匹配gold | 19/28 | 16/28 |
| QA必需证据完整 | 20/28 | 24/28 |
| QA预算通过 | 28/28 | 28/28 |
| provider请求/响应 | 178/178 | 145/145 |
| provider input tokens | 280894 | 305678 |
| provider output tokens | 8925 | 7804 |
| provider cached input tokens | 209868 | 212322 |
| input−cached（实测差值） | 71026 | 93356 |
| 实际检索/编辑工具invoke（不含submit） | 164 | 139 |
| provider请求工具actions（含submit） | 200 | 175 |
| 累计tool消息UTF-8字节 | 214132 | 310655 |
| 首次tool消息字节 | 94934 | 136126 |
| 历史tool消息重复字节 | 119198 | 174529 |
| 累计block wall ms | 244499.193 | 300355.555 |

36题配对：双方成功17，仅control成功3，仅product成功3，双方失败13。全部72次accepted submit，无recovery；不能将值或证据失败称为JSON格式失败。

QA失败分解是并列事实，不由一个标签遮盖：control有7次仅缺必需证据、8次仅gold值不符、1次二者均有；product有4次仅缺证据、12次仅gold值不符。“gold值不符”表示原严格合同不匹配，不自动代表全部语义事实错误，更不能据此归一化答案或改gold。

Product在本轮既有题上证据送达更多、工具invoke更少，但严格QA没有提高，input/uncached input/重传字节及累计wall更高。不能宣称整体质量优势、token节约或货币费用下降。原80% QA要求不变，两臂均未通过；repair8/8不能替代QA门槛。

## 有界profile诊断实测

| 指标（每profile 8次） | broad | evidence | exact-evidence |
| --- | ---: | ---: | ---: |
| 严格成功 | 1/8 | 3/8 | 2/8 |
| 必需证据完整 | 5/8 | 7/8 | 6/8 |
| accepted submit / 预算通过 | 8/8 / 8/8 | 8/8 / 8/8 | 8/8 / 8/8 |
| provider请求/响应 | 27/27 | 33/33 | 37/37 |
| input tokens | 57169 | 87303 | 79895 |
| output tokens | 1556 | 2006 | 1914 |
| cached input tokens | 37207 | 61641 | 60531 |
| input−cached | 19962 | 25662 | 19364 |
| 累计tool消息字节 | 63329 | 110275 | 68187 |
| 历史重复tool消息字节 | 29783 | 59699 | 40700 |
| 实际工具invoke（不含submit） | 27 | 27 | 33 |
| java_evidence调用/结果消息delivery | 0/0 | 5/5 | 3/3 |
| java_evidence实际源码units收到 | 0 | 1 | 2 |
| 任何工具的XML源码收到attempts | 0 | 2 | 2 |

按task/repeat列出strict原结果：

| task | broad r1/r2 | evidence r1/r2 | exact-evidence r1/r2 |
| --- | --- | --- | --- |
| PAYMENTS-02 | FAIL / FAIL | PASS / FAIL | FAIL / FAIL |
| HIKARI-01 | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL |
| NOTIFICATIONS-01 | FAIL / FAIL | FAIL / FAIL | FAIL / FAIL |
| MYBATIS-02 | PASS / FAIL | PASS / PASS | PASS / PASS |

java_evidence的消息delivery不等于源码unit送达。evidence5次结果中只有1次非空源码unit，其余2次READY_EMPTY、2次ANCHOR_UNRESOLVED；exact-evidence3次结果中有2次非空源码unit、1次ANCHOR_UNRESOLVED。错误/空结果不能记成“送达5个/3个XML证据”。

PAYMENTS-02具体来源核查：

- evidence repeat1通过：read送达Receipt和ReceiptAssembler，java_evidence送达XML resultMap第2–4行。该单例证明新TYPE unit可在原预算下补齐XML来源，并与Java来源共同满足严格合同。
- evidence repeat2失败：只有native read送达XML第1–5行，缺Java必需证据。此处XML不能归因java_evidence；新增工具结果消息并不代表它提供了源码。
- exact-evidence两个repeat均由java_evidence送达XML unit，同时也native read过XML/Receipt，但两次都缺ReceiptAssembler所需证据；repeat1另有gold值不符。XML送达没有转化为严格成功。
- broad两个repeat均答案值匹配，却没有所需源码送达，仍按原评分失败。

因此新unit具有实际XML送达机制的单例成功证明；没有PAYMENTS严格通过的重复证明。MYBATIS-02是Java参数封装题，不是method→XML；method→XML仍只有P2真实parser/SQL/XML离线证据，本轮模型层UNMEASURED。

## 指标解释与决策边界

工具重传字节按每attempt provider callId + exact contentHash的首次/重复出现区分，再累加每个实际request的role=tool content UTF-8字节；不是raw-tool-results大小，也不等于重复源码预算。messagesBytes是JSON.stringify(messages)字节，包含消息结构，不含tool schemas。现有raw只记录工具名，完整HTTP payload/wire未测；不能估算补值。缓存字段实测完整，但tokens仍不是货币价格。

blockWall包括workspace、session连接、模型、repair judge与close，排除另记Python QA scoring；overall还包括评分及编排。session连接只证明connect，首次product query混合lazy index准备/查询/IPC/序列化；独立indexBuildDuration未测。provider缺失reasoning_tokens为null，不标0或据此断言服务端没有思考。orderingSeed=1984是编排seed，providerSamplingSeed=null。

四profile比较的是实际暴露工具包，不能解释为全Java/JDT能力对照。exact-evidence仍可native rg/read广泛搜索；evidence与exact-evidence同用XML unit路径，但java_symbol schema/description及可用搜索模式不同。没有强制模型使用新增工具，也没有增加gold词汇提示。

全部36题及四题诊断都已暴露；完整对照一次、诊断两次，不是独立holdout。四题1/8、3/8、2/8不足以推断生产总体效应或删除公共broad，不能以多次attempt冒充更多独立问题。诊断显示exact-evidence没有在四能力层全面占优；缩小公开能力范围需要本轮之外、另行冻结且独立的证据。

root决定与证据一致：公共broad不收缩，exact-evidence保留实验，XML停在既有完整FQN关联边界，默认reader1不变。达到本轮界限后停止扩样/改提示/加handler/扩大XML语义；若后续另行授权研究，最小先看本批已送达完整源码却gold值不符的具体字段与公开合同，区分推演错误和严格字面要求，仍不修改或重评分历史。

历史v1.3 QA product17/28、control19/28与本轮12/28、12/28均保留。跨协议对比只能报告观察变化：typed submit、locator默认、预算边界等共同改变，不能把差值归因单项修复、单个工具、模型或worker。

## 冻结证据与置信度

- candidate sourceDigest：`a4b9d61bd731518ec508a7d10b6a6a23c9a3e919c4f7b799b35a73d354dcc313`，base `04058e43b8b2658864d0de09c8d6024e9928dfc5`。
- preregistration.json SHA256：`d219a643a918b507b435c1f87591eac2e18a70e80a2889ddb960ee4ec52e7a7a`。
- audit-model.mjs 最终SHA256：`74f425b449a83ae91f35b9f9c890688dacf962b349041de8751c815aaba0269c`。FINAL审计运行版本为`5c30be54eee7abaf3800b3753f616e957f63ee896e19270265b0d42eb3feda15`；随后仅修Markdown显示task/repeat和repair N/A，不改审计算法或JSON结果，未重跑审计。
- FINAL model-audit.json SHA256：`9f82e87a566553adae986e029d191f6add8973efaf38c9758be4ffb96bd82292`。
- FINAL model-summary.json SHA256：`d25deadb866a798ce017d5239f4a8e66799470247d8d55e4a8833aab4565bb75`。

来源：ROOT/p4/{preregistration.json,audit-model.mjs,model-audit.json,model-summary.json,model-audit.md}；full和diagnostic的execution/attempts/completion/results-pack；逐block model-payloads/model-completions/raw-tool-results/live-runs/source-snapshots/frozen-score；ROOT/tasks.jsonl与gold.jsonl。所有数字追溯到实际原记录，未用推测值替代实测。

置信度：计划完整性、strict映射、来源行窗/hash、usage/cache与重传统计高；既有题上的机制描述高；泛化、能力收缩、生产质量和费用收益未由本轮证明。对公共broad保持现状的决策支持充分，对删除它的证据不足。

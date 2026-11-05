# 最终候选 QA56 独立实际评审

结论：**本阶段执行与证据评审 PASS，原 QA≥0.8 门达标；无未关闭宿主或产物 finding。** Product严格26/28（92.857%），control24/28（85.714%）。56 scheduled、56 actual、56 MEASURED，零missing。可以继续原repair16与public72阶段；本报告不宣称这两个尚未运行阶段或整体发布已通过。

本轮是新final-qa的完整56 raw，不复用P3的计数代替新检查。候选 `6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864`、611files；launcher `93439e4c6ecd08742eaf281abbf7d42d7a467f8bada2d05eff9b56d66a4d82d1`。只读独立辅助核查5458项，零未关闭错误。逐slot详细结论及缺失坐标保存在review.json，未反馈给模型。

## 真源与核查范围

核对当前candidateIdentity、原150-file kit范围及file-set、tasks/gold字节hash、helper/launcher、protocol/evaluator/adapter、完整公共准备module hash与prereg；核对56schedule唯一键、attempt/execution身份及COMPLETE终态。当前原scoring.py SHA为 `5c41e12a994a7a9269725e94646bfb691e6929c2d3dba7c306255754095d4a28`，对应每block原冻结报告，不改原评分。

逐一读取250模型request与250实际response，重算messages payloadHash、模型标识、2048/none/thinkingfalse配置、原工具曝光与公共角色文本。56个被接受提交均关联真实response中的唯一submit_answer调用，rawArguments通过候选公共validator；schema与prereg逐题一致，包括整数、布尔和数组，未做字面值normalize。HIKARI-02 product有一次公开恢复：先返回正文draft，随后仅submit_answer；恢复计数1、原始提示保留，符合原公开合同，不是额外重抽样。

读取237原工具结果并重算rawHash。125个SOURCE_RECEIVED逐一校核源码快照文件hash、切片hash、实际candidate原字节、行窗正文、receipt slice、真实请求tool消息及其payloadHash。切片计量按每次接收求和，重复行仍计费。独立重建required_evidence逐行覆盖、每字段字面值与原gold精确比较、160line/16000byte预算、strict conjunction，再与原报告七项frozenScore字段及taskSuccess核对。没有运行新scorer或替换旧结果。

## 实际失败保留

| Arm / task | 字面值 | 源覆盖 | 实际原因 |
|---|---|---|---|
| Product ACCESS-02 | PASS | FAIL | 只读endpoint并接收policy短preview；缺SignedAccessPolicy第199行。31lines，预算尚余129，未继续读取委托实现。 |
| Product GSON-01 | FAIL | PASS | 收到175–204完整相关实现，却提交a_URL；源码逐大写插入分隔符，冻结原字面量为a_U_R_L。推演错误。 |
| Control ACCESS-02 | PASS | FAIL | policy只读1–30，缺第199行。37lines，预算尚余123。 |
| Control MYBATIS-02 | PASS | FAIL | 读1–80、80–139、140–159，共160lines含重复80；未覆盖160–174。早期搜索用了不存在目录，PATH_NOT_FOUND如实返回；未定向到关键实现，后续预算已耗尽。 |
| Control MYBATIS-03 | FAIL | FAIL | 读40–149，缺prefix声明第36行；guard提交带!的允许插入条件，公共合同要求正向冲突谓词。保持原gold，不把两个谓词归一化。110lines仍可补读。 |
| Control LEDGER-02 | PASS | FAIL | 只读endpoint与command，未读callee Ledger第7行。13lines，预算尚余147。 |

以上raw工具均保留真实查询/返回。缺实现的情况是模型读取策略遗漏；MYBATIS-02因窗口选择耗尽预算；GSON与MYBATIS-03还有推演／公开字段角色错误。没有证据表明宿主遗漏已请求且可送达的源码，或原门/合同需要放宽。两臂全部28 typed提交、预算和source版本有效；values各27/28，evidence product27/28、control24/28。

## 成本与计量边界

| 指标 | Product | Control |
|---|---:|---:|
| 实际请求 / 响应 | 124 / 124 | 126 / 126 |
| provider input tokens | 312589 | 231768 |
| provider output tokens | 6648 | 6459 |
| provider total tokens | 319237 | 238227 |
| cached input tokens | 224979 | 169981 |
| 全请求累计tool正文UTF-8 bytes | 290647 | 146167 |
| 首次tool正文bytes（按slot内callId去重） | 111257 | 67975 |
| tool正文重传bytes | 179390 | 78192 |

全部250响应usage非负整数，cached≤prompt、total=input+output，逐slot相加与最终usage一致。Input已包括历史消息重传，cached为其中子集；不可再次加cache或工具重传bytes来声称token成本。正文bytes只计算请求里的tool content，不包括system/user/assistant或transport JSON，不能换算货币。Overall481306.239792ms，block wall441326.343206ms、scoring22053.306377ms；剩余为编排/冻结校核等开销，不冒称独立index-build时间。

## 公平性、限制与运行边界

两臂同28题、原种子顺序、repeat1、相同公开角色/提交合同、源预算、模型与请求配置。product保持broad、默认worker1；没有新增私有坐标提示或答案纠错。所有失败原样保留，未删除、替换或重试求好结果。本阶段是全部已暴露任务的regression，不能宣称独立locked泛化，26vs24也不是统计因果结论。

本代理只读原始产物、当前源码/输入并执行独立hash/计量/合同核查，仅写本review.md/json；未发模型、未重评分、未运行benchmark/JDT/fullsuite/installer、未修改源码或raw。辅助检查初版曾误把broad工具曝光视为仅product工具、把sliceHash视为fileHash、把公开恢复当完整工具轮；按实际公共合同和原实现修正，修正记录在JSON，原始测量没有变化。完成最小充分核查后停止。

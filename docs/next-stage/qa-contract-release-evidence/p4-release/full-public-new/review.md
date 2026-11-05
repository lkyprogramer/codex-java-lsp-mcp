# FULL_PUBLIC72 最终候选独立实际评审

结论：**完整公共profile测量与证据评审 PASS；原 CLI 资格 FAIL；不具备发布／部署完成结论。** Product QA26/28（92.857%），control25/28（89.286%）；repair各8/8由实际candidate与原frozen judge验证成功。72scheduled/actual/MEASURED，零missing。30950项只读检查零未关闭宿主或产物finding。原资格失败及独立locked输入缺失必须保留在NO_GO证据中。

## 实际profile与冻结绑定

本次仅审新full-public-new的72slot，不混scoped56/repair16或历史测量。候选6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864、611files，launcher93439e4c6ecd08742eaf281abbf7d42d7a467f8bada2d05eff9b56d66a4d82d1及冻结prep modules保持绑定。当前candidateIdentity、原150-file kit内容/集合、task/gold原字节、public角色/schema、evaluator/adapter/protocol/helper均核对prereg。

实际external-full2533文件，corpusHash `13d529a6d262bfbe43a44c84b5666dedaa8527447768a098778682f1539de747`，datasetHash `c34a7c7c2f261bb273bc622739eae6beff8479ca96512c48942638cd912b8c4d`。独立重算当前完整file-set及hash、原harness corpus_fingerprint与dataset_digest，与prereg及score-manifest一致；核对4upstream实际commit/clean/seed hash及8authored目录。所有QA workspace完整文件树等于其full corpus，repair完整树仅有allowed model edits；只排除.git，没有按cache或Java包路径名称过滤文件。

Aggregate每臂原36row report / results SHA与manifest一致，实际命令为原python -m harness、--corpora-root完整根、--split all，两exit0。原scorerSHA `5c41e12a994a7a9269725e94646bfb691e6929c2d3dba7c306255754095d4a28`；report原qualification为RETRIEVAL_AND_STRUCTURED_QA_ONLY，source_sha=null原样保留。代码身份由prereg sourceDigest/helperSHA及launcher逐block重新检查绑定，不能捏造填回source_sha。

## 原始模型、来源与评分

逐项核对348request/response身份、序号、实际模型、messages payloadHash、2048tokens/none/thinkingfalse及工具曝光；333原工具rawHash正确。72真实accepted submit_answer关联唯一真实response，validator逐题核schema（含integer／array）、public字段角色与QA/repair分离。公开一次恢复轮只暴露submit_answer时按实际恢复消息核对，不增加任务repeat。

158个SOURCE_RECEIVED均映射到真实请求tool正文、准确源码版本快照、fileHash/sliceHash和行窗正文；metadata只用于locator，不当源码已读取。逐QA重算原gold字面量逐字段一致性、required_evidence逐行覆盖、重复行累计160line/16000byte预算与严格conjunction，逐字段核原frozenScore。Product values27/evidence27/budget28；control values27/evidence26/budget28。

16repair逐个核artifact.task_id/mode=candidate、artifactSHA、完整candidate逐文件SHA、原test/wrapperSHA、javac/run exit0且无timeout/output_limit、frozen_test_completed。内存从full corpus重放模型replace_file，所得完整文件树等于真实judge candidate。patchApplied声明不判成功，不以offline reference替代模型候选。原临时classes/nonce已清理，本评审核guard元数据，不声称读取已删除nonce。两臂PAGINATION-03均source回执0，如实保留；成功依据是真实修改及原judge，而不是源送达完整性的虚构声明。

## 五个QA失败保留

| Arm / task | 值 | 源覆盖 | 具体原因 |
|---|---|---|---|
| Product ACCESS-02 | PASS | FAIL | policy仅短preview，缺第199行；31lines，未读取委托实现。 |
| Product GSON-01 | FAIL | PASS |175–204实现已完整收到，仍提交a_URL；逐大写插分隔符的结果应是原字面量a_U_R_L。 |
| Control ACCESS-01 | PASS | FAIL |读1–80、318–397共160lines，漏199；窗口选错耗完预算。 |
| Control MYBATIS-03 | FAIL | PASS |收到34–133及133–162（重复133仍计费）；把公开要求的正向冲突谓词写成带!的允许插入条件。 |
| Control LEDGER-02 | PASS | FAIL |只读endpoint/command，缺callee Ledger第7行；13lines，未继续读取。 |

缺源码是模型检索／窗口策略，值错是推演／公开角色错误。未发现已请求可送达源码被宿主丢失；不值normalize、不改gold、不反馈私有坐标、不替换失败重试求好结果。

## 原CLI资格的实际失败

原不变CLI gate两臂实际exit1，decision=QUALIFICATION_FAIL、scope=STRUCTURED_QA_ONLY_NOT_RELEASE。两臂budget、qa_measurement_complete、qa_contract_floor均true。Product integrity=false/anchors=false；control integrity=true/anchors=false。

- 两臂ACCESS-03 repair：原report valid=true、budget=true、qa_contract_pass=null、anchor_containment=0。原scorer按emitted regions算anchor；原results regions为空，不能把SOURCE_RECEIVED或judgePASS伪装成emitted region使资格变绿。
- Product NOTIFICATIONS-03 repair：原report valid=false，errors=['region[6]: stale or absent content hash']，anchor=null、qa=null。该源码是模型修改后的版本；保留快照hash/行窗及实际请求送达均有效，真实candidate judgePASS。原retrieval/QA scorer用不变external source检查read event，因此标修改后回执stale。诊断原样保留，不能过滤postwrite或重评分消除。

这些原资格结果与实际repair judge8/8是不同判定边界，必须同时记录。FULL_PUBLIC测量PASS只完成“full upstream profile measured separately”，不能冒称原QUALIFICATION_PASS、locked独立性或整个releasePASS。当前仍需NO_GO；不能发布／部署替换daemon。

## 实测成本与时间

| 阶段 / arm | input | output | total | cached input |
|---|---:|---:|---:|---:|
| QA product | 301240 | 6136 | 307376 | 215193 |
| QA control | 258474 | 7223 | 265697 | 191307 |
| Repair product | 101136 | 2765 | 103901 | 82879 |
| Repair control | 90497 | 2524 | 93021 | 74484 |

每个response provider usage完整、非负整数、cached≤prompt、total=input+output；累计与原slot一致。Input包含历史消息重复传输，cache是其中子集。Tool正文全请求累计product349982／control276693 UTF-8 bytes，其中重传209156／173361bytes；仅tool content，排除其他消息和传输JSON，不能加到token计费或换成虚构货币。Overall712640.89175ms，block wall681991.851332ms、publicscore2484.371167ms；wall包含workspace/session/model/judge/关闭，不声称独立索引耗时。

## 运行与停止边界

本代理只读原raw、输入及current source，执行hash、原fingerprint/dataset_digest、git只读provenance、内存修改重放及validator检查，仅写review.md/json。未发模型、未执行score/judge重测、测试、benchmark、JDT、fullsuite或installer，未改source／raw／候选。

全部任务已暴露，仍属regression；不把原split叫locked就宣称其独立性。不混其他阶段数值，不增加100%repair门，不放宽原QA0.8门。独立locked owner输入仍缺，原CLI资格失败完整保留，交付此测量评审后停止。

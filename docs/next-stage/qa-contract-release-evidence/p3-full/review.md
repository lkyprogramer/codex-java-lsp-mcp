# P3 全量 QA 与实际 repair 独立评审

2026-10-11。最终结论：P3 PASS，无未关闭的宿主critical finding。两臂原严格QA均25/28（89.29%），达到原≥80%门；原8 actual repair groups × 两臂16slot均被原judge实际测量，本次恰好全部VALIDATED_SUCCESS。没有新增100% repair成功率要求。

此结论仅覆盖P3。六个QA失败及原诊断全部保留；既有独立locked/full public、默认worker1容量、真实JDT、发布安装/回滚等门仍须P4验证，不能据此宣布最终可上线或替换daemon。

## 实际计划与独立审计

QA56/56、repair16/16均COMPLETE，同611文件候选 `5f9c8f2f7d4c12e9ec3e6bbfc1ba26fda973f150e3a1ebe5ac8c257a23d6981b`、同public-qa/v1.0、同launcher和模型设置。28 QA每题两臂；8 repair每组两臂，repeat1、全键唯一、执行顺序与各prereg一致，缺失/失败没有替换。根源代码、合同和launcher从QA到repair的绑定一致。

本代理先独立读取QA原始数据，2024项计数校核PASS；repair未完成时review.json明确QA_PASS_REPAIRS_PENDING。完成后只做repair16增量，787项计数校核PASS，再升级本最终结论。未重跑模型、原评分器、测试、benchmark、JDT或安装。

QA已直接核对：slotpack/aggregate/terminal对原Python frozen report的strict映射与七项诊断；required_evidence逐行覆盖、每个源码slice及整文件snapshot SHA256、真实行窗及实际messages中的嵌套精确文本；receipt投影hash/bytes；每次request/response身份、配置和工具面；actual submit schema与公开合同hash；public schema/首轮prompt两臂一致；source预算160行/16000字节不变。

Repair已直接核对：原8 manifest groups、原frozen test和wrapper hash、judge mode=candidate及compile/run记录、实际candidate_tree全文件SHA、允许编辑policy；provider产生的成功write_file/replace_file请求与raw工具操作相对应，在内存中从原corpus逐字节复演后匹配最终candidate，未写回候选或使用reference patch；源码回执绑定fetch时整文件snapshot与实际dispatch，不要求修改前hash等于最终文件hash。

Prereg的原baseline-kit实际150文件hash在QA及repair均一致。原tasks/gold/冻结scorer未变，新协议结果不覆盖旧12/28或其他历史NO_GO。

## 完整 QA 的原门结果

| 全28 QA指标 | control | product broad |
| --- | ---: | ---: |
| 原strict成功 | 25/28 | 25/28 |
| 原80%门 | PASS | PASS |
| 答案值精确匹配 | 28/28 | 27/28 |
| 原必需证据完整 | 25/28 | 26/28 |
| 公开typed提交接受 | 28/28 | 28/28 |
| source预算通过 | 28/28 | 28/28 |
| 公开格式恢复次数 | 0 | 0 |
| provider请求/响应 | 127/127 | 122/122 |
| 实际工具invoke（不含submit） | 117 | 114 |
| source行/字节 | 1221 / 36914 | 1256 / 38546 |
| input tokens | 240988 | 298418 |
| output tokens | 6418 | 6139 |
| cached input tokens | 177846 | 215720 |
| 实测input−cached | 63142 | 82698 |

两臂都达到原QA门，但没有观察到product strict优势或token节约：product实际input和uncached input更多。tokens是成本代理，不是货币价格。provider字段均为实测非负整数、cached<=input，QA249请求对应249响应。配置记录max_tokens2048/reasoning none/enable_thinking false，只证明请求设置，不证明provider内部行为。

## 保留的六个 QA 失败

| 失败slot | 观察与原判定 | 宿主边界 |
| --- | --- | --- |
| ACCESS-01 control | 值正确；read1–120及357–396耗满160行，漏Policy第199行 | 选择窗口问题；请求的精确窗口均送达，预算结算正确，不提高预算 |
| ACCESS-02 control | 值正确；仅读Endpoint1–7及Policy1–30，漏199 | 未读被调实现，不是schema或read丢行 |
| ACCESS-02 product | 值正确；read Endpoint及symbol head预览共31行，Policy仅头部片段，漏199 | preview为有界片段，不代表完整实现；没有继续定向read |
| LEDGER-02 control | 值正确；读Endpoint/Command共13行，未读Ledger第7行 | 提前停止读取被调实现；rg导航不计源码 |
| GSON-01 product | read175–204完整覆盖循环，值仍为a_URL | 与源码逐大写插分隔符不符；推演错误，非格式问题或source不足 |
| HIKARI-01 product | 值正确；一次window预览共80行，目标remove(Object)窗口128–139，required129–142末尾未齐 | 多候选预览不等于完整方法；未read补140–142，尚有预算 |

ACCESS、LEDGER和HIKARI失败是实际来源闭合不足，GSON是已读完整源码后的内容推演错误。source hash/行窗/actual messages可信，不存在宿主删行、预算超支、答案归一化、值纠错或评分替代。不得把正确导航、正确答案或完整unit标记替换为gold required证据覆盖。

QA仍有25次error工具结果：空list参数15次（C6/P9），不存在rg路径10次（C5/P5），后者都准确PATH_NOT_FOUND，没有旧BLOCKED_ENV归因。保留这些回退历史；它们不是新的宿主critical，也不能按error次数换算QA失败数。

## 实际8 repair groups

两臂分别对PAYMENTS、INVENTORY、ACCESS、ADMISSIONS、PRICING、NOTIFICATIONS、LEDGER、PAGINATION的原-03任务进行真实模型修复，总16slot，全部VALIDATED_SUCCESS。

| repair指标 | control | product broad |
| --- | ---: | ---: |
| 原组实际被测 | 8/8 | 8/8 |
| 实际候选原judge成功 | 8/8 | 8/8 |
| 模型成功写入操作 | 8 | 8 |
| candidate receipt snapshots验证 | 17 | 13 |
| provider请求/响应 | 54/54 | 42/42 |
| input tokens | 99514 | 86158 |
| output tokens | 2854 | 2446 |
| cached input tokens | 82998 | 68632 |
| 实测input−cached | 16516 | 17526 |

每slot仅原允许编辑文件改变，无新增/删除、symlink或policy violation；patch实际来源于对应模型tool arguments，不是patchApplied自报或脚本化oracle。独立逐字节复演验证每个最终candidate与frozen-judge.json记录candidate_tree一致；原frozen test hash、wrapper hash及test_class对应原manifest，compile/run exit0、无timeout/output-limit，frozen_test_completed=true。

Repair submission schema仍只含patchApplied:boolean和summary:string，没有QA fields/pattern/enum/order或公开合同publicContract附加；attempt publicAnswerContract.applied=false。两臂repair首轮prompt/schema一致。原judge决定taskSuccess，QA source coverage及format不能替代它。

来源与历史诊断必须分开：

- 所有30个repair SOURCE_RECEIVED均按fetch时snapshot验证VALID，修改前文件与最终candidate不同是正常修复过程，不是陈旧回执。
- PAYMENTS-03 control有修改后read：原不可变基础语料的诊断仍保留region[2] stale or absent content hash / valid=false。实际candidate snapshot验证和原repair judge为PASS。不能表述为“全部原冻结诊断均有效”，也不能删这条诊断。
- PAGINATION-03 product没有SOURCE_RECEIVED，candidateReceiptValidation的VALID仅为0项空集合检查，不能称源码完整或已验证模型理解。它仍有真实成功replace操作和原judge实际通过；原repair门未要求QA式必需source coverage，不新增该门来否定实际候选测量。
- 原harness的TemporaryDirectory会清理judge临时repo/classes、wrapper和nonce marker。保留artifact记录原subprocess结果、hash及nonce-completion布尔；本代理没有复跑judge或宣称独立读取了已删除marker。实际模型candidate源码与fetch snapshots仍保留且已独立hash核对。

## 阶段决定与限制

P3满足原QA≥0.8与8 actual repair groups实测要求；本次全部repair成功是观察事实，而非新设100%通过门。无未关闭的宿主/protocol关键finding，故可进入P4原发布证据与安装前核验。

公开broad、default reader1及原budget/scorer保持。旧v1.4与新v1.5结果仅跨轮观察；公共表示、读取指引、rg/read边界共同变化，orderingSeed1984也不是provider sampling seed，不能归因某一个补丁。已暴露题依旧regression，不属于独立locked。P4须在真实生产/安装影响边界完成原门，不能用本P3或八题样本顶替容量/JDT/full-public/independent证据。

本代理仅读取实际数据并写review.md/review.json，未给模型gold反馈或私有坐标提示，未修改代码/候选/合同/raw，也未增删模型attempt。

## 冻结摘要

- QA preregistration：`5d4ccf7046369bd562c6388ba95b3ce631339256a76ae513de1394f42a34ef0e`。
- QA attempts：`b2b630182a57e2c18e3baf828e3b8999b14771cbab92ccf48e92e8a8032dfd0e`。
- QA results-pack：`950f9dec9f2c89c29013447795c4200c3bb55b35b5410b4ceed0403948531499`。
- repair preregistration：`9fb4ca6042073d7d06a4253f84d7772c067b1d00f2d7536a5e175cf915fd7d5b`。
- repair attempts：`ad87aa008d3b4d8732f420b07de51b0f36f448be931dac68021cab9c5150e8f0`。
- repair results-pack：`2f530716be05c5c0c5afaa022f260b7cbfc099226407fcd207e9486081988fd2`。

复核helper曾把judge run argv[4]（wrapper）误当test class，改为原argv[5]后787项检查通过；只修只读检查器，未修改judge或raw。该检查器问题未作为宿主finding。

置信度：实际72slot完整性、原score/judge映射、来源及候选hash、公平配置与原QA门判定高；生产质量、泛化和最终release/daemon替换资格仍待P4证据。

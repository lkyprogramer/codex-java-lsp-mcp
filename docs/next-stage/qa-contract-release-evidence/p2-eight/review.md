# P2 八题真实结果独立评审

2026-10-11。结论：P2执行与证据评审PASS，无必须先修的宿主/protocol finding；可按原阶段进入完整28 QA两臂。保留product两个失败，不新增八题80%或100%门槛，不宣称上线通过。完整28题才检验原QA≥80%，发布还须其余原门及real-agent repair。

## 计划、合同与原评分

原八个指定QA × product broad / native control × repeat1，共16计划slot，16/16 COMPLETE、0缺失。执行顺序与prereg逐项一致；task/arm/repeat全键唯一；slotpack、aggregate、terminal及原frozen Python report的strict结果一致。原tasks/gold仍为先前36题原字节输入，八题是过滤选择，没有替换任务、改gold/scorer或回算历史。

每题两臂第一轮system/user消息一致，实际submit schema与prereg公开schema一致；public-qa/v1.0 version/hash在submission、attempt、pack中一致且applied=true。Product仅多出原broad java_symbol；没有java_evidence或私有答案/必需行反馈。配置仍同一模型、completion2048、reasoning none、thinking false、maxRounds16、default reader1；seed1984用于arm顺序，providerSamplingSeed=null，不宣称服务端遵守了思考行为。

本代理直接读取原记录并核查543项：planned与terminal、strict原报告公式、每次messages hash、request/response identity及配置、tool profile名称、actual submit schema、receipt投影hash/bytes、source snapshot整文件hash、slice hash与真实行窗、required_evidence逐行覆盖、160行/16000字节预算、provider/cache整数范围。全部PASS。67个实际request对应67个response，没有provider缺失。实际候选原baseline-kit150文件与prereg冻结hash一致。

源码送达从实际tool messages递归查找精确source text，覆盖read及java_symbol嵌套preview；不把rg/list文本算SOURCE_RECEIVED。初版本地检查器只看payload顶层text，无法识别嵌套preview而触发断言；已修为递归精确比较后通过，未改raw或将检查器问题认成宿主问题。

## 真实结果与成本

| 八题指标 | control | product broad |
| --- | ---: | ---: |
| 原strict成功 | 8/8 | 6/8 |
| 答案值精确匹配 | 8/8 | 7/8 |
| 原必需证据完整 | 8/8 | 7/8 |
| source预算通过 | 8/8 | 8/8 |
| 公开typed提交接受 | 8/8 | 8/8 |
| 格式恢复次数 | 0 | 0 |
| provider请求/响应 | 40/40 | 27/27 |
| 实际检索工具invoke（不含submit） | 40 | 27 |
| 收到源码行（含重复） | 317 | 313 |
| 收到源码字节 | 9310 | 9395 |
| provider input tokens | 75875 | 71708 |
| provider output tokens | 1939 | 1640 |
| provider cached input tokens | 56993 | 47451 |
| 实测input−cached | 18882 | 24257 |

Product调用/input总量更少，但uncached input更多。实测tokens是成本代理，不是货币费用；这八题不足以推断总体费用收益或检索工具质量优势。两臂同题原v1.4分别product1/8、control3/8与本次6/8、8/8，只作跨轮观察：公开合同、读取指引、rg/read协议共同变化且provider sampling未设seed，不能将变化归因单一修复。

## 两个残余失败的真实触发链

### PAYMENTS-02 product：导航充分、组装器未read

本次symbol查询receipt amount field，随后rg amount；实际rg结果包含ReceiptAssembler.toReceipt的定位与实现文本、Receipt字段及XML映射。模型只read Receipt.java第1–7行和ReceiptMapper.xml第1–5行，然后typed提交三个正确值。

实际SOURCE_RECEIVED共12行420字节，原必需ReceiptAssembler.java第4行未覆盖。rg文本是导航而非计分源码；模型没有向read请求该实现，因此没有FETCHED却被宿主丢失的情况，没有工具error、clip、预算耗尽或路径失败。剩余预算足以读取该小文件。原scorer按“值匹配/证据不完整”判FAIL正确。

宿主应继续保持原回执规则，不把rg偷换成源码、不公布私有缺失坐标、不自动补读Assembler以购买通过。该失败是模型读取闭合/提前提交问题；当前无证据支持修改宿主。

### GSON-01 product：完整循环已送达，具体推演错误

Symbol定位separateCamelCase；read FieldNamingPolicy第175–204行，共30行1086字节，完整覆盖179–188循环。wire totalLines=213、hasMore=true、剩余130行14914字节；其余后文未读不影响该完整循环。来源hash与快照/实际messages一致，没有truncation或read丢行。

循环对每个非首位大写字符分别加入分隔符；输入aURL的结果逐步为a、a_U、a_U_R、a_U_R_L。模型提交method正确、result=a_URL。新表示合同没有归一化result，原scorer按“值不匹配/证据完整”判FAIL正确。

该失败是模型具体推演错误，不是成员名格式、源码定位或工具协议失败。不自动纠正a_URL、不加gold-derived返回值提示、不改变scorer；应保留为完整28题中的同一已知回归项。

## 已恢复工具错误，不混入两失败归因

16次中实际仍有6次error结果：4次list(path="")（control3、product1）准确报path is required；2次control rg不存在路径准确报PATH_NOT_FOUND，未再误标BLOCKED_ENV。涉及的题全部strict通过。六次均属无效参数或不存在路径后的正常回退，不是本次两道失败的触发原因，也不等于“运行中从未返回过错误”。

没有观察到未关闭的宿主参数归因、schema/validator不对称、source receipt丢失、预算计算、评分替代或provider故障。没有因全部错误都已恢复而删除error历史。

## 进入P3的决定与未运行边界

本阶段证明16slot数据可信、公开合同确实应用、宿主缺陷未复发；没有要求八题达到新设质量分数。两个模型残余失败已经明确分类并保留，不应为救八题分数扩大框架、追加尝试或改private gold。

因此可冻结同候选/合同/预算/profile进入原28 QA两臂，完整分母为28/arm（共56）。本轮八题不能替代该分母，不能把新旧八题提升宣称为发布通过或独立泛化。已暴露任务都只作regression；公共broad和生产默认reader1继续保持。真实repair/public/independent locked、容量/JDT、发布安装与回滚仍由各后续阶段按原门执行。

本代理只读审计并写review.md/review.json，未修改源码、raw、scorer或公开合同，未重跑模型、评分、benchmark或安装，未扩样。定向Nowledge检索未找到可替代当前原记录的P2证据，结论不依赖历史记忆推定。

## 冻结标识

- candidate sourceDigest：`5f9c8f2f7d4c12e9ec3e6bbfc1ba26fda973f150e3a1ebe5ac8c257a23d6981b`。
- public-qa/v1.0 SHA256：`2debcf5ef20d58e6e994025f4d5a69861d3e869e0f67b8a2780ee59b6592f1d3`。
- p2-eight/preregistration.json SHA256：`19929dd78397d4541778f1c57e424484ba1368f2f04d7fea687c8e6fe24ee3eb`。
- run/attempts.json SHA256：`2a173e8816bdb8eaa571c78debbd5593d20ff1907b54d32c684d8f1e89406e0c`。
- run/results-pack.json SHA256：`c74baeaee45aafd543147aa99de1512faad2f02ded172c7d7e1fe91dd3d77b70`。

置信度：本16slot完整性/公平/原评分与两个具体失败链高；下一轮质量与生产发布资格尚未证明。

# 外部 evidence copier 独立预检

结论：**REPAIR_REQUIRED，1项绑定缺口；真实ROOT复制NOT_RUN。** 输入copier SHA256 `98d8f7359a92ff8f71ddbee1224f2ccec579e2276aa02d047dbdb319392b796e`已校核。只读code/readme、已有offline tests/TAP和必要state/preregistration；没有collect/扫描实际ROOT全树，没有复制实际ROOT，没有重复测试或执行model/build/JDT/installer。只写本报告。

## Finding E01：supplement helper/launcher没有绑定冻结字节

位置：package-evidence.mjs requireCompletedReviews第28–37行及packageEvidence第122–129行。

已观察事实：三份实际preregistration均包含oldHelperSha256、launcherSha256、protocolSha256、staticReaderCount1、product/native工具与逐任务submissionschema。copier当前只检查source identity、任务/arm/repeat universe、完成数、model/productProfile/requested配置与最终report/review hash。复制外部oldreadonly helper前只从当前launch-final.mjs解析路径并regular校验，没有比较actual helper hash与冻结oldHelperSha256；当前launcher也未比较冻结launcherSha256。protocol/tools/staticReader字段没有守卫。

触发与影响：完成并review之后若helper或launcher字节发生漂移，现有前置校验仍可通过，复制包的supplement将不再是该三轮测量时的helper，却仍标识ORIGINAL_READONLY_HELPER。类似的prereg工具/协议reader字段漂移未被copy preflight拒绝。没有观察到实际文件已经漂移；这是代码中可达的绑定缺口，不是重新评分结论。

最小修复：仅补明确冻结字段和实际待复制launcher/helper/protocol/publiccontract的hash binding；产品/原生工具list与phase任务集合约束逐task schema。不能直接比较三phase完整tools JSON，因为QA28、repair8、public36的submission集合本来不同。用各字段声明的实际candidate/authority base处理来源，不把任意{path,sha}都解释为ROOT证据。新增最小offline drift拒绝测试，保留正向fixture及原3测试。已通知作者p4_results_audit和父代理，由作者窄修；本代理不改工具。

## 其余已核查边界

- 原56/16/72任务与product/control/repeat1 universe和COMPLETE/denominator/actual keys检查，source6d/611、modelQwen3.8-next/broad/requested固定配置，最终report/reviewstatus及hash守卫存在。真实state.p4FinalPublic在本次读取时尚未登记PASS，函数会正常拒绝；不把pendingreview视为功能缺陷。
- 新绝对destination、已存在拒绝、root双向重叠拒绝；新文件wx写入；原binary字节SHA/mode/bytes核验，失败留package-incomplete；copy-only不做Git创建/源码修改/commit或bundle验证。bundle明确依赖父代理已经验证的source claim，脚本只原字节复制。
- filters按真实生成物布局匹配block cache/home/xdg等和source clone；candidates/source-snapshots里的org/.../cache/classes/temp/home/dist真实源码保留。.git排除，已选symlink拒绝，明确credential文件failclosed。没有把source包名当cache目录一刀切删除。
- formal ref补充只复制实际ROOT内存在regular文件；source inventory相对src路径、private docs及block-relative scorer ref并非天然ROOT证据。不能因这些记录里出现{path,sha}就宣称缺证据。已选JSON/JSONL提取formal filekeys，过滤文件可补单文件；显式源码clone/credential/编译产物引用拒绝。不修改payload和原绝对路径，inventory提供映射。
- historicalSourceDigest与currentSourceDigest分列5f/6d，旧目录/失败样本保留；没有重评分或合并denominator。
- output authority固定NO_GO/EVIDENCE_COPY_ONLY_NOT_RELEASE_AUTHORITY，明确FULL_PUBLIC/INDEPENDENT_LOCKED/PERFORMANCE不由copier推断PASS。真实复制与发布资格保持不同。

已有offline proof：package-evidence.offline-r2-final.tap 3/3PASS、skip0/fail0；覆盖binarySHA/mode、nooverwrite、真实源码cache保留、formalfilteredref恢复、compiledref及escaping symlink拒绝、三阶段完成与review门。该proof只在fake临时fixture运行；未测试E01的helper/tool/protocol drift，因此不能替代所建议的最小新增用例。

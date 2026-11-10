# 01 分支审计：已解决什么，下一步不该重复什么

## 核查边界

核查到 `b1475cddac01ab6ce589a1d465578d5ab7772533`，提交日期2026-11-04。读取了执行手册、目标合同、G10/G12/G13/G14/G16/G17记录及公开工具、discovery、evidence、read-plan、关系provider、SQL查询、JDT生命周期、repair oracle等关键源码。来源索引见[13](13-sources.md)。

这不是完整安全审计或新一轮生产复测。没有当前完整本地checkout、Mac原生运行环境、私有数据和付费模型。以下数值均注明仓库历史报告，不能写成“本次测得”。

## A. ILV2 应作为稳定基础保留

| 范围 | 当前事实 | 后续处理 |
|---|---|---|
| 唯一owner | launchd + 小型原生launcher，固定inode的flock和显式fd继承；静态owner与外部Gradle域分别管理 | 不另建guardian/全局多租户调度器 |
| 索引事实 | 从同一捕获字节产生hash/AST/search/片段；SQLite不可变快照，绑定与lease独立 | 新功能消费已有held view，不重读live后冒充snapshot |
| 增量/复用 | full/delta、seed、verified-noop、worktree rebase、后台验证已有 | 不再提出“从零建增量索引/统一generation” |
| 新鲜度 | workspace水位、coverage、job、snapshot分层 | 保留PARTIAL与不可靠否定回答边界 |
| 公共身份 | mac1 workspace-bound symbolId，稳定声明与snapshot-local handle分离 | 不改回FQN-only，不为旧ID建长期别名 |
| 资源回收 | 新linked-worktree静态闲置回收48小时；默认关闭，observe/enforce | 不视为默认已启用，不碰源文件或JDT/Gradle缓存 |
| 生命周期 | JDT导入/搜索索引屏障、共享启动/调用方deadline分离、私有Gradle域 | 性能测量必须区分首次依赖准备、首次索引和复用 |
| 索引查询 | scope SQL前置、writer统计、有限posting、source hash检查等上一轮修复已落地 | 不重发旧R05–R09作为“当前未修复” |

[S01–S04][S11–S19][S22]

## B. 性能成果很大，但不是所有路径都变快

G12报告（2026-10-29，sourceDigest `413de8ad…`）记录：seed发布约47秒→0.16秒；计入后台全校验后的成本比约0.15；端到端seed约55.5秒→3.2秒。三对query p95分别13.39→21.44、24.06→18.38、14.06→21.44毫秒。用户接受D1-a：`candidate <= max(1.1 * baseline, baseline + 10ms)`；其中第一和第三对不满足原1.1倍门槛，不能写成“全面性能提升”。[S05]

这些结果说明基础设施的主要成本已经下降，不能证明后续没有任何瓶颈。但再投入一轮泛化的SQL/GC/调度重写，预期收益不如直接改善任务证据链。此前每5秒重启CPU profiler导致数百毫秒开销的发现也说明：观测本身必须受控，不能恢复常开重型采样。

## C. 检索质量没有随底座一起跨越

| 仓库历史测量 | 结果 | 含义 |
|---|---|---|
| G13 dev / holdout product recall | 0.3929 / 0.4118，改造前后相同 | 是当时无模型检索driver的表现，不是JDT正确率或真实Agent成功率 |
| G13 evidence coverage | dev 49/104，holdout 18/45 | 暴露证据缺口；分母是标注证据项，不是任意源码行 |
| G14三仓R_read_must | 0.9250 / 0.8850 / 0.8800，旧/新相同 | 存在既有质量限制；用户明确接受无回退上线口径，不抹掉地板FAIL |
| MAC-16 conditional precision | NOT_RUN | 未建立任务级编译器解析错误；记录把缺口归为深度/预算/范围 |
| MAC-15真实模型收益 | 公开账本仍PLAN / benefit UNMEASURED | 不能以无模型pipeline或系统稳定性替代任务收益 |

[S06–S09]。本轮不要求为了完美1.0地板重做已接受的工程发布；这些失败应进入下一阶段的质量队列。

## D. 当前直接可确认的增量机会

### D1 文件命中以后仍缺少紧凑的同文件候选比较

`java_symbol`当前有query/position/references/evidence，没有outline操作。query默认head preview只有4行，适合发现但未必能区分同文件的相似方法。建议在已有工具中加一个按需outline，不自动在每次查询注入，也不新增独立tool。[S12][S13]

这是待验证机会，不是断言所有错误都来自缺outline。Q02先区分“没找到文件”和“文件对、方法错”，Q03再实施最小能力并做工具可用性/输出组织两层消融。

### D2 evidence入口仍偏窄

`runEvidenceUnit()`明确标注`indexed-mybatis-xml-fqn-links`，全局8units/80lines/16000bytes，源码文件上限2MiB；有hash、路径、敏感内容和末次anchor复验。应复用这些安全边界，把Java声明和已选关系源码接进同一入口，而不是新建Context Engine。[S14]

### D3 选择/序列化已有改造，重点应转向可解释归因

readPlan已有文件/byte预算、ReadUnit、多个matched positions、ENTRY_ABSENT/EVICTED/RANGE_MISS。compact最新提交已保护spans和anchor及少量框架补充。下一步是比较同候选同预算下，哪些关键行在哪一级丢失；不是把这些能力再写一次。[S15][S16]

### D4 精确关系与相关性不同

relationship provider有call/helper/implementation的有限展开及confidence常量。静态候选关系、JDT绑定和运行时动态目标必须分开。常量0.98不是从验证集估计的98%精度。宏观图更密不意味着Agent更准确；先验证明确声明→明确位置的窄关系。[S17]

### D5 性能最值得观察的是“等到能用”，不是继续压几毫秒

Nov3隔离样本READY106.150秒，其中索引屏障74.356秒；首次定义455.380ms、引用430.448ms。依赖恢复113.188秒另计。单次首次语义成功不能推出稳定p95，也不能被描述成空缓存全程120秒通过。[S10]

下一步只读记录用户实际等待频率：同一工作区重用时是否仍重复长等待？若主要发生在首次安装，不必为罕见冷路径引入常驻预热/额外索引系统。

## E. 必须先对齐的两处记录差异

### E1 部署状态

用户表示已上线；branch status仍IN_PROGRESS/NOT_READY，G17历史FAIL，G18/G19 PLAN。仓库的LOCAL候选记录可能晚于/早于用户实际安装，单靠它不能否认上线。Q00取得只读runtime identity和安装回执，将`sourceHead`、`installedProductDigest`、`measuredProductDigest`分列。未取得时写USER_REPORTED_DEPLOYED / NOT_INDEPENDENTLY_VERIFIED，而不是自造DEPLOYED。[S03][S10]

### E2 JDT时间合同

Nov3报告描述索引屏障包含在原120秒共享启动内；HEAD的`startTransactional()`在import之后创建独立`indexBudget`，默认600000ms，import启动预算默认120000ms。当前合同可能是后续明确改动，不能自动认定回归，也不能继续引用旧总上限。Q00冻结实际设置；Q09才决定是否有优化需求。

**1.1修订补充（已核实）：** 独立的600秒索引预算由`07c6ccf fix(runtime): bound JDT startup and serialize lifecycle controls`（2026-11-04）引入，晚于11月3日验收，确认是明确改动而非回归。产品README仍写“在原120秒预算内等待只读索引屏障”，已与源码不符，由Q00改正。剩余未知只有已安装版本是否包含`07c6ccf`。调用方自身deadline不能变成终止其他等待者共享启动的权限。[S10][S11]

## F. 评测可信性仍需一个窄门，而非再造评测平台

MAC10公开说明：private mac10-v3有50题，真实数据不在本仓；native单词搜索基线很弱；纯症状题的anchor-identifier planner会产生零查询；live接线属于MAC15；策展AI见过holdout；repair oracle当时用固定stdout marker。当前`ilv2-mac-repair-oracle.mjs`仍用exit0+ORACLE PASS。Q01应在付费实验前验证最终消息边界、repair正常返回和证据hash；不是假定上一轮b9c3cc3消息丢失bug还存在。[S09][S20]

## 总判定

**方向：QUALITY_FIRST_WITH_CONDITIONAL_LATENCY。** ILV2工程成果保留；旧质量地板继续公开；上线身份待只读对齐；下一轮先改善“正确入口→正确方法→必要证据”的链路。embedding路线关闭，Java精确引擎重写不触发，泛性能攻坚不触发。具体触发门见执行计划。

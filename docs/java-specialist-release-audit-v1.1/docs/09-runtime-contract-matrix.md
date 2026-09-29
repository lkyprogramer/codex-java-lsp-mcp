# 原 K01–K32 契约：完整保留并补齐执行层级

这是原 `baseline-kit/dataset/contracts/cases.json` 的执行展开，不是重新制定32条更松的要求。给定条件与 expected 原文保持在冻结文件，本章只指定如何取得足以支持其结论的证据。**本表是待执行矩阵，不是32项已经通过的报告。**

## 1. 层级与结论

`source-export` 对真实导出函数做小型反例；`parser-fixture` 必须经过真实AST/parser，不能只构造已解析Facts；`runtime-index/watcher/worktree` 必须使用真实writer/变更协调/独立工作树；`runtime-MCP` 是协议黑箱；`runtime-JDT` 需真实JDT/classpath；`runtime-load/SQL` 需原始时序/资源采样。

不要求所有fixture都启动JDT。K22–K24的保守绑定/partial边界可以无JDT验证；但K26/K28不能仅凭源码探针取得全层级通过。`T11=NOT_NEEDED` 是新增功能选择，不是既有契约的豁免。若要缩小正式发布范围，须所有者预先批准、单独版本化gate，不能把这些行标记PASS。

旧报告的10 PASS/12 PARTIAL/10 NOT_RUN是SOURCE_REPORTED。本次12源码探针全通过可直接复核其中明确覆盖的导出函数行为，不能将报告中的全部10项自动升级为本次完整独立验证。

## 2. 每项操作与验收

| 契约 | 承担任务 | 必需验证层 | 准备与触发 | 必须观察的结果 |
|---|---|---|---|---|
| K01 | R05 | source-export | 写入 modules/a 与 modules/b 的 demo.Shared，分别含同名字段及方法。 | 断言两份 type/method/field ID、file_id 不相同；查出的每条边端点存在。 |
| K02 | R05 | source-export | 用两个全新 DB 分别按 AB/BA 次序写同一对文件。 | 对实体与归属排序后比对完全一致；不能只比较条数。 |
| K03 | R05/R12 | runtime-index | 用独立 main/test source-root 建索引，查询同 FQN，不传可消歧范围；再指定范围。 | 未指定编译范围保留歧义候选；指定 main 不出现 test；test 的可见性显式遵循 build。 |
| K04 | R05 | source-export | 在 named type 前插入5空行，重新解析/写入。 | named ID 不变，selection 坐标加5；匿名/局部类型允许文件局部 ID 变化。 |
| K05 | R05/R12 | runtime-watcher | 双模块完成索引后从磁盘删 A，等待实际变更代次完成；再查 A/B。 | A 的声明、边、search-doc 清除；B 的归属和结果保持；不得手动清整个库假装增量通过。 |
| K06 | R05/R12 | runtime-worktree | git init 临时repo并创建两个 linked worktree；同一relativePath分别写不同内容。 | 局部named ID允许相同，但每个结果repoHash/sourceHash匹配本worktree；无兄弟内容串入。 |
| K07 | R08 | source-export | 对长方法fixture显式请求第201行。 | 最终range包含201；provider和最后serializer均检查，不能只中间结果通过。 |
| K08 | R08 | source-export | 同一长方法请求第100与350行；合并后走最终序列化。 | 正常预算两行都在；预算不足不得声称完整覆盖。 |
| K09 | R00/R08 | source-export | 使用原始CRLF字节运行长方法range与source slice。 | 行号对应一致，源码slice哈希与byte计数基于原始文件；不全局改LF。 |
| K10 | R08 | parser-fixture | 原Unicode.java含emoji的行，用真实parser读取声明及引用selection。 | 列为1-based UTF-16 code units；与独立字符串编码长度oracle一致，不用同parser反算作oracle。 |
| K11 | R08/R12 | runtime-index | 索引 caller+helper，helper从caller后移到前，正常触发更新。 | 显式调用事实不消失；返回的必要证据移动到当前range；不要求排序分数bit-identical。 |
| K12 | R08/R09/R12 | runtime-MCP | 对静态query/impact给零剩余时间或小于必要anchor的字节预算。 | 明确BUDGET_TOO_SMALL/PARTIAL或现有等价错误；无虚假COMPLETE，无无限等待。 |
| K13 | R07 | source-export | 查询 OrderService rollback refund，并给无词法关联的其他类型作干扰。 | 相关method参与且可用作anchor；纯type命中不结束text搜索。 |
| K14 | R07 | source-export | exact owner#method，计数所有dense/JDT调用；再查不存在exact。 | 精确声明命中且dense=0；静态后端JDT=0；不存在不得回退模糊召回。 |
| K15 | R08/R12 | runtime-watcher | 仅改中文JavaDoc为新业务词，执行真实变更协调后查询新旧词。 | 新词对应当前sourceHash；旧表示被替换；不改Java逻辑仍须刷新文档。 |
| K16 | R08 | parser-resource | 两个同名statement、不同namespace的XML，Java mapper接口作目标。 | 证据source为正确XML path/hash/range，目标declaration为对应Java方法；N01/P01独立断言不能替代真实parser测试。 |
| K17 | R06/R09/R12 | runtime-MCP | 20个scope外高分干扰 + 第21个scope内候选；并测broad common terms。 | scope在cap前生效；module与sourceSet AND；未知module不扩大范围；记录物理work与truncated理由。 |
| K18 | R08 | parser-resource | fixture含api.token唯一canary，查询配置key并请求preview，使用假的embed捕获输入。 | key可检索，canary不得进入model payload或embedding；不得外发真实凭据。 |
| K19 | R07/R09/R12 | runtime-watcher | 先查未存在名称；add→query→rename→query→delete→query，每步等待正常代次。 | 负缓存随变更失效；新名称可达；旧路径不复活；采用bounded wait，不用任意sleep断言已一致。 |
| K20 | R08/R12 | runtime-concurrent | 在query获取hits后、coverage/preview之前注入一次G+1变更，用barrier控制时序。 | 返回同snapshot的全部G证据或显式changedDuringRequest/PARTIAL；不拼新status与旧locator。 |
| K21 | R08/R12 | runtime-worktree | 完成兄弟DB拷贝，只修改目标worktree XML，Java保持hash相同。 | XML-source文档先reconcile再READY；不能因Java相同复用旧SQL证据。 |
| K22 | R05/R12 | parser-fixture | 同arity重载且仅凭语法不能确定实参绑定，使用原syntax fixture。 | 输出STATIC_CANDIDATE/AMBIGUOUS而非虚假JDT_BOUND；如主动请求JDT证据另跑真实JDT层。 |
| K23 | R05/R12 | parser-fixture | Parent类型参数实际可能Child实例，Child覆盖非final方法。 | 区分静态目标与运行时分派；不声称Parent是唯一运行目标；不需要新建全程序分析器。 |
| K24 | R09/R12 | parser-fixture | 真实Tree-sitter解析不完整Java文件，然后查询未找到符号。 | parse/coverage保持PARTIAL；不能写COMPLETE的负缓存。 |
| K25 | R07/R12 | runtime-MCP | 隔离MCP static query，JDT_BIN设为必失败程序并观察启动计数。 | 静态结果有效，JDT启动=0；不是用假的MCP factory直接调用函数替代。 |
| K26 | R09/R12 | runtime-JDT | 同工具operation=position/references；关闭LSP时检查enablement，再启用真实JDT。 | 关闭时明确配置错误；启用时实际绑定/引用可用且同一absolute deadline；记录runtime JDK/project JDK分离。 |
| K27 | R10/R12 | runtime-provider | optional关闭/无模型/超时/hash不符；使用受控假provider通过真实调用边界注入。 | lexical仍可用；不写COMPLETE负缓存；关闭时provider调用=0。optional未接核心时记录实际集成边界，不伪造不存在的自动fallback。 |
| K28 | R09/R12 | runtime-JDT | 两caller共享同JDT请求，取消deadline更短caller，保留另一个。 | 短caller退出不取消长caller；backend按现有policy结算、资源释放；先fake协议单测，再真实JDT集成证据。 |
| K29 | R09/R12 | runtime-load | 固定生成语料和同机基线，20并发broad query，计队列/耗时/loop delay/RSS。 | 队列有界，超时不遗留无界工作；不得全图prefetch；按原150ms/20ms SLO独立记录，不以机器不同推算通过。 |
| K30 | R09/R12 | runtime-SQL | 写库期间持只读query连接，写完后停止流量，观察reader idle释放与checkpoint。 | WAL在配置的idle TTL+有界grace后收敛；无无限snapshot；不得以删库作为收敛。 |
| K31 | R05/R12 | parser-fixture | 真实parser遍历nested/local/package-private源声明，并查询各selection。 | 各声明独立可寻址；不以constructor伪造局部type身份；数据库归属正确。 |
| K32 | R08/R12 | parser-fixture | JDK17+编译record/compact constructor合法fixture，text block里有括号与花括号。 | 真实parser的声明/range正确，文本括号不影响方法边界；JDK8业务源码与fixture目标级别分开。 |

## 3. 运行规则

所有工作区均由runner在临时root创建；canonical root/hash、build配置与输入文件hash先记录。变更事件用barrier、generation/status轮询和总deadline等待，超限FAIL或BLOCKED_ENV，不能无限重试。顺序是cold build→warm query→edit→rename/delete→parallel→idle；每阶段另存样本，不能把warm结果冒充cold。

K06/K21使用本地 `git init` 与 `git worktree add` 构造，不需要私有仓。依赖下载只能在独立环境明确授权后执行；缺native parser/JDT时如实BLOCKED_ENV，不用regex或fake结果补分。

运行态测试建议在仓库增加 `src/discovery/runtime-contracts.test.ts`、`src/discovery/mcp-contracts.test.ts`，或复用当前同职责测试文件；每个K编号必须成为具体test title并记录level。未提供的运行态实现属于R12的交付，不把本包的矩阵/模板误说成现成32项黑箱runner。

原 `mutations.json` 的4条序列继续运行；本轮N01/P01/Qxx/Wxx/Dxx是额外针对性反例，不能替代这些生命周期序列。

## 4. 单项结果

以 `contracts/runtime-matrix.json` 为初始状态，由独立evaluator另写run输出；不要修改发布包内的初始记录。每项至少包含：sourceSha、level、环境、test title、完整command/exit、输入/输出hash、观察的generation/文件hash、是否真实MCP/JDT、限制和原始证据路径。

`PASS`只在expected全部满足且证据层级正确时成立。测试安装失败=BLOCKED_ENV；产品返回错误/超时=FAIL；尚未执行=NOT_RUN；fakechat工具交付测试PASS仍不是live-model任务PASS。

K29原150ms静态warm P95与20ms loop-delay门槛按原机器协议评估；固定每轮warm-up次数、重复数和并发度。K30结束等待界限必须从当前配置导出并在run前冻结（idle TTL + checkpoint grace），不能不断延长直到偶然通过。

## 5. 发布汇总

不得使用只列PASS项的过滤表。最终manifest必须出现K01–K32全部32项和每项证据。任何原must gate仍PARTIAL/NOT_RUN/BLOCKED，按原完整v1要求都不具备上线资格。精简静态子集可单独申请有限试用，但不得冠以“原全部文档完成/全门禁通过”。

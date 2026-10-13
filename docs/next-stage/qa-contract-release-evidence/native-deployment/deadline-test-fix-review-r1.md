# Deadline diagnostic and test-boundary independent review r1

**PASS：这一个测试的前置启动修正语义合理。旧模型及业务测量证据可条件性按运行等价沿用；新包身份及等价证明目前尚未生成，不得直接宣称新包已通过发布。**

## 实际诊断关闭此前假设

读取 deadline-diagnostic-r4.log 的完整31条 trace。long caller开始43.491459ms；ensureStarted结束531.075792ms，已占它窗口487.584333ms。definition531.844834ms启动、572.957584ms结束；long545.737125ms结束，caller实耗502.246083ms，结果晚27.220459ms。六次全机ps共339.086249ms，两轮身份重试名义等待100ms。fake initialize约0.1ms；不是JDT响应慢或40ms handler被首10ms硬截断。

trace与既有调用链一致：预算在cold ensureStarted之前开始，真实fakePID身份探测侵入共享semantic查询测试的500ms窗口，long正确到期降级为[]。同步ps还使short实际晚于其10ms计时结束；这同样是event loop阻塞的调度现象。JDK构造解析早于caller预算，不是该窗口直接来源。诊断wrapper数字不是正式产品性能benchmark，但排序充分支持此次测试失败原因；没有观察到应修改产品共享deadline语义的证据。

## 单测试变更

独立将当前 src/jdtls-session.test.ts 与冻结a77同文件全文比较，精确差异仅为该用例writeFileSync之后新增 `await session.ensureStarted();`。原10/500ms、40ms handler、short空结果/long正确结果/definition count1三条assert均保留。ensureStarted只建立READY，不发semantic definition，因而没有预填共享查询缓存；short仍是首个semantic backend调用者，long仍验证同键共享及caller退出隔离。

既有独立“a short caller deadline does not cancel a shared JDT startup”保留cold startup、10/5000ms、STARTING、child不kill、one spawn、最终READY断言。新前置将已覆盖的cold-start状态准备从查询共享的短wall-clock窗口移出，符合本用例职责；没有延长budget、跳过失败或弱化产品门。本次未运行修改后的测试，必要窄验证与installer证明须另行实际执行。

## 旧测量证据沿用的机器前提

1. 冻结新clean commit/tree、完整source digest与file inventory。原a77、6d、模型raw、评分与失败日志保持原身份和原字节。
2. 原包与新包path set一致，唯一SHA差异allowlist为此一个test file，mode保持；差异内容精确为上述单行。全部非测试文件逐SHA+mode相同，包含lock、installer、生产代码、runtime scripts、fixtures、scorer、tools、protocol/gates。不能只比较部分目录或用“所有*.test文件都可忽略”绕过额外变更。
3. 新runtime-equivalence/adoption receipt绑定旧6d/a77与新commit/tree/digest、两份完整manifest、test前后hash/精确diff、完整非测试执行输入runtime摘要、沿用的每个原证据ref/hash及其原测量身份；receipt经独立审查并hash冻结。
4. Node/编译器/JDT/依赖及运行配置保持。新build产物应比较生产文件集合与hash；新build-stamp身份元数据以及对应test JS/maps允许精确登记差异，不能笼统忽略dist。证明源代码等价与证明新构建可用是不同事项。
5. 原样定向验证修改用例与既有cold shared-start覆盖。新包必须完成原installer的build、完整mandatory tests、HTTP smoke，及真实隔离安装→回滚→stop/job absent/ports free；这些记录必须属于新身份。production资格及preservation保护保留。
6. 逐门说明沿用范围和原metric/task denominator/limit。原QA56/repair16/fullpublic72/newlocked24分组、全部失败、newCritical作用域及cost/optional限制不变。要求当前candidate实际执行的门必须使用新实际proof；等价不能冒充运行、放宽门或把旧raw重标为新执行。

这些条件满足时，唯一test setup变更不改变实际模型收到的工具、生产行为、scorer或业务门槛。无需为了这个无runtime语义变更重新调参或重复模型测量；应把旧证据描述为“原身份真实测量，按已证明runtime-equivalence沿用”。目前新包尚待生成，条件是预注册接受边界，不是已完成证据。

此修正不优化真实产品cold-start ps成本。此次只读评审仅写本报告及JSON；没有执行tests、models、scores、build、installer或benchmark。

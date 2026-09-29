# Runtime / 数据新鲜度 / 安全测试

dataset/contracts/cases.json列出32条产品要求，mutations.json列出4条具体变更序列。execution=runtime的项是必须补到产品集成测试的规格，不能把JSON存在当作测试通过。12项probe函数检验覆盖C1/C2/C3的部分要求，范围用构造FactsReader，不覆盖整个Tree-sitter/JDT路径。

## 变更序列执行器要求

在临时git工作树内：准备文件→等待索引READY(g)→query记录旧hash→执行action→等待新generation或timeout→query→检查旧ID/旧路径/旧hash不可作为current完整证据。delete/rename/add必须分别测；触发N个文件storm不允许只是sleep后假定完成。

若目标文件在query期间变化，允许旧一致snapshot或明确changedDuringRequest/PARTIAL；禁止把old declaration和new source范围拼成READY。negative cache仅对已完整覆盖的scope/version有效。

兄弟worktree重用共享模型/只读历史artifact可以，重用错误工作树的可变索引不可；XML-only变化也必须reconcile。当前SQLite/WAL成果要保持：builder完成、reader idle之后不能持续钉住旧snapshot。

## 语义边界

K22重载同arity应返回STATIC_CANDIDATE/ambiguous，只有JDT绑定成功才标JDT_BOUND。K23静态Parent.value绑定不能排除Child覆盖。Spring profiles/qualifier、反射、Lombok未解析状态不能用高相似分数补成确定事实。

## 运行约束

连接测试仅用显式loopback canary端口；适配器拒绝生产38456。缓存、HOME、XDG、CODEX_HOME、ownership都指向临时目录。对真实源码分析的默认流程无网络、无向量模型下载。

路径包含../、绝对路径、URI、逃逸symlink、NUL应拒绝。fixtures内secret只是测试canary，不是真凭据；其值不能入search文档、日志摘要或external embedding。项目read-only指不修改被分析工程；索引与临时日志仍可在隔离cache目录创建。

单caller取消不能取消其它共享singleflight waiter；backend工作仍受整体期限和队列上限约束。超时partial禁止写complete cache。process runner使用有限时间和输出cap，并清理进程组；这是事故限制，不是安全执行不可信代码的沙箱。

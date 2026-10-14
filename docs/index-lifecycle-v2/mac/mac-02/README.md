# MAC-02：Mac 原生边界

状态：**IN_PROGRESS（MAC-02A / G02A PASS）**。G01已通过并提交`6fd8032ac45b3b32bf7d3cf6fd0033e4999a4ae4`。G02A定向验证、独立复验、归档和实际收尾均通过；MAC-02B/02C尚未验收，父门G02须三个子门全部通过。

MAC-02A提供C17 capability/clonefile helper、同一native builder、冻结Node入口、候选native源码身份、native/runtime构建stamp与受管HTTP smoke。helper只克隆缓存同卷的文件，跨卷/非APFS/身份错误明确失败，不复制fallback。安装器的`--preflight-runtime`是只读身份检查，不安装或调用生产服务。

执行前须设置`ILV2_NODE_BIN`、`ILV2_RUNTIME_MANIFEST`，注册本次运行根并把`TMPDIR`放在其中。MAC-02A的真实版本漂移证据设置`ILV2_FOREIGN_NODE_BIN`指向实际不同的Node；普通测试未提供时只在私有目录复制冻结可执行文件，以不同execPath验证PATH选择，不额外要求另一已安装版本。shell清除原六项Node加载/输出选择器以及测试IPC上下文`NODE_TEST_CONTEXT`；binder在嵌套分支前重绑定当前绝对Node，quoted test glob只在编译候选展开。普通构建、隔离候选和当前三仓候选均重新编译native。历史baseline若完全没有native输入，保留其原始树并明确标注`NOT_APPLICABLE_LEGACY_BASELINE`；当前候选或部分native输入缺失仍失败。

release HTTP smoke使用自身服务实际绑定的随机端口。独立fixture launcher经事务登记后才启动服务；真实服务报告PID、instance、绑定地址和runtime身份，实际service exit与整个组退出分别核对。绑定失败、超时或取消不会附加其他服务，组未退出不会释放共享配额。

已取得的证据包括：旧入口三项行为RED；native及TS隔离编译；同卷克隆后的字节/修改隔离；真实随机端口、端口冲突与取消回收；另一Node置于PATH首位时，PR/release/K调度fixture的后代仍报告冻结execPath、versions和digest；安装预检及编译失败阻断；普通`npm run build`。

跨卷实验使用登记根内的64MiB私有APFS镜像。clone明确返回`CROSS_VOLUME`且未创建目标；现有Java reader/parser实际读取并解析镜像内合成源码。该证据不代表MAC-03新capture协议通过。

PR/release/K样本只证明真实wrapper的运行时选择，生成的fixture TAP不证明正式业务K门或产品性能。失败尝试均保留。一次未引用的shell正则`|`导致无文件列表的误收集，记录为`INVALID_INVOCATION`，不计为全仓PASS。正式三仓矩阵、生产安装/调用、真实JDT/Gradle、launchd/flock及FSEvents仍未运行。

原始记录归档于本机持久工作根的`archives/mac-02a/20261014T023317Z/`：95个文件、402059字节已逐路径/字节/SHA-256解包核对。运行根只保留本地摘要，RAW/BULK已删除，私有镜像已卸载；实际未登记路径、到期残留、关联进程及共享配额均为空。最终状态与精确证据hash见`task-result.json`，不同候选及重叠样本不合并计数。

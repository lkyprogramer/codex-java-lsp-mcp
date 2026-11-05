# MAC-09 — GC 和故障恢复闭环

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** SnapshotStore GC、owner recovery、`scripts/ilv2-mac-fault-matrix.mjs`、相关真实进程集成测试。

**步骤：** 基于 MAC-07 的 `tryReclaim` 实现周期 sweeper 和恢复扫描，所有删除分支复用统一 lease/inflight 检查；覆盖 retired、workspace 失效、无绑定 sealed、半成 tmp、daemon 重启和 base 候选过期。加入故障屏障与外部 SIGKILL，在 clone/SQL/checkpoint/seal/binding 中途发生，另保留确定性 faultAt 出口测试。

**resume 信号生产者（2026-10-16归属决定，G03B评审P2）：** G03B只交付`WorkspaceTracker.resume()`入口与“resume后强制全量hash”的协议级测试，原生helper不发系统唤醒信号。本卡由native侧把系统睡眠唤醒作为原始恢复信号传给tracker（不用Node猜测），并在故障矩阵中证明唤醒后首轮全量hash、确认前不为FRESH。

**验收G09：** 有效reader/worker/base/publication lease文件不消失；恢复后没有半成绑定、越域删除、进程孤儿或泄漏lease；无引用tmp/快照两个GC周期内收敛；停止/超时后pending全部settle，原有绑定可读或明确失效；旧生产缓存和历史证据不被GC触及。

**正式恢复集成（G09必需，不能由G02B/G06C代替）：** 使用已完成的新binding、stdio/HTTP transport、请求分流和GC，覆盖活动builder/query/base lease中杀owner并重启。正常路径证明两类遗留进程同一≤10 s退出、绑定恢复、静态正确查询和语义恢复；注入Gradle stop失败时，旧OWNER_PROCESS退出前不能准入，之后静态查询的snapshot/hash/coverage正确，required语义有界报告阻塞，auto明确静态缺口，无新JDT导入、无Gradle home越域GC。降级场景按故障oracle判定，不能抵扣正常完整恢复超时；清理成功后才能重新启动语义。此门通过后才能宣称产品具备§2.1完整恢复合同。

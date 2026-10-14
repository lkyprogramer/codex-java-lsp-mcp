# MAC-18 — 具体候选的生产切换

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**依赖：** 默认MAC-17 PASS，或§3.1提前候选完成其必需前置门；两者均需用户对具体候选安装的明确授权。无授权停在准备好的包。

**步骤：** 安装前复查目标身份；停止旧服务，安装同一工件、切换唯一launcher/daemon 和新 cache namespace，验证状态、一个真实静态查询、一次指定仓库增量和 stdio/HTTP 路径指向同一 owner。真实静态查询须由生产launcher身份实际读取业务仓完成；TCC等待或拒绝记BLOCKED_ENV_TCC，不视为可用。是否启动真实 JDT 按批准范围执行。记录每步结果和旧工件位置。

**验收 G18：** 读回生产 instance/build/native digest 与候选一致，进程槽位/缓存根/工具结果符合合同；失败立即按已批准回退方案停止新服务，旧版本只有在已证明可用且获准时才恢复。旧格式数据不迁移也不自动删除；不把回退到已知活锁 release 当成功恢复。

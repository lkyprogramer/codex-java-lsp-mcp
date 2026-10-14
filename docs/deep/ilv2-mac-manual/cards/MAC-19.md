# MAC-19 — 观察和收尾

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**步骤：** 对 MAC-18 实际部署观察 24 h（或用户明确指定窗口），记录正常使用与未覆盖的低流量时段；运行 on-demand SLO 汇总，不自动创建日报/定时任务。核对进程、lease、快照物理增长、失败与用户真实工作区的 first-correct evidence。更新 README/HANDOFF/操作文档和任务状态，清理本次到期隔离产物。

**验收 G19：** 工程结果、agent 结果、生产读回分别列状态；部署成功但 A/B 未跑须明确写未验证 agent 收益。无未披露失败/孤儿/无主配置；旧生产缓存只有单独删除授权才处理。只有最终候选实际部署/观察完成且全部必需任务关闭才能把本手册改为LANDED；提前候选观察不结束整个计划；授权未给时整个计划停在 READY_FOR_DEPLOY，不把未部署的任务标 PASS。

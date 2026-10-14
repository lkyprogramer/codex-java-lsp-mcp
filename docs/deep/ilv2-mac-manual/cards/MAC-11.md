# MAC-11 — 完整系统闭环与提前候选检查点

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** 隔离 lishu-v2 run copies、MAC-01 runners、生命周期遥测；仅根据失败证据修改直接责任模块。

**步骤：** 按 §5.2 跑“主库 full → 六 worktree 并发 → 五小差量 + 一大分支 full → 持续编辑 → 杀 builder/daemon → 重启 → 正确查询”。另跑两个长 full 与短 delta 公平性。独有方法/Java/XML/hash oracle 检查所有 worktree；插入坏语法、同 stat、touch、edit-revert、事件 drop、候选 lease/GC。

**验收 G11：** 正确性、隔离、请求截止、资源/lease生命周期硬门必须 PASS，且所有性能项完成足量实测；0 跨 worktree 错证、0 混捕获 hash、0 无界请求、0 健康 build 误杀，短作业不能被 full 无限饿死。edit→first-correct-query、full/seed/排队、零/20/200 物理成本逐项记实际 PASS/FAIL。性能 FAIL 不伪装通过，但允许仅进入 MAC-12 修复对应已测热点；正确性失败必须先修本卡。输出 parse、resolve、graph、SQL/封存、排队 profile；G11 状态另附 `performanceReady`，不把“测量已完成”表述为性能已达标。

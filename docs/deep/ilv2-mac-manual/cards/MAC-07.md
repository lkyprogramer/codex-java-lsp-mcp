# MAC-07 — 封存与原子 workspace 绑定

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** 新 `src/java-index/snapshot/`、manifest 校验、immutable 读连接、lease 注册及发布协议。

**步骤：** 实现 §2.7 次序与 crash recovery，以及统一、真实执行删除的 lease-aware `tryReclaim` 原语；发布/noop 共用 binding CAS；零差量验证后绑定同一 snapshot；候选、base 和 reader 共用 lease。封存 DB 的不可变约束通过文件/目录归属和代码写入口双重保证，只有 SEALED 才用 SQLite immutable。

**验收 G07：** 每个封存/rename/binding 边界失败后只有完整旧绑定或完整新绑定；错误 root/buildKey/capture 不能确认；noop 能更新水位且不新增 DB；并发 publish 不能把旧验证套新状态；base 在 clone 前被 pause，其他发布与并发 `tryReclaim` 不能删除它；本卡直接调用真实删除原语，周期 GC sweeper 留到 MAC-09。进程崩溃测试不声称覆盖断电耐久。

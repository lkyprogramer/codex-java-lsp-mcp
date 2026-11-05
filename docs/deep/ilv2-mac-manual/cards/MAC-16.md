# MAC-16 — 语义精度条件任务

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** JDT session manager、静态解析失败案例、隔离语义 oracle；无证据不改精度架构。

**步骤：** 先检查 MAC-10/13/14 的实际失败；MAC-15 若已运行也纳入。没有影响任务成功的语义缺口则 NOT_RUN 并交付依据。需要实验时保持每 workspace/environment 专用 session，按全局配额排队与 idle 回收。可试编译器离线关系提取，但其 key 必含完整编译环境，先与现有专用 JDT 比较成本与收益。

**验收 G16：** 两个并发 worktree 同 URI 不同内容、相同构建配置、交错请求时 0 串扰；不允许 98% 一致率豁免隔离错误。分层至少 200 个符号按专用 JDT 真值评估，语义关系一致率 ≥ 98% 仅作为精度门，另报错误类别与运行成本；实际失败任务改善才采用。实验失败删除新路径；有效原有语义能力不随条件任务跳过而删除。

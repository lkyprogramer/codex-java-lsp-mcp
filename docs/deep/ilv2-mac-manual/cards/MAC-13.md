# MAC-13 — 工具面与 guidance

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**依赖：** MAC-10、MAC-11，可与MAC-12并行；共享源码写入仍串行协调。整合门MAC-14必须同时等MAC-12和MAC-13。

**范围：** 当前 MCP schema、`java_symbol`/`java_impact` 路由与文档、repository guidance 和建议全局 diff；不得直接改全局文件。

**步骤：** 在 MAC-08 的可靠生命周期上完成必需输出合同：workspace/snapshot/content 身份、coverage、indexFreshness 和明确 NOT_READY/PARTIAL。`java_impact(symbol=...)` 用静态索引定位，有歧义返回候选，不猜重载；参数错误带合法示例。同步更新guidance，删除强制先status的文档要求；IDLE_WARMING运行时代码已由MAC-08B删除，不重复归属。用 MAC-10 dev 任务决定 read plan/批量读取的具体改善，不预先强制合并工具。

**验收 G13：** 公共 schema、调用方、文档同步；mac1之前的ID格式明确拒绝；同workspace未变命名符号的mac1 ID跨无关发布仍可调用，证据handle版本另验；歧义/缺口/超时语义可测；无模型 recall 不下降超过 2pp，实际 evidence coverage 不退化，全部 6 个 pilot 的 retrieval/evidence smoke 通过；repair judge 另验 known-bad 拒绝、known-good 通过，不要求未修复 tree 被判成功。guidance 使用执行agent可见输入并与工具能力一致。关闭D09的guidance/文档部分，交付`guidance.diff`，全局应用待授权。

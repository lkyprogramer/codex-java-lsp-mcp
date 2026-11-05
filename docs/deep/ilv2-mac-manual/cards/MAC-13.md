# MAC-13 — 工具面与 guidance

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**依赖：** MAC-10、MAC-11，可与MAC-12并行；共享源码写入仍串行协调。整合门MAC-14必须同时等MAC-12和MAC-13。

**范围：** 当前 MCP schema、`java_symbol`/`java_impact` 路由与文档、repository guidance 和建议全局 diff；D08残留②的 `src/agent-router/framework-index-view.ts`、`framework/shared.ts` 及产生旧式查找键的adapter调用方。不得直接改全局文件。

**步骤：** 在 MAC-08 的可靠生命周期上完成必需输出合同：workspace/snapshot/content 身份、coverage、indexFreshness 和明确 NOT_READY/PARTIAL。`java_impact(symbol=...)` 用静态索引定位，有歧义返回候选，不猜重载；参数错误带合法示例。同步更新guidance，删除强制先status的文档要求；IDLE_WARMING运行时代码已由MAC-08B删除，不重复归属。用 MAC-10 dev 任务决定 read plan/批量读取的具体改善，不预先强制合并工具。

**D08残留②（2026-10-15归属决定）：** 框架adapter的`type:<fqn>`、`method:type:<fqn>#<sig>`、`field:type:<fqn>#<name>`是进程内名称查找键，不是持久化旧库格式，也不是公共mac1 symbolId。调用方先按module/sourceSet等实际上下文解析名称，再以真实source-scoped declaration ID读取声明和路径；完成调用方迁移后删除`v1AliasIds`及两处alias处理。当前`bundlesToRequestedDeclarations`对重复alias报缺口，`relativePathLookup`却按最低ID选首项；迁移必须统一歧义语义，不以另一个字符串前缀保留兼容路径。

**验收 G13：** 公共 schema、调用方、文档同步；mac1之前的ID格式明确拒绝；同workspace未变命名符号的mac1 ID跨无关发布仍可调用，证据handle版本另验；歧义/缺口/超时语义可测；无模型 recall 不下降超过 2pp，实际 evidence coverage 不退化，全部 6 个 pilot 的 retrieval/evidence smoke 通过；repair judge 另验 known-bad 拒绝、known-good 通过，不要求未修复 tree 被判成功。guidance 使用执行agent可见输入并与工具能力一致。关闭D09的guidance/文档部分，交付`guidance.diff`，全局应用待授权。

D08②同时要求：三类旧式查找键及alias map无生产调用者；现有Spring/MapStruct/MyBatis等受影响adapter的有效目标仍能解析；同FQN跨module/sourceSet、重载和缺失声明均有定向用例，有唯一上下文时选中正确声明，无充分上下文时返回候选或明确缺口，不按ID排序猜选。公共旧ID拒绝与内部名称解析分别验证；本卡只关闭D08②，①继续由MAC-07 + MAC-08B负责。

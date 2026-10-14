# MAC-03 — 同字节捕获与tracker分开推进

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

## MAC-03A — 纯TS内容捕获

**依赖：** MAC-01，可与MAC-02并行。**范围：** `java-index-file-parse.ts`、`search-document.ts`、cold/incremental search派生接口与capture类型。

**目标测试：** `dist/index-builder/content-capture.test.js`：`parse-search-use-identical-bytes`、`preview-rejects-live-hash-mismatch`、`source-root-may-use-another-volume`。Buffer/受管staging贯穿hash/AST/search，后续阶段不二读；source根无需APFS同卷。

**G03A：** parse后注入编辑仍同字节派生，census包含失败/删除/资源；删除D03。新schema/新full-delta可依赖本卡，不必等待FSEvents完成。

## MAC-03B — 事件确认、水位与noop

**依赖：** MAC-03A、MAC-02C。**范围：** `repo-fs-watch.ts`替代、tracker、root/build身份、pending/rescan水位。

**目标测试：** `dist/java-index/snapshot/workspace-tracker.test.js`：`same-stat-changes-are-hashed`、`touch-edit-revert-startup-noop`、`drop-during-scan-keeps-new-rescan-cut`、`root-replacement-invalidates-binding`、`stream-restart-requires-full-hash`、`new-epoch-rejects-old-result-with-same-seq`。经§5.1定向入口。

**G03B：** Java/XML同stat变化能发现；扫描中新事件/drop不被旧cut清除；第一轮STALE、第二轮确认；持续编辑不无限重启。原生cursor只在内存，进程重启新epoch+全量hash；删除D07。父门G03需G03A/B全通过。

# 资料与可追溯性

本轮以附件源码、原冻结包和对应GitHub版本为权威。以下为已阅读的源文件；行号随版本变化前须重新定位函数。

- [S01 scripts/run-agent-trace-live.mjs](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/scripts/run-agent-trace-live.mjs)：261–281 / 480–625：压缩与最终消息。
- [S02 scripts/evaluate-java-task.mjs](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/scripts/evaluate-java-task.mjs)：31 / 214–270 / 292–468：prompt、判分与分母。
- [S03 experiments/semantic-discovery/provider.mjs](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/experiments/semantic-discovery/provider.mjs)：缓存/identity/timeout/stale。
- [S04 experiments/semantic-discovery/compare.mjs](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/experiments/semantic-discovery/compare.mjs)：coverage与A2/A3 union。
- [S05 experiments/semantic-discovery/agent-ab.mjs](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/experiments/semantic-discovery/agent-ab.mjs)：candidate与symbol root、硬编码路径。
- [S06 experiments/semantic-discovery/repair-judge.mjs](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/experiments/semantic-discovery/repair-judge.mjs)：allowed delete物化/执行。
- [S07 src/java-index/sql/entity-search.ts](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/src/java-index/sql/entity-search.ts)：437–456：scope在cap后。
- [S08 src/discovery/query.ts](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/src/discovery/query.ts)：query/terms/scope、preview与stale。
- [S09 src/java-index/name-resolver.ts](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/src/java-index/name-resolver.ts)：FQN最小ID赢家。
- [S10 src/discovery/search-document.ts](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/src/discovery/search-document.ts)：XML范围与Java来源混用。
- [S11 docs/java-specialist-devkit-v1/reports/m3-milestone.md](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/docs/java-specialist-devkit-v1/reports/m3-milestone.md)：历史测量/未测32项/原解释。
- [S12 docs/java-specialist-devkit-v1/schemas/gates.json](https://github.com/lkyprogramer/codex-java-lsp-mcp/blob/b9c3cc325491947b198342575e9ea251c024b521/docs/java-specialist-devkit-v1/schemas/gates.json)：原冻结上线标准。

## 本地输入和独立运行

`evidence/input-manifest.json` 包含三个输入archive的SHA256/ZIP comment；`provenance/audited-files.json`包括关键文件SHA256与Git blob。`baseline-kit/`为实际可访问原包字节，不是从历史聊天概括重建。`evidence/`为本次独立离线运行；`provenance/repository-reports/`为源码中报告的副本，二者不混同。

## 规范核验

- [Node.js v22 DatabaseSync](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)：API同步执行；不是把async函数名作为异步SQL证据。本次环境Node22.16.0，文档更新版本的新增API不自动假设存在。
- [MCP 2025-06-18 Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)：工具结果可以有text/structuredContent。SDK成功返回不证明host后续没有破坏payload，最后model-visible消息还要测。
- [SQLite WAL](https://www.sqlite.org/wal.html)：长读事务会影响checkpoint，R12需实测空闲收敛；本包没有以规范替代实际WAL负载证据。

没有使用新的竞品/论文排行榜推导本项目收益。本轮的关键问题是实现与测量是否符合原定义，而不是再研究一个新产品方向。

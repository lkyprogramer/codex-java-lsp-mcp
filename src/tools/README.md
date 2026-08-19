# `src/tools/`

本目录承载 ImpactResult V6 public MCP tools 的薄 handler。公开工具面真源是 `src/mcp-server-factory.ts` 的 `PUBLIC_JAVA_TOOLS`（恰好五个：`java_status`、`java_impact`、`java_symbol`、`java_diagnostics`、`java_runtime`）。没有 `java_context`。每个 handler 只负责入参解析、request budget 传播、调用共享服务和响应格式化；JavaIndex、semantic、ranking 与 readPlan 逻辑留在各自 owner 模块。历史 v5 tools 面已删除。

## 文件清单

- `README.md` | 目录职责与文件清单。
- `context.ts` | 注入给 handler 的 JDT session、JavaIndex、AgentRouter、watcher/resource 状态。
- `diagnostics.ts` | `java_diagnostics`。
- `impact.ts` | 推荐入口 `java_impact`；创建唯一 absolute `DeadlineBudget` 并传入 router。
- `runtime.ts` | `java_runtime`（action=restart\|shutdown）。
- `shared.ts` | repo-relative、JSON-safe 的 location/hover/symbol formatter。
- `status.ts` | `java_status`；汇总 runtime、RepoChangeCoordinator、JavaIndex coverage/generation、lease 与 cache 状态。
- `symbol.ts` | `java_symbol`（operation=query\|position\|references）。

目录内容变化时必须同步更新本文件。

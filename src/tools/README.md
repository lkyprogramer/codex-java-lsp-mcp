# `src/tools/`

本目录承载 public MCP tools 的薄 handler。公开工具面真源是 `src/mcp-server-factory.ts` 的 `PUBLIC_JAVA_TOOLS`（`java_status`、`java_impact`、`java_context`、`java_symbol`、`java_diagnostics`、`java_runtime`）。`java_impact` 仍是当前 compact 链；`java_context` 是 JIN planner（N5）。每个 handler 只负责入参解析、request budget 传播、调用共享服务和响应格式化。历史 v5 tools 面已删除。

## 文件清单

- `README.md` | 目录职责与文件清单。
- `context.ts` | 注入给 handler 的 JDT session、JavaIndex、AgentRouter、watcher/resource 状态。
- `diagnostics.ts` | `java_diagnostics`。
- `impact.ts` | 当前 compact 链 `java_impact`；创建唯一 absolute `DeadlineBudget` 并传入 router。
- `java-context.ts` | JIN `java_context`：intent / 无锚点 / navigate，返回 §11.3 contract。
- `runtime.ts` | `java_runtime`（action=restart\|shutdown）。
- `shared.ts` | repo-relative、JSON-safe 的 location/hover/symbol formatter。
- `status.ts` | `java_status`；汇总 runtime、RepoChangeCoordinator、JavaIndex coverage/generation、lease 与 cache 状态。
- `symbol.ts` | `java_symbol`（operation=query\|position\|references）。

目录内容变化时必须同步更新本文件。

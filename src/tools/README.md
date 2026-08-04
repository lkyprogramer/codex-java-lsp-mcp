一旦我所属的文件夹有所变化，请更新我。
本目录承载 v5 public MCP tools 的薄 handler。
每个 handler 只做入参解析、调用共享服务和响应格式化，复杂影响面逻辑放在 `agent-router/`。

## 文件清单

- `README.md` | 目录说明 | 说明 tools 目录职责。
- `context.ts` | 共享上下文 | 定义注入给 tool handler 的 JDT LS session、source index、agent router。
- `diagnostics.ts` | 工具 handler | 实现 `java_diagnostics`。
- `impact.ts` | 工具 handler | 实现推荐入口 `java_impact`。
- `runtime.ts` | 工具 handler | 实现合并后的 `java_runtime`（action=restart\|shutdown，Task 31 Step 7 折叠了原 `restart.ts`/`shutdown.ts`）。
- `shared.ts` | 格式化工具 | 复用 LSP location、hover、symbol kind 的 JSON-safe formatter。
- `status.ts` | 工具 handler | 实现 `java_status`。
- `symbol.ts` | 工具 handler | 实现合并后的 `java_symbol`（operation=query\|position\|references，Task 31 Step 7 折叠了原 `references.ts`）。

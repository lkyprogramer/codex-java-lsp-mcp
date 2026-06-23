本目录是 `codex-java-lsp` MCP 的 TypeScript 源码层。
`server.ts` 只做 MCP 注册，`repo-resolver.ts` 负责 repo/worktree 选择，`tools/` 处理 public tools，`agent-router/` 生成 Java 影响面。

## 文件清单

- `agent-router/` | `java_impact` 的候选生成、内部 rg、评分、readPlan 与证据缺口逻辑。
- `agent-types.ts` | public options、内部候选、readPlan、rgSummary 与 metrics 类型。
- `alias-registry.ts` | 读取并热更新 `projects.json` alias 与 LSP enablement 配置。
- `benchmark-agent-impact.ts` | 固化导航场景，统计 payload、耗时、precision、recall。
- `file-watcher.ts` | 监听 Java/Gradle/Maven 变化并通知 JDT LS，同时触发 cache invalidation。
- `generated-code.ts` | 检测 Lombok、MapStruct 等生成代码依赖与 Lombok javaagent。
- `hooks/hook-gate.ts` | Codex advisory hook，复用 registry/resolver/path 判断。
- `jdtls-session.ts` | 启动/复用 JDT LS，处理 initialize、open document、diagnostics、documentSymbol、timeout 与 cache。
- `path-utils.ts` | canonical path、segment-safe containment、repo hash。
- `project-jdk.ts` | 解析项目 JDK 与 JDT LS runtime JDK 的配置关系。
- `repo-layout.ts` | 识别 repo root、模块、layer、sourceSet 和路径规范化。
- `repo-resolver.ts` | 将 `projectId/repoRoot/file` 解析为 canonical repoRoot、repoHash 与 LSP enablement。
- `repo-runtime-manager.ts` | 管理每个 repo/worktree 的 session、SourceIndex 和 AgentRouter。
- `server.ts` | 注册七个只读 public MCP tools。
- `smoke.ts` | 启动已构建 MCP server，验证 tools/list、`java_status` 与 shutdown。
- `source-index.ts` | Java 轻量源码索引，支持 regex cold facts 和 documentSymbol warm-index 回填。
- `tools/` | 七个 public MCP tool 的 handler 与共享 context。
- `worktree-cache-cleanup.ts` | 启动时清理超过 TTL 的非活跃 Git worktree cache，不清主 checkout。

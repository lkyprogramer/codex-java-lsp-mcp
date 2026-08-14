本目录是 `codex-java-lsp` MCP 的 TypeScript 源码层。
`application.ts` 管理共享业务生命周期，`mcp-server-factory.ts` 注册 public tools，`server.ts` 装配 stdio transport，`http-server.ts` 装配 stateless loopback HTTP daemon；`repo-resolver.ts` 负责 repo/worktree 选择，`agent-router/` 生成 Java 影响面。

## 文件清单

- `agent-router/` | `java_impact` 的候选生成、内部 rg、评分、readPlan 与证据缺口逻辑。
- `agent-types.ts` | public options、内部候选、readPlan、rgSummary 与 metrics 类型。
- `application.ts` | transport-neutral application | 集中拥有 registry、resolver、runtime、request drain、正常 close 与 deadline-bounded forceClose；强制关闭保留 uncertain canonical-root lease。
- `alias-registry.ts` | 读取并热更新 `projects.json` alias 与 LSP enablement 配置。
- `benchmark-agent-impact.ts` | 固化导航场景，统计 payload、耗时、precision、recall。
- `file-watcher.ts` | 监听 Java/Gradle/Maven 变化并通知 JDT LS，同时触发 cache invalidation。
- `generated-code.ts` | 检测 Lombok、MapStruct 等生成代码依赖与 Lombok javaagent。
- `hooks/hook-gate.ts` | Codex advisory hook，复用 registry/resolver/path 判断。
- `http-server.ts` | loopback stateless Streamable HTTP host，负责 Host/Origin/body/path 防护、request protocol scope 与 drain/force shutdown。
- `http-server-lifecycle.ts` | HTTP READY/DRAINING/CLOSED 状态、in-flight 计数与有界 drain。
- `jdtls-session.ts` | 启动/复用 JDT LS，处理 initialize、open document、diagnostics、documentSymbol、timeout 与 cache。
- `mcp-server-factory.ts` | protocol factory | 每个 transport/session 创建独立 MCP server，并共享 application。
- `path-utils.ts` | canonical path、segment-safe containment、repo hash。
- `project-jdk.ts` | 解析项目 JDK 与 JDT LS runtime JDK 的配置关系。
- `repo-layout.ts` | 识别 repo root、模块、layer、sourceSet 和路径规范化。
- `repo-ownership-lease.ts` | cross-process ownership | 通过原子目录交接、PID 启动身份和 owner token 保证同 root 单 owner。
- `repo-resolver.ts` | 将 `projectId/repoRoot/file` 解析为 canonical repoRoot、repoHash 与 LSP enablement；daemon 模式严格拒绝 CWD/跨 root 推断。
- `repo-runtime-manager.ts` | 管理每个 repo/worktree 的 ownership、query/control gate、JDT slot 和 runtime entry TTL/LRU 驱逐。
- `server.ts` | stdio compatibility entry | 只装配 application、protocol server 与 stdio lifecycle。
- `smoke.ts` | 启动已构建 MCP server，验证 tools/list、`java_status` 与 shutdown。
- `smoke-http.ts` | 连接显式 loopback URL，验证 7 tools、daemon status、build SHA 与可选 repo selector/JDT start。
- `source-index.ts` | Java 轻量源码索引，支持 regex cold facts、documentSymbol warm-index 回填、内存 dispose 与磁盘 snapshot 重载。
- `tools/` | 七个 public MCP tool 的 handler 与共享 context。
- `worktree-cache-cleanup.ts` | startup + periodic cache janitor；删除前排除 retained root/JDT，并取得 canonical-root ownership lease。

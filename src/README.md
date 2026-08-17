# `src/` architecture map

本目录是 `codex-java-lsp` MCP 的 TypeScript 源码层。生产链只有一套 Java V3 路径：RepoChangeCoordinator generation → Tree-sitter JavaIndex → bounded JDT/SemanticGateway → typed evidence/family ranker → token-aware `readPlan` → 5 个 MCP tools。stdio 与 HTTP daemon 共用 `JavaLspApplication`。

## 文件清单

- `agent-router/` | `java_impact` 的 typed evidence、family ranking、framework packs、candidate materialization 与文件/范围级 `readPlan`。
- `agent-types.ts` | public options、ImpactResultV6、候选、readPlan、freshness 与 metrics 类型。
- `application.ts` | transport-neutral application | 集中拥有 registry、resolver、runtime、request drain、正常 close 与 deadline-bounded forceClose。
- `alias-registry.ts` | 读取并热更新 `projects.json` alias 与 LSP enablement 配置。
- `benchmark-agent-impact.ts`、`benchmark/` | frozen golden、质量/成本/确定性/mutation/first-touch 验收工具；不属于 MCP 请求路径。
- `cross-process-lease.ts` | machine-level JDT/sweep fixed slots、same-worktree runtime ownership、heartbeat 与 owner-token release。
- `document-lru.ts` | JDT open document 上限、pin、didChange/didClose 与 LRU 淘汰。
- `generated-code.ts` | 检测 Lombok、MapStruct 等生成代码依赖与 Lombok javaagent。
- `hooks/hook-gate.ts` | Codex advisory hook，复用 registry/resolver/path 判断。
- `http-server.ts` | loopback stateless Streamable HTTP host。
- `http-server-lifecycle.ts` | HTTP READY/DRAINING/CLOSED 状态、in-flight 计数与有界 drain。
- `java-index/` | Tree-sitter Java AST、FQN/import resolution、静态 edges、MyBatis resources、coverage、incremental refresh、atomic snapshot 与 worktree seed。
- `jdtls-session.ts` | transactional JDT lifecycle、restart backoff、lease heartbeat、DocumentLru、LSP notifications 与 SemanticGateway backend。
- `mcp-server-factory.ts` | 每个 transport/session 创建独立 MCP server，并共享 application。
- `semantic-gateway.ts` | 所有 semantic operations 的 same-key singleflight、per-caller deadline、complete-only bounded cache。
- `repo-change-coordinator.ts` | 唯一文件 watcher owner；输出 normalized batch 和单调 generation，处理 storm/degraded 状态。
- `repo-ownership-lease.ts` | cross-process ownership | 通过原子目录交接、PID 启动身份和 owner token 保证同 root 单 owner。
- `repo-runtime-manager.ts` | 管理每个 repo/worktree 的 coordinator、JavaIndex、JDT session、request budget 与 lifecycle。
- `path-utils.ts` | canonical/potential path、segment-safe containment、repo hash。
- `project-jdk.ts` | 解析项目 JDK 与 JDT LS runtime JDK 的配置关系。
- `repo-layout.ts` | 识别 repo root、模块、layer、sourceSet 和路径规范化。
- `repo-resolver.ts` | 将 `projectId/repoRoot/file` 解析为 canonical repoRoot、repoHash 与 LSP enablement；daemon 模式严格拒绝 CWD/跨 root 推断。
- `server.ts` | stdio compatibility entry | 装配 application、protocol server 与 stdio lifecycle。
- `smoke.ts` | 启动已构建 MCP server，验证 `tools/list`、`java_status` 与 shutdown。
- `smoke-http.ts` | 连接显式 loopback URL，验证 5 tools、daemon status、build SHA。
- `tools/` | 5 个 public MCP tool 的薄 handler 与共享 context。
- `worktree-cache-cleanup.ts` | owner-token/lease-aware cache janitor；只清理已确认非活跃的 stale worktree cache。

目录或生产 ownership 变化时必须同步更新本文件。

# codex-java-lsp-mcp

![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-43853c.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

`codex-java-lsp-mcp` 是面向 coding agent 的 Java-only 本地代码智能服务：Tree-sitter 增量事实 + 有界 JDT 精确语义 + 面向任务、受 token 预算约束的 `readPlan`。

它不是完整 IDE，也不是通用语言平台。项目边界以 canonical `repoRoot` 和 `repoHash` 为准，`projectId` 只作为 alias/display name；所有请求都受绝对 deadline、仓库边界和完整性状态约束。

## 目录

- [核心能力](#核心能力)
- [五层架构](#五层架构)
- [设计边界](#设计边界)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [项目启用](#项目启用)
- [Codex Hook](#codex-hook)
- [Public MCP Tools](#public-mcp-tools)
- [配置](#配置)
- [开发与验证](#开发与验证)
- [故障排查](#故障排查)
- [安全说明](#安全说明)
- [贡献规范](#贡献规范)
- [许可证](#许可证)

## 核心能力

- 注册一个 Codex MCP server：`codex-java-lsp`。
- 提供 5 个 public tools：`java_status`、`java_impact`、`java_symbol`（operation=query\|position\|references）、`java_diagnostics`、`java_runtime`（action=restart\|shutdown）。
- 默认推荐入口是 `java_impact`，用于生成影响面、候选文件、`readPlan`、证据缺口和指标。
- 未启用 LSP 的 Java repo 仍可走 fast path：repo/layout/JDK 探测、Tree-sitter JavaIndex、增量 watcher 和有界 streaming `rg`。
- 启用 LSP 后，JDT LS 为 symbol、references、hierarchy、diagnostics 和精确位置语义提供增强结果；同键请求由 SemanticGateway singleflight 合并。
- Git worktree family 可继承 LSP enablement 和经过内容验证的不可变 seed facts；每个 worktree 的 generation、JavaIndex、JDT workspace、日志和可变缓存保持隔离。
- `ImpactResultV6` 显式暴露 freshness/completeness、证据来源、任务导向的候选顺序和文件/范围级 `readPlan`。

## 五层架构

1. **Repo identity 与 freshness**：`repo-resolver`、`RepoChangeCoordinator` 和单调 generation 统一处理 canonical containment、edit/add/delete/rename/build/resource 事件、storm 降级和 worktree identity。
2. **JavaIndex 静态事实层**：Tree-sitter Java AST、FQN/import 解析、静态关系、MyBatis resource facts、按 source root 的 coverage，以及 versioned atomic snapshot。后台 sweep 分块且受跨进程 lease 限制，前台 refresh 不等待整仓 sweep。
3. **JDT 精确语义层**：`JdtlsSession`、`SemanticGateway`、跨进程 JDT slot、restart backoff、complete-only bounded cache 和 64-entry `DocumentLru`。同键 semantic operation 只执行一次 backend work，每个 caller 独立消费自己的 deadline。
4. **Evidence、ranking 与 readPlan**：providers 只产生 typed evidence；family ranker 对同族证据饱和；Spring、MyBatis、MapStruct pack 只在有证据时参与；planner 一次批量读取精确 ranges，并同时约束文件、字节和估算 token。
5. **MCP surface 与 observability**：5 个工具提供 compact/standard/diagnostic 输出；`java_status` 汇总 runtime、watcher、JavaIndex coverage、generation、lease 和缓存状态，不把绝对私有路径泄漏到标准结果。

### cold、auto、required

- `semanticPolicy=fast`：不发起 live JDT semantic request；使用 JavaIndex、静态/框架证据和 streaming `rg`。LSP 未启用时强制采用该策略。
- `semanticPolicy=auto`：`java_impact` 默认值。只对当前策略允许的 service-profile anchor 在剩余 request budget 内使用 JDT；JDT 已 READY 本身不构成自动执行理由。
- `semanticPolicy=required`：显式要求 live JDT 语义；LSP 未启用时立即返回配置错误，启动、slot 等待和请求本身仍必须服从同一个绝对 deadline。
- benchmark 的 `cold-nolsp`、`warm-auto`、`warm-required` 分别固定上述三种验收状态。Phase 5 决策为 `KEEP_EXPLICIT`：`required` 保持显式选择，不改成默认。

### Cache、freshness 与 completeness

- JavaIndex snapshot 只接受当前 schema/build identity/manifest；不匹配、损坏或部分写入会被忽略并重建，不读取 V1 cache，也不做双读/双写迁移。
- 每个 normalized repo batch 只推进一次 generation，并同时驱动 AgentRouter、JDT document/cache 同步和 JavaIndex refresh。请求结果记录 `requestGeneration`、`indexedGeneration` 与 `changedDuringRequest`。
- source root 只有在同 generation、无 failed/recovered/pending 条目且 coverage=`COMPLETE` 时才能回答负查询；其余状态返回未知或降级结果，不能把缺失当成不存在。
- SemanticGateway 只缓存 `COMPLETE`，有 TTL、容量上限和 generation 失效；partial/timeout/cancelled 结果不会写成 complete cache。
- worktree sibling seed 在目标内容验证完成前不可查询，且在 reconcile 结束前保持 `DEGRADED`。schema 不兼容时直接重建目标 cache。

## 设计边界

- public MCP surface 保持 5 个工具；除非有明确需求（测过 `tools/list` token 成本或有真实误选证据），不扩展或再拆分工具面。
- 所有工具都不修改目标 Java repo；`java_runtime`（action=restart\|shutdown）只影响本 MCP 管理的 JDT LS 进程。
- JDT LS 启动必须显式启用：`lspEnabled=true`，或命中同一 Git `common-dir` 的 worktree family 继承。
- JavaIndex 是冷启动事实来源；JDT LS 是可选精确增强，不是路由正确性的唯一来源。
- JDT LS runtime JDK 与项目 JDK 分开处理，避免把语言服务器运行环境误当成项目编译环境。
- resource 默认值按本机内存保守计算；多 repo 并行时优先保住可用性，而不是抢占更多 JDT LS。
- `warm-required` 仍是 precision/recall 可选增强，不是默认路径；profile-aware/default warm 需要先解决首触 `textDocument/references` P95。
- 非目标：非 Java 语言索引、替代 Maven/Gradle 编译、远程/共享可变索引、任意图查询 API、自动修改目标仓库，以及用 partial evidence 伪装完整答案。

## 环境要求

- macOS。目前 `run.sh` 和检查脚本会在非 macOS 平台直接退出。
- Node.js `>=22` 和 npm。
- Codex CLI，且可执行 `codex mcp`。
- Java runtime。
- Eclipse JDT Language Server，可用 Homebrew 安装：

```bash
brew install jdtls
```

## 快速开始

```bash
npm ci
npm run build
npm test
./install-runtime.sh
./check-codex-mcp.sh --fast
```

默认 runtime 目录：

```text
~/Library/Application Support/codex-java-lsp-mcp
```

默认项目配置：

```text
~/.config/codex-java-lsp/projects.json
```

`install-runtime.sh` 会把当前项目复制到用户级 runtime、安装依赖、构建 `dist/`，并注册 Codex MCP server `codex-java-lsp`。

兼容入口：

```bash
./install-codex-mcp.sh
```

## 项目启用

启用一个 Java repo：

```bash
"$HOME/Library/Application Support/codex-java-lsp-mcp/register-alias.sh" \
  --enable-lsp my-java-app /absolute/path/to/my-java-app \
  --layout-profile maven-reactor
```

禁用 LSP 但保留 alias：

```bash
"$HOME/Library/Application Support/codex-java-lsp-mcp/register-alias.sh" \
  --disable-lsp my-java-app /absolute/path/to/my-java-app
```

可选 `layoutProfile`：

- `ddd-gradle`
- `maven-reactor`
- `generic-java`

每次使用前先确认当前 repo 解析结果：

```json
{"tool":"java_status","arguments":{"repoRoot":"/absolute/current/worktree","start":false}}
```

只有返回的 `repoRoot` 等于当前 worktree，才继续信任 LSP 结果。

### Worktree 规则

- 如果当前 worktree 与某个 `lspEnabled=true` 配置 root 共享同一个 Git `common-dir`，允许继承“可启动 LSP”的权限。
- 继承的只是 enablement，不继承主工作区的 runtime/cache。
- 当前 worktree 仍使用自己的 canonical `repoRoot`、`repoHash`、generation、JavaIndex snapshot、JDT LS workspace 和日志。
- 独立 clone、复制目录、不同 Git `common-dir` 的 review worktree 不自动继承，需要单独注册绝对路径。
- 如果多个 enabled alias 共享同一 Git family 且无法唯一判断，hook 静默放行，`java_status` 返回 conflict。

## Codex Hook

生成 Codex `UserPromptSubmit` advisory hook 配置：

```bash
"$HOME/Library/Application Support/codex-java-lsp-mcp/install-hook.sh"
```

hook 行为：

- 每次执行重新读取 `projects.json`。
- 只校验当前 cwd 是否命中 `lspEnabled=true` 或 Git worktree family 继承。
- 未启用、冲突、非 Java 语义提示时静默放行。
- 只追加短提示，不直接启动 JDT LS，不阻断 shell/`rg`。
- 提示 agent 先用 `java_status(start=false)` 校验 `repoRoot`；已配置项目不能只报告 LSP server 未启动，若返回 `started=false`，必须用 `java_status(start=true)` 主动启动。

## Public MCP Tools

| Tool | 用途 | 是否要求 LSP |
| --- | --- | --- |
| `java_status` | 查看 server、repo、JDT LS、RepoChangeCoordinator、JavaIndex coverage/generation、lease 和 resource 摘要；`start=true` 时尝试启动 JDT LS；`detail=diagnostic` 返回完整排障字段。 | 否；启动时需要启用 |
| `java_impact` | 推荐入口。生成 Java 影响面、候选文件、内部 `rg` 摘要、可读计划、证据缺口和指标。 | `semanticPolicy=fast` 不要求；`required` 要求 |
| `java_symbol` | `operation=query`（默认，给了 query）按 query 搜索 workspace symbols；`operation=position`（默认，给了 file/line/column）查 hover、definition、implementation；`operation=references` 对精确符号位置返回 summary-only references。默认返回 repo-relative 位置、隐藏 raw URI/range。 | 是 |
| `java_diagnostics` | 打开 Java 文件并等待短时间返回 JDT LS diagnostics；默认按 repo-relative 文件聚合。 | 是 |
| `java_runtime` | `action=restart` 重启当前 repo 的 JDT LS session（默认返回动作摘要，只有显式参数才清 cache）；`action=shutdown` 停止当前或全部（`all=true`）JDT LS 子进程，MCP server 保持存活。 | restart 是；shutdown 否 |

推荐默认调用顺序：

```json
{"tool":"java_status","arguments":{"repoRoot":"/absolute/repo","start":true}}
{"tool":"java_impact","arguments":{"repoRoot":"/absolute/repo","anchors":[{"file":"src/main/java/demo/OrderService.java","line":42,"column":18}],"semanticPolicy":"auto"}}
```

排查 runtime、watcher roots、JDK candidates、raw LSP URI/range 或完整 diagnostics 时显式打开诊断字段：

```json
{"tool":"java_status","arguments":{"repoRoot":"/absolute/repo","start":false,"detail":"diagnostic"}}
```

默认不要在每次查询后调用 `java_runtime(action=shutdown)`；让 idle TTL 回收 JDT LS，才能复用 workspace import、JDT LS 内存索引和 JavaIndex snapshot。

需要强语义结果时：

```json
{"tool":"java_symbol","arguments":{"repoRoot":"/absolute/repo","query":"OrderService"}}
```

## 配置

`projects.json` 示例：

```json
{
  "aliases": [
    {
      "id": "my-java-app",
      "root": "/absolute/path/to/my-java-app",
      "lspEnabled": true,
      "layoutProfile": "maven-reactor"
    }
  ],
  "defaults": {}
}
```

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `CODEX_JAVA_LSP_RUNTIME_DIR` | 覆盖用户级 runtime 目录。 |
| `JAVA_LSP_PROJECTS_JSON` | 覆盖 `projects.json` 路径。 |
| `JDTLS_BIN` | 指定 `jdtls` 可执行文件。 |
| `JDTLS_JAVA_HOME` | 指定运行 JDT LS 的 Java home。 |
| `JDTLS_EXTRA_ARGS` | 追加传给 `jdtls` launcher 的参数，例如额外 `--jvm-arg=`。 |
| `JAVA_LSP_PROJECT_JAVA_HOME` | 指定默认项目 JDK。 |
| `JAVA_LSP_PROJECT_JAVA_HOME_<ALIAS>` | 为某个 alias 指定项目 JDK，alias 会转成大写并把非字母数字替换成 `_`。 |
| `JAVA_LSP_JDTLS_XMX` | 覆盖 JDT LS heap，例如 `2g`。 |
| `JAVA_LSP_MAX_ACTIVE_REPOS` | 限制同时活跃的 JDT LS repo 数。 |
| `JAVA_LSP_IDLE_TTL_MS` | repo 空闲后自动停止 JDT LS 的时间。 |
| `JAVA_LSP_WORKTREE_CACHE_TTL_DAYS` | 自动删除超过指定天数未更新的 Git worktree cache；默认 `2`，设为 `0` 关闭。 |
| `JAVA_LSP_AUTOBUILD` | 设为 `on` 时启用 JDT LS auto build；默认关闭以降低 import 等待。 |
| `JAVA_LSP_IMPORT_CONCURRENCY` | 透传给 JDT LS `java.maxConcurrentBuilds`。 |
| `JAVA_LSP_RG_CONCURRENCY` | `java_impact` 内部 rg section 并行度。 |
| `JAVA_LSP_RG_CACHE_TTL_MS` | complete-only rg cache TTL；generation 变化仍会立即失效。 |
| `JAVA_LSP_DOCUMENT_SYMBOL_TIMEOUT_MS` | documentSymbol warm-index 等待预算。 |
| `JAVA_LSP_DOCUMENT_SYMBOL_GLOBAL_CONCURRENCY` | documentSymbol 全局并发。 |
| `JAVA_LSP_DOCUMENT_SYMBOL_PER_REPO_CONCURRENCY` | documentSymbol 单 repo 并发。 |
| `JAVA_LSP_LOMBOK_JAR` | 指定 Lombok javaagent。 |

32GB 内存机器的默认资源策略通常是：

- `JAVA_LSP_MAX_ACTIVE_REPOS=3`
- `JAVA_LSP_JDTLS_XMX=2g`
- `JAVA_LSP_IDLE_TTL_MS=2700000`
- `JAVA_LSP_WORKTREE_CACHE_TTL_DAYS=2`
- `JAVA_LSP_IMPORT_CONCURRENCY=2`
- `JAVA_LSP_RG_CONCURRENCY=4`
- `JAVA_LSP_DOCUMENT_SYMBOL_GLOBAL_CONCURRENCY=2`
- `JAVA_LSP_DOCUMENT_SYMBOL_PER_REPO_CONCURRENCY=1`
- `JAVA_LSP_DOCUMENT_SYMBOL_TIMEOUT_MS=2000`

## 开发与验证

本地开发：

```bash
npm ci
npm run build
npm test
```

MCP readiness：

```bash
./check-codex-mcp.sh --fast
```

fast-path smoke：

```bash
./check-codex-mcp.sh --smoke --repo-root /absolute/path/to/java-repo
```

要求真实启动 LSP 的 smoke：

```bash
./check-codex-mcp.sh --smoke --repo-root /absolute/path/to/java-repo --require-lsp
```

benchmark 入口：

```bash
npm run benchmark:agent-impact -- --repo-root /absolute/path/to/java-repo --project-id <id> --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic
npm run benchmark:impact-attribution -- --repo-root /absolute/path/to/java-repo --project-id <id>
npm run benchmark:three-repo-matrix -- --baseline <approved-baseline-sha> --lishuedu <repo-root> --cipherlink <repo-root> --exam-parent-v3 <repo-root>
npm run test:three-repo-matrix
npm run test:determinism
npm run test:task36-mutation
npm run test:task36-fault
npm run test:task36-multiprocess
```

Task36 机器可读产物入口：

```bash
npm run benchmark:task36-mutation -- --output artifacts/v3-final/task36-mutation.json
node scripts/task36-fault-suite.mjs --output artifacts/v3-final/task36-fault.json
npm run smoke:task36-multiprocess > artifacts/v3-final/task36-multiprocess.json
npm run benchmark:verify-determinism -- --input artifacts/v3-final/<repo>-determinism-20.json --expected-runs 20
```

当前 benchmark 口径：

- hard gate 包括每仓 `R_read_must=1.0000`、task-blocking/recall/P_read 不低于冻结基线、standard estimated tokens 不增加，以及有绝对 slack 的 cold P95 上限。
- `goldenAttribution[]` 用于判断缺口是 `absent`、`readplan-full` 还是已命中 `readPlan`。
- `timing.phaseMs/sessionPhaseMs` 用于 warm 延迟归因；`warm-required` 的首触成本仍不足以支持默认化，因此保持 `KEEP_EXPLICIT`。
- 三仓 paired gate 使用 [`docs/three-repo-cold-matrix-runbook.md`](docs/three-repo-cold-matrix-runbook.md)：old/new 必须共享冻结的 `--scenarios` 文件，固定 AB/BA/AB、3 轮 × 每格 5 runs，且由脚本逐仓判定 quality/P95 硬门。

最新验证报告：

- `docs/java-lsp-mcp-benchmark-guide-2026-06-23.md`
- `docs/java-lsp-mcp-readplan-semantic-gap-report-2026-06-26.md`
- `docs/java-lsp-mcp-warm-latency-report-2026-06-27.md`
- `docs/java-lsp-mcp-warm-instrumentation-report-2026-06-29.md`
- `docs/java-lsp-mcp-warm-optimization-test-report-2026-06-29.md`

## 故障排查

- `codex-java-lsp currently supports macOS only`：当前平台不是 macOS，回退到 `rg`、build、日志证据。
- `jdtls not found`：执行 `brew install jdtls`，或设置 `JDTLS_BIN`。
- `Missing dist/server.js`：先运行 `npm run build`，用户级 runtime 则重新执行 `./install-runtime.sh`。
- `Project root is not LSP-enabled`：用 `register-alias.sh --enable-lsp <id> <absolute-root>` 显式启用。
- `Multiple enabled aliases share this Git common-dir`：为当前 worktree 单独注册绝对路径，消除 family 继承歧义。
- `No idle Java LSP runtime available`：降低并发、关闭空闲 repo，或调整 `JAVA_LSP_MAX_ACTIVE_REPOS`。

## 安全说明

- MCP tools 不会写入目标 Java repo。
- JDT LS 可能读取项目配置并执行语言服务器需要的导入流程；不要对不可信 repo 启用 LSP。
- 不要在公开 issue 中粘贴私有路径、源码片段、日志中的 token 或企业内部包名。
- 发现安全问题时，优先通过 GitHub Security Advisory 或私有渠道报告；不要先公开 PoC。

## 贡献规范

- 保持改动小而可审阅；不要为单次需求提前抽象。
- 不要扩大 5 个 public tools 的工具面，除非 issue 或设计说明给出明确需求。
- 优先补定向测试：repo 解析、worktree 继承、资源限制、JDK 解析、JavaIndex coverage/freshness、tool handler 行为。
- 提交前至少运行：

```bash
npm run build
npm test
```

- 贡献代码默认按 Apache License 2.0 授权，除非贡献者在提交中明确说明更严格且兼容的授权边界。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。

使用、复制、修改、分发本项目时需要遵守 Apache-2.0 的核心约束：

- 保留版权声明、许可证文本和已有 NOTICE 内容。
- 修改过的文件应按许可证要求保留显著的变更说明。
- Apache-2.0 包含专利授权和专利诉讼终止条款。
- Apache-2.0 不授予项目名称、商标、服务标识或产品名的使用权。
- 本项目按 “AS IS” 提供，不提供明示或默示担保。
- 第三方依赖保留其各自许可证；分发时需要同时满足第三方许可证要求。

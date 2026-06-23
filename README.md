# codex-java-lsp-mcp

![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-43853c.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

`codex-java-lsp-mcp` 是一个用户级、Java-only 的 Codex MCP server。它给 Codex 提供低 token 的 Java 语义导航能力：先用源码索引和内部 `rg` 收敛影响面，再按需启动有界 JDT LS 做语义增强。

它不是完整 IDE，也不是通用多项目平台。项目边界以 canonical `repoRoot` 和 `repoHash` 为准，`projectId` 只作为 alias/display name。

## 目录

- [核心能力](#核心能力)
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
- 提供 7 个 public tools：`java_status`、`java_impact`、`java_symbol`、`java_references`、`java_diagnostics`、`java_restart`、`java_shutdown`。
- 默认推荐入口是 `java_impact`，用于生成影响面、候选文件、`readPlan`、证据缺口和指标。
- 未启用 LSP 的 Java repo 仍可走 fast path：repo/root/layout/JDK/generated-code 探测、SourceIndex、内部 `rg` 摘要。
- 启用 LSP 后，JDT LS 可为 symbol、references、diagnostics 和 documentSymbol warm-index 提供增强结果。
- 支持 Git worktree family 继承 LSP enablement，但每个 worktree 仍独立使用自己的 `repoRoot`、`repoHash`、workspace、日志和 SourceIndex。

## 设计边界

- public MCP surface 保持 7 个工具；除非有明确需求，不扩展工具面。
- 所有工具都不修改目标 Java repo；`java_restart` 和 `java_shutdown` 只影响本 MCP 管理的 JDT LS 进程。
- JDT LS 启动必须显式启用：`lspEnabled=true`，或命中同一 Git `common-dir` 的 worktree family 继承。
- SourceIndex 是冷启动事实来源；JDT LS 是可选增强，不是路由正确性的唯一来源。
- JDT LS runtime JDK 与项目 JDK 分开处理，避免把语言服务器运行环境误当成项目编译环境。
- resource 默认值按本机内存保守计算；多 repo 并行时优先保住可用性，而不是抢占更多 JDT LS。

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
- 当前 worktree 仍使用自己的 canonical `repoRoot`、`repoHash`、JDT LS workspace、日志和 SourceIndex。
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
- 只追加短提示，不启动 JDT LS，不阻断 shell/`rg`。

## Public MCP Tools

| Tool | 用途 | 是否要求 LSP |
| --- | --- | --- |
| `java_status` | 查看 server、repo、JDT LS、watcher、SourceIndex、resource 状态；`start=true` 时尝试启动 JDT LS。 | 否；启动时需要启用 |
| `java_impact` | 推荐入口。生成 Java 影响面、候选文件、内部 `rg` 摘要、可读计划、证据缺口和指标。 | `semanticPolicy=fast` 不要求；`required` 要求 |
| `java_symbol` | 按 query 搜索 workspace symbols，或按 file/line/column 查 hover、definition、implementation。 | 是 |
| `java_references` | 对精确 Java 符号位置返回 summary-only references。 | 是 |
| `java_diagnostics` | 打开 Java 文件并等待短时间返回 JDT LS diagnostics。 | 是 |
| `java_restart` | 重启当前 repo 的 JDT LS session；只有显式参数才清 cache。 | 是 |
| `java_shutdown` | 停止当前或全部 JDT LS 子进程，MCP server 保持存活。 | 否 |

推荐默认调用顺序：

```json
{"tool":"java_status","arguments":{"repoRoot":"/absolute/repo","start":true}}
{"tool":"java_impact","arguments":{"repoRoot":"/absolute/repo","anchors":[{"file":"src/main/java/demo/OrderService.java","line":42,"column":18}],"semanticPolicy":"auto"}}
```

默认不要在每次查询后调用 `java_shutdown`；让 idle TTL 回收 JDT LS，才能复用 workspace import、JDT LS 内存索引和 SourceIndex 缓存。

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
| `JAVA_LSP_DOCUMENT_SYMBOL_TIMEOUT_MS` | documentSymbol warm-index 等待预算。 |
| `JAVA_LSP_DOCUMENT_SYMBOL_GLOBAL_CONCURRENCY` | documentSymbol 全局并发。 |
| `JAVA_LSP_DOCUMENT_SYMBOL_PER_REPO_CONCURRENCY` | documentSymbol 单 repo 并发。 |
| `JAVA_LSP_LOMBOK_JAR` | 指定 Lombok javaagent。 |
| `JDTLS_FILEWATCH` | 设为 `off` 可关闭 JDT LS 文件监听。 |

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
npm run benchmark:agent-impact
```

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
- 不要扩大 7 个 public tools 的工具面，除非 issue 或设计说明给出明确需求。
- 优先补定向测试：repo 解析、worktree 继承、资源限制、JDK 解析、SourceIndex、tool handler 行为。
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

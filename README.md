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
- stdio 与共享 HTTP daemon 共用 canonical-root ownership；同一个 worktree 同一时刻只允许一个进程持有 JDT workspace、JavaIndex 和 cache。

## 五层架构

1. **Repo identity 与 freshness**：`repo-resolver`、`RepoChangeCoordinator` 和单调 generation 统一处理 canonical containment、edit/add/delete/rename/build/resource 事件、storm 降级和 worktree identity。
2. **JavaIndex 静态事实层**：Tree-sitter Java AST、FQN/import 解析、静态关系、MyBatis resource facts、按 source root 的 coverage，以及 versioned atomic snapshot。后台 sweep 分块且受跨进程 lease 限制，前台 refresh 不等待整仓 sweep。
3. **JDT 精确语义层**：`JdtlsSession`、`SemanticGateway`、跨进程 JDT slot、restart backoff、complete-only bounded cache 和 64-entry `DocumentLru`。同键 semantic operation 只执行一次 backend work，每个 caller 独立消费自己的 deadline。
4. **Evidence、ranking 与 readPlan**：providers 只产生 typed evidence；family ranker 对同族证据饱和；Spring、MyBatis、MapStruct pack 只在有证据时参与；planner 一次批量读取精确 ranges，并同时约束文件、字节和估算 token。
5. **MCP surface 与 observability**：5 个工具提供 compact/standard/diagnostic 输出；`java_status` 汇总 runtime、watcher、JavaIndex coverage、generation、lease 和缓存状态，不把绝对私有路径泄漏到标准结果。stdio 与 HTTP daemon 共用同一套 `JavaLspApplication`。

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
- MCP stdio 对端实际结束或关闭时，服务会释放全部 runtime 并退出；保持打开的空闲 stdio 连接不会让服务自行退出。
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
# 仅在未被在线 runtime 使用的 checkout（或独立 clone）中安装依赖
npm ci
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile compile
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile full
./install-runtime.sh
./check-codex-mcp.sh --fast
```

上面的 `check-codex-mcp.sh` 是安装后的在线运维检查，会访问刚安装的服务。`npm ci`
会重建当前 checkout 的 `node_modules`，只能在确认该 checkout 未被在线 runtime 使用时执行；
后续隔离构建与测试会把依赖复制到私有临时目录，不会让验证写回源依赖树。

默认 runtime 目录：

```text
~/Library/Application Support/codex-java-lsp-mcp
```

默认项目配置：

```text
~/.config/codex-java-lsp/projects.json
```

`install-runtime.sh` 会构建新的 immutable release、在固定 loopback 端口启动 LaunchAgent 管理的 HTTP daemon，并保留至少一个前序 release。**默认不改**当前 Codex MCP 注册，因此已启用的 stdio MCP 和已有 task 不会被安装步骤切换。

`npm test` 同样会自动创建并清理独立的 cache、ownership、projects、XDG 配置、`CODEX_HOME` 和 `HOME`；即使从携带运行态环境变量的 shell 调用，也不会读写当前 MCP/daemon 的运行目录或 Codex 配置。

### 受管 HTTP daemon 与显式切换

安装过程先在独立 canary 端口运行 `tools/list` / `java_status` smoke，再原子更新 `current` symlink，最后通过 `launchd` 在固定端口启动。candidate 与 release 内的 `npm test` 分别使用 installer 创建的临时 cache、ownership、projects、XDG 配置、`CODEX_HOME` 和 `HOME`；两者都不会读取或写入受管 daemon 的状态目录。它不会 `rsync --delete` 覆盖运行中的 release。

```bash
./install-runtime.sh

"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" status
"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" smoke
```

只有完成隔离 canary、真实 Codex CLI/Desktop task、crash recovery 和 worktree 并发验证后，才显式切换同名 MCP 到 HTTP URL。生产切换会校验一个不超过七天、且绑定本次 build SHA 与 daemon instance ID 的 release-gate 凭据：

```bash
./install-runtime.sh --activate-http /absolute/path/to/http-activation-attestation.json
```

凭据必须记录真实 CLI 和 Desktop 的 taskId、七个工具可用、正常 restart 与 `kill -9` recovery 后仍可调用、Desktop 跨过 idle 窗口后仍可调用、旧 stdio owner 已清退、以及 linked-worktree 隔离已确认；任何一项缺失，installer 保留已有 MCP registration。通过门禁后命令会先保存旧 stdio registration 的精确 rollback command；daemon health、build SHA、HTTP smoke 任一失败时不切换或恢复旧 registration。切换完成仍必须 Restart Codex/Desktop 后创建新 task，不能把已出现 `Transport closed` 的旧 task 当作已原地修复。

完整的隔离 CLI/Desktop canary、crash recovery、worktree 与回滚证据要求见 [shared HTTP daemon canary runbook](docs/shared-http-daemon-canary-runbook.md)。
CLI canary 的 MCP URL 应通过 `codex exec --ignore-user-config -c 'mcp_servers...={url="..."}'`
作单次进程覆盖；临时 `CODEX_HOME` 可验证注册形状，但不应复制真实认证或用户配置来运行任务。

可单独开发/隔离验证 HTTP host；务必使用临时 cache、ownership 和未占用端口，不能指向当前被 stdio 使用的真实 worktree：

```bash
JAVA_LSP_HTTP_PORT=38457 \
JAVA_LSP_CACHE_BASE=/absolute/isolated/cache \
JAVA_LSP_OWNERSHIP_BASE=/absolute/isolated/ownership \
npm run start:http

npm run smoke:http -- --url http://127.0.0.1:38457/mcp
```

HTTP 模式固定绑定 `127.0.0.1`，只提供严格的 `/mcp`、`/healthz`、`/readyz`（拒绝大小写、尾斜杠和 query 变体）。MCP transport 是 stateless：每个 POST 使用独立 protocol/transport，但所有请求共享一个 application/runtime manager。请求或 client 关闭不会关闭其他 worktree runtime；daemon SIGINT/SIGTERM 进入 drain，超时则终止已拥有的 JDT、保留 canonical-root lease，避免 stdio/HTTP 交接时并发写 workspace 或 SourceIndex。

浏览器请求如果携带 `Origin`，默认全部拒绝；确需允许时通过 `JAVA_LSP_HTTP_ALLOWED_ORIGINS` 配置精确的 loopback origin。不要把 bearer token、源码或完整 tool payload写入配置和日志。

受管布局：

```text
~/Library/Application Support/codex-java-lsp-mcp/
  releases/<build-id>/
  current -> releases/<build-id>
  state/
  run-daemon.sh
  daemonctl.sh
~/Library/LaunchAgents/com.lky.codex-java-lsp-mcp.plist
~/Library/Logs/codex-java-lsp-mcp/
```

release rollback 使用 `daemonctl.sh rollback-release`。它会先验证前一 release 的 `daemon.env`、LaunchAgent、稳定入口、daemon identity 与 predecessor pointer 均完整，随后确认 `bootout` 已真正卸载 LaunchAgent、等待 PID 退出，再原子恢复前一 release 与其配置；任一验证/卸载失败都 fail-closed，且不会停止当前 daemon。若已经切到 HTTP 而需恢复 stdio，使用 `daemonctl.sh rollback-stdio`：它同样会先确认 HTTP LaunchAgent 已卸载和 PID 已退出，再恢复已保存的 stdio MCP registration；随后手动 Restart Codex/Desktop。若 stdio registration 恢复命令本身失败，controller 会立即恢复保存的 HTTP URL、重新启动并 smoke managed daemon，之后以失败状态退出，避免留下“HTTP 已停且 MCP 缺失”的半切换状态。不要让 stdio 与 HTTP 同时针对同一个 canonical root 做 semantic 调用。

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
| `java_runtime` | `action=restart` 重启当前 repo 的 JDT LS session（默认返回动作摘要，只有显式参数才清 cache）；`action=shutdown` 停止当前或全部（`all=true`）JDT LS 子进程，MCP server 保持存活。HTTP daemon 固定拒绝 `all=true`。 | restart 是；shutdown 否 |

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
| `JDTLS_EXTRA_ARGS` | 追加传给在线 `jdtls` launcher 的参数，例如额外 `--jvm-arg=`；隔离 benchmark 会丢弃调用者提供的值，禁止用第二个 `-data` 覆盖私有 workspace。 |
| `JAVA_LSP_CACHE_BASE` | 覆盖统一 cache base；每个 canonical repo 始终追加独立 repoHash。 |
| `JAVA_LSP_PROJECT_JAVA_HOME` | 指定默认项目 JDK。 |
| `JAVA_LSP_PROJECT_JAVA_HOME_<ALIAS>` | 为某个 alias 指定项目 JDK，alias 会转成大写并把非字母数字替换成 `_`。 |
| `JAVA_LSP_JDTLS_XMX` | 覆盖 JDT LS heap，例如 `2g`。 |
| `JAVA_LSP_MAX_ACTIVE_REPOS` | 限制同时活跃的 JDT LS repo 数。 |
| `JAVA_LSP_IDLE_TTL_MS` | repo 空闲后自动停止 JDT LS 的时间。 |
| `JAVA_LSP_RUNTIME_ENTRY_TTL_MS` | JDT 已停止后，空闲 runtime context 在内存中的保留时间；默认 `3600000`。 |
| `JAVA_LSP_MAX_RUNTIME_ENTRIES` | Node 进程最多保留的 repo runtime context 数；默认 `16`，超限时按 LRU 驱逐不活跃 entry。 |
| `JAVA_LSP_OWNERSHIP_BASE` | 覆盖 canonical-root 跨进程 ownership 目录；主要用于隔离 canary/测试，生产默认位于用户 cache。 |
| `JAVA_LSP_CACHE_JANITOR_INTERVAL_MS` | cache janitor 周期；默认 `21600000`（6 小时），设为 `0` 关闭周期执行。L0 格式回收在 TTL=0 时仍会跑。 |
| `JAVA_LSP_WORKTREE_CACHE_TTL_DAYS` | 非 pin 目录按 `lastRequestAt` 过期删除的天数；默认 `2`。`0` 关闭 TTL 删除，仍做死路径 / L0 / L2。`projects.json` 里 `lspEnabled` 的 root 永不因 TTL 删除。 |
| `JAVA_LSP_CACHE_UNPINNED_MAX_DIRS` | 非 pin hash 目录数硬顶，默认 `48`；`0` 关闭。超出按 `lastRequestAt` LRU 驱逐。 |
| `JAVA_LSP_CACHE_UNPINNED_MAX_BYTES` | 非 pin 目录合计体积硬顶，默认 `6 GiB`；`0` 关闭。 |
| `JAVA_LSP_HTTP_PORT` | HTTP daemon 固定 loopback 监听端口；HTTP entrypoint 必填。 |
| `JAVA_LSP_HTTP_INSTANCE_ID` | installer 为每个 managed release 自动生成的 health identity；不要手工复用或配置，doctor/start/smoke 会用它拒绝端口遗留进程。 |
| `JAVA_LSP_HTTP_CANARY_PORT` | installer candidate 的独立 loopback 端口；必须不同于固定端口，默认 `38457`。 |
| `JAVA_LSP_HTTP_ALLOWED_ORIGINS` | 逗号分隔的精确 loopback HTTP origins；未配置时只允许不带 Origin 的原生 MCP client。 |
| `CODEX_JAVA_LSP_RUNTIME_DIR` | immutable release、`current` symlink 与 daemon state 的根目录。 |
| `CODEX_JAVA_LSP_LAUNCH_AGENTS_DIR` | LaunchAgent plist 的目录；默认 `~/Library/LaunchAgents`，主要用于隔离验证。 |
| `CODEX_JAVA_LSP_LOG_DIR` | daemon stdout/stderr 日志目录；默认 `~/Library/Logs/codex-java-lsp-mcp`。 |
| `JAVA_LSP_AUTOBUILD` | 设为 `on` 时启用 JDT LS auto build；默认关闭以降低 import 等待。 |
| `JAVA_LSP_IMPORT_CONCURRENCY` | 透传给 JDT LS `java.maxConcurrentBuilds`。 |
| `JAVA_LSP_RG_CONCURRENCY` | `java_impact` 内部 rg section 并行度。 |
| `JAVA_LSP_RG_CACHE_TTL_MS` | complete-only rg cache TTL；generation 变化仍会立即失效。 |
| `JAVA_LSP_DOCUMENT_SYMBOL_ATTEMPT_TIMEOUT_MS` | 单次 documentSymbol 尝试预算；默认 `10000`。 |
| `JAVA_LSP_LOMBOK_JAR` | 指定 Lombok javaagent。 |

`streamable_http` 模式拒绝 `JDTLS_DATA_DIR` / `JDTLS_LOG_DIR` 单例目录覆盖；stdio 兼容模式仅把它们视为 base，并强制追加 canonical repoHash。

生产 cache 不要 `rm -rf ~/Library/Caches/codex-java-lsp`。一次性收割（默认 dry-run）：

```bash
npm run cache:harvest
npm run cache:harvest -- --apply
```

32GB 内存机器的默认资源策略通常是：

- `JAVA_LSP_MAX_ACTIVE_REPOS=3`
- `JAVA_LSP_JDTLS_XMX=2g`
- `JAVA_LSP_IDLE_TTL_MS=2700000`
- `JAVA_LSP_RUNTIME_ENTRY_TTL_MS=3600000`
- `JAVA_LSP_MAX_RUNTIME_ENTRIES=16`
- `JAVA_LSP_WORKTREE_CACHE_TTL_DAYS=2`
- `JAVA_LSP_CACHE_UNPINNED_MAX_DIRS=48`
- `JAVA_LSP_CACHE_UNPINNED_MAX_BYTES=6442450944`
- `JAVA_LSP_IMPORT_CONCURRENCY=2`
- `JAVA_LSP_RG_CONCURRENCY=4`
- `JAVA_LSP_DOCUMENT_SYMBOL_ATTEMPT_TIMEOUT_MS=10000`

## 开发与验证

> **隔离硬门禁**：在线 MCP/LSP 正在运行时，禁止在本 checkout 执行
> `npm run build`、`npm run clean` 或裸 `node dist/<benchmark-or-smoke>.js`。
> 当前 `dist/` 可能正被在线服务使用。开发验证必须通过隔离脚本，在临时 detached
> code local clone、私有 HOME/XDG/TMP/cache/JDT workspace 中重新编译和运行；真实 JDT
> 还必须使用目标 Java 仓库的 detached local clone。`check-codex-mcp.sh` 是在线服务运维检查，
> 不属于隔离开发验证，执行前会接触当前服务。严格验证必须从
> `scripts/run-isolated-node.sh` 启动；它会在 Node 解释器加载前清除宿主 loader、coverage、
> compile-cache 和 warning-output 变量。`npm run ...` 仅是可信开发环境下的快捷入口，
> 不能作为在线 runtime 并存时的正式证据。

在线服务运行期间的本地开发验证：

```bash
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile compile
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile full
```

依赖缺失或需要执行 `npm ci` 时，先创建不被在线 runtime 使用的独立 clone；只有在确认
当前 checkout 未被在线 runtime 使用时，才执行 `npm ci`、生产构建 `npm run build` 或清理命令。

MCP readiness：

```bash
./check-codex-mcp.sh --fast
```

HTTP 注册后的 smoke 只连接已运行的 LaunchAgent daemon，不会启动第二个 server：

```bash
./check-codex-mcp.sh --smoke --repo-root /absolute/path/to/java-repo
```

要求真实启动 LSP 的 smoke：

```bash
./check-codex-mcp.sh --smoke --repo-root /absolute/path/to/java-repo --require-lsp
```

需要验证 rollback stdio release 时显式使用：

```bash
./check-codex-mcp.sh --stdio-smoke --repo-root /absolute/path/to/java-repo
```

benchmark 入口：

```bash
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node scripts/run-isolated-jdt-benchmark.mjs --repo-root /source/java-repo --revision <exact-sha> -- node dist/benchmark-agent-impact.js --repo-root {repo} --project-id <id> --warm-state cold-nolsp --strategy impact --runs 5 --verbosity diagnostic
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node scripts/run-isolated-jdt-benchmark.mjs --repo-root /source/java-repo --revision <exact-sha> -- node scripts/attribute-impact-payload.mjs --repo-root {repo} --project-id <id>
sh scripts/run-isolated-node.sh scripts/run-three-repo-cold-matrix.mjs --baseline <approved-baseline-sha> --output-dir /tmp/java-v32-matrix-<id> --lishuedu <repo-root> --cipherlink <repo-root> --exam-parent-v3 <repo-root>
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test scripts/run-three-repo-cold-matrix.test.mjs scripts/verify-three-repo-cold-matrix.test.mjs
```

`warm-auto`、`warm-required`、semantic first-touch 等会启动真实 JDT 的基准，必须把
目标 Java 仓库和精确 revision 交给双层隔离 harness；不得把当前在线项目目录直接作为
JDT workspace：

```bash
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- \
  node scripts/run-isolated-jdt-benchmark.mjs \
  --repo-root /path/to/source-java-repo --revision <exact-sha> -- \
  node dist/benchmark/semantic-first-touch.js --repo-root {repo} <other-args>
```

Task36 机器可读产物入口：

```bash
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --keep --profile targeted -- \
  node dist/benchmark/task36-mutation-matrix.js --output '{state}/task36-mutation.json'
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test scripts/task36-fault-suite.test.mjs
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node --test scripts/task36-multiprocess-smoke.test.mjs
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile targeted -- node dist/benchmark/verify-determinism.js --input /tmp/<repo>-determinism-20.json --expected-runs 20
```

需要保留输出的 Task36 命令必须使用 `--keep` 与 `{state}`；以 wrapper 最后打印的
`preserved isolated validation root` 作为产物根。不要把 `--output` 指向当前 checkout、在线 cache
或正在使用的 Java 仓库。

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
- `Missing dist/server.js`：若该 checkout 没有被在线服务使用，可运行 `npm run build`；
  在线服务场景只运行 `npm run build:isolated` 做源码验证，用户级 runtime 通过
  `./install-runtime.sh` 在目标 runtime 目录重新安装。
- `HTTP daemon down`：运行 `daemonctl.sh status` 检查 LaunchAgent、固定端口与 daemon stderr log；不要直接再起一个随机端口的生产 daemon。
- `HTTP daemon build SHA differs from current release`：停止 daemon 后执行 `daemonctl.sh restart`；若仍失败执行 `daemonctl.sh rollback-release`。
- 需要回到 stdio：先执行 `daemonctl.sh rollback-stdio`，确认 HTTP PID 已退出后 Restart Codex/Desktop；如果命令报错，先检查它是否已经恢复 HTTP URL 和 daemon health，再排查 stdio registration；不要通过两个 MCP transport 并行兜底。
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
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile compile
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile full
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

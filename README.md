# codex-java-lsp-mcp

![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-43853c.svg)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

`codex-java-lsp-mcp` 是面向 coding agent 的 Java-only 本地代码智能服务：Tree-sitter 增量事实 + 有界 JDT 精确语义 + 面向任务、受 token 预算约束的 `readPlan`。

它不是完整 IDE，也不是通用语言平台。项目边界以 canonical `repoRoot` 和 `repoHash` 为准，`projectId` 只作为 alias/display name；所有请求都受绝对 deadline、仓库边界和完整性状态约束。

当前开发主线是 ILV2 单 owner 与不可变 workspace snapshot。固定签名 native launcher 持有 canonical cache root 的 fd4 锁后直接 exec 冻结 Node；stdio 只转发到同一 owner。2026-10-11 的生产发布记录是历史证据，不代表当前生产状态或安装授权。本轮仅交付 MAC-16 收尾、MAC-17 候选与隔离 `:38457` canary，不 push、不动生产。操作边界见 [生产操作](docs/phase-f/production-operations.md)，门状态见 `docs/index-lifecycle-v2/mac/status.json`。

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
- [Java Specialist Devkit v1（M0–M3）](#java-specialist-devkit-v1m0m3)
- [故障排查](#故障排查)
- [安全说明](#安全说明)
- [贡献规范](#贡献规范)
- [许可证](#许可证)

## 核心能力

- 注册一个 Codex MCP server：`codex-java-lsp`。
- 提供 5 个 public tools：`java_status`、`java_impact`、`java_symbol`（operation=query\|position\|references，另有显式实验 operation=evidence）、`java_diagnostics`、`java_runtime`（action=restart\|shutdown）。
- 默认推荐入口是 `java_impact`，用于生成影响面、候选文件、`readPlan`、证据缺口和指标。
- 未启用 LSP 的 Java repo 仍可走 fast path：repo/layout/JDK 探测、Tree-sitter JavaIndex、增量 watcher 和有界 streaming `rg`。
- 启用 LSP 后，JDT LS 为 symbol、references、hierarchy、diagnostics 和精确位置语义提供增强结果；同键请求由 SemanticGateway singleflight 合并。
- Git worktree family 可继承 LSP enablement；ILV2 通过封存 snapshot 与 workspace binding 复用静态事实。各 worktree 的视图、JDT workspace 和日志隔离。
- `ImpactResultV6` 显式暴露 freshness/completeness、证据来源、任务导向的候选顺序和文件/范围级 `readPlan`。
- 一个 canonical cache root 只有一个 owner；stdio 只转发 MCP transport。builder、query、publisher 和 snapshot GC 由 owner 管理。

## 五层架构

1. **Repo identity 与 freshness**：canonical root 与设备/inode 标识 workspace；native FSEvents tracker 跟踪变更与 watermark，owner 发布经校验的 workspace binding。
2. **JavaIndex 静态事实层**：Tree-sitter Java AST、静态关系和 MyBatis facts 保存在封存的 SQLite snapshot；builder 写私有候选，发布后不修改，请求持有具体 snapshot lease。
3. **JDT 精确语义层**：`JdtlsSession`、`SemanticGateway`、跨进程 JDT slot、restart backoff、complete-only bounded cache 和 64-entry `DocumentLru`。同键 semantic operation 只执行一次 backend work，每个 caller 独立消费自己的 deadline。
4. **Evidence、ranking 与 readPlan**：providers 只产生 typed evidence；family ranker 对同族证据饱和；Spring、MyBatis、MapStruct pack 只在有证据时参与；planner 一次批量读取精确 ranges，并同时约束文件、字节和估算 token。
5. **MCP surface 与 observability**：5 个工具提供 compact/standard/diagnostic 输出；`java_status` 汇总 runtime、JavaIndex coverage/`db`/`builder`、generation、lease 和 JDT 状态，不把绝对私有路径泄漏到标准结果。HTTP owner 持有 application/runtime；stdio 转发请求。索引路径没有 hibernate/recycle。

### cold、auto、required

- `semanticPolicy=fast`：不发起 live JDT semantic request；使用 JavaIndex、静态/框架证据和 streaming `rg`。LSP 未启用时强制采用该策略。
- `semanticPolicy=auto`：`java_impact` 默认值。只对当前策略允许的 service-profile anchor 在剩余 request budget 内使用 JDT；JDT 已 READY 本身不构成自动执行理由。
- `semanticPolicy=required`：显式要求 live JDT 语义；LSP 未启用时立即返回配置错误，启动、slot 等待和请求本身仍必须服从同一个绝对 deadline。
- benchmark 的 `cold-nolsp`、`warm-auto`、`warm-required` 分别固定上述三种验收状态。Phase 5 决策为 `KEEP_EXPLICIT`：`required` 保持显式选择，不改成默认。

### Cache、freshness 与 completeness

- ILV2 使用独立 `mac1/` snapshot/binding 布局，不迁入旧 v9/v10/legacy 索引，不支持双格式启动。
- 每个 normalized repo batch 只推进一次 generation，并同时驱动 AgentRouter、JDT document/cache 同步和 JavaIndex refresh。请求结果记录 `requestGeneration`、`indexedGeneration` 与 `changedDuringRequest`。
- source root 只有在同 generation、无 failed/recovered/pending 条目且 coverage=`COMPLETE` 时才能回答负查询；其余状态返回未知或降级结果，不能把缺失当成不存在。
- SemanticGateway 只缓存 `COMPLETE`，有 TTL、容量上限和 generation 失效；partial/timeout/cancelled 结果不会写成 complete cache。

## 设计边界

- public MCP surface 保持 5 个工具；除非有明确需求（测过 `tools/list` token 成本或有真实误选证据），不扩展或再拆分工具面。
- 所有工具都不修改目标 Java repo；`java_runtime`（action=restart\|shutdown）只影响本 MCP 管理的 JDT LS 进程。
- stdio relay 关闭只结束该 transport，不关闭共享 HTTP owner。
- JDT LS 启动必须显式启用：`lspEnabled=true`，或命中同一 Git `common-dir` 的 worktree family 继承。
- JavaIndex 是冷启动事实来源；JDT LS 是可选精确增强，不是路由正确性的唯一来源。
- JDT LS 的 `READY` 要等待当前连接的初始工程导入完成通知；`initialize` 返回和进度静默均不代表就绪。冷态 `java_symbol` 精确查询会报告 `JDT_NOT_READY`，可用 `java_status(start=false)` 等待 `READY` 后重试；导入在后台继续，按需启动保持不变。初始导入完成不保证后续全部 build/index 或注解处理成功。
- JDT LS 的 Gradle 导入使用 `-Dorg.gradle.parallel=false`，覆盖导入和 APT tooling model；保留注解处理与 Lombok agent。普通命令行构建仍使用业务仓库的并行设置。
- JDT LS 的 Gradle 导入不预下载外部依赖的源码附件。受管 init 脚本位于 JDT workspace，不预填私有 Gradle home；项目源码目录和二进制 classpath 保留。外部依赖源码跳转没有预下载附件。
- 共享 JDT 启动分两段计时：初始工程导入受 `JDTLS_START_TIMEOUT_MS`（默认 120 秒）限制，导入完成后等待只读搜索索引屏障另有 `JDTLS_INDEX_TIMEOUT_MS`（默认 600 秒，`07c6ccf` 起）。导入达到上限时，返回 `JDT_SERVER_ERROR` 并进入现有退避期；`java_status` 的 `restartBackoff.lastErrorMessage` 保留阶段与原因。调用方请求超时仍独立于共享启动。
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

开发验证使用冻结的 `ILV2_NODE_BIN` 和 `ILV2_RUNTIME_MANIFEST`，在已登记的隔离运行根执行：

```bash
sh scripts/run-isolated-node.sh scripts/run-isolated-validation.mjs --profile compile
```

### MAC-17 安装合同

最新[索引就绪修复与单次真实验收](docs/index-lifecycle-v2/mac/mac-17/index-ready-fix-acceptance.md)通过：启动事务在原 120 秒预算内等待只读索引屏障，再提交 READY（历史验收口径；`07c6ccf` 起索引屏障改为导入后独立的 600 秒预算，见上文设计边界）。17 项定向检查和唯一真实语义验收通过。客户端 106.150 秒 READY，首次引用 430.448 ms。历史正式 G17 FAIL 保留，候选供本地审查，尚未部署。

此前隔离失败见 [安装期恢复与准备后语义验收](docs/index-lifecycle-v2/mac/mac-17/install-prepared-acceptance.md)。依赖恢复通过。JDT 在原 120 秒内 READY。精确定义通过，首次引用超时，完整验收仍失败。

隔离安装增加 `--prepare-gradle <plan>`。该计划绑定同一私有 repo、HOME、Gradle home 和冻结工具链。恢复 Eclipse 与 APT 模型后，Gradle 先退出，再固定依赖清单。真实 JDT 验收使用准备后的缓存。该入口要求隔离标记和注册运行根，不切换服务。

本轮不执行生产安装。安装器支持 `--port`、`--canary-port`、`--preflight-runtime`，要求冻结 Node/runtime manifest 和 `ILV2_CODESIGN_IDENTITY` 稳定签名，不修改 Codex MCP registration。隔离构建还需显式 `ILV2_CODESIGN_KEYCHAIN`；仅 codesign 签名子进程使用账户 HOME 查找该身份，其他构建与运行进程保持隔离。

首次 ILV2 安装必须显式设置 `CODEX_JAVA_LSP_RUNTIME_DIR` 为新的 runtime 目录。脚本默认仍为历史 runtime 路径；已有 daemon.env/current 却没有 verified launcher bundle 时，在停服前拒绝。旧生产 runtime、cache 和 state 保留。未来生产切换须另行批准具体 SHA/digest、固定 launcher 路径、label、端口和停用步骤。

```text
<new-ilv2-runtime>/
  launcher/
    package.json
    bundle-artifacts.json
    dist/native/{ilv2-mac,manifest.json}
    dist/mac-platform/{owner-lock-guard,owner-lock,clonefile,native-protocol,native-exec}.js
  releases/<build-id>/
  current -> releases/<build-id>
  state/{daemon.env,previous-current,rollback-<build-id>/,jdt-gradle-home/}
  run-daemon.sh
  run.sh
  daemonctl.sh
```

launchd Program 直接指向固定 `launcher/dist/native/ilv2-mac`；HTTP entry 指向具体 immutable release。完整 bundle 校验文件集合、权限、hash、native/runtime 身份及实际稳定签名。升级保持 launcher 绝对路径与签名身份。plist 使用 `RunAtLoad=true`、`KeepAlive={SuccessfulExit=false}`、`ThrottleInterval=1`、`AbandonProcessGroup=false`；native owner 最多等待锁 5 秒，锁忙以非零状态退出。

默认新缓存是 `~/Library/Caches/codex-java-lsp-ilv2`。service-state 固定为该 runtime 的 `state/`，私有 Gradle home 为 `state/jdt-gradle-home/`，独立于 snapshot GC。canary 使用独立 runtime/cache/state/HOME/log/label。冻结 Node 采用默认堆策略；不添加 heap/RSS 杀进程阈值。

安装先构建并校验候选、完成隔离 smoke 和配置检查，再备份前序状态、停止旧 job、替换完整 bundle/env/plist/current，最后启动并 smoke。`daemonctl.sh rollback-release` 在停服前核验备份，恢复完整 bundle、immutable release、env/plist、稳定入口和 predecessor pointer；cache/state 数据目录保留。首次安装没有完整前序备份时不能执行 release rollback。

控制器还支持 `status`、`start`、`stop`、`restart`、`wait-ready`、`smoke`。stdio 是 owner relay，不创建另一套 runtime。HTTP 只绑定 loopback，提供 `/mcp`、`/healthz`、`/readyz`；浏览器 Origin 默认拒绝。不要把 token、业务源码或完整 tool payload 写入公共材料。

定向单测不能替代真实签名、launchd、TCC 和实际安装验收。兼容与回滚按用户要求不再验收，有问题停用。历史两小时 canary 只覆盖原候选身份。实际结果以 MAC-17 task-result 与候选清单为准；生产固定路径 TCC 授权和业务仓读取未包含在本轮授权中。

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

每次调用都显式传当前 worktree 的绝对 `repoRoot`，不需要先调 `java_status`。daemon 从入参 `repoRoot` 向上找构建根（Gradle settings，或最外层 Maven 聚合 `pom.xml`）：普通仓库和独立目录的 worktree 就是它本身；worktree 放在另一个 Maven/Gradle 工程目录之下时可能解析成外层工程，这种布局先用 `java_status` 核对返回的 `repoRoot`。静态结果的 `indexView` 标明所用的索引视图（`workspaceId`、snapshot、新鲜度 `state`）。

### Worktree 规则

- 如果当前 worktree 与某个 `lspEnabled=true` 配置 root 共享同一个 Git `common-dir`，允许继承“可启动 LSP”的权限。
- 继承的只是 enablement，不继承主工作区的 runtime/cache。
- 当前 worktree 仍使用自己的 canonical `repoRoot`、`repoHash`、generation、`index.sqlite`、JDT LS workspace 和日志。
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
- 提示 agent 每次调用显式传 `repoRoot`、直接调用目标工具（不必先调 `java_status`；worktree 嵌在另一个 Maven/Gradle 工程目录下时，先用 `java_status` 核对解析出的 `repoRoot`；静态结果的 `indexView` 标明所用视图与新鲜度）；普通仓库与 Git worktree 都按需启动 JDT。`started=false` 不代表静态查询不可用；未知位置先用 `java_symbol(operation=query)` 定位，或直接 `java_impact({symbol:"Type#method"})`；返回的 `symbolId` 可直接传回，`AMBIGUOUS` 时从候选选 `symbolId`。
- 全局 `AGENTS.md` 维护 Java 工具选择与证据核实策略；hook 补充当前仓库提示，具体参数以 MCP schema 为准。
- 只有 cwd 已启用 **且** prompt 命中 Java 语义词（如 `java` / `Service` / `修复` / `影响面` / `排查`）才注入 `JAVA_LSP_ADVISOR`。纯「接口 / 接手计划」类 prompt 会静默放行，模型仍应自己调用工具。

## Public MCP Tools

| Tool | 用途 | 是否要求 LSP |
| --- | --- | --- |
| `java_status` | 查看 server、repo、JDT LS、RepoChangeCoordinator、JavaIndex coverage/generation、lease 和 resource 摘要。`start=false` 仍会为该仓 create runtime（不拉 JDT）；repo 级请求预算 15s。`start=true` 才启动 JDT LS。`detail=diagnostic` 返回完整排障字段。 | 否；启动时需要启用 |
| `java_impact` | 推荐入口。生成 Java 影响面、候选文件、内部 `rg` 摘要、可读计划、证据缺口和指标。目标三选一：`symbol`（`java_symbol` 返回的 `declaration.symbolId`，或 `Type#method`、`Type#method(ParamType, ...)` 这类名称；参数表按解析出的参数类型比较（数组维数、varargs、类型变量的 erasure；部分限定的外部类型无法确认时列为候选），包含 `String a[]` 声明符数组维度和带注解 varargs；旧 method ID 须重新定位；歧义返回 `status=AMBIGUOUS` 候选、不跑分析；ID 失效返回 `NOT_FOUND`/`REJECTED` 和重新定位提示）、`file`/`line`/`column` 或 `anchors[]`；参数错误附合法示例。**省略** `readPlanMaxItems`（最大 30）和 `deadlineMs`（最大 15000）；不要用旧记忆里的 80 / 120000。 | `semanticPolicy=fast` 不要求；`required` 要求 |
| `java_symbol` | `operation=query`（默认，给了 query）走静态 discovery：消费磁盘 Java 索引（`java-discovery/v1`：显式 name、1-based UTF-16 locator、按 contentHash 校验的源码 preview），**不需要 JDT**；`backend=jdt` 保留旧 workspace-symbol 通道。`operation=position`（默认，给了 file/line/column）查 hover、definition、implementation；`operation=references` 对精确符号位置返回 summary-only references（两者始终走 JDT）。默认返回 repo-relative 位置、隐藏 raw URI/range。静态结果用 mac1 `symbolId`（workspace 身份 + 声明键，跨无关发布有效；局部/匿名声明只有 `stability=SNAPSHOT` 和 `evidenceHandle`）命名声明，可作为 `symbolId` 入参代替 `file`/`line`/`column`；`indexView.state` 是索引新鲜度（FRESH/STALE/NOT_READY），`scopeState` 为 PARTIAL/NOT_READY 时未命中不代表不存在。 | query 默认否（`backend=jdt`、position、references 是） |
| `java_diagnostics` | 打开 Java 文件并等待短时间返回 JDT LS diagnostics；默认按 repo-relative 文件聚合。 | 是 |
| `java_runtime` | `action=restart` 重启当前 repo 的 JDT LS session（默认返回动作摘要，只有显式参数才清 cache）；`action=shutdown` 停止当前或全部（`all=true`）JDT LS 子进程，MCP server 保持存活。HTTP daemon 固定拒绝 `all=true`。 | restart 是；shutdown 否 |

方法声明键现为 `method:v3:<owner>#signature`（`identityVersion=3`、`factsRevision=6`），外层 `jsym:mac1` 不变，type/field ID 保留。旧 method key（含 mac1 包裹）返回 `REJECTED` 并提示重新定位；mac1 包裹的旧键为 `reason=MALFORMED`，不自动绑定到新方法。请重新执行 `java_symbol(operation=query)` 获取当前 `symbolId`；旧库和缓存按现有版本机制重建。

实验操作 `java_symbol(operation=evidence, file, line, column)` 按已定位的 Java 类型或方法读取关联 XML 源码，不启动 JDT。类型路径使用现有 `resultMap.type` 事实，方法路径保留独立的 XML 文档来源；每次最多 8 个片段、80 行、16000 源码字节。`complete` 只说明该 XML 元素范围是否完整，未解析、过期或截断结果仍为 `PARTIAL`。普通 query 的默认预览和排名不变。分阶段验证与配置边界见 [实验计划](docs/next-stage/evidence-protocol-experiment-plan.md)。

生产 daemon 的静态查询由最多 2 个共享只读 worker 承担（`MAX_QUERY_WORKERS`，所有仓库共用），等待队列上限 32，满时请求返回 `INDEX_PARTIAL`；HTTP daemon 无选择器的 `java_status` 在 `index.queryCounters` 里给出启动以来的 `queueFull` 与因 deadline/取消被杀的查询数。隔离容量测量 `measure-query-load` 可显式传入 `--worker-count 1|2`；两种配置共用最多 32 个等待请求的队列，报告逐请求排队、执行时间及进程 CPU/RSS。该参数只用于实验，不改变生产默认配置。容量与模型对照结论见[实验评审](docs/next-stage/evidence-protocol-experiment-review.md)。

推荐默认调用（直接调用目标工具；名称有歧义时从返回的候选里取 `symbolId` 再调用）：

```json
{"tool":"java_impact","arguments":{"repoRoot":"/absolute/repo","symbol":"demo.OrderService#create","semanticPolicy":"auto"}}
{"tool":"java_impact","arguments":{"repoRoot":"/absolute/repo","anchors":[{"file":"src/main/java/demo/OrderService.java","line":42,"column":18}],"semanticPolicy":"auto"}}
```

只要 JDT 时再 `java_status({start:true})`。静态索引是 owner 管理的不可变 snapshot：仓库首次被请求时由 builder 子进程全量构建（大仓可能 1–3 分钟 `BUILDING`），之后按 FSEvents 增量发布新 snapshot；daemon 重启后直接复用已发布的 snapshot。`projects.json` 里 `lspEnabled` 的 pin 仓不会因为 2 天不用被 janitor 删掉。

排查 runtime、watcher roots、JDK candidates、raw LSP URI/range 或完整 diagnostics 时显式打开诊断字段：

```json
{"tool":"java_status","arguments":{"repoRoot":"/absolute/repo","start":false,"detail":"diagnostic"}}
```

默认不要在每次查询后调用 `java_runtime(action=shutdown)`；让 idle TTL 回收 JDT LS，才能复用 workspace import 和磁盘上的 `index.sqlite`。

需要强语义结果时：

```json
{"tool":"java_symbol","arguments":{"repoRoot":"/absolute/repo","query":"OrderService","backend":"jdt"}}
```

静态 query 返回的 locator（`declaration.selection`，1-based UTF-16）可直接喂给 `java_impact` 的 `file`/`line`/`column`，无需重搜行号；preview 仅在磁盘文件与索引 `contentHash` 一致时返回（`previewKind=source`），否则只报无 preview，不拿摘要冒充源码。

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
| `JDTLS_INDEX_TIMEOUT_MS` | JDT 初次导入后等待搜索索引的独立时限，默认 `600000`（10 分钟）。请求超时后，索引可继续运行。用 `java_status(start=false)` 查看 `progress.indexBarrier`。 |
| `JAVA_LSP_CACHE_BASE` | 覆盖统一 cache base；安装器默认 `~/Library/Caches/codex-java-lsp-ilv2`，canonical 路径绑定 native owner。 |
| `JAVA_LSP_SERVICE_STATE_ROOT` | 服务状态根；受管安装为 runtime 的 `state/`，私有 Gradle home 为 `jdt-gradle-home/`。 |
| `ILV2_CODESIGN_IDENTITY` | 稳定 launcher 签名 identity；MAC-17 安装拒绝 ad-hoc bundle。 |
| `JAVA_LSP_SQLITE_CACHE_KB` | sqlite page cache，默认 `32768`（32 MiB / 打开的连接）。 |
| `JAVA_LSP_CONN_IDLE_MS` | 只读 sqlite 连接空闲后关闭的时间，默认 `600000`；关闭后会 truncate WAL。 |
| `JAVA_LSP_BUILDER_PARALLELISM` | 冷建解析并行度，默认 `min(4, cpus-1)`。 |
| `JAVA_LSP_OWNER_ENDPOINT` | stdio 入口转发的 owner MCP 地址（仅 loopback `http://`）；未设置时读取 daemon 在 cache base 下写的 `owner-endpoint.json`。stdio 自身不建 index/JDT，owner 不可达时请求直接失败。 |
| `JAVA_LSP_PROJECT_JAVA_HOME` | 指定默认项目 JDK。 |
| `JAVA_LSP_PROJECT_JAVA_HOME_<ALIAS>` | 为某个 alias 指定项目 JDK，alias 会转成大写并把非字母数字替换成 `_`。 |
| `JAVA_LSP_JDTLS_XMX` | 覆盖 JDT LS heap，例如 `2g`。 |
| `JAVA_LSP_MAX_ACTIVE_REPOS` | 限制同时活跃的 JDT LS repo 数。 |
| `JAVA_LSP_IDLE_TTL_MS` | repo 空闲后自动停止 JDT LS 的时间。 |
| `JAVA_LSP_MAX_RUNTIME_ENTRIES` | Node 进程最多保留的 repo runtime context 数；默认 `16`。新建 entry 超限时按 LRU 退役一个空闲（无进行中请求）、非 pin 的 entry；pin 与使用中的 entry 不退役，所以总数可暂时超过上限，等有 entry 空闲时再收敛。 |
| `JAVA_LSP_MAX_DELTA_LINEAGE` | 连续 delta 的血缘上限，默认 `256`；自身基底已累计这么多次 delta 时，下一次构建改为全量（`fullReason=lineage-limit`），限制 delta 与全量结果漂移的累积。`0` 关闭。 |
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

生产 cache 不要 `rm -rf` cache base，也不要手删其中的 snapshot、job 或 WAL 文件：snapshot 由 owner 的 GC 按绑定和租约回收。janitor 只处理按 hash 命名或带 `repoRoot` meta 的仓库目录，拒绝把 `/`、`$HOME` 及其祖先、`~/Library`、`~/Library/Caches` 当作 cache base。一次性收割（默认 dry-run）：

```bash
npm run cache:harvest
npm run cache:harvest -- --apply
```

32GB 内存机器的默认资源策略通常是：

- `JAVA_LSP_MAX_ACTIVE_REPOS=3`
- `JAVA_LSP_JDTLS_XMX=2g`
- `JAVA_LSP_IDLE_TTL_MS=2700000`
- `JAVA_LSP_MAX_RUNTIME_ENTRIES=16`
- `JAVA_LSP_WORKTREE_CACHE_TTL_DAYS=2`
- `JAVA_LSP_CACHE_UNPINNED_MAX_DIRS=48`
- `JAVA_LSP_CACHE_UNPINNED_MAX_BYTES=6442450944`
- `JAVA_LSP_IMPORT_CONCURRENCY=2`
- `JAVA_LSP_RG_CONCURRENCY=4`
- `JAVA_LSP_DOCUMENT_SYMBOL_ATTEMPT_TIMEOUT_MS=10000`

## 开发与验证

历史 2026-10-11 QA 发布的静态事实 revision 为 **5**。旧 revision 的静态索引在正常访问时重建；静态 READY 需要完整遍历，并按实际解析、失败与恢复计数发布。存活的 JDT 子进程继续占有 lease，直到进程确认退出。较早 runtime integrity 阶段的未安装 / NO_GO 记录作为历史保留；QA 发布时刻的资格和安装记录位于维护工作区 `docs/next-stage/qa-contract-release-review.md`；后续 hook 同步见 [Java agent 指导](docs/next-stage/java-agent-guidance-review.md)。未手动修复或删除生产缓存。

较早范围与证据见 [runtime integrity 计划](docs/next-stage/runtime-integrity-plan.md)、[历史发布评审](docs/next-stage/runtime-integrity-release-review.md) 和 [历史原 NO_GO 清单](docs/next-stage/release-evidence.json)。[K01–K32 runner](scripts/run-release-contracts.mjs) 记录逐项原始结果；[真实 JDT driver](scripts/release-jdt-contracts.mjs) 生成 K26/K28 的隔离集成证据。使用这些入口仍须遵守下面的隔离约束。

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

当前运维与下一周期：

- [生产操作（IOD 现行）](docs/phase-f/production-operations.md)
- [生产切流手册（历史）](docs/phase-f/production-cutover-runbook.md)
- [下一周期 token accuracy 计划](docs/deep/codex-java-lsp-mcp-next-frontier-token-accuracy-plan-2026-08-24.md)
- 三仓 paired gate：[three-repo-cold-matrix-runbook](docs/three-repo-cold-matrix-runbook.md)

历史 warm/readPlan 报告仍在 `docs/java-lsp-mcp-*-2026-06-*.md`。

## 故障排查

- `codex-java-lsp currently supports macOS only`：当前平台不是 macOS，回退到 `rg`、build、日志证据。
- `jdtls not found`：执行 `brew install jdtls`，或设置 `JDTLS_BIN`。
- `Missing dist/server.js`：若该 checkout 没有被在线服务使用，可运行 `npm run build`；
  在线服务场景只运行 `npm run build:isolated` 做源码验证，用户级 runtime 通过
  `./install-runtime.sh` 在目标 runtime 目录重新安装。
- `HTTP daemon down`：运行 `daemonctl.sh status` 检查 LaunchAgent、固定端口与 daemon stderr log；不要直接再起一个随机端口的生产 daemon。
- `HTTP daemon build SHA differs from current release`：停止 daemon 后执行 `daemonctl.sh restart`；若仍失败执行 `daemonctl.sh rollback-release`。
- `Project root is not LSP-enabled`：用 `register-alias.sh --enable-lsp <id> <absolute-root>` 显式启用。
- `Multiple enabled aliases share this Git common-dir`：为当前 worktree 单独注册绝对路径，消除 family 继承歧义。
- `No idle Java LSP runtime available`：降低并发、关闭空闲 repo，或调整 `JAVA_LSP_MAX_ACTIVE_REPOS`。
- `Deadline exceeded before runtime.create`：repo 级 `java_status` 现在是 15s 预算。若仍超时，等几秒再调一次（create 在后台继续）；不要为了「不超时」乱传 `deadlineMs=120000`。
- `Too big … readPlanMaxItems` / `deadlineMs`：省略这两个字段，或分别 ≤30 / ≤15000。不要用旧记忆里的 80 / 120000。
- hook 没有 `JAVA_LSP_ADVISOR`：cwd 未启用，或 prompt 没命中 `Service`/`修复`/`影响面` 等词。工具仍可用，模型应直接调 `java_status` / `java_impact`。

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

## Java Specialist Devkit v1（M0–M3）

本仓库同时是 Java Specialist Devkit v1 的执行载体：静态发现层（`java_symbol` 词法/结构化检索，A2 主线）+ 真实 agent 评测轨道。M0–M3 全部收口：

- **M1** 静态发现 + canary；**M2** 关键证据/读计划/真实 agent 评测（144 runs MEASURED，27B 后端）；**M3** 语义发现预注册实验（T10，KEEP_EXTERNAL 运行姿态，分支关闭）+ 绑定加深归因（T11，NOT_NEEDED）+ 单主线收口（T12）+ **终局双缺口关闭：full public corpus 12/12 语料 external-profile 实测（micro A2 0.574 → A3 0.625）与 Agent repair 48 runs 冻结测试实测（0/33，诚实的零）**。
- **单主线**：生产工具面 `java_status` / `java_impact` / `java_symbol` / `java_diagnostics` / `java_runtime`；未注册的 `java_context` 旧逻辑已在 M3 删除，`context-engine` 模块仍由 `java_impact`/SQL 层消费。
- **语义路线**：外部 dense 对照实验已关闭（R11 在 eval protocol v1.2 下重测为 NO_GO，见 `docs/next-stage/a2-static-fixes.md`），驱动与产品侧 `search_doc_text` 已删除；`experiments/semantic-discovery/` 只保留冻结审计按路径导入的 `provider.mjs` 与 `repair-judge.mjs`。产品默认线为 A2 词法。报告见 [`docs/java-specialist-devkit-v1/reports/`](docs/java-specialist-devkit-v1/reports/)（m0/m1/m2/m3-t10/m3-t11/m3 里程碑）。
- 历史路线（JIN/phase-f/v3 矩阵等）文档保留在 `docs/deep` 与 `docs/` 顶层，作为历史设计记录（当前生产主线以上文“单主线”节与 devkit 报告为准）；运行产物不在仓库内（仓库外 `java-devkit-v1-runs/`）。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。

使用、复制、修改、分发本项目时需要遵守 Apache-2.0 的核心约束：

- 保留版权声明、许可证文本和已有 NOTICE 内容。
- 修改过的文件应按许可证要求保留显著的变更说明。
- Apache-2.0 包含专利授权和专利诉讼终止条款。
- Apache-2.0 不授予项目名称、商标、服务标识或产品名的使用权。
- 本项目按 “AS IS” 提供，不提供明示或默示担保。
- 第三方依赖保留其各自许可证；分发时需要同时满足第三方许可证要求。

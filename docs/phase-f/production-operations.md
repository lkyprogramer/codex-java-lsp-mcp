# ILV2 安装候选与生产操作边界

日期：2026-10-31。本轮仅 MAC-16 收尾、MAC-17 候选及隔离 `:38457` canary；不 push、不动生产。旧生产 URL、LaunchAgent、runtime/cache/state 保留。历史授权不能用于本轮部署。

## 候选安装布局

首次安装必须显式设置 `CODEX_JAVA_LSP_RUNTIME_DIR` 为新的 ILV2 runtime；安装器默认仍是历史路径，不能裸执行覆盖旧生产。已有 daemon.env/current 却没有 verified owner bundle 时，在停服前拒绝。

固定路径是 `<runtime>/launcher/dist/native/ilv2-mac`。完整 bundle 包含 native/manifest、owner guard 与其 JS 闭包、ESM 声明和逐文件 inventory，校验权限、hash、实际稳定签名、protocol/architecture 和冻结 Node 身份。launchd Program 直接指向 launcher，参数中的 HTTP entry 指向具体 immutable release。

plist 使用 `RunAtLoad=true`、`KeepAlive={SuccessfulExit=false}`、`ThrottleInterval=1`、`AbandonProcessGroup=false`。owner 最多等待锁 5 秒；锁忙非零退出。进程组清理不等于私有 Gradle daemon 已退出，须分别核验。

默认新缓存 `~/Library/Caches/codex-java-lsp-ilv2`；`JAVA_LSP_SERVICE_STATE_ROOT=<runtime>/state`；`GRADLE_USER_HOME` 与 JDT Gradle home 为其 `jdt-gradle-home/`。该目录不受 snapshot GC 或 release 更新/回滚删除。canary 使用独立 HOME/runtime/cache/state/log/label。

## 安装与回滚合同

安装器支持 `--port`、`--canary-port`、`--preflight-runtime`，要求冻结 `ILV2_NODE_BIN`、`ILV2_RUNTIME_MANIFEST` 与稳定 `ILV2_CODESIGN_IDENTITY`，不修改 Codex MCP registration。

先完成候选构建/校验、隔离 smoke 与配置检查，再备份前序状态、停止旧 job、替换完整 bundle/env/plist/入口/current，最后启动并 smoke。故障恢复先确认候选退出，再恢复整组前序状态。

`daemonctl.sh rollback-release` 在停服前核验备份，再恢复完整 bundle、release、env/plist、稳定入口和 predecessor pointer；恢复的 env 选择前序 cache/state，数据目录均保留。首次安装没有完整前序备份时不能执行 release rollback。其他命令为 status/start/stop/restart/wait-ready/smoke。

未来生产切换须另行批准具体 SHA/digest、固定 launcher 绝对路径、label、端口与回退步骤，并冻结旧 runtime/cache/state 保留位置。不手删数据库、owner lock、lease 或 Gradle home。

## 验证边界

实际结果以 MAC-17 task-result 和候选清单为准。定向单测不证明真实稳定签名、launchd、TCC、升级回滚或两小时/1000 正常请求 canary 已通过。canary 先 start 再 attach，覆盖 full/seed/编辑/重启，正常与故障窗口分开统计，实例 source/build/native/runtime 身份须匹配。

生产固定路径的 Documents 授权、首次业务仓读取和升级后复验须另获授权并实测。空私有 Gradle home 的首次下载、首次语义可用时间与新增磁盘成本未测时保留未测；静态和语义时间分别报告。本轮不复制用户完整 Gradle home 或凭据。

## 历史生产证据

以下仅适用于记录中的旧候选与时段，不代表当前生产状态或 ILV2 验收。旧路径和观察口径不能直接用于 ILV2 清理或部署。

2026-10-11 QA 合同版本已实际安装。原 15 发布门、K01–K32、隔离升级与回滚均已通过评审；本次生产 installer 的 1366 源码测试和 436 脚本测试全部通过，无跳过，线上 health/ready 与五工具 smoke 通过。URL、四个 pin、项目配置、cache/ownership 和 15min JDT idle TTL 保持原值。这段描述限定于 QA 发布 `8f737ac7cd14`；原始 proof 与验收报告位于维护工作区 `docs/next-stage/qa-contract-release-evidence/` 和 `docs/next-stage/qa-contract-release-review.md`，不随发行包安装。生产未执行回滚，成功版本保留。

## 48h 观察（P3-G5）

- 结论：**pass**。`03f5a4154081` pid 15387 `runs=1` 连续 **49.7h**（采到 2026-09-11T04:58Z）。
- 8 针 6h 采样全部 ok：IOD 后 heap FATAL/recycle/hibernate/compact = 0，watchdog = 0，pin WAL = 0。
- 空闲 RSS 26–76 MiB；干活时 3 个 JDT 把 daemon 抬到 172.5 MiB，收回后 46 MiB。
- 表：`docs/phase-x/p3-gate-raw/P3-G5-samples.md`。原始 JSON：`~/Library/Logs/codex-java-lsp-mcp/samples/`。
- caveat：第一次 IOD 安装（2026-09-08T03:21Z）被 WAL 截断重装切开；48h 连续指当前进程。6h 采样未每针打 `java_impact`。

## 观察口径（非阻塞）

- `/healthz` `ok`，无第四端口，plist 无 `JAVA_LSP_ENGINE`
- stderr 在 IOD 之后不应再出现 heap recycle / hibernate / compact 指标
- 空闲 daemon RSS 目标 ≤120 MiB；打开多份 sqlite 会短暂抬高 page cache，conn idle 后应回落
- WAL 不应再堆到 GiB；活跃写入时几十到一百多 MiB 可以，idle 后应收掉
- 日志：`~/Library/Logs/codex-java-lsp-mcp/daemon.stderr.log`（含切流前旧堆时代记录，采样要按 release 路径过滤）

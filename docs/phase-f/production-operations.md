# 本机 Java LSP 现行操作（Index-on-Disk）

- 日期：2026-09-09
- 线上：`buildSha=03f5a4154081`（`releases/03f5a4154081-20260909T030914Z`）
- MCP：`http://127.0.0.1:38456/mcp`（不要 `--activate-http`，不要改 URL）
- 索引真源：每 worktree 一份 `~/Library/Caches/codex-java-lsp/<repoHash>/index.sqlite`
- 历史切流步骤（SourceIndex → 5 工具）见 [production-cutover-runbook.md](production-cutover-runbook.md)；**不要再按那份的 hibernate / 7 仓冷建 / 删 SourceIndex 执行。**

## 现在是什么

共享 HTTP daemon，LaunchAgent `com.lky.codex-java-lsp-mcp`，`RunAtLoad=true`（用户登录后自动起，不是登录前的系统 LaunchDaemon）。公开工具 5 个：`java_status` `java_impact` `java_symbol` `java_diagnostics` `java_runtime`。

`projects.json` 当前 `lspEnabled` pin：**lishuedu / lishu-v2 / exam-parent-v3 / cipherlink**。fat-service / analysis / recognition 未启用。

## 索引与 worktree

| 行为 | 实际 |
|---|---|
| 身份 | `repoHash` = 规范化 worktree 路径哈希。一 root 一 DB。 |
| 同 Git family | `familyHash` = common-dir 哈希。新 worktree 无库时异步 `VACUUM INTO` sibling，改写 `meta.repoRoot`，并等 reconcile 完成再对外 READY。 |
| 未提交 `.env` / `.sdkmanrc` | 不进 JavaIndex。JDT JDK 优先已提交的 gradle/maven toolchain。 |
| `git worktree add` 刷掉全部 `.java` mtime | 比 `content_hash`；相同则只戳时间戳，不整树 parse。 |
| 空闲 | 关 SQLite 连接（默认 10 min）。非 pin worktree 再过 JDT idle TTL 会 `shutdown` 释放 runtime lease（库文件留下，再开直接 reload）。**不 hydrate。** |
| WAL | 写连接 close / 只读 idle drop 后 `wal_checkpoint(TRUNCATE)`；`journal_size_limit=64MiB`。不要手删 `*-wal`。 |
| `JAVA_LSP_INDEX_DIR` | 若设成全局目录，所有 root 会抢同一个 `index.sqlite`。**生产 plist 不要设。** |

## LSP 启动

JDT **默认不随 daemon / `java_status` / `java_impact(fast)` 启动。**

- `java_status(start=false)`、`java_impact(fast)`：只开该 root 的 sqlite。
- `java_impact(auto)`：仅 service-profile 锚点才打 JDT；controller 不打。
- `java_symbol` / `java_diagnostics` / `required`：要 LSP，且仓 `lspEnabled`（worktree 可按 family 继承启用资格）。
- 最多 3 个 JDT；idle 15 min（本机 plist `JAVA_LSP_IDLE_TTL_MS=900000`）；关进程保留 `workspace/`。
- `session.state=READY` ≠ 工程 import 完。workspace symbol 要等 `ServiceReady`。
- 不要四个 pin 同时 `start=true`。不要设 `JAVA_LSP_ENGINE`。不要起第四个 HTTP daemon。

## Cache 什么能删

禁止 `rm -rf ~/Library/Caches/codex-java-lsp`，禁止手删 pin 的 `index.sqlite` / `*-wal`，禁止删 `.ownership` 和 `leases/`。

| 可删 | 条件 |
|---|---|
| 已结束的 Codex worktree 对应 12 位目录 | 路径已死或确认不再用；下次打开会再拷 sibling 库 |
| 空闲仓的 `workspace/` | 只影响下次 JDT import |
| `logs/`、`telemetry/`、`cold-build-metrics.json` | 可删 |

Janitor 每 6 小时：L0 退役 gz；回收死 pid 的 `leases/runtime` 目录；L1 非 pin 且 `lastRequestAt` 超 2 天或路径已死；L2 非 pin 超 48 目录 / 6 GiB。`lspEnabled` pin 永不因 TTL 删除。活 JDT / 未 idle 退役的 runtime lease 仍 skip。非 pin 空闲后会放 lease，L1/L2 才能收盘。先看再删：

```bash
npm run cache:harvest
npm run cache:harvest -- --apply
```

## 安装 / 回滚

```bash
# 干净工作区；不要 --activate-http
./install-runtime.sh
"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" smoke
# Restart Codex，开新 task

# 回滚上一份 immutable release
"$HOME/Library/Application Support/codex-java-lsp-mcp/daemonctl.sh" rollback-release
```

登录自动启动：

```bash
launchctl enable "gui/$(id -u)/com.lky.codex-java-lsp-mcp"
```

`daemonctl.sh stop` 只卸当前会话；下次登录仍会按 `RunAtLoad` 拉起，除非 `launchctl disable`。

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

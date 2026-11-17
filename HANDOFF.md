# HANDOFF

## 当前 ILV2 owner 与 workspace snapshot

一个 canonical cache root 对应一个 owner。固定签名 native launcher 获取 fd4 独占锁后直接 exec 冻结 Node；受管子进程继承锁引用。stdio 只转发到 owner。静态真源是 `mac1/` 下封存的 SQLite snapshot 与 workspace binding；builder 写私有候选，发布前校验，请求持有 snapshot lease。

MAC-17 完整 launcher bundle 位于 `<runtime>/launcher/`；launchd Program 指向固定 native binary，HTTP entry 指向具体 immutable release。plist 使用 RunAtLoad、失败重启、1 秒 throttle、`AbandonProcessGroup=false`；native 锁等待最多 5 秒。进程组清理与私有 Gradle daemon 清理分别核验。不新增 heap/RSS 杀进程阈值。

首次安装显式设置 `CODEX_JAVA_LSP_RUNTIME_DIR` 为新 ILV2 runtime。默认 runtime 仍为历史路径；已有 daemon.env/current 却没有 verified bundle 时，在停服前拒绝。默认新缓存 `~/Library/Caches/codex-java-lsp-ilv2`；service-state 是 runtime 的 `state/`，私有 Gradle home 是 `state/jdt-gradle-home/`。旧生产 runtime/cache/state 保留。

升级与 rollback-release 成对管理完整 bundle、immutable release、env/plist、稳定入口及 predecessor pointer。回滚恢复路径绑定，不删除缓存或 Gradle home；首次安装没有完整前序备份时不具备 release rollback。

## 当前任务与证据边界

- **生产升级**：2026-11-18 已部署封存版本 `cd6b96ff84ac`，full seal、五工具 smoke 和 stats 均通过。回滚指针指向 `1496fd29c7d0`。见[生产升级与 stats 验收](docs/index-lifecycle-v2/mac/mac-17/production-upgrade-2026-11-18.md)。
- **改进线**：post-ILV2 的评测与关系类改进线已收尾，S2、S3 关闭（[decisions.md](docs/post-ilv2/decisions.md) P12、P13）。产品方向和封存集 v2 暂不投入。
- **审计**：代码质量审计已收尾，逐项处理状态见[审计](docs/code-quality-audit-2026-11-16.md) §9；JDT 路径各项（第 3 步）只登记、暂缓。各步 Mac 门禁结果在 `docs/post-ilv2/results/AUDIT-*-MAC-GATE.json`。
- **验证**：开发机内存不足，不在本地跑测试、tsc 或 eslint。`gate:pr` 由 GitHub macOS runner（`.github/workflows/gates.yml`）在发往 main 的 PR 和推到 main 时自动运行；`gate:release` 依赖冻结 JDT 工具链和私有 launchd 工作根，仍在用户 Mac 上运行。合入用 merge commit，须用户明确同意。
- **边界**：不动生产 runtime、cache 与固定路径；生产部署、首次业务仓读取和升级复验须另行批准。不得新增第四个 live daemon；常驻测试只用已授权 `:38457`，fixture 全机最多 2 个。Mac 长时间验证按 `docs/deep/ilv2-mac-manual/` 执行。
- **归档**：冻结 V3 证据（`artifacts/`）、两套冻结评测 kit（`java-specialist-devkit-v1`、`java-specialist-release-audit-v1.1`，仅保留 `contracts/`）、v4 sprint0 基线及其驱动脚本，以及无代码读取的历史 `docs/`（阶段报告、`deep` 历史计划、多数 `phase-*`、未被 status/决策引用的门禁证据）已从主分支移除，原样保存在 tag `archive/evidence-2026-11-17`，用 `git show archive/evidence-2026-11-17:<path>` 读取。
- **历史**：2026-11-16 之前的任务边界与日志见 [docs/archive/handoff-history-2026-11-16.md](docs/archive/handoff-history-2026-11-16.md)，只作背景。

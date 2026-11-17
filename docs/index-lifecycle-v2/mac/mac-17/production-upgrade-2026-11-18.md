# 2026-11-18 生产原地升级与 stats 验收

生产 `38456` 已切换到 `cd6b96ff84ac314e89d46a57f79300c30ef424db`。封存版本的 SHA-256 为 `894040ec41aef432054a5c196e849662fa1f501b3d55ba4a2633188a857477e6`。最终验收为 PASS。

## Fixture 配额排查

首次 full seal 中，`owner-restart-admission-with-active-workers` 报 `fixture quota wait timed out`。共享配额只有两个槽。查询配额 SQLite 后发现，11 月 17 日隔离 JDT 冷启动测试中止后仍占着槽 0，而该用例需要第二个槽启动竞争 owner。

对照配额关联的运行目录和测试 LaunchAgent plist，确认对应服务已从 launchd 消失，控制进程已退出，也没有进程命令行引用该测试运行目录。在 SQLite 写事务内重新核对归属，只按该 token 释放关联的外部 fixture 记录和配额槽。保留原始测试工件。原失败用例定向复跑 1/1 通过，最终配额登记为 0。

## 封存与切换

清理配额后，脚本套件另有一项因工作区缺少锁文件声明的 ESLint 而失败。沿用冻结 Node 执行 `npm ci --include=dev`，该用例定向复跑 1/1 通过，随后同一源码提交重新完成 full seal。

| Full seal | 总数 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| 单测 | 1693 | 1692 | 0 | 1 |
| 脚本测试 | 828 | 817 | 0 | 11 |

单测跳过项为 48 小时 GC。首次安装尝试的隔离 smoke 通过，随后在切换前因传入的 manifest 路径不同于生产登记路径而退出。核对冻结 manifest 和生产 manifest 的 SHA-256 相同后，复用同一封存候选继续升级。**升级时使用的 `ILV2_RUNTIME_MANIFEST` 为 `~/Library/Application Support/codex-java-lsp-ilv2/state/runtime.json`**，调用时须将 `~` 展开为账户目录。

隔离端口 `38457` 与生产端口 `38456` 的五工具 smoke 均通过。生产 `daemonctl.sh status`、`smoke`、`/healthz` 和 `/readyz` 均通过。

## Stats 与回滚

- `daemonctl.sh stats --since 30d` 成功读取 2588 条历史调用，无坏行，旧 `java_symbol` 调用的 operation 显示为 `unknown`。
- 首次启动 JDT 的状态请求超时。等待同一 JDT 达到 `READY` 后补验通过。`stats --since 1d` 中新增的 `java_symbol` 调用按 operation 分组，`query` 2 次均成功，`indexState` 为 `FRESH=2`。 `position` 1 次成功，耗时 2525 ms，`indexState` 为 `-`。
- 回滚指针已核对为 `releases/1496fd29c7d0-20261117T085918Z`。需要恢复时执行 `"$HOME/Library/Application Support/codex-java-lsp-ilv2/daemonctl.sh" rollback-release`。回滚保留缓存、service-state 和私有 Gradle home。本次未执行回滚。

原始证据留在 Mac 的 `runs/upgrade/` 下，封存运行 ID 为 `cd6b96ff84ac-deps-20261117T163751Z`，切换运行 ID 为 `cd6b96ff84ac-cutover-20261117T165352Z`。最终结果见切换目录中的 `acceptance.json`，另保留首次 stats 失败日志与补验结果。

# MAC-02 — native边界与构建供应链（分卡验收）

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

下列名称是**待实现的测试合同**；每张子卡完成对应GREEN后才能依赖它。父门G02只有G02A/B/C全部通过才PASS，不用一个大测试掩盖部分完成。

## MAC-02A — 构建身份、固定Node与clonefile

**依赖：** MAC-00、MAC-01。**范围：** `native/macos/`、`src/mac-platform/`、`scripts/build-macos-native.mjs`、`run-isolated-node.sh`、`isolation-utils.mjs`、`run-isolated-validation.mjs`、`run-v4-gates.mjs`、`run-v4-http-smoke.mjs`、`run-three-repo-cold-matrix.mjs`、`run-release-contracts.mjs`、`write-build-stamp.mjs`、`src/build-info.ts`、`package.json`、安装器Node选择。

**步骤：** 同一个native builder输出`dist/native/`；candidate allowlist和sourceDigest纳入未跟踪native源码；普通/隔离/三仓/安装均构建它，不复制宿主旧二进制。所有入口显式使用冻结NODE_BIN；binder在任何分支返回前重绑定字面node，含nested broker；后续子进程复用该路径。覆盖v4的PR和release/HTTP smoke，去掉release固定38491，使用受管随机端口；实际bind失败明确退出，不能附加别人实例。stamp绑定native源/binary/protocol/架构/deployment target/工具链/runtime digest。capability/clonefile只覆盖缓存同卷，错误不fallback。

**目标测试/命令：** `scripts/ilv2-mac-runtime-contracts.test.mjs`：`reject-runtime-drift`、`targeted-pr-release-k-descendants-ignore-host-path`、`nested-broker-binds-current-executable`、`quoted-glob-is-expanded-in-candidate`、`release-smoke-binds-owned-port-and-reaps`、`native-untracked-input-is-captured`、`native-compile-failure-blocks-pass`；`dist/mac-platform/clonefile.test.js`：`same-volume-clone-or-explicit-error`。PATH首位放另一Node，实际test/PR/release/HTTP/K后代仍报告冻结execPath/versions/digest；源checkout的dist故意陈旧或缺失时，候选测试文件集合仍完整且glob只在候选展开。经§5.1定向入口运行；旧入口缺陷用行为RED，新能力用合同测试。

**G02A：** 运行、安装预检和manifest的Node/SQLite完全一致；不同PATH不影响选择；native改动影响身份；编译失败/错误架构/跨卷clone明确失败；业务仓库在另一卷的read capture不受此限制。D06为计划层替换，无需虚构删除不存在的源码。


## MAC-02B — flock launcher与launchd生命周期证明

**依赖：** MAC-02A。**范围：** 小型exec/flock launcher、Node spawn/fd传递辅助、`jdtls-lsp-io.ts`/`jdtls-semantic-backend.ts`的Gradle home与停止接入、隔离launchd/harness fixture；不写生产plist。

**步骤：** 按§2.1实现固定锁inode、fd4/IPC3映射及所有正式入口的lock校验。先用fixture逐级spawn，再核对真实builder/parser和JDT wrapper→JVM的组/锁；Gradle daemon按外部类单独核验private home、实际版本/PGID/fd、按版本stop及退出。G02B保留原生子进程继承合同及实测；按用户2026-10-14确认，真实FSEvents helper的fd/PGID实测归入G02C。隔离launchd job的label/plist/cache受本次manifest管理，plist只在本次run root，禁止写`~/Library/LaunchAgents`；结束后bootout，再用`launchctl print gui/<uid>/<label>`确认job不存在，核实进程退出后清理本次资源。

**目标测试/命令：** `scripts/ilv2-mac-owner-lifecycle.test.mjs`：`same-root-second-owner-is-rejected`、`bounded-lock-wait-and-owner-busy-restart`、`crash-soon-after-start-honors-recovery-budget`、`stable-sigkill-reaps-owned-group-and-preserves-lock-until-exit`（合并原稳定清组和锁存续两个相同场景，保留全部断言）、`child-alive-after-parent-sigkill`、`real-builder-parses-and-preserves-lock-and-pgid`；JDT/Gradle定向文件继续覆盖`jdt-wrapper-preserves-lock-and-pgid`、`gradle-private-home-and-bounded-recovery`、`gradle-failure-preserves-static-admission-state`。真实Gradle fixture用冻结9.3.1，覆盖正常stop和活动导入中SIGKILL/重启，并用另一私有home的对照daemon证明不误停；多版本分派用定向测试，实际采用其他版本时再补真实fixture。经§5.1及JDT隔离入口运行，不能用假日志代替实际存活/锁观察。历史G02B计数不改写。

**G02B：** 旧持锁OWNER_PROCESS尚存时第二launcher等待且不exec，超时非零退出；旧组退出后锁释放。验收刚启动即崩溃和锁暂占用两条实际launchd时间线，核对KeepAlive/ThrottleInterval以及OWNER_BUSY重启；两类旧进程正常清理须在同一≤10 s窗口退出。Gradle stop失败时用明确的恢复状态机fixture证明静态准入状态不被语义阻塞状态覆盖，且不会启动新JDT；有效home/按版本stop/实际exit/launchd卸载留证，对照域不误停。本卡不要求尚未实现的SnapshotStore、正式transport或GC，也不把fixture状态当正确查询的证明；完整产品恢复由G09必验。环境不足BLOCKED_ENV，不用guardian绕过证明。


## MAC-02C — FSEvents传输和fence

**依赖：** MAC-02A、MAC-02B（按用户明确执行顺序）。**范围：** native FSEvents模式与TS协议解码，不持久化原生eventId；真实helper的fd4、同OFD锁和PGID继承实测。

**目标测试/命令：** `dist/mac-platform/fsevents.test.js`：`raw-flags-and-fence-order`、`drop-and-root-change-remain-observable`、`stream-restart-creates-new-epoch`，用§5.1定向入口。原始flags、drop、root变化、事件流重建都有结构化传递和顺序证明；native协议错误明确失败，不退回fs.watch。

真实场景用`scripts/ilv2-mac-fsevents.test.mjs`一次证明ready后变更、fence前缀、真实RootChanged、重建epoch和fd4/OFD/PGID；先到ready再注入变更。独立执行者在相同候选复跑该关键场景。协议注入drop仅记PROTOCOL_ONLY；未诱发真实OS溢出记NOT_INDUCED，不折算PASS或声称OS溢出实测。协议错误、volume身份和总fence时限由定向协议测试证明。

**G02C：** watcher先建再扫的接入合同可执行，内存cursor没有被误写成持久freshness；真实FSEvents helper继承owner的fd4/同OFD锁且同PGID，父引用关闭后锁仍有效，退出后锁引用释放。此实测由G02B转入本门，未运行不得算PASS；供MAC-03B集成。

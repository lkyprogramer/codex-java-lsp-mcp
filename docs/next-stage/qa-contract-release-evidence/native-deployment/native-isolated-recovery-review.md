# Native 隔离恢复与 r7 独立评审

**PASS：隔离升级、回滚及清理的实际证据已足够；未发现阻断进入所审 r7 生产校验的事项。** r7 原生产守卫保留。此结论不表示生产已切换，也不预先承诺生产运行通过。

本评审只读核对已有原始结果、文件哈希及调用路径。未运行 model、test、build、installer、daemonctl、launchctl、HTTP 或生产操作。仅写本报告及配套 JSON。

## 实际证据

r6 原日志依次记录 qualification、clean-source、旧部署二进制副本配置、旧版启动、旧版 smoke、新版 installer、rollback-release、stop 共 8 个操作，全部 exit 0。原 installer 日志含实际依赖安装、build，以及强制 npm full 的 1366/1366 源码测试和 436/436 脚本测试；fail、skip、cancelled、todo 均为 0。候选端口 38562 和固定端口 38561 的五工具 HTTP smoke 都返回 build `8f737ac7cd14` / ready。旧版启动与回滚的五工具 smoke 均返回 `09b9851e888a` / ready。

原 r6 后续在 stop 成功、自己的 launchctl job 已 absent 后，首次 `socket.bind(38561)` 报 EADDRINUSE，原 driver 因此 **exit 1**。该原失败未修改。失败时精确 socket 状态未留存，不能断言 TIME_WAIT。

补充 r2 恢复没有重跑 installer、测试、build 或生命周期操作。它检查原始顺序及各 exit、测试统计、实际 smoke、旧版 current/stamp、已安装新版文件，然后记录 own job absent 和两端口原始无 SO_REUSEADDR bind 成功。恢复日志为 PASS，复合 proof 明确保留 `originalDriverExitCode=1`、`recoveryExitCode=0` 和 `ORIGINAL_OPERATIONS_PLUS_ADDITIVE_CLEANUP_RECOVERY`。

已独立重读核对上述 raw 与回执映射，核验旧版 current/stamp、新版 stamp 及 1780 个实际安装文件哈希。原 r6 中候选 previous pointer、rollback health 和 current pointer 的断言位于后续操作/stop 前；原日志只有清理失败的单个 traceback，结合执行顺序支持这些断言已通过。原失败入口与首次恢复失败记录均保留。这里采用原成功操作加清理后置条件恢复的组合证据，没有将原失败运行改写为 exit 0。

## 29 个日志排除标记

已从**原封未改** installer 的 `rsync_source_tree` 提取并核对 16 条排除规则，再对原 manifest 的 1843 个路径逐项重算：1780 included、63 excluded。63 个排除文件全部是 docs 下的日志；旧 manifest 只有其中 29 个缺少 `installerRsyncExcluded` 元数据，全部命中原 `*.log` 规则。

29 个差异均位于 `docs/next-stage/evidence-protocol-experiment-evidence/`，没有 src、scripts、fixtures 或生产安装入口。独立复核 1843 个包源文件 SHA 与 mode 全部匹配，1780 个实际安装源文件 SHA 全部匹配。`installed-source-selection.json` 修正的是验证范围的表达；未更改原 installer、原 manifest，也没有增加排除豁免或漏检生产源码。

## r7 守卫

r6→r7 的实际 diff 保留原 qualification/verifier、terminal PASS、独立 test-fixture adoption、1843 文件 SHA+mode、Git HEAD、clean-source、无生产代码变更及不重标旧模型数据的检查。r7 新增 production-only 入口，以及本评审 PASS、复合 proof SHA 和 installed selection SHA 绑定。对所审精确 selection 的哈希固定后，安装内容检查由旧错误元数据标记改为已审计的 1780 includedPaths。

生产分支继续在安装前校验旧 current、plist、projects config 哈希、旧版 health、候选端口空闲；执行原强制 installer；安装后核对新 current、previous-current、项目配置、原环境变量（除实例 ID）、cache/ownership/项目 Java pins、Label/RunAtLoad、新版 health 与新实例 ID、1780 实装源码哈希，最后执行 HTTP smoke。r7 只有这些实际后置条件通过才写 production PASS。源码 AST 可解析；本评审没有执行 driver。

## 身份与限制

- 发布包：`8f737ac7cd141d0eb07de37bb212d4d6648d96a3` / source `3ee9f884412d43e061699c42d11427fc70c3ba355d52bcc475d682db1c9dfcbc`。
- 原模型和资格证据仍为 `a77b6428ca432259c4008ead6c5e58cdc5e53cef` / `6d031e959f5b9a2824f0165b9deeb4aab98ba5cd3679312c8973139ffa129864`。本次只核对旧终审及 adoption 引用哈希，没有重新评测 15 门、32 K 或 168 slots。
- 五工具 smoke 是宿主/MCP 暴露面验证（repoScoped=false、started=false），不扩张为新的真实项目 JDT 语义验收。
- 原端口失败原因仍未知；后续 bind 证明的是恢复时刻的空闲，不是失败瞬间的状态。
- 原依赖 audit 警告仍按既有 dependency-risk-review 的条件化结论保留，不宣称 audit clean。
- 无需为此次清理回执恢复重复整套 npm。下一步是保持所审 driver/selection/proof 哈希不变，由 r7 的现有运行时检查决定当时生产状态。生产安装、保留项和最终 smoke 仍需实际执行后才可宣称通过。

固定绑定：

- isolatedProofSha256: `6ed5a7bfa2fcf25ad8856c0cdfdf407f13668a15361471eef847bc4a99f1c13e`
- installedSelectionSha256: `a5d648f17d0b68a6174b0028c0348b5bb4a8743dbd394ee466145104f87d4fa1`
- driverSha256: `38bc045ffe18a1ba9121acd0babf8233e0d783542a8b65ee701a6a4c26ee2f0c`

结构化结论与证据 SHA 见 [native-isolated-recovery-review.json](native-isolated-recovery-review.json)。

# 2026-11-17 封存版本原地升级与 JDT 冷启动观察

生产切换至 `1496fd29c7d0a9ba7b677d51bb477234f1d53f25`。full seal SHA-256 为 `cad65ca6f2c0720ad4cbc1afb3e75a22c4aa922713bd3e4b38a19a0e621bd7c0`。隔离端口 `38457` 和固定端口 `38456` 的五工具 smoke 均通过，生产 `/healthz` 和 `/readyz` 通过。同一业务仓的 workspace 和 snapshot ID 在切换前后相同，静态索引为 `FRESH`，缓存、service-state、私有 Gradle home 和 JDT 共享索引目录均已保留。

## JDT 冷启动问题

同一仓库已有 `READY` 的 JDT 进程时，语义查询复用该进程。生产所在 Mac 的空闲回收时间为 45 分钟。回收、服务重启或使用另一个 worktree 后，需要语义能力时才启动 JDT。已有且有效的 Gradle 项目模型可以跳过重新同步。[JDT LS 1.56.0 的同步判定](https://github.com/eclipse-jdtls/eclipse.jdt.ls/blob/v1.56.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/managers/GradleProjectImporter.java#L549-L584)

- 较早一次尝试在 `jdtls.project.import` 耗尽 120 秒启动预算，未达到 `READY`。
- 本次先验收生产静态路径，再用同一业务仓和已有缓存启动新 JDT 进程。日志显示项目需要重新同步。启动约 25、60、88 秒的线程栈均落在 Buildship 递归刷新 Eclipse 项目资源树的路径上。一次 Gradle 工具调用约 22 秒成功返回，之后仍采到了文件树刷新。[Buildship 的递归刷新入口](https://github.com/eclipse-buildship/buildship/blob/master/org.eclipse.buildship.core/src/main/java/org/eclipse/buildship/core/internal/workspace/ImportRootProjectOperation.java#L85-L92)
- 本次 95.63 秒达到 `READY`，其中包含导入和索引屏障。首次精确定义耗时 3.32 秒，首次引用耗时 1.74 秒，命中预期定义和两处引用。两次请求均在原有 10 秒时限内。此前达到 `READY` 后的首次定义超时，本次未复现，原因待查。

## 后续排查

保留 JDT 按需启动。若日常使用再次遇到慢启动，在隔离环境中对同一仓库和候选采集 Buildship 刷新的实际路径。仓库内的 `.worktrees` 有 15 个嵌套 worktree，现有 Eclipse 资源过滤器未覆盖该目录。它是否占主要扫描时间仍待确认。确认后，可比较排除该目录前后的导入耗时，并用相同的定义和引用位置验证结果。当前 JDT 的启动 job 在项目初始化之后配置资源过滤器，首次导入能否受益需要实测。

本次原始证据留在 Mac 的运行根 `production-static-1496fd29-20261117T085911Z`，包括 `result.json`、`acceptance.json`、`jdt-diagnostics.json`、`jdt-timeline.jsonl` 和线程栈。此次切换以固定端口、五工具 smoke 和静态索引作为生产验收，JDT 数据单独记录。历史 MAC-17 门结果保存在各自的验收记录中。

# 日常失败案例台账

日常使用中工具给错、给空、太慢或报错时记一行。阶段 3 的深化只在同类问题出现在至少 2 个不同任务组时进入，先在 A 层回归集加用例复现（长期规划 §5 阶段 3、§6.5）。

- 只记现象和可复现的最小信息；不记业务源码、绝对路径或任务 ID。
- 修复后填"处理"列，并在同一 PR 加回归用例。

| 日期 | 工具 / operation | 现象 | 绕过方法 | 处理 |
|---|---|---|---|---|
| 2026-11-17 | JDT 启动（`java_symbol` position） | 较早一次尝试在 `jdtls.project.import` 耗尽 120 秒启动预算，未 READY；同日复测 95.63 秒 READY | 静态 query 不受影响；稍后重试 | 待查：Buildship 递归刷新是否主要耗在 `.worktrees`（[记录](index-lifecycle-v2/mac/mac-17/production-upgrade-2026-11-17.md)） |
| 2026-11-18 | `java_status start:true` | 升级后首次启动 JDT，状态请求在 15 秒内超时；同一 JDT 达到 READY 后补验通过 | 等 READY 后重试 | 同上，冷启动问题 |

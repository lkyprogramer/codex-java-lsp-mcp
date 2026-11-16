# 仓库工作约定

## 真源与边界

- 当前状态只看 HANDOFF.md 开头的两节"当前…"；`docs/phase-*`、`docs/deep` 下带日期的计划和报告是历史，不作为实现依据。例外：`docs/deep/ilv2-mac-manual/` 是现行执行合同。
- 生产可达性以 `scripts/ilv2-mac-removed-paths.mjs` 为准；test-only 文件的问题不按生产缺陷处理。
- 公共工具面固定 5 个（`java_status`、`java_symbol`、`java_impact`、`java_diagnostics`、`java_runtime`）；不修改目标 Java repo；JDT 是可选增强，静态路径正确性优先。

## 实现规则

- 写新 helper 前先用 rg 找现有实现：
  - 写事务：`src/java-index/sql/driver.ts` 的 `withTransaction`（总是开新事务）；可能被嵌套调用的写入口沿用 `runInWriteTx` 的"加入已有事务"语义。
  - 异步原子写文件：`src/java-index/snapshot/seal.ts` 的 `writeFileAtomic`。
  - 分块绑定：`driver.ts` 的 `bindChunks`，必须把同一语句里的固定参数个数传给 `extraBinds`。
- catch 先处理终止类错误：`JavaIntelligenceError` 且 code 为 `DEADLINE_EXCEEDED` 或 `CANCELLED` 时重新抛出（参照 `relationship-provider.ts` 的 `rethrowRelationshipTerminal`）；降级处必须注释原因；对外错误用 `JavaIntelligenceError(code, message, cause)`，不得丢失 code 和 cause。
- 不新增 `any`、`as unknown as`、非空断言 `!`；外部输入用 zod 或类型守卫收窄。
- 新建的 child、stream、server、worker 必须监听 `error`；timer 和 fd 必须有释放点；close、dispose、shutdown 用 try/finally 和 `Promise.allSettled` 保证异常安全。
- 跨进程锁和 lease 不得"检查后直接 rm"；回收前必须在锁内重新确认 ownerToken。
- 偏移和列号必须标明单位（byte / UTF-16 / line），跨单位必须显式换算，并测试非 ASCII 输入。
- 测试或验证专用行为必须由 `JAVA_LSP_ISOLATED_VALIDATION=1` 或显式选项门控，默认关闭。
- 不新增被 .gitignore 忽略的跟踪文件。新增脚本须被 package.json、其他脚本或 [scripts/README.md](scripts/README.md) 引用。

## 机器门禁

- `npm run lint`（eslint，基线 `eslint-suppressions.json`）和 `npm run check:hygiene`（基线 `scripts/repo-hygiene-baseline.json`）都在 `gate:pr` 里，只拦新增问题。
- 基线只减不增：修掉存量后用 `npm run lint:prune` 收紧；`check-repo-hygiene.mjs --write-baseline` 只用于经评审的重置，不得用来放行新问题。

## 测试

- 修缺陷先写一个会失败的回归测试；必须覆盖的边界：空、上限、上限+1、非 ASCII、取消、deadline。
- 不得削弱断言、扩大 mock、skip 测试或用 sleep 等待。

## 测试与验证

- Mac 长时间验收预计超过 5 分钟、涉及多道工程门或需要索引冷启动时，执行前阅读 [Mac 长时间测试验证规范](docs/deep/ilv2-mac-manual/long-running-validation.md)。按规范准备后台脚本、阶段日志和终态交接。需要自动接续时，将 Heartbeat 绑定到当前对话。
- 迭代中运行 `npm run gate:pr`；提交前按 README 运行 compile 与 full 两个 profile（在线 runtime 并存时，`npm run` 不能作为正式证据，见 README）。
- 汇报时区分：已运行并通过 / 已运行但失败（附错误）/ 未运行（说明原因）。

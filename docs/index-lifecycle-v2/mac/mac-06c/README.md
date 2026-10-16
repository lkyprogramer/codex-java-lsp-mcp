# MAC-06C / G06C

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

接通真实 adapter：
- `build-process.ts` 为每个作业 fork 一个 builder 进程，原子发布后先回 result 再退出。delta 需要 full 时（`escalation: "report"`）回报 `needs-full`，full 等 scheduler 的 full 槽。
- `query-process.ts` 为每个请求 fork 一个只读查询进程。

两者都继承 owner 的 PGID 和锁 fd4，IPC `disconnect` 时以 70 退出。`incremental.ts` 只新增两个可选项，默认路径不变，G05 的驱动测试和增量测试已重跑。`OwnerAdmission` 提供两道准入：
- 静态准入：本进程 `assertOwnerLock` 校验通过后打开 builder/query 槽，在此之前排队的作业不 fork；
- 语义准入：交给 GradleDomain，外部清理完成前一直是 `JDT_NOT_READY`。

`owner-restart-admission-with-active-workers` 由直接 spawn 的 owner fixture 持锁（不经 launchd），流程如下：
1. owner A 跑着真实 full 和两个卡住的真实查询，第三个查询在排队（query worker=2）；
2. 用 `lsof` 确认这三个 worker 的 fd4 inode 都等于 owner 锁的 inode；A 关掉自己的 fd4 之后，第二个 owner 仍然拿到 `OWNER_BUSY`，零执行。这说明是 worker 自己持有锁；
3. SIGKILL A；
4. 旧 worker 全部退出后启动 C。C 先排队但 builder 为 0，semantic 被阻塞；static 打开后，所有 fork 都晚于 static-open；
5. 构建完成，正常查询返回 ok；截止和取消都在 2 s 内回收；
6. 外部清理之后 semantic 才准入。

整条 timeline 上 builder≤2、full≤1、parser token≤4、query worker≤2、lease≤worker。worker 装了 `disconnect` 时以 70 退出的处理，但本次没有观测到各旧 worker 实际是被哪个信号结束的。卡在同步步骤里的 worker 收不到 `disconnect`，靠 fixture supervisor 的进程组 SIGTERM/SIGKILL 回收，这是 launchd `AbandonProcessGroup=false` 的替身。外部清理用的是没有 daemon 的 fixture GradleDomain。`mixed-full-load-short-delta-queue-latency` 实测 verification.md §公平性：两个 full 加上每 500 ms 一个小 delta，p95/max 和 full 接力时间见 `owner-restart-summary.json`。

G02B 通过之后，launcher/锁的 native 代码改过（`e7c12e4a`），按 MAC-06.md 先在同一候选上重跑了 G02B 的 6 个 launchd 测试。G02B 的 JDT/Gradle 文件未重跑，G02B 自身的状态和历史不变。

不声明正式 binding、stdio/HTTP transport、文件 lease、GC，也不声明 launchd 下"两类旧进程同一 ≤10 s 退出"的产品恢复；这些属于 G09。旧 BuilderSupervisor 和生产调用链的切换属于 MAC-08。

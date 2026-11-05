# MAC-06B / G06B

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

QueryPool 固定两个请求专属子进程槽，FIFO 排队最多 32 项。排队期间截止或取消不 acquire lease；运行中截止或取消先结清 caller、终止专属进程，实际 close 后才释放槽和 lease token。stop 结清队列并等待活动子进程真实退出。result 一到就结清 caller：预算未过期返回 ok，过期返回 deadline。槽位和 lease 仍要等真实 close 才释放；result 后 1 s 内未退出则 SIGKILL，kill 后 2 s 内未回收则上报 `reap-overdue`。`acquire(signal)` 可以返回 Promise：取 lease 期间占着槽位，caller 取消后迟到的 lease 立即释放。

复用 DeadlineBudget。waitForSharedBuild 只撤销该 caller 的等待权，不取消由 BuildScheduler 持有的共享构建。MAC-06C 再接真实 builder/query adapter；MAC-07/08 再接文件 lease 和正式入口，全链 prepare/preview/序列化预算也在该集成阶段验证。本卡不提前替换旧 discovery worker 或生产调用链，不把 token 测试算作文件 lease/GC 验收。

2026-10-16 按 review finding 1（按时到达的 result 被判成 deadline）以及 3、5、6 修复后重跑。先前"正常结果也须等 close 后返回"的规则及固定它的测试已撤销。先前 PASS（`efe6a498`）保留在 git 历史中，也作为 `prior-task-result.json` 保存在新 run root，不合并计数。

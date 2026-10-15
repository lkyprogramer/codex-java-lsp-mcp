# MAC-06B / G06B

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

QueryPool 固定两个请求专属子进程槽，FIFO 排队最多 32 项。排队期间截止或取消不 acquire lease；运行中截止或取消先结清 caller、终止专属进程，实际 close 后才释放槽和 lease token。stop 结清队列并等待活动子进程真实退出。正常结果也须等 close 后返回，避免 result 提前释放资源。

复用 DeadlineBudget。waitForSharedBuild 只撤销该 caller 的等待权，不取消由 BuildScheduler 持有的共享构建。MAC-06C 再接真实 builder/query adapter；MAC-07/08 再接文件 lease 和正式入口，全链 prepare/preview/序列化预算也在该集成阶段验证。本卡不提前替换旧 discovery worker 或生产调用链，不把 token 测试算作文件 lease/GC 验收。

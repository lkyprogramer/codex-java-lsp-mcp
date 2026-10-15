# MAC-06A / G06A

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

新增 owner 级 BuildScheduler：全域最多两个 builder、一个 full，每个活动 builder 获得两个 parser token，总量不超过四；同 workspace 只保留一个活动作业和一个合并提示。实际 dispatch 重新选择候选，低估为小任务时先退出，再携带可复用 capture 进入 full 队列。收到 result 不放槽，须等真实子进程 close；fork 失败、超时和 stop 均结清等待者。

按 D04，MAC-08 才切换正式调用链并删除旧 BuilderSupervisor。本卡用真实 fork 的有界 fixture 验证调度原语，不宣称已接通真实 builder/parser worker、正式 binding、transport 或文件 lease；这些分别由 MAC-06C、MAC-07/08/09 集成。原生 launcher、锁和 runtime 身份未变时复用既有证据；不重复四仓矩阵、JDT/Gradle 或无关全量测试。

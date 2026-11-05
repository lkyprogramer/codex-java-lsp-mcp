# MAC-06A / G06A

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

新增 owner 级 BuildScheduler：全域最多两个 builder、一个 full，每个活动 builder 获得两个 parser token，总量不超过四；同 workspace 只保留一个活动作业和一个合并提示。实际 dispatch 重新选择候选，低估为小任务时先退出，再携带可复用 capture 进入 full 队列。收到 result 不放槽，须等真实子进程 close；result 后 5 s 内未退出则 SIGKILL，记 `forcedExit`，结果仍算成功。kill 后 2 s 内没有回收会上报 `reap-overdue`，槽位一直占到真实 close 为止。按进程变化的状态挂在单次 Attempt 上，不挂在合并请求 Entry 上。selection 的 `release` 恰好调用一次：在子进程 close 后，或者在未启动就被丢弃时。child 的重复 `error` 不会打崩 owner。fork 失败、超时和 stop 均结清等待者；stop 期间的升级会直接结清，不再重新入队。`admitted`/`wake` 供 owner 重启准入使用（MAC-06C）。

按 D04，MAC-08 才切换正式调用链并删除旧 BuilderSupervisor。本卡用真实 fork 的有界 fixture 验证调度原语，不宣称已接通真实 builder/parser worker、正式 binding、transport 或文件 lease；这些分别由 MAC-06C、MAC-07/08/09 集成。原生 launcher、锁和 runtime 身份未变时复用既有证据；不重复四仓矩阵、JDT/Gradle 或无关全量测试。

2026-10-16 按 review findings 2–5 修复后重跑。先前 PASS（`90f97fb8`）保留在 git 历史中，也作为 `prior-task-result.json` 保存在新 run root，不合并计数；本次门证据只来自新 run 的 `final-g06a-fix`。该 run 跑的是整个 `build-scheduler.test.js`，其中也包含 G06C 的两个测试，但 G06C 的结论只在它自己的门里声明。

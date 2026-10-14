# MAC-06 — owner、调度与取消（分卡验收）

[索引](../../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · [规则](../rules.md) · [合同](../contract.md) · [验证](../verification.md) · 门状态见 [`status.json`](../../../index-lifecycle-v2/mac/status.json)

**范围：** 新owner/scheduler/query pool，`src/application.ts`、`repo-ownership-lease.ts`和builder启动点；正式入口通过MAC-02B launcher。保留有用的JDT孤儿诊断，但不以裸PID清未知进程。

| 子卡 / 门 | 依赖 | 实施与目标测试（均待实现，经§5.1定向入口） | 完成判据 |
| --- | --- | --- | --- |
| MAC-06A / G06A | MAC-02B、MAC-05 | owner调度、full保留槽、workspace合并、候选dispatch重选、parser token；`dist/index-builder/build-scheduler.test.js`：`short-delta-not-starved-by-full`、`result-before-exit-keeps-slot`、`stop-settles-queued-promises` | 多root≤2 builder/full≤1，真实exit才放槽；fork失败/stop均settle |
| MAC-06B / G06B | MAC-06A | query池/有界队列、caller取消与shared build分离；`dist/java-index/snapshot/query-pool.test.js`：`hung-query-is-terminated-and-reaped`、`caller-timeout-preserves-shared-build` | 请求按时返回，专属worker≤2 s回收，未退出前不释放其lease |
| MAC-06C / G06C | MAC-06B | 调度harness并发提交多root任务，真实builder/query worker；owner由直接spawn的owner fixture持锁（不经launchd），活动中SIGKILL后重启；`dist/index-builder/build-scheduler.test.js`：`owner-restart-admission-with-active-workers` | 旧组/锁未释放前不开放新worker槽；随后静态槽可用、语义准入等待外部清理；result/exit/取消均收敛且槽位不超限。不要求或宣称正式binding/transport/GC已集成 |

**G06C不重复的证明：** 真实launchd的KeepAlive/ThrottleInterval时间线、OWNER_BUSY重启和“两类旧进程同一≤10 s退出”由G02B在原语层证明，由G09在正式binding/transport/GC集成后重证；G06C不再跑这两条最慢、最不稳定的真实OS路径。前提是launcher与锁原语的native源码digest与G02B通过时一致；若之后改过launcher/锁代码，先重跑G02B的launchd测试，而不是把它们加进G06C。

父门G06为三个子门全部PASS。证据包含实际PID/PGID、锁等待/OWNER_BUSY/获取、exit/reap、调度层两类准入时间线；不新增durable PID ledger或guardian。G06B/C先验真实worker、槽位和lease token生命周期，不提前依赖SnapshotStore；真实文件lease由G07/G08接入，周期GC与正式恢复由G09集成。早期token/状态机结果不能替代G09。

# MAC-08A / G08A

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

代码在 `ec9f9388`（request view 与持久 query worker）和 `b5bf5ac3`（stalled start 不阻塞 owner stop）提交，新增 `src/java-index/snapshot/` 下的 `index-owner.ts`、`request-view.ts`、`query-pool.ts`、`query-ops.ts`：
- `IndexOwner`：每个 daemon 一个 SnapshotStore、BuildScheduler 和 QueryPool，每个 workspace 一个 WorkspaceIndex；一轮依次 track → 校验已绑定内容 → noop 确认或构建 full/delta 候选 → 携带 builder 自身 capture 的 contentManifestId 发布。
- `withRequestView`：resolve、workspace create、prepare（≤ min(1000 ms, 剩余预算的一半)，总在第一次 acquire 之前）、恰好一次 `acquireBound`、查询，全部受请求预算约束；标签（FRESH/STALE/NOT_READY、snapshotId、bindingVersion、水位）在 acquire 时冻结，之后的 publish 不升级已持有的 view；没有自身 binding 就是 NOT_READY，不借用 sibling；`start=false` 只读内存。
- Query worker 持久（最多 2 个），在不可变的封存 snapshot DB 上执行操作；每个缓存连接持有一个 query-worker lease，只有 worker 报告关闭或进程实际关闭后才释放；查询中途超时或取消会 SIGKILL 并回收该 worker；preview 用 hash 校验 live 字节，不一致时给出显式 `sourceChanged` 缺口。

验证（在 `c7f2ae23…` = `ec9f9388 + b5bf5ac3` 上）：final-g08a 22/22（request-view、query-pool），regression-g08a 426/426；resolve/create/SQL/preview 挂起都在 deadline 之后 1.0–3.1 ms 返回，prepare 挂起 1027.8 ms 后以 STALE 服务；dev 档 mutation 矩阵 12/12 被杀。第一个 run root `runs/mac-08a/20261017T030510Z`（`b0ca6506`）是历史记录，未组合（见其 `not-composed.json`）：mutant M1 暴露了 owner `stop()` 会被挂起的 workspace start 阻塞，已由 `b5bf5ac3` 修复。

不声明的部分：本源码上 MCP 工具还走旧 runtime，生产调用链接入、stdio relay 和旧路径删除属于 MAC-08B；K29 容量和三仓严格 p95 比例属于 MAC-08C；request-view 测试里的 tracker 信号是注入的，原生 FSEvents 投递是 G03B 的证据；G06C 在 query pool 重写后没有重跑，MAC-14 复用前需要重跑。独立评审的发现作为带 owner 的 accepted limits 记录在 run root 的 `independent-review.json`，本源码中均未修复。

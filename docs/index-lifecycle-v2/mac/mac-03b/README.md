# MAC-03B / G03B

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

新增 `src/java-index/snapshot/workspace-tracker.ts`：以 FSEvents 信号驱动的 workspace tracker，原生 cursor 只在内存，不持久化。
- 每个信号取下一个进程内 seq，忽略原生 eventId；drop、RootChanged、mount/unmount、根外路径、启动、流重启和 resume 都强制全量 hash；EventIdsWrapped 不算 drop。
- `dispatch` 在 fence 之后同步冻结 epoch、cut、pending、子树和欠账标志，然后才读取 root、布局和 build fingerprint；读取期间到达的新信号 seq 大于 cut，不会被本轮清除。
- `verify` 对可疑文件一律 hash；stat 缓存键为 size、纳秒 mtime/ctime、ino、dev。`complete` 要求未失效、同 epoch、本轮已 verify，且 binding 的 epoch/cut/generation/bindingVersion/workspaceId/root 全部对上，之后只清除 seq≤cut 的项。周期全量 hash（10 分钟）的时间戳只在 `complete` 推进。
- root 在同一路径被替换时进入 INVALID_ROOT，`SnapshotStore.acquireBound` 不再返回旧 binding。

D07 的处理（2026-10-16 计划修订，见 [删除账本](../../../deep/ilv2-mac-manual/ledger.md) D07 行和 MAC-03/MAC-08 卡）：size+mtime 跳过已删除，builder 与 workspace-stat（schema v2，纯缓存，重建）改用五字段全等的 stat 身份。旧 runtime 的 fs.watch tracker（`repo-fs-watch.ts`、`repo-change-coordinator.ts`）在新调用图接入前仍是其唯一 watcher，作为 D07 显式残留由 MAC-08B 删除，G03B 不代表 D07 整体关闭。

真实场景 `scripts/ilv2-mac-tracker.test.mjs` 在 owner launcher 下（不经 launchd，fixture 槽）用真实 native FSEvents helper 驱动：启动全量 hash、同 size 同秒级 mtime 的编辑被发现、touch 不重建、目录 rename、流重启后新 epoch 全量 hash、root 替换后拒绝服务。drop 只在协议层用 fake source 验证，OS drop 未诱发。

第一轮评审 FAIL（dispatch cut 竞态；size+mtime 跳过仍在 reconcile 路径），修复后复评 PASS；第一轮运行保留为 history。closeout 第一次 `--finish` 因真实场景测试遗留 0555 封存目录删不掉 tmp 而失败，经评审确认的恢复过程记录在 verdict notes，测试清理留作后续。

不声明：OS 级 drop、原生 resume 信号（MAC-09）、launchd 路径、tracker→builder 的生产接线（MAC-08）；symlink 内容根与 abandon 后的 FRESH 显示是已接受限制，归 MAC-08B。

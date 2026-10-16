# MAC-07 / G07

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

新增 `src/java-index/snapshot/` 下的 `seal.ts`、`binding.ts`、`snapshot-store.ts`：
- 封存：DB 必须无 writer、build 完整、无 WAL/SHM/journal 旁路文件；封存后文件和目录去写权限，manifest 记录 sha256，只有 SEALED 才用 SQLite immutable 打开，`driver.ts` 拒绝对封存路径的写连接。
- 绑定：发布与 noop 共用 binding CAS（bindingVersion），还校验 trackerEpoch、root、generation、buildKey、capture 与 contentManifestId；noop 只推进水位，不写 DB、不新增 snapshot；零差量时验证完整后把已有 snapshot 绑定给另一 workspace。
- lease：候选、base 和 reader 共用 lease；base 在 clone 前 pause，其他发布和并发 `tryReclaim` 不能删除它；`tryReclaim` 是真实执行删除的统一原语。
- crash recovery：每个封存/rename/binding 边界的进程内失败和 SIGKILL 之后，只剩完整旧绑定或完整新绑定；与 snapshot manifest 不一致的 binding 被隔离；未知目录项（如 `.DS_Store`）不删。
- MAC-03B 之后 `acquireBound` 在 tracker 报告 root 被同路径替换时不再返回旧 binding。

代码先在 `0d557489` 提交并在 `runs/mac-07/20261016T065523Z` 验证通过，但当时 G03B 未完成，按依赖图没有组合（见该 run root 的 `not-composed.json`）。G03B 通过后在新 run root 上对已提交的 G03B 源码重跑 final 与 56 文件回归，复评 PASS。

不声明断电耐久（只测进程崩溃）；周期 GC sweeper 属于 MAC-09；生产调用链接入（query worker 回收后的 lease 释放、先 track 后服务、BuildPlan 携带 builder capture 的 contentManifestId、旧 reconcile/VACUUM 种子路径删除）属于 MAC-08。

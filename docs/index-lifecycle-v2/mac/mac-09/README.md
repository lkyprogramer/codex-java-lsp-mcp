# MAC-09 / G09

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

## 源码变更

| 提交 | 内容 |
|---|---|
| `59b4ec1a` | 原生 watch helper 用 IOKit 把系统唤醒作为 `{"kind":"resume"}` 上报（native 协议 v2），tracker 收到后要求下一轮全量 hash |
| `464dae10` | `SnapshotStore.sweep()`：每个 GC 周期遍历 workspaces/、jobs/、snapshots/，全部删除走 `tryReclaim`；workspace binding 只在 root 已不存在（被替换，或所在卷仍挂载时缺失）且没有 tracker/job/lease 时删除；job 先登记再建目录。`IndexOwner` 在 open 时做恢复 sweep，之后每 30 s 一次；10 分钟周期全量 hash；隔离验证专用的故障屏障 |
| `ae5995c6` | owner 启动器下，semantic 由私有 Gradle 域把关：版本取自 home 的 `daemon/<v>`，配置每次清理时重读；启动时清理，失败后由 semantic 请求触发重试（间隔 ≥30 s），正常停止时按“关准入 → 关 JDT → `--stop` → 确认”的顺序执行。`java_status` 报告 `semantic`；required 位置请求和 auto 的 seed 在阻塞时显式失败 |
| `72b7750f` | 正式恢复与故障矩阵 harness（隔离 launchd owner，真实 HTTP daemon） |
| `63446ba0` | 正常停止顺序测试要求 session 关完才开始 Gradle 清理；清理等待加上限 |
| `01d9e1d7` | 修独立评审的 P1/P2（见下） |
| `e98d1f2e` | harness：故障时所有 daemon 都计时；GC 收敛从新实例 ready 起算；semantic ≤10 s；挂起请求必须失败 |

## 独立评审第一轮（`63446ba0`）FAIL 及修复

第一轮全部 broker 运行均通过（run root `20261019T033947Z`，有 `not-composed.json` 和该轮 `independent-review.json`），但独立源码评审判 FAIL：

| 级别 | 问题 | 修复（`01d9e1d7` / `e98d1f2e`） |
|---|---|---|
| P1 | 旧缓存 janitor 把 `<cache base>/mac1` 当成无 repo-meta 的孤儿缓存：mtime 超过 1 h 就递归删除整个 owner store（MAC-07 起就存在；harness 每个实例都不到 1 h，所以测不到） | janitor 跳过 `OWNER_STORE_DIR` |
| P2 | 没有 owner 锁的进程（非 launcher）也跑 GC，会把同一 store 上活进程的 job 和未绑定快照当作遗留物删除 | 无锁时 `gc: false`：不做恢复 sweep 和周期 sweep，只回收本进程自己 supersede 的快照 |
| P2 | semantic 未 READY 时，auto 仍交付上一实例持久化的 JDT 边，违反 §2.1“不复用旧 JDT 结果” | 持久化语义证据先过 semantic admission |
| P2 | ≤10 s 的 EXTERNAL_BUILD_DAEMON 断言只看第一个 daemon | 故障时记录全部 daemon，逐个计时 |
| P2 | 客户端已死、daemon 还没写 registry 时，`--status`/`--stop` 都看不到它 | 5 分钟内新建的 `daemon-<pid>.out.log`，若 pid 存活且命令行是该版本的 GradleDaemon，就重试 `--stop`，直到它消失或到期 BLOCKED；只观察，不 kill |

## 验证（源码 `342fa796…` = HEAD `e98d1f2e`）

| 项 | 结果 |
|---|---|
| env-probe | READY |
| final-g09 | 238/238 |
| regression-g09-dist | 1530/1530 |
| regression-g09-scripts | 573/573 |
| 独立复验（另一执行者、另一构建） | 116/116：恢复、矩阵、owner 锁/传输/协议边界、GC、store、Gradle 域、janitor、semantic；身份与主测一致，validation root 不同 |
| mutation 矩阵（dev 档） | 16/16 有效变异被杀（另 3 个被替代/无效） |
| 独立评审 | PASS（`342fa796…`），openFindings 为空，第一轮 5 项全部关闭 |
| 资源与归档 closeout | PASS（独立复核 PASS）：219 个登记 pid、64 个进程组、47 个 launchd 任务全部退出；归档 614 个文件逐个 hash 校验；生产缓存、Application Support 与 LaunchAgents 未改动 |

正式恢复（final-g09）：

- **活动 builder/query/base lease 中杀 owner：**
  - owner 进程组 475 ms 退出，故障时唯一存活的 Gradle daemon 2420 ms 退出，两者从同一故障时刻计时；
  - 挂起请求 12 ms 以 `fetch failed` 结束；
  - semantic 在故障后 2828 ms 回到 READY；
  - 死亡实例的 2 个 job 在新实例 ready 后 1752 ms 删除（两个 GC 周期为 3000 ms）；
  - binding 不变，静态查询正确，semantic 恢复。正常停止后没有 Gradle daemon。
- **Gradle 清理失败（冻结 launcher 摘要不符）：**
  - 新实例只在旧进程组退出后启动；
  - 静态快照/hash/coverage 正确；
  - required 5 ms 报 `semanticState=RECOVERY_BLOCKED`；auto 返回静态结果并带 JDT_NOT_READY 缺口；
  - 阻塞期间没有新 JDT、没有新 daemon，Gradle home 没有删除任何东西；
  - 修好配置后，第一次越过 30 s 下限的 semantic 请求触发清理，旧 daemon 退出后 semantic 才恢复。
- **故障矩阵：**
  - 8 个存储边界，即 clone、builder SQL、checkpoint、manifest、binding tmp、binding rename、reclaim、query lease；
  - 外部 SIGKILL 后进程组 10–38 ms 退出；
  - binding 在 rename 之前为旧、之后为新，且完整、hash 匹配；
  - 有 job 的 6 格，死亡实例的 job 在 ready 后 546–570 ms 删除（两个 GC 周期为 3000 ms）；reclaim-marked 与 query-leased 两格没有遗留 job。
  - 唤醒格：唤醒后的 full-hash 轮次被屏障挡住时状态为 STALE，放行后为 FRESH。

## 必须同时知道的

- **真实睡眠/唤醒没有跑（NOT_RUN）：** 唤醒由测试钩子重放（`ILV2_NATIVE_TEST_HOOKS=1` 下发 SIGUSR1），直接调用 resume 输出，绕过 IOKit 回调的消息分派和 `IOAllowPowerChange` 应答；协议只证明注册成功。真机 sleep/wake 探针归 MAC-17/18。
- **没用 G01 runner：** 卡片 scope 列出的 `scripts/ilv2-mac-fault-matrix.mjs` 依赖 driver 协议屏障，本卡的矩阵是 node 测试（`scripts/ilv2-mac-recovery-matrix.test.mjs`），用产品内的故障屏障。矩阵缺 sealed-verified 和 snapshot-renamed 两格。
- **lease 和两周期的单元证明：** 实机 harness 里的 lease 检查针对已绑定快照，本来就受 bound 保护；lease 不消失、两个周期内收敛的证明来自 `snapshot-store.test` 和 `owner-gc.test`，实机只证明死亡实例的 job 在 ready 后两个周期内清掉。
- **无锁进程的回收范围：** `gc: false` 仍会回收本进程自己 supersede 的快照（MAC-07/08 原有行为）；如果另一个进程正 lease 着这份快照，这仍有风险。生产 LaunchAgent 迁到 owner launcher 前（MAC-17）一直是这个状态。
- **观察类断言的局限：**
  - `previousGroupsAlive` 是新实例自报的值；
  - “阻塞期间无新 JDT”只在一个时间点看 owner 的直接子进程；
  - 矩阵不带 Gradle，closeout 不检查 daemon。
- **遗留的过期注释：** `owner-lock.ts` 原注释“Legacy transports are migrated in MAC-09”已改写。生产 LaunchAgent/launcher 迁移归 MAC-17/18（`scripts/render-launch-agent-plist.mjs`）。
- **部署前提：** 生产没有 `JAVA_LSP_GRADLE_DISTRIBUTIONS` 也没有 `JAVA_HOME` 时，首次 wrapper import 之后会一直 RECOVERY_BLOCKED（fail-closed）；wrapper launcher 的 sha 是自哈希。这两点归 MAC-17 的部署配置。
- **G02B 不重跑：** native 改动只涉及 `fsevents.h` 和构建参数（加 IOKit），锁与 launcher 代码未变；G02B 的 launchd/native 锁测试在 regression-g09-scripts 里用新 native 二进制跑过。
- **第二轮评审新增的 P3（接受，不改源码）：** `defaultIndexOwner` 的 `gc: owned` 接线没有测试或变异覆盖；启动中 daemon 的扫描不校验 Gradle home（同版本、跨域、pid 复用时会重试到期限后报 BLOCKED，fail-closed，不 kill）；两周期锚点在两格上为空集；矩阵 GC 周期 1.5 s，两周期 3 s 的判定窗口偏紧。
- **closeout 的 pid 复用：** 第一次 `--finish` 报 `owned process still alive: 1017`，几秒后重试通过，此时 pid 1017 已不存在。主机 pid 已回绕，判为无关短命进程复用了 pid；退出检查只比 pid，不绑定启动时间。
- 其余 P3 及建议 owner 见 task-result 的 notClaimed 和 run root 的 `independent-review.json`。

## 历史 run root

| run root | 原因 |
|---|---|
| `mac-09/20261019T033947Z` | 全部通过（final 195/195、dist 1526/1526、scripts 573/573、复验 73/73），但独立评审在 `63446ba0` 上 FAIL（1 P1、4 P2） |

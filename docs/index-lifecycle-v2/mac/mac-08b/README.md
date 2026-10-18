# MAC-08B / G08B

唯一结果见 [task-result.json](task-result.json)，状态由 [status.json](../status.json) 汇总。

生产代码在 `a56f44f8` 提交（MCP 工具切到 owner request view，stdio 只转发），之后三处修复：`fc2ee722` 不再对每个请求同步打 repo cache 戳（K29 首次失败的根因），`e6e7a5eb` 让 `status(start=false)` 不做任何 cache 戳（meta I/O、git spawn），`4c678f1a` 跳过经 symlink 到达的内容根并把它们记为 DEGRADED 覆盖缺口：
- stdio 入口不构造 runtime（`src/server.ts`、`src/stdio-owner-proxy.ts` 的 runtime import 都是 0），只把请求转发给唯一 owner；没有显式 repoRoot/file 的本地调用用 cwd 补全，server-wide 调用保持 server-wide；取消会中止对应的转发请求。
- `status` 不带 start 时只读内存（合同 §2.6），不启动 workspace、不读写 meta、不 spawn git；带 start 时仍受 15 s 预算约束。
- 新调用图和旧 runtime 在同一批提交里替换：删除 11 个文件（builder-supervisor、builder-main、layout-manager、repo-change-coordinator、repo-fs-watch、vacuum-into 等），D01、D04、D07 残留、D09 runtime 部分在 HEAD 的 src/scripts 中匹配数为 0，清单见 run root 的 `g08b-deletions.json`。D05 安装脚本仍被 `install-runtime.sh` 调用，按台账保留，归 MAC-17。
- symlink 内容根（仓库内、指向另一个根、指向仓库外）不再走成伪 FRESH 或构建失败：probeLayout 不遍历它们，覆盖表记 DEGRADED，buildState 为 DEGRADED。

MCP 合同测试 `status-only-does-not-bootstrap`、`stdio-http-share-one-owner` 在 final-g08b 中。

验证（在 `afb36e10…` = HEAD `ae90151d` 上）：final-g08b 114/114，regression-g08b-dist 1503/1503，regression-g08b-scripts 570/570，均无 fail/skip/cancel；dev 档 mutation 矩阵 13/13 被杀（B3 首版存活后由 B3b 取代；B13 在加入“探测发生在 hold 内”的断言前存活）。独立评审 PASS：12 条关闭，20 条 accepted limit，无 open finding。

`9bfcbb2f`、`08b1301f`、`ae90151d` 只改测试 fixture：builder 测试原先用 SIGSTOP 冻结 builder 再用 lsof 读 fd4，lsof 在这台主机上会对这些 fixture 进程成批卡在不可中断等待里（从 owner 或测试进程发起都会，独立实验 270 次无一次卡住，内核层根因未证实），一次卡死还让 launchd closeout 失败、遗留 quota slot，导致整轮运行挂起约 5 小时。现在 owner 用 DB 写锁 hold builder，测试进程用 `proc_pidfdinfo`（经 `/usr/bin/python3` ctypes）读 builder 的 fd4，比对 dev:ino 与 owner 的 `fstat(4)`，并断言路径是 `.owner.lock`。

历史 run root（均有 `not-composed.json`，不组合）：`20261017T090447Z`、`20261017T092232Z`、`20261018T023044Z`、`20261018T024255Z`、`20261018T031501Z`、`20261018T034818Z`、`20261018T092541Z`，原因依次是测试假设导致的 2 个回归、G08C K29 暴露的同步 cache 戳、评审 P2（status 打戳）、评审 FAIL（symlink 内容根）、SIGSTOP+lsof 卡死、owner 侧 lsof 卡死引发 quota 连锁挂起、测试侧 lsof 也卡死。G08C 的 K29 失败记录 `runs/mac-08/20261018T022250Z` 属于 G08C。

不声明的部分：K29 请求路径容量和三仓严格 p95 比例属于 MAC-08C，本源码上未运行；10 分钟周期 full hash 定时器未接入：tracker 的 status() 不因 full hash 过期而变 STALE，到期的 full hash 只会随下一轮文件系统信号（或重启、新 epoch）执行，FRESH workspace 上的请求不会触发它（P2，MAC-09，G11 之前必须落地）；symlink 内容根只报覆盖缺口不索引，且 symlinkedRoots 不进 layoutKey/fingerprint，覆盖标签可能滞后（MAC-13），publish 不交叉核对 tracker census 与 builder capture（MAC-11）；K driver 与 JDT 合同脚本仍在旧入口（MAC-14）；G06C 在 query pool 重写后没有重跑（MAC-14）；两个 builder 测试依赖 Command Line Tools 的 `/usr/bin/python3`，缺失时会明确失败。其余评审发现作为带 owner 的 accepted limits 记录在 run root 的 `independent-review.json`。

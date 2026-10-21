# MAC-11 / G11

**G11 PASS，`performanceReady=false`。** 五项硬门通过，所有性能项已完成足量实测；五项性能 FAIL 留给 MAC-12。门记录见 [task-result.json](task-result.json)、[status.json](../status.json)，逐项统计见 [measurements.json](measurements.json)。测量完成不表示性能达标。

## 改动

- 静态 symbol / evidence 使用本次请求持有的 `indexView`。STALE 或覆盖不完整时返回 PARTIAL，保留已验证正向证据，不能给确定的否定回答；旧响应标签不随后台发布改变。
- census 分歧保留可用绑定和 pending，通过既有 full-hash 路径追赶未提示变化。build-key 拒绝保留旧绑定和待处理变化，输入稳定后重试收敛。
- 删除没有消费者的 `isGitWorktree` 元数据及其同步 Git 探测，保留缓存归属、合并与请求时间戳语义。
- full 服务时间关联 owner、workspace、job、round、快照及首次正确查询，计入封存和发布，排队单列。实际 full / escalation 不填充 seed 样本。
- 计时窗口两端均要求绝对 `load1 < 20`；保留全部尝试，足量后使用全部有效慢、快样本。环境 INVALID 不计有效数量，缺证、失败和右删失仍阻断。有限补测复用已有 runner，不重复完整矩阵。

## 验证

最终源码 `dff8bef922c09183729361d8e3b4529fbfa27bd45a3bf9c3a390a0834b1a6a2c`，基于 `52d44cb6`。本机工作根为 `/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac`，本轮 `runs/mac-11/20261021T074300Z`。

- 原 `performance-g11`：26,928 次调用，五硬门 PASS；因有效性能样本不足，原 broker **FAIL 保留**。只复用核实过的唯一“测量不足”失败，不把任意退出 1 当作可复用证据。
- `supplement-g11-01/02`：10,508 / 569 次调用，只补缺口；每轮实际 bootout=0、进程组退出、无兜底清理。补测自身为 NOT_GATED，跳过的 restart / fairness 不记 PASS。三轮共 **38,005** 次调用均检查原请求截止。
- `supplement-g11-gate-proof`：实际原始证据聚合证明 **1/1 PASS**。核对输入、broker、源码、运行时、实际编译/native 字节和原始文件摘要后合并；原五硬门不跨失败片段拼接。
- `independent-supplement-g11`：独立目录新构建，**37 PASS、2 SKIP、0 FAIL**。两条真实长测/聚合证明在该定向运行中明确 SKIP，另由上述真实运行完成。独立源码、原始断言及统计复核 PASS，0 个未关闭 finding。
- 新旧候选 441 个编译 JS、native 字节和运行时身份一致。复用旧 89 条产品测试、61 条缓存测试、真实六仓 60 秒刷新边界及独立 STALE / census / build-key / 锁 / builder / stdio / HTTP 证明；没有重跑或冒领新全仓 PASS。
- 历史源码漂移、夹具冷启动失败、804f 的真实 4031.79 ms 请求超时、错误选择器中断均保留。睡眠告警误抓了无日期的开机统计；准确窗口的 602 条带日期记录无睡眠事件，独立复核一致，负载 INVALID 仍原样排除。

| 测量 | 有效样本 | 实测 | 门 | 结果 |
|---|---:|---:|---:|---|
| full 服务 p50 | 3 | 203.192 s | ≤327.9 s | PASS |
| ≤20 seed 首次正确 p95 | 20 | 56.456 s | ≤5 s | FAIL |
| 21–200 seed 首次正确 p95 | 20 | 72.780 s | ≤15 s | FAIL |
| full 中短作业排队 p95 / max | 6 | 0.142 / 0.142 ms | ≤2000 / 5000 ms | PASS |
| full 交接 max | 1 | 8 ms | ≤5000 ms | PASS |
| 单文件 build p95 | 34 | 3.689 s | ≤2 s | FAIL |
| 编辑首次正确 p95 | Java 20 / XML 10 | 63.198 s | ≤3 s | FAIL |
| heartbeat 最大间隔 | 2405 | 2311 ms | ≤2000 ms | FAIL |
| status(start=false) p99 | 19803 | 132.054 ms | ≤200 ms | PASS |
| 零差量写入 | 3 | 0 | 0 | PASS |
| 20 文件物理增长 p50 / full | 14 | 0.786% | ≤10% | PASS |
| 200 文件物理增长 p50 / full | 3 | 28.818% | ≤30% | PASS |

full 共尝试 7 次，其中 4 次环境 INVALID；两档 seed 各保留 22 / 24 次 INVALID。其余尝试数、无效数及每组下限见 measurements。各组缺证与右删失均为 0。新 full 有效窗口 load1 为 2.43–3.51，历史基线为 15–21；满足现有门，但不宣称同负载受控相对提速。

## 收尾及下一步

统一 closeout 和独立复验均 PASS：**332 PID、20 个拥有的进程组、17 个 launchd job** 实际退出，配额释放；无未登记路径，过期残留 0 字节，RAW / BULK 原件已清理。归档实际解包后逐文件校验 **361 文件、204,065,452 字节**，SHA-256 `045f1043e15e3d7baad60937d24bcbd49d9dc282d9ab6d3b58160e6bee23a1e6`。macOS tar 消费的 AppleDouble 元数据差异亦保留诊断。归档、摘要、清单和独立校验在本机 run 的 `closeout/`，不进仓库。

MAC-12 优先处理实测封存发布：低负载补测 delta publish p50 **48.63 s**，其中 manifest **38.74 s**、verify **9.50 s**。继续保留逻辑、coverage、原子发布和退出合同，并处理上述五项实测性能 FAIL；G12 仍需满足全部适用绝对门。

build-key 竞争防止与浪费消除、封存并发/超时尚未实现。非 oracle 查询、跨文件混捕获穷举等历史限制见 task-result 的 `notClaimed`。没有安装、部署或 push。

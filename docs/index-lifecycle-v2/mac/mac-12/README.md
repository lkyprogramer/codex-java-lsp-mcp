# MAC-12 / G12

**IN_PROGRESS。** G11 已通过并本地提交 `4cfa0402`。方案B实现与此前封存候选一并本地提交（未 push）；G12 全部适用绝对性能门尚未实测，`performanceReady=false`。门状态见 [task-result.json](task-result.json)、[status.json](../status.json)。

## 方案B：发布前增量检查，全库校验放后台（2026-10-22，按用户要求）

用户 2026-10-22 接受方案B，并据此修订[合同§2.7](../../../deep/ilv2-mac-manual/contract.md#27-封存绑定读-lease-与-gc)。修订原因：每次 seal 都按全库成本（O(DB)）检查 572 MB 的库，上述最好候选的完整 seal 仍需 3.5–4.6 s，而编辑可见门要求 p95 ≤ 3 s；继续调全库校验过不了这个门。下文所列旧试验的结论不变。

- **full 构建**（空 job）：发布前的完整检查不变（global quick、逐表 integrity、FK、census、逻辑行），再加文件 sha256。结论写入 `mac1/verified/<snapshotId>.json`，状态为 VERIFIED。
- **delta/rescan**（克隆 base）：发布前只做：
  - checkpoint 和无 sidecar 检查；
  - census/pipeline/schema 完整性检查；
  - 本次写出行的检查：安全整数、引用存在、facts 可解码。这些行包括 generation 等于本次 indexedGeneration 的 file 行；挂在这些 file 下的 type、field、method、edge、type_ref_name；经 owner 索引查到的这些 file 拥有的 kg_node、kg_edge 及其 owner 行；全部 mybatis_resource。

  不做文件 sha256。manifest 升级为 `ilv2-snapshot-manifest/mac3`，去掉 `file.sha256`；旧格式（包括 mac2）的快照在恢复时隔离，再重建。
- **后台校验**（`snapshot-verifier.ts`）：每次只查一个仍被绑定、还没有结论的快照，用 1 个 reader，在最后一次发布后静默 2 s 才开始。快照不再被绑定时跳过；被新发布取代时，查完当前表后停止。
  - VERIFIED：写入结论。
  - FAILED：隔离该快照，以及共享它的全部绑定和由它派生、尚未校验的快照，这些工作区进入 NOT_READY。由它克隆的在途作业拒绝发布（`base-failed`），这一点在 base 被回收后依然成立。工作区下一轮必须做 full 构建，不回退到旧快照。
- **零差量和 seed**：未校验的快照也可以作为来源，它的 FAILED 结论作用于所有共享者。已校验快照做零差量绑定时，按结论中的 sha256 重新哈希比对。

**Tier-0 私有探针**（不作为证据，NOT_GATED）：在登记的 572 MB 基线库的 APFS 克隆上，调用真实的 `sealJobDatabase(mode:"delta")`，每档 3 次。起止 load1 为 9.3→8.5，接 AC 电源。

| 改写文件数 | delta seal 墙钟 | 其中检查 | 旧完整 seal（上表最好候选） |
| --- | --- | --- | --- |
| 1 | 118–125 ms | 63 ms | 3.5–4.6 s |
| 20 | 225–234 ms | 169–175 ms | 同上 |
| 200 | 807–816 ms | 755–760 ms | 同上 |

后台完整校验用 1 个 reader，单次 17.2 s（含 hash 0.4 s），不在编辑可见路径上。第一版按 generation 全表扫描 kg_edge 和 kg_node（各 55.8 万行、16.8 万行），delta seal 约需 1.07 s；改为经 owner 索引限定范围后，降到上表的数值。探针脚本是 `scripts/ilv2-mac-delta-seal-probe.mjs`；原始输出只存放在私有工作根 `runs/dev-mac12/` 下。

**验证状态。** 以下为 Tier-0 结果（开发循环，不作为门证据）：

| 验证项 | 状态 |
| --- | --- |
| java-index 和 index-builder 下 56 个测试文件 | 449/449 PASS |
| 新增 store 测试 | PASS |
| 新增 owner 测试 | PASS |
| 新增 scoped validation 测试 | PASS |
| G12 端到端实测（编辑可见、0/20/200 物理、full/seed、公平性、查询） | 未运行 |
| 脚本回归（含 recovery matrix） | 未运行 |
| 独立评审 | 未运行 |

新增 store 测试覆盖：
- 改动行或 owner 图行损坏时，发布前拒绝，旧绑定不变；
- 未改动行损坏时，先发布，后台 FAILED 后隔离（包括零差量共享者）；
- 派生快照和在途作业返回 base-failed；
- 结论持久保存、重启后保持隔离；
- full 重建后可回收；
- 中止时不写结论；
- sweep 清理孤立结论和死 tmp；
- verifier 的跳过、停止和 reader 退出。

新增 owner 测试覆盖：delta 发布在后台得到 VERIFIED；注入的未改动行损坏使 FAILED 结论隔离工作区，下一轮 full 重建后恢复 VERIFIED。

[facts 验证继承提案](facts-validation-proposal.md)已被方案B取代，不再实施。

当前封存候选删除无生产消费者的 manifest 全库逻辑摘要，格式明确升为 `ilv2-snapshot-manifest/mac2`，严格拒绝旧格式，不增加兼容分支。旧绑定恢复时隔离，待验证发布替换。原摘要隐含的孤立引用、标量安全整数、facts BLOB/deflate/JSON 检查留在 seal verify；SQLite integrity、外键、census、绑定 CAS、原子发布和 lease/GC 保留。独立 full/delta `logicalDigest` oracle 的算法与校验要求不变。

已完成的同库交替测量如下，每项均为三组、六次有效样本，起止 `load1 < 20`，数据库字节不变，全部原始慢值和无效记录保留。成本范围不同，不能跨行直接比较。

| 方案 | 成本范围 | 原有 → 候选中位数 | 改善 | 裁决 |
| --- | --- | --- | --- | --- |
| 既有 driver 连接策略 | verify＋manifest | 44.748 → 44.119 s | 1.407% | 拒绝，未采用 |
| 数组行投影 | manifest | 38.849 → 33.553 s | 13.632% | 拒绝，已撤回产品试验和专属测试 |
| 删除无消费者摘要，保留显式数据检查 | verify＋manifest，含全部新增检查 | 43.807 → 15.516 s | 64.581% | 支持保留候选，NOT_GATED |
| 引用去重，父表仍分别验证 | verify＋manifest | 15.678 → 10.745 s | 31.465% | 支持保留候选，NOT_GATED |
| 全局有界的逐表并发校验 | 完整 seal，含规划、等待、hash 和持久化 | 11.398 → 4.583 s | 59.795% | 三组各改善 58.618%／61.994%／59.619%，NOT_GATED |
| method facts 四分片，仍共用四 worker | 完整 seal，相对上一整表四 worker 候选 | 4.376 → 4.412 s | 无改善 | 三组 +0.579%／−0.972%／−4.505%，拒绝并撤回试验 |
| 全局封存上限 4 → 6 | 完整 seal，相对整表四 worker | 4.433 → 4.183 s | 5.654% | 三组 5.654%／6.776%／14.568%，拒绝并撤回上限改动 |
| inflate 输出块 16KiB → 1KiB，仅诊断 | 串行 SQL 迭代＋inflate／UTF-8／JSON | 4.054 → 4.301 s | −6.088% | 三组均变慢，产品解码器未改 |
| method facts 范围＋固定六 worker | 完整 seal，相对安全四 worker | 4.495 → 3.565 s | 三组 20.230%／19.379%／22.653% | 中间组不足 20%，拒绝并撤回组合 |
| facts 严格 JSON 语法检查 | 完整 seal，相对安全四 worker | 4.365 → 4.078 s | 三组 10.143%／5.071%／5.820% | 均不足 20%，拒绝并撤回试验 |

已完成证据的第一候选 `e5b2382724e3a68e7504b4494768796c5d65428aa30d5cbd270694963a7f1b91` 正式定向测试 **28/28 PASS**，比较 **1/1 PASS**。覆盖损坏数据拒绝发布且旧绑定不变、旧格式隔离重建、原有原子发布/SIGKILL、lease/GC，以及离线 full/delta 等价。比较核对全部公共 manifest 字段、独立逻辑摘要和数据库字节；仅显式格式版本及移除字段不同。源码及原始证据均已独立只读复核，评审者未执行新测试。首个减法候选的安全整数保护遗漏在正式测量前已修复、复核。

**上述收益仅证明同库校验＋manifest 成本下降，不能判 G12 PASS。** 引用去重后仍约 10.75 s；编辑可见 3 s、两档 seed 等五项 G11 实测 FAIL 尚未解决。校验分项诊断已完成：原串行完整性检查约 4.54 s，其余主要是引用检查和 facts 解码。计时惰性迭代的每次 `next()`，区分 SQL 与调用方解码，查询计划在计时之外采集。不重跑完整 owner 或无关全仓矩阵。

本机 run：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-12/20261021T181104Z`。上一批主机接电、无睡眠且进程退出已复核；本轮最终归档逐文件校验、closeout 仍待执行。未安装、部署或 push。

引用去重候选 `cd6da982bef78a30c722de9f537d8afc6e29b046f78479cf4197e9774b647612` 的正式定向 **29/29 PASS**，比较 **1/1 PASS**；三组六次全部有效，完整 manifest 严格一致，离线逻辑 oracle 和数据库字节不变。单次健康库成本探针 **1/1 PASS**，覆盖 global quick 和全部 22 张 schema 表的完整检查；它只证明健康库成本，不能证明损坏检测等价。

已测的并发基线采用全局最多 4 个封存 worker：global quick 加每张表的完整 integrity（包含 sym、meta、内部表和 sqlite_schema），并保留外键、census、孤立引用、facts 和安全整数检查；遗漏或重复结果均拒绝发布。所有读取使用只读连接，checkpoint 后到 hash/manifest 完成期间的文件变化会被拒绝。worker 只有成功回复且实际 exit 0 才释放名额，批失败等待全部退出。固定 SQLite 3.49.1 的源码覆盖分析不是官方组合保证；六类小型健康/损坏库与原 full 检查对照均已接实际 worker 路径，并验证 quick-only 会漏检的错误索引键。三个受影响测试文件正式运行 **38/38 PASS、0 skip**，原始 TAP 已独立只读复核；源码评审为 PASS_FOR_MEASUREMENT，评审者未执行测试。

并发候选的正式比较 **1/1 PASS**：同一登记数据库的私有 APFS 克隆，三组交替调用原版与候选的真实 `sealJobDatabase`。计时包含 checkpoint、规划扫描、worker 等待、全部检查、hash、manifest、fsync 和 rename；克隆准备另记。六次均有效，完整 manifest/文件字节一致，每次新封存后的 worker 都为 active=0、queued=0、peak=4，原库字节和登记逻辑摘要不变。相同的预先 SHA 读取会预热缓存，因此该结果不代表冷启动或 owner 端到端性能。原始结果与实际退出已独立只读复核，评审者未执行测试。

实际代价是 CPU 时间中位数增加 **35.577%**。完整封存仍为 **4.38–4.60 s**，verify 为 **3.83–4.14 s**，不能判编辑可见 3 s 或 G12 通过。后续仅运行一次逐表串行诊断和有界分片比较；未重跑无关全仓测试或完整 owner 矩阵。

逐表诊断 **1/1 PASS**，19 张逻辑表的计时合计与整体 6.152 s 对齐。method 单表 **3.113 s**，其中 66,969 行 facts 原生迭代为 **146 ms**；这支持其主要成本在调用方解码的判断，但不是并行 worker 时间线。原始结果、覆盖和退出已独立只读核验。

method facts 分片试验的正式定向 **40/40 PASS、0 skip**，比较 **1/1 PASS**，六次计时全部有效；但三组完整封存成本没有达到每组至少 20% 收益。该试验的产品代码和专属测试已撤回，补丁及实际慢值保留，独立只读复核确认拒绝。相近的 CPU/wall 比例只支持四 worker 下分片没有整体收益，不能证明主机 CPU 或内存带宽已饱和。

封存上限 4 → 6 的试验没有达到每组 20% 收益，已撤回为 4；全部六次有效样本和慢值保留。测量前的开发验证发生一次真实 `SIGABRT`：坏 facts 触发批取消时，强制 `Worker.terminate()` 可能打断 zlib 初始化，退出清理触发 Node 22.16 原生 CHECK。系统崩溃栈已核实，但具体线程交错仍属推断；原四 worker 也使用该路径，不能将其归为性能 INVALID。

必要的协作取消修复保留：当前任务完成后不再领任务，关闭 SQLite 并正常退出；排队取消、原始错误和全部实际退出仍须确认。冻结的 6-worker 候选两份受影响测试正式 **30/30 PASS、0 skip**，新增真实坏 facts 批次证明不调用强制 terminate、错误保留且资源归零；比较 **1/1 PASS** 只表示诊断执行成功。原始 TAP、身份、全部计时和 8 个实际退出 PID 已独立只读复核。协作取消等待当前任务完成，不声称即时截止。撤回为 4 后，上限、坏 facts 批和旧绑定三条直接回归正式 **3/3 PASS、0 skip**，证据已独立复核。

facts 解码成本诊断正式 **1/1 PASS**，六次样本全部有效；1KiB 输出块三组分别慢 **6.214%／5.793%／6.088%**，因此关闭该假设，产品 `decodeFacts` 未改。每次处理全部 162,896 条 facts，逐行解压字节一致；长度 p50 为 1,699B、p95 为 18,026B，只有 36.13% 不超过 1KiB。原库字节、TAP、采样和 8 个实际退出 PID 已独立只读复核。这是串行解码成本，不是实际分配次数或并行封存瓶颈证明。

实际四 worker 时间线诊断 **1/1 PASS、0 skip**，24 个任务与全部表及真实 ACK 一致，7 个线程 exit0、5 个进程 PID 已退出，证据已独立只读复核。但起止 load1 为 **21.810→20.384**，本次必须保留为 **INVALID_EXPERIMENT**，不能用 4.422s 判性能。记录包含探针开销，末任务还含连接关闭；`wall − all/get` 包含 prepare、iterate、解码、调度等，不能标为纯解码。

源码和实际 FK 清单可覆盖 12 项直接、2 项传递引用检查，但有效旧诊断中它们合计仅约 484ms 串行成本，尚无支持删除检查的整体收益证据，因此未改。

实际 worker CPU 诊断 **1/1 PASS**，四份非空 profile 的 SHA、全部任务/ACK 和真实退出已独立复核，负载边界 **12.317→11.491**，属于有效诊断。采样权重合计 14.263s，SQL `all/get` 自占合计 68.335%，`decodeFacts` 自占 17.953%、`processChunkSync` 6.775%；method 线程后二项分别为 64.486% 和 15.337%。采样权重不是进程 CPU 时间，`decodeFacts` 自占不能全归给 JSON.parse；4.496s 带探针耗时不能用于性能门。

随后仅试验了已有的 BigInt facts 范围与固定六 worker 的组合。正式定向 **41/41 PASS、0 skip**，比较 **1/1 PASS**、六次均有效，但中间组收益 19.379% 未达 20%；完整封存仍需 **3.504–3.585s**。因此已归档补丁，将六个产品文件逐字恢复到安全四 worker 候选，保留协作取消修复。原始结果、身份与 9 个实际退出 PID 已独立只读复核；未重跑挑选样本。

facts 严格 JSON 语法检查试验保持四 worker 及原调度顺序，只减少校验时构造完整 JS 对象的工作。解压和 UTF-8 转换复用原路径；`json_valid(?,1)` 配合实际 NUL 和 false 结果的原 `JSON.parse` 分支，保持隐藏尾部拒绝、超过 SQLite 1000 层限制的接受行为及原错误。正式定向 **40/40 PASS、0 skip**，包含 NUL、JSON5 拒绝真实发布及旧绑定保护。比较 **1/1 PASS、6 VALID**，但三组收益均不足 20%，完整 seal 仍需 **4.055–4.143s**。已归档试验补丁，仅将四个产品及测试文件逐字恢复到安全四 worker 基线；编码、schema、逻辑导出和全部校验不变。

同一脚本按条件追加一次实际 CPU 诊断，**1/1 PASS**，四份 profile 哈希、24 个唯一任务/ACK、七个 worker exit0 已独立只读核验，11 个相关 PID 实际已退出，主机接电且无睡眠。诊断显示成本分散到多路完整性和引用校验；method 后仍有 sym，最晚线程还承担 common。`all/get` 样本包含 integrity、引用检查和 json_valid，不能全归为 JSON；带探针耗时不是性能门。此次定向、比较、诊断和实际退出均已独立只读复核，评审者未执行测试。

只读可行性核对也排除了直接按 `factsMoved` 免检：该集合只覆盖部分解析闭包，未涵盖先前的 `writeBundle`、XML、删除和 full 路径。`BuildJob` 没有传给 seal 的基线验证凭据或完整行写集合；输入 content/build 身份不能证明候选 BLOB 未变。直接跳检会绕过坏压缩或坏 JSON 不得替换旧绑定的保护，因此未实施。后续先核对物理布局，暂不继续调 worker 数量、任务顺序或重复测量；不将现有耗时误称为已经证明的理论下限。

一次只读 dbstat 核对已完成，原库 SHA 前后一致、进程实际退出：572,321,792B 数据库没有空闲页，压缩 facts 共 114,376,836B，约占 20%；sym 表约 100.86MB，entity_token 及其 lookup 索引约 77.62MB。这只说明物理分布，没有布局或 codec 优化收益证据。新的[受限 facts 验证继承提案](facts-validation-proposal.md)已经独立只读评审，但涉及 clone/base lease/seal 验证合同，等待用户决定；未实施、未启动新一批测试，G12 保持 IN_PROGRESS。

首个完整封存比较在计时前准备克隆时失败：固定 Node 的 `copyFile(COPYFILE_FICLONE_FORCE)` 返回 `ENOSYS`，未取得任何 seal 耗时；原始 FAIL 保留。只修测试准备步骤，改调产品已有的原生 `cloneSealedDatabase`，没有普通复制 fallback。补跑前重新冻结 helper；全部 dist JS、runtime 和 native 身份相同才复用上述 38 项证据，只补失败比较。

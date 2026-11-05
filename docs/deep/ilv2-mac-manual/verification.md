# ILV2-MAC 验证工具与验收门（§5–§6）

[索引](../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · 门状态见 [`status.json`](../../index-lifecycle-v2/mac/status.json)

## 5. 验证工具与输入规格

### 5.1 当前可用命令与新增 CLI 的边界

MAC-02A已将native builder和runtime manifest校验接入普通构建、隔离/当前三仓候选、v4及K入口，并让安装预检使用同一冻结Node。shell入口显式使用绝对Node并清宿主加载/输出环境及测试IPC上下文。正式证据记录实际`process.execPath`、binary digest和完整`process.versions`；缺manifest或运行时不匹配均阻断门。完整产品门和生产安装仍需其后续任务验收。

`ILV2_NODE_BIN`是执行命令的任务变量，`runtime.json`中的可执行身份才是真源。shell broker校验该路径和`ILV2_RUNTIME_MANIFEST`，保留原六项环境清理并移除`NODE_TEST_CONTEXT`，不回退PATH。JS binder在任何嵌套分支返回前将字面`node`重绑定为当前绝对`process.execPath`；quoted test glob在编译候选中展开。安装器使用同一manifest及冻结Node安装中的npm-cli，不重新查PATH；`--preflight-runtime`只读返回身份。实际另一Node的PATH漂移证据已保留；普通测试自建私有execPath fixture，不另加必须安装备用版本的前提。

**两级开发循环。** Tier-0用于迭代：`sh scripts/run-isolated-node.sh scripts/ilv2-mac-dev.mjs [--name <tree>] [--env K=V] [-- node --test <文件>]`，需先设好下方模板中的`ILV2_NODE_BIN`、`ILV2_RUNTIME_MANIFEST`和PATH。它的行为如下：
- 在工作根（`MAC_WORK_ROOT`，路径同§0.3）的`dev/<tree>/`维护一个持久的`--shared` clone。执行破坏性的git命令前，先核对它确实是自己的clone且路径不经过符号链接；然后重置到源HEAD，再重新应用`captureCandidatePatch`补丁。
- node_modules只在lock hash变化时重拷。
- 执行`tsc --incremental`，并删除没有对应`src/*.ts`的陈旧`dist/**/*.js`。
- native只在其源码digest、runtime或工具链变化时重编；build stamp每次重写。
- 命令在新建的`runs/dev-<tree>/<id>/`下运行，HOME、cache和TMPDIR都隔离，launchd fixture可用。结束后核对登记的进程、launchd job和配额都已退出，并确认没有活进程的命令行引用该运行根。只保留最近N个已结束的干净运行；有残留或未结束的运行不删。
- 同一tree串行执行；锁被活进程持有时拒绝启动。

Tier-0不产生证据，不得写入task-result。Tier-1是下文的broker：每张卡的最终候选只构建一次，只有它上面的运行计入门。`node --test`遇到不存在的文件参数时会静默不选；broker和Tier-0因此拒绝候选中不存在的测试文件参数，包括zsh未分词的数组。卡开始时先在Tier-1候选里运行环境探针：`--name env-probe -- "$ILV2_NODE_BIN" scripts/ilv2-mac-env-probe.mjs [--toolchains "$ILV2_TOOLCHAINS"]`，未到READY就停止。之后的命令用`--reuse`在同一候选上执行。`--read <保护目录内文件>`会让系统弹出真实的TCC对话框，所以只在用户事先同意时运行，并按“不允许”作答，记为`BLOCKED_ENV_TCC`。

**JDT/Gradle工具链：** `ILV2_TOOLCHAINS`冻结JDT 1.56.0、Gradle 9.3.1、JDK 25.0.2及其22,304个文件的sha。Homebrew已执行`brew pin gradle jdtls openjdk`（2026-10-14），`brew upgrade`不会改动它们；换版本须先`brew unpin`、重建INPUT，并重跑依赖它的门。JDT设置只给`java.import.gradle.home`，不给`gradle.version`：JDT LS优先采用version，Tooling API随后按版本下载发行版到私有Gradle home，绕开冻结home，耗时还取决于网络（WF-MAC5的JDT导入超时即此原因）。fixture断言daemon的`-cp`位于冻结home之下。

以下为完整子shell模板，在源码checkout执行，替换freeze/task/run ID及测试路径。也可保存为任务脚本后用`/bin/sh`执行，禁止source到持久shell。每次新建并登记运行根；环境在子shell退出后恢复。MAC-00尚无manifest时直接固定并记录runtime；后续指向持久冻结文件。`TMPDIR`必须在broker启动前设置，子进程的`--env TMPDIR=...`不能约束broker自身mkdtemp。

```sh
(
  set -eu
  export ILV2_WORK_ROOT="/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac"
  export ILV2_NODE_BIN="/Users/luo/.nvm/versions/node/v22.16.0/bin/node"
  export ILV2_RUNTIME_MANIFEST="$ILV2_WORK_ROOT/plans/mac-00/<freeze-id>/runtime.json"
  ILV2_TASK_DIR="$ILV2_WORK_ROOT/runs/<task-id>"
  export ILV2_RUN_ROOT="$ILV2_TASK_DIR/<new-run-id>"
  test -x "$ILV2_NODE_BIN"
  test -f "$ILV2_RUNTIME_MANIFEST"
  mkdir -p "$ILV2_TASK_DIR"
  mkdir "$ILV2_RUN_ROOT"
  printf '%s\n' "$ILV2_RUN_ROOT" > "$ILV2_RUN_ROOT/run-root.txt"
  mkdir "$ILV2_RUN_ROOT/tmp"
  export TMPDIR="$ILV2_RUN_ROOT/tmp"
  export PATH="/opt/homebrew/bin:$PATH"
  # JDT/Gradle cards only:
  # export ILV2_TOOLCHAINS="$ILV2_WORK_ROOT/inputs/toolchains/jdt-1.56.0-gradle-9.3.1-jdk-25.0.2/toolchains.json"
  unset NODE_OPTIONS NODE_PATH NODE_REPL_HISTORY NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_REDIRECT_WARNINGS

  "$ILV2_NODE_BIN" scripts/run-isolated-validation.mjs --name main --profile targeted -- \
    "$ILV2_NODE_BIN" --test --test-concurrency=1 'dist/index-builder/integrity.test.js'
)
```

示例是一个既有定向测试；新任务换成其真实测试文件。若任务明确要求全源码测试，参数写成`'dist/**/*.test.js'`；脚本套件写成`'scripts/*.test.mjs'`。**glob必须加引号**，作为一个argv交给候选中的Node展开，不能让bash/zsh先在源checkout里枚举陈旧dist。具体文件列表逐个引用。compile/full任务只替换子shell最后的broker调用为`--profile compile`或`--profile full`，删去`--`及其后子命令；不逐项重复全跑。

已登记的broker保留至统一收尾。后续命令在同一任务子shell中增加`--reuse <输出的validationRoot> --name <唯一名称>`，复用已冻结candidate；源码、runtime、native/build/dist与依赖身份不符时拒绝执行，不静默重建。名称重复拒绝覆盖证据。构建路径不再嵌入native guard身份；两目录相同二进制与真实预加载的定向证明只在相关native/builder变更时运行，其他定向测试不反复双构建。正式G14 full仍按该卡要求执行。

v4的PR入口`"$ILV2_NODE_BIN" scripts/run-v4-gates.mjs --profile pr`与release profile现在可以作为固定runtime命令使用，仍放在上述子shell内部。内层字面node由binder重绑定，release HTTP smoke使用自身实际绑定的随机端口并核对PID/instance/runtime及整组退出，绑定失败不附加现有服务。G02A运行的是入口调度fixture及定向真实HTTP smoke，不能据此宣称正式PR/release产品门通过。

MAC-01的runner入口已实现；MAC-04/10对应的产品/评测入口仍为目标CLI。driver兼容发生在离线测量工具，不进入正式产品。统一退出码：0 全部所选门 PASS；1 已测但失败；2 前置/身份/环境/授权/产物错误。NOT_RUN/BLOCKED不能以0混入所选门的全部PASS。

隔离验证broker的退出0仅证明所选命令成功；closeout的退出0仅证明所登记资源和目录收尾通过。两者都不能代替`task-result.json`中完整合同的G门判定。

```text
"$ILV2_NODE_BIN" scripts/ilv2-mac-burst-replay.mjs
  --mode start|attach --driver <driver.json> --frozen <abs-root>
  --plan <run-plan.json> --out <new-dir>
  start:  --port <unused-port> --service-work <new-dir>
  attach: --url <url> --expected-instance <id> --expected-source <source-digest>

"$ILV2_NODE_BIN" scripts/ilv2-mac-slo-report.mjs
  --telemetry <dir> --calls <jsonl> --plan <run-plan.json>
  --since <ISO> --until <ISO> --out <new-dir>

"$ILV2_NODE_BIN" scripts/ilv2-mac-fault-matrix.mjs
  --driver <driver.json> --plan <fault-plan.json> --out <new-dir>

"$ILV2_NODE_BIN" scripts/ilv2-mac-snapshot-equivalence.mjs
  --left <sealed-snapshot> --right <sealed-snapshot>
  --contract <logical-contract.json> --out <new-dir>

"$ILV2_NODE_BIN" scripts/ilv2-mac-retrieval-eval.mjs
  --tasks <jsonl> --gold <private-jsonl> --schedule <jsonl>
  --drivers <drivers.json> --out <new-dir>

"$ILV2_NODE_BIN" scripts/ilv2-mac-paired-compare.mjs
  --dataset <manifest> --gold <private-jsonl> --schedule <jsonl>
  --results <pack> --out <new-dir>
```

driver 固定runtime manifest digest、`contractVersion`、argv 数组、身份读取方式、status/prewarm/query/cancel 映射、规范化规则与错误映射。baseline/candidate 可以不同 schema/工具名，但输入、预算、目标证据与计时点相同。baseline 不能满足新身份字段时由其启动器提供可验证 source/cache/process 身份，不伪造新产品字段。

start 拒绝占用端口并只关闭自己启动的实例。attach 必须核对 instanceId、source/build/native/runtime digest、cache/owner root 与协议；不要求端口空闲，不负责停止服务或删除其共享 cache。两者拒绝生产 cache、既有输出目录和越出受管根的清理路径。

### 5.2 真实负载 plan 与 oracle

`run-plan.json` 至少包含：格式版本、四仓 commit/hash、主库与每 worktree 的 commit、实际 Java/XML/build 内容差异清单/hash、expectedBuildKind、base 可用时刻、并发顺序、编辑/故障屏障、请求预算、SLO、样本数、停止时限和产物根。

- 不用 HEAD~20/50/100 代替差异等级；实际测得 ≤20、21–200、超过 delta 闭包阈值的分支再归档。五小差量中至少两组同相对路径但不同 Java/XML 内容；大分支必须证明确实进入 full。
- 主场景包含主库第一次 full 与可服务后的 seed 阶段；分别记录“等待兼容 base 的时间”和“已有 base 后的 first-correct-query”。无可用 base 的初次请求不能套 5 s seed 门，也不能从端到端延迟报告里剔除。
- 每组首证据样本 ≥20。每轮编辑写入唯一方法/XML token，记录单调时钟 `tEdit`、`tPublished`、`tFirstCorrectQuery`；每 100–200 ms 发起有界查询，至少20轮、跨多个工作区和 Java/XML。
- first-correct 必须命中新内容、hash 匹配、声明正确 workspace/snapshot，且相应关系/来源符合 oracle。HTTP 成功、返回结构化 NOT_READY 或仅发布事件均不算命中。
- 统计 edit→publish 与 edit→first-correct-query 两组数值。10 s polling 不能证明 3 s 可见；达到停止时限仍未命中的轮次保留失败/右删失记录，分位门按未满足处理，禁止删掉。
- 故意 deadline/SIGKILL/drop 是 fault 窗口；正常窗口和故障恢复窗口分别出 SLO。两组全部调用保留在原始 calls，不把注入的故障误报正常误杀，也不把无注入的失败移到 fault 组。

### 5.3 统一证据结构

每次运行生成 manifest、calls.jsonl、jobs.jsonl、timeline.jsonl、samples.json、verdict.json。最少字段：

| 记录 | 必需字段 |
| --- | --- |
| 运行 | runId、source/tree/native/build/runtime/driver/plan digest、实际execPath和process.versions、输入身份、host、windowKind、开始结束时刻、精确 argv |
| 调用 | requestId、workspaceId、工具、请求开始 serving/freshness、deadline、elapsed、状态、errorCode、snapshot/capture/manifest hash、firstCorrect、payloadBytes |
| 作业 | jobId、incarnation、workspace、full/delta/noop、原因、queue/run/seal/publish/reap 时间、changed/affected/parsed 数、CPU、physicalBytes、lastHeartbeat/workCounter、result/exit |
| 资源 | 当前 owner/build/query/parser 数、各类 lease、队列、tmp/retired 数和物理占用；Gradle home/version/PID/PGID与实际退出单列；取消/故障前后有配对快照 |
| 判定 | gateId、PASS/FAIL/BLOCKED、n/分母、完整样本引用、阈值、实测值、输入有效性、未覆盖项 |

普通性能运行保留 lifecycle、阶段耗时、RSS/CPU/GC/event-loop 和 heartbeat 遥测，但不启用滚动 V8 CPU profiler。需要 CPU 栈诊断时，在 owner 环境显式设置 `JAVA_LSP_OWNER_CPU_PROFILE=1`；该运行计时只作 `NOT_GATED` 诊断，不能并入正式性能样本。Profiler 在大堆上重启本身会造成数百毫秒停顿，不能把观测器开销误判成查询路径成本；已有 FAIL/INVALID 记录保持原判。

租约持续时间以同一 owner 的同一 unbound snapshotId 连续被保留为依据，保持 120 秒阈值、既有在途排除及最后一次 sweep 的 snapshot 残留检查；不同 snapshot 不接续计时。workspace 可能等待另一工作区对共享快照的合法租约，不套绝对 120 秒寿命，仍须证明持租约不删除、最后释放后≤2个 GC 周期回收及真实退出。非零 leased 记录缺少对象身份或计数不一致时属于证据不足，resources 不得 PASS；不能用后续清零或新短测改写历史 FAIL。

分位数固定 nearest-rank：排序后第 `ceil(p × n)` 个；p50/p95/p99 同时报 n、max 和原始样本。失败/未完成 slot 不伪造零耗时；门判断同时检查完成率，缺一个必需样本即不满足门。模型重复按任务聚类；工程重复报告独立 run 和条件，不人为增加样本独立性。

G11 各组最少样本数按有效样本计数，保留全部尝试及其引用，分别报告 attemptedN、validN、invalidN 和缺证数量。证据完整但窗口边缘已知 load1≥20 的计时，以及有完整测量记录但物理噪声超限的轮次，保留为 INVALID_EXPERIMENT；已有足量有效样本时，以全部有效样本统计，不挑选较快轮次。缺负载、失败、未闭合或右删失记录仍阻止测量完成，不能归入环境噪声排除。各 seed 档、Java/XML 编辑、full 和物理档分别满足原定数量；无效样本不足的组只补缺口。请求截止与正确性硬门始终检查全部调用，不能因负载排除违规。此聚合口径仅用于新候选，历史结论不改写。

### 5.4 APFS/SQLite 物理成本

对相同冻结 lishu-v2 内容分别测零差量、20 文件、200 文件，再测实际大分支。每次独立目录、至少3轮，分开记录 clone、capture、parse、resolve、SQL、checkpoint/seal、publish 的时间/CPU/逻辑字节/物理增长。

clonefile 返回成功证明请求了原生克隆；`ls -l` 不能证明共享 extent，`du` 也不能简单按多个 clone 求和得到真实新增占用。记录卷可用空间差、Time Machine/APFS snapshot 干扰、`stat`/`du`、页数/freelist/dbstat 与作业写入量。物理增量用隔离运行前后卷分配变化并做空跑校正；误差大于目标差异时该项 INVALID_EXPERIMENT，重选受控条件，不宣称节省。

零差量直接绑定，新增事实 DB 数和 DB 写入字节必须为 0。20/200 变化的净物理增长分别以同输入 fresh full 的净增长为分母；通过门见 §6。checkpoint/同步成本计入总时延，不能只报 clone 毫秒数。

### 5.5 MAC-05 full/delta runner

`scripts/ilv2-mac-full-delta.mjs --history <冻结输入worktree> [--repo <run tmp内源码副本>] [--out <run内新目录>] [--work <run tmp内新目录>] [--changes 20,200] [--correctness-only true]`；`--repo`默认`$ILV2_RUN_ROOT/tmp/repos/<仓名>`，JSON报告`--out`默认`$ILV2_RUN_ROOT/raw/full-delta/<仓名>`，数据库`--work`默认`$ILV2_RUN_ROOT/tmp/full-delta/<仓名>`（分阶段提交要求位于run tmp，且数据库是bulk而非归档证据）。它是测试驱动，不实现publisher/tracker/GC，也不据此宣称它们。

- **输入身份。** 副本不存在时先从冻结worktree复制构建输入（`relevantInput`，不含`.git`及其他文件）；随后总是核对副本与冻结worktree的构建输入集合及字节完全相同，得到census digest；git只读并加`--no-optional-locks`。不同即退出，不在漂移的副本上测。
- **编辑负载是真实历史，不用合成编辑。** 每档cap用指数探测与二分确定性选择first-parent链上的`HEAD~k..HEAD`，核对其中Java净差异文件数≤cap且大于上一档cap；净差异数可能非单调，因此不宣称找到了全历史最长范围。门资格仍要求每档实际文件数≥cap的一半，选样不足不算PASS。把这些路径恢复为`HEAD~k`的工作区字节（在run tmp内建立临时`GIT_INDEX_FILE`，用`read-tree`与单次`checkout-index --stdin -z`导出；保留checkout filters，逐文件与原`cat-file --filters`语义核对，不改冻结输入index）：HEAD新增的删除、HEAD删除的重建，所需目录随之创建并在还原时删除。实际文件数、k、commit写入报告，不以cap代替。XML与构建文件保持HEAD并计数为`heldAtHead`：真库切片不声称XML/资源差量，其正确性由定向用例（`execution-plan.test`的闭包步骤）证明；构建文件变化本应升级full，不属于delta档。
- **正确性分层。** ①每个发布状态（base、各档delta、chain、oracle、full-2）都跑`checkIndexInvariants`：graph边/节点owner、反向边与正向owner对应（库里没有CALLED_BY符号而存在前向调用边也算违例）、非`ext:`边端点都是kg_node、每个已索引文件有自己拥有的FILE节点、FILE/TYPE/METHOD/CONSTRUCTOR/FIELD节点由其path所在文件拥有、xor摘要等于行重算、owner是已索引文件、entity/search-doc的df与posting数及stats一致、search_doc来源行存在；任一违例即FAIL。②链式oracle：base→D(small)→D(small→large)与base→D(large)两个终态都必须等于同一棵large树的一次独立full；chain只提交两棵树字节不同的路径，所以small档中被chain第二步重写的文件只由①与定向用例覆盖。sealed base与full源文件先核对SHA256相等，再复用full逻辑摘要，base仍实际运行不变量；不重复解码同字节数据库。verified reconcile与空delta的逻辑摘要必须等于base。③full-1与带parse后注入编辑的full-2逻辑摘要相等。每仓因此是3次full（full-1、oracle、full-2）。delta应用顺序置换与单文件行移零写入由定向用例证明，不在真库重复。
- **正确性与计时分开。** 计时窗口包含job、checkpoint/同步和第一次正确查询（delta命中变更文件、hash等于磁盘字节；full命中已捕获文件、hash等于捕获输入，parse后注入编辑不得混入）；不变量、逻辑摘要、页差在窗口外，CPU与未归因时间单列。阶段快照只在`--diagnostic true`时做；快照落在delta窗口内，所以诊断模式的delta计时只记录、不设限（NOT_GATED）。
- **计时有效性。** 窗口起止的原始load1均 < 20才有效；load1缺失或≥20时该项`INVALID_EXPERIMENT`，正确性仍照常判定，CPU数及perCpu只作记录。此主机上限于2026-10-21按用户要求调整，仅用于新运行；历史INVALID/FAIL原样保留。首样本距阈值±5%以内为INCONCLUSIVE，一旦进入补测便完成3次取中位数，第二次偏离临界带也不提前结束；无效主机样本仍直接记INVALID_EXPERIMENT。noop预算严格小于。full-1与full-2均受full时间门约束，并分别记录correctness与timing；full-2的每个补测样本均注入parse后编辑。oracle只承担正确性，计时记NOT_GATED。阈值是脚本`LIMITS`：full≤327.9 s、noop<2.5 s、20/200档首个正确查询≤5 s/15 s、页差比<10%/30%，与§6.1和MAC-05卡一致，不放宽。
- **正确性专用运行。** `--correctness-only true`按用户明确选择仅完成正确性：full/delta保留实际墙钟、CPU、负载和页差，但timing一律NOT_GATED，不因时间/页比失败，不做临界补测；不变量、hash、chain oracle与full确定性断言保持不变。可与同run、同base key的`--resume-base`组合，完整继续oracle和full-2；复用full的计时不能冒充新full计时。与`--cost-only`互斥。该模式因已观察到的native启动环境阻塞，副本使用Node `copyFile`且每份facts/stat副本核对源/目标SHA256；report/result的`copyMode`及`notClaimed`显式记`BYTE_COPY_NOT_NATIVE`，不声称native clone或物理COW。普通gate、cost-only及diagnostic仍只使用`NATIVE_CLONE`，native失败即停止，不回退。成功仅记correctness PASS、总状态DIAGNOSTIC_ONLY，G05保持IN_PROGRESS，不提交。
- **门资格。** 只有门运行（`--changes 20,200`、本run新做的full-1、非`--diagnostic`/`--cost-only`/`--correctness-only`/`--resume-base`、默认阈值与空闲上限、每档Java文件数不低于其cap的一半）可以得PASS；其他运行的结论只能是FAIL、INVALID_EXPERIMENT或DIAGNOSTIC_ONLY，原因写入`notGated`。没有阈值的档位记NOT_GATED，不记PASS。
- **每次测量都是新的。** `--out`与`--work`必须不存在或为空，每个full在新的case目录里建库；计时full的`stages.mode`必须是`full`且parse文件数等于capture文件数（否则是续跑的full，FAIL）；delta与chain的`stages.mode`必须是`delta`，升级或回退成full即FAIL并记`ESCALATED_FULL: <原因>`，按§6.1归入full组，不当作delta通过。
- **停止与记录。** 按成本顺序执行：full-1→base不变量→verified reconcile→空delta→small→large→chain→oracle→full-2→确定性。首个falsifier即停，full/delta成本失败均先停止，再将未执行的不变量与逻辑摘要记NOT_RUN；未到达的步骤记NOT_RUN；每步结果在产生时写入`full-delta-progress.json`；已建立新输出目录后的执行异常也必须记录原始error、当前步骤FAIL（native超时或已识别权限/磁盘环境错误记BLOCKED_ENV）与剩余NOT_RUN，禁止遗留IN_PROGRESS；失败或成功都把源码树还原到HEAD；还原本身失败时，成功路径以该错误停止（副本已不是HEAD），失败路径只记录它，不掩盖原始失败。
- **复用封存base。** `--resume-base`只接受本run tmp内已完成full的目录，且base key（schema版本、facts revision、dist digest（`dist/`下全部运行时文件，不含测试、map、声明文件与`build-stamp.json`；后者由broker验证/记录，但builder不消费其generatedAt等构建元信息）、Node版本、输入census）完全相同；只用于`--cost-only true`的成本诊断或`--correctness-only true`的正确性续跑（runner拒绝其他组合）；前者不产出oracle/确定性结论，后者保留全部正确性检查但不能产出full计时或G05 PASS。
- **变化边界即falsifier。** 实际Java文件数、resolve闭包、facts与workspace-stat页差分开报告；闭包或页差越过门限时先修MAC-04/05，不放宽阈值、不把档位改小来通过。

## 6. 验收门与停止条件

### 6.1 工程与收益指标

以下是待验证的目标，不是已观测结果。10%/30%与5 s/15 s为默认目标；维持或收紧无需额外确认，任何放宽按MAC-00第5步取得用户明确批准并记录批准人/时间/授权引用。表与实施前冻结的thresholds.json同步；缺批准仍用默认值，不能候选失败后改门。MAC-00将具体plan冻结；没有样本时记 NOT_RUN，不能写 0 次失败。

| 维度 | 通过标准 | 主要责任 |
| --- | --- | --- |
| 内容/隔离 | 0 跨 worktree 证据；0 旧 hash 标新文本；full/delta logicalDigest 一致；坏文件不阻断正常更新，相关否定保留 PARTIAL | G03、G05、G08、G11 |
| 请求截止 | 每个调用 elapsed ≤ deadline+1000 ms；正常窗口 watchdog 硬截止 0 次；fault 窗口按预期返回且资源收敛 | G06、G08、G11 |
| status | start=false 无副作用；每工具/workspace 状态分层及总体 status p99 ≤200 ms，≥100 个样本 | G08、G11、G17 |
| owner/资源 | 同域builder≤2、full≤1、parser≤冻结数、query≤2；取消≤2 s；完整恢复仍要求两类旧进程同一≤10 s窗口退出；Gradle故障时静态降级可用另验，不能抵扣完整恢复FAIL；性能窗口零遗留进程 | G02、G06、G09、G11 |
| full | 三次真实 lishu-v2 full，0 健康 stall kill；中位墙钟 ≤0.8×B_full（B_full=409.9 s，即≤327.9 s，见`mac-00/b-full.json`）；基线无有效值时绝对门≤600 s，并明确未证明相对提速 | G11、G12 |
| seed 首次正确查询 | 兼容 base 已可用后，≤20 文件 p95≤5 s，21–200 文件 p95≤15 s，每档≥20 样本；大分支按 full 门，禁止套 seed 门 | G11、G12 |
| 公平性 | 混合 full 负载中，小 delta queued p95≤2 s、max≤5 s；等待的 full 在前一 full 退出后≤5 s dispatch | G06、G11 |
| 编辑可见 | 单文件 build run p95≤2 s；edit→first-correct-query p95≤3 s，≥20轮；正常窗口无缺样本 | G11、G12 |
| 心跳/进度 | 正常阶段 heartbeat 最大间隔≤2 s；无健康误杀；阶段进度与真实完成量对应 | G05、G06、G11 |
| 生命周期 | sealed 无 WAL/SHM；持任何 lease 不删除；无引用产物≤2个 GC 周期回收；崩溃后 binding 旧/新二选一完整 | G07、G09 |
| 物理差量 | 零差量0 DB写；20/200文件净物理增长中位数分别≤同输入full的10%/30%；查询p95与编辑可见仍达标 | G11、G12 |
| 合成容量 | K29 原1000文件，20并发 broad query：p95≤150 ms、event loop p95≤20 ms | G08C、G14 |
| 三仓质量/耗时 | 保留全部必要质量断言；每cell 5次，按原三轮合并分母计算严格p95比≤1.25，不加50ms宽限；候选/基线驱动/runtime/contractVersion可追溯 | G08C、G14 |
| 工具证据 | deterministic recall 不下降>2pp，hash/实际内容范围可核验；没有靠 gold 生成 query | G10、G13 |
| agent 收益 | 新MCP对冻结旧MCP：成功率不降+token减少≥20%，或成功率提高≥10pp；分层、区间、失败slot全部报告 | G15 |
| 语义隔离 | 任意 worktree同URI 0串扰；精度实验另有≥200符号、≥98%语义一致率，不能抵扣隔离错误 | G16 |

单个合法编辑引发闭包 >400 或全仓语义变化时可显式升级 full；这类样本单列 full 组，不能伪装小 delta 通过，也不能从用户端时延报告删除。物理差量超过门时先分析 DB 页更新与关系闭包，不自动引入分片/第二种数据库。

### 6.2 K01–K32 具体改造

当前 K 定义仍从 [runtime contract matrix](../../java-specialist-release-audit-v1.1/docs/09-runtime-contract-matrix.md) 追踪，MAC-08C前移K29驱动，MAC-14完成当前定义和runner的契约版本更新；已有历史报告不覆盖。未列出的 K 仍逐项执行原业务断言，只适配新入口，不能隐式取消。

| K | 需要改变的场景 / oracle |
| --- | --- |
| K05 / K11 / K15 / K19 | 等实际正确查询/hash，不只等 published；明确观察的是哪个 workspace/capture |
| K06 | 六 worktree 并发，排除 BUILDING/private base；无 family 串行；同路径异 Java/XML hash；未验证返回 NOT_READY |
| K12 | 非零预算经过 resolve/create/prepare/SQL/preview 的挂起点；外部 elapsed 与取消后资源收敛；不是只测 deadline=0 参数拒绝 |
| K20 | hits 后 publish 新快照，再读 coverage/preview，仍同一个旧 lease；GC 期间旧快照不消失 |
| K21 | sealed seed 后仅 XML 修改/删除；结果必须是目标 worktree 内容；不再调用 VACUUM INTO |
| K24 | 一个 FAILED/RECOVERED Java + 正常更新，正常更新可见、受影响否定有缺口；修复后完整 |
| K26 / K28 | 使用真实隔离 JDT；缺环境明确 BLOCKED_ENV；增加并发同 URI worktree 隔离 |
| K29 | 保留固定1000文件容量门；真实 lishu-v2 cold/seed/full 混合压力是另外 G11，不相互替代 |
| K30 | SEALED 无 WAL/SHM；reader/query/base/publication lease；CURRENT绑定/GC/持续发布物理收敛，不能仅证明 WAL checkpoint |

心跳同步段测试用≥5 s真实子进程，按首次到达、相邻间隔和最后到达时间验收；1Hz 节流不再要求3秒收到至少5次。需区分 coordinator 活着与具体工作有进展。

### 6.3 正式三仓命令

以下模板各自包含完整环境初始化，独立复制执行；不要先运行一个已经退出的§5.1子shell，再依赖其中变量。先完成§1.1的冻结输入预检；MAC-02A接入native/runtime身份，MAC-08C实现新driver及严格p95合同后才可据此判新门PASS。MAC-14针对最终候选完成其余K门。`<BASELINE_SHA>`取MAC-00冻结的祖先，不换成方便通过的候选。

```sh
(
  set -eu
  export ILV2_WORK_ROOT="/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac"
  export ILV2_NODE_BIN="/Users/luo/.nvm/versions/node/v22.16.0/bin/node"
  export ILV2_RUNTIME_MANIFEST="$ILV2_WORK_ROOT/plans/mac-00/<freeze-id>/runtime.json"
  ILV2_TASK_DIR="$ILV2_WORK_ROOT/runs/mac-14"
  export ILV2_RUN_ROOT="$ILV2_TASK_DIR/<new-matrix-run-id>"
  test -x "$ILV2_NODE_BIN"
  test -f "$ILV2_RUNTIME_MANIFEST"
  mkdir -p "$ILV2_TASK_DIR"
  mkdir "$ILV2_RUN_ROOT"
  printf '%s\n' "$ILV2_RUN_ROOT" > "$ILV2_RUN_ROOT/run-root.txt"
  mkdir "$ILV2_RUN_ROOT/tmp"
  export TMPDIR="$ILV2_RUN_ROOT/tmp"
  unset NODE_OPTIONS NODE_PATH NODE_REPL_HISTORY NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_REDIRECT_WARNINGS

  "$ILV2_NODE_BIN" scripts/run-three-repo-cold-matrix.mjs \
    --baseline '<BASELINE_SHA>' \
    --lishuedu "$ILV2_WORK_ROOT/inputs/frozen-java-repos/lishuedu" \
    --cipherlink "$ILV2_WORK_ROOT/inputs/frozen-java-repos/cipherlink" \
    --exam-parent-v3 "$ILV2_WORK_ROOT/inputs/frozen-java-repos/exam-parent-v3" \
    --output-dir "$ILV2_RUN_ROOT/three-repo"

  "$ILV2_NODE_BIN" scripts/verify-three-repo-cold-matrix.mjs \
    --matrix-dir "$ILV2_RUN_ROOT/three-repo/matrix" \
    --expected-runs 5 --p95-limit 1.25
)
```

runner已在内部调用同一verifier；第二条是对持久产物的独立复验，不重跑矩阵。manifest位于`three-repo/run-manifest.json`，18个cell位于`three-repo/matrix/`，两个参数不能写成同一目录。当前旧verifier的50ms宽限不满足本计划严格门，必须先完成MAC-08C改造和合同版本校验。

完整K合同模板如下；G08C只跑K29时将task-id改为mac-08，使用新run-id，以`--cases K29`替换`--jdt-evidence ...`整行。选定门退出码仍须先完成MAC-08C改造。

```sh
(
  set -eu
  export ILV2_WORK_ROOT="/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac"
  export ILV2_NODE_BIN="/Users/luo/.nvm/versions/node/v22.16.0/bin/node"
  export ILV2_RUNTIME_MANIFEST="$ILV2_WORK_ROOT/plans/mac-00/<freeze-id>/runtime.json"
  ILV2_TASK_DIR="$ILV2_WORK_ROOT/runs/mac-14"
  export ILV2_RUN_ROOT="$ILV2_TASK_DIR/<new-k-run-id>"
  test -x "$ILV2_NODE_BIN"
  test -f "$ILV2_RUNTIME_MANIFEST"
  mkdir -p "$ILV2_TASK_DIR"
  mkdir "$ILV2_RUN_ROOT"
  printf '%s\n' "$ILV2_RUN_ROOT" > "$ILV2_RUN_ROOT/run-root.txt"
  mkdir "$ILV2_RUN_ROOT/tmp"
  export TMPDIR="$ILV2_RUN_ROOT/tmp"
  unset NODE_OPTIONS NODE_PATH NODE_REPL_HISTORY NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_REDIRECT_WARNINGS

  "$ILV2_NODE_BIN" scripts/run-isolated-validation.mjs --profile targeted --keep -- \
    "$ILV2_NODE_BIN" scripts/run-release-contracts.mjs --isolated \
    --output '{state}/k-contracts' \
    --jdt-evidence "$ILV2_WORK_ROOT/runs/mac-14/<jdt-run-id>/real-jdt-evidence.json"
)
```

现有binder要求`--output`使用`{state}`/`{candidate}`；K输出又必须在candidate外，所以上例用`'{state}/k-contracts'`及`--keep`。随机根在持久run root的tmp内；成功或失败均登记其精确路径，将证据按§0.3归档/核验后才清理，不能让finally删掉唯一正式证据。子shell的`set -e`保留失败退出码，失败后不继续声称后续命令已运行。JDT输入由MAC-14前置步骤生成，source/native/runtime身份一致；其缺失不能当全K PASS。

脚本当前按旧 API/schema 驱动的部分必须先改造；命令保留不代表新 candidate 已兼容。若 baseline 的历史缺陷使某项无法完成，保留失败和比较缺口；新候选按绝对功能 oracle 验收，不可凭缺失基线宣布相对提升。

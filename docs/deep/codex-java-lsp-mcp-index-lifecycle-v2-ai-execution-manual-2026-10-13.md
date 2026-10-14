# codex-java-lsp-mcp 索引生命周期 v2：Mac 专用执行手册

| 项 | 值 |
| --- | --- |
| 版本 | `ILV2-MAC/4`，2026-10-13，替代本文件的旧 P0–P4 执行顺序 |
| 当前状态 | `IN_PROGRESS`：MAC-00/G00、MAC-01/G01、MAC-02A/G02A、MAC-02B/G02B已按各自范围通过；A提交`2c70544`、B提交`0ab0e0f`。流程精简与MAC-02C/G02C已通过，见[唯一结果记录](../index-lifecycle-v2/mac/mac-02c/task-result.json)；父G02的A/B/C已齐全。MAC-03及后续仍为PLAN |
| 目标 | 消除构建活锁、错误新鲜度、跨 worktree 内容污染和请求失控；让同内容复用、真实差量构建及后续 agent 收益可测 |
| 平台 | Mac 专用：2026-10-13 读取为 `arm64`、macOS `26.5.1 (25F80)`、Node `22.16.0`、SQLite `3.49.1`；MAC-00 冻结绝对可执行路径、digest和完整versions，并核对实际生产工件；不自动升级 |
| 技术路线 | TypeScript + SQLite + 小型 macOS 原生 helper；APFS 硬前提；唯一 daemon、不可变内容快照、显式 full/delta、统一 lease |
| 不做 | Linux/Windows/Intel 适配、旧 schema 迁移、旧输出兼容层、普通复制兜底、先修旧版再部署；提前恢复新服务按 §3.1 选择 |
| 实施起点 | 分支 `codex/index-lifecycle-v2`；手册重写前 HEAD `9b3a110`；历史源码基线 `ad412ceb51bc616df3700feca7d3c14ea6dc5ee0` |
| 设计输入 | [Mac 深度 review](codex-java-lsp-mcp-index-lifecycle-v2-macos-review-2026-10-13.md)，F01–F12 |

本手册是实施任务合同，不是实现完成记录或操作授权。`PLAN_READY` 不意味着产品已修复。旧 P0-T0 的历史成果保留；旧任务的 PASS 不能转成 MAC 任务的 PASS。启动实施须有用户的实施指令，具体副作用继续遵守 §0.1。

## 0. 范围、授权与执行规则

### 0.1 权限与历史决定

- 历史 U1 已完成：基线源码和冻结仓库记录保留，禁止重做或改写历史。
- 历史 U2 允许 ILV2 实施期间本地 commit/tag，U3 允许 `:38457` 隔离 canary。用户明确启动实施后可在原范围内复用；文档维护本身不启动实施或提交。push、PR、生产安装仍需明确授权。
- 历史 U4 只表示不部署旧 P0、直接进入新生命周期方案，不能推导成“必须等全部任务结束才恢复服务”。取消旧 P0 修复部署及强制 v9→v10 双格式路线；默认最终候选部署，另提供 G11 后的可选提前切换点（§3.1），届时以具体候选和已有安全证据取得安装授权。
- 付费模型按次确认模型、slot 数及预算。缺授权记 `BLOCKED_AUTH`；无模型 runner 不需要模型账户。
- 全局 AGENTS/hook/config 只交付建议 diff，不直接写入。生产安装、旧生产缓存删除分别授权。无需读取 `~/.codex/sessions` 完成本计划。

以下边界继续有效：

1. 生产缓存 `~/Library/Caches/codex-java-lsp/`、运行目录 `~/Library/Application Support/codex-java-lsp-mcp/`、生产 LaunchAgent 和 `:38456` 在 MAC-18 或 §3.1 的具体提前安装获批前不写、不调用。旧手册记录的“服务已停、缓存已清理”是历史事实，不能当作当前状态。
2. 业务原仓和已有 worktree 只读，不在其 `.git` 执行写操作。Git 读取加 `--no-optional-locks`；所有编辑、故障注入和 worktree 创建只在本次隔离副本内进行。
3. 不复制凭据，不读取无关 `.env`，不向公开仓库写业务源码、任务正文、gold、oracle或模型原文；执行agent可见不等于允许公开。不改 pins、生产 projects.json；不新增 fat-service。
4. 不引入 heap/RSS kill 阈值。记录 RSS/CPU 用于分析，不能替代阶段进度与明确时限。
5. 不更换存储引擎、不重写语言。原生 helper 使用系统 API，作为版本化构建产物；不是插件式跨平台抽象。
6. 不删除历史归档及其引用：`docs/evidence-archive/`、`/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/`。
7. 继续禁止 `--activate-http` 和 `JAVA_LSP_ENGINE`。保留 [HANDOFF](../../HANDOFF.md) 与 [操作文档](../phase-f/production-operations.md) 的“不得新增第四个 live daemon”限制，不据此把现有实例数当作已核验事实；常驻测试只用已授权 `:38457` canary，不增设第二个常驻canary。单次fixture daemon使用独立临时HOME/cache/owner/projects及随机未占用端口，默认禁用JDT（真实JDT专项除外），登记PID/PGID/端口并在运行结束回收；这类有界测试进程不计入常驻实例，不得接生产根。同机所有测试runner合计最多2个fixture daemon，受管配额同时约束并行测试；达到上限排队，不把每个runner的2个相加。
8. 正式三仓矩阵遵守 [主机政策](../phase-v4/three-repo-host-load-policy.md)：load < 20 应跑，load ≥ 20 仍跑并记录；唯一主机硬门是可用内存 ≥ 4 GiB。真实 ENOSPC 等执行失败如实报告。文档改写和小范围单测不触发矩阵。

### 0.2 每项任务的完成合同

每张任务卡的依赖、输出和验收都是必需项。新增脚本和字段在对应任务完成前一律视为**目标接口**，不得伪称已经存在或可执行。

- 实现前读取列出的源码及直接调用者。实际缺陷写能表达错误行为的 RED 测试；编译失败、脚本不存在不算缺陷复现。
- 新架构按合同测试实施，不要求先在旧架构伪造全部 RED。历史活锁未复现，不阻塞已经由独立测试确认的其他缺陷修复。
- 实现后运行最窄定向测试及必要编译；G08前移查询容量和三仓回归，G14负责最终整合候选的全量、完整K合同与真实负载。新修改只重跑受影响证据，禁止同一 SHA 多角色重复完整矩阵。
- 评审与实现分离。并发/持久化/native/公共工具合同必须独立只读评审；评审固定 commit 或 tree/source digest。正式架构和门禁结论不使用 fast 档。
- 每项输出 `task-result.json`：taskId、状态、源码/tree/native/build 身份、输入 hash、精确命令、退出码、断言、原始产物位置/hash、未覆盖项、删除清单、授权引用和下一步。空缺写 `N/A`，不填虚构数字。
- **任务/门状态**：`PLAN`、`IN_PROGRESS`、`PASS`、`FAIL`、`BLOCKED_ENV`、`BLOCKED_AUTH`、`NOT_RUN`、`NOT_REPRODUCED`、`INVALID_EXPERIMENT`。条件任务NOT_RUN要有依据；未启动的MAC主卡/子卡为PLAN。
- **文档/计划状态**：`PLAN_READY`、`IN_PROGRESS`、`LANDED`；**候选状态**：`NOT_READY`、`READY_FOR_DEPLOY`、`DEPLOYED`；**收益结论**：`UNMEASURED`、`IMPROVED`、`NOT_IMPROVED`。`SUPERSEDED`仅标历史任务被替代，`UNMEASURED_BASELINE`仅标测量前提，不混入任务PASS/FAIL。
- 每次本地commit前，扫描**暂存的实际blob**与新增文件类型/体积：业务包名、Mapper namespace、业务源码片段和密钥特征的未解决命中必须为0。扫描器只输出文件路径/计数，不回显匹配正文；文档里的规则文字或脱敏占位符需逐项解释后排除，不宽泛排除整个docs。二进制/压缩RAW、源码树与未审明的任务正文直接拒绝入库。MAC-01补可重复的扫描入口；MAC-00证据先留§0.3持久工作根，待MAC-01扫描器可用并通过扫描、人工diff检查后再纳入本地提交，不能先提交后补扫。
- MAC-02/06/08按下文子卡实施和验收；MAC-03拆开纯TS捕获与原生tracker集成。开工时把真实文件、定向测试名/命令和数据清单填进执行记录。只对未决并发/持久化合同做独立评审，不新增“每张小卡先审批展开计划”的统一阻塞步骤。
- 门失败不得降低阈值、删样本、扩大 mock 或延长已经冻结的时限。连续两次同因失败且没有新证据时，停止该路径，记录根因与下一项最小验证；不连补猜测补丁。

执行顺序固定为：列齐本卡合同与缺口 → 最小环境/ready探针 → 一次构建并冻结候选 → 主测 → 同一候选的独立只读评审与关键行为复验 → 一次收尾 → 更新结果并提交。环境探针未到ready时不展开故障矩阵。评审可与主测并行；对同一范围只安排一次独立评审，发现修复后只复核受影响项。

一个物理场景可以证明多项合同，证据中逐项列出断言，不重复计作多个测试；刚启动与稳定运行的故障窗口仍分开。独立复验必须由不同执行者实际重跑关键退出/锁/协议边界，不要求复制整个主测矩阵。只有源码、运行时、工具链、依赖或编译产物漂移才重建；文档和汇总变更不使候选失效。原始失败保留，命令退出0只代表所选检查通过，不能自动宣告G门PASS。

`run-isolated-validation.mjs`自动生成各命令的双流、实际close后的退出码、时间、argv、环境白名单与hash。`task-result.json`只汇总这些记录及独立结论，是门状态的唯一结果入口；README/手册只引用该结果，不再复制命令日志、源码清单或维护重复状态表。每轮记录构建与验证命令耗时；排障、证据处理及等待只按实际时间记录，未计时写N/A。

### 0.3 产物、公开边界与清理

新小型证据放 `docs/index-lifecycle-v2/mac/`：单文件≤1 MiB、总计≤20 MiB，只收聚合数值、不含业务含义的ID、hash和脱敏结论。`agent-visible tasks/answer contract/query plan`仅表示执行agent可读，与`private gold/oracle`一样不允许提交公开仓库；仓库不存任务正文、业务路径/符号清单、模型请求响应或压缩原始记录。

持久工作根 `ILV2_WORK_ROOT=/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/ilv2-mac/` 保存本计划输入和证据：`inputs/frozen-java-repos/<repo>/` 为经完整性核验的冻结副本；`plans/mac-00/<freeze-id>/` 保存runtime.json、thresholds.json和冻结manifest；`datasets/<dataset-id>/` 放任务、答案合同、私有gold/oracle；`runs/<task-id>/<run-id>/` 为受管运行根；`archives/<task-id>/<run-id>/` 保存通过核验的RAW归档。执行agent只获得agent-visible部分，gold由独立scorer读取。文件写权限不足时，只阻塞依赖持久产物的步骤并记BLOCKED_AUTH；不能改放公开仓库，也不能以/tmp作为跨门保留的替代。

**临时目录不提供保留保证。** 本机macOS的`com.apple.tmp_cleaner`每天调度`/usr/libexec/tmp_cleaner`；脚本设`daily_clean_tmps_days=3`，以`-atime +3 -mtime +3 -ctime +3`删文件、以`-empty -mtime +3`删空目录。这里的“3天”是当前清理配置，不是精确72小时的安全保留承诺；不用touch/atime续期保住证据。历史`/tmp/frozen-java-repos`只作待核验的恢复输入，不能继续充当权威冻结根。冻结输入、批准记录、runtime manifest、`--keep`产物和跨门carry-over全部放持久根；/tmp仅用于同次调用结束就可丢弃的探针。MAC-00先按§1.1核验或重建持久副本，之后consumer只使用该副本。

源码新增目录为 `native/macos/`、`src/mac-platform/`、`src/java-index/snapshot/`；新runner为 `scripts/ilv2-mac-*.mjs`、测试平铺 `scripts/ilv2-mac-*.test.mjs`，避免现有收集器漏测。

运行目录为 `$ILV2_WORK_ROOT/runs/<task-id>/<run-id>/`，每次新建。启动broker前先登记该根并设置 `TMPDIR=<run-root>/tmp`（§5.1）；所有临时HOME/TMPDIR/JDT/构建缓存归入本次受管根。环境仅在任务子shell/脚本内生效，不能污染调用shell。broker建随机子根后立即登记/输出，不等clone或依赖复制完成；工具输出用于补全子路径，预登记父根负责覆盖输出前被杀的窗口，不通过全局通配猜测归属。默认SIGTERM/SIGKILL可能绕过JavaScript finally，收尾必须先确认进程退出，再核对和清理本次精确路径。持久路径避免系统临时清理，不豁免下列到期清理。

| 类别 | 收尾时机 | 必留信息 |
| --- | --- | --- |
| BULK：DB/快照/clone/worktree/dist/缓存 | 运行结束；明确有后续consumer才延后 | 输入/构建身份、命令、摘要、consumer与到期门 |
| RAW：调用/时间线/profile/模型原文 | 本G门的独立评审已给结论且受影响修复已验证后，即gate closeout | 摘要/样本计算依据/hash；付费或重跑>1 h的记录按下述流程归档 |
| INPUT：本次冻结副本、数据集 | 对应最后consumer完成 | commit/hash/恢复方法；历史归档不动 |
| REPO / LOCAL：公开摘要 / 本机归档及小型结果记录 | 保留 | 不自动删除；不可把整套RAW/BULK改名为LOCAL绕过到期清理 |

**每个G门的closeout是明确事件：** 验收结果写定 → 所需独立评审完成 → 原始证据核对 → 归档/删除到期产物 → 填`testData`。要求 `unregisteredPaths=[]`、`expiredResidualBytes=0`；仍有效的INPUT或跨门carry-over列出确切路径、consumer和到期门，不要求它们为0。FAIL/BLOCKED也有收尾；最小诊断现场可以登记下一consumer。不能因测试失败无限保留整套副本。

归档顺序固定：生成逐文件SHA-256清单 → 打包 → 解包到本次临时验证目录 → 重算全部hash并比较路径集合/字节数 → 确认一致 → 删除解包验证目录与原始RAW。一次物理解包校验足够；独立执行者核对归档hash、关键原始断言与实际资源/目录残留，不默认再解包一遍。归档或验证失败保留原件，不宣布清理完成。只删除本次登记且到期的精确路径；不对`/tmp/ilv2-*`或整个TMPDIR通配删除。历史残留另按其归属和授权处理，不自动并入本次运行清单。

统一收尾入口为`ilv2-mac-closeout.mjs --finish <closeout-manifest.json>`。清单明确登记`runRoot`、`gateId`、`artifacts`、`processes`（PID及确实拥有的PGID）、`launchdJobs`和递归LOCAL的`closeoutDirectory`；使用fixture配额时附`workRoot`。入口只读证明本次资源实际退出及配额释放，再对到期RAW归档并物理校验一次，删除到期目录，生成`closeout.json`。原始错误由runner双流保存，收尾错误单独报告；收尾PASS不代表产品G门PASS。独立收尾使用`--manifest`核验实际残留，并独立调用资源退出核验，不重建、不重复归档。跨门候选必须登记consumer/到期门。

评测单批预计峰值≤20 GiB，保留30 GiB磁盘余量；不新增三仓矩阵的主机拒绝门。以下模板为待填执行记录，`null`表示尚未测量：

```json
{
  "taskId": "MAC-02A",
  "status": "PLAN",
  "identity": {"sourceDigest": null, "nativeDigest": null, "runtimeManifestSha256": null},
  "inputs": [],
  "checks": [{"name": "planned-test-name", "argv": [], "expected": "behavior assertion", "exitCode": null, "evidence": null}],
  "artifacts": [{"path": "<exact-managed-path>", "class": "RAW", "consumer": "G02A-review", "expiresAtGate": "G02A", "disposition": "PENDING"}],
  "testData": {"unregisteredPaths": [], "expiredResidualBytes": null, "carryOver": []},
  "approvals": [],
  "remainingGaps": [],
  "next": "N/A"
}
```

## 1. 基线、根因与不继承的旧设计

### 1.1 可复用的历史输入

P0-T0冻结记录见[frozen-repos.json](../index-lifecycle-v2/p0/frozen-repos.json)。以下身份只描述冻结时输入，历史清单不改写。MAC-00将可核验输入复制或从指定commit重建到§0.3持久根，生成新的实际路径/内容manifest；目录存在或HEAD相同不能证明文件仍完整。

每个consumer使用冻结副本前都执行 `git --no-optional-locks -C "$repo" status --porcelain=v1 --untracked-files=all`、`git --no-optional-locks -C "$repo" fsck --full`，核对预期HEAD、工作树状态，以及冻结manifest的相关Java/XML/build输入路径集合与实际字节hash。缺文件、额外文件、dirty状态或对象损坏必须中止该输入；不能只靠fsck（不校验工作树）或只靠HEAD。MAC-00建立manifest；MAC-01将这组前置核验纳入runner并测试“HEAD不变但文件缺失”。run copy与冻结输入分开，业务原仓和历史副本仍只读。

| 仓库 | 冻结 commit | Java / XML 数量 |
| --- | --- | --- |
| lishuedu | `db63b1a7e393edd90449eb013d7d1c4d65c366f2` | 5312 / 3 |
| cipherlink | `fa433982e92e52dd610650d1e79f2d041179b1d3` | 633 / 6 |
| exam-parent-v3 | `f90a0b475f7be2ed003703feecec8195bc7eb976` | 1370 / 26 |
| lishu-v2 | `fd9c117b4cfad46247757d4c373b9465534fe33f` | 6160 / 89 |

历史源码基线用于对照；手册重写前 HEAD 用于定位当前实现。后续候选必须记录自己的 source digest，不能沿用 release 名称证明本地未提交 native/source 输入已被测试。

### 1.2 这次要删除的根因组合

旧实现把作业进度、coverage、恢复选择和可服务性压进 `buildState`；`BUILDING/DEGRADED` 又触发 recovering 全量路径。长同步事务没有可见进度，watchdog 误认为停滞；终止后再恢复，可能循环。与此同时，解析后再读源码生成搜索文本、stat 相等跳过 hash、请求提前固定旧视图、每进程各自管理 root 槽位，使“原子快照”本身也不足以保证结果正确。

review 已读源码并运行既有 23 项定向测试、int64 实验。它们不是本计划的新实现验收。历史大仓活锁、APFS 物理成本、新水位协议和真实多 worktree 行为仍需下面的门证明。

## 2. 唯一目标合同

### 2.1 Mac 平台、唯一owner和最小launcher

- 一个launchd job运行一个Node daemon；小型C launcher获取独占锁后直接`exec`冻结的Node，不新增常驻guardian。cache/scheduler/publisher/GC只有一个owner；stdio仅转发本机MCP transport。
- 默认选择launchd进程组清理 + flock生命周期锁。Apple文档支持job退出时清理同进程组剩余进程，`AbandonProcessGroup=false`；这不证明任意后代都在同PGID，也不证明Node默认继承锁。MAC-02B必须实测后才能认定该路线成立。
- 锁文件固定在canonical cache root内，生命周期内不unlink、rename或被GC重建，防止不同inode上各持一把锁。launcher单次等待锁最多5 s，用monotonic时钟、`LOCK_NB`与约100 ms的sleep重试，期间不exec、不spawn、不偷锁；到期以非零退出码返回OWNER_BUSY。launchd配置显式固定`RunAtLoad=true`、`KeepAlive={SuccessfulExit=false}`、`ThrottleInterval=1`、`AbandonProcessGroup=false`，OWNER_BUSY与异常退出可重启；有意停服使用bootout或约定的正常退出0。默认10 s节流不能与故障后10 s恢复门混用；这些配置也不保证系统调度时延，G02B须实测整个故障时间线。
- launcher把锁映射到固定fd4，清除该fd的`FD_CLOEXEC`后exec绝对`NODE_BIN`。Node的Darwin spawn默认关闭未显式映射的fd，所有访问服务缓存/持有快照的受管子进程必须显式传递同一open-file-description的锁fd（IPC用fd3，lock用fd4）；下一层spawn也遵守。子进程只close自己的引用，禁止`LOCK_UN`，因为它会解除共享锁。不得靠每个子进程重新open锁文件冒充继承。
- daemon、builder/query/parser子进程、FSEvents helper以及JDT wrapper→JVM属于`OWNER_PROCESS`，不得detached/setsid逃出受管组。Node→builder→parser、Node→JDT wrapper→JVM的PGID和fd继承逐级验证；线程共享进程锁。现有`ps -o lstart`只能辅助诊断，不能当高精度birth identity或以裸PID杀未知进程。
- JDT导入引起的Gradle daemon单列为`EXTERNAL_BUILD_DAEMON`：不假定与owner同PGID或继承fd4，也不能以launchd清组证明它已回收。三个冻结Gradle仓（lishuedu、cipherlink、lishu-v2）的wrapper目前均为9.3.1；exam-parent-v3没有Gradle wrapper。该版本源码存在detach路径，实际PGID/fd行为由G02B实测。Tooling API使用daemon，不能靠普通`--no-daemon`省略生命周期证明。
- `serviceStateRoot`定义为正式服务的`~/Library/Application Support/codex-java-lsp-mcp/state/`；独立Gradle home固定为其`jdt-gradle-home/`。canary/fixture改用各自登记的`<runRoot>/service-state/jdt-gradle-home/`，不得复用生产或其他owner域的路径。不共用用户`~/.gradle`；环境`GRADLE_USER_HOME`与`java.import.gradle.user.home`必须指向同一路径，冻结JDT/TAPI/JDK和实际Gradle版本，核验有效home及registry/log。当前`src/jdtls-lsp-io.ts`未传该环境变量，外层设置或改HOME不算完成。该目录不属于快照GC，不随schema/cache重建、release切换或回滚删除；卸载/手动清理先确认本域daemon全部退出，再按对应授权执行。
- 正常停止：阻止新导入 → 取消在途操作并关闭连接/JDT → 对私有home内实际使用的每个Gradle版本，以已核验的本机分发程序、显式该home执行`--stop` → 确认本域daemon实际退出。`--stop`只覆盖对应版本；退出0、关闭TAPI连接或idle timeout都不单独证明退出。恢复清理同域最多一个在途操作；失败不忙重试、不临时下载新版本、不广泛pkill或裸PID猜杀、不清理其他域、不删除home。
- 恢复分两道门：旧OWNER_PROCESS全部退出、原锁独占且binding恢复完成后，可接纳静态请求、开放静态builder/query槽及publisher/快照GC。Gradle清理在后台门控**新JDT/Gradle导入和语义请求**；未完成记`semanticState=RECOVERING`，失败记`RECOVERY_BLOCKED`，required语义请求有界返回明确缺口，auto仅交付可证明的静态结果。不复用旧JDT结果，也不把semanticState混入indexFreshness/coverage。纯静态full/delta不得启动Gradle/JDT或把未核验的外部依赖当完整语义事实；外部daemon不得访问mac1的snapshot/binding/jobs。只有先证明此资源边界，才允许静态服务独立恢复。
- daemon死亡后launchd清同PGID后代；任何OWNER_PROCESS仍持锁时第二launcher只可有界等待，不启动新owner。取得锁不等于外部Gradle已退出；静态可用不等于完整恢复。测试harness分别证明组内退出、锁获取、静态可用、外部清理和语义恢复；finally失效窗口由隔离launchd测试证明，不把单纯`process.kill(parent)`当完整恢复。
- MAC-02B覆盖刚启动后及稳定运行时SIGKILL、锁暂占用、锁等待超时/OWNER_BUSY重启、活动Gradle导入中故障、同root重复启动、父死子存和锁fd意外关闭。原“故障后≤10 s完整清理”仍为G02B/G06C硬门，两类进程从同一故障时刻计时；静态降级可用不能将清理超时改判PASS。若互斥或完整收敛失败，用失败证据修复该门，不预先增加自有持久PID日志/start gate/常驻guardian。
- 原生部分限于capability、clonefile、FSEvents和小型exec/flock launcher，使用C17系统API；架构/协议/binary digest可验证，不做universal或Node ABI addon。clonefile只用于**缓存卷内**SEALED DB→私有tmp DB。APFS、同卷是缓存路径硬前提；业务仓库可在另一卷，capture读取实际字节，不调用clonefile。
- 不支持clone、helper缺失或runtime身份不符明确失败，不转普通复制。Node/OS升级重新冻结并跑受影响门；不能把另一PATH会话的版本当本候选版本。

服务域最多一个owner。不同baseline/candidate测试实例使用隔离root和临时PGID，不构成正式多owner支持；常驻实例限制见§0.1。

### 2.2 四类状态，不共用一个 READY

| 对象 | 状态及真源 | 禁止推导 |
| --- | --- | --- |
| Job | `QUEUED → RUNNING → RESULT_RECEIVED → REAPING → SUCCEEDED/FAILED/CANCELLED`；scheduler/真实子进程退出 | result 到达不等于槽释放；数据库字段不选择 full/delta |
| Snapshot | `PRIVATE → SEALED → 可绑定 → RECLAIMED`；封存 manifest | SEALED 不等于每文件解析完整；published 是绑定关系，不是可变 DB 状态 |
| Coverage | 每文件 `COMPLETE/PARTIAL/FAILED`，另记解析/引用/构图缺口 | 坏语法不能阻止其余可用内容发布；旧成功事实不能冒充坏文件当前事实 |
| Workspace freshness | `UNVERIFIED/VERIFYING/FRESH/STALE/INVALID_ROOT`；已验证绑定 + 当前 pending | 作业失败不抹掉旧可服务快照；全局最新状态不改变已持有 view 的标签 |

全仓 census 必须覆盖所有纳入索引的文件及其结果，包括失败、删除和资源文件。结构完整但 coverage 降级的快照允许封存、绑定和查询。否定回答必须证明**查询依赖范围 coverage 完整且满足请求水位**；全仓“无调用方”需要全仓相关 coverage。无法可靠计算缺口影响闭包时返回 PARTIAL，不猜测缺口无关。

### 2.3 内容捕获、环境与身份

1. 每文件捕获一次实际字节；contentHash、AST、原始语法事实、search 文本、声明片段都从这一份字节产生。parse/resolve/graph 阶段禁止重读 live 文件。
2. capture 包含完整相对路径 census、Java/XML 内容身份，以及真正影响结果的布局、build 配置和 resolver 环境。目录新增、删除、rename、dirty/untracked、Git conflict 状态均有显式处理；不能只读 Git blob 代替过滤后的工作树字节。不得跟随符号链接越出授权 root，外部依赖按明确输入合同处理。
3. capture只读源文件字节，可在受管tmp保存staging；不用clonefile捕获业务文件，因此不要求业务仓库与cache同卷。逐文件读取不是整棵树的原子快照。捕获结果可代表不同文件的不同捕获时刻，但必须自洽、可追溯；扫描期间还有变化则发布后仍 STALE，并继续追赶。禁止为了等全树静止无界重启。
4. `snapshotId` 标识封存产物；`contentManifestId` 标识排序后的路径/内容/环境清单；`buildKey` 包含 schema、parser/grammar、extractor/resolver 版本及实际相关环境输入。daemon 的整体 Git SHA 只用于构建可追溯性，不自动作为解析失效键。
5. 事实库只保存相对路径、内容 hash、语法/关系和 coverage。canonical root、文件stat和访问时间在workspace sidecar；原生watch游标只在内存。禁止 seed 时全表重写目标 worktree 的 mtime/root。
6. 查询源码 preview 若需读 live 文件，必须校验 hash 与持有 snapshot 一致；不一致时返回明确缺口或读取保存的捕获片段，不能以旧 hash 标记新文本。

### 2.4 FSEvents、水位和 verified-noop

本地确认水位是 `(workspaceGeneration, trackerEpoch, seq)`，原生游标 `(volumeIdentity, streamIdentity, eventId)` 仅保留在当前事件流的内存状态/诊断中，不写入sidecar或binding，也不用于跨重启回放。eventId 不连续不是掉事件证据。原生 helper 传递原始恢复信号；Node 不用 `fs.watch` 猜测这些信号。

- 先建 watcher，再开始初始扫描。dispatch 先 flush/fence 已到达事件，冻结 `coveredThroughSeq = s`、root/environment 身份及 pending 集合。helper 必须定义 fence 响应的顺序，不能声称它证明今后没有迟到事件。
- pending 为 `path → maxSeq`，另有带水位的全局 `rescanRequiredThroughSeq`。drop/root/resume/无路径信号也递增本地 seq；dispatch 冻结本轮 rescan cut。本轮只清除 `maxSeq ≤ s` 且实际验证过的项；扫描期间或迟到事件生成更高 seq，留给下一轮。部分路径验证不能清全局 suspect；完整扫描也只能清除其覆盖的 rescan cut，扫描期间新增 drop/重扫水位必须保留。
- suspect 路径强制 hash。启动、重启、drop/事件流重建、root 身份变化、resume 后强制全量内容验证；稳定路径可用包含纳秒 mtime/ctime、size、file identity 的 stat 缓存缩小普通扫描范围。每个 active workspace 至少每 10 分钟安排一次完整 hash；idle workspace 下次使用先校验。
- `MustScanSubDirs` 对作用子树递归验证；`UserDropped/KernelDropped` 或无法界定范围时全量；`RootChanged` 先重建 root 身份，根失效返回 INVALID_ROOT。重扫标记只有完整确认且当前 rescan 水位不高于本轮 cut 时解除。
- verified-noop 是成功结果：已验证的完整 manifest/environment 与绑定 base 一致，可不生成 DB，原子更新确认水位。touch、edit-revert、启动同内容校验因此可以恢复 FRESH。
- noop/publish 先核对workspaceGeneration和trackerEpoch，再使用dispatch时的绑定版本作CAS前提；epoch不同即拒绝旧结果，即使seq相同。如果base/根/环境已变，不得把旧确认套到新绑定上，重新校验或丢弃结果。pending清理仍受本轮实际覆盖范围约束。
- FRESH 只表示所声明水位已验证且当前没有已知未确认提示，不承诺文件系统在响应后绝不再改。启动后旧持久水位不能直接恢复 FRESH，必须先重新验证。

### 2.5 FullPlan / DeltaPlan 与工作量

`BuildPlan` 必含 jobId、ownerIncarnation、workspaceGeneration、captureId、contentManifestId、buildKey、确认水位、baseSnapshotId（可空）、bindingVersion、changed/deleted/affected 清单及预算。builder 不读 `buildState` 决定工作类型。

- FullPlan 从捕获清单构建全量 census 与派生关系；DeltaPlan 从兼容 SEALED base 的 clone 开始，仅更新变化文件及必要依赖闭包。坏文件移除旧事实并保存缺口；未变文件复用原有语法事实，不重读源码。
- 类型/方法导出变化、跨模块继承、调用和 XML 绑定的依赖闭包需要专门 fixture。不能证明闭包完整或 buildKey 不兼容时显式 FullPlan，原因写遥测；不得静默进入 recovering。
- 全量重解析、依赖重解析、SQL 写入分别计数。`parsedFiles` 必须等于计划要求的集合，不能用最终查询正确掩盖 delta 退化成 full。
- 私有 tmp 允许分批事务，读者不会访问它。单批 resolve/graph/SQL 必须可观测并有预算，不再用巨型事务保护不存在的读者。初始 `deltaMaxTouched=400`，MAC-11 依据时间/写放大校准；正式门前冻结。
- build 无内容变化返回 verified-noop；失败保留旧绑定；发布前必须通过封存验证。失败重试只对明确暂时原因有界一次，语法失败走 coverage，不触发重建循环。

### 2.6 调度、截止和释放

- 服务域最多 2 个活动 builder，最多 1 个 full/大作业；另一槽保留给 capture/seed/小 delta。误估的小作业发现超过阈值时保存可复用捕获、释放槽并进入 full 队列，不能占住保留槽继续长跑。
- 同 workspace 最多一个作业，其余提示合并；dispatch 重新选 base，不能把排队时的 CURRENT 路径当永久有效。队列同类 FIFO，等待中的旧 full 必须在前一 full 退出后获得机会；测量小 delta 的等待上限。
- parser worker 总量由 owner 授予 token，初始全域 ≤ 4，MAC-12 在 {1,2,4} 中冻结；不能每个 builder 各开 8 个。query 子进程初始池上限 2，有界排队，SQL/大范围解析/目录遍历不在 daemon 主事件循环同步执行。
- 请求从入口创建 budget，覆盖 resolve/create/prepare/query/preview/序列化；所有调用在 `deadline + 1000 ms` 内返回。freshness prepare ≤ `min(1000 ms, remaining)`，发生在首次 acquire 前。status(start=false) 只读内存状态，不建 entry、不扫描、不启动 JDT/build。
- deadline/取消撤销请求等待和响应权；共享 build 归 scheduler 管理，不因一个 caller 超时而取消。请求专属 worker 必须可终止，stop 时 queued promise 全部 settle；只做 Promise.race 和 finally 不算完成。
- 进程或worker真正停止/reap前不能释放其snapshot lease。query取消到资源收敛上限2 s；owner完整恢复仍从故障注入起≤10 s，分别核验OWNER_PROCESS和本域EXTERNAL_BUILD_DAEMON退出，超时则完整恢复门FAIL。旧OWNER_PROCESS未退出时不接纳任何请求、不开放槽或publisher/GC；它们退出且锁/binding恢复后允许静态服务，外部清理只阻塞语义，状态按§2.1披露。正式性能窗口必须等两类遗留进程清到0，不带残留JVM继续矩阵/K29；这项“零残留”不禁止语义专项按计划新启动的受管进程。
- builder 心跳每 1 s 最多一次、正常到达间隔目标 ≤ 2 s；协调线程发送 liveness，另有真实阶段 work counter。两者分开，心跳存在不能掩盖无限工作。阶段无工作进展 30 s 进入诊断，按冻结预算终止；健康大阶段必须拆批或提供可观察进展。
- full 作业上限 `max(600 s, 3 × B_full)`，B_full 在 MAC-00 取基线无故障完整 full 的中位数；无法测得基线时用 900 s 并标 UNMEASURED_BASELINE。seed/delta 作业上限 60 s。它们是终止上限，不是性能通过阈值。

### 2.7 封存、绑定、读 lease 与 GC

目标缓存格式为一个新的 `mac1/`，不读取 v9/v10/legacy 库：

```text
mac1/
  owner/                         # 稳定inode的锁文件；incarnation仅作身份/诊断
  snapshots/<snapshotId>/         # index.sqlite + sealed manifest；发布后永不写
  workspaces/<workspaceId>/
    binding.json                 # 唯一正确性提交点
    observations.json            # stat、访问统计等可丢弃观测
  jobs/<jobId>/                   # 私有捕获、tmp DB、进程身份
```

独立服务状态目录为`serviceStateRoot/jdt-gradle-home/`（绝对路径及隔离实例规则见§2.1），位于上述mac1缓存树之外。它保存Gradle发行版、依赖和daemon registry，不是快照可回收物；snapshot/workspace GC不得遍历或删除它。安装/回滚清单明确保留该目录；清理入口复用外部daemon停止与授权边界。

发布次序：私有写入完成 → checkpoint/关闭所有写句柄 → integrity/外键/census/派生校验 → 保证无 WAL/SHM → 写封存 manifest → 同卷 rename 到 snapshots 并同步文件/目录 → 写临时 binding、同步并原子 rename → 同步 workspace 目录。失败结果不得进入绑定。SIGKILL 恢复与断电耐久分开报告；fsync API 调用过不等于做过断电试验。

`binding.json` 一次提交：formatVersion、workspaceId、canonicalRoot、root/volume identity、workspaceGeneration、bindingVersion、snapshotId、contentManifestId、buildKey、trackerEpoch、coveredThroughSeq。统计字段可另写；这些正确性字段不能拆成 CURRENT 与游标两次无关系写入。

SnapshotStore 在唯一 owner 内串行处理 acquire/publish/GC 删除决策；所有使用者用同一种 lease：请求、query worker、候选扫描、builder base、正在发布的候选。base 从选中到 clone 完成保持 lease；base/reader 最后一个使用者结束才能回收。已标记删除的对象不再授予 lease。

请求在有界 prepare 之后一次 acquire，直到结束固定同一 snapshot。发布不会更新该请求的 view 或 freshness 标签。跨发布的 hits/coverage/preview 必须仍指向同一内容身份；无法取得本工作区已验证绑定时返回 NOT_READY，不能借未核验 sibling 应答。

零差量目标 worktree 完整核验 manifest/buildKey 后可直接绑定现有快照；响应 repoRoot/workspaceId 来自目标绑定。这是已证明的同内容复用，不是 sibling 推测。不同内容使用 clonefile + delta；文件 hash 和证据路径仍按目标工作区验证。

GC 仅处理无绑定、无任何 lease、无有效在途发布/进程的快照和 tmp。删除 workspace 绑定前必须确认无活动请求、排队/运行作业及待确认 root 状态；所有删除分支用同一个判定，不靠固定 grace 猜安全。进程退出后至多两个 GC 周期收敛；初始 GC 周期 30 s。历史生产缓存不在新 GC 删除范围。

### 2.8 schema 与精度边界

- 新 schema 使用安全小整数 surrogate PK；所有 Node number 读取必须满足正整数和 `Number.isSafeInteger`。hash 用固定长度 BLOB 做查找辅助并比较原文，碰撞不可合并两个实体；不把任意 int64 hash 当 number 主键。
- file/owner/kind 等重复身份正规化；对外ID与快照内部surrogate key分离。共享事实库只保存workspace无关的`declarationKey`（规范化相对路径/kind/owner/signature），对外`symbolId`在目标workspace绑定处组合workspaceId与该key，不把root/workspace前缀写进共享DB。对命名符号，`symbolId`由workspace身份、相对源码路径、声明kind、qualified owner/name及擦除后的成员签名派生，不含snapshotId、generation、行号或数据库行号；跨full/delta/noop及无关发布保持稳定。可编码规范化身份或hash并校验原文，不能以hash碰撞合并实体。多源根同FQN仍按源码路径区分。
- “旧ID拒绝”只指mac1之前的格式；mac1符号ID在当前view解析，签名/名称/源路径改变或符号删除才失效，返回NOT_FOUND/AMBIGUOUS并给出重新定位提示，不猜测重绑定。root同路径重建生成新workspace身份，旧workspace ID明确拒绝。方法体、注释、行位移不改变命名符号ID，但sourceHash/range随新snapshot更新。匿名/局部符号若没有可证明的结构身份，显式返回`stability=SNAPSHOT`的evidence handle，不能混称长期symbolId。
- `evidenceHandle`才包含snapshot/capture/sourceHash与range，服务精确版本读取；它与跨请求symbolId是两种用途，不为每次发布重造符号ID。索引组织按真实查询计划验证。
- 当前 facts 已使用 deflate 压缩。字典编码不是预定必做项；先测重复列、索引和压缩 BLOB 的物理占比，再决定 MAC-12 的收益项。同一候选只读一个正式schema，内部试验缓存可重建；若选择提前发布，后续schema变更的重建成本按§3.1披露，不保留旧格式兼容读取。
- JDT session 以 workspace/root/environment 绑定，独立文档 URI/状态；禁止一个 family 的同 URI didOpen overlay 在 worktree 间切换共享。独立语义会话使用全局配额与 idle 回收。
- 内容寻址语法缓存仅在 MAC-12 的 profile 支持时引入；key 含字节与 grammar/extractor 版本，缓存位置无关语法数据。模块、路径、resolver、JDT 结果不能仅凭相同 contentHash 复用。

### 2.9 标识符与数据模型

| 字段 | 定义/生成边界 | 存储和使用范围 |
| --- | --- | --- |
| workspaceId | canonical root与卷/根身份导出的工作区身份；同路径根替换产生新值 | binding和请求路由；不同worktree不同ID |
| workspaceGeneration | 同一workspace的输入边界变更代数，root/env重建递增 | binding/plan；拒绝旧作业结果，不是每次内容发布号 |
| trackerEpoch / seq / coveredThroughSeq | 当前watcher的随机epoch、提示序号与本轮已验证上界 | 当前epoch内是接受结果、清pending、确认FRESH的正确性字段；binding与snapshot身份原子提交。重启后的旧持久值仅供追溯，不能恢复FRESH；新epoch必须全量hash |
| rescanRequiredThroughSeq | 最近要求全量/子树重扫的提示水位 | 内存；只有覆盖该cut的验证能清除 |
| captureId | 一次内容捕获尝试的唯一ID，不代表全树同一时刻 | job/结果/诊断；关联捕获字节与派生事实 |
| contentManifestId | 排序路径、内容hash和相关环境清单的digest | sealed manifest/binding；判断同内容复用 |
| buildKey | schema/parser/grammar/extractor/resolver及相关环境版本digest | 判断事实可复用；不含无关daemon提交号 |
| snapshotId | 一个封存产物身份 | store/lease/evidence；不承担符号长期身份 |
| bindingVersion | workspace绑定每次publish或noop确认递增的CAS版本 | 单次原子binding提交；旧验证不能覆盖新绑定 |
| declarationKey | workspace无关的相对路径/kind/owner/signature身份 | 共享事实库；surrogate PK只作库内关联 |
| symbolId / evidenceHandle | 跨发布命名符号身份 / 特定捕获版本的证据句柄 | 前者用于多步工具调用；后者校验版本/hash/范围 |
| ownerIncarnation / jobId | 单次daemon生命周期ID / 单次作业ID | IPC与日志，拒绝旧结果；不代替flock锁 |
| volumeIdentity / streamIdentity / eventId | 当前FSEvents来源和事件位置 | 内存/诊断；不是内容真源或持久恢复点 |

## 3. 实施顺序与任务卡

任务表是依赖 DAG。没有依赖冲突的只读工作、数据集建设可并行；不并发修改同一所有权/状态模块。MAC-00先用旧实现做成本spike，MAC-05跑真库薄切片，MAC-08前置查询/三仓回归，MAC-11完成含调度、故障和GC的系统闭环，再进入MAC-12热点优化；不以“全量单测绿”代替它。

| 任务 | 交付 | 依赖 | 完成门 |
| --- | --- | --- | --- |
| MAC-00 | 冻结runtime/输入、旧实现spike和成本边界 | 无 | G00 |
| MAC-01 | 状态/故障 oracle、runner 和遥测骨架 | MAC-00 | G01 |
| MAC-02 | native构建/clone、flock launcher、FSEvents三张子卡 | MAC-00、MAC-01 | G02 |
| MAC-03 | 同字节捕获与tracker两张子卡 | MAC-01；MAC-03B另需MAC-02C | G03 |
| MAC-04 | 唯一新schema、稳定符号ID、逻辑导出 | MAC-00、MAC-01 | G04 |
| MAC-05 | 显式full/delta及真库薄切片 | MAC-02A、MAC-03A、MAC-04 | G05 |
| MAC-06 | owner/调度、query取消、恢复三张子卡 | MAC-02B、MAC-05 | G06 |
| MAC-07 | SnapshotStore、原子绑定与统一 lease | MAC-03、MAC-04、MAC-06 | G07 |
| MAC-08 | 请求/transport接入、删除、早期回归三张子卡 | MAC-05、MAC-06、MAC-07 | G08 |
| MAC-09 | GC 与真实故障矩阵 | MAC-08 | G09 |
| MAC-10 | 真实 task/gold/oracle 与无模型评测 | MAC-01 | G10 |
| MAC-11 | lishu-v2完整系统闭环；可选提前发布检查点 | MAC-09 | G11 |
| MAC-12 | 根据 profile 优化写放大、并行与语法复用 | MAC-11 | G12 |
| MAC-13 | 面向任务的工具合同与 guidance | MAC-10、MAC-11 | G13 |
| MAC-14 | K01–K32、全量和三仓整合验收 | MAC-09、MAC-12、MAC-13 | G14 |
| MAC-15 | 成对模型 A/B 与最终 holdout | MAC-10、MAC-13、MAC-14；最终holdout另需MAC-16 | G15 |
| MAC-16 | 语义精度实验，按失败证据决定 | MAC-14 | G16 |
| MAC-17 | 最终候选、安装包、canary 和交接 | MAC-14、MAC-16 | G17 |
| MAC-18 | 最终候选正式切换（或提前版本的后续升级） | MAC-17、明确安装授权 | G18 |
| MAC-19 | 观察、结果分账和收尾 | MAC-18 | G19 |

MAC-15 的付费授权不阻塞工程候选 MAC-17，但缺实测时不能宣称 agent 成功率/token 提升。MAC-16 可以因没有语义失败证据而 NOT_RUN；若实施语义修改，MAC-17 必须使用修改后的源码，并重新完成 MAC-14 受影响门。MAC-15 可以先做 dev pilot；最终 holdout 必须等 MAC-16 PASS/有依据 NOT_RUN、相关 MAC-14 重验以及 source/native/driver/guidance 冻结后才运行。若 holdout 后又有影响行为的修改，旧收益证据过期，只能使用新 holdout，不能在同一保留集补测调优。这样避免把条件实验伪装成已完成能力。

### 3.1 可选提前恢复服务，默认不执行

G11正确性通过后可以准备提前候选，避免把数据集/模型实验/后续优化误当恢复服务的必需前提。这不是自动部署授权，也不是“只要G11绿即可安装”。提前候选必须完成G00–G09适用合同、G08C容量/三仓、G11正确性/有界资源，并前置执行MAC-14的必需全量/PR/K01–K32（含实际提供语义能力的真实JDT证据）、MAC-17的工件身份/canary/回滚要求。提前检查只前置复用这些任务中的验证/打包步骤，不把尚依赖后续功能的整张MAC-14/17标PASS；单独生成`early-release-checklist.json`，逐项绑定当前代码实际提供的合同。复用相同身份的有效证据，不重复跑。

提前canary沿用MAC-17的隔离、至少2 h/1000次请求、工件身份、故障/回滚场景，但按`early-release-checklist.json`判定：正确性、隔离、截止、资源回收、必需K/K29必须通过；full/seed/编辑可见等其余性能完整实测并披露，不调用完整G17的最终性能PASS条件，也不把整张G17标PASS。最终候选G17仍要求§6全部适用SLO。

可以暂不完成MAC-10/12/13/15/16的后续收益工作；G11已测出的性能缺口必须列入候选报告，不能标成最终性能PASS。正确性、隔离、deadline、资源回收、K29或必需K阻塞不得豁免。如果希望缩小对外能力范围，先形成明确的版本化合同和影响清单，不能静默绕过失败门。

准备好具体SHA/runtime/native/缓存根/性能缺口/回滚证据后，由用户决定是否提前安装。执行与读回复用MAC-18，观察复用MAC-19，各自以`early`候选身份单独记账；之后最终候选仍需自己的验证与安装授权。若schema/buildKey后来变化，直接重建新缓存，旧格式不迁移；额外冷建时间和暂时双缓存磁盘成本在提前报告中列出。提前可用不等于整个计划LANDED。未选择提前方案时继续原默认顺序。

### MAC-00 — 冻结runtime、输入和最早成本spike

**执行状态：** `PASS`（G00，有限旧路径诊断）。[执行结果](../index-lifecycle-v2/mac/mac-00/README.md)列明未验证维度；不计作新架构性能或生产验收。

**范围：** `docs/index-lifecycle-v2/mac/mac-00/`、历史冻结清单与隔离运行目录；不修旧生产产品。spike允许在临时checkout加测量探针和一次性C clonefile探针，产物不进入生产路径。

**步骤：**

1. 冻结 `runtime.json`：绝对NODE_BIN（已观察路径 `/Users/luo/.nvm/versions/node/v22.16.0/bin/node`）、可执行文件SHA-256、realpath、完整`process.versions`、架构、macOS build、native工具链。只读核对生产release/launchd实际指向的Node；无法读取则标明生产版本未验证，不用旧手册替代现场。当前入口 `run-isolated-node.sh` 的 `exec node` 与安装器的 `command -v node` 都可能漂移，MAC-02A统一修正。
2. 本卡测量直接使用冻结绝对Node；暂不经仍靠PATH选择Node的broker。先按§0.3/1.1建立并完整核验持久冻结副本，把runtime/thresholds/输入manifest留在`plans/mac-00/<freeze-id>/`，不依赖/tmp跨天保留。记录source/tree、主机资源/APFS、已有服务只读状态及四仓输入commit/hash；缺失/损坏输入从指定commit重建独立副本，不修改历史或业务原仓。
3. **先做一轮探索spike再重做schema。** lishu-v2旧路径完整cold build并记录parse/resolve/graph/search/SQL/checkpoint各阶段及CPU/墙钟，逐source root报告discovered/indexed/failed/recovered、buildState、coverageRevision、integrity与census校验。关闭所有写句柄、checkpoint后用一次性clonefile探针克隆。自然状态不能进入非recovering时，如实标记该分支不可测；不得改写原基线或冒充自然增量成功。
4. 为同一封闭基线分别创建独立0/20/200变化副本：A仅模拟目标stat重戳；B实际内容差量并走非recovering入口；C二者组合。若B/C被coverage阻挡，**仅在结构完整、census一致且退化原因已归因时**，允许在独立一次性副本将buildState/coverageRevision设为READY/1，并记录`forcedNonRecovering=true`、原值/改值及副本digest；条件不满足仍不可测。保存精确changed/affected/实际parsed清单与计数，未编辑FAILED文件仍可能重解析，必须单列，不能称纯20/200 delta。分开报告file/resource stat、facts、graph/search和索引的页/写入增长。dbstat/页计数只是结构归因；物理COW按§5.4测量。强制分支只用于旧布局成本归因，不作正确性、自然增量可用性或收益门PASS，不发布、不作为正式base；新schema与seed仍由G05/G11证明。
5. 用spike决定MAC-04/05的布局和闭包实现。10%/30%物理增长、5 s/15 s首证据是默认承诺目标；维持或收紧无需额外确认。任何放宽必须在目标实现和采用放宽值的正式运行前取得用户明确批准，并在`thresholds.json`记录默认值、拟定/采用值、原因、未满足收益、批准人、批准时间及授权引用；等待答复不算批准，未获批准继续按默认值验收。必须保留外部请求截止、隔离/正确性与K门。候选测量开始后阈值锁定，失败只能修复或报告，不能再改到通过。
6. 需要相对full提速基线时再收集≥3次有效full取B_full中位数；同因已确认无法完成不盲重试，采用§2.6未测基线分支。历史活锁NOT_REPRODUCED不阻塞已独立确认的缺陷。

**验收G00：** runtime、四仓和spike身份可重建，权威冻结输入/批准记录/runtime均在持久根；status、fsck及输入路径/hash核验通过。每次probe的execPath/versions/digest与冻结一致，否则运行INVALID_EXPERIMENT、G00 FAIL。有效spike完成或明确给出不可测分支和设计限制，不能把没跑写成0增长。输出runtime/input/baseline/spike/thresholds/run-plan清单；MAC-04/05不得先落地再补spike。生产runtime若不一致，先明确选择统一目标再验证，不自动升级。

### MAC-01 — 先让错误可测

**范围：** 新 `scripts/ilv2-mac-{driver,burst-replay,slo-report,fault-matrix}.mjs` 及平铺测试、测试 fixture、遥测类型；`run-isolated-validation.mjs`/`run-three-repo-cold-matrix.mjs`的运行根登记；参照 `scripts/run-release-contracts.mjs`、`src/benchmark/release-index-contracts.test.ts`。

**步骤：** 增加读取runtime manifest并校验实际execPath/versions/digest的公共runner入口，以及暂存内容泄漏扫描（无正文输出）和gate-closeout清单验证；将MAC-00待提交证据纳入首次扫描。broker随机根创建后立即登记/输出，验证被杀后仍可从预登记父根确定归属；fixture daemon共享同机2个槽。实现 §5 的 driver/start/attach/instance 校验、计划解析、单调时钟和原始样本记录；定义 deadline/cancel、owner/query/base lease 数、parse/write 工作量和 first-correct oracle。构造重复样本、超时、漏结果、错误 hash、错误 workspace、占用端口、attach 到错误实例的自测。故障点必须支持阻塞屏障，让外部控制器在阶段中途杀真实进程。

**验收G01：** fake driver被正确判PASS/FAIL，错误身份不能开始负载；百分位/分母自测通过；status-only不触发预热；start只管理自身生命周期，attach不停止被附加服务。另用合成负向样本证明：扫描暂存blob而非工作树、stdout/stderr不含命中正文、docs没有整体豁免；未登记路径/到期残留拒绝closeout；broker创建后输出前被杀仍归属预登记父根；第三个fixture排队，取消/退出释放配额；HEAD未变但缺文件/坏对象/输入hash变化不能开跑。新增CLI在本卡结束才允许被后续门调用。

**执行状态：PASS。** 定向修复、独立行为复验、逐文件归档、实际收尾及暂存blob扫描已完成，见[MAC-01聚合证据](../index-lifecycle-v2/mac/mac-01/README.md)。该结论只覆盖验收工具，不抵扣后续产品、native、JDT或性能门。

### MAC-02 — native边界与构建供应链（分卡验收）

下列名称是**待实现的测试合同**；每张子卡完成对应GREEN后才能依赖它。父门G02只有G02A/B/C全部通过才PASS，不用一个大测试掩盖部分完成。

#### MAC-02A — 构建身份、固定Node与clonefile

**依赖：** MAC-00、MAC-01。**范围：** `native/macos/`、`src/mac-platform/`、`scripts/build-macos-native.mjs`、`run-isolated-node.sh`、`isolation-utils.mjs`、`run-isolated-validation.mjs`、`run-v4-gates.mjs`、`run-v4-http-smoke.mjs`、`run-three-repo-cold-matrix.mjs`、`run-release-contracts.mjs`、`write-build-stamp.mjs`、`src/build-info.ts`、`package.json`、安装器Node选择。

**步骤：** 同一个native builder输出`dist/native/`；candidate allowlist和sourceDigest纳入未跟踪native源码；普通/隔离/三仓/安装均构建它，不复制宿主旧二进制。所有入口显式使用冻结NODE_BIN；binder在任何分支返回前重绑定字面node，含nested broker；后续子进程复用该路径。覆盖v4的PR和release/HTTP smoke，去掉release固定38491，使用受管随机端口；实际bind失败明确退出，不能附加别人实例。stamp绑定native源/binary/protocol/架构/deployment target/工具链/runtime digest。capability/clonefile只覆盖缓存同卷，错误不fallback。

**目标测试/命令：** `scripts/ilv2-mac-runtime-contracts.test.mjs`：`reject-runtime-drift`、`targeted-pr-release-k-descendants-ignore-host-path`、`nested-broker-binds-current-executable`、`quoted-glob-is-expanded-in-candidate`、`release-smoke-binds-owned-port-and-reaps`、`native-untracked-input-is-captured`、`native-compile-failure-blocks-pass`；`dist/mac-platform/clonefile.test.js`：`same-volume-clone-or-explicit-error`。PATH首位放另一Node，实际test/PR/release/HTTP/K后代仍报告冻结execPath/versions/digest；源checkout的dist故意陈旧或缺失时，候选测试文件集合仍完整且glob只在候选展开。经§5.1定向入口运行；旧入口缺陷用行为RED，新能力用合同测试。

**G02A：** 运行、安装预检和manifest的Node/SQLite完全一致；不同PATH不影响选择；native改动影响身份；编译失败/错误架构/跨卷clone明确失败；业务仓库在另一卷的read capture不受此限制。D06为计划层替换，无需虚构删除不存在的源码。

**执行状态：PASS。** 固定Node/native构建与clone边界、定向入口/真实受管HTTP、独立复验、私有镜像卸载、归档和实际收尾均完成，见[MAC-02聚合证据](../index-lifecycle-v2/mac/mac-02/README.md)。历史baseline没有native时保留原始树并明确标注；当前candidate必须完整构建。wrapper fixture只证明运行时选择；正式K/PR/release、三仓、生产安装与后续MAC-03新capture仍未运行。

#### MAC-02B — flock launcher与launchd生命周期证明

**依赖：** MAC-02A。**范围：** 小型exec/flock launcher、Node spawn/fd传递辅助、`jdtls-lsp-io.ts`/`jdtls-semantic-backend.ts`的Gradle home与停止接入、隔离launchd/harness fixture；不写生产plist。

**步骤：** 按§2.1实现固定锁inode、fd4/IPC3映射及所有正式入口的lock校验。先用fixture逐级spawn，再核对真实builder/parser和JDT wrapper→JVM的组/锁；Gradle daemon按外部类单独核验private home、实际版本/PGID/fd、按版本stop及退出。G02B保留原生子进程继承合同及实测；按用户2026-10-14确认，真实FSEvents helper的fd/PGID实测归入G02C。隔离launchd job的label/plist/cache受本次manifest管理，plist只在本次run root，禁止写`~/Library/LaunchAgents`；结束后bootout，再用`launchctl print gui/<uid>/<label>`确认job不存在，核实进程退出后清理本次资源。

**目标测试/命令：** `scripts/ilv2-mac-owner-lifecycle.test.mjs`：`same-root-second-owner-is-rejected`、`bounded-lock-wait-and-owner-busy-restart`、`crash-soon-after-start-honors-recovery-budget`、`stable-sigkill-reaps-owned-group-and-preserves-lock-until-exit`（合并原稳定清组和锁存续两个相同场景，保留全部断言）、`child-alive-after-parent-sigkill`、`real-builder-parses-and-preserves-lock-and-pgid`；JDT/Gradle定向文件继续覆盖`jdt-wrapper-preserves-lock-and-pgid`、`gradle-private-home-and-bounded-recovery`、`gradle-failure-preserves-static-admission-state`。真实Gradle fixture用冻结9.3.1，覆盖正常stop和活动导入中SIGKILL/重启，并用另一私有home的对照daemon证明不误停；多版本分派用定向测试，实际采用其他版本时再补真实fixture。经§5.1及JDT隔离入口运行，不能用假日志代替实际存活/锁观察。历史G02B计数不改写。

**G02B：** 旧持锁OWNER_PROCESS尚存时第二launcher等待且不exec，超时非零退出；旧组退出后锁释放。验收刚启动即崩溃和锁暂占用两条实际launchd时间线，核对KeepAlive/ThrottleInterval以及OWNER_BUSY重启；两类旧进程正常清理须在同一≤10 s窗口退出。Gradle stop失败时用明确的恢复状态机fixture证明静态准入状态不被语义阻塞状态覆盖，且不会启动新JDT；有效home/按版本stop/实际exit/launchd卸载留证，对照域不误停。本卡不要求尚未实现的SnapshotStore、正式transport或GC，也不把fixture状态当正确查询的证明；完整产品恢复由G09必验。环境不足BLOCKED_ENV，不用guardian绕过证明。

**执行状态：PASS。** 最终37文件候选受影响定向8/8、独立8/8及源码评审通过；前候选真实launchd7场景与quota2测试保留其身份。实际JDT配置驱动两个私有Gradle域导入，活动故障后旧owner/JDT组与daemon从同一故障起点2156.013291ms退出，对照域存活。Documents权限经用户允许且观察到系统放行；两个EPERM夹具FAIL及定向RED保留，修复只以ESRCH证明退出、原10秒门不变。566文件归档完整解包核验、独立收尾、到期carry删除及job/PID/组/quota无残留均完成。详见[MAC-02B证据](../index-lifecycle-v2/mac/mac-02b/README.md)。G09完整查询恢复/重新initialize仍未运行；FSEvents锁/组实测归G02C，现可按顺序进入C。

#### MAC-02C — FSEvents传输和fence

**依赖：** MAC-02A、MAC-02B（按用户明确执行顺序）。**范围：** native FSEvents模式与TS协议解码，不持久化原生eventId；真实helper的fd4、同OFD锁和PGID继承实测。

**目标测试/命令：** `dist/mac-platform/fsevents.test.js`：`raw-flags-and-fence-order`、`drop-and-root-change-remain-observable`、`stream-restart-creates-new-epoch`，用§5.1定向入口。原始flags、drop、root变化、事件流重建都有结构化传递和顺序证明；native协议错误明确失败，不退回fs.watch。

真实场景用`scripts/ilv2-mac-fsevents.test.mjs`一次证明ready后变更、fence前缀、真实RootChanged、重建epoch和fd4/OFD/PGID；先到ready再注入变更。独立执行者在相同候选复跑该关键场景。协议注入drop仅记PROTOCOL_ONLY；未诱发真实OS溢出记NOT_INDUCED，不折算PASS或声称OS溢出实测。协议错误、volume身份和总fence时限由定向协议测试证明。

**G02C：** watcher先建再扫的接入合同可执行，内存cursor没有被误写成持久freshness；真实FSEvents helper继承owner的fd4/同OFD锁且同PGID，父引用关闭后锁仍有效，退出后锁引用释放。此实测由G02B转入本门，未运行不得算PASS；供MAC-03B集成。

### MAC-03 — 同字节捕获与tracker分开推进

#### MAC-03A — 纯TS内容捕获

**依赖：** MAC-01，可与MAC-02并行。**范围：** `java-index-file-parse.ts`、`search-document.ts`、cold/incremental search派生接口与capture类型。

**目标测试：** `dist/index-builder/content-capture.test.js`：`parse-search-use-identical-bytes`、`preview-rejects-live-hash-mismatch`、`source-root-may-use-another-volume`。Buffer/受管staging贯穿hash/AST/search，后续阶段不二读；source根无需APFS同卷。

**G03A：** parse后注入编辑仍同字节派生，census包含失败/删除/资源；删除D03。新schema/新full-delta可依赖本卡，不必等待FSEvents完成。

#### MAC-03B — 事件确认、水位与noop

**依赖：** MAC-03A、MAC-02C。**范围：** `repo-fs-watch.ts`替代、tracker、root/build身份、pending/rescan水位。

**目标测试：** `dist/java-index/snapshot/workspace-tracker.test.js`：`same-stat-changes-are-hashed`、`touch-edit-revert-startup-noop`、`drop-during-scan-keeps-new-rescan-cut`、`root-replacement-invalidates-binding`、`stream-restart-requires-full-hash`、`new-epoch-rejects-old-result-with-same-seq`。经§5.1定向入口。

**G03B：** Java/XML同stat变化能发现；扫描中新事件/drop不被旧cut清除；第一轮STALE、第二轮确认；持续编辑不无限重启。原生cursor只在内存，进程重启新epoch+全量hash；删除D07。父门G03需G03A/B全通过。

### MAC-04 — 一个新 schema 和可比较逻辑真值

**范围：** `src/java-index/sql/{schema,sym,rows,facts-store,driver}.ts`、身份生成/引用读写点、新 snapshot manifest schema；新增 `scripts/ilv2-mac-snapshot-equivalence.mjs`。

**步骤：** workspace stat/root 移出事实库；使用 surrogate PK + hash BLOB/原文判等，缩短重复身份和索引键；落实§2.8稳定symbolId与snapshot evidenceHandle的边界。建立不依赖自增行号/压缩字节/插入顺序的逻辑导出与 logicalDigest。旧版本只由离线 benchmark driver 调用，正式读取不带双 schema 分支。

**验收 G04：** hash 碰撞注入仍保存两个不同实体；大 hash 不经过 Number；safe integer 边界和 orphan FK 被拒绝；编码往返、Java/XML 事实、关系/coverage 逻辑导出正确；改变工作区stat/root不重写共享事实库；命名symbolId在同workspace无关编辑/行位移/full重建后保持稳定，源路径/签名改变或删除才失效；跨workspace不能误绑定。删除D08。字典压缩不列入本卡硬任务。

### MAC-05 — full/delta 显式流水线

**范围：** `src/index-builder/{cold-build,incremental,builder-main,progress}.ts`、新 build-plan/capture 输入与阶段实现；不复用 recovering 选择器。

**步骤：** 构建只读捕获输入和兼容 base；分离 parse、resolve、graph/search 与 SQL 阶段；分批提交 tmp；新增/删除/rename/导出变化触发明确依赖闭包。failed/recovered 文件记录缺口并清除其旧事实，其他文件仍可更新。阶段进度从真实处理计数产生，job 完成和 coverage 完整性分开。

**验收 G05：** 一文件变化没有全量 parse；含跨模块继承、方法签名改变、调用方新增、XML 修改/删除的 delta 与独立新 full 逻辑一致；一个坏文件与正常新增调用方可同时发布有效结果；修复坏文件后缺口消失。无依赖闭包证明时明确 full，不谎报 delta。删除 D02。至少对四仓分别证明两次 full 确定性与有变化的 full/delta 等价，不以旧v9缺陷为oracle。

**真库薄切片（G05必需）：** 在隔离lishu-v2上直接驱动新full→封存测试副本→20/200差量→只读实际查询，核对hash/coverage/logicalDigest和阶段/页写入成本；另注入parse后编辑。驱动只提供测试用有界并发/临时读取，不实现正式publisher/GC，也不宣称证明它们。若成本或闭包falsifier成立，先修MAC-04/05，不等MAC-11再返工。

### MAC-06 — owner、调度与取消（分卡验收）

**范围：** 新owner/scheduler/query pool，`src/application.ts`、`repo-ownership-lease.ts`和builder启动点；正式入口通过MAC-02B launcher。保留有用的JDT孤儿诊断，但不以裸PID清未知进程。

| 子卡 / 门 | 依赖 | 实施与目标测试（均待实现，经§5.1定向入口） | 完成判据 |
| --- | --- | --- | --- |
| MAC-06A / G06A | MAC-02B、MAC-05 | owner调度、full保留槽、workspace合并、候选dispatch重选、parser token；`dist/index-builder/build-scheduler.test.js`：`short-delta-not-starved-by-full`、`result-before-exit-keeps-slot`、`stop-settles-queued-promises` | 多root≤2 builder/full≤1，真实exit才放槽；fork失败/stop均settle |
| MAC-06B / G06B | MAC-06A | query池/有界队列、caller取消与shared build分离；`dist/java-index/snapshot/query-pool.test.js`：`hung-query-is-terminated-and-reaped`、`caller-timeout-preserves-shared-build` | 请求按时返回，专属worker≤2 s回收，未退出前不释放其lease |
| MAC-06C / G06C | MAC-06B | 调度harness并发提交多root任务，真实builder/query worker与launchd恢复；`scripts/ilv2-mac-owner-lifecycle.test.mjs`：`active-workers-daemon-restart` | 旧组/锁未释放前不开放新worker槽；随后静态槽可用、语义准入等待外部清理；正常两类旧进程同一≤10 s退出，result/exit/取消均收敛且槽位不超限。不要求或宣称正式binding/transport/GC已集成 |

父门G06为三个子门全部PASS。证据包含实际PID/PGID、锁等待/OWNER_BUSY/获取、exit/reap、调度层两类准入时间线；不新增durable PID ledger或guardian。G06B/C先验真实worker、槽位和lease token生命周期，不提前依赖SnapshotStore；真实文件lease由G07/G08接入，周期GC与正式恢复由G09集成。早期token/状态机结果不能替代G09。

### MAC-07 — 封存与原子 workspace 绑定

**范围：** 新 `src/java-index/snapshot/`、manifest 校验、immutable 读连接、lease 注册及发布协议。

**步骤：** 实现 §2.7 次序与 crash recovery，以及统一、真实执行删除的 lease-aware `tryReclaim` 原语；发布/noop 共用 binding CAS；零差量验证后绑定同一 snapshot；候选、base 和 reader 共用 lease。封存 DB 的不可变约束通过文件/目录归属和代码写入口双重保证，只有 SEALED 才用 SQLite immutable。

**验收 G07：** 每个封存/rename/binding 边界失败后只有完整旧绑定或完整新绑定；错误 root/buildKey/capture 不能确认；noop 能更新水位且不新增 DB；并发 publish 不能把旧验证套新状态；base 在 clone 前被 pause，其他发布与并发 `tryReclaim` 不能删除它；本卡直接调用真实删除原语，周期 GC sweeper 留到 MAC-09。进程崩溃测试不声称覆盖断电耐久。

### MAC-08 — 正式接入、旧路径删除与早期回归（分卡验收）

**范围：** `repo-runtime-manager.ts`、`mcp-server-factory.ts`、`application.ts`、`agent-router/java-index-router.ts`、`java-index-client-api.ts`、`sql-client.ts`、stdio/HTTP入口、受影响K/三仓drivers。

| 子卡 / 门 | 依赖 | 实施与目标测试（均待实现，经§5.1入口） | 完成判据 |
| --- | --- | --- | --- |
| MAC-08A / G08A | MAC-05、MAC-06、MAC-07 | budget→prepare→一次acquire→query worker→preview→取消/释放；`dist/java-index/snapshot/request-view.test.js`：`nonzero-deadline-bounds-all-stages`、`publish-does-not-upgrade-held-view`、`symbol-id-survives-unrelated-publish` | resolve/create/SQL/preview挂起均有界且收敛；hash/coverage/标签同view；NOT_READY/PARTIAL正确；跨请求稳定符号ID成功 |
| MAC-08B / G08B | MAC-08A | stdio只转发、status纯读、新调用图与旧runtime同提交替换；MCP合同测试`status-only-does-not-bootstrap`、`stdio-http-share-one-owner` | 删除D01/D04/D05和D09运行时部分（IDLE_WARMING、先acquire后fresh、无取消race）；保留有效业务断言；guidance文字留MAC-13 |
| MAC-08C / G08C | MAC-08B | 前移K29的新版driver及三仓runner/verifier合同适配；运行容量和三仓门 | 新query池/IPC/lease/preview被负载经过；1000文件/20并发/p95≤150ms/eventloop≤20ms；三仓质量无回退、每cell 5次且严格p95比≤1.25，无+50ms宽限 |

G08C不沿用绕过新query池的旧SQL直连benchmark冒充请求路径证明；输入/并发/样本分母相同，计时覆盖请求进入到返回。命令用§6.3，task-id取`mac-08`且run-id新建；K容量选`--cases K29`，无需JDT输入。同步修runner的selected-only退出码/汇总测试，不把其余NOT_RUN算全K PASS。

当前三仓verifier实际采用`newP95 ≤ max(oldP95 × 1.25, oldP95 + 50ms)`，`--p95-limit 1.25`本身不能证明本计划的严格比例承诺。MAC-08C对本计划新版contractVersion落实`newP95 ≤ oldP95 × 1.25`，记录实际old/new/ratio/判定策略，runner内验收与独立verifier必须共用该合同；历史报告保持原式，不重标。增加100→140 ms必须FAIL、100→125 ms通过及旧合同不能冒充新门的反例；无效/零基线标INVALID_EXPERIMENT，不静默除零或加宽限。其余三仓质量断言、采样/分母和主机政策保留；修改当前合同/runbook的适用版本说明，不能混用历史宽限解释新PASS。

父门G08为三子门全部PASS。失败先修直接回归再进入MAC-09；MAC-14在最终候选复用身份未变且仍有效的证据，source/native/runtime/driver或直接影响行为变化才重跑，不能仅凭任务号不同就强制重复。

### MAC-09 — GC 和故障恢复闭环

**范围：** SnapshotStore GC、owner recovery、`scripts/ilv2-mac-fault-matrix.mjs`、相关真实进程集成测试。

**步骤：** 基于 MAC-07 的 `tryReclaim` 实现周期 sweeper 和恢复扫描，所有删除分支复用统一 lease/inflight 检查；覆盖 retired、workspace 失效、无绑定 sealed、半成 tmp、daemon 重启和 base 候选过期。加入故障屏障与外部 SIGKILL，在 clone/SQL/checkpoint/seal/binding 中途发生，另保留确定性 faultAt 出口测试。

**验收G09：** 有效reader/worker/base/publication lease文件不消失；恢复后没有半成绑定、越域删除、进程孤儿或泄漏lease；无引用tmp/快照两个GC周期内收敛；停止/超时后pending全部settle，原有绑定可读或明确失效；旧生产缓存和历史证据不被GC触及。

**正式恢复集成（G09必需，不能由G02B/G06C代替）：** 使用已完成的新binding、stdio/HTTP transport、请求分流和GC，覆盖活动builder/query/base lease中杀owner并重启。正常路径证明两类遗留进程同一≤10 s退出、绑定恢复、静态正确查询和语义恢复；注入Gradle stop失败时，旧OWNER_PROCESS退出前不能准入，之后静态查询的snapshot/hash/coverage正确，required语义有界报告阻塞，auto明确静态缺口，无新JDT导入、无Gradle home越域GC。降级场景按故障oracle判定，不能抵扣正常完整恢复超时；清理成功后才能重新启动语义。此门通过后才能宣称产品具备§2.1完整恢复合同。

### MAC-10 — 可运行的真实任务评测基础

**范围：** `scripts/generate-commit-tasks.mjs`、`evaluate-java-task.mjs`、`eval-pilot-compare.mjs`及新转换/retrieval/paired runner；输入/结果按§0.3存本机datasets/runs目录，临时attempt只在受管隔离根。

**步骤：**

1. 把 `jin-commit-tasks/v1` 当候选输入，新增人工核验转换步骤，分别输出 agent-visible tasks、agent-visible answer contract、private gold、repair oracle、corpus manifest。commit changed files 不能直接当 required evidence。
2. 先冻结 6 个 dev task，覆盖 lishu-v2、lishuedu、exam-parent-v3，每仓至少 QA/repair 各一；QA 真值/文件范围人工核查，repair 的错误前态必失败、已知正确修复必通过。隔离验证 oracle 依赖和时间上限。
3. 实现无模型 retrieval runner；agent-visible query plan 不得使用 private gold 选查询。评估实际收到的文件/源码范围、hash、payload、首次正确证据，而非仅“read plan 列了文件”。
4. evaluator/比较器显式接收 dataset/gold/schedule/driver 身份，移除对旧 pilot IDs 和 dev.jsonl 的隐含绑定；缺 backend/dry-run 保持 UNMEASURED，不能变成无模型评测 PASS。
5. 链路跑通后扩到 40–60 个经核验任务，覆盖调用方、实现类、XML、Spring、DTO 影响与 repair。按仓库/类别分层保留 30% holdout；私有 gold 和保留集结果不向调优流程开放。

**验收 G10：** 六题全链路可执行；漏证据、错 hash、重复候选、timeout、漏 slot 评分正确；dataset/gold/schedule 不匹配拒绝比较；gold 不泄漏给执行 agent；已知失败/正确 repair oracle 判定稳定。全数据集完成身份冻结后才能进入 MAC-15。

### MAC-11 — 完整系统闭环与提前候选检查点

**范围：** 隔离 lishu-v2 run copies、MAC-01 runners、生命周期遥测；仅根据失败证据修改直接责任模块。

**步骤：** 按 §5.2 跑“主库 full → 六 worktree 并发 → 五小差量 + 一大分支 full → 持续编辑 → 杀 builder/daemon → 重启 → 正确查询”。另跑两个长 full 与短 delta 公平性。独有方法/Java/XML/hash oracle 检查所有 worktree；插入坏语法、同 stat、touch、edit-revert、事件 drop、候选 lease/GC。

**验收 G11：** 正确性、隔离、请求截止、资源/lease生命周期硬门必须 PASS，且所有性能项完成足量实测；0 跨 worktree 错证、0 混捕获 hash、0 无界请求、0 健康 build 误杀，短作业不能被 full 无限饿死。edit→first-correct-query、full/seed/排队、零/20/200 物理成本逐项记实际 PASS/FAIL。性能 FAIL 不伪装通过，但允许仅进入 MAC-12 修复对应已测热点；正确性失败必须先修本卡。输出 parse、resolve、graph、SQL/封存、排队 profile；G11 状态另附 `performanceReady`，不把“测量已完成”表述为性能已达标。

### MAC-12 — 只实现测量支持的收益项

**范围：** MAC-11 明确的热点与其定向测试；目标 schema 在 MAC-17 前一次定版。

**决策顺序：**

1. 如果少量变化仍重写大量 DB 页，先缩小受影响关系/索引更新，删除全表重戳/重建；不能只加解析并行掩盖写放大。
2. parse 占 full CPU/墙钟关键路径 ≥ 30% 才试 {1,2,4} worker；逐文件 logicalDigest 一致，选满足资源与延迟门的最小池。
3. 在真实多 worktree trace 中潜在语法复用率 ≥ 30%，且 parse 确为热点时试内容寻址语法缓存；位置无关 payload 与绑定步骤分离，损坏项明确重算，加入 schema/version/hash 与 GC 合同。
4. 只有 dbstat/profile 表明 facts 编码是主要空间项才试字典压缩；与现有 deflate 比总物理增长、解码 CPU、seed/查询 p95，不只比较 JSON 长度。

**验收 G12：** 每个采用项相对 MAC-11 同输入至少改善其目标成本 20%，逻辑/coverage 一致、查询和编辑可见 p95 不劣于 1.1 倍且仍满足绝对门；重复 ≥ 3 次。达不到则删除试验代码/配置，记 NOT_RUN 或 FAIL 决策证据，不留双实现。G12 以及最终 G14 必须满足 §6 全部适用工程性能硬门，包括 0/20/200 物理门、full/seed、公平性和编辑可见；不再保留“350 MiB 逻辑尺寸唯一通过条件”。

### MAC-13 — 工具面与 guidance

**依赖：** MAC-10、MAC-11，可与MAC-12并行；共享源码写入仍串行协调。整合门MAC-14必须同时等MAC-12和MAC-13。

**范围：** 当前 MCP schema、`java_symbol`/`java_impact` 路由与文档、repository guidance 和建议全局 diff；不得直接改全局文件。

**步骤：** 在 MAC-08 的可靠生命周期上完成必需输出合同：workspace/snapshot/content 身份、coverage、indexFreshness 和明确 NOT_READY/PARTIAL。`java_impact(symbol=...)` 用静态索引定位，有歧义返回候选，不猜重载；参数错误带合法示例。同步更新guidance，删除强制先status的文档要求；IDLE_WARMING运行时代码已由MAC-08B删除，不重复归属。用 MAC-10 dev 任务决定 read plan/批量读取的具体改善，不预先强制合并工具。

**验收 G13：** 公共 schema、调用方、文档同步；mac1之前的ID格式明确拒绝；同workspace未变命名符号的mac1 ID跨无关发布仍可调用，证据handle版本另验；歧义/缺口/超时语义可测；无模型 recall 不下降超过 2pp，实际 evidence coverage 不退化，全部 6 个 pilot 的 retrieval/evidence smoke 通过；repair judge 另验 known-bad 拒绝、known-good 通过，不要求未修复 tree 被判成功。guidance 使用执行agent可见输入并与工具能力一致。关闭D09的guidance/文档部分，交付`guidance.diff`，全局应用待授权。

### MAC-14 — 整合门和 K 合同换代

**范围：** `scripts/run-release-contracts.mjs`、`scripts/release-mcp-contracts.test.mjs`、`scripts/release-jdt-contracts.mjs`、`scripts/run-isolated-jdt-benchmark.mjs`及其定向测试、`src/benchmark/release-index-contracts.test.ts`、`docs/java-specialist-release-audit-v1.1/contracts/runtime-matrix.json`及当前合同说明、三仓runner/verifier与runbook。

**步骤：** 按 §6.2 更新 K 搭建与 oracle；全部 K01–K32 列表保留。改造现有 `scripts/release-jdt-contracts.mjs` 和 `run-isolated-jdt-benchmark.mjs`，使真实 JDT 测试经唯一 owner/新 transport 运行；在隔离 fixture 上生成同一候选的 `real-jdt-evidence.json`，临时根清理前导出到本任务 RAW，并以 `--jdt-evidence` 交给 K runner。native/source/fixture 身份必须一致，不接受旧 JDT 产物。历史结果保持原样；当前矩阵标新 contractVersion、source/native/driver digest。对同一整合候选执行一次 full、PR、K、真实负载和三仓门，复用有效证据；任何修改使直接受影响证据失效。

**验收 G14：** 完整合同结果表无隐含跳过，K26/K28 缺真实 JDT 则 G14 为 BLOCKED_ENV，并阻断 G17/部署；不能写“全 K PASS”或把必需 K 静默降级；正式三仓质量无回退、p95 比 ≤ 1.25；新真实多 worktree 门独立 PASS；旧路径删除清单为零生产调用者。对明确新增行为用新 oracle，不要求新输出逐字兼容旧 JSON。

### MAC-15 — 模型收益与保留集

**范围：** 评测 runner、冻结数据和隔离 attempts；真实付费运行需预算授权。

**步骤：** 冻结 task×arm×repeat（每题每臂 ≥ 3）、模型、prompt/guidance、工具预算、顺序、cache 条件和 scorer。主对照为 `baselineProduct`（原生工具 + MAC-00冻结旧MCP）与 `candidateProduct`（相同原生工具 + 新MCP），分别使用冻结 driver；native-only 可作辅助臂，单独回答增加MCP的收益。主对照的模型、任务预算和输入相同，schema适配/公开guidance差异单独登记。旧版运行失败保留为失败，不剔除困难样本。先 dev 调优；最终 holdout 等 MAC-16 PASS/有依据 NOT_RUN、MAC-14 受影响重验及最终 source/native/driver/guidance/oracle/预算冻结后才打开结果。

**验收 G15：** 全部 scheduled slot 纳入分母，失败/超时/缺结果保留；按 task 聚类成对报告成功率、first-correct-evidence、token、墙钟、区间与仓库/类别分层。采用门针对 candidateProduct 相对 baselineProduct：成功率不降且输入 token 减少 ≥ 20%，或成功率提高 ≥ 10pp；retrieval recall 下降 > 2pp 则 FAIL。小样本/区间跨零如实写结论限制，不能把同题三次当三题。“±1 题”不再使用。holdout 一次正式决策；之后任何影响行为的修改都使该收益结论过期，重新调优/验收须新 holdout，原集可明确转 dev，禁止同集反复补测。无授权输出 BLOCKED_AUTH，不伪造收益。

### MAC-16 — 语义精度条件任务

**范围：** JDT session manager、静态解析失败案例、隔离语义 oracle；无证据不改精度架构。

**步骤：** 先检查 MAC-10/13/14 的实际失败；MAC-15 若已运行也纳入。没有影响任务成功的语义缺口则 NOT_RUN 并交付依据。需要实验时保持每 workspace/environment 专用 session，按全局配额排队与 idle 回收。可试编译器离线关系提取，但其 key 必含完整编译环境，先与现有专用 JDT 比较成本与收益。

**验收 G16：** 两个并发 worktree 同 URI 不同内容、相同构建配置、交错请求时 0 串扰；不允许 98% 一致率豁免隔离错误。分层至少 200 个符号按专用 JDT 真值评估，语义关系一致率 ≥ 98% 仅作为精度门，另报错误类别与运行成本；实际失败任务改善才采用。实验失败删除新路径；有效原有语义能力不随条件任务跳过而删除。

### MAC-17 — 最终构建、canary 与可审查安装包

**范围：** `install-runtime.sh`、`scripts/runtime-artifacts.test.mjs`、README、HANDOFF、[生产操作文档](../phase-f/production-operations.md)、隔离 canary。

**步骤：** 安装工件包含并校验native binary/权限/版本；移除旧stdio runtime迁移和双schema启动合同。生成release digest、唯一缓存/独立serviceStateRoot布局、§2.1完整launchd配置（RunAtLoad、KeepAlive/非零OWNER_BUSY、ThrottleInterval、AbandonProcessGroup、5 s锁等待）及停止/回退步骤，按生成plist读回核验。canary用`:38457`独立cache和service-state，通过start启动后attach回放≥2 h、≥1000正常请求，含full/seed/编辑/重启/lease/GC；真实JDT专项另测，其余可禁用JDT。

**验收G17：** 本卡修改构建输入后先补受影响G14门；运行实例build/source/native身份与候选匹配，§6正常窗口SLO达标，输出回滚演练和安装清单。部署请求精确到SHA/digest、生产路径、唯一owner、旧缓存和service-state保留/恢复方式；披露空私有Gradle home下首次发行版/依赖下载、首次语义可用耗时和新增磁盘实测，未测明确标注，静态与语义可用时间分开。只迁入核实必需且获授权的构建配置，不整份复制用户Gradle home或凭据；不能由“当前未见配置”推定生产永久无需配置。工程候选可READY_FOR_DEPLOY，尚非DEPLOYED或AGENT_IMPROVED。

### MAC-18 — 具体候选的生产切换

**依赖：** 默认MAC-17 PASS，或§3.1提前候选完成其必需前置门；两者均需用户对具体候选安装的明确授权。无授权停在准备好的包。

**步骤：** 安装前复查目标身份；停止旧服务，安装同一工件、切换唯一launcher/daemon 和新 cache namespace，验证状态、一个真实静态查询、一次指定仓库增量和 stdio/HTTP 路径指向同一 owner。是否启动真实 JDT 按批准范围执行。记录每步结果和旧工件位置。

**验收 G18：** 读回生产 instance/build/native digest 与候选一致，进程槽位/缓存根/工具结果符合合同；失败立即按已批准回退方案停止新服务，旧版本只有在已证明可用且获准时才恢复。旧格式数据不迁移也不自动删除；不把回退到已知活锁 release 当成功恢复。

### MAC-19 — 观察和收尾

**步骤：** 对 MAC-18 实际部署观察 24 h（或用户明确指定窗口），记录正常使用与未覆盖的低流量时段；运行 on-demand SLO 汇总，不自动创建日报/定时任务。核对进程、lease、快照物理增长、失败与用户真实工作区的 first-correct evidence。更新 README/HANDOFF/操作文档和任务状态，清理本次到期隔离产物。

**验收 G19：** 工程结果、agent 结果、生产读回分别列状态；部署成功但 A/B 未跑须明确写未验证 agent 收益。无未披露失败/孤儿/无主配置；旧生产缓存只有单独删除授权才处理。只有最终候选实际部署/观察完成且全部必需任务关闭才能把本手册改为LANDED；提前候选观察不结束整个计划；授权未给时整个计划停在 READY_FOR_DEPLOY，不把未部署的任务标 PASS。

## 4. 旧路径删除账本

删除必须跟随替代路径接入，不能留到最后再靠开关禁用。表中名字是重写时的源码锚点，实施时必须用调用图/搜索确认全部创建点。旧测试中的有效业务断言迁移到新入口；禁止为通过删除覆盖。

| ID | 对象类型、删除对象和实际调用范围 | 替代/删除任务 | 验收 |
| --- | --- | --- | --- |
| D01 | `findSiblingDb`、`scanFamilySiblingIndex`、mtime 最新 sibling、`siblingDbPath`、`copySibling/retargetCopiedDb/copiedSchemaMatches`、`src/java-index/sql/vacuum-into.ts` | MAC-07 提供 sealed 候选；MAC-08 删除旧入口 | 正式源码无 mutable sibling/VACUUM seed；候选均有 manifest 与 lease |
| D02 | `incremental.ts` 的 `recovering`、以 tmp buildState 选择全量/恢复、巨型全图事务 | MAC-05 | 显式计划；单文件 delta parse 集合等于计划；未出现自动恢复路径 |
| D03 | `cold-build.ts`/`incremental.ts` parse 后 `readFile` 生成 search 文本、旧 hash 标新内容 | MAC-03、MAC-05 | 注入编辑仍同字节派生，live preview hash 不符有缺口 |
| D04 | `familyGates/startFamilyCreate`、每 repo `BuilderSupervisor`、builder 常驻 serve；创建点含 manager、`agent-router/java-index-router.ts`、`sql-client.ts` | MAC-06 建替代，MAC-08 切换即删 | 生产调用图仅一个 scheduler；两个客户端不能绕 owner 创建 builder |
| D05 | 独立 stdio runtime/owner、旧 per-root ownership 允许跨 root 多 owner、旧安装迁移握手；检查 `extract-stdio-project-jdk-env.mjs`、`verify-stdio-ownership-handoff.mjs` 及调用者 | MAC-08、MAC-17 | stdio 只转发；旧迁移脚本无调用则删除；保留必要 JDK 选择与 JDT 孤儿清理，不整文件盲删 |
| D06 | **计划层**：旧手册的`cp -c`/COPYFILE_FICLONE保证与复制fallback；当前src/scripts未发现对应克隆实现 | 本手册、MAC-02A | 旧方案被替换；新原语明确成功/失败；不虚构源码删除diff |
| D07 | `fs.watch` 作为正式 tracker、仅 size+mtime 的跳过、持久游标直接恢复 FRESH | MAC-03 | 原生 flags + 确认水位；startup/drop/root/resume/同 stat 用例通过 |
| D08 | 旧 schema 读取/迁移、事实库 root/stat 重戳、int64 hash number PK、旧 ID 兼容拼接 | MAC-04 | 一个新格式；stat 不改事实 DB；无 unsafe Number hash |
| D09 | **代码+文档**：IDLE_WARMING、先acquire后fresh、无取消race，以及强制先status的guidance | MAC-08B删运行时；MAC-13删guidance要求 | 分别给源码删除与文档更新证据；不重复认领同一改动 |
| D10 | 上述删除后无读取者的 env/config（逐项盘点，如 `JAVA_LSP_BUILDER_IDLE_MS`）、重复缓存根别名/旧 installer 分支 | MAC-08、MAC-14、MAC-17 | 当前 canonical 配置、runtime、test/env filter、安装器与文档一致；不保留空壳兼容选项 |
| D11 | **计划层**：旧P3 family共享JDT同URI overlay；未把它声称成已有实现 | 本手册、MAC-16 | 计划撤销；真实专用session零串扰，若后来发现实现另登记实际调用点 |
| D12 | **计划层+独立代码子项**：旧P0→v9→v10强制顺序/旧阶段任务为计划撤销；比较器旧pilot隐含输入是已存在代码 | 本手册；代码子项MAC-10 | 计划不再强制双格式部署；比较器另提供真实diff；提前新版本按§3.1选择 |

MAC-14输出`removed-paths.json`，区分`CODE`与`PLAN`：代码项记录真实定义/调用者/测试迁移/rg与构建结果；计划项记录旧commit章节、新合同和无对应当前实现的核查，不要求不存在的源码删除diff。D12拆开记录其代码子项。源码、脚本中出现历史名称必须逐个解释为离线 baseline driver/历史 fixture/明确的负向断言；不能只用“文件仍在但不会调用”交差。历史文档提及旧名不要求删除。

## 5. 验证工具与输入规格

### 5.1 当前可用命令与新增 CLI 的边界

MAC-02A已将native builder和runtime manifest校验接入普通构建、隔离/当前三仓候选、v4及K入口，并让安装预检使用同一冻结Node。shell入口显式使用绝对Node并清宿主加载/输出环境及测试IPC上下文。正式证据记录实际`process.execPath`、binary digest和完整`process.versions`；缺manifest或运行时不匹配均阻断门。完整产品门和生产安装仍需其后续任务验收。

`ILV2_NODE_BIN`是执行命令的任务变量，`runtime.json`中的可执行身份才是真源。shell broker校验该路径和`ILV2_RUNTIME_MANIFEST`，保留原六项环境清理并移除`NODE_TEST_CONTEXT`，不回退PATH。JS binder在任何嵌套分支返回前将字面`node`重绑定为当前绝对`process.execPath`；quoted test glob在编译候选中展开。安装器使用同一manifest及冻结Node安装中的npm-cli，不重新查PATH；`--preflight-runtime`只读返回身份。实际另一Node的PATH漂移证据已保留；普通测试自建私有execPath fixture，不另加必须安装备用版本的前提。

以下为完整子shell模板，在源码checkout执行，替换freeze/task/run ID及测试路径。也可保存为任务脚本后用`/bin/sh`执行，禁止source到持久shell。每次新建并登记运行根；环境在子shell退出后恢复。MAC-00尚无manifest时直接固定并记录runtime；后续指向持久冻结文件。`TMPDIR`必须在broker启动前设置，子进程的`--env TMPDIR=...`不能约束broker自身mkdtemp。

```sh
(
  set -eu
  export ILV2_WORK_ROOT="/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/ilv2-mac"
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

分位数固定 nearest-rank：排序后第 `ceil(p × n)` 个；p50/p95/p99 同时报 n、max 和原始样本。失败/未完成 slot 不伪造零耗时；门判断同时检查完成率，缺一个必需样本即不满足门。模型重复按任务聚类；工程重复报告独立 run 和条件，不人为增加样本独立性。

### 5.4 APFS/SQLite 物理成本

对相同冻结 lishu-v2 内容分别测零差量、20 文件、200 文件，再测实际大分支。每次独立目录、至少3轮，分开记录 clone、capture、parse、resolve、SQL、checkpoint/seal、publish 的时间/CPU/逻辑字节/物理增长。

clonefile 返回成功证明请求了原生克隆；`ls -l` 不能证明共享 extent，`du` 也不能简单按多个 clone 求和得到真实新增占用。记录卷可用空间差、Time Machine/APFS snapshot 干扰、`stat`/`du`、页数/freelist/dbstat 与作业写入量。物理增量用隔离运行前后卷分配变化并做空跑校正；误差大于目标差异时该项 INVALID_EXPERIMENT，重选受控条件，不宣称节省。

零差量直接绑定，新增事实 DB 数和 DB 写入字节必须为 0。20/200 变化的净物理增长分别以同输入 fresh full 的净增长为分母；通过门见 §6。checkpoint/同步成本计入总时延，不能只报 clone 毫秒数。

## 6. 验收门与停止条件

### 6.1 工程与收益指标

以下是待验证的目标，不是已观测结果。10%/30%与5 s/15 s为默认目标；维持或收紧无需额外确认，任何放宽按MAC-00第5步取得用户明确批准并记录批准人/时间/授权引用。表与实施前冻结的thresholds.json同步；缺批准仍用默认值，不能候选失败后改门。MAC-00将具体plan冻结；没有样本时记 NOT_RUN，不能写 0 次失败。

| 维度 | 通过标准 | 主要责任 |
| --- | --- | --- |
| 内容/隔离 | 0 跨 worktree 证据；0 旧 hash 标新文本；full/delta logicalDigest 一致；坏文件不阻断正常更新，相关否定保留 PARTIAL | G03、G05、G08、G11 |
| 请求截止 | 每个调用 elapsed ≤ deadline+1000 ms；正常窗口 watchdog 硬截止 0 次；fault 窗口按预期返回且资源收敛 | G06、G08、G11 |
| status | start=false 无副作用；每工具/workspace 状态分层及总体 status p99 ≤200 ms，≥100 个样本 | G08、G11、G17 |
| owner/资源 | 同域builder≤2、full≤1、parser≤冻结数、query≤2；取消≤2 s；完整恢复仍要求两类旧进程同一≤10 s窗口退出；Gradle故障时静态降级可用另验，不能抵扣完整恢复FAIL；性能窗口零遗留进程 | G02、G06、G09、G11 |
| full | 三次真实 lishu-v2 full，0 健康 stall kill；中位墙钟 ≤0.8×B_full；基线无有效值时绝对门≤600 s，并明确未证明相对提速 | G11、G12 |
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

当前 K 定义仍从 [runtime contract matrix](../java-specialist-release-audit-v1.1/docs/09-runtime-contract-matrix.md) 追踪，MAC-08C前移K29驱动，MAC-14完成当前定义和runner的契约版本更新；已有历史报告不覆盖。未列出的 K 仍逐项执行原业务断言，只适配新入口，不能隐式取消。

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
  export ILV2_WORK_ROOT="/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/ilv2-mac"
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
  export ILV2_WORK_ROOT="/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/ilv2-mac"
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

## 7. F01–F12 追踪表

每项 review 问题都有实现责任、删除项和直接验收；关闭 finding 要引用这些门的实际产物，不能只引用本手册。

| Finding | 最终要求 | 任务 / 删除 | 直接证明 |
| --- | --- | --- | --- |
| F01 | job/coverage分离，显式FullPlan/DeltaPlan，无recovering | MAC-04、MAC-05；D02 | G05一文件parse集合/full-delta逻辑等价 |
| F02 | 结构完整的降级快照可发布，旧坏事实不得保留，否定按依赖coverage | MAC-05、MAC-08；D02 | G05/G08坏文件与正常更新并存，K24 |
| F03 | 同字节派生，preview校验捕获hash | MAC-03、MAC-05、MAC-08；D03 | G03 parse后编辑注入，K20 |
| F04 | prepare在acquire前，held-view标签，noop确认明确水位 | MAC-03、MAC-07、MAC-08；D09 | G03 touch/edit-revert/启动noop；G08跨发布 |
| F05 | 原生信号+内容真源+确认协议，不凭stat/游标证明新鲜 | MAC-02、MAC-03；D07 | G03同stat/drop/root/resume/扫描中第二事件 |
| F06 | 全链budget+取消+隔离worker+真实释放 | MAC-06、MAC-08、MAC-09；D09 | G06/G08非零deadline挂起与资源收敛，K12 |
| F07 | 唯一owner、全域槽、统一base/reader lease、孤儿回收 | MAC-02、MAC-06、MAC-07、MAC-09；D04、D05 | G02/G06进程与调度原语；G09正式恢复、语义降级、候选GC |
| F08 | 安全surrogate PK，BLOB hash判等，逻辑导出 | MAC-04、MAC-12；D08 | G04碰撞与safe integer；G12物理/CPU |
| F09 | clonefile硬失败，事实/stat分离，同内容直接绑定 | MAC-02、MAC-04、MAC-07、MAC-11；D01、D06、D08 | G02原语；G11零/20/200成本和目标root |
| F10 | start/attach分开，status纯读，真正first-correct，修正心跳断言 | MAC-01、MAC-08、MAC-11、MAC-14 | G01实例/分母；G11可见延迟；K12/K29 |
| F11 | task格式转换、私有gold、无模型runner、成对比较与holdout | MAC-10、MAC-13、MAC-15；D12 | G10六题链路；G15全slot/身份/聚类 |
| F12 | 不共享同URI worktree语义状态，精度与隔离分别验收 | MAC-16；D11 | G16双worktree交错0串扰，真实JDT |

## 8. 历史任务替代与证据保留

| 原手册路径 | 新处理 |
| --- | --- |
| P0-T0 | 已完成历史输入保留；MAC-00只复核现状/输入，不重新声明或改写原PASS |
| P0-T1 | 历史机制诊断收进MAC-00；未复现不阻塞其他已独立确认的问题 |
| P0-T2/T3a/T6/T7/T8 | 由MAC-01/05/06/08实现目标系统所需能力；不先补旧生产系统 |
| P0-T3b/T4/T5及旧P0生产门 | SUPERSEDED：U4已决定不部署，目标实现直接删除旧恢复/ownership路径 |
| P1-T1–T9 / P1A | 合并到MAC-02–09、MAC-11；状态/水位/原语/GC合同以本版为准 |
| P1B | schema前置MAC-04，profile优化MAC-12；取消int64 hash主键、强制字典压缩、旧输出逐字兼容及单独部署 |
| P2 | 数据与runner前置MAC-10；工具MAC-13；模型/holdout MAC-15，不以先生产运行3天为前提 |
| P3 | MAC-16条件实验；family JDT overlay方案删除 |
| P4 | 删除跟随接入；最终清单MAC-14/17/19；不额外立benchmark迁仓或自动日报项目 |

旧手册全文可从重写前 commit `9b3a110` 的同路径取回；历史 P0 证据保留在 `docs/index-lifecycle-v2/p0/`。此前清理详情继续以 [临时证据提炼记录](../evidence-archive/tmp-distill-2026-10-13/README.md) 和 [仓库内证据提炼记录](../evidence-archive/inrepo-distill-2026-10-13/README.md) 为准。本版不重新执行旧清理，不删除历史证明材料。

## 9. 来源与证据边界

源码依据和具体行号见 [深度 review](codex-java-lsp-mcp-index-lifecycle-v2-macos-review-2026-10-13.md)。以下真源支持平台合同，具体 helper 仍需 MAC-02 实测：

- Apple `cp -c` 允许克隆失败后复制，因此不能把退出0当 clone 成功证明：[Apple cp 手册](https://raw.githubusercontent.com/apple-oss-distributions/file_cmds/main/cp/cp.1)。
- FSEvents 的递归扫描、掉事件、root变化及建立观察/扫描顺序：[Apple FSEvents 指南](https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html)。
- immutable 连接跳过锁与变化检测，前提是文件真的不可变：[SQLite URI](https://www.sqlite.org/uri.html)。
- 本机Node版本的Darwin fsync会先尝试F_FULLFSYNC；封存成本须计入同步，不能据此宣称断电已验证：[Node 22.16 libuv 源码](https://raw.githubusercontent.com/nodejs/node/v22.16.0/deps/uv/src/unix/fs.c)。
- launchd的KeepAlive、默认ThrottleInterval=10及AbandonProcessGroup，以及flock共享锁语义：[Apple launchd.plist](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5)、[Apple flock(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)。本机man已核对；新plist和5 s锁等待仍待真实launchd时间线证明，不能从配置推出10 s必达。
- 本机临时清理依据：`/usr/share/man/man8/tmp_cleaner.8`、`/usr/libexec/tmp_cleaner`、`/System/Library/LaunchDaemons/com.apple.tmp_cleaner.plist`，读取于2026-10-13。man记载始于macOS 14；本次未执行清理器、未等待实际过期删除，也未靠atime探针推定保留安全期。
- Node Darwin spawn关闭未显式传递的fd，整数stdio可以映射父fd：[Node 22.16 libuv process.c](https://raw.githubusercontent.com/nodejs/node/v22.16.0/deps/uv/src/unix/process.c)、[Node 22.16 child_process stdio](https://nodejs.org/download/release/v22.16.0/docs/api/child_process.html#optionsstdio)。因此不接受“全树自动继承flock”的无测试假设。
- Gradle 9.3.1的detach调用链：[DaemonMain](https://raw.githubusercontent.com/gradle/gradle/v9.3.1/platforms/core-runtime/daemon-server/src/main/java/org/gradle/launcher/daemon/bootstrap/DaemonMain.java)、[NativePlatformBackedProcessEnvironment](https://raw.githubusercontent.com/gradle/gradle/v9.3.1/platforms/core-runtime/native/src/main/java/org/gradle/internal/nativeintegration/processenvironment/NativePlatformBackedProcessEnvironment.java)。这支持不能假设同PGID，不代替实际进程观测。
- Tooling API的daemon与按版本停止行为：[Gradle daemon文档](https://docs.gradle.org/current/userguide/gradle_daemon.html)；JDT的`java.import.gradle.user.home`：[JDT Preferences源码](https://raw.githubusercontent.com/eclipse-jdtls/eclipse.jdt.ls/main/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/preferences/Preferences.java)。这两项是设计期线索；MAC-02B冻结实际JDT/TAPI/Gradle工件时，必须将执行证据中的链接固定到对应tag/commit和文件digest，不把main/current当版本验收证据。配置生效和10 s完整恢复仍须实测。
- didOpen文档状态必须有清晰的URI归属，不能替代多工作区隔离：[LSP文档同步规范](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_didOpen)。

平台资料与源码阅读只支持设计依据；MAC任务/G门的完成状态以实际执行记录为准。历次文档修订、核实方法和未验证范围见[review修订记录](codex-java-lsp-mcp-index-lifecycle-v2-macos-review-2026-10-13.md#8-手册修订核实记录)。

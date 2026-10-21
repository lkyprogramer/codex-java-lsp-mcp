# ILV2-MAC 执行规则（§0–§1）

[索引](../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · 门状态见 [`status.json`](../../index-lifecycle-v2/mac/status.json)

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
6. 不删除历史归档及其引用：`docs/evidence-archive/`、`/Users/luo/Documents/evidence-archive/codex-java-lsp-mcp/`。MAC/5之前的工作根`…/evidence-archive/codex-java-lsp-mcp/ilv2-mac/`属于后者，只读保留，新运行不再写入。
7. 继续禁止 `--activate-http` 和 `JAVA_LSP_ENGINE`。保留 [HANDOFF](../../../HANDOFF.md) 与 [操作文档](../../phase-f/production-operations.md) 的“不得新增第四个 live daemon”限制，不据此把现有实例数当作已核验事实；常驻测试只用已授权 `:38457` canary，不增设第二个常驻canary。单次fixture daemon使用独立临时HOME/cache/owner/projects及随机未占用端口，默认禁用JDT（真实JDT专项除外），登记PID/PGID/端口并在运行结束回收；这类有界测试进程不计入常驻实例，不得接生产根。同机所有测试runner合计最多2个fixture daemon，受管配额同时约束并行测试；达到上限排队，不把每个runner的2个相加。
8. 正式三仓矩阵遵守 [主机政策](../../phase-v4/three-repo-host-load-policy.md)：load < 20 应跑，load ≥ 20 仍跑并记录；唯一主机硬门是可用内存 ≥ 4 GiB。真实 ENOSPC 等执行失败如实报告。文档改写和小范围单测不触发矩阵。该政策只适用于候选与基线交错运行、按比值判定的三仓矩阵；full墙钟、seed首次正确查询、noop等绝对时间门的计时窗口起止均须load1 < 20（CPU数仅作记录，见[验证§5.5](verification.md#55-mac-05-fulldelta-runner)），否则该计时记`INVALID_EXPERIMENT`，不能记PASS或FAIL。此上限于2026-10-21按用户要求调整，历史运行保留原口径和结论。
9. 不修改TCC数据库，不代用户授予或撤销隐私权限。探针或测试引出TCC对话框时按拒绝处理并记`BLOCKED_ENV_TCC`；是否授权由用户另行决定（生产launcher的开放决定见§2.1）。

### 0.2 每项任务的完成合同

每张任务卡的依赖、输出和验收都是必需项。新增脚本和字段在对应任务完成前一律视为**目标接口**，不得伪称已经存在或可执行。

- 实现前读取列出的源码及直接调用者。实际缺陷写能表达错误行为的 RED 测试；编译失败、脚本不存在不算缺陷复现。
- 新架构按合同测试实施，不要求先在旧架构伪造全部 RED。历史活锁未复现，不阻塞已经由独立测试确认的其他缺陷修复。
- 实现后运行最窄定向测试及必要编译；G08前移查询容量和三仓回归，G14负责最终整合候选的全量、完整K合同与真实负载。新修改只重跑受影响证据，禁止同一 SHA 多角色重复完整矩阵。
- 评审与实现分离。并发/持久化/native/公共工具合同必须独立只读评审；评审固定 commit 或 tree/source digest。正式架构和门禁结论不使用 fast 档。
- 每项输出 `task-result.json`，由 `scripts/ilv2-mac-task-result.mjs compose` 生成：输入为broker在运行根自动追加的`validation-index.jsonl`（argv、退出码、耗时、TAP计数、源码/native/runtime身份）、`closeout/closeout.json`、独立评审记录和一份人工`verdict.json`（taskId与gateId、状态、main/expectedRed/independentRerun的运行名、补充证据文件、未覆盖项、授权引用、下一步）。生成器同时写回`status.json`。PASS缺少记录支持时拒绝生成，包括以下情形：
  - main运行没有实际执行测试，或有失败、取消的测试；main运行之间身份不一。
  - expected-RED不是测试失败（编译或broker失败不算）。
  - 需要独立复验的门缺少复验。
  - 收尾未PASS或归档未物理校验；收尾id与verdict不符；收尾后validation-index又被追加；raw/、tmp/仍存在。
  - 评审有未关闭发现，或评审的source与候选不符。

  不手抄hash和计数；空缺写`N/A`。
- **任务/门状态**：`PLAN`、`IN_PROGRESS`、`PASS`、`FAIL`、`BLOCKED_ENV`、`BLOCKED_AUTH`、`NOT_RUN`、`NOT_REPRODUCED`、`INVALID_EXPERIMENT`。条件任务NOT_RUN要有依据；未启动的MAC主卡/子卡为PLAN。
- **文档/计划状态**：`PLAN_READY`、`IN_PROGRESS`、`LANDED`；**候选状态**：`NOT_READY`、`READY_FOR_DEPLOY`、`DEPLOYED`；**收益结论**：`UNMEASURED`、`IMPROVED`、`NOT_IMPROVED`。`SUPERSEDED`仅标历史任务被替代，`UNMEASURED_BASELINE`仅标测量前提，不混入任务PASS/FAIL。
- 每次本地commit前，扫描**暂存的实际blob**与新增文件类型/体积：业务包名、Mapper namespace、业务源码片段和密钥特征的未解决命中必须为0。扫描器只输出文件路径/计数，不回显匹配正文；文档里的规则文字或脱敏占位符需逐项解释后排除，不宽泛排除整个docs。二进制/压缩RAW、源码树与未审明的任务正文直接拒绝入库。MAC-01补可重复的扫描入口；MAC-00证据先留§0.3持久工作根，待MAC-01扫描器可用并通过扫描、人工diff检查后再纳入本地提交，不能先提交后补扫。
- MAC-02/06/08按各自卡片文件中的子卡实施和验收；MAC-03拆开纯TS捕获与原生tracker集成。开工时把真实文件、定向测试名/命令和数据清单填进执行记录。只对未决并发/持久化合同做独立评审，不新增“每张小卡先审批展开计划”的统一阻塞步骤。
- 门失败不得降低阈值、删样本、扩大 mock 或延长已经冻结的时限。连续两次同因失败且没有新证据时，停止该路径，记录根因与下一项最小验证；不连补猜测补丁。

执行顺序固定为：列齐本卡合同与缺口 → 运行环境探针`scripts/ilv2-mac-env-probe.mjs`（§5.1），未到READY不展开故障矩阵 → Tier-0开发循环迭代 → 一次Tier-1构建并冻结候选 → 主测 → 同一候选的独立只读评审（G09/G11/G14/G17另加独立复验）→ 一次收尾 → 生成结果并提交。评审可与主测并行；对同一范围只安排一次独立评审，发现修复后只复核受影响项。Tier-0运行不是证据：不计次、不进task-result，失败也不留档；只有最终Tier-1候选上的运行计入。

一个物理场景可以证明多项合同，证据中逐项列出断言，不重复计作多个测试；刚启动与稳定运行的故障窗口仍分开。独立复验（不同执行者在另一次构建上实际重跑关键退出/锁/协议边界，不复制整个主测矩阵）只是G09、G11、G14、G17的必需项；其他门由独立只读评审核对关键原始断言、归档hash与实际残留，不另起构建。只有源码、运行时、工具链、依赖或编译产物漂移才重建；文档和汇总变更不使候选失效。原始失败保留，命令退出0只代表所选检查通过，不能自动宣告G门PASS。

`run-isolated-validation.mjs`自动生成各命令的双流、实际close后的退出码、时间、argv、环境白名单与hash，并在已登记运行根追加`validation-index.jsonl`（LOCAL，收尾后仍保留）。`task-result.json`是每门的唯一结果记录，`status.json`是门状态的唯一汇总；父门状态由子门推导，不单独存储。README/手册只引用二者，不复制命令日志、源码清单或状态。每轮记录构建与验证命令耗时；排障、证据处理及等待只按实际时间记录，未计时写N/A。

### 0.3 产物、公开边界与清理

新小型证据放 `docs/index-lifecycle-v2/mac/`：单文件≤1 MiB、总计≤20 MiB，只收聚合数值、不含业务含义的ID、hash和脱敏结论。`agent-visible tasks/answer contract/query plan`仅表示执行agent可读，与`private gold/oracle`一样不允许提交公开仓库；仓库不存任务正文、业务路径/符号清单、模型请求响应或压缩原始记录。

持久工作根 `ILV2_WORK_ROOT=/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/` 保存本计划输入和证据：`inputs/frozen-java-repos/<repo>/` 为经完整性核验的冻结副本；`plans/mac-00/<freeze-id>/` 保存runtime.json、thresholds.json和冻结manifest；`datasets/<dataset-id>/` 放任务、答案合同、私有gold/oracle；`runs/<task-id>/<run-id>/` 为受管运行根；`archives/<task-id>/<run-id>/` 保存通过核验的RAW归档。执行agent只获得agent-visible部分，gold由独立scorer读取。文件写权限不足时，只阻塞依赖持久产物的步骤并记BLOCKED_AUTH；不能改放公开仓库，也不能以/tmp作为跨门保留的替代。

**工作根、运行根、TMPDIR和fixture根不得位于TCC保护目录**（`~/Desktop`、`~/Documents`、`~/Downloads`、`~/Library/Mobile Documents`、`~/Library/CloudStorage`，大小写不敏感）：launchd job加载或读取其中的文件会在main之前等待TCC决定，G02B有两次运行因此超时。`createRegisteredBrokerRoot`和launchd fixture配额遇到这类路径直接报`BLOCKED_ENV_TCC_PATH`。MAC/5迁移用APFS clone把四个冻结仓复制到新根，输入manifest只改`repoRoot`，文件清单逐字节不变；现行输入清单为`plans/relocation/20261014T133452Z/inputs.json`，四仓均重新通过完整核验。`plans/mac-00/20261013T144536Z/`是原样副本，runtime.json的hash不变，其中inputs.json只作历史。MAC-02B的JDT/TAPI/JDK/Gradle清单已持久化为INPUT `inputs/toolchains/jdt-1.56.0-gradle-9.3.1-jdk-25.0.2/toolchains.json`，由`ILV2_TOOLCHAINS`传入；它引用Homebrew Cellar路径，brew升级会使其漂移，环境探针报`BLOCKED_ENV_TOOLCHAIN_DRIFT`。

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

收尾清单由`ilv2-mac-task-result.mjs manifest --run-root <root> --gate <G门或WF-流程id>`从运行根生成：`raw/`为RAW、`tmp/`为BULK，均到期于本次收尾；`closeout/`为递归LOCAL；其余顶层文件为LOCAL。未知顶层目录直接拒绝，需移入raw/tmp或用`--extra`显式登记（如carry-over INPUT）。PID/PGID/launchd label取自raw下的JSON/JSONL与plist、broker根和validation-index；只有组长PID本身被记录时才登记owned group。统一收尾入口为`ilv2-mac-closeout.mjs --finish <closeout-manifest.json>`。清单明确登记`runRoot`、`gateId`、`artifacts`、`processes`（PID及确实拥有的PGID）、`launchdJobs`和递归LOCAL的`closeoutDirectory`；使用fixture配额时附`workRoot`。入口只读证明本次资源实际退出及配额释放，再对到期RAW归档并物理校验一次，删除到期目录，生成`closeout.json`。原始错误由runner双流保存，收尾错误单独报告；收尾PASS不代表产品G门PASS。需要独立复验的门（§0.2）由独立执行者用`--manifest`核验实际残留，并独立调用资源退出核验，不重建、不重复归档。跨门候选必须登记consumer/到期门。

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

P0-T0冻结记录见[frozen-repos.json](../../index-lifecycle-v2/p0/frozen-repos.json)。以下身份只描述冻结时输入，历史清单不改写。MAC-00将可核验输入复制或从指定commit重建到§0.3持久根，生成新的实际路径/内容manifest；目录存在或HEAD相同不能证明文件仍完整。

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

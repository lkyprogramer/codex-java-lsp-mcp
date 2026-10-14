# ILV2-MAC 删除账本、追踪与来源（§4、§7–§9）

[索引](../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · 门状态见 [`status.json`](../../index-lifecycle-v2/mac/status.json)

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

旧手册全文可从重写前 commit `9b3a110` 的同路径取回；历史 P0 证据保留在 `docs/index-lifecycle-v2/p0/`。此前清理详情继续以 [临时证据提炼记录](../../evidence-archive/tmp-distill-2026-10-13/README.md) 和 [仓库内证据提炼记录](../../evidence-archive/inrepo-distill-2026-10-13/README.md) 为准。本版不重新执行旧清理，不删除历史证明材料。

## 9. 来源与证据边界

源码依据和具体行号见 [深度 review](../codex-java-lsp-mcp-index-lifecycle-v2-macos-review-2026-10-13.md)。以下真源支持平台合同，具体 helper 仍需 MAC-02 实测：

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

平台资料与源码阅读只支持设计依据；MAC任务/G门的完成状态以实际执行记录为准。历次文档修订、核实方法和未验证范围见[review修订记录](../codex-java-lsp-mcp-index-lifecycle-v2-macos-review-2026-10-13.md#8-手册修订核实记录)。

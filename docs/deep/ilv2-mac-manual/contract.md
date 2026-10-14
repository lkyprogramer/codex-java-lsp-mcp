# ILV2-MAC 目标合同（§2）

[索引](../codex-java-lsp-mcp-index-lifecycle-v2-ai-execution-manual-2026-10-13.md) · 门状态见 [`status.json`](../../index-lifecycle-v2/mac/status.json)

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
- MAC-02B覆盖刚启动后及稳定运行时SIGKILL、锁暂占用、锁等待超时/OWNER_BUSY重启、活动Gradle导入中故障、同root重复启动、父死子存和锁fd意外关闭。原“故障后≤10 s完整清理”仍为G02B（原语，真实launchd）与G09（正式产品恢复）硬门，G06C只验调度准入、不重复该证明；两类进程从同一故障时刻计时；静态降级可用不能将清理超时改判PASS。若互斥或完整收敛失败，用失败证据修复该门，不预先增加自有持久PID日志/start gate/常驻guardian。
- 原生部分限于capability、clonefile、FSEvents和小型exec/flock launcher，使用C17系统API；架构/协议/binary digest可验证，不做universal或Node ABI addon。clonefile只用于**缓存卷内**SEALED DB→私有tmp DB。APFS、同卷是缓存路径硬前提；业务仓库可在另一卷，capture读取实际字节，不调用clonefile。
- 不支持clone、helper缺失或runtime身份不符明确失败，不转普通复制。Node/OS升级重新冻结并跑受影响门；不能把另一PATH会话的版本当本候选版本。
- **TCC责任进程（开放决定）：** 2026-10-14的隔离launchd探针中，job的Program是本launcher，exec冻结Node后读取`~/Documents`下的文件，仍触发`kTCCServiceSystemPolicyDocumentsFolder`的`AUTHREQ_PROMPTING`。TCC把launcher记为`responsible_path`，`binary_path`为node（`status.json`的`openDecisions`引用该证据）。业务仓库位于`~/Documents/program/`，所以生产owner首次读取业务仓会等待隐私授权，未获授权时capture被阻塞。可选路线有三条：给launcher稳定的代码签名身份，再由用户一次性授权；把业务worktree迁出保护目录；或换用另一种经同一探针证明的启动拓扑。由用户在MAC-17之前决定。决定之前，不得把生产读取业务仓视为已验证。按TCC以cdhash识别ad-hoc签名的一般行为推断，每次重建的候选binary身份都会变；该推断尚未实测，不能据此复用授权。

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
- full 作业上限 `max(600 s, 3 × B_full)`，B_full 在 MAC-00 取基线无故障完整 full 的中位数；无法测得基线时用 900 s 并标 UNMEASURED_BASELINE。MAC-00补测B_full=409.9 s，故full上限为1,230 s。seed/delta 作业上限 60 s。它们是终止上限，不是性能通过阈值。

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

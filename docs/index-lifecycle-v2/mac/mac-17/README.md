# MAC-17 隔离安装验收收尾

2026-11-03 [索引就绪修复与单次真实验收](index-ready-fix-acceptance.md)：修复通过。17/17 定向检查及唯一真实精确定义、引用验收通过。客户端 106.150 秒 READY；首次引用 430.448 ms。19 PID、7 个自有组退出，候选和证据收尾通过。LOCAL 候选供审查，历史失败和正式 G17 FAIL 保留，未部署。

**后续待办 · JDT 冷启动耗时（未开始）**。隔离样本从进程启动到 READY 为 106.150 秒，其中 `ServiceReady` 后的索引屏障耗时 74.356 秒。若日常使用同一仓库时反复遇到长等待，先用同一候选和仓库，对比新建与保留 JDT 工作区时的启动耗时，分别记录项目导入和索引屏障耗时。保留默认静态路径、原 120 秒启动上限和精确定义、引用门槛。此项性能工作单独排期。

2026-11-03 [首次引用索引等待的根因与最小方案](reference-index-readiness-diagnosis.md)：同 PID 两次栈确认引用等待仍在推进的 JDT 索引队列。方案复用既有只读 `java.project.getAll`，在原 120 秒启动预算内通过索引屏障后再 READY。方案尚未实施，完整验收仍 FAIL。20 PID、7 个自有组退出，原始证据和到期资源收尾完成。

2026-11-02 [安装期依赖恢复与准备后语义验收](install-prepared-acceptance.md)：部分完成。恢复两个真实模型通过，JDT 30.195 秒 READY，精确定义通过。唯一引用请求在原 10 秒预算超时，整体验收 FAIL，候选停用。20 PID、8 个自有组退出，证据与临时资源收尾通过。历史空缓存及 G17 FAIL 保留。

2026-11-02 [Gradle 最终事实与验收边界](gradle-cold-final-diagnosis.md)：尚未彻底解决。隔离 HOME 组件 8/8 与真实两操作证明通过；干净冷语义仍 FAIL。五根资源与 raw/tmp 收尾完成，候选停用。等待用户选择安装期依赖恢复，或保留空缓存全程 120 秒并停止。历史失败与 G17 FAIL 保留。

2026-11-02 [两补丁后的唯一最终冷语义验收](remediated-final-cold.md)：FAIL，候选停用。物理空 home 和单次 JDT 启动成立，原 120 秒截止时仍在下载必需依赖并导入模型；精确定义、引用均 NOT_RUN。实际 init、Gradle 参数和 marker 检查通过。17 PID、5 个自有组退出，证据归档完成。按用户要求失败即停，没有追加重试。

2026-11-02 [冷导入的根因与最小修复](cold-import-root-cause-remediation.md)：Astra xhigh 复核三个独立缺陷。共享启动与状态分类回归 24/24 PASS；真实 Gradle 模型证明源码附件开关生效；隔离业务副本的单行 BOM 补丁使三个 classpath 的 9 项实际工件检查通过。修复后完整冷语义尚未运行，原 G17 FAIL 保留。

2026-11-02 [按方案执行的最终结果](original-chain-cold-acceptance.md)：新门槛回归 5/5 PASS；唯一原链插件观测 PASS；唯一空 Gradle home 最终验收 FAIL。实际参数、代理路线和 Boot marker 均通过，但完整导入在原 120 秒预算边界结束，定义与引用未开始。另确认冻结业务输入的 BOM 传播缺口，不能把它当成超时的唯一原因。三个新运行根均收尾完成，候选停用，G17 FAIL 保留。

2026-11-02 [Astra xhigh 诊断与收敛方案](astra-cold-gradle-diagnosis.md)：确认旧参数证明门槛错误及 JDT 无认证代理的独立缺陷。唯一真实 TAPI 探针观察到原插件 POM 下载成功，完整模型仍未在 120 秒内完成。历史 JDT/Buildship 插件失败原因尚未确认，原 FAIL 与候选 NOT_READY 保留。本轮没有实施产品修复。

2026-11-02 用户授权的 [单次 TLS 1.2 冷 Gradle 验收](tls12-single-acceptance.md) **FAIL**。Spring Boot 4.0.6 插件 marker 仍无法解析，真实语义未通过。按用户要求停止使用候选，不再重试。既有安装证据与历史失败保留。正式 G17 FAIL 保留。

2026-11-02 用户授权的 [新基线安装结果与冷 Gradle 最小方案](current-baseline-acceptance.md)：完整安装和升级通过，冷 Gradle 语义仍阻塞，候选 NOT_READY。用户取消兼容与回滚工作。下列内容是历史收尾记录，失败结论与工件保持原样；新运行单独记录结果。

2026-10-31。本次有界验收已停止并收尾，**G17 = FAIL，candidateStatus = NOT_READY**。两次完整 installer 均在必需的脚本测试中遇到同一 native 调用超时；按预定停止条件不再重试，不补丁试错、不放宽时限。未 push、未操作生产，早于 2026-11-03 18:00+08 截止。

唯一门状态由 [task-result.json](task-result.json) 和 [status.json](../status.json) 生成。原始失败、定向复核、独立评审、资源及归档事实见 [acceptance-summary.json](acceptance-summary.json)。本报告不表示可以部署生产。

后续用户授权的 native 超时补证据已单独收尾：[诊断报告](native-timeout-diagnosis.md)。结果为 **NOT_REPRODUCED / 根因 UNDETERMINED**；原失败工件与现场缺失，未实施产品修复，本页 G17 FAIL 保留。[诊断 workflow 结果](native-timeout-task-result.json) 不覆盖正式安装验收。

2026-11-02 继续取证已区分首次启动延迟、依赖恢复导致的 NOT_READY 和 OS/clang 漂移。依赖恢复问题已定因，同一候选修正依赖后原单项 1/1 PASS；历史 5 秒根因仍未确定。实际二进制、同 PID 时序、采样边界及解决方案见 [首次 capability 捕获报告](first-capability-capture.md)。正式 G17 FAIL 保留。

## 本次改动与身份

最终实现源码为 `f58e66190952aab415a9f5f6fc4e70cdbacf86c1`：

- `f5df7f9a`：仅隔离安装的 candidate smoke 使用已有全机 fixture 配额执行器；实际子进程组退出后释放名额，生命周期定向验证 3/3 PASS。
- `f58e6619`：仅隔离模式的 plist 显式保留私有 HOME、TMP、XDG、CODEX、run 和冻结 runtime 身份，避免 launchd 脱离本次隔离环境。
- 相对原候选 `0fb81bb52c0e`，`src/`、`native/`、native build helper、package.json 和 package-lock.json 均未变。不重跑 G12/G14、MAC-16 或原两小时 canary。

源码和私有验收 harness 已独立审查。两次完整测试使用相同源码和冻结 Node/工具链，fresh npm-ci 的依赖字节清单不同，已按各自 identity 保留；不能声称它们与旧候选包字节相同。

## 实际结果与停止点

| 尝试 | 实际结果 |
|---|---|
| R1：073839Z | 真实 npm ci 和签名 build 成功；复用的旧 runtime 包将 `.bin/tsc` 链接展开为普通文件，编译入口 MODULE_NOT_FOUND，未执行测试。这是准备失败，单独保留 |
| R2：082239Z | 改用真实 npm-ci 依赖并保留链接。源码测试 1601/1601 PASS；脚本 670 项：659 PASS、10 具名 SKIP、1 FAIL |
| R2 定向复核 | 在同一个冻结 broker/candidate 上仅运行失败用例，1/1 PASS；完整 source/dist/dependency/native identity 无漂移。该结果不覆盖原 full FAIL |
| R3：085341Z | 经独立复核后进行唯一一次不改代码、阈值或时限的完整 installer 重试。源码仍 1601/1601 PASS；脚本仍 659 PASS、10 具名 SKIP、同一项 FAIL。到此停止 |

唯一失败为 `scripts/ilv2-mac-retrieval-eval.test.mjs:153` 的 product-mcp 独立 owner 检索用例，错误为 `native process deadline exceeded`。两次用例耗时分别约 5607.596 / 5592.667 ms。执行器的 5 秒上限覆盖 native 子进程启动至 close；原记录缺少当时 native PID、启动/退出和管道关闭时序，**根因 UNDETERMINED**，不能断言 statfs 阻塞。

两次窗口全 AC，最高 load1 分别 7.39 / 5.50，可用内存最低约 8.34 / 8.97 GB；没有证据将失败归因于高负载。没有新增 retry、预热、超时放宽或 runtime 优化。

| 验收项 | 最终状态 |
|---|---|
| 完整 installer 入口 | **FAIL**：必需测试门失败，尚未进入主服务激活 |
| installer 安装后服务身份及实际业务读回 | NOT_RUN |
| 完整 installer 升级与实际 daemonctl 回滚组合 | NOT_RUN；没有构建/激活本次 B release |
| 空私有 Gradle home 首次语义、依赖下载、首次耗时和磁盘成本 | NOT_RUN；真实业务副本的首次 JDT 导入未开始 |
| 生产固定 launcher 的 TCC 授权、业务文件读取、升级后复读 | NOT_RUN；用户排除生产，未运行授权探针，也没有观察到 TCC 拒绝 |
| 生产部署、MAC-18/19、AI 效益 | NOT_RUN |

两个完整尝试都保留 10 项同名、同理由的环境/专项未选具名 skip；没有取消项或 todo。没有把编译失败当行为 RED，也没有用单项 PASS 拼成完整 installer PASS。完整精确 argv、退出码及计数由生成器读取原 validation-index；失败后的 smoke/激活步骤未执行。

## 保留工件

本次只保留一份实际构建的 **UNQUALIFIED 取证包**，没有提升为可部署候选：

- 路径：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261031T085341Z-acceptance-retry2/unqualified-installer-build-f58e66190952.tar.gz`
- SHA256：`3a3b4ebf2a1ccb73efdd083124494511d2f0485740c82f37ddb8bbd1fe9afc27`
- 6492 个普通文件、7 个相对符号链接，逻辑字节 104941571；压缩包 20295761 bytes。
- inventory digest：`7a34c9f0d4a4ec8e91c2f7a7521a8c454130527e85519c0e3c9f4f527932e277`。
- 实际 native SHA256：`8a7526baf36fa8039a7314219cb4c3c04e162ae2405a5c646a5dc12fbae14b74`；Team `2UVGT2J459`，严格 codesign 核验通过。该身份属于实际 release，不能与独立 broker 重新签名后的 binary hash 混用。
- 包已一次物理解压，逐项核对所有文件、目录模式及符号链接；验证 PASS 仅说明包完整，不代表安装验收通过。

原 `0fb81bb52c0e` 审查包保持 LOCAL，没有重复解压或修改：

`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261031T021745Z/deployment-candidate-0fb81bb52c0e.tar.gz`

SHA256 `20a8d575469cf6da7d77477e21e3579dc1b065068d4e5243c93b942503a29ef1`。该包此前完成 7266 文件核对；其源码/工件与本次 f58 取证包分别标识。

## 复用的既有证据

| 原候选检查 | 结果与边界 |
|---|---|
| 正式签名环境探针 | READY；本次复用冻结环境，没有以 READY 代替安装验收 |
| 原受影响测试 / 独立另一次构建 | 65/65 PASS / 4/4 PASS；仅覆盖原候选和未变的受测边界，不覆盖本次 full CLI 失败 |
| 原两小时静态 canary | 1000 正常请求加 20 次真实编辑；正常请求跨度约 120.07 分钟，编辑可见延迟 p95 1148.355 ms，两窗口 status p99 31.287 / 53.791 ms |
| 原真实安装组合演练 | 同源双 immutable 路径 A→B→真实 daemonctl rollback→A PASS；不代表完整 installer 或跨版本迁移 |
| MAC-16 | worktree/JDT 隔离 PASS；条件精度专项 NOT_RUN；原 closeout PASS，不重跑 |
| 原 GC 观测 | 246 sweeps OBSERVED；正向 reclamation、canary 内部 held lease 仍 UNVERIFIED，硬不变量复用 G14 |

原 021745Z raw archive SHA256 `981d03d625db8d702fc9fc480af7fa05d51a4a058c429bc785e94f480405d349`，原资源和归档收尾保持不变。

## 资源与归档

独立评审按完整清单实际核对 ps、每个精确 launchd job 和只读 quota。统一 closeout 再核对实际退出，各做一次 raw 归档及一次物理解压全 hash 验证，删除本次到期 raw/tmp。三根均 **closeout PASS、unregisteredPaths=[]、expiredResidualBytes=0**；最终资源清单与独立评审列表一致。

| 运行根后缀 | PID / 自有组 / job | raw archive SHA256 |
|---|---|---|
| 20261031T073839Z-acceptance | 6 / 3 / 1 | `e327a879a892dfe6ed88bd23803308ef393cbd014713d1722121ddb25409fbc6` |
| 20261031T082239Z-acceptance-retry1 | 167 / 35 / 35 | `d2c168f2735a6c4c7e58d5d3d78219b9340de82c1bdd60ff89ed26a3df9816a8` |
| 20261031T085341Z-acceptance-retry2 | 166 / 35 / 35 | `95fc11d2e7cfb01202d5d7bf7d0d0ef9ac812e99a41d4fa763a70d788f7a7f14` |

归档均为对应运行根的 `closeout/raw-evidence.tar.gz`。原失败日志、fixture 证据和 host 观测均在归档内；LOCAL 清单、判定、包、独立评审及 validation-index 保留。本次只在实际退出后给本次到期的只读 snapshot 目录增加 owner 写权限，没有删除其他运行根或清理未知进程。

## 限制与下一步

本次按停止条件结束，不再自动启动任何验证。若另行启动后续任务，先补齐 full-suite 场景的 native 启动、退出和管道关闭证据，定位这一个 5 秒超时；取得新证据后再决定修复及最小复验。随后才能继续完整安装激活、空 Gradle 首次语义、升级和回滚。当前不重放失败 installer，也不新增诊断框架。

生产 TCC 与生产切换仍需单独明确授权。MAC-17 隔离验收即使通过，也不等于 MAC-18 已切换或 MAC-19 观察完成。本次没有创建或调用生产 runtime/cache/LaunchAgent，也没有读取生产状态。

installer 的 npm ci 记录了 9 项依赖告警（4 moderate、4 high、1 critical），尚未区分生产/开发影响。额外独立 `npm audit` 被自动审批拒绝，理由是可能外发依赖元数据；已放弃该额外动作，没有绕过或升级依赖。

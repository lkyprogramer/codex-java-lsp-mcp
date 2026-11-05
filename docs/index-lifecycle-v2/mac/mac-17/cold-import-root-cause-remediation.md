# MAC-17 冷导入：根因与最小修复

后续：[另行授权的唯一最终冷语义验收](remediated-final-cold.md)为 FAIL。下文保留修复及组件验证的原始结论；不能用组件 PASS 覆盖该最终失败。

2026-11-02。三个独立缺陷取得直接证据。产品最小补丁与定向验证完成。业务 BOM 补丁只在隔离副本验证，未写入业务主工作区。**修复后完整冷语义为 NOT_RUN，正式 G17 FAIL 保留，候选仍 NOT_READY。**

前几轮把局部连通或插件解析成功作为完整导入的充分前提，过早消耗最终语义验收次数。这是排查方法的问题。原链后来确实解析了 Boot marker，但仍在原 120 秒边界终止。TLS 配置不能修复后续全部导入工作。

## 原因与改动

| 原因 | 直接证据 | 最小改动 |
|---|---|---|
| Gradle 导入同步解析外部依赖源码附件 | 原失败缓存有 361 个 sources jar，逻辑字节 125055787；启动约 78.7 秒起仍密集下载源码。冻结 Gradle 的 RunClosedProjectBuildDependencies 会解析 Eclipse classpath | 受管 init 仅设置 EclipseClasspath.downloadSources=false。脚本位于 JDT workspace，通过现有 java.import.gradle.arguments 传入。原 Gradle home 不预填 |
| 共享启动截止错误沿用调用方超时代码 | 原终态 BROKEN/importFAILED，但失败计数为 0。新增 RED 分别复现 initialize/import 截止分类错误，状态工具另吞掉真实服务错误 | 仅将内部启动预算的 DEADLINE_EXCEEDED 转为现有 JDT_SERVER_ERROR。现有 backoff 保留错误消息。status 按错误码分支，避免按消息吞错 |
| platform-core 没有向消费者导出 BOM 约束 | 真实 ai 消费者的三个 classpath 各出现三项空版本依赖 | 生产者仅增加 `api(platform(libs.spring.boot.bom))`。保留原本地 dependency-management；不在 LS 注入业务版本 |

`java.import.gradle.downloadSources` 不是本次 JDT/Buildship 的有效设置，未使用该键。init 在 projectsEvaluated 后注册 Eclipse 插件回调，覆盖提前应用和模型阶段应用插件的两种情况。普通命令行构建配置不变。代价是导入不预下载外部依赖源码附件。

原 15 秒调用预算、120 秒共享启动预算、证书校验保持原样。共享截止修复使立即后续请求进入已有退避期，不会缩短首次导入。源码附件窗口与缓存字节不能换算成必然节省的时间，也不能据此保证完整冷导入小于 120 秒。BOM 缺口不是已经证明的唯一超时原因。

## 验证

- TypeScript：RED 5 项，2 PASS、3 FAIL；真实失败为两个共享截止分类及状态工具吞错。原记录保留。
- 最终定向回归：24/24 PASS，0 skip/cancel。覆盖共享截止、短调用方、租约、退避、状态和受管 init 配置。使用 fake JDT transport，不冒充真实 JDT 语义。
- 真实 Gradle 9.3.1/TAPI 8.9 模型：原两个依赖源码附件均存在；修复后均为 NONE。两个二进制文件名、三个项目标识、四个源码目录路径相同。包含模型阶段才应用 Eclipse 的项目，以及 afterEvaluate 设置 downloadSources=true 的项目。
- 上述模型使用本地文件依赖仓，无外网。两次模型共用私有缓存与 daemon，耗时不构成性能对照。项目依赖边、完整 sourceSet 属性及 APT 未实测。
- 真实业务副本：固定 HEAD `6403a9c3c020741f2ce7bf77564e8e4dba1cc555`。临时 observer 附着真实 ai 的 classes 任务，只解析原有三个配置和检查实际外部 jar。未创建合成消费者。
- 业务 RED：三个配置各出现 jackson-annotations、jakarta.validation-api、slf4j-api 空版本错误，共九项。
- 业务 GREEN：仅生产者增加一行。compileClasspath/runtimeClasspath/testRuntimeClasspath 的九项实际文件检查通过；版本分别为 2.21、3.1.1、2.0.17。
- ai 的 compileJava 原为 NO-SOURCE。本证据证明配置解析，不表示 AI 编译测试、应用兼容或完整语义通过。业务证明实际下载了 Gradle wrapper 和依赖。
- 业务命令使用原仓库全局租约及 `--no-parallel --max-workers=1 --no-daemon`。两个过程保留相同 observer。没有放宽任何原语义断言。

实际命令与输出在本次归档的 `raw/{red,green,sources,source-policy,business-proof}/`。复现入口保留在运行根的 `validate.mjs`、`source-policy.mjs`、`business-proof.mjs`。最终 observer 身份为 `d57dc7f2d6de0f9f2785cde7185f269cbf7bfe9f5a8719fd97a1a85c37c47063`；早期 v1 准备记录单独保留，未冒用为最终身份。

## 补丁与审查

- 当前工作区修改：`src/jdtls-session.ts`、`src/jdtls-semantic-backend.ts`、`src/jdt-restart-backoff.ts`、`src/tools/status.ts` 及对应定向测试。
- 产品补丁基点：`ff81b8ddbcb8c508f785f035be92323e5a8b4027`。源码补丁 SHA256：`cfcd4f85b6073932e0b3fe324dbb2ddcb575f32863ffe42ada869d9c85c17843`。
- [业务单行补丁](platform-core-bom-export.patch) SHA256：`4019b815297a5c310aad773c774d6b8512c1d8f6d0ffa62330d3e39ffb18a65c`。可应用于当前业务主仓对应文件；仅执行了 apply --check，没有应用到主仓。
- Astra xhigh 独立只读审查通过，无 open findings。审查覆盖实际源码、记录的 RED/GREEN、模型对照及资源退出。审查者没有另跑测试、JVM 或网络探针。

本次运行根：`/private/tmp/mac17-root-cause-20261102T090900Z`。LOCAL 保留补丁、observer、输入身份、摘要、独立审查与原始归档。统一 closeout 的实际结果及 SHA 见 [生成结果](cold-remediation-task-result.json)。临时业务 worktree 只在消费者结束后删除。没有操作旧运行根或旧包。

## 剩余边界

修复后新候选的完整冷语义尚未执行。旧的唯一最终验收已结束，不能重放成通过。下一项验收必须明确绑定产品补丁和修正后的业务输入；必须保留受管 init，再追加原隔离 TLS/代理配置，不能由观察脚本覆盖该 arguments。仍须物理空 Gradle home、单启动、原 120 秒、精确定义、引用和真实退出。

未重跑完整测试、installer、canary、兼容或回滚。未构建或发布新 product/native release。未 push、未操作生产、未读取生产 TCC 状态。生产 TCC 与 MAC-18/19 不在本次范围。原硬截止仍为北京时间 2026-11-03 18:00。

本次资源与归档：20 个已登记 PID、1 个自有组、0 个 launchd job，退出检查与全 argv 残留检查通过。全局配额为空。raw 归档 51 文件、161419 逻辑字节，一次物理解压全 hash 通过；SHA256 为 `1346e48b54b3191a49fe03966b24baa496cd16e399cdc7ad52d2d95bb9c4a947`。本次 raw/tmp 均删除。清单首次预检仅因输出日志未登记而中止，归档和删除尚未开始；原预检失败保留，补齐清单后完成归档，没有重跑验证。业务 worker 的数值 PID 没有持久化，退出依据是已完成的 fixture executor 和最终 argv/配额核对，不宣称记录了所有创建过的 PID。

持久工件副本：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/artifacts/mac-17/20261102T090900Z-root-cause-remediation`。它是本次运行的只读交付副本，不是新的可执行运行根；原始运行根仍为上文 `/private/tmp` 路径。

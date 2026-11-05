# MAC-17 Astra xhigh 诊断与收敛方案

后续用户授权实施的真实结果见 [门槛修正、原链观测与最终冷语义收尾](original-chain-cold-acceptance.md)。本页保留原诊断和原方案。新门槛及原链插件观测通过；唯一最终冷导入仍未在原预算内完成，实际业务 BOM 传播缺口单独记录。没有追加重试。

2026-11-02。按用户要求派发 `gpt-6-astra / xhigh`。本轮只诊断和给出方案，没有实施产品修复。新增一次实际 Gradle Tooling API 诊断，单次上限 120 秒，没有重跑 installer、完整测试或 Java 语义验收。

**结论：前轮验收的参数证明方法有误。原 Gradle 参数传递链没有证据需要替换。JDT 的无认证代理分支另有确定缺陷。历史插件解析失败的底层原因仍未确认。**

这四个判断分别成立。不能把其中一项写成全部故障的根因。正式 G17 的历史 FAIL 和候选 NOT_READY 保留。

## 为什么前轮没有解决

1. **测了启动命令行，没有测构建中的属性。** Gradle 9.3.1 会把本次五个 `-D` 参数归入可变系统属性。它在每次 build 前设置属性，结束后恢复。daemon 启动命令行不必包含它们。私有 harness 却把命令行包含四个参数作为成功条件。即使后续语义成功，这个条件也会误判失败。本次原语义确实失败，因此不能改写原 FAIL。
2. **HEAD 成功只证明了一次请求。** 它没有证明 JDT/Buildship 的真实模型导入，也没有证明 Gradle GET、重定向和依赖下载。前轮过早用该结果支持最终验收。
3. **原异常没有保留底层下载错误。** Gradle 插件解析器使用宽松解析，再把失败集合压缩为插件不存在。只有 `UnknownPluginException` 的栈不足以区分 TLS、代理、HTTP 响应和仓库内容。
4. **混合了两个消费者。** JDT 请求 Gradle 版本列表的 TLS 错误，属于另一个非阻断后台请求。它不是已证实的 Spring Boot marker 失败原因。

源码依据：[构建前设置、构建后恢复属性](https://raw.githubusercontent.com/gradle/gradle/v9.3.1/platforms/core-runtime/launcher/src/main/java/org/gradle/launcher/daemon/server/exec/EstablishBuildEnvironment.java)、[插件宽松解析与错误汇总](https://raw.githubusercontent.com/gradle/gradle/v9.3.1/platforms/extensibility/plugin-use/src/main/java/org/gradle/plugin/use/resolve/internal/ArtifactRepositoriesPluginResolver.java)。

## 已确认的配置边界

产品 `src/jdtls-semantic-backend.ts:255` 设置私有 Gradle home 和 JVM 参数。`src/jdtls-session.ts:843` 在 initialize 中发送设置。JDT 在导入前读取设置。Buildship 将参数交给 `setJvmArguments`。Astra 用本地冻结 jar 的字节码核对了这些调用。

因此，本轮不推荐把现有参数改写到 `gradle.properties` 来碰运气。该入口有效，但没有证据说明它会修复现有故障。也没有证据支持参数键错误、数组类型错误或初始化顺序错误。

JDT 1.56 的 `JavaLanguageServerPlugin.configureProxy` 另有问题：只有代理用户名非空时，它才选择 Manual。本次代理不要求认证，因此选择 Native。本机冻结的 Eclipse `org.eclipse.core.net` 只提供 Linux 和 Windows 的 Native provider，macOS 分支为空。代理管理器随后会改写 HTTPS 代理系统属性。启动参数和 macOS 系统代理开启，都不足以证明 JDT 的最终代理状态。

该问题可以解释 JDT 后台版本列表请求的代理风险。它尚不能证明 Gradle marker 失败的原因。Gradle 接受的显式参数具有独立传递路径，源码没有证明 JDT 属性覆盖它们。

源码依据：[JDT 代理选择](https://raw.githubusercontent.com/eclipse-jdtls/eclipse.jdt.ls/v1.56.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/JavaLanguageServerPlugin.java)、[Eclipse Native provider](https://raw.githubusercontent.com/eclipse-platform/eclipse.platform/R4_37/team/bundles/org.eclipse.core.net/src/org/eclipse/core/internal/net/ProxyManager.java)、[Buildship 参数消费](https://raw.githubusercontent.com/eclipse-buildship/buildship/d99d99a319906c88418fe7a4dbfeec0b48a35805/org.eclipse.buildship.core/src/main/java/org/eclipse/buildship/core/internal/configuration/GradleArguments.java)。

## 唯一实际诊断结果

新运行根：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261102T072800Z-astra-gradle-diagnosis`。

复用冻结业务输入 HEAD `fd9c117b4cfad46247757d4c373b9465534fe33f`，完整复制并核对 6286 个文件。使用原 Java 25.0.2、TAPI 8.9 和 Gradle 9.3.1。Gradle home 起始为空。原五项 JVM 参数保持不变。唯一附加内容是只读 `beforeSettings` 观测与 `--debug/--stacktrace`。

| 实际观测 | 结果 |
|---|---|
| build 内五项参数 | 全部与原配置一致 |
| 实际 Gradle home | 本次私有 home |
| 实际 ProxySelector | `sun.net.spi.DefaultProxySelector` |
| marker 的代理选择 | `HTTP @ 127.0.0.1:8888` |
| 原 Spring Boot 4.0.6 marker POM | 真实 GET 并成功进入 Downloading |
| 诊断日志中的 SSLHandshakeException / PKIX / UnknownPlugin | 均为 0 |
| 完整 EclipseProject 模型 | 未完成；120330 ms 达到上限后停止，exit 143 |
| 停止时最后活动 | 仍在下载依赖和源码 jar |

关键原日志位于 `raw/tapi-model/0.stdout.txt`：165–176 行记录实际属性和路线；478 行记录 marker GET；611 行记录发送请求；615 行记录下载。原始文件在收尾后由归档保留。

停止后的首次采样记录为 4177 个文件、640152946 个逻辑字节、651038720 个分配字节。独立复核时分配字节为 650375168，文件数与逻辑字节未变。分配字节是随文件系统变化的快照。其中有 647 个 jar，237 个为 source jar。这些数字混合下载、生成和缓存内容，不能当成精确网络流量。源码下载不是已证实的唯一预算原因。

**该结果排除了“这五项参数在当前独立 TAPI 路径无法工作”。它没有复现历史 marker 失败，也没有证明原 JDT/Buildship phased 导入成功。** 本次没有 JDT/MCP、精确定义或引用验收。

## 唯一推荐方案

### 1. 修正确定错误，保留产品参数链

新私有 harness 删除 daemon 命令行包含四个参数的成功条件。改用 build 内五项属性、实际 Gradle home、代理选择及真实 GET 结果。原精确定义、引用、固定 JDT PID、单次启动和资源退出条件全部保留。

保留现有 `java.import.gradle.jvmArguments` 与隔离环境设置。不得伪造代理用户名，不得关闭证书校验，不得补无效的顶层 `http.proxySupport` 设置。不得自动改仓库、依赖版本或增加备用下载路径。

### 2. 在原消费者上只定位一次

下一次只观测原 JDT/Buildship phased/composite 导入链。通过现有 `java.import.gradle.arguments` 追加以下参数。保留原五项 JVM 参数和 JDT 自带 init 脚本。

```text
[...originalArguments, "--debug", "--stacktrace", "--init-script", observerAbsolutePath]
```

只执行一次 initialize/import。取得 marker 的明确成功或失败后结束。最迟 120 秒停止并回收本次资源。该步骤不发定义或引用请求，不延长预算，不追加另一轮。

- 属性或路线与配置不符：只修实际覆盖配置的位置。
- 属性和路线正确、GET 失败：只修日志确认的网络或响应问题。
- marker 成功：历史故障保持“未复现”，不得再追补历史因果。
- 120 秒内仍未取得结果：按现有限制停止，报告未满足的导入条件。

### 3. JDT 代理的独立条件修复

若实际使用该无认证显式代理入口，JDT 的最小源码修复是 `configureProxy:282` 的外层判断：由 `isNotBlank(httpUser) || isNotBlank(httpsUser)` 改为 `isNotBlank(httpHost) || isNotBlank(httpsHost)`。保留原端口解析和认证逻辑，不增加必须显式配置端口的合同。该修复属于冻结第三方工具链变更，不能偷偷塞进产品环境变量或伪造用户名。

它必须单独冻结新 JDT jar 的身份，并证明最终 provider、实际代理属性和路线。它不能单独作为 Gradle marker 修复，也不是 marker 诊断或最终语义验收的强制前置。当前只给出该切口，没有修改或重建 JDT。

### 4. 以原语义目标收尾

只有原消费者的配置和下载链取得实际证据后，才安排一次最终空 home 语义验收。完整 installer 和已通过的矩阵不重跑。原时限、证书校验和语义断言不变。失败即停用，不自动重试或扩展优化。

本方案的完成条件是实际定义和引用通过。HEAD 成功、版本列表成功、ServiceReady、独立 TAPI 下载成功都不能替代它。

## 资源与证据

原 `gradle --stop` 在 803 ms 内返回 exit 0，显示停止一个 daemon。紧随的即时退出检查仍看到 PID 39950，原失败记录保留。稍后的完整 PID/组检查确认退出。本轮只用原有配额适配器回收完全匹配本次已结束进程的名额，没有清空共享配额或向未知进程发信号。

Astra 独立只读复核确认 5 个 PID、2 个自有组均为 ESRCH，全局两张配额表均为 0。其沙箱拒绝 `ps`，因此不声明独立 `ps` 通过。主代理的实际 `ps` 读回和完整资源记录另行保留。

统一 closeout 为 PASS，未登记路径和到期残留字节均为 0。本次 raw 的 10 个文件、50156701 个逻辑字节完成一次归档及一次物理解压全 hash 核验。归档 SHA256 为 `8ab39c463f24b289c35dcd49e1cdef88d09ba0f3011a48c40c1f97823a00014c`，位于本次运行根的 `closeout/raw-evidence.tar.gz`。本次 raw/tmp 清理完成。LOCAL 观测代码、计划、清单、摘要、结果和归档保留。本轮不改变历史包或原归档。

生成结果见 [astra-diagnostic-result.json](astra-diagnostic-result.json)。脱敏事实见 [astra-diagnostic-summary.json](astra-diagnostic-summary.json)。其中 FAIL 表示模型没有在诊断预算内完成，不表示本轮诊断报告缺失，也不覆盖历史 G17 FAIL。

本轮未修改产品、代理或生产设置。没有 push。原硬截止仍为 2026-11-03 18:00+08:00。本轮诊断另设 2026-11-02 16:00+08:00 收敛点。

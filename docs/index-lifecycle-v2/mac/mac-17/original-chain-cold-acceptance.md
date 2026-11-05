# MAC-17 门槛修正、原链观测与最终冷语义收尾

**门槛修正和原链插件观测完成。唯一一次空 Gradle home 语义验收 FAIL。候选停止使用，正式 G17 的历史 FAIL 保留。**

2026-11-02。原硬截止为 2026-11-03 18:00+08:00。本轮按一次观测、一次最终验收的边界停止。没有重跑 installer、完整测试、canary、兼容或回滚。没有 push 或生产操作。

## 本轮实际结果

| 项目 | 实际结果 |
|---|---|
| 修正后的门槛回归 | 最终版本 5/5 PASS；同一代码字节复用到实际观测及验收 |
| 两次准备失败 | Clang producer 变化、Apple Git 许可阻断；各自保留 FAIL，均未启动 owner/JDT/Gradle |
| 原 JDT/Buildship 插件观测 | 一次真实 JDT 启动，27472 ms 内观察到完整 Boot 4.0.6 `Resolved plugin`；没有定义或引用请求 |
| 构建中的实际配置 | 原五项 JVM 参数、私有 Gradle home、实际代理路线均 PASS |
| 唯一最终验收 | TAP 1 项：0 PASS、1 FAIL；0 skip/cancel/todo |
| 最终冷导入 | 原 120 秒启动预算边界终止；终态为 `JDT import failed` |
| 精确定义、引用 | NOT_RUN；导入未达到 READY，未进入这两项验证 |
| 实际退出与归档 | 三根 closeout PASS；未登记路径与到期残留字节均为 0 |

最终验收的 Gradle home 起始为 0 文件、0 目录。没有复制观测阶段或用户的 Gradle 缓存。业务输入仍为原冻结的 6286 文件，原语义 oracle、固定 PID、网关 miss、单次启动和证书校验条件不变。

最终首次静态结果耗时 134258.393 ms。JDT 仅启动一次。实际 JDT 从 spawn 到 TERM 为 119995.293 ms，到退出为 120224.152 ms。15 秒调用方超时和原始错误均保留。静态阶段更早的 `MCP tool error` 随后恢复，不是最终失败原因。

终止前状态为 Starting 70%，正在取得 `RunClosedProjectBuildDependencies` 模型。原 private driver 的 `firstFailure` 仍保留更早暂态；最终错误以原 actions 末条 `JDT import failed` 为准。

## 修正了什么

旧私有 harness 要求 Gradle daemon 的命令行包含四项可变 `-D` 参数。这个条件不符合 Gradle 的构建属性处理方式。新门槛读取 `beforeSettings` 中的真实五项属性，并核对实际私有 home、所属 daemon PID 和代理路线。实现类名只记录，不作为成功条件。原精确定义和引用断言没有减少。

本轮复用原签名成品，未调用 Clang。机器中的 Xcode/Clang producer 从 `clang-2100.1.1.101` 变为 `clang-2100.4.1.1`。旧 producer 身份保留，另记 `OBSERVED_UNUSED_PRODUCER`；没有把新哈希填入旧基线。运行门继续逐项校验原候选、Node/OS 和 443 项已记录的 JDT/Buildship/TAPI/Gradle/JDK 文件。JDK 实际覆盖 `bin/java` 与 `lib/server/libjvm.dylib`，不声称旧清单未记录的 modules、cacerts 或 security 文件字节一致。

准备脚本的元数据查询改用本机既有独立 Git 的绝对路径和 SHA。它仍核对原冻结 HEAD。没有接受 Xcode 许可，没有修改系统 Git、全局 PATH 或系统代理。

交付代码保留在本次私有运行根的 `gradle-proof.mjs`、`mac17-entry.mjs`、`mac17-phase-driver.mjs`、`observe.init.gradle` 和测试文件中。它们为 LOCAL 工件。历史 harness 没有覆盖。产品 `src/native/dist`、依赖和 JDT jar 均未修改。

## 本次证据说明了什么

原链和最终验收都证明 Boot marker 能解析，Gradle 构建中的五项参数正确。因此，没有依据再追加 TLS、代理、`gradle.properties`、仓库或 source-download 开关补丁。历史 marker 网络失败仍为未复现，不能声称已经定因或修复。

最终 Gradle daemon 日志计数：`SSLHandshakeException=0`、`PKIX=0`、`UnknownPluginException=0`。这只是本次 daemon 日志的范围，不代表 JDT 的所有后台请求均成功。JDT 的独立无认证代理缺陷没有在本轮修改。

最终日志还真实出现 6 个 `ModuleVersionNotFoundException`：两个 classpath 各包含三项空版本依赖：

- `com.fasterxml.jackson.core:jackson-annotations:`
- `jakarta.validation:jakarta.validation-api:`
- `org.slf4j:slf4j-api:`

Astra 核对原冻结构建文件后确认：上游库只在本项目应用 Boot BOM，却以 API 暴露无版本依赖；下游消费项目没有同一 BOM 约束。相关构建、settings、catalog 文件均匹配原冻结清单。这是业务输入自身的依赖管理缺口，业务副本没有修改。

**该缺口与 120 秒内未完成模型同时存在，但不是已证实的唯一超时原因。** 没有做新的时限对照或关闭源码下载来归因。最终缓存记录为 4577 个新增文件、1704 个工件文件、750612206 个逻辑字节、786276352 个分配字节快照。这些数字混合生成和下载，不等于精确网络流量；Gradle 发行版没有重新下载。

原 `actualJdtLaunchArgumentsObserved=false` 保留。导入未 READY，因此没有产生 READY 后的 `process-selected` 文件。另有原 trace 证明初始 JDT 启动参数包含四项设置；它不证明 Eclipse 后续的实际代理属性。

## 工件与资源

产品源码仍为 `174227f978a012f9c9bb525c5f3e658aa3e0c9a5`。实际 native SHA256 为 `7fa9bd85b10cc5414b5c6bb495263d7bdfa5662541f8c6a8f0de902aa538a2e3`。实际载荷在两个运行后均为 UNCHANGED。

复用的原 A 包为 `review-candidate-174227f978a0.tar.gz`，SHA256 为 `bdafaa6ccd270db710fa16e30e1f434506a70fee55aa9670740a7b4292dc81c2`。没有创建新候选包或重做旧归档验证。新 consumer 的载荷按原 6505 个文件、模式和 7 个链接逐项核对。

本次主运行根：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261102T081400Z-jdt-chain-explicit-git`。

| 根后缀 | PID / 自有组 / job | raw 归档 SHA256 |
|---|---:|---|
| 075300Z-jdt-chain-and-cold-final | 3 / 0 / 0 | `3b592a5ea67e67f9784f74d9fd8beedc2b2b15850ca628f9beec2386ce0e0d62` |
| 080800Z-jdt-chain-runtime-reuse | 1 / 0 / 0 | `dd9a5dbb67dcd8c41ff4b4fb2821f4f54ab61d0b7b884063d7de4d7129281870` |
| 081400Z-jdt-chain-explicit-git | 17 / 8 / 0 | `359ad92905b70f62584034852031cbfde03ce2f813c45aa1274b19c13e92f9be` |

三个归档各完成一次物理解压全 hash 验证。本次 raw/tmp 均清理完成。原包、历史归档、LOCAL 代码、计划、输入身份、结果和独立复核保留。没有清理旧 state 或共享配额，没有向未知进程发信号。

Astra 独立核对全部登记 PID/组均为 ESRCH，两张配额表均为 0。其沙箱拒绝 ps，因此不声明独立 ps 通过；主代理的统一 closeout 执行完整运行根 argv 扫描并通过。新声明清单与原 attempt、命令和 outcome 完全匹配。

## 停止边界与剩余工作

本轮不再运行任何验收，也不修改冻结业务输入。若后续继续，先在业务构建中修正 BOM 约束的传递，再冻结新的输入身份。不能靠复制用户缓存、跳过项目或放宽时限掩盖这个缺口。新的业务修改和另一轮运行不属于本次已消耗的单次验收额度。

原 installer A/B 的成功证据继续复用。当前仍不能声明 G17 PASS、READY_FOR_DEPLOY、DEPLOYED 或 AI 收益。生产固定 launcher 的 TCC、业务读、生产切换和 MAC-18/19 均为 NOT_RUN。

实际结果由 [original-chain-cold-result.json](original-chain-cold-result.json) 生成；脱敏事实见 [original-chain-cold-summary.json](original-chain-cold-summary.json)。两个准备失败分别见 [preparation-1](original-chain-preparation-1-result.json)、[preparation-2](original-chain-preparation-2-result.json)。原始请求、业务 oracle 和源码日志只保留在私有归档。

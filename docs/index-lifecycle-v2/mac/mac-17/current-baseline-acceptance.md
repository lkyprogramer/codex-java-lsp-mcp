# MAC-17 新基线安装结果与冷 Gradle 最小方案

2026-11-02，用户授权固定依赖恢复和实际加载检查，以当前 OS/Clang 冻结新基线，继续完整 installer 安装、升级、回滚及空 Gradle home 首次语义验收。硬截止仍为 **2026-11-03 18:00+08:00**。本轮不 push、不操作生产、不追溯旧环境，不修改 native 5 秒时限、测试断言或依赖版本。

**最新范围覆盖原计划：** 用户随后取消兼容与回滚工作。新版本有问题即停止使用。本轮不再排查、修复或复验兼容/回滚，不追加完整 installer、全量测试或 canary。原始执行和失败保留；当前只完成冷 Gradle 首次导入原因、最小修复方案及资源收尾。此范围调整不表示现有兼容/回滚代码已经删除。

## 实际结果

源码提交 `174227f978a012f9c9bb525c5f3e658aa3e0c9a5`，仅本地提交。依赖恢复修正及定向测试 16/16 通过。正式签名环境探针 READY，22304 个冻结工具链文件无漂移。旧 OS/Clang 的 manifest 和所有历史失败不改写。

| 验收项 | 实际结果 |
|---|---|
| 完整 installer A | 真实 npm ci、签名 build、完整 npm test、安装及固定端口 health/MCP/身份读回，exit 0 |
| 完整 installer B | 同源独立新 release，真实 npm ci、签名 build、完整 npm test、停服升级及身份读回，exit 0 |
| A/B 各自完整测试 | source 1601/1601；scripts 675 项：665 PASS、10 具名 SKIP、0 FAIL/取消 |
| 第一次冷 Gradle 语义 | FAIL；实际终止为 `JDT import failed`，不是更早的静态 NOT_READY 暂态 |
| 唯一透明补充观测 | BLOCKED_ENV；Gradle 插件 marker 无法解析，精确定义失败，引用未继续 |
| 兼容与回滚 | 用户移出本轮范围；原执行和失败保留，不再排查或复验 |
| 生产 TCC、业务读、部署 | NOT_RUN；没有生产授权 |

第一次准备在执行 installer 前因 `node_modules` 符号链接触发源码清洁检查而失败。原 FAIL 保留。新根恢复为真实依赖目录，相对 npm 链接和字节 inventory 不变，实际 Git 工作区清洁；没有改守卫或 ignore 规则。

第一次真实业务验收从物理空 Gradle home 开始，静态结果在 137496.857 ms 可用，仅一次 `start:true`。JDT PID 51122 持续导入、下载及报告进度，约 120 秒后变为 BROKEN/FAILED。新增 4163 文件、1365 新工件，逻辑字节 562214400、分配字节 584261632。新工件包含下载及生成内容，不能全部计作网络下载；本机 Gradle 发行版没有重新下载。

共享启动预算同时覆盖 initialize 与 project.import，默认 120 秒。原同 PID 时序高度支持预算耗尽；原共享任务异常和信号发起者没有保留，仍为**高可信推断**，不写成完全证实。

唯一透明观测复用 A 的实际 native、完整 dist/deps 与冻结输入，在另一个物理空私有 home 运行；原产品文件、15 秒请求、120 秒启动上限和 oracle 未变。JDT PID 54035 在约 41.7 秒后进入 ServiceReady，import 时还剩 113597 ms。唯一 budget rejection 属于 15 秒调用者，未终止共享导入。TERM/KILL 栈来自最终 stopInternal 收尾，**没有复现原 120 秒失败**。

该次 Gradle 明确报告 Spring Boot 4.0.6 插件 marker 无法解析。JDT 的 services.gradle.org checksum 请求另有 TLS 错误；它不属于插件异常链，不能拼接成已证明的插件 TLS 根因。

## 最小方案及验证边界

用同一冻结 JDK、同一公开插件 marker 做短 HEAD 对照：默认 TLS 直连与现有 `127.0.0.1:8888` 代理均发生 SSLHandshakeException/EOF；同一代理显式使用 TLS 1.2 返回 HTTP 200，5456 ms。全部请求保留默认的证书校验，没有改主机、truststore 或 Gradle/JDT 设置，没有追加语义运行。

建议只调整隔离 JDT/Gradle JVM 的候选环境设置：

```text
-Djdk.tls.client.protocols=TLSv1.2
-Dhttps.protocols=TLSv1.2
-Dhttps.proxyHost=127.0.0.1
-Dhttps.proxyPort=8888
```

JDT 使用既有 `JDTLS_EXTRA_ARGS` 入口；Gradle 使用既有 `java.import.gradle.jvmArguments` 设置位置。两类实际 JVM 必须分别配置，不能推定 Gradle daemon 一定继承 JDT 参数。不得放开全部宿主 JVM 环境变量或写入全局设置。保持 15 秒请求、120 秒启动、冻结版本、证书校验和原语义 oracle。

**本节记录原方案。** 用户随后授权唯一一次隔离实施，结果见 [单次 TLS 1.2 冷 Gradle 验收](tls12-single-acceptance.md)：真实语义 FAIL，候选停止使用，不再重试。HEAD 成功没有证明完整 Gradle 依赖或语义恢复。原证据和本页历史判定保留。

## 本地审查工件

包：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261102T023500Z-new-baseline-acceptance-retry1/review-candidate-174227f978a0.tar.gz`

SHA256：`bdafaa6ccd270db710fa16e30e1f434506a70fee55aa9670740a7b4292dc81c2`。6505 个普通文件、7 个相对链接、20321713 压缩字节。完成一次物理解压及逐项全 hash 核对。该 PASS 仅证明包完整；候选为 **NOT_READY**。

A 实际 native SHA256 为 `7fa9bd85b10cc5414b5c6bb495263d7bdfa5662541f8c6a8f0de902aa538a2e3`。B 实际 native、manifest 和 build stamp 另行保留。fresh npm ci 依赖按每份 release 的实际 inventory 记录，不冒用准备阶段旧依赖 hash。

精确计数、argv、签名、身份、资源和归档见 `current-baseline-summary.json` 与生成的 `current-baseline-result.json`、`current-baseline-preparation-result.json`。业务 oracle、请求及日志只保留在私有归档。

两根统一收尾均 PASS，原始归档各完成一次物理解压全 hash；本次到期 raw/tmp 均删除，未登记路径和到期残留字节均为 0。审查包、实际 B native、清单、验证、历史及生成结果保持 LOCAL。

| 运行根 | raw 文件数 | 归档 SHA256 |
|---|---:|---|
| 原准备根 023000 | 37 | `d6a912391f87a7cc4aec8b909eb4e212d26e05ee00e5601d29d53690b368c3bb` |
| 实际验收根 023500 | 851 | `2dcaf9be7b817dfb26db033160e62acb6d08f8ddd79cb6358b34f3092db0499d` |

独立实际退出复核覆盖完整 fixture、JDT、Gradle、daemon、监督器、自有组和精确 job；两张全局配额表均为 0。收尾遇到一个由 Chrome 复用的历史 PID，原 Node exit 0 与后起进程身份均保留，清理清单按实际归属纠正；没有向 Chrome 或未知进程发送信号。

## 固定边界

- 历史 [G17 FAIL](README.md) 与所有失败证据保留。新基线的成功不改写旧失败，也不说明历史超时根因已经确定。
- 实际验收根为 `/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261102T023500Z-new-baseline-acceptance-retry1`。原 `023000` 准备失败根单独保留。新 runtime 及 compiler/SDK 身份单独冻结，不复制旧 production 观测字段。
- 当前基线为 macOS 26.7.2 (25G332)、Apple clang 21.0.0 (clang-2100.1.1.101)、冻结 Node 22.16.0。JDT/Java/Gradle 使用既有冻结工具链，正式探针重新核对实际文件。
- 生产固定 launcher 的 TCC、业务读取及升级后复读为 `NOT_RUN`。本轮隔离验收不表示 `READY_FOR_DEPLOY`、生产部署或 MAC-18/19 完成。

## 依赖准备合同

`scripts/ilv2-mac-dependencies.mjs restore` 只接受预登记运行根下的新目录。先验证已知归档 SHA256，再用 macOS `/usr/bin/tar` 恢复 `./node_modules`。恢复后逐项核对既有文件/目录/相对链接 inventory。不得用会将 AppleDouble 元数据展开成普通 `._*.node` 文件的提取方式；不得覆盖旧目录。

`check --repo-root <absolute-root>` 必须在新 Node 进程中执行。它记录真实 loader/binding 路径及 hash，拒绝 AppleDouble 和越出依赖根的实际 binding，并实际加载 Tree-sitter Java parser 解析固定 Java 文本。完整 installer 在真实 npm ci 后、构建前检查；隔离 broker 在复制依赖后、tsc 前以原命令记录器检查。失败原样终止，不自动修补 vendor loader、不跳过检查。

## 原执行计划（由上方最新范围覆盖）

1. 完成最窄依赖测试和独立只读评审。
2. 用新 runtime/Clang 构建并完成正式环境探针。
3. 完整 installer A 执行真实 npm ci、签名构建、完整 npm test、安装和服务身份读回。
4. 在真实冻结业务隔离副本和物理空 Gradle home 中执行首次精确定义/引用语义验收，记录首次耗时、下载/cache 和磁盘成本。
5. 停止 A 并释放配额；同源完整 installer B 执行停服升级；真实 daemonctl 回滚 A 并核对配对状态。
6. 读取实际退出、全局配额、独立评审及原始日志；统一归档和清理本次资源。

A/B 是同一源码的两份独立构建，不代表跨版本迁移或零停机升级。full CLI 失败时停止原 pipeline，先读取第一条原始错误；同因无新证据不得重放。首次 Gradle 失败保留原错，仍执行升级/回滚。完成或到期都汇报，达到验收标准后停止扩展。

当前结果：`BLOCKED_ENV`，候选 `NOT_READY`。原 G17 FAIL 保留。当前候选停止使用；没有 push、生产操作或 JDT 产品修复。

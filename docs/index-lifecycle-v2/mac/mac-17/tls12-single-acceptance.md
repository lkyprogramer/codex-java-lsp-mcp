# MAC-17 单次 TLS 1.2 冷 Gradle 验收

2026-11-02，唯一一次真实语义验收 **FAIL**。候选停止使用，`candidateStatus = NOT_READY`。没有重试。正式 G17 的历史 FAIL 保留。生产 TCC、业务读和部署为 `NOT_RUN`。

本轮只配置隔离 JDT/Gradle JVM 的 TLS 1.2 和既有代理。用户取消兼容与回滚工作。用户规定失败即停用。原截止为 **2026-11-03 18:00+08:00**。

## 改动与复用

本轮没有修改产品源码、native、dist、依赖或版本。安装证据复用[新基线结果](current-baseline-acceptance.md)，没有重跑 installer、构建或完整测试。

隔离配置只增加以下四个参数：

```text
-Djdk.tls.client.protocols=TLSv1.2
-Dhttps.protocols=TLSv1.2
-Dhttps.proxyHost=127.0.0.1
-Dhttps.proxyPort=8888
```

JDT 使用原有 `JDTLS_EXTRA_ARGS`。Gradle 使用原有 `java.import.gradle.jvmArguments`。原有 Gradle 参数保留。配置只适用于本次登记的私有运行根。主机代理、全局 JVM 设置和证书校验均未修改。

15 秒请求时限、120 秒 JDT 启动预算及原语义断言保持不变。没有增加预热、延时、重试或备用路径。

## 实际验证

| 项目 | 结果 |
|---|---|
| 唯一真实 Node test | 1 项；0 PASS、1 FAIL；0 跳过、取消或 todo |
| 空私有 Gradle home | 起始为空；只有一次 `start:true` |
| 首次静态结果 | 132347.724 ms |
| 首次精确语义结果 | FAIL；未取得成功耗时；引用验收未完成 |
| 实际配置传输参数 | initialize/didChangeConfiguration 中观察到四个参数 |
| JDT 实际进程参数 | PID 7556 中观察到四个参数 |
| Gradle daemon 实际参数证明 | 未取得；PID 7715 的捕获命令行没有这四个参数 |
| 产品工件身份 | 验收后 native/dist/deps 无漂移 |

传输观测标记为 `ACTUAL_TRANSPORT_ARGUMENT`。它记录实际调用参数，不冒称序列化 wire capture。Gradle 命令行没有参数，不足以证明每次 build 的属性没有生效。

最终错误为 `semantic oracle unavailable after bounded attempts`。Gradle 日志报告 Spring Boot 4.0.6 插件 marker 无法解析。精确坐标为 `org.springframework.boot:org.springframework.boot.gradle.plugin:4.0.6`。Gradle 搜索了 Gradle Central Plugin Repository 和 MavenRepo。

`firstFailure` 中更早的静态 `MCP tool error` 是暂态记录。它不是本次最终语义失败。现有日志不能证明插件解析失败的深层原因，也不能证明 TLS 1.2 配置恢复了 Gradle 导入。没有追加网络或 JVM 探针。

私有缓存记录为 239 个新增文件、0 个新增工件。逻辑字节为 195604392，分配字节为 207577088。这些数字包括生成缓存，不等于网络下载量。本机 Gradle 发行版没有重新下载。

## 工件身份

- 产品源码：`174227f978a012f9c9bb525c5f3e658aa3e0c9a5`。
- 源码 digest：`5754a52848cc99719326eecd8fdaf02673756477b02f46e78fdd7e40609a59ff`。
- runtime manifest：`26112d6328ccb37718c004f6bac4f6c62fbe99d3808ff7f5870db550429de058`。
- 实际 A native：`7fa9bd85b10cc5414b5c6bb495263d7bdfa5662541f8c6a8f0de902aa538a2e3`。
- 隔离配置 SHA256：`c564c0eb680cef486625a6d8368267869731d075475391a4bcf50d72939d640c`。
- 单次计划 SHA256：`b2b4a0898fd65d1077dfa88babccc2cb5bb06d73aee6b318dcc87a1671bd1e21`。

复用原 A 包 `review-candidate-174227f978a0.tar.gz`，SHA256 为 `bdafaa6ccd270db710fa16e30e1f434506a70fee55aa9670740a7b4292dc81c2`。本次只为新 consumer 恢复一次，6505 个普通文件及目录模式、7 个链接均匹配原清单。没有创建新候选包，也没有重做旧归档验证。

私有运行根：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261102T061500Z-tls12-single-acceptance`。

## 资源与归档

独立只读复核确认原始失败与候选身份。复核没有运行测试、构建、JVM 或网络探针。复核通过只表示证据和资源记录准确，不表示语义验收通过。

完整清单包含 10 个 PID、6 个自有进程组、0 个 launchd job。独立 ps/ESRCH 读回确认退出。运行根 argv 残留为 0。全局两张 fixture 配额表均为 0。

统一 closeout 为 PASS。`unregisteredPaths=[]`，`expiredResidualBytes=0`。本次 raw 的 28 个文件、1179383 个逻辑字节完成一次归档及一次物理解压全 hash 核验。归档 SHA256 为 `6a076d6f32134acb6629094f4955e59dce39bb963e11c98579d03433807c918e`。

归档位于本次私有运行根的 `closeout/raw-evidence.tar.gz`。本次 raw/tmp 清理完成。配置、harness、清单、结果和归档保留为 LOCAL。原 A 包及历史归档保持原样。

## 停止边界

本次最小配置没有取得成功语义结果。候选停止使用。本轮不再自动排查、修改或测试。

安装和升级的既有成功证据保留。历史失败保留。兼容与回滚不属于当前范围。生产 TCC、固定 launcher 业务读、生产切换和 MAC-18/19 均未执行。本轮不能声明 `G17 PASS`、`READY_FOR_DEPLOY` 或 `DEPLOYED`。

生成结果见 [tls12-single-result.json](tls12-single-result.json)。公开摘要见 [tls12-single-summary.json](tls12-single-summary.json)。业务 oracle、请求、源码与原始日志只保留在私有证据中。

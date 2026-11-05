# MAC-17 Gradle：最终事实与验收边界

本页保留当时结果。用户随后选择安装期依赖恢复。新结果见 [准备后语义验收](install-prepared-acceptance.md)。原失败与原计数保持。

Gradle 尚未彻底解决。候选停用。正式 G17 的历史 FAIL 保留。

原 120 秒未放宽。完整冷导入没有完成，精确定义和引用均未运行。本轮没有 push、生产操作、完整测试或 installer 重跑。

## 已确认的配置缺陷

Gradle 把 `user.home` 归为 mutable 标准属性。JVM 参数通道没有实现所需隔离。改用 build arguments 只修复第一阶段：JDT 1.56 的 APT 同步通过 `withArguments` 替换原参数，第二阶段会丢失 CLI HOME 与显式 init。connector 的 Gradle home、独立 JVM 参数中的 TLS 和代理保留。实际冻结 JAR 的 javap 和原操作日志支持该结论。[JDT APT 调用源](https://raw.githubusercontent.com/eclipse-jdtls/eclipse.jdt.ls/v1.56.0/org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/managers/GradleBuildSupport.java)

最终修复位于 `src/jdtls-session.ts`：仅在隔离启动时，向专有 Gradle home 写入 `gradle.properties` 的 `systemProp.user.home`。文件在 JDT spawn 前生成。内容使用 UTF-16 escape。已有冲突配置会终止启动。临时文件 rename 保证完整写入。无效 CLI HOME 参数已移除。

最终定向回归 8/8 PASS。缺失 properties 的真实 RED 为 1 test / 1 FAIL。两个独立真实 Gradle 操作均读取私有 HOME 与 Maven 目录。这些结果只证明配置组件，不证明完整冷语义通过。

此前共享启动错误分类、backoff、源码附件策略与隔离业务 BOM 导出证据继续复用。原矩阵未重跑。最终产品补丁涉及 7 个文件。业务主分支未修改。

## 保留的原失败

时间均为 2026-11-02 UTC，目录完整名称见 [summary](gradle-cold-final-summary.json)。

| 根时间 | 原结果及边界 | 退出 PID / 自有组 |
|---|---|---:|
| 12:10 | FAIL；Gradle 实际仍读取宿主 HOME | 22 / 5 |
| 12:50 | FAIL；第一阶段完成，APT 在截止前未交付。旧 HOME PASS 仅覆盖第一阶段 | 24 / 6 |
| 13:10 | FAIL；SIGQUIT dump 污染 LSP stdout，出现 129 次 header 错误。不能作为干净产品验收 | 23 / 7 |
| 13:25 | 干净 FAIL；截止时仍恢复插件依赖，缓存 87 个依赖文件、22 个 JAR | 14 / 5 |
| 13:40 | 干净 FAIL；镜像路径生效，截止时缓存 83 个依赖文件、18 个 JAR | 20 / 7 |

每根仅启动一个 JDT。精确 position/reference 调用均为 0。早期 `firstFailure` 的静态 MCP 错误属于暂态；最终错误以原 action 中的共享导入 deadline 为准。

13:10 的实际 JDT 栈位于 APT model get。Gradle dump 只观察到请求，未观察到输出。该取栈方式是本轮执行错误，未包装成产品缺陷。原 TAP FAIL、dump 与污染说明全部保留。后两次干净运行没有诊断信号。

## 仓库与客户端对照

冻结输入的插件仓库优先使用 Portal；业务依赖仓库已使用 Aliyun public。实验补丁只把同一既有镜像加入 `pluginManagement` 首位，保留原仓库和版本。[插件门户镜像说明](https://plugins.gradle.org/docs/mirroring)

两个 marker 的依赖契约相同。两个插件 JAR 与原实际 Portal 缓存 SHA 相同。真实实验记录 88 条镜像下载、0 条 Portal 下载，但冷验收仍 FAIL。镜像补丁作为[实验工件](plugin-repository-mirror.patch)保留，不宣称解决了 120 秒问题。

同一 600176-byte JAR 的 HTTP/1.1 对照为 curl 116.857 ms、JDK 306.577 ms、冻结 Gradle HttpClientHelper 359.821 ms。三者 SHA 相同。原 TLS 1.2、代理及证书校验保持。该对照未启动 JDT 或 Gradle daemon。

单请求快不能解释真实构建上下文中的批量恢复延迟。目前仍缺少无干扰的失败 Gradle 上下文证据，不能确定唯一网络、JDK、代理或仓库根因。配置缺陷已定位；全部耗时原因尚未定位。

## 下一步方案：等待验收边界选择

已向用户提出选择，尚未收到答复：

1. 把依赖恢复纳入安装阶段。复用当前候选，在独立隔离阶段恢复插件、BOM、二进制和 APT 依赖并记录实际身份。依赖就绪后，JDT 启动继续使用原 120 秒，精确定义和引用门槛保持。新结果必须称为“依赖已准备后的首次语义”，不得改写此前空缓存全程 FAIL。
2. 保持“从空 Gradle home 开始全程 120 秒”。本轮停止使用候选，保留 FAIL，不继续补参数或盲目冷跑。

方案 1 改变了原验收口径，必须先得到用户明确选择。拟议实施位置是 `install-runtime.sh` 的候选准备阶段与隔离验收驱动。尚未实施 bootstrap、预热、额外重试或预算调整。后续如获确认，仍遵守北京时间 2026-11-03 18:00 截止点，不重跑完整测试、不 push、不动生产。

## 工件与收尾

- 源码摘要：`22923c65250be78133c3c85727162b62a0f7da385b1bddb85c720be4af66b4b9`
- 基础提交：`ff81b8ddbcb8c508f785f035be92323e5a8b4027`
- 产品补丁 SHA：`ab009ca3f87108ee6ccd4cb744e0a496b4a10921a52b1d578445f3570abbd632`
- build：`ff81b8ddbcb8+pab009ca3f871`
- 复用的实际 native SHA：`7fa9bd85b10cc5414b5c6bb495263d7bdfa5662541f8c6a8f0de902aa538a2e3`；无新 native 构建或 SLO 声明。
- LOCAL 候选包：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261102T131000Z-gradle-home-properties/review-candidate-22923c65250b.tar.gz`
- 包 SHA：`3aa3584b81d17e1b5cd5a74c5ce44555ec039368e6ca901741eb7d542e7567eb`；6505 个普通文件、7 个相对链接，一次解压全身份核对。后续消费者只做必要恢复身份检查。

独立复核确认登记 PID/PGID 均退出，精确根 argv、isolated job、两张 quota 表均为空。五根均 closeout PASS。raw 各一次物理解压全 hash 归档，到期 raw/tmp 已删除。失败、候选、清单和归档保留 LOCAL。各归档 SHA 见 summary。任务结果仅由 [compose 结果](gradle-cold-final-task-result.json)生成。

生产固定 launcher 的 TCC、业务读取、生产切换及 MAC-18/19 均 NOT_RUN。兼容与回滚由用户取消。候选没有部署资格。

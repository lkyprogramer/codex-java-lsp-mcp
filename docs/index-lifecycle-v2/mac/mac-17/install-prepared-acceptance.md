# MAC-17：安装期依赖恢复与准备后语义验收

本页保留当时失败。后续同 PID 栈诊断见 [引用索引等待根因](reference-index-readiness-diagnosis.md)。原验收结果不变。

部分完成：安装期依赖恢复通过。JDT 启动通过。完整语义验收失败。候选停用。

用户选择把依赖恢复纳入安装阶段。JDT 仍使用原 120 秒门槛。引用仍使用原 10 秒语义预算。MCP 请求仍使用原 15 秒预算。此前空缓存全程 120 秒的失败保留。

## 改动

- `install-runtime.sh --prepare-gradle <plan>` 增加独立的隔离安装阶段。该阶段使用注册的私有运行根。
- `scripts/Ilv2GradlePrepare.java` 使用冻结 TAPI。它递归恢复真实 Eclipse 项目模型。它还执行原 JDT 的 APT 模型。APT 指注解处理配置。
- `scripts/ilv2-mac-gradle-prepare.mjs` 核对实际 HOME、TLS 和代理属性。Gradle 退出后，它释放配额并生成工件清单。
- `src/mac-platform/gradle-domain.ts` 复用隔离 HOME 配置。安装准备与 JDT 使用同一私有域。
- 原 TLS 1.2、代理和证书校验保持。生产安装入口未运行。完整 installer、完整测试和 native 构建均未重跑。

## 验证

| 项目 | 结果 |
|---|---|
| 定向检查 | 已验证：3/3 通过。首次私有 TMP 目录缺失导致的 3 项失败保留 |
| 从空私有 Gradle home 恢复依赖 | 已验证：731.552 秒；23 个项目、399 个必需二进制、1 个处理器文件 |
| 依赖工件 | 已验证：1395 个文件，324604180 bytes；恢复后逐项固定 SHA |
| 两次模型的实际属性 | 已验证：私有 HOME、TLS 1.2、指定代理一致 |
| 单次 JDT 启动 | 已验证：30.195 秒收到 ServiceReady；33.039 秒由状态轮询观察到 READY |
| 单次 `start:true` 请求 | 失败：15.003 秒 MCP 超时。底层共享启动继续，没有第二次启动 |
| 精确定义及 hover | 已验证：原精确断言匹配，2.567 秒 |
| 唯一引用请求 | 失败：10.006 秒，原错误为 `Deadline exceeded during request.handler after 10000ms` |
| JDT 阶段新增依赖工件 | 已验证：0；不表示网络请求为 0 |
| 全部语义断言 | 失败：引用未交付合格结果。最终 TAP 为 1 项失败 |

首次静态阶段耗时 119.844 秒。该值包含 104 次静态尝试。最后一次成功请求耗时 576.923 ms。它不是单次 API 耗时。

原 `result.firstFailure` 记录了较早的静态错误。终止原因以原 actions 中的引用期限错误为准。原结果没有修改。

实际 Gradle home 在消费者退出后包含 5521 个文件。逻辑字节为 568158145。分配字节为 597778432。这些数值包含转换产物及元数据。Gradle distribution 没有新增下载。

## 原因与剩余方案

本次安装恢复完成后，JDT 在原 120 秒内进入 READY。精确定义也通过。本次剩余阻塞是首次引用请求。

`ServiceReady` 表示启动导入完成。它不证明整个引用搜索已经就绪。`request.handler` 是外层处理器期限。现有证据没有区分 JDT 索引等待、搜索执行和其他处理阶段。本次没有采集引用超时现场的同 PID 栈。引用内部原因仍未确认。

后续最小步骤是定位同一引用请求的实际耗时阶段。随后只修复证据确认的缺陷。现有证据不支持直接增加等待、重试或时限。本轮没有追加该步骤，也没有追加冷验收。

## 工件与收尾

- 基础提交：`ff81b8ddbcb8c508f785f035be92323e5a8b4027`。
- 源码摘要：`48253f3cc857bb9313c883bd5857247cabdc70a2a673dbabd3e23dd0ba20035a`。
- 产品补丁 SHA：`44035234251f78610d4e1a51ae0f84aeee673f747970f434362e6e53539e2428`。
- build：`ff81b8ddbcb8+p44035234251f`。
- 本地审查包：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261102T150500Z-install-gradle-prepare/review-candidate-48253f3cc857.tar.gz`。
- 包 SHA256：`b5849e32d5f04c94de29c97357692f8e7e313f05a370ba2663f83f85bc66d0f6`。
- 包包含 6508 个普通文件和 7 个相对链接。一次物理解压及全量身份核对通过。包完整性不表示可部署。
- 实际 native SHA256：`7fa9bd85b10cc5414b5c6bb495263d7bdfa5662541f8c6a8f0de902aa538a2e3`。签名证据按同字节复用，没有新构建或新 SLO 声明。
- raw 归档 SHA256：`997022d325e99cc4e3e15b0bfad349338bd5fb45b545c6443926503eb81f71ee`。归档包含 49 个文件。一次物理解压及全 hash 核对通过。

独立审查核对了原始事实。20 个 PID 和 8 个自有进程组均退出。精确运行根 argv 和本次 launchd job 均无残留。两张配额表均为 0。JDT 的 SIGKILL 发生在失败后的清理阶段，没有自行崩溃的证据。

统一 closeout 通过。到期 raw/tmp 已删除。候选包、清单、原失败、摘要和归档保留 LOCAL。更早五根归档保持原样。任务结果由 [compose 结果](install-prepared-task-result.json)生成。完整摘要见 [summary](install-prepared-summary.json)。

正式 G17 的历史 FAIL 保留。生产 TCC 和业务读取未验证，原因是用户未授权生产操作。兼容与回滚按用户要求跳过。本轮没有 push，没有生产操作。收尾早于北京时间 2026-11-03 18:00 截止点。

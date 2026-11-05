# MAC-17：两补丁后的唯一最终冷语义验收

2026-11-02。**FAIL，候选停用。** 用户新增授权的一次验收执行完毕，没有追加重试。两个补丁的身份、参数传递和私有输入检查通过，完整冷导入仍未满足原 120 秒条件。精确定义和引用没有执行。

[生成结果](remediated-final-cold-task-result.json) 与 [机器摘要](remediated-final-cold-summary.json) 保留实际结果。正式 G17 FAIL 保留，不表示可以上生产。

## 实际结果

| 项目 | 结果 |
|---|---|
| 唯一最终 case | TAP 1 项、0 PASS、1 FAIL，0 skip/cancel |
| 物理空 Gradle home | 启动前 0 文件、0 目录、0 分配字节 |
| 静态源码可用 | 首次可用 140953.235 ms；保留之前的暂态 MCP tool error |
| JDT 启动 | 仅一次，PID 48371 |
| 原始截止 | spawn→TERM 119994.570 ms；→KILL 120194.945 ms；→exit 120221.143 ms |
| 导入终态 | 未取得 ServiceReady；原动作失败消息为 `JDT import failed` |
| 精确定义、引用 | NOT_RUN；没有发出这两类请求 |
| 产品 init | 实际 transport 保留私有 init 路径；脚本 SHA 与已审查常量一致 |
| Gradle JVM/profile/home/代理 | 实际 beforeSettings 内五项系统属性、私有 home、既有 HTTP 代理路线检查通过 |
| Boot marker | MARKER_RESOLVED |
| 源码附件缓存快照 | modules-2 下 sources jar 为 0 |
| 原四类异常字串 | daemon 日志中 SSLHandshakeException、PKIX、UnknownPluginException、ModuleVersionNotFoundException 均为 0 次 |
| 实际候选载荷 | dist、依赖运行前后身份一致 |

截止前最后记录仍有必需的依赖元数据和二进制下载。最后状态显示 POM 下载；TERM 前的 daemon 日志仍有 binary JAR GET。完整模型导入尚未完成。

本次证据不足以将延迟归因于唯一网络环节、TLS、远端仓库或本地解析。两个补丁没有使“物理空 home＋完整业务副本＋120 秒”这个组合验收通过。源码附件为 0、未出现上述异常字串，也不能替代完整语义通过。

最终缓存快照新增 4137 文件、1282 工件，逻辑字节 617362216、分配字节 648609792。本次选择既有本机 Gradle，没有下载 Gradle distribution。这些缓存字节不是精确网络流量，不与上轮不同导入进度直接换算性能收益。

## 补丁和输入身份

- 产品基点：`ff81b8ddbcb8c508f785f035be92323e5a8b4027`，加已审查补丁 `cfcd4f85b6073932e0b3fe324dbb2ddcb575f32863ffe42ada869d9c85c17843`。
- 实际源码 digest：`cfce7c772405fdff35401908244e10213d7cde248223722d1a01fffc0c8b95c1`。
- 实际 build label：`ff81b8ddbcb8+pcfcd4f85b607`。它明确标识基点加补丁，不冒充新提交。
- 只编译 TypeScript；复用原实际 A 的签名 native 与 npm-ci 依赖。实际 native SHA：`7fa9bd85b10cc5414b5c6bb495263d7bdfa5662541f8c6a8f0de902aa538a2e3`。没有调用当前 Clang 重建或重签名。
- 依赖为实际 A 的 4110 个文件、7 个相对链接，真实 parser 加载检查通过；没有冒用其他准备包的依赖 hash。
- 业务输入以原冻结 `fd9c117b4cfad46247757d4c373b9465534fe33f` 的 6286 文件为基线，只修改 platform-core 的一行 BOM 导出。新清单完整绑定该副本；没有修改旧冻结输入或业务主工作区。
- 业务补丁 SHA：`4019b815297a5c310aad773c774d6b8512c1d8f6d0ffa62330d3e39ffb18a65c`。组件回归及真实 classpath 对照复用[前轮记录](cold-import-root-cause-remediation.md)，没有重跑完整测试。

原 15 秒调用预算、120 秒共享启动预算、证书校验和精确 oracle 保持原样。为执行“失败即停”，私有 driver 的语义尝试上限由 10 收紧为 1；本次尚未进入该步骤。受管 init 与原 TLS/profile 都保留在实际 arguments 中，没有用 observer 覆盖产品参数。

## 证据解释边界

原 result.firstFailure 保留早期静态暂态错误，不能把它写成最终失败原因。静态可用门后来通过；终态是导入未完成。

最后一次状态在 JDT 真正退出之前，显示 importFAILED、state STARTING、backoff 0。共享启动 catch 在子进程回收后才记录退避。因此该瞬时状态既不能证明新增 backoff 缺陷，也不能证明本次实际退避生效。失败后未追加状态 API。

原 `actualJdtLaunchArgumentsObserved=false` 保留，因为没有 READY 阶段的 process-selected 文件。原始 spawn trace 单独保留初始 JDT 参数，不把它改写成后续 JDT 系统属性的证明。

## 原始工件与收尾

运行根：`/Users/luo/Developer/ilv2-work/codex-java-lsp-mcp/ilv2-mac/runs/mac-17/20261102T094800Z-remediated-cold-once`。

实际失败候选仅作为 **UNQUALIFIED / NOT_READY** 取证包保留：

- `unqualified-remediated-cfce7c772405.tar.gz`
- SHA256：`e03f53c5dd1924424de1d42a497b3f8b00377132fdae2441e930f0fcfb63fd9c`。
- 6505 普通文件、1183 目录、7 相对链接；压缩字节 20327675。
- 新包只物理解压及全 hash 一次；验证通过只证明包完整。

Astra xhigh 独立只读复核确认本次真实失败与资源退出。17 个已登记 PID、5 个自有组均退出；0 个 launchd job；两张配额表为空。根代理保存整根实际 argv 扫描，无残留。独立 reviewer 没有另跑测试、JVM 或网络探针。

统一 closeout PASS，unregisteredPaths=[]，expiredResidualBytes=0。raw 归档 27 文件、190698925 逻辑字节，一次物理解压全 hash 通过；SHA256：`ae487d192f394a53301280262085f8782fb5902903c7bb3682e6bd1a4d2e9ca5`。本次 raw/tmp 均删除。只在确认消费者结束后给本次缓存的一处 0555 目录增加 owner 写权限。

准备阶段的两次 mode 检查失败和一次私有 helper 变量错误保留。它们发生时没有 owner/JDT/Gradle。解包 consumer 没有重复创建；按原清单恢复常规文件及符号链接自身权限，再继续准备。没有用准备修正增加最终验收次数。

## 停止点

本次按“失败即停”结束，早于北京时间 2026-11-03 18:00。没有新增运行、优化、预热、兼容、回滚、fullsuite、installer、canary 或 G12 排查。没有 push、生产操作或生产 TCC 探针。原安装证据、所有历史失败和旧包保持原样。
